import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRequestFingerprint,
  createUpstreamFingerprint,
  hashIdempotencyKey
} from "../../src/jobs/fingerprint.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import type { JobOutput, JobResult, NewJob } from "../../src/jobs/types.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-jobs-"));
  temporaryDirectories.push(directory);
  return join(directory, "jobs.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

const fixtureNewJob: NewJob = {
  kind: "image",
  sourceType: "image-generation",
  model: "fixture-model",
  apiId: "707",
  modelCode: null,
  expectedAssetScene: "image",
  requestFingerprint: "a".repeat(64),
  idempotencyKeyHash: null,
  spaceId: 0
};

const fixtureOutput: JobOutput = {
  url: "https://output.example/final.png?token=allowed-output-metadata",
  posterUrl: null,
  width: 1024,
  height: 1024,
  duration: null,
  format: "png"
};

const fixtureResult: JobResult = { outputs: [fixtureOutput] };

function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (cause) {
    expect(cause).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

function rawJob(databasePath: string, jobId: string): Record<string, unknown> {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown>;
  } finally {
    database.close();
  }
}

describe("job fingerprints", () => {
  it("hashes idempotency keys without retaining their raw value", () => {
    const hash = hashIdempotencyKey("private-idempotency-key");

    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).not.toContain("private-idempotency-key");
  });

  it("canonicalizes sorted request keys while including model, parameters, and content hashes", () => {
    const first = createRequestFingerprint({
      model: "fixture-model",
      parameters: {
        prompt: "fixture prompt",
        nested: { z: true, a: 1 },
        size: "1024x1024"
      },
      inputContentHashes: ["b".repeat(64), "a".repeat(64)]
    });
    const reordered = createRequestFingerprint({
      inputContentHashes: ["b".repeat(64), "a".repeat(64)],
      parameters: {
        size: "1024x1024",
        nested: { a: 1, z: true },
        prompt: "fixture prompt"
      },
      model: "fixture-model"
    });
    const reorderedInputs = createRequestFingerprint({
      model: "fixture-model",
      parameters: {
        prompt: "fixture prompt",
        nested: { z: true, a: 1 },
        size: "1024x1024"
      },
      inputContentHashes: ["a".repeat(64), "b".repeat(64)]
    });
    const changedInput = createRequestFingerprint({
      model: "fixture-model",
      parameters: {
        prompt: "fixture prompt",
        nested: { z: true, a: 1 },
        size: "1024x1024"
      },
      inputContentHashes: ["c".repeat(64)]
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(reorderedInputs);
    expect(first).not.toBe(changedInput);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("canonicalizes upstream payloads independently of object key order", () => {
    expect(createUpstreamFingerprint({
      params: [{ name: "prompt", values: "secret" }],
      apiId: "707",
      nested: { z: 2, a: 1 }
    })).toBe(createUpstreamFingerprint({
      nested: { a: 1, z: 2 },
      apiId: "707",
      params: [{ values: "secret", name: "prompt" }]
    }));
  });
});

describe("SqliteJobRepository", () => {
  it("rejects unhashed values at the persistence boundary", () => {
    const repository = new SqliteJobRepository(":memory:");

    expect(() => repository.createOrGet({
      ...fixtureNewJob,
      requestFingerprint: "fixture prompt"
    })).toThrowError(/SHA-256/u);
    expect(() => repository.createOrGet({
      ...fixtureNewJob,
      requestFingerprint: "a".repeat(64),
      idempotencyKeyHash: "raw-idempotency-key"
    })).toThrowError(/SHA-256/u);
    repository.close();
  });

  it("stores only hashes and result metadata", () => {
    const repository = new SqliteJobRepository(":memory:");
    const { job } = repository.createOrGet(fixtureNewJob);
    repository.transition(job.id, ["queued"], {
      status: "failed",
      errorCode: "safe_error_code",
      result: {
        outputs: [{
          ...fixtureOutput,
          prompt: "fixture prompt",
          input: "https://input.example/private.png"
        }]
      } as unknown as JobResult
    });

    const serialized = JSON.stringify(repository.findById(job.id));
    expect(serialized).not.toContain("fixture prompt");
    expect(serialized).not.toContain("https://input.example");
    expect(job.id).toMatch(/^job_[0-9a-f]{32}$/u);
    repository.close();
  });

  it("returns the same job for a repeated idempotency hash", () => {
    const repository = new SqliteJobRepository(":memory:");
    const first = repository.createOrGet({
      ...fixtureNewJob,
      idempotencyKeyHash: "b".repeat(64)
    });
    const second = repository.createOrGet({
      ...fixtureNewJob,
      idempotencyKeyHash: "b".repeat(64)
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    repository.close();
  });

  it("rejects the same idempotency hash with a different fingerprint", () => {
    const repository = new SqliteJobRepository(":memory:");
    repository.createOrGet({
      ...fixtureNewJob,
      idempotencyKeyHash: "b".repeat(64)
    });

    expectErrorCode(() => repository.createOrGet({
      ...fixtureNewJob,
      requestFingerprint: "c".repeat(64),
      idempotencyKeyHash: "b".repeat(64)
    }), "idempotency_conflict");
    repository.close();
  });

  it("rejects a raw upstream payload in place of its fingerprint", () => {
    const repository = new SqliteJobRepository(":memory:");
    const { job } = repository.createOrGet({
      ...fixtureNewJob,
      requestFingerprint: "a".repeat(64)
    });

    expect(() => repository.transition(job.id, ["queued"], {
      status: "submitting",
      upstreamFingerprint: "fixture prompt"
    })).toThrowError(/SHA-256/u);
    repository.close();
  });

  it("atomically rejects unknown transitions without a hold deadline", () => {
    const repository = new SqliteJobRepository(":memory:");
    const { job } = repository.createOrGet({
      ...fixtureNewJob,
      requestFingerprint: "a".repeat(64)
    });
    repository.transition(job.id, ["queued"], { status: "submitting" });

    expect(() => repository.transition(job.id, ["submitting"], {
      status: "unknown"
    })).toThrowError(/hold deadline/u);
    expect(repository.findById(job.id)?.status).toBe("submitting");
    repository.close();
  });

  it("allows only one creator under cross-process idempotency contention", async () => {
    const databasePath = temporaryDatabasePath();
    const startMarker = join(databasePath, "..", "start");
    const moduleUrl = pathToFileURL(join(
      process.cwd(),
      "src",
      "jobs",
      "sqlite-repository.ts"
    )).href;
    const input = Buffer.from(JSON.stringify({
      ...fixtureNewJob,
      idempotencyKeyHash: "d".repeat(64)
    })).toString("base64url");
    const script = [
      "import { existsSync } from 'node:fs';",
      "import { setTimeout as delay } from 'node:timers/promises';",
      `import { SqliteJobRepository } from ${JSON.stringify(moduleUrl)};`,
      "while (!existsSync(process.argv[3])) await delay(5);",
      "const repository = new SqliteJobRepository(process.argv[1]);",
      "const value = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));",
      "const result = repository.createOrGet(value);",
      "repository.close();",
      "process.stdout.write(JSON.stringify({ created: result.created, id: result.job.id }));"
    ].join("\n");

    const attempts = Array.from({ length: 6 }, async () => {
      const { stdout } = await execFileAsync(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
        databasePath,
        input,
        startMarker
      ], {
        cwd: process.cwd(),
        windowsHide: true
      });
      return JSON.parse(stdout) as { created: boolean; id: string };
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    writeFileSync(startMarker, "", "utf8");
    const results = await Promise.all(attempts);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.id))).toHaveLength(1);
  }, 20_000);

  it("rejects illegal transitions atomically", () => {
    const repository = new SqliteJobRepository(":memory:");
    const { job } = repository.createOrGet(fixtureNewJob);

    expect(() => repository.transition(job.id, ["processing"], {
      status: "completed",
      result: fixtureResult
    })).toThrow();
    expect(repository.findById(job.id)?.status).toBe("queued");
    repository.close();
  });

  it("checks both expected state and the allowed transition graph", () => {
    const repository = new SqliteJobRepository(":memory:");
    const { job } = repository.createOrGet(fixtureNewJob);

    expect(() => repository.transition(job.id, ["queued"], {
      status: "completed",
      result: fixtureResult
    })).toThrow();
    expect(repository.findById(job.id)?.status).toBe("queued");
    repository.close();
  });

  it("rolls back a state update when history insertion fails", () => {
    const databasePath = temporaryDatabasePath();
    const first = new SqliteJobRepository(databasePath);
    const { job } = first.createOrGet(fixtureNewJob);
    first.close();
    const database = new Database(databasePath);
    database.exec(`
      CREATE TRIGGER fail_history_insert
      BEFORE INSERT ON job_status_history
      WHEN NEW.status = 'submitting'
      BEGIN
        SELECT RAISE(ABORT, 'injected history failure');
      END
    `);
    database.close();
    const repository = new SqliteJobRepository(databasePath);

    expect(() => repository.transition(job.id, ["queued"], {
      status: "submitting",
      submittedAt: 1234
    })).toThrowError(/injected history failure/u);
    expect(repository.findById(job.id)).toMatchObject({
      status: "queued",
      submittedAt: null
    });
    repository.close();
  });

  it("commits each transition and history row together", () => {
    const databasePath = temporaryDatabasePath();
    const repository = new SqliteJobRepository(databasePath);
    const { job } = repository.createOrGet(fixtureNewJob);
    repository.transition(job.id, ["queued"], {
      status: "submitting",
      submittedAt: 1234
    });
    repository.close();
    const database = new Database(databasePath, { readonly: true });
    const rows = database.prepare(`
      SELECT status FROM job_status_history WHERE job_id = ? ORDER BY id
    `).all(job.id) as Array<{ status: string }>;
    database.close();

    expect(rows.map((row) => row.status)).toEqual(["queued", "submitting"]);
  });

  it("reopens a file database with recoverable jobs intact", () => {
    const databasePath = temporaryDatabasePath();
    const first = new SqliteJobRepository(databasePath);
    const { job } = first.createOrGet(fixtureNewJob);
    first.transition(job.id, ["queued"], { status: "submitting" });
    first.close();
    const second = new SqliteJobRepository(databasePath);

    expect(second.recoverable().map((item) => item.id)).toContain(job.id);
    second.close();
  });

  it("recovers only active and unexpired unknown jobs", () => {
    const repository = new SqliteJobRepository(":memory:");
    const submitting = repository.createOrGet(fixtureNewJob).job;
    repository.transition(submitting.id, ["queued"], { status: "submitting" });
    const heldUnknown = repository.createOrGet(fixtureNewJob).job;
    repository.transition(heldUnknown.id, ["queued"], { status: "submitting" });
    repository.transition(heldUnknown.id, ["submitting"], {
      status: "unknown",
      unknownHoldUntil: 10_000
    });
    const expiredUnknown = repository.createOrGet(fixtureNewJob).job;
    repository.transition(expiredUnknown.id, ["queued"], { status: "submitting" });
    repository.transition(expiredUnknown.id, ["submitting"], {
      status: "unknown",
      unknownHoldUntil: 9_999
    });
    const completed = repository.createOrGet(fixtureNewJob).job;
    repository.transition(completed.id, ["queued"], { status: "submitting" });
    repository.transition(completed.id, ["submitting"], { status: "discovering" });
    repository.transition(completed.id, ["discovering"], {
      status: "completed",
      result: fixtureResult
    });

    expect(repository.recoverable(9_999).map((job) => job.id)).toEqual([
      submitting.id,
      heldUnknown.id
    ]);
    expect(repository.recoverable(10_000).map((job) => job.id)).toEqual([
      submitting.id
    ]);
    repository.close();
  });

  it("lists jobs by status and limit without content fields", () => {
    const repository = new SqliteJobRepository(":memory:");
    const first = repository.createOrGet(fixtureNewJob).job;
    const second = repository.createOrGet({ ...fixtureNewJob, kind: "video" }).job;
    repository.transition(first.id, ["queued"], { status: "failed", errorCode: "safe" });

    expect(repository.list({ status: "queued", limit: 1 }).map((job) => job.id)).toEqual([
      second.id
    ]);
    repository.close();
  });

  it("checkpoints and closes once, then rejects later operations", () => {
    const databasePath = temporaryDatabasePath();
    const repository = new SqliteJobRepository(databasePath);
    repository.createOrGet(fixtureNewJob);

    repository.close();
    expect(() => {
      repository.close();
    }).not.toThrow();
    expect(() => repository.findById("job_missing")).toThrowError(/closed/u);
    expect(() => repository.recoverable()).toThrowError(/closed/u);
    expect(rawJob(databasePath, "job_missing")).toBeUndefined();
  });
});
