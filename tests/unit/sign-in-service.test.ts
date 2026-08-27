import { describe, expect, it, vi } from "vitest";
import { LingjingSignInService } from "../../src/lingjing/sign-in-service.js";

const TODAY = Date.parse("2026-08-27T02:00:00Z");
const progress = (date: string, activityNo = "ACT2026062314020044") => [{
  activityNo,
  status: 1,
  currentFrequency: 2,
  updateTime: `${date} 08:43:10`
}];

describe("Lingjing sign-in service", () => {
  it("does not submit when the account is already signed today", async () => {
    const submitOnce = vi.fn();
    const service = new LingjingSignInService({
      read: <T>() => Promise.resolve(progress("2026-08-27") as T),
      submitOnce
    });

    await expect(service.signIn(TODAY)).resolves.toMatchObject({
      status: "already_signed",
      currentFrequency: 2
    });
    expect(submitOnce).not.toHaveBeenCalled();
  });

  it("submits the live activity number once and verifies the new state", async () => {
    let reads = 0;
    const read = vi.fn(<T>() => {
      reads += 1;
      return Promise.resolve(progress(
        reads === 1 ? "2026-08-26" : "2026-08-27"
      ) as T);
    });
    const submitOnce = vi.fn(<T>() => Promise.resolve({} as T));
    const service = new LingjingSignInService({ read, submitOnce } as never);

    await expect(service.signIn(TODAY)).resolves.toMatchObject({
      status: "signed",
      currentFrequency: 2
    });
    expect(submitOnce).toHaveBeenCalledTimes(1);
    expect(submitOnce).toHaveBeenCalledWith(
      "/joycreator/activity/task_complete",
      { activityNo: "ACT2026062314020044" }
    );
  });

  it("fails closed when the active activity number is malformed", async () => {
    const submitOnce = vi.fn();
    const service = new LingjingSignInService({
      read: <T>() => Promise.resolve(progress("2026-08-26", "bad") as T),
      submitOnce
    });

    await expect(service.signIn(TODAY)).rejects.toThrow(/malformed/u);
    expect(submitOnce).not.toHaveBeenCalled();
  });

  it("fails closed when the progress envelope drifts", async () => {
    const service = new LingjingSignInService({
      read: <T>() => Promise.resolve({ result: [] } as T),
      submitOnce: vi.fn()
    });

    await expect(service.signIn(TODAY)).rejects.toThrow(/malformed/u);
  });

  it("does not credit a different activity observed after submission", async () => {
    let reads = 0;
    const read = vi.fn(<T>() => {
      reads += 1;
      return Promise.resolve(progress(
        reads === 1 ? "2026-08-26" : "2026-08-27",
        reads === 1 ? "ACTA" : "ACTB"
      ) as T);
    });
    const service = new LingjingSignInService({
      read,
      submitOnce: vi.fn(<T>() => Promise.resolve({} as T))
    } as never);

    await expect(service.signIn(TODAY)).resolves.toMatchObject({
      status: "unknown"
    });
  });

  it("does not submit when today's durable attempt was already claimed", async () => {
    const submitOnce = vi.fn();
    const claimAttempt = vi.fn(() => Promise.resolve(false));
    const service = new LingjingSignInService({
      read: <T>() => Promise.resolve(progress("2026-08-26") as T),
      submitOnce
    }, claimAttempt);

    await expect(service.signIn(TODAY)).resolves.toMatchObject({
      status: "unknown",
      currentFrequency: 2
    });
    expect(claimAttempt).toHaveBeenCalledWith(
      "ACT2026062314020044",
      "2026-08-27"
    );
    expect(submitOnce).not.toHaveBeenCalled();
  });

  it("submits at most once when hourly verification remains stale", async () => {
    const claimed = new Set<string>();
    const submitOnce = vi.fn(<T>() => Promise.resolve({} as T));
    const service = new LingjingSignInService({
      read: <T>() => Promise.resolve(progress("2026-08-26") as T),
      submitOnce
    } as never, (activityNo, shanghaiDate) => {
      const key = `${activityNo}:${shanghaiDate}`;
      if (claimed.has(key)) return Promise.resolve(false);
      claimed.add(key);
      return Promise.resolve(true);
    });

    await expect(service.signIn(TODAY)).resolves.toMatchObject({
      status: "unknown"
    });
    await expect(service.signIn(TODAY)).resolves.toMatchObject({
      status: "unknown"
    });
    expect(submitOnce).toHaveBeenCalledTimes(1);
  });

  it.each([null, false, "", " "])(
    "rejects malformed status %j",
    async (status) => {
      const submitOnce = vi.fn();
      const service = new LingjingSignInService({
        read: <T>() => Promise.resolve([{ ...progress("2026-08-26")[0], status }] as T),
        submitOnce
      });

      await expect(service.signIn(TODAY)).rejects.toThrow(/malformed/u);
      expect(submitOnce).not.toHaveBeenCalled();
    }
  );

  it.each(["2026-99-99", "2026-02-30", "2026-08-27garbage"])(
    "rejects malformed update date %s",
    async (updateTime) => {
      const submitOnce = vi.fn();
      const service = new LingjingSignInService({
        read: <T>() => Promise.resolve([{
          ...progress("2026-08-26")[0],
          updateTime
        }] as T),
        submitOnce
      });

      await expect(service.signIn(TODAY)).rejects.toThrow(/malformed/u);
      expect(submitOnce).not.toHaveBeenCalled();
    }
  );
});
