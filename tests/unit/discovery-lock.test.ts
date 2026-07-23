import { expect, it } from "vitest";
import { DiscoveryLock } from "../../src/jobs/discovery-lock.js";

it("serves discovery critical sections in FIFO order after failures", async () => {
  const lock = new DiscoveryLock();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = lock.runExclusive(async () => {
    order.push("first-start");
    await firstGate;
    order.push("first-end");
    throw new Error("fixture");
  });
  const second = lock.runExclusive(() => {
    order.push("second");
  });
  const third = lock.runExclusive(() => {
    order.push("third");
  });

  await Promise.resolve();
  expect(order).toEqual(["first-start"]);
  releaseFirst?.();
  await expect(first).rejects.toThrowError("fixture");
  await Promise.all([second, third]);
  expect(order).toEqual(["first-start", "first-end", "second", "third"]);
});
