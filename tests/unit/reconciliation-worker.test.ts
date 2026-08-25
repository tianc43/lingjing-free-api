import { describe, expect, it, vi } from "vitest";
import { ReconciliationWorker } from "../../src/jobs/reconciliation-worker.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SqliteWorkerLeaseRepository } from "../../src/jobs/worker-lease-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";

function setup(status: 0 | 1 | 2) {
  let now = 1_000;
  const store = new SqliteStore(":memory:");
  const repository = new SqliteJobRepository(store);
  const leases = new SqliteWorkerLeaseRepository(store, () => now);
  const job = repository.createOrGet({
    kind: "video",
    sourceType: "text-to-video",
    model: "fixture-video",
    apiId: "upstream-api",
    modelCode: null,
    expectedAssetScene: "video",
    requestFingerprint: "a".repeat(64),
    idempotencyKeyHash: null,
    spaceId: 1
  }).job;
  repository.transition(job.id, ["queued"], { status: "submitting", submittedAt: now });
  repository.transition(job.id, ["submitting"], { status: "discovering" });
  repository.transition(job.id, ["discovering"], {
    status: "processing",
    upstreamTaskId: "fixture-task-1",
    creationCode: "creation-1",
    discoveredAt: now,
    processingDeadlineAt: now
  });
  repository.transition(job.id, ["processing"], {
    status: "unknown",
    unknownHoldUntil: now + 1,
    reconcileAfter: now,
    uncertaintyReason: "provider_status_unknown",
    errorCode: "generation_processing_deadline_exceeded"
  });
  const read = vi.fn(() => Promise.resolve({
    taskId: "fixture-task-1",
    status,
    ...(status === 1 ? {
      taskResults: [{ url: "https://media.example/video.mp4", format: "mp4" }]
    } : {})
  }));
  const executionsView = {
    markProviderTerminal: vi.fn(),
    markProviderStatusUnknown: vi.fn()
  };
  const worker = new ReconciliationWorker({
    repository,
    executions: executionsView,
    workerLeases: leases,
    runtimes: {
      listEnabled: () => [{
        record: { id: "legacy" } as never,
        transport: { read } as never
      }]
    },
    workerId: "reconciler-a",
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    now: () => now
  });
  return {
    store, repository, worker, job, read, executionsView,
    setNow: (value: number) => { now = value; }
  };
}

describe("reconciliation worker", () => {
  it("completes an unknown job by polling the original task without submitting", async () => {
    const app = setup(1);
    expect(await app.worker.scan()).toMatchObject({ completed: 1, failed: 0 });
    expect(app.repository.findById(app.job.id)?.status).toBe("completed");
    expect(app.read).toHaveBeenCalledTimes(1);
    expect(app.executionsView.markProviderTerminal).toHaveBeenCalledWith(
      app.job.id,
      "provider_succeeded",
      1_000,
      expect.objectContaining({ workerId: "reconciler-a", fencingToken: 1 })
    );
    app.repository.close(); app.store.close();
  });

  it("persists an explicit provider failure", async () => {
    const app = setup(2);
    expect(await app.worker.scan()).toMatchObject({ failed: 1 });
    expect(app.repository.findById(app.job.id)?.status).toBe("failed");
    expect(app.executionsView.markProviderTerminal).toHaveBeenCalledWith(
      app.job.id,
      "provider_failed",
      1_000,
      expect.objectContaining({ workerId: "reconciler-a", fencingToken: 1 })
    );
    app.repository.close(); app.store.close();
  });

  it("defers a still-processing task with exponential reconciliation delay", async () => {
    const app = setup(0);
    expect(await app.worker.scan()).toMatchObject({ deferred: 1 });
    const deferred = app.repository.findById(app.job.id);
    expect(deferred).toMatchObject({
      status: "unknown",
      reconcileAfter: 1_100,
      pollAttempts: 1,
      lastPolledAt: 1_000,
      uncertaintyReason: "provider_status_unknown",
      errorCode: "provider_still_processing"
    });
    expect(await app.worker.scan()).toMatchObject({ scanned: 0 });
    app.setNow(1_100);
    expect(await app.worker.scan()).toMatchObject({ deferred: 1 });
    expect(app.repository.findById(app.job.id)?.reconcileAfter).toBe(1_300);
    app.repository.close(); app.store.close();
  });
});
