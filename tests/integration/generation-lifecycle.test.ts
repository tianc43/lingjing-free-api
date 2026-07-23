import { afterEach, describe, expect, it } from "vitest";
import { StartupRecovery } from "../../src/jobs/recovery.js";
import { fingerprintUpstreamPayload } from "../../src/jobs/upstream-fingerprint.js";
import {
  createGenerationHarness,
  fixtureRequest,
  type GenerationHarness
} from "../helpers/generation-harness.js";

const harnesses: GenerationHarness[] = [];

afterEach(async () => {
  for (const value of harnesses.splice(0)) await value.close();
});

describe("generation lifecycle", () => {
  it("moves a successful task through persisted states and releases capacity", async () => {
    const app = createGenerationHarness();
    harnesses.push(app);

    const handle = await app.coordinator.create(fixtureRequest());
    const finalJob = await handle.wait(10_000);

    expect(finalJob.status).toBe("completed");
    expect(finalJob.result?.outputs[0]?.url).toMatch(
      /^https:\/\/media\.example\/fixture-task-/u
    );
    expect(app.capacity.activeJobIds()).not.toContain(finalJob.id);
    expect(app.repository.history(finalJob.id)).toEqual([
      "queued",
      "submitting",
      "discovering",
      "processing",
      "completed"
    ]);
    expect(app.submitCount()).toBe(1);
  });

  it("shares the production runner with startup recovery without resubmitting", async () => {
    const app = createGenerationHarness();
    harnesses.push(app);
    const submittedAt = Date.now() - 100;
    const payload = {
      apiId: "707",
      refId: "fixture-ref",
      params: [
        { idx: "1", name: "Prompt", values: "restored fixture" },
        {
          idx: "2",
          name: "Images",
          values: ["https://uploads.example/restored.png"],
          filePath: ["https://uploads.example/restored.png"]
        }
      ],
      spaceId: 0
    };
    const persisted = app.repository.createOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "707",
      apiId: "707",
      modelCode: "model-v1",
      expectedAssetScene: "image-generation",
      requestFingerprint: "a".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 0
    }).job;
    app.repository.transition(persisted.id, ["queued"], {
      status: "submitting",
      submittedAt,
      upstreamFingerprint: fingerprintUpstreamPayload(payload)
    });
    app.addPersistedAsset({
      payload,
      submittedAt,
      taskId: "fixture-restored-task",
      creationCode: "fixture-restored-creation"
    });
    const recovery = new StartupRecovery({
      repository: app.repository,
      capacity: app.capacity,
      registry: app.registry,
      resumeJob: app.coordinator.recoveryResumeRunner,
      unknownCapacityHoldMs: 60_000
    });

    try {
      await recovery.start();
      await recovery.waitUntilIdle();

      expect(app.repository.findById(persisted.id)?.status).toBe("completed");
      expect(app.submitCount()).toBe(0);
      expect(app.capacity.activeJobIds()).not.toContain(persisted.id);
      expect(app.repository.history(persisted.id)).toEqual([
        "queued",
        "submitting",
        "discovering",
        "processing",
        "completed"
      ]);
    } finally {
      recovery.close();
    }
  });

  it("preserves an unknown job's exact hold deadline across startup recovery", async () => {
    const app = createGenerationHarness({ unknownCapacityHoldMs: 100 });
    harnesses.push(app);
    const submittedAt = Date.now() - 10;
    const originalHoldUntil = Date.now() + 50;
    const payload = {
      apiId: "707",
      refId: "fixture-ref",
      params: [{ idx: "1", values: "ambiguous restart" }]
    };
    const queued = app.repository.createOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "707",
      apiId: "707",
      modelCode: "model-v1",
      expectedAssetScene: "image-generation",
      requestFingerprint: "d".repeat(64),
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
        unknownHoldUntil: originalHoldUntil,
        errorCode: "generation_discovery_ambiguous"
      }
    );
    app.addPersistedAsset({
      payload,
      submittedAt,
      taskId: "fixture-ambiguous-restart-a",
      creationCode: "ambiguous-restart-a"
    });
    app.addPersistedAsset({
      payload,
      submittedAt,
      taskId: "fixture-ambiguous-restart-b",
      creationCode: "ambiguous-restart-b"
    });
    const recovery = new StartupRecovery({
      repository: app.repository,
      capacity: app.capacity,
      registry: app.registry,
      resumeJob: app.coordinator.recoveryResumeRunner,
      unknownCapacityHoldMs: 100
    });

    try {
      await recovery.start();
      await recovery.waitUntilIdle();

      expect(app.repository.findById(unknown.id)).toMatchObject({
        status: "unknown",
        unknownHoldUntil: originalHoldUntil
      });
      expect(app.submitCount()).toBe(0);
    } finally {
      recovery.close();
    }
  });
});
