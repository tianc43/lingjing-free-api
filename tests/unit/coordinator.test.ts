import { afterEach, describe, expect, it } from "vitest";
import { JobRunnerRegistry } from "../../src/generation/runner-registry.js";
import {
  createGenerationHarness,
  fixtureRequest,
  trackedMedia,
  type GenerationHarness
} from "../helpers/generation-harness.js";

const harnesses: GenerationHarness[] = [];

function harness(): GenerationHarness {
  const value = createGenerationHarness();
  harnesses.push(value);
  return value;
}

afterEach(async () => {
  for (const value of harnesses.splice(0)) await value.close();
});

describe("LingjingGenerationCoordinator", () => {
  it("reserves admission before account, catalog, and media preparation", async () => {
    const app = harness();

    const handle = await app.coordinator.create(fixtureRequest());
    await handle.wait(5_000);

    expect(app.events).toEqual([
      "account",
      "catalog:707:image-generation:true",
      "prepare:admitted=1"
    ]);
  });

  it("returns the existing job for a repeated idempotency key", async () => {
    const app = harness();
    const firstMedia = trackedMedia(Buffer.from("same"));
    const secondMedia = trackedMedia(Buffer.from("same"));
    const first = await app.coordinator.create(fixtureRequest({
      media: [{
        source: { type: "prepared", media: firstMedia },
        kind: "image"
      }],
      idempotencyKey: "request-1"
    }));
    const second = await app.coordinator.create(fixtureRequest({
      media: [{
        source: { type: "prepared", media: secondMedia },
        kind: "image"
      }],
      idempotencyKey: "request-1"
    }));

    expect(second.job.id).toBe(first.job.id);
    expect(app.submitCount()).toBe(1);
    expect(secondMedia.disposeCount()).toBe(1);
    expect(app.uploadCount()).toBe(1);
    await first.wait(5_000);
  });

  it("starts only one runner for concurrent requests with the same key", async () => {
    const app = harness();
    const firstMedia = trackedMedia(Buffer.from("same concurrent input"));
    const secondMedia = trackedMedia(Buffer.from("same concurrent input"));
    const [first, second] = await Promise.all([
      app.coordinator.create(fixtureRequest({
        media: [{
          source: { type: "prepared", media: firstMedia },
          kind: "image"
        }],
        idempotencyKey: "concurrent-key"
      })),
      app.coordinator.create(fixtureRequest({
        media: [{
          source: { type: "prepared", media: secondMedia },
          kind: "image"
        }],
        idempotencyKey: "concurrent-key"
      }))
    ]);

    expect(second.job.id).toBe(first.job.id);
    expect(app.registry.startCountFor(first.job.id)).toBe(1);
    expect(app.submitCount()).toBe(1);
    expect(firstMedia.disposeCount() + secondMedia.disposeCount()).toBe(2);
    await first.wait(5_000);
  });

  it("discovers after a disconnected submit without resubmitting", async () => {
    const app = harness();
    app.disconnectNextSubmit();

    const handle = await app.coordinator.create(fixtureRequest());
    const job = await handle.wait(5_000);

    expect(job.status).toBe("completed");
    expect(app.submitCount()).toBe(1);
    expect(job.upstreamTaskId).toMatch(/^fixture-task-/u);
  });

  it("holds capacity when discovery is ambiguous", async () => {
    const app = harness();
    app.addAssetsPerSubmit(2);

    const handle = await app.coordinator.create(fixtureRequest());
    const job = await handle.wait(5_000);

    expect(job.status).toBe("unknown");
    expect(app.capacity.activeJobIds()).toContain(job.id);
    expect(app.submitCount()).toBe(1);
  });

  it("serializes baseline, submit, and discovery for identical concurrent payloads", async () => {
    const app = harness();
    const [first, second] = await Promise.all([
      app.coordinator.create(fixtureRequest({
        media: [{
          source: {
            type: "prepared",
            media: trackedMedia(Buffer.from("same payload"))
          },
          kind: "image"
        }],
        idempotencyKey: "key-a"
      })),
      app.coordinator.create(fixtureRequest({
        media: [{
          source: {
            type: "prepared",
            media: trackedMedia(Buffer.from("same payload"))
          },
          kind: "image"
        }],
        idempotencyKey: "key-b"
      }))
    ]);
    const [firstJob, secondJob] = await Promise.all([
      first.wait(5_000),
      second.wait(5_000)
    ]);

    expect(first.job.id).not.toBe(second.job.id);
    expect(firstJob.creationCode).not.toBe(secondJob.creationCode);
    expect(app.maximumCriticalConcurrency()).toBe(1);
    expect(app.submitCount()).toBe(2);
    expect(app.criticalHistory().filter((event) => (
      event.startsWith("assets:") || event.startsWith("submit:")
    ))).toEqual([
      "assets:submits=0:count=0",
      "submit:1",
      "assets:submits=1:count=1",
      "assets:submits=1:count=1",
      "submit:2",
      "assets:submits=2:count=2"
    ]);
  });

  it("disposes media and releases capacity exactly once after an upload failure", async () => {
    const app = harness();
    const media = trackedMedia();
    app.failUpload(new Error("injected upload failure"));

    const handle = await app.coordinator.create(fixtureRequest({
      media: [{
        source: { type: "prepared", media },
        kind: "image"
      }]
    }));
    const job = await handle.wait(5_000);

    expect(job).toMatchObject({
      status: "failed",
      errorCode: "generation_before_submit_failed"
    });
    expect(media.disposeCount()).toBe(1);
    expect(app.capacity.activeJobIds()).not.toContain(job.id);
    expect(app.capacity.counts().admitted).toBe(0);
    expect(app.submitCount()).toBe(0);
  });

  it("aborting one waiter never cancels the shared worker", async () => {
    const app = harness();
    const handle = await app.coordinator.create(fixtureRequest());
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));

    await expect(handle.wait(5_000, controller.signal)).rejects.toThrow(
      "client disconnected"
    );
    const final = await handle.wait(5_000);

    expect(final.status).toBe("completed");
    expect(app.submitCount()).toBe(1);
    expect(app.registry.startCountFor(handle.job.id)).toBe(1);
  });

  it("fails the persisted queued job when shutdown rejects a new runner", async () => {
    const app = harness();
    const media = trackedMedia();
    app.registry.stopAccepting();

    await expect(app.coordinator.create(fixtureRequest({
      media: [{
        source: { type: "prepared", media },
        kind: "image"
      }]
    }))).rejects.toThrow("no longer accepting work");

    const jobs = app.repository.list({ limit: 10 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "failed",
      errorCode: "runner_not_started"
    });
    expect(media.disposeCount()).toBe(1);
    expect(app.capacity.activeJobIds()).toEqual([]);
    expect(app.submitCount()).toBe(0);
  });

  it("resumes discovery after a read failure without a second submit", async () => {
    const app = harness();
    app.failNextPostSubmitAssetRead();

    const first = await app.coordinator.create(fixtureRequest());
    await app.registry.waitUntilIdle();
    expect(app.repository.findById(first.job.id)?.status).toBe("discovering");
    expect(app.capacity.activeJobIds()).toContain(first.job.id);

    const resumed = await app.coordinator.resume(first.job.id);
    const final = await resumed.wait(5_000);

    expect(final.status).toBe("completed");
    expect(app.submitCount()).toBe(1);
    expect(app.capacity.activeJobIds()).not.toContain(final.id);
  });

  it("continues background recovery while an unknown job holds capacity", async () => {
    const app = harness();
    app.addAssetsPerSubmit(2);

    const handle = await app.coordinator.create(fixtureRequest());
    const unknown = await handle.wait(5_000);
    expect(unknown.status).toBe("unknown");
    app.resolveAmbiguity();
    await app.registry.waitUntilIdle();

    expect(app.repository.findById(handle.job.id)?.status).toBe("completed");
    expect(app.submitCount()).toBe(1);
    expect(app.capacity.activeJobIds()).not.toContain(handle.job.id);
  });

  it("keeps the unknown hold durable across a background discovery read failure", async () => {
    const app = harness();
    app.addAssetsPerSubmit(2);

    const handle = await app.coordinator.create(fixtureRequest());
    expect((await handle.wait(5_000)).status).toBe("unknown");
    app.failNextPostSubmitAssetRead();
    app.resolveAmbiguity();
    await app.registry.waitUntilIdle();

    expect(app.repository.findById(handle.job.id)?.status).toBe("completed");
    expect(app.submitCount()).toBe(1);
    expect(app.capacity.activeJobIds()).not.toContain(handle.job.id);
  });

  it("drains a submit reservation held by a worker still uploading", async () => {
    const registry = new JobRunnerRegistry();
    const reservation = registry.reserveSubmitCriticalSection();
    let releaseUpload: (() => void) | undefined;
    const upload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const runner = registry.startOnce("job-1", async () => {
      await upload;
      await reservation.run(() => Promise.resolve());
    });
    registry.stopAccepting();
    let drained = false;
    const drain = registry.drainSubmitCriticalSections(1_000).then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);
    releaseUpload?.();
    await Promise.all([runner.promise, drain]);
    expect(drained).toBe(true);
  });
});
