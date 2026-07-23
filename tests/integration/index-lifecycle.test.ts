import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobRunnerRegistry } from "../../src/generation/runner-registry.js";
import { startServer, type RunningServer } from "../../src/index.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) resolve();
      else reject(cause);
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a test port");
  }
  return address.port;
}

describe("server lifecycle", () => {
  let runtime: RunningServer | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    await runtime?.stop();
    if (directory !== undefined) {
      removeTestDirectory(directory);
    }
  });

  async function fixtureEnvironment(
    dbPath: string
  ): Promise<Record<string, string | undefined>> {
    const storageStatePath = join(directory as string, "storage-state.json");
    const profilePath = join(directory as string, "session-profile.json");
    writeFileSync(storageStatePath, JSON.stringify({
      cookies: [{
        name: "csrfToken",
        value: "fixture-csrf",
        domain: "lingjing.jdcloud.com",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: "Lax"
      }]
    }));
    writeFileSync(profilePath, JSON.stringify({ originPin: "fixture-pin" }));
    return {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(await availablePort()),
      LINGJING_API_KEY: "fixture-downstream-api-key",
      SESSION_MODE: "browser-state",
      LINGJING_STORAGE_STATE: storageStatePath,
      LINGJING_SESSION_PROFILE: profilePath,
      DB_PATH: dbPath,
      LOG_LEVEL: "silent",
      DOCS_ENABLED: "false"
    };
  }

  it("starts recovery before listening and closes HTTP and SQLite cleanly", async () => {
    directory = mkdtempSync(join(tmpdir(), "lingjing-index-test-"));
    const dbPath = join(directory, "jobs.sqlite");
    const env = await fixtureEnvironment(dbPath);
    const port = Number(env.PORT);
    runtime = await startServer(env);

    expect(runtime.dependencies.recovery.ready).toBe(true);
    const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(await health.json()).toMatchObject({
      status: "ok",
      database: "ok"
    });
    const session = await fetch(
      `http://127.0.0.1:${String(port)}/v1/session`,
      {
        headers: {
          authorization: "Bearer fixture-downstream-api-key"
        }
      }
    );
    expect(await session.json()).toEqual({
      mode: "browser-state",
      logged_in: true,
      login_required: false
    });

    const repository = runtime.repository;
    await runtime.stop();
    expect(runtime.app.server.listening).toBe(false);
    expect(() => repository.findById("job_missing")).toThrow(
      "Job repository is closed"
    );
  });

  it("schedules seeded recoverable work before listen and aborts a blocked poller", async () => {
    directory = mkdtempSync(join(tmpdir(), "lingjing-index-test-"));
    const dbPath = join(directory, "jobs.sqlite");
    const seededRepository = new SqliteJobRepository(dbPath);
    const queued = seededRepository.createOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "fixture-image",
      apiId: "707",
      modelCode: "fixture-model",
      expectedAssetScene: "image-generation",
      requestFingerprint: "a".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 1
    }).job;
    const submitting = seededRepository.transition(queued.id, ["queued"], {
      status: "submitting",
      submittedAt: Date.now(),
      upstreamFingerprint: "b".repeat(64)
    });
    const discovering = seededRepository.transition(
      submitting.id,
      ["submitting"],
      { status: "discovering" }
    );
    const processing = seededRepository.transition(
      discovering.id,
      ["discovering"],
      {
        status: "processing",
        creationCode: "seeded-creation",
        upstreamTaskId: "seeded-task"
      }
    );
    seededRepository.close();

    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const blockedRead = new Promise<unknown>((resolve) => {
      releaseRead = () => {
        resolve({
          data: {
            task: {
              taskId: "fixture-seeded-task",
              status: 1,
              taskResults: [{
                url: "https://example.invalid/late.png"
              }]
            }
          }
        });
      };
    });
    const transport: LingjingTransport = {
      read<T>(path: string): Promise<T> {
        if (path === "/openApi/modelmarket/describeUserTask") {
          markStarted?.();
          return blockedRead as Promise<T>;
        }
        return Promise.reject(new Error(`Unexpected read ${path}`));
      },
      submitOnce: () => Promise.reject(new Error("Unexpected submit")),
      uploadApi: () => Promise.reject(new Error("Unexpected upload")),
      putSigned: () => Promise.reject(
        new Error("Unexpected signed upload")
      )
    };

    runtime = await startServer(
      await fixtureEnvironment(dbPath),
      { transport }
    );
    await started;
    expect(runtime.dependencies.recovery.ready).toBe(true);
    expect(runtime.registry.has(processing.id)).toBe(true);

    await runtime.stop();
    releaseRead?.();
    const verified = new SqliteJobRepository(dbPath);
    expect(verified.findById(processing.id)?.status).toBe("processing");
    verified.close();
  });

  it("keeps SQLite open across an active-submit drain timeout and closes on retry", async () => {
    directory = mkdtempSync(join(tmpdir(), "lingjing-index-test-"));
    const dbPath = join(directory, "jobs.sqlite");
    runtime = await startServer(
      await fixtureEnvironment(dbPath),
      {
        shutdown: {
          submitDrainTimeoutMs: 5,
          runnerIdleTimeoutMs: 100
        }
      }
    );
    const reservation = runtime.registry.reserveSubmitCriticalSection();

    await expect(runtime.stop()).rejects.toThrow(
      "Timed out draining submit critical sections"
    );
    expect(runtime.repository.findById("missing")).toBeNull();
    reservation.cancel();

    await runtime.stop();
    expect(() => runtime?.repository.findById("missing")).toThrow(
      "Job repository is closed"
    );
  });

  it("aborts and drains seeded recovery when listen fails", async () => {
    directory = mkdtempSync(join(tmpdir(), "lingjing-index-test-"));
    const dbPath = join(directory, "jobs.sqlite");
    const seededRepository = new SqliteJobRepository(dbPath);
    const queued = seededRepository.createOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "fixture-image",
      apiId: "707",
      modelCode: "fixture-model",
      expectedAssetScene: "image-generation",
      requestFingerprint: "c".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 1
    }).job;
    const submitting = seededRepository.transition(queued.id, ["queued"], {
      status: "submitting",
      submittedAt: Date.now(),
      upstreamFingerprint: "d".repeat(64)
    });
    const discovering = seededRepository.transition(
      submitting.id,
      ["submitting"],
      { status: "discovering" }
    );
    const processing = seededRepository.transition(
      discovering.id,
      ["discovering"],
      {
        status: "processing",
        creationCode: "failed-listen-creation",
        upstreamTaskId: "failed-listen-task"
      }
    );
    seededRepository.close();

    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const transport: LingjingTransport = {
      read<T>(path: string): Promise<T> {
        if (path === "/openApi/modelmarket/describeUserTask") {
          markStarted?.();
          return new Promise<T>(() => undefined);
        }
        return Promise.reject(new Error(`Unexpected read ${path}`));
      },
      submitOnce: () => Promise.reject(new Error("Unexpected submit")),
      uploadApi: () => Promise.reject(new Error("Unexpected upload")),
      putSigned: () => Promise.reject(
        new Error("Unexpected signed upload")
      )
    };
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") {
      throw new Error("Could not occupy test port");
    }
    const env = await fixtureEnvironment(dbPath);
    env.PORT = String(address.port);
    const registry = new JobRunnerRegistry();

    try {
      await expect(startServer(env, {
        transport,
        registry
      })).rejects.toMatchObject({ code: "EADDRINUSE" });
      await started;
      expect(registry.has(processing.id)).toBe(false);
      const verified = new SqliteJobRepository(dbPath);
      expect(verified.findById(processing.id)?.status).toBe("processing");
      verified.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((cause) => {
          if (cause === undefined) resolve();
          else reject(cause);
        });
      });
    }
  });
});
