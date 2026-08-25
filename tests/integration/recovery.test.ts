import {
  existsSync,
  mkdtempSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteAdmissionRepository } from "../../src/accounts/sqlite-admission-repository.js";
import { CapacityManager } from "../../src/jobs/capacity.js";
import { discoverAsset } from "../../src/jobs/discovery.js";
import {
  JobRunnerRegistry,
  removeOrphanTemporaryFiles,
  StartupRecovery
} from "../../src/jobs/recovery.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { fingerprintUpstreamPayload } from "../../src/jobs/upstream-fingerprint.js";
import type {
  CapacityLease,
  JobRecord,
  NewJob
} from "../../src/jobs/types.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTestDirectory(directory);
  }
});

const fixtureNewJob: NewJob = {
  kind: "image",
  sourceType: "image-generation",
  model: "fixture-model",
  apiId: "707",
  modelCode: "model-v1",
  expectedAssetScene: "image-generation",
  requestFingerprint: "a".repeat(64),
  idempotencyKeyHash: null,
  spaceId: 0
};

function createRepository(): SqliteJobRepository {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-recovery-"));
  directories.push(directory);
  return new SqliteJobRepository(join(directory, "jobs.sqlite"));
}

function createVersionTwoDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-recovery-v2-"));
  directories.push(directory);
  const path = join(directory, "jobs.sqlite");
  const database = new Database(path);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_migrations(version, applied_at) VALUES (2, 1);

    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source_type TEXT NOT NULL,
      model TEXT NOT NULL,
      api_id TEXT NOT NULL,
      model_code TEXT,
      expected_asset_scene TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      idempotency_key_hash TEXT,
      space_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      creation_code TEXT,
      upstream_task_id TEXT,
      upstream_fingerprint TEXT,
      submitted_at INTEGER,
      discovered_at INTEGER,
      completed_at INTEGER,
      failed_at INTEGER,
      unknown_hold_until INTEGER,
      error_code TEXT,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      account_id TEXT,
      quoted_points REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE job_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL,
      priority INTEGER NOT NULL,
      daily_point_limit REAL NOT NULL,
      monthly_point_limit REAL NOT NULL,
      auth_directory TEXT NOT NULL UNIQUE,
      health_status TEXT NOT NULL,
      last_error_code TEXT,
      subject_hash TEXT,
      points_balance REAL,
      total_balance REAL,
      max_concurrency INTEGER,
      last_checked_at INTEGER,
      last_selected_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE budget_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
      quoted_points REAL NOT NULL,
      state TEXT NOT NULL,
      day_window_start INTEGER NOT NULL,
      month_window_start INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO accounts (
      id, name, enabled, priority, daily_point_limit, monthly_point_limit,
      auth_directory, health_status, created_at, updated_at
    ) VALUES (
      'legacy', 'Legacy account', 1, 0, 0, 0,
      'data/auth', 'unknown', 1, 1
    );
    INSERT INTO jobs (
      id, kind, source_type, model, api_id, expected_asset_scene,
      request_fingerprint, space_id, status, created_at, updated_at,
      account_id, quoted_points
    ) VALUES
      (
        'job_v2_queued', 'image', 'image-generation', 'fixture', '707',
        'image-generation', '${"d".repeat(64)}', 0, 'queued', 2, 2,
        'legacy', 0
      ),
      (
        'job_v2_completed', 'image', 'image-generation', 'fixture', '707',
        'image-generation', '${"e".repeat(64)}', 0, 'completed', 3, 3,
        'legacy', 7
      ),
      (
        'job_v2_failed', 'image', 'image-generation', 'fixture', '707',
        'image-generation', '${"f".repeat(64)}', 0, 'failed', 4, 4,
        'legacy', 0
      );
    INSERT INTO job_status_history(job_id, status, created_at) VALUES
      ('job_v2_queued', 'queued', 2),
      ('job_v2_completed', 'completed', 3),
      ('job_v2_failed', 'failed', 4);
    INSERT INTO budget_entries (
      account_id, job_id, quoted_points, state, day_window_start,
      month_window_start, created_at, updated_at
    ) VALUES
      ('legacy', 'job_v2_queued', 0, 'charged', 0, 0, 2, 2),
      ('legacy', 'job_v2_completed', 7, 'charged', 0, 0, 3, 3),
      ('legacy', 'job_v2_failed', 0, 'charged', 0, 0, 4, 4);
  `);
  database.close();
  return path;
}

function createVersionThreeDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-recovery-v3-"));
  directories.push(directory);
  const path = join(directory, "jobs.sqlite");
  const database = new Database(path);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_migrations(version, applied_at) VALUES
      (1, 1),
      (2, 2),
      (3, 3);

    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
      source_type TEXT NOT NULL,
      model TEXT NOT NULL,
      api_id TEXT NOT NULL,
      model_code TEXT,
      expected_asset_scene TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      idempotency_key_hash TEXT,
      space_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'queued',
          'submitting',
          'discovering',
          'processing',
          'unknown',
          'completed',
          'failed'
        )
      ),
      creation_code TEXT,
      upstream_task_id TEXT,
      upstream_fingerprint TEXT,
      submitted_at INTEGER,
      discovered_at INTEGER,
      completed_at INTEGER,
      failed_at INTEGER,
      unknown_hold_until INTEGER,
      error_code TEXT,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      account_id TEXT,
      quoted_points REAL NOT NULL DEFAULT 0,
      quote_known INTEGER NOT NULL DEFAULT 1
      CHECK (quote_known IN (0, 1))
    );
    CREATE UNIQUE INDEX jobs_idempotency_key_hash_unique
    ON jobs(idempotency_key_hash)
    WHERE idempotency_key_hash IS NOT NULL;
    CREATE INDEX jobs_status_updated_at_idx
    ON jobs(status, updated_at);
    CREATE TABLE job_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (
        status IN (
          'queued',
          'submitting',
          'discovering',
          'processing',
          'unknown',
          'completed',
          'failed'
        )
      ),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      priority INTEGER NOT NULL CHECK (priority >= 0),
      daily_point_limit REAL NOT NULL CHECK (daily_point_limit >= 0),
      monthly_point_limit REAL NOT NULL CHECK (monthly_point_limit >= 0),
      auth_directory TEXT NOT NULL UNIQUE,
      health_status TEXT NOT NULL CHECK (
        health_status IN ('unknown', 'ready', 'needs_login', 'unhealthy')
      ),
      last_error_code TEXT,
      subject_hash TEXT,
      points_balance REAL,
      total_balance REAL,
      max_concurrency INTEGER,
      last_checked_at INTEGER,
      last_selected_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE budget_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
      quoted_points REAL NOT NULL CHECK (quoted_points >= 0),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'charged', 'released')),
      day_window_start INTEGER NOT NULL,
      month_window_start INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX budget_entries_account_day_idx
    ON budget_entries(account_id, day_window_start, state);
    CREATE INDEX budget_entries_account_month_idx
    ON budget_entries(account_id, month_window_start, state);
    INSERT INTO accounts (
      id, name, enabled, priority, daily_point_limit, monthly_point_limit,
      auth_directory, health_status, created_at, updated_at
    ) VALUES (
      'legacy', 'Legacy account', 1, 0, 0, 0,
      'data/auth', 'unknown', 1, 1
    );
    INSERT INTO jobs (
      id, kind, source_type, model, api_id, expected_asset_scene,
      request_fingerprint, space_id, status, submitted_at, failed_at,
      created_at, updated_at, account_id, quoted_points
    ) VALUES
      (
        'job_v3_unknown_quote', 'image', 'image-generation', 'fixture', '707',
        'image-generation', '${"a".repeat(64)}', 0, 'queued', NULL, NULL,
        2, 2, 'legacy', 0
      ),
      (
        'job_v3_known_zero', 'image', 'image-generation', 'fixture', '707',
        'image-generation', '${"g".repeat(64)}', 0, 'completed', NULL, NULL,
        4, 4, 'legacy', 0
      ),
      (
        'job_v3_submitted_failed', 'image', 'image-generation', 'fixture', '707',
        'image-generation', '${"b".repeat(64)}', 0, 'failed', 3, 4,
        3, 4, 'legacy', 7
      ),
      (
        'job_v3_unsubmitted_failed', 'image', 'image-generation', 'fixture', '707',
        'image-generation', '${"c".repeat(64)}', 0, 'failed', NULL, 5,
        5, 5, 'legacy', 5
      ),
      (
        'job_v3_processing', 'image', 'image-generation', 'fixture', '707',
        'image-generation', '${"d".repeat(64)}', 0, 'processing', 6, NULL,
        6, 6, 'legacy', 9
      ),
      (
        'job_v3_unsubmitted_charged', 'image', 'image-generation', 'fixture', '707',
        'image-generation', '${"f".repeat(64)}', 0, 'failed', NULL, 7,
        7, 7, 'legacy', 6
      );
    INSERT INTO job_status_history(job_id, status, created_at) VALUES
      ('job_v3_unknown_quote', 'queued', 2),
      ('job_v3_submitted_failed', 'failed', 4),
      ('job_v3_unsubmitted_failed', 'failed', 5),
      ('job_v3_processing', 'processing', 6),
      ('job_v3_unsubmitted_charged', 'failed', 7);
    INSERT INTO budget_entries (
      account_id, job_id, quoted_points, state, day_window_start,
      month_window_start, created_at, updated_at
    ) VALUES
      ('legacy', 'job_v3_unknown_quote', 0, 'charged', 0, 0, 2, 2),
      ('legacy', 'job_v3_submitted_failed', 7, 'charged', 0, 0, 3, 4),
      ('legacy', 'job_v3_unsubmitted_failed', 5, 'reserved', 0, 0, 5, 5),
      ('legacy', 'job_v3_processing', 9, 'reserved', 0, 0, 6, 6),
      ('legacy', 'job_v3_unsubmitted_charged', 6, 'charged', 0, 0, 7, 7);
  `);
  database.close();
  return path;
}

function submitting(repository: SqliteJobRepository): JobRecord {
  const job = repository.createOrGet(fixtureNewJob).job;
  return repository.transition(job.id, ["queued"], {
    status: "submitting",
    submittedAt: 10_000,
    upstreamFingerprint: "b".repeat(64)
  });
}

function recoveryTransport(records: readonly unknown[] = []): {
  transport: LingjingTransport;
  read: ReturnType<typeof vi.fn>;
  submitOnce: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(() => Promise.resolve({ records }));
  const submitOnce = vi.fn(() => Promise.resolve({}));
  return {
    transport: { read, submitOnce } as unknown as LingjingTransport,
    read,
    submitOnce
  };
}

function submissionSensitiveResumeRunner(
  repository: SqliteJobRepository,
  transport: LingjingTransport
): (job: JobRecord, lease: CapacityLease) => Promise<void> {
  return async (job, lease) => {
    try {
      if (job.status === "queued" || job.status === "submitting") {
        await transport.submitOnce(
          "/joycreator/AIModelApiConsole/executeByApiId",
          { apiId: job.apiId, params: [] }
        );
        return;
      }
      if (job.status !== "discovering") return;
      const discovered = await discoverAsset(transport, job);
      const asset = discovered.asset;
      if (asset?.taskId === null || asset?.taskId === undefined) return;
      repository.transition(job.id, ["discovering"], {
        status: "processing",
        upstreamTaskId: asset.taskId,
        creationCode: asset.creationCode,
        discoveredAt: 10_200
      });
    } finally {
      lease.release();
    }
  };
}

describe("startup recovery", () => {
  it("migrates v3 quote and budget semantics without refunding submitted failures", () => {
    const store = new SqliteStore(createVersionThreeDatabase());
    const repository = new SqliteJobRepository(store);

    try {
      expect(store.read((database) => database.prepare(`
        SELECT MAX(version) AS version FROM schema_migrations
      `).get())).toEqual({ version: 16 });
      expect(repository.findById("job_v3_unknown_quote")?.quotedPoints).toBeNull();
      expect(repository.findById("job_v3_known_zero")?.quotedPoints).toBe(0);
      expect(store.read((database) => database.prepare(`
        SELECT dflt_value FROM pragma_table_info('jobs')
        WHERE name = 'quote_known'
      `).get())).toEqual({ dflt_value: "1" });
      const created = repository.createOrGet({
        ...fixtureNewJob,
        requestFingerprint: "e".repeat(64)
      }).job;
      expect(created.quotedPoints).toBeNull();
      expect(store.read((database) => database.prepare(`
        SELECT quote_known FROM jobs WHERE id = ?
      `).get(created.id))).toEqual({ quote_known: 0 });
      expect(store.read((database) => database.prepare(`
        SELECT job_id, state FROM budget_entries
        WHERE job_id LIKE 'job_v3_%'
        ORDER BY job_id
      `).all())).toEqual([
        { job_id: "job_v3_processing", state: "charged" },
        { job_id: "job_v3_submitted_failed", state: "charged" },
        { job_id: "job_v3_unknown_quote", state: "reserved" },
        { job_id: "job_v3_unsubmitted_charged", state: "released" },
        { job_id: "job_v3_unsubmitted_failed", state: "released" }
      ]);
    } finally {
      repository.close();
      store.close();
    }
  });

  it("migrates a v2 queued charged job before atomic startup recovery", async () => {
    const store = new SqliteStore(createVersionTwoDatabase());
    const repository = new SqliteJobRepository(store);
    const admissions = new SqliteAdmissionRepository(store);
    const resumeJob = vi.fn(() => Promise.resolve());
    const recovery = new StartupRecovery({
      repository,
      admissions,
      capacity: new CapacityManager(5),
      registry: new JobRunnerRegistry(),
      resumeJob,
      unknownCapacityHoldMs: 900_000
    });

    try {
      expect(repository.findById("job_v2_queued")?.quotedPoints).toBeNull();
      expect(repository.findById("job_v2_completed")?.quotedPoints).toBe(7);
      expect(store.read((database) => database.prepare(`
        SELECT id, quote_known FROM jobs ORDER BY id
      `).all())).toEqual([
        { id: "job_v2_completed", quote_known: 1 },
        { id: "job_v2_failed", quote_known: 0 },
        { id: "job_v2_queued", quote_known: 0 }
      ]);
      expect(store.read((database) => database.prepare(`
        SELECT dflt_value FROM pragma_table_info('jobs')
        WHERE name = 'quote_known'
      `).get())).toEqual({ dflt_value: "1" });
      expect(store.read((database) => database.prepare(`
        SELECT job_id, state FROM budget_entries
        WHERE job_id IN ('job_v2_queued', 'job_v2_failed')
        ORDER BY job_id
      `).all())).toEqual([
        { job_id: "job_v2_failed", state: "released" },
        { job_id: "job_v2_queued", state: "reserved" }
      ]);

      await expect(recovery.start()).resolves.toBeUndefined();

      expect(repository.findById("job_v2_queued")).toMatchObject({
        status: "failed",
        errorCode: "interrupted_before_submit",
        quotedPoints: null
      });
      expect(store.read((database) => database.prepare(`
        SELECT state FROM budget_entries WHERE job_id = 'job_v2_queued'
      `).get())).toEqual({ state: "released" });
      expect(store.read((database) => database.prepare(`
        SELECT status FROM job_status_history
        WHERE job_id = 'job_v2_queued' ORDER BY id
      `).all())).toEqual([{ status: "queued" }, { status: "failed" }]);
      expect(resumeJob).not.toHaveBeenCalled();
    } finally {
      recovery.close();
      store.close();
    }
  });

  it("removes real orphan media files older than the last clean start", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-orphans-"));
    directories.push(directory);
    const oldTemp = join(
      directory,
      "upload-11111111-1111-4111-8111-111111111111.png"
    );
    const newTemp = join(
      directory,
      "upload-22222222-2222-4222-8222-222222222222.mp4"
    );
    for (const path of [oldTemp, newTemp]) {
      writeFileSync(path, "fixture");
    }
    utimesSync(oldTemp, new Date(1_000), new Date(1_000));
    utimesSync(newTemp, new Date(3_000), new Date(3_000));

    await removeOrphanTemporaryFiles(directory, 2_000);

    expect(existsSync(oldTemp)).toBe(false);
    expect(existsSync(newTemp)).toBe(true);
  });

  it("recovers a submitting job without issuing another generation POST", async () => {
    const repository = createRepository();
    const job = submitting(repository);
    const upstream = recoveryTransport();
    const resumeJob = vi.fn(
      submissionSensitiveResumeRunner(repository, upstream.transport)
    );
    const recovery = new StartupRecovery({
      repository,
      capacity: new CapacityManager(5),
      registry: new JobRunnerRegistry(),
      resumeJob,
      unknownCapacityHoldMs: 900_000
    });

    expect(recovery.ready).toBe(false);
    await recovery.start();
    await recovery.waitUntilIdle();

    expect(recovery.ready).toBe(true);
    expect(resumeJob).toHaveBeenCalledTimes(1);
    expect(repository.findById(job.id)?.status).toBe("discovering");
    expect(upstream.submitOnce).toHaveBeenCalledTimes(0);
    recovery.close();
    repository.close();
  });

  it("reopens the database and discovers the task without a generation POST", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-restart-"));
    directories.push(directory);
    const databasePath = join(directory, "jobs.sqlite");
    const payload = {
      apiId: "707",
      refId: "fixture-ref",
      params: [{ idx: "1", values: "restart fixture" }]
    };
    const firstRepository = new SqliteJobRepository(databasePath);
    const created = firstRepository.createOrGet(fixtureNewJob).job;
    firstRepository.transition(created.id, ["queued"], {
      status: "submitting",
      submittedAt: 10_000,
      upstreamFingerprint: fingerprintUpstreamPayload(payload)
    });
    firstRepository.close();

    const upstream = recoveryTransport([{
        id: "fixture-asset",
        scene: "image-generation",
        modelCode: "model-v1",
        createTime: 10_100,
        taskId: "fixture-task",
        creationCode: "fixture-creation",
        reqParam: JSON.stringify(payload),
        status: 0
      }]);
    const secondRepository = new SqliteJobRepository(databasePath);
    const recovery = new StartupRecovery({
      repository: secondRepository,
      capacity: new CapacityManager(5),
      registry: new JobRunnerRegistry(),
      resumeJob: submissionSensitiveResumeRunner(
        secondRepository,
        upstream.transport
      ),
      unknownCapacityHoldMs: 900_000
    });

    try {
      await recovery.start();
      await recovery.waitUntilIdle();

      expect(upstream.submitOnce).toHaveBeenCalledTimes(0);
      expect(secondRepository.findById(created.id)).toMatchObject({
        status: "processing",
        upstreamTaskId: "fixture-task",
        creationCode: "fixture-creation"
      });
    } finally {
      recovery.close();
      secondRepository.close();
    }
  });

  it("hands the restored capacity lease to the single resumed owner", async () => {
    const repository = createRepository();
    const job = submitting(repository);
    const capacity = new CapacityManager(5);
    const resumeJob = vi.fn((_recovered: JobRecord, lease: {
      jobId: string;
      release(): void;
    }) => {
      expect(lease.jobId).toBe(job.id);
      lease.release();
      return Promise.resolve();
    });
    const recovery = new StartupRecovery({
      repository,
      capacity,
      registry: new JobRunnerRegistry(),
      resumeJob,
      unknownCapacityHoldMs: 900_000
    });

    await recovery.start();
    await recovery.waitUntilIdle();

    expect(resumeJob).toHaveBeenCalledTimes(1);
    expect(capacity.activeJobIds()).toEqual([]);
    recovery.close();
    repository.close();
  });

  it("fails an interrupted queued job without any upstream request", async () => {
    const repository = createRepository();
    const job = repository.createOrGet(fixtureNewJob).job;
    const upstream = recoveryTransport();
    const resumeJob = vi.fn(
      submissionSensitiveResumeRunner(repository, upstream.transport)
    );
    const recovery = new StartupRecovery({
      repository,
      capacity: new CapacityManager(5),
      registry: new JobRunnerRegistry(),
      resumeJob,
      unknownCapacityHoldMs: 900_000
    });

    await recovery.start();

    expect(repository.findById(job.id)).toMatchObject({
      status: "failed",
      errorCode: "interrupted_before_submit"
    });
    expect(resumeJob).not.toHaveBeenCalled();
    expect(upstream.submitOnce).toHaveBeenCalledTimes(0);
    recovery.close();
    repository.close();
  });

  it("can retry startup after transient orphan cleanup failure", async () => {
    const repository = createRepository();
    let attempts = 0;
    const recovery = new StartupRecovery({
      repository,
      capacity: new CapacityManager(5),
      registry: new JobRunnerRegistry(),
      resumeJob: vi.fn(() => Promise.resolve()),
      unknownCapacityHoldMs: 900_000,
      cleanupOrphans: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("transient cleanup failure"))
          : Promise.resolve();
      }
    });

    await expect(recovery.start()).rejects.toThrowError(
      "transient cleanup failure"
    );
    expect(recovery.ready).toBe(false);
    await recovery.start();
    expect(recovery.ready).toBe(true);
    expect(attempts).toBe(2);
    recovery.close();
    repository.close();
  });

  it("can retry startup after synchronous orphan cleanup failure", async () => {
    const repository = createRepository();
    let attempts = 0;
    const recovery = new StartupRecovery({
      repository,
      capacity: new CapacityManager(5),
      registry: new JobRunnerRegistry(),
      resumeJob: vi.fn(() => Promise.resolve()),
      unknownCapacityHoldMs: 900_000,
      cleanupOrphans: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("synchronous cleanup failure");
        return Promise.resolve();
      }
    });

    await expect(recovery.start()).rejects.toThrowError(
      "synchronous cleanup failure"
    );
    await recovery.start();
    expect(recovery.ready).toBe(true);
    expect(attempts).toBe(2);
    recovery.close();
    repository.close();
  });

  it("shares one initialization promise across concurrent starts", async () => {
    const repository = createRepository();
    let releaseCleanup: (() => void) | undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupOrphans = vi.fn(() => cleanupGate);
    const recovery = new StartupRecovery({
      repository,
      capacity: new CapacityManager(5),
      registry: new JobRunnerRegistry(),
      resumeJob: vi.fn(() => Promise.resolve()),
      unknownCapacityHoldMs: 900_000,
      cleanupOrphans
    });

    const first = recovery.start();
    const second = recovery.start();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    expect(second).toBe(first);
    expect(secondSettled).toBe(false);
    expect(cleanupOrphans).toHaveBeenCalledTimes(1);
    expect(recovery.ready).toBe(false);
    releaseCleanup?.();
    await Promise.all([first, second]);
    expect(recovery.ready).toBe(true);
    recovery.close();
    repository.close();
  });

  it("shares one owner across repeated scans and manual resume calls", async () => {
    const repository = createRepository();
    const job = submitting(repository);
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const resumeJob = vi.fn(async () => gate);
    const registry = new JobRunnerRegistry();
    const recovery = new StartupRecovery({
      repository,
      capacity: new CapacityManager(5),
      registry,
      resumeJob,
      unknownCapacityHoldMs: 900_000
    });

    await recovery.start();
    const first = recovery.resume(job.id);
    const second = recovery.scan();
    expect(resumeJob).toHaveBeenCalledTimes(1);
    finish?.();
    await Promise.all([first, second]);
    await recovery.waitUntilIdle();
    expect(resumeJob).toHaveBeenCalledTimes(1);
    recovery.close();
    repository.close();
  });

  it("expires unknown capacity holds without marking upstream work failed", async () => {
    const repository = createRepository();
    const job = submitting(repository);
    const unknown = repository.transition(job.id, ["submitting"], {
      status: "unknown",
      unknownHoldUntil: 9_000
    });
    const capacity = new CapacityManager(5);
    capacity.restore(unknown.id, "unknown", unknown.unknownHoldUntil, 0);
    const recovery = new StartupRecovery({
      repository,
      capacity,
      registry: new JobRunnerRegistry(),
      resumeJob: vi.fn(),
      unknownCapacityHoldMs: 4_000,
      now: () => 10_000
    });

    await recovery.start();

    expect(capacity.activeJobIds()).not.toContain(job.id);
    expect(repository.findById(job.id)?.status).toBe("unknown");
    recovery.close();
    repository.close();
  });
});
