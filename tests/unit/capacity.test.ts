import { describe, expect, it } from "vitest";
import { CapacityManager } from "../../src/jobs/capacity.js";

function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (cause) {
    expect(cause).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("CapacityManager", () => {
  it("never grants more than the configured account limit", async () => {
    const manager = new CapacityManager(2);
    const firstAdmission = manager.admit("request-a");
    const secondAdmission = manager.admit("request-b");
    const thirdAdmission = manager.admit("request-c");
    const first = await firstAdmission.acquire("job-a");
    const second = await secondAdmission.acquire("job-b");
    let thirdGranted = false;
    const thirdPromise = thirdAdmission.acquire("job-c").then((lease) => {
      thirdGranted = true;
      return lease;
    });
    await Promise.resolve();

    expect(thirdGranted).toBe(false);
    expect(manager.counts()).toEqual({
      active: 2,
      admitted: 1,
      activeLimit: 2,
      maxQueuedRequests: 100
    });
    first.release();
    const third = await thirdPromise;
    expect(thirdGranted).toBe(true);
    second.release();
    third.release();
  });

  it("grants waiting admissions in FIFO order", async () => {
    const manager = new CapacityManager(1, 3);
    const active = await manager.admit("request-active").acquire("job-active");
    const order: string[] = [];
    const second = manager.admit("request-second").acquire("job-second").then((lease) => {
      order.push(lease.jobId);
      return lease;
    });
    const third = manager.admit("request-third").acquire("job-third").then((lease) => {
      order.push(lease.jobId);
      return lease;
    });

    active.release();
    const secondLease = await second;
    expect(order).toEqual(["job-second"]);
    secondLease.release();
    const thirdLease = await third;
    expect(order).toEqual(["job-second", "job-third"]);
    thirdLease.release();
  });

  it("does not allow a later admission to skip an earlier unconverted admission", async () => {
    const manager = new CapacityManager(1, 1);
    const firstAdmission = manager.admit("request-first");
    const secondAdmission = manager.admit("request-second");
    let secondGranted = false;
    const secondPromise = secondAdmission.acquire("job-second").then((lease) => {
      secondGranted = true;
      return lease;
    });
    await Promise.resolve();

    expect(secondGranted).toBe(false);
    const first = await firstAdmission.acquire("job-first");
    first.release();
    const second = await secondPromise;
    second.release();
  });

  it("deduplicates admissions by request and leases by job ID", async () => {
    const manager = new CapacityManager(2);
    const admission = manager.admit("request-a");

    expect(manager.admit("request-a")).toBe(admission);
    const first = await admission.acquire("job-a");
    expect(manager.admit("request-a")).toBe(admission);
    const second = await admission.acquire("job-a");
    expect(second).toBe(first);
    expect(manager.counts().active).toBe(1);
    first.release();
    second.release();
    expect(manager.counts().active).toBe(0);
  });

  it("does not give a duplicate admission ownership of an active job lease", async () => {
    const manager = new CapacityManager(1, 2);
    const owner = await manager.admit("request-owner").acquire("job-shared");
    const duplicateAdmission = manager.admit("request-duplicate");
    const duplicate = await duplicateAdmission.acquire("job-shared");
    let laterGranted = false;
    const laterPromise = manager.admit("request-later").acquire("job-later").then((lease) => {
      laterGranted = true;
      return lease;
    });

    duplicate.release();
    duplicateAdmission.release();
    await Promise.resolve();
    expect(laterGranted).toBe(false);
    expect(manager.activeJobIds()).toEqual(["job-shared"]);

    owner.release();
    const later = await laterPromise;
    expect(laterGranted).toBe(true);
    later.release();
  });

  it("rejects converting one admission to different job IDs", async () => {
    const manager = new CapacityManager(1);
    const admission = manager.admit("request-a");
    const lease = await admission.acquire("job-a");

    await expect(admission.acquire("job-b")).rejects.toThrow(/already acquired/u);
    lease.release();
  });

  it("releases queued admissions idempotently", async () => {
    const manager = new CapacityManager(1, 1);
    const first = await manager.admit("request-active").acquire("job-active");
    const waiting = manager.admit("request-waiting");

    waiting.release();
    waiting.release();
    expect(manager.counts().admitted).toBe(0);
    expect(() => manager.admit("request-replacement")).not.toThrow();
    first.release();
  });

  it("keeps unknown jobs leased until hold expiry", () => {
    const manager = new CapacityManager(5);
    manager.restore("job-unknown", "unknown", 10_000, 0);

    expect(manager.activeJobIds()).toContain("job-unknown");
    manager.expireUnknown(9_999);
    expect(manager.activeJobIds()).toContain("job-unknown");
    manager.expireUnknown(10_000);
    expect(manager.activeJobIds()).not.toContain("job-unknown");
  });

  it.each(["processing", "discovering", "submitting"] as const)(
    "clears an unknown hold when recovery refreshes the job to %s",
    (status) => {
      const manager = new CapacityManager(1);
      const lease = manager.restore("job-refresh", "unknown", 10_000, 0);

      expect(manager.restore("job-refresh", status, null, 1)).toBe(lease);
      manager.expireUnknown(10_000);
      expect(manager.activeJobIds()).toContain("job-refresh");
      lease?.release();
    }
  );

  it("uses the current clock by default when restoring unknown jobs", () => {
    const manager = new CapacityManager(1);

    expect(manager.restore(
      "job-expired-default-clock",
      "unknown",
      Date.now() - 1
    )).toBeNull();
    expect(manager.counts().active).toBe(0);
  });

  it("releases an existing lease refreshed to an expired unknown state", async () => {
    const manager = new CapacityManager(1, 1);
    manager.restore("job-stale", "processing", null, 0);
    let laterGranted = false;
    const laterPromise = manager.admit("request-later").acquire("job-later").then((lease) => {
      laterGranted = true;
      return lease;
    });

    expect(manager.restore("job-stale", "unknown", 10_000, 10_000)).toBeNull();
    await Promise.resolve();
    expect(laterGranted).toBe(true);
    const later = await laterPromise;
    expect(manager.activeJobIds()).toEqual(["job-later"]);
    later.release();
  });

  it("restores only recoverable active states and deduplicates restored leases", () => {
    const manager = new CapacityManager(5);
    manager.restore("job-submitting", "submitting", null);
    manager.restore("job-discovering", "discovering", null);
    manager.restore("job-processing", "processing", null);
    manager.restore("job-completed", "completed", null);
    manager.restore("job-submitting", "submitting", null);

    expect(manager.counts().active).toBe(3);
    expect(manager.activeJobIds().sort()).toEqual([
      "job-discovering",
      "job-processing",
      "job-submitting"
    ]);
  });

  it("rejects an unknown hold that is expired at the recovery clock", () => {
    const manager = new CapacityManager(1);

    expect(manager.restore("job-expired", "unknown", 10_000, 10_000)).toBeNull();
    expect(manager.counts().active).toBe(0);
  });

  it("reconciles a queued admission when recovery restores the same job", async () => {
    const manager = new CapacityManager(1, 2);
    const active = manager.restore("job-active", "processing", null);
    const admission = manager.admit("request-recovered");
    const pending = admission.acquire("job-recovered");

    const restored = manager.restore("job-recovered", "discovering", null);
    await expect(pending).resolves.toMatchObject({ jobId: "job-recovered" });
    expect(manager.activeJobIds().filter((id) => id === "job-recovered")).toHaveLength(1);
    expect(manager.counts()).toMatchObject({ active: 2, admitted: 0 });
    active?.release();
    restored?.release();
  });

  it("does not grant queued work until a recovered overage clears", async () => {
    const manager = new CapacityManager(1, 2);
    const first = manager.restore("job-recovered-a", "processing", null);
    const second = manager.restore("job-recovered-b", "submitting", null);
    let granted = false;
    const pending = manager.admit("request-waiting").acquire("job-waiting").then((lease) => {
      granted = true;
      return lease;
    });
    await Promise.resolve();

    expect(granted).toBe(false);
    first?.release();
    await Promise.resolve();
    expect(granted).toBe(false);
    second?.release();
    const lease = await pending;
    expect(granted).toBe(true);
    lease.release();
  });

  it("rejects requests beyond the bounded waiting queue", async () => {
    const manager = new CapacityManager(1, 1);
    const activeAdmission = manager.admit("request-active");
    await activeAdmission.acquire("job-active");
    manager.admit("request-waiting");

    expectErrorCode(
      () => manager.admit("request-rejected"),
      "lingjing_capacity_queue_full"
    );
    try {
      manager.admit("another-request-rejected");
    } catch (cause) {
      expect(cause).toMatchObject({ statusCode: 429 });
    }
  });

  it("reports only aggregate health counts", async () => {
    const manager = new CapacityManager(1, 2);
    const active = await manager.admit("secret-request").acquire("secret-job");
    manager.admit("another-secret-request");

    const serialized = JSON.stringify(manager.counts());
    expect(serialized).not.toContain("secret");
    expect(JSON.parse(serialized)).toEqual({
      active: 1,
      admitted: 1,
      activeLimit: 1,
      maxQueuedRequests: 2
    });
    active.release();
  });
});
