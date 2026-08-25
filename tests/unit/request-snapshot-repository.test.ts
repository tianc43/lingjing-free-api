import { describe, expect, it } from "vitest";
import { SqliteRequestSnapshotRepository } from "../../src/generation/request-snapshot-repository.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";

function setup() {
  const store = new SqliteStore(":memory:");
  const jobs = new SqliteJobRepository(store);
  const snapshots = new SqliteRequestSnapshotRepository(store, () => 100);
  const job = jobs.createOrGet({
    kind: "video",
    sourceType: "image-to-video",
    model: "fixture-video",
    apiId: "upstream-api",
    modelCode: "model-code",
    expectedAssetScene: "video",
    requestFingerprint: "a".repeat(64),
    idempotencyKeyHash: null,
    spaceId: 1
  }).job;
  return { store, jobs, snapshots, job };
}

describe("generation request snapshots", () => {
  it("persists normalized values without media or raw idempotency keys", () => {
    const { store, jobs, snapshots, job } = setup();
    const saved = snapshots.save(job.id, {
      principal: {
        userId: "usr_legacy",
        projectId: "prj_legacy",
        apiKeyId: "key_legacy_environment"
      },
      kind: "video",
      sourceType: "image-to-video",
      model: "fixture-video",
      values: { prompt: "fixture", duration: 5 },
      media: [],
      idempotencyKey: "private-idempotency-value"
    });
    expect(saved).toMatchObject({
      jobId: job.id,
      request: {
        kind: "video",
        sourceType: "image-to-video",
        model: "fixture-video",
        values: { prompt: "fixture", duration: 5 }
      },
      createdAt: 100
    });
    const raw = JSON.stringify(store.read((database) => database.prepare(
      "SELECT * FROM generation_request_snapshots"
    ).get()));
    expect(raw).not.toContain("private-idempotency-value");
    expect(raw).not.toContain("media");
    jobs.close(); store.close();
  });

  it("replays the same snapshot and rejects conflicting values", () => {
    const { store, jobs, snapshots, job } = setup();
    const request = {
      kind: "video" as const,
      sourceType: "text-to-video" as const,
      model: "fixture-video",
      values: { prompt: "fixture" },
      media: [],
      idempotencyKey: null
    };
    snapshots.save(job.id, request);
    expect(() => { snapshots.save(job.id, request); }).not.toThrow();
    expect(() => {
      snapshots.save(job.id, {
        ...request,
        values: { prompt: "different" }
      });
    }).toThrowError(/snapshot conflict/u);
    jobs.close(); store.close();
  });
});
