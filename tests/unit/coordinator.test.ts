import { afterEach, describe, expect, it } from "vitest";
import { JobRunnerRegistry } from "../../src/generation/runner-registry.js";
import { fingerprintUpstreamPayload } from "../../src/jobs/upstream-fingerprint.js";
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

  it("disposes prepared media when admission rejects before preparation", async () => {
    const app = createGenerationHarness({
      capacityActiveLimit: 1,
      capacityMaxQueuedRequests: 0
    });
    harnesses.push(app);
    const blockingAdmission = app.capacity.admit("blocking-request");
    const blockingLease = await blockingAdmission.acquire("blocking-job");
    const media = trackedMedia();

    try {
      await expect(app.coordinator.create(fixtureRequest({
        media: [{
          source: { type: "prepared", media },
          kind: "image"
        }]
      }))).rejects.toMatchObject({
        code: "lingjing_capacity_queue_full"
      });

      expect(media.disposeCount()).toBe(1);
      expect(app.events).toEqual([]);
    } finally {
      blockingLease.release();
    }
  });

  it("disposes prepared media when catalog resolution rejects before preparation", async () => {
    const failure = new Error("injected catalog failure");
    const app = createGenerationHarness({ catalogFailure: failure });
    harnesses.push(app);
    const media = trackedMedia();

    await expect(app.coordinator.create(fixtureRequest({
      media: [{
        source: { type: "prepared", media },
        kind: "image"
      }]
    }))).rejects.toBe(failure);

    expect(media.disposeCount()).toBe(1);
    expect(app.events).toEqual([
      "account",
      "catalog:707:image-generation:true"
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

  it("rejects duplicate prepared media identity without double disposal", async () => {
    const app = createGenerationHarness({ mediaMaxFiles: 2 });
    harnesses.push(app);
    const media = trackedMedia();

    await expect(app.coordinator.create(fixtureRequest({
      media: [
        {
          source: { type: "prepared", media },
          kind: "image"
        },
        {
          source: { type: "prepared", media },
          kind: "image"
        }
      ]
    }))).rejects.toMatchObject({ code: "invalid_request" });

    expect(media.disposeCount()).toBe(1);
    expect(app.uploadCount()).toBe(0);
    expect(app.submitCount()).toBe(0);
    expect(app.repository.list({ limit: 10 })).toEqual([]);
    expect(app.capacity.counts().admitted).toBe(0);
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
    expect(firstMedia.disposeCount()).toBe(1);
    expect(secondMedia.disposeCount()).toBe(1);
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

  it("finishes the submit reservation and persists a rejected submit once", async () => {
    const app = harness();
    app.failNextSubmit(new Error("injected submit rejection"));

    const handle = await app.coordinator.create(fixtureRequest());
    await app.registry.waitUntilIdle();

    expect(app.repository.findById(handle.job.id)).toMatchObject({
      status: "failed",
      errorCode: "generation_submit_rejected"
    });
    expect(app.submitCount()).toBe(1);
    await expect(app.registry.drainSubmitCriticalSections(0))
      .resolves.toBeUndefined();
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

  it("persists unknown and recovers in the same worker after the first discovery read fails", async () => {
    const app = harness();
    app.failNextPostSubmitAssetRead();

    const handle = await app.coordinator.create(fixtureRequest());
    await app.registry.waitUntilIdle();

    expect(app.repository.history(handle.job.id)).toEqual([
      "queued",
      "submitting",
      "discovering",
      "unknown",
      "processing",
      "completed"
    ]);
    expect(app.repository.findById(handle.job.id)?.status).toBe("completed");
    expect(app.submitCount()).toBe(1);
    expect(app.registry.startCountFor(handle.job.id)).toBe(1);
    expect(app.capacity.activeJobIds()).not.toContain(handle.job.id);
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
    const app = createGenerationHarness({ unknownCapacityHoldMs: 1_000 });
    harnesses.push(app);
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

  it("retries a transient polling read failure without losing the worker or lease", async () => {
    const app = harness();
    app.failNextTaskRead();

    const handle = await app.coordinator.create(fixtureRequest());
    await app.registry.waitUntilIdle();

    expect(app.repository.findById(handle.job.id)?.status).toBe("completed");
    expect(app.repository.history(handle.job.id)).toEqual([
      "queued",
      "submitting",
      "discovering",
      "processing",
      "completed"
    ]);
    expect(app.submitCount()).toBe(1);
    expect(app.capacity.activeJobIds()).not.toContain(handle.job.id);
  });

  it("does not accept unknown discovery after its fixed capacity hold expires", async () => {
    let now = 0;
    const app = createGenerationHarness({
      now: () => now,
      unknownCapacityHoldMs: 100
    });
    harnesses.push(app);
    const payload = {
      apiId: "707",
      refId: "fixture-ref",
      params: [{ idx: "1", values: "deadline fixture" }]
    };
    const queued = app.repository.createOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "707",
      apiId: "707",
      modelCode: "model-v1",
      expectedAssetScene: "image-generation",
      requestFingerprint: "c".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 0
    }).job;
    const submitting = app.repository.transition(queued.id, ["queued"], {
      status: "submitting",
      submittedAt: 0,
      upstreamFingerprint: fingerprintUpstreamPayload(payload)
    });
    const unknown = app.repository.transition(
      submitting.id,
      ["submitting"],
      {
        status: "unknown",
        unknownHoldUntil: 100,
        errorCode: "generation_discovery_timeout"
      }
    );
    app.addPersistedAsset({
      payload,
      submittedAt: 0,
      taskId: "fixture-deadline-task",
      creationCode: "deadline-creation"
    });
    const gate = app.blockNextAssetRead();

    await app.coordinator.resume(unknown.id);
    await gate.started;
    now = 101;
    app.capacity.expireUnknown(now);
    gate.release();
    await app.registry.waitUntilIdle();

    expect(app.repository.findById(unknown.id)).toMatchObject({
      status: "unknown",
      unknownHoldUntil: 100
    });
    expect(app.capacity.activeJobIds()).not.toContain(unknown.id);
    expect(app.submitCount()).toBe(0);
  });

  it("keeps a timed-out discovery lock owner registered until its read settles", async () => {
    const app = harness();
    const submittedAt = Date.now();
    const holdUntil = Date.now() + 30;
    const payload = {
      apiId: "707",
      refId: "fixture-ref",
      params: [{ idx: "1", values: "bounded lock fixture" }]
    };
    const queued = app.repository.createOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "707",
      apiId: "707",
      modelCode: "model-v1",
      expectedAssetScene: "image-generation",
      requestFingerprint: "e".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 0
    }).job;
    const submitting = app.repository.transition(queued.id, ["queued"], {
      status: "submitting",
      submittedAt,
      upstreamFingerprint: fingerprintUpstreamPayload(payload)
    });
    const unknown = app.repository.transition(
      submitting.id,
      ["submitting"],
      {
        status: "unknown",
        unknownHoldUntil: holdUntil,
        errorCode: "generation_discovery_timeout"
      }
    );
    app.addPersistedAsset({
      payload,
      submittedAt,
      taskId: "fixture-bounded-lock-task",
      creationCode: "bounded-lock-creation"
    });
    const gate = app.blockNextAssetRead();

    await app.coordinator.resume(unknown.id);
    await gate.started;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(app.repository.findById(unknown.id)?.status).toBe("unknown");
    expect(app.capacity.activeJobIds()).not.toContain(unknown.id);
    expect(app.registry.has(unknown.id)).toBe(true);
    gate.release();
    await app.registry.waitUntilIdle();
    expect(app.registry.has(unknown.id)).toBe(false);
    expect(app.submitCount()).toBe(0);
  });

  it("clears the unknown lease deadline before polling a discovered task", async () => {
    let now = 0;
    const app = createGenerationHarness({ now: () => now });
    harnesses.push(app);
    const payload = {
      apiId: "707",
      refId: "fixture-ref",
      params: [{ idx: "1", values: "processing lease fixture" }]
    };
    const queued = app.repository.createOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "707",
      apiId: "707",
      modelCode: "model-v1",
      expectedAssetScene: "image-generation",
      requestFingerprint: "f".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 0
    }).job;
    const submitting = app.repository.transition(queued.id, ["queued"], {
      status: "submitting",
      submittedAt: 0,
      upstreamFingerprint: fingerprintUpstreamPayload(payload)
    });
    const unknown = app.repository.transition(
      submitting.id,
      ["submitting"],
      {
        status: "unknown",
        unknownHoldUntil: 100,
        errorCode: "generation_discovery_timeout"
      }
    );
    app.addPersistedAsset({
      payload,
      submittedAt: 0,
      taskId: "fixture-processing-lease-task",
      creationCode: "processing-lease-creation"
    });
    app.setTaskStatuses("fixture-processing-lease-task", [0]);

    await app.coordinator.resume(unknown.id);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (app.repository.findById(unknown.id)?.status === "processing") break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(app.repository.findById(unknown.id)?.status).toBe("processing");
    now = 101;
    app.capacity.expireUnknown(now);

    const remainedActive = app.capacity.activeJobIds().includes(unknown.id);
    app.setTaskStatuses("fixture-processing-lease-task", [1]);
    await app.registry.waitUntilIdle();
    expect(remainedActive).toBe(true);
    expect(app.repository.findById(unknown.id)?.status).toBe("completed");
    expect(app.submitCount()).toBe(0);
  });

  it("claims processing capacity before polling an unknown job with a task id", async () => {
    let now = 0;
    const app = createGenerationHarness({ now: () => now });
    harnesses.push(app);
    const queued = app.repository.createOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "707",
      apiId: "707",
      modelCode: "model-v1",
      expectedAssetScene: "image-generation",
      requestFingerprint: "1".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 0
    }).job;
    const submitting = app.repository.transition(queued.id, ["queued"], {
      status: "submitting",
      submittedAt: 0,
      upstreamFingerprint: "2".repeat(64)
    });
    const unknown = app.repository.transition(
      submitting.id,
      ["submitting"],
      {
        status: "unknown",
        creationCode: "known-creation",
        upstreamTaskId: "known-task",
        unknownHoldUntil: 100,
        errorCode: "generation_poll_read_failed"
      }
    );
    app.setTaskStatuses("known-task", [0, 1]);
    const gate = app.blockNextTaskRead();

    await app.coordinator.resume(unknown.id);
    await gate.started;
    now = 101;
    app.capacity.expireUnknown(now);

    const statusWhileBlocked = app.repository.findById(unknown.id)?.status;
    const activeWhileBlocked = app.capacity.activeJobIds().includes(unknown.id);
    gate.release();
    await app.registry.waitUntilIdle();
    expect(statusWhileBlocked).toBe("processing");
    expect(activeWhileBlocked).toBe(true);
    expect(app.repository.findById(unknown.id)?.status).toBe("completed");
    expect(app.submitCount()).toBe(0);
  });

  it("stops a blocked recovered poller without mutating its durable job", async () => {
    const app = harness();
    const queued = app.repository.createOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "707",
      apiId: "707",
      modelCode: "model-v1",
      expectedAssetScene: "image-generation",
      requestFingerprint: "3".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 0
    }).job;
    const submitting = app.repository.transition(queued.id, ["queued"], {
      status: "submitting",
      submittedAt: Date.now(),
      upstreamFingerprint: "4".repeat(64)
    });
    const discovering = app.repository.transition(
      submitting.id,
      ["submitting"],
      { status: "discovering" }
    );
    const processing = app.repository.transition(
      discovering.id,
      ["discovering"],
      {
        status: "processing",
        creationCode: "shutdown-creation",
        upstreamTaskId: "shutdown-task"
      }
    );
    app.setTaskStatuses("shutdown-task", [1]);
    const gate = app.blockNextTaskRead();

    await app.coordinator.resume(processing.id);
    await gate.started;
    try {
      app.coordinator.stopPollers();
      await expect(Promise.race([
        app.registry.waitUntilIdle(),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error("poller did not stop"));
          }, 100);
        })
      ])).resolves.toBeUndefined();

      expect(app.repository.findById(processing.id)?.status).toBe("processing");
      expect(app.capacity.activeJobIds()).not.toContain(processing.id);
    } finally {
      gate.release();
    }
    await Promise.resolve();
    expect(app.repository.findById(processing.id)?.status).toBe("processing");
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
