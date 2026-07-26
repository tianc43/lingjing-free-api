import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { budgetWindows } from "../../src/accounts/budget.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import { SqliteAdmissionRepository } from "../../src/accounts/sqlite-admission-repository.js";
import { parseConfig } from "../../src/config.js";
import { JobRunnerRegistry } from "../../src/generation/runner-registry.js";
import { startServer, type RunningServer } from "../../src/index.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import type {
  LingjingTransport,
  ReadRequest
} from "../../src/lingjing/types.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { accountSessionPaths } from "../../src/session/create-provider.js";
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

function withAccountRuntime(
  fallback?: LingjingTransport
): LingjingTransport {
  return {
    read<T>(path: string, init?: ReadRequest): Promise<T> {
      const accountResponses: Record<string, unknown> = {
        "/api/user/describeBaseInfo": {},
        "/joycreator/team/space/menu/list": [{ spaceId: 0 }],
        "/joycreator/member/queryMember?pin=fixture-pin": {
          membership: "fixture"
        },
        "/api/wallet/describeAccountCoupons": {
          pointsBalance: 100,
          couponBalance: 0,
          availableAmount: 100,
          totalBalance: 100
        }
      };
      if (Object.hasOwn(accountResponses, path)) {
        return Promise.resolve(accountResponses[path] as T);
      }
      return fallback?.read<T>(path, init)
        ?? Promise.reject(new Error(`Unexpected read ${path}`));
    },
    submitOnce: fallback?.submitOnce.bind(fallback)
      ?? (() => Promise.reject(new Error("Unexpected submit"))),
    uploadApi: fallback?.uploadApi.bind(fallback)
      ?? (() => Promise.reject(new Error("Unexpected upload"))),
    putSigned: fallback?.putSigned.bind(fallback)
      ?? (() => Promise.reject(new Error("Unexpected signed upload")))
  };
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
      DATA_DIRECTORY: join(directory as string, "data"),
      DB_PATH: dbPath,
      LOG_LEVEL: "silent",
      DOCS_ENABLED: "false"
    };
  }

  it("boots with a disabled legacy account and re-enables it through administration", async () => {
    directory = mkdtempSync(join(tmpdir(), "lingjing-index-test-"));
    const dbPath = join(directory, "jobs.sqlite");
    const env = await fixtureEnvironment(dbPath);
    env.LINGJING_ADMIN_PASSWORD = "fixture-admin-password";
    const store = new SqliteStore(dbPath);
    const accounts = new SqliteAccountRepository(store);
    accounts.ensureLegacyAccount("data/auth");
    accounts.update("legacy", { enabled: false });
    store.close();

    runtime = await startServer(env, {
      transport: withAccountRuntime()
    });
    expect(runtime.dependencies.runtimes.listEnabled()).toEqual([]);
    const login = await runtime.app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { password: "fixture-admin-password" }
    });
    const loginBody = login.json<{ csrf_token: string }>();
    const setCookie = login.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
      ?.split(";")[0];
    if (cookie === undefined) throw new Error("Admin cookie was not set");

    const enabled = await runtime.app.inject({
      method: "POST",
      url: "/admin/api/accounts/legacy/enable",
      headers: {
        cookie,
        "x-csrf-token": loginBody.csrf_token
      }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      account: { id: "legacy", enabled: true, health_status: "ready" }
    });
    expect(runtime.dependencies.runtimes.listEnabled()).toHaveLength(1);
  });

  it.each(["missing", "corrupt"] as const)(
    "boots administration with a %s legacy session and returns a recoverable compatibility error",
    async (sessionState) => {
      directory = mkdtempSync(join(tmpdir(), "lingjing-index-test-"));
      const dbPath = join(directory, "jobs.sqlite");
      const env = await fixtureEnvironment(dbPath);
      env.LINGJING_ADMIN_PASSWORD = "fixture-admin-password";
      const storageStatePath = env.LINGJING_STORAGE_STATE;
      if (storageStatePath === undefined) {
        throw new Error("Fixture storage-state path was not configured");
      }
      const validStorageState = readFileSync(storageStatePath);
      if (sessionState === "missing") {
        rmSync(storageStatePath);
      } else {
        writeFileSync(storageStatePath, "{invalid-json");
      }

      runtime = await startServer(env, {
        transport: withAccountRuntime()
      });

      expect(runtime.dependencies.recovery.ready).toBe(true);
      expect(runtime.dependencies.runtimes.listEnabled()).toEqual([]);
      const login = await runtime.app.inject({
        method: "POST",
        url: "/admin/api/login",
        payload: { password: "fixture-admin-password" }
      });
      expect(login.statusCode).toBe(200);
      const loginBody = login.json<{ csrf_token: string }>();
      const setCookie = login.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
        ?.split(";")[0];
      if (cookie === undefined) throw new Error("Admin cookie was not set");
      const compatibility = await runtime.app.inject({
        method: "GET",
        url: "/v1/session",
        headers: {
          authorization: "Bearer fixture-downstream-api-key"
        }
      });
      expect(compatibility.statusCode).toBe(503);
      expect(compatibility.json()).toMatchObject({
        error: {
          type: "login_required",
          code: "lingjing_session_expired"
        }
      });

      writeFileSync(storageStatePath, validStorageState);
      const refreshed = await runtime.app.inject({
        method: "POST",
        url: "/admin/api/accounts/legacy/check",
        headers: {
          cookie,
          "x-csrf-token": loginBody.csrf_token
        }
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json()).toMatchObject({
        account: {
          id: "legacy",
          health_status: "ready"
        }
      });
      const recoveredCompatibility = await runtime.app.inject({
        method: "GET",
        url: "/v1/session",
        headers: {
          authorization: "Bearer fixture-downstream-api-key"
        }
      });
      expect(recoveredCompatibility.statusCode).toBe(200);
      expect(recoveredCompatibility.json()).toMatchObject({
        logged_in: true,
        login_required: false
      });
    }
  );

  it("lazily uses another ready runtime when the legacy session is corrupt", async () => {
    directory = mkdtempSync(join(tmpdir(), "lingjing-index-test-"));
    const dbPath = join(directory, "jobs.sqlite");
    const env = await fixtureEnvironment(dbPath);
    const config = parseConfig(env);
    const store = new SqliteStore(dbPath);
    const accounts = new SqliteAccountRepository(store);
    accounts.ensureLegacyAccount("data/auth");
    const fallback = accounts.create({
      name: "Compatibility fallback",
      priority: 1,
      dailyPointLimit: 0,
      monthlyPointLimit: 0
    });
    const fallbackPaths = accountSessionPaths(config, fallback.id);
    mkdirSync(dirname(fallbackPaths.storageStatePath), { recursive: true });
    copyFileSync(config.storageStatePath, fallbackPaths.storageStatePath);
    copyFileSync(config.sessionProfilePath, fallbackPaths.sessionProfilePath);
    accounts.update(fallback.id, { enabled: true });
    store.close();
    writeFileSync(config.storageStatePath, "{invalid-json");

    runtime = await startServer(env, {
      transport: withAccountRuntime()
    });

    expect(runtime.dependencies.runtimes.listEnabled()).toHaveLength(1);
    const compatibility = await runtime.app.inject({
      method: "GET",
      url: "/v1/session",
      headers: {
        authorization: "Bearer fixture-downstream-api-key"
      }
    });
    expect(compatibility.statusCode).toBe(200);
    expect(compatibility.json()).toEqual({
      mode: "browser-state",
      logged_in: true,
      login_required: false
    });
  });

  it("restores processing work on its disabled bound account after restart", async () => {
    directory = mkdtempSync(join(tmpdir(), "lingjing-index-test-"));
    const dbPath = join(directory, "jobs.sqlite");
    const env = await fixtureEnvironment(dbPath);
    const config = parseConfig(env);
    const store = new SqliteStore(dbPath);
    const repository = new SqliteJobRepository(store);
    const accounts = new SqliteAccountRepository(store);
    accounts.ensureLegacyAccount("data/auth");
    const account = accounts.create({
      name: "Disabled recovery account",
      priority: 1,
      dailyPointLimit: 0,
      monthlyPointLimit: 0
    });
    const sessionPaths = accountSessionPaths(config, account.id);
    mkdirSync(dirname(sessionPaths.storageStatePath), { recursive: true });
    copyFileSync(config.storageStatePath, sessionPaths.storageStatePath);
    copyFileSync(config.sessionProfilePath, sessionPaths.sessionProfilePath);
    accounts.update(account.id, { enabled: true });
    accounts.recordObservation(account.id, {
      healthStatus: "ready",
      lastErrorCode: null,
      subjectHash: "fixture-subject",
      membership: null,
      pointsBalance: 100,
      totalBalance: 100,
      maxConcurrency: 1
    });
    const admissions = new SqliteAdmissionRepository(store);
    const admitted = admissions.reserveOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "fixture-image",
      apiId: "707",
      modelCode: "fixture-model",
      expectedAssetScene: "image-generation",
      requestFingerprint: "e".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 1,
      accountId: account.id,
      quotedPoints: 2,
      windows: budgetWindows()
    });
    if (admitted.outcome !== "created") {
      throw new Error("Fixture admission was not created");
    }
    const submitting = repository.transition(admitted.job.id, ["queued"], {
      status: "submitting",
      submittedAt: Date.now(),
      upstreamFingerprint: "f".repeat(64)
    });
    admissions.charge(admitted.job.id);
    const discovering = repository.transition(
      submitting.id,
      ["submitting"],
      { status: "discovering" }
    );
    const processing = repository.transition(
      discovering.id,
      ["discovering"],
      {
        status: "processing",
        creationCode: "disabled-creation",
        upstreamTaskId: "fixture-disabled-task"
      }
    );
    accounts.update(account.id, { enabled: false });
    repository.close();
    store.close();

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
              taskId: "fixture-disabled-task",
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

    runtime = await startServer(env, {
      transport: withAccountRuntime(transport)
    });
    await started;
    expect(runtime.registry.has(processing.id)).toBe(true);
    expect(runtime.dependencies.runtimes.listEnabled()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ record: { id: account.id } })
      ])
    );

    await runtime.stop();
    releaseRead?.();
    const verified = new SqliteJobRepository(dbPath);
    expect(verified.findById(processing.id)).toMatchObject({
      status: "processing",
      accountId: account.id
    });
    verified.close();
  });

  it("starts recovery before listening and closes HTTP and SQLite cleanly", async () => {
    directory = mkdtempSync(join(tmpdir(), "lingjing-index-test-"));
    const dbPath = join(directory, "jobs.sqlite");
    const env = await fixtureEnvironment(dbPath);
    const port = Number(env.PORT);
    runtime = await startServer(env, {
      transport: withAccountRuntime()
    });

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
      { transport: withAccountRuntime(transport) }
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
        transport: withAccountRuntime(),
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
        transport: withAccountRuntime(transport),
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
