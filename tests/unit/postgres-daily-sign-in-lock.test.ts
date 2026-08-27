import { describe, expect, it, vi } from "vitest";
import { PostgresDailySignInLock } from "../../src/accounts/postgres-daily-sign-in-lock.js";

describe("Postgres daily sign-in lock", () => {
  it("runs only while the advisory lock is held and always unlocks", async () => {
    const release = vi.fn();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    const lock = new PostgresDailySignInLock({
      connect: () => Promise.resolve({ query, release } as never)
    });
    const work = vi.fn(() => Promise.resolve("done"));

    await expect(lock.runExclusive(work)).resolves.toBe("done");
    expect(work).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_try_advisory_lock($1) AS locked",
      [1_904_270_010]
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_unlock($1)",
      [1_904_270_010]
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("skips work when another instance owns the lock", async () => {
    const release = vi.fn();
    const query = vi.fn(() => Promise.resolve({ rows: [{ locked: false }] }));
    const lock = new PostgresDailySignInLock({
      connect: () => Promise.resolve({ query, release } as never)
    });
    const work = vi.fn();

    await expect(lock.runExclusive(work)).resolves.toBeNull();
    expect(work).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
