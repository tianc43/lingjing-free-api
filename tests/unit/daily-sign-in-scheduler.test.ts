import { describe, expect, it, vi } from "vitest";
import {
  DailySignInScheduler,
  nextShanghaiSignInAt
} from "../../src/accounts/daily-sign-in-scheduler.js";

describe("daily sign-in scheduler", () => {
  it("targets the next 00:10 Asia/Shanghai boundary", () => {
    expect(nextShanghaiSignInAt(
      Date.parse("2026-08-27T15:00:00Z")
    )).toBe(Date.parse("2026-08-27T16:10:00Z"));
    expect(nextShanghaiSignInAt(
      Date.parse("2026-08-27T16:11:00Z")
    )).toBe(Date.parse("2026-08-28T16:10:00Z"));
  });

  it("visits every enabled runtime and isolates account failures", async () => {
    const runtimes = [{ record: { id: "a" } }, { record: { id: "b" } }];
    const signIn = vi.fn((runtime: { record: { id: string } }) =>
      runtime.record.id === "a"
        ? Promise.resolve({ status: "signed" as const, currentFrequency: 1 })
        : Promise.reject(new Error("fixture failure"))
    );
    const scheduler = new DailySignInScheduler({
      runtimes: { listEnabled: () => runtimes as never },
      signIn
    });

    await expect(scheduler.runNow()).resolves.toEqual({
      total: 2,
      signed: 1,
      alreadySigned: 0,
      noActiveActivity: 0,
      unknown: 0,
      failed: 1
    });
    expect(signIn).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("schedules without signing immediately on startup", () => {
    const setTimeout = vi.fn(() => ({ unref: vi.fn() })) as never;
    const signIn = vi.fn();
    const scheduler = new DailySignInScheduler({
      runtimes: { listEnabled: () => [] },
      signIn,
      now: () => Date.parse("2026-08-27T15:00:00Z"),
      setTimeout
    });

    scheduler.start();
    expect(signIn).not.toHaveBeenCalled();
    expect(setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      70 * 60_000
    );
  });

  it("allows only one cluster scheduler to execute a run", async () => {
    let locked = false;
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const runExclusive = async (
      work: () => Promise<import("../../src/accounts/daily-sign-in-scheduler.js").DailySignInSummary>
    ) => {
      if (locked) return null;
      locked = true;
      try { return await work(); } finally { locked = false; }
    };
    const signIn = vi.fn(async () => {
      await wait;
      return { status: "signed" as const, currentFrequency: 1 };
    });
    const options = {
      runtimes: { listEnabled: () => [{ record: { id: "a" } }] as never },
      signIn,
      runExclusive
    };
    const first = new DailySignInScheduler(options);
    const second = new DailySignInScheduler(options);
    const firstRun = first.runNow();
    await Promise.resolve();

    await expect(second.runNow()).resolves.toMatchObject({ total: 0 });
    expect(signIn).toHaveBeenCalledTimes(1);
    release?.();
    await expect(firstRun).resolves.toMatchObject({ total: 1, signed: 1 });
  });
});
