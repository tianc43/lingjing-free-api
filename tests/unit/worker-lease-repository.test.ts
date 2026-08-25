import { describe, expect, it } from "vitest";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SqliteWorkerLeaseRepository } from "../../src/jobs/worker-lease-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";

function setup() {
  let now = 1_000;
  const store = new SqliteStore(":memory:");
  const jobs = new SqliteJobRepository(store);
  const job = jobs.createOrGet({
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
  const leases = new SqliteWorkerLeaseRepository(store, () => now);
  return { store, jobs, job, leases, setNow: (value: number) => { now = value; } };
}

describe("SQLite worker lease repository", () => {
  it("allows one owner and rejects a concurrent worker", () => {
    const { store, jobs, job, leases } = setup();
    const first = leases.acquire(job.id, "worker-a", 500);
    expect(first).toMatchObject({ workerId: "worker-a", fencingToken: 1 });
    expect(leases.acquire(job.id, "worker-b", 500)).toBeNull();
    expect(first === null ? false : leases.owns(first)).toBe(true);
    jobs.close(); store.close();
  });

  it("takes over a stale lease with a higher fencing token", () => {
    const { store, jobs, job, leases, setNow } = setup();
    const stale = leases.acquire(job.id, "worker-a", 100);
    if (stale === null) throw new Error("Fixture lease was not acquired");
    setNow(1_101);
    const replacement = leases.acquire(job.id, "worker-b", 200);
    expect(replacement).toMatchObject({ workerId: "worker-b", fencingToken: 2 });
    expect(leases.owns(stale)).toBe(false);
    expect(leases.heartbeat(stale, 100)).toBeNull();
    expect(leases.release(stale)).toBe(false);
    jobs.close(); store.close();
  });

  it("heartbeats and releases only with the current fencing token", () => {
    const { store, jobs, job, leases, setNow } = setup();
    const acquired = leases.acquire(job.id, "worker-a", 100);
    if (acquired === null) throw new Error("Fixture lease was not acquired");
    setNow(1_050);
    const renewed = leases.heartbeat(acquired, 200);
    expect(renewed?.leaseExpiresAt).toBe(1_250);
    setNow(1_150);
    expect(renewed === null ? false : leases.owns(renewed)).toBe(true);
    expect(renewed === null ? false : leases.release(renewed)).toBe(true);
    expect(leases.find(job.id)).toBeNull();
    jobs.close(); store.close();
  });

  it("fences job state writes after another worker takes over", () => {
    const { store, jobs, job, leases, setNow } = setup();
    const stale = leases.acquire(job.id, "worker-a", 100);
    if (stale === null) throw new Error("Fixture lease was not acquired");
    setNow(1_101);
    const current = leases.acquire(job.id, "worker-b", 200);
    if (current === null) throw new Error("Replacement lease was not acquired");

    expect(() => jobs.transition(job.id, ["queued"], { status: "submitting" }, {
      workerId: stale.workerId,
      leaseToken: stale.leaseToken,
      fencingToken: stale.fencingToken,
      now: 1_101
    })).toThrowError(/fencing conflict/u);
    expect(jobs.transition(job.id, ["queued"], { status: "submitting" }, {
      workerId: current.workerId,
      leaseToken: current.leaseToken,
      fencingToken: current.fencingToken,
      now: 1_101
    }).status).toBe("submitting");
    jobs.close(); store.close();
  });

  it("lists expired leases for stale recovery", () => {
    const { store, jobs, job, leases, setNow } = setup();
    leases.acquire(job.id, "worker-a", 100);
    setNow(1_100);
    expect(leases.listExpired()).toEqual([
      expect.objectContaining({ jobId: job.id, workerId: "worker-a" })
    ]);
    jobs.close(); store.close();
  });
});
