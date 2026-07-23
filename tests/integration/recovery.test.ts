import {
  existsSync,
  mkdtempSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
