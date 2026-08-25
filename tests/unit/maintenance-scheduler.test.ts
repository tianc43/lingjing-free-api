import { describe, expect, it, vi } from "vitest";
import { MaintenanceScheduler } from "../../src/jobs/maintenance-scheduler.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("maintenance scheduler", () => {
  it("runs reconciliation and asset cleanup at startup", async () => {
    const reconcile = vi.fn(() => Promise.resolve());
    const cleanupAssets = vi.fn(() => Promise.resolve(3));
    const scheduler = new MaintenanceScheduler({
      reconcile,
      cleanupAssets,
      intervalMs: 1_000,
      unboundAssetRetentionMs: 200,
      now: () => 1_000
    });
    await scheduler.start();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(cleanupAssets).toHaveBeenCalledWith(800);
    await scheduler.close();
  });

  it("coalesces overlapping runs into one maintenance pass", async () => {
    const gate = deferred();
    const reconcile = vi.fn(() => gate.promise);
    const cleanupAssets = vi.fn(() => Promise.resolve(0));
    const scheduler = new MaintenanceScheduler({
      reconcile,
      cleanupAssets,
      intervalMs: 1_000,
      unboundAssetRetentionMs: 0
    });
    const first = scheduler.runNow();
    const second = scheduler.runNow();
    expect(first).toBe(second);
    expect(reconcile).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
    expect(cleanupAssets).toHaveBeenCalledTimes(1);
    await scheduler.close();
  });

  it("clears its timer and waits for an active pass during close", async () => {
    const gate = deferred();
    const reconcile = vi.fn(() => gate.promise);
    const clearInterval = vi.fn();
    const fakeTimer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const scheduler = new MaintenanceScheduler({
      reconcile,
      cleanupAssets: () => Promise.resolve(0),
      intervalMs: 1_000,
      unboundAssetRetentionMs: 0,
      setInterval: (() => fakeTimer) as unknown as typeof setInterval,
      clearInterval
    });
    const starting = scheduler.start();
    await Promise.resolve();
    const closing = scheduler.close();
    expect(clearInterval).not.toHaveBeenCalled();
    gate.resolve();
    await starting;
    await closing;
    await expect(scheduler.runNow()).rejects.toThrow(/closed/u);
  });
});
