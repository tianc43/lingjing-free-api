import { describe, expect, it, vi } from "vitest";
import {
  DailySignInScheduler,
  nextHourlySignInAt
} from "../../src/accounts/daily-sign-in-scheduler.js";

describe("daily sign-in scheduler", () => {
  it("targets the next exact hourly boundary", () => {
    expect(nextHourlySignInAt(
      Date.parse("2026-08-27T15:00:00Z")
    )).toBe(Date.parse("2026-08-27T16:00:00Z"));
    expect(nextHourlySignInAt(
      Date.parse("2026-08-27T16:11:00Z")
    )).toBe(Date.parse("2026-08-27T17:00:00Z"));
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
    expect(scheduler.status()).toMatchObject({
      enabled: true,
      intervalMs: 60 * 60_000,
      running: false,
      accounts: [
        { accountId: "a", status: "signed", currentFrequency: 1 },
        { accountId: "b", status: "failed", currentFrequency: null }
      ]
    });
    await scheduler.close();
  });

  it("checks immediately on startup and schedules the next exact hour", async () => {
    const setTimeout = vi.fn(() => ({ unref: vi.fn() })) as never;
    const signIn = vi.fn(() => Promise.resolve({
      status: "already_signed" as const,
      currentFrequency: 2
    }));
    const scheduler = new DailySignInScheduler({
      runtimes: {
        listEnabled: () => [{ record: { id: "a" } }] as never
      },
      signIn,
      now: () => Date.parse("2026-08-27T15:00:00Z"),
      setTimeout
    });

    scheduler.start();
    await vi.waitFor(() => {
      expect(signIn).toHaveBeenCalledTimes(1);
    });
    expect(setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      60 * 60_000
    );
    expect(scheduler.status()).toMatchObject({
      nextCheckAt: Date.parse("2026-08-27T16:00:00Z"),
      accounts: [{ accountId: "a", status: "already_signed" }]
    });
    await scheduler.close();
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

  it("removes status for accounts that are no longer enabled", async () => {
    let runtimes = [
      { record: { id: "a" } },
      { record: { id: "b" } }
    ];
    const scheduler = new DailySignInScheduler({
      runtimes: { listEnabled: () => runtimes as never },
      signIn: () => Promise.resolve({
        status: "already_signed",
        currentFrequency: 1
      })
    });

    await scheduler.runNow();
    runtimes = [{ record: { id: "b" } }];
    await scheduler.runNow();

    expect(scheduler.status().accounts.map((account) => account.accountId))
      .toEqual(["b"]);
    await scheduler.close();
  });
});
