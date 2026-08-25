import { describe, expect, it } from "vitest";
import { SqliteExecutionRepository } from "../../src/generation/execution-repository.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SqliteWorkerLeaseRepository } from "../../src/jobs/worker-lease-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";

const fingerprint = "a".repeat(64);

function fixture() {
  const store = new SqliteStore(":memory:");
  const jobs = new SqliteJobRepository(store);
  const executions = new SqliteExecutionRepository(store);
  const job = jobs.createOrGet({
    userId: "usr_legacy",
    projectId: "prj_legacy",
    apiKeyId: null,
    kind: "video",
    sourceType: "text-to-video",
    model: "video-model",
    apiId: "upstream-api",
    modelCode: "model-code",
    expectedAssetScene: "video",
    requestFingerprint: fingerprint,
    idempotencyKeyHash: null,
    spaceId: 1
  }).job;
  return { store, jobs, executions, job };
}

describe("SQLite execution repository", () => {
  it("persists baseline before submit and transitions exactly once", () => {
    const { store, jobs, executions, job } = fixture();
    const captured = executions.captureBaseline({
      jobId: job.id,
      accountId: "legacy",
      requestFingerprint: fingerprint,
      upstreamFingerprint: "b".repeat(64),
      catalogRevision: "revision-1",
      baselineAssetIds: ["asset-b", "asset-a", "asset-a"],
      capturedAt: 100
    });
    expect(captured).toMatchObject({
      jobId: job.id,
      baselineAssetIds: ["asset-a", "asset-b"],
      outcome: "baseline_captured"
    });
    executions.markSubmitting(job.id, 110);
    executions.markSubmitted(job.id, 120);
    expect(executions.findSubmission(job.id)?.outcome).toBe("submitted");
    expect(() => { executions.markSubmitted(job.id, 130); }).toThrowError(/transition conflict/u);
    jobs.close(); store.close();
  });

  it("writes idempotent ledger entries and exact correlations", () => {
    const { store, jobs, executions, job } = fixture();
    executions.appendLedger({
      jobId: job.id,
      type: "hold",
      points: 8,
      reason: "quoted_video_cost",
      createdAt: 100
    });
    executions.appendLedger({
      jobId: job.id,
      type: "hold",
      points: 8,
      reason: "quoted_video_cost",
      createdAt: 101
    });
    executions.captureBaseline({
      jobId: job.id,
      accountId: "legacy",
      requestFingerprint: fingerprint,
      upstreamFingerprint: "b".repeat(64),
      catalogRevision: "revision-1",
      baselineAssetIds: [],
      capturedAt: 100
    });
    executions.markSubmitting(job.id, 110);
    executions.markAmbiguous(job.id, "connection_lost", 120);
    executions.correlate({
      jobId: job.id,
      upstreamTaskId: "task-1",
      upstreamAssetId: "asset-1",
      creationCode: "creation-1",
      correlatedAt: 130
    });
    expect(store.read((database) => database.prepare(
      "SELECT COUNT(*) AS count FROM usage_ledger WHERE job_id = ?"
    ).get(job.id))).toEqual({ count: 1 });
    expect(store.read((database) => database.prepare(`
      SELECT upstream_task_id, upstream_asset_id, confidence
      FROM provider_correlations WHERE job_id = ?
    `).get(job.id))).toEqual({
      upstream_task_id: "task-1",
      upstream_asset_id: "asset-1",
      confidence: "exact"
    });
    expect(executions.findSubmission(job.id)?.outcome).toBe("correlated");
    executions.markProviderStatusUnknown(job.id, "poll_deadline_exceeded", 140);
    expect(executions.findSubmission(job.id)).toMatchObject({
      outcome: "provider_status_unknown",
      ambiguityReason: "poll_deadline_exceeded"
    });
    executions.markProviderTerminal(job.id, "provider_succeeded", 150);
    expect(executions.findSubmission(job.id)?.outcome).toBe("provider_succeeded");
    jobs.close(); store.close();
  });

  it("rejects stale fenced submission writes after worker takeover", () => {
    const { store, jobs, executions, job } = fixture();
    const leases = new SqliteWorkerLeaseRepository(store, () => 100);
    const stale = leases.acquire(job.id, "worker-a", 10);
    if (stale === null) throw new Error("Fixture lease was not acquired");
    const staleFence = {
      workerId: stale.workerId,
      leaseToken: stale.leaseToken,
      fencingToken: stale.fencingToken,
      now: 111
    };
    const replacementLeases = new SqliteWorkerLeaseRepository(store, () => 111);
    expect(replacementLeases.acquire(job.id, "worker-b", 100)?.fencingToken).toBe(2);
    expect(() => {
      executions.captureBaseline({
        jobId: job.id,
        accountId: "legacy",
        requestFingerprint: fingerprint,
        upstreamFingerprint: "f".repeat(64),
        catalogRevision: "revision-1",
        baselineAssetIds: [],
        capturedAt: 111,
        fence: staleFence
      });
    }).toThrowError(/fencing conflict/u);
    jobs.close(); store.close();
  });

  it("rejects binding one upstream task to two jobs", () => {
    const { store, jobs, executions, job } = fixture();
    const second = jobs.createOrGet({
      kind: "video",
      sourceType: "text-to-video",
      model: "other",
      apiId: "other-api",
      modelCode: null,
      expectedAssetScene: "video",
      requestFingerprint: "c".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 1
    }).job;
    for (const candidate of [job, second]) {
      executions.captureBaseline({
        jobId: candidate.id,
        accountId: "legacy",
        requestFingerprint: candidate.requestFingerprint,
        upstreamFingerprint: candidate.id === job.id ? "d".repeat(64) : "e".repeat(64),
        catalogRevision: "revision-1",
        baselineAssetIds: [],
        capturedAt: 100
      });
      executions.markSubmitting(candidate.id, 110);
      executions.markSubmitted(candidate.id, 120);
    }
    executions.correlate({
      jobId: job.id,
      upstreamTaskId: "shared-task",
      upstreamAssetId: "asset-1",
      creationCode: "creation-1",
      correlatedAt: 130
    });
    expect(() => {
      executions.correlate({
        jobId: second.id,
        upstreamTaskId: "shared-task",
        upstreamAssetId: "asset-2",
        creationCode: "creation-2",
        correlatedAt: 140
      });
    }).toThrowError(/upstream_task_already_bound/u);
    expect(executions.findSubmission(second.id)).toMatchObject({outcome:"correlation_ambiguous",ambiguityReason:"upstream_task_already_bound"});
    jobs.close(); store.close();
  });
});
