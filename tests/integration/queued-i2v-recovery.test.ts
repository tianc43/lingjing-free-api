import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteRequestSnapshotRepository } from "../../src/generation/request-snapshot-repository.js";
import { JobRunnerRegistry } from "../../src/generation/runner-registry.js";
import { CapacityManager } from "../../src/jobs/capacity.js";
import { StartupRecovery } from "../../src/jobs/recovery.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SqliteAssetRepository } from "../../src/media/asset-repository.js";
import { LocalObjectStore } from "../../src/media/object-store.js";
import type { PreparedMedia } from "../../src/media/types.js";
import type { CapacityLease, JobRecord } from "../../src/jobs/types.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) removeTestDirectory(directory);
});

function inputMedia(body: Buffer): PreparedMedia {
  return {
    filename: "first-frame.png",
    contentType: "image/png",
    size: body.byteLength,
    openRead: () => Readable.from([body]),
    dispose: () => Promise.resolve()
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array | string));
  }
  return Buffer.concat(chunks);
}

describe("queued image-to-video recovery", () => {
  it("rebuilds a queued request and persistent input after restart without creating another job", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-queued-i2v-"));
    directories.push(directory);
    const databasePath = join(directory, "jobs.sqlite");
    const objectsPath = join(directory, "objects");
    const frame = Buffer.from("persistent-first-frame");
    let jobId: string;

    {
      const store = new SqliteStore(databasePath);
      const repository = new SqliteJobRepository(store);
      const assets = new SqliteAssetRepository(store, new LocalObjectStore(objectsPath));
      const snapshots = new SqliteRequestSnapshotRepository(store);
      const job = repository.createOrGet({
        userId: "usr_legacy",
        projectId: "prj_legacy",
        apiKeyId: null,
        kind: "video",
        sourceType: "image-to-video",
        model: "fixture-video",
        apiId: "upstream-video-api",
        modelCode: "video-model-code",
        expectedAssetScene: "video",
        requestFingerprint: "a".repeat(64),
        idempotencyKeyHash: "b".repeat(64),
        spaceId: 1
      }).job;
      const asset = await assets.persistInput({
        userId: "usr_legacy",
        projectId: "prj_legacy",
        media: inputMedia(frame),
        maxBytes: 1024
      });
      assets.bindToJob([asset.id], job.id, "prj_legacy");
      snapshots.save(job.id, {
        principal: {
          userId: "usr_legacy",
          projectId: "prj_legacy",
          apiKeyId: "key_legacy_environment"
        },
        kind: "video",
        sourceType: "image-to-video",
        model: "fixture-video",
        values: { prompt: "animate", duration: 5 },
        media: [],
        idempotencyKey: null
      });
      jobId = job.id;
      repository.close();
      store.close();
    }

    {
      const store = new SqliteStore(databasePath);
      const repository = new SqliteJobRepository(store);
      const assets = new SqliteAssetRepository(store, new LocalObjectStore(objectsPath));
      const snapshots = new SqliteRequestSnapshotRepository(store);
      const capacity = new CapacityManager(2);
      const registry = new JobRunnerRegistry();
      const queuedRuns = vi.fn(async (
        job: JobRecord,
        lease: CapacityLease
      ) => {
        const snapshot = snapshots.find(job.id);
        expect(snapshot?.request).toMatchObject({
          kind: "video",
          sourceType: "image-to-video",
          values: { prompt: "animate", duration: 5 }
        });
        const records = assets.listForJob(job.id, "input");
        expect(records).toHaveLength(1);
        const record = records[0];
        if (record === undefined) throw new Error("Recovered input asset was not found");
        const prepared = await assets.prepared(record);
        expect(await readAll(prepared.openRead())).toEqual(frame);
        repository.transition(job.id, ["queued"], {
          status: "failed",
          failedAt: Date.now(),
          errorCode: "fixture_recovery_completed"
        });
        lease.release();
      });
      const recovery = new StartupRecovery({
        repository,
        capacity,
        registry,
        resumeJob: () => Promise.reject(new Error("Post-submit recovery was not expected")),
        resumeQueuedJob: queuedRuns,
        unknownCapacityHoldMs: 100
      });

      await recovery.start();
      await recovery.waitUntilIdle();
      expect(queuedRuns).toHaveBeenCalledTimes(1);
      expect(repository.findById(jobId)).toMatchObject({
        status: "failed",
        errorCode: "fixture_recovery_completed",
        accountId: "legacy"
      });
      expect(repository.list({ limit: 100 })).toHaveLength(1);
      recovery.close();
      repository.close();
      store.close();
    }
  });
});
