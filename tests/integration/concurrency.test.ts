import { afterEach, describe, expect, it } from "vitest";
import {
  createGenerationHarness,
  fixtureRequest
} from "../helpers/generation-harness.js";

const harnesses: ReturnType<typeof createGenerationHarness>[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const job of harness.repository.list({ status: "processing", limit: 20 })) {
      if (job.upstreamTaskId !== null) {
        harness.setTaskStatuses(job.upstreamTaskId, [1]);
      }
    }
    await harness.close();
  }
});

async function eventually(
  assertion: () => void,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("generation concurrency", () => {
  it("queues the sixth task until one of five leases is released", async () => {
    const harness = createGenerationHarness({
      capacityActiveLimit: 5,
      initialTaskStatuses: [0]
    });
    harnesses.push(harness);

    const handles = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        harness.coordinator.create(fixtureRequest({
          idempotencyKey: `fixture-request-${String(index)}`,
          values: { prompt: `fixture prompt ${String(index)}` }
        }))
      )
    );
    await eventually(() => {
      expect(harness.submitCount()).toBe(5);
      expect(harness.capacity.counts().active).toBe(5);
    });

    let sixthSettled = false;
    const sixth = harness.coordinator.create(fixtureRequest({
      idempotencyKey: "fixture-request-5",
      values: { prompt: "fixture prompt 5" }
    })).then((handle) => {
      sixthSettled = true;
      return handle;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sixthSettled).toBe(false);
    expect(harness.submitCount()).toBe(5);

    const first = harness.repository.findById(handles[0]?.job.id ?? "");
    expect(first?.upstreamTaskId).not.toBeNull();
    harness.setTaskStatuses(first?.upstreamTaskId ?? "", [1]);
    await handles[0]?.wait(1_000);
    const sixthHandle = await sixth;
    await eventually(() => {
      expect(harness.submitCount()).toBe(6);
    });

    for (const job of harness.repository.list({ status: "processing", limit: 20 })) {
      if (job.upstreamTaskId !== null) {
        harness.setTaskStatuses(job.upstreamTaskId, [1]);
      }
    }
    await Promise.all([
      ...handles.slice(1).map((handle) => handle.wait(1_000)),
      sixthHandle.wait(1_000)
    ]);
    expect(harness.maximumCriticalConcurrency()).toBeLessThanOrEqual(5);
  });

  it("keeps the selected account limit in addition to the global limit", async () => {
    const harness = createGenerationHarness({
      capacityActiveLimit: 2,
      accountCapacityActiveLimit: 1,
      initialTaskStatuses: [0]
    });
    harnesses.push(harness);

    const first = await harness.coordinator.create(fixtureRequest({
      idempotencyKey: "account-limit-first"
    }));
    await eventually(() => {
      expect(harness.submitCount()).toBe(1);
      expect(harness.accountCapacity.counts().active).toBe(1);
    });

    let secondSettled = false;
    const secondPromise = harness.coordinator.create(fixtureRequest({
      idempotencyKey: "account-limit-second"
    })).then((handle) => {
      secondSettled = true;
      return handle;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondSettled).toBe(false);
    expect(harness.submitCount()).toBe(1);
    expect(harness.capacity.counts().active).toBe(2);
    expect(harness.accountCapacity.counts()).toMatchObject({
      active: 1,
      admitted: 1
    });

    await eventually(() => {
      expect(harness.repository.findById(first.job.id)?.upstreamTaskId)
        .not.toBeNull();
    });
    const firstJob = harness.repository.findById(first.job.id);
    harness.setTaskStatuses(firstJob?.upstreamTaskId ?? "", [1]);
    await first.wait(1_000);
    const second = await secondPromise;
    await eventually(() => {
      expect(harness.submitCount()).toBe(2);
    });

    await eventually(() => {
      expect(harness.repository.findById(second.job.id)?.upstreamTaskId)
        .not.toBeNull();
    });
    const secondJob = harness.repository.findById(second.job.id);
    harness.setTaskStatuses(secondJob?.upstreamTaskId ?? "", [1]);
    await second.wait(1_000);
  });
});
