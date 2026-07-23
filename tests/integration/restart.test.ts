import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LingjingGenerationCoordinator
} from "../../src/generation/coordinator.js";
import { JobRunnerRegistry } from "../../src/generation/runner-registry.js";
import { shutdownServer } from "../../src/index.js";
import { CapacityManager } from "../../src/jobs/capacity.js";
import { DiscoveryLock } from "../../src/jobs/discovery-lock.js";
import { StartupRecovery } from "../../src/jobs/recovery.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { fingerprintUpstreamPayload } from "../../src/jobs/upstream-fingerprint.js";
import type { JobStatus, NewJob } from "../../src/jobs/types.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
import type { NormalizedModel } from "../../src/models/types.js";

const directories: string[] = [];
const payload = {
  apiId: "fixture-api",
  refId: "fixture-ref",
  params: [{ idx: "1", values: "fixture restart prompt" }]
};
const upstreamFingerprint = fingerprintUpstreamPayload(payload);
const fixtureJob: NewJob = {
  kind: "image",
  sourceType: "image-generation",
  model: "fixture-model",
  apiId: "fixture-api",
  modelCode: "fixture-model-code",
  expectedAssetScene: "image-generation",
  requestFingerprint: "a".repeat(64),
  idempotencyKeyHash: null,
  spaceId: 0
};
const fixtureModel: NormalizedModel = {
  id: "fixture-api",
  apiId: "fixture-api",
  alias: "fixture-model",
  displayName: "Fixture model",
  sourceType: "image-generation",
  modelCode: "fixture-model-code",
  refId: "fixture-ref",
  sceneCode: "fixture-scene",
  expectedAssetScene: "image-generation",
  uploadStrategy: "general",
  priceQuerySchema: null,
  parameters: [{
    idx: "1",
    key: "prompt",
    displayName: "Prompt",
    required: true,
    kind: "string"
  }],
  pricing: null,
  rawRevision: "fixture-revision"
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-restart-full-"));
  directories.push(directory);
  return join(directory, "jobs.sqlite");
}

function persistedAt(
  repository: SqliteJobRepository,
  status: Extract<JobStatus, "submitting" | "discovering" | "processing">
): string {
  const created = repository.createOrGet(fixtureJob).job;
  repository.transition(created.id, ["queued"], {
    status: "submitting",
    submittedAt: 10_000,
    upstreamFingerprint
  });
  if (status !== "submitting") {
    repository.transition(created.id, ["submitting"], {
      status: "discovering"
    });
  }
  if (status === "processing") {
    repository.transition(created.id, ["discovering"], {
      status: "processing",
      upstreamTaskId: "fixture-task-restart",
      creationCode: "fixture-creation-restart",
      discoveredAt: 10_100
    });
  }
  return created.id;
}

function recoveryTransport(submitCount: { value: number }): LingjingTransport {
  return {
    read: vi.fn((path: string) => {
      if (path === "/joycreator/space/asset/list") {
        return Promise.resolve({
          records: [{
            id: "fixture-asset-restart",
            scene: "image-generation",
            modelCode: "fixture-model-code",
            createTime: 10_100,
            creationCode: "fixture-creation-restart",
            taskId: "fixture-task-restart",
            reqParam: payload,
            status: 0
          }]
        });
      }
      if (path === "/openApi/modelmarket/describeUserTask") {
        return Promise.resolve({
          data: {
            task: {
              taskId: "fixture-task-restart",
              status: 1,
              taskResults: [{
                imageUrl: "https://media.example/fixture-restart.png",
                width: 1024,
                height: 1024
              }]
            }
          }
        });
      }
      throw new Error(`Unexpected recovery path ${path}`);
    }),
    submitOnce: vi.fn(() => {
      submitCount.value += 1;
      return Promise.resolve({});
    }),
    uploadApi: vi.fn(),
    putSigned: vi.fn()
  } as unknown as LingjingTransport;
}

function coordinatorFor(
  repository: SqliteJobRepository,
  capacity: CapacityManager,
  registry: JobRunnerRegistry,
  transport: LingjingTransport
): LingjingGenerationCoordinator {
  return new LingjingGenerationCoordinator({
    repository,
    capacity,
    registry,
    transport,
    account: {
      describe: () => Promise.resolve({
        subject: "fixture-subject",
        spaceId: 0,
        membership: null,
        maxConcurrency: 5,
        pointsBalance: 100,
        couponBalance: 0,
        availableAmount: 100,
        totalBalance: 100,
        resourcePackages: []
      })
    },
    catalog: { resolve: () => Promise.resolve(fixtureModel) },
    prepareMedia: () => Promise.reject(new Error("No media expected")),
    discoveryLock: new DiscoveryLock(),
    assetDiscoveryTimeoutMs: 50,
    unknownCapacityHoldMs: 500,
    taskPollIntervalMs: 1,
    sleep: () => Promise.resolve()
  });
}

async function restartAndRecover(
  databasePath: string,
  jobId: string,
  submitCount: { value: number }
): Promise<void> {
  const repository = new SqliteJobRepository(databasePath);
  const capacity = new CapacityManager(5);
  const registry = new JobRunnerRegistry();
  const transport = recoveryTransport(submitCount);
  const coordinator = coordinatorFor(
    repository,
    capacity,
    registry,
    transport
  );
  const recovery = new StartupRecovery({
    repository,
    capacity,
    registry,
    resumeJob: coordinator.recoveryResumeRunner,
    unknownCapacityHoldMs: 500
  });
  try {
    await recovery.start();
    await recovery.waitUntilIdle();
    expect(repository.findById(jobId)).toMatchObject({
      status: "completed",
      result: {
        outputs: [{
          url: "https://media.example/fixture-restart.png"
        }]
      }
    });
  } finally {
    recovery.close();
    coordinator.stopPollers();
    repository.close();
  }
}

describe("durable restart recovery", () => {
  it.each(["submitting", "discovering", "processing"] as const)(
    "recovers from %s to the same result without another submit",
    async (status) => {
      const databasePath = createDatabasePath();
      const first = new SqliteJobRepository(databasePath);
      const jobId = persistedAt(first, status);
      first.close();
      const submits = { value: 0 };

      await restartAndRecover(databasePath, jobId, submits);

      expect(submits.value).toBe(0);
    }
  );

  it("drains a submit written to the wire before closing SQLite and recovers without resubmit", async () => {
    const databasePath = createDatabasePath();
    const repository = new SqliteJobRepository(databasePath);
    const capacity = new CapacityManager(5);
    const registry = new JobRunnerRegistry();
    let markWritten: (() => void) | undefined;
    let releaseSubmit: (() => void) | undefined;
    const written = new Promise<void>((resolve) => {
      markWritten = resolve;
    });
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    let submitCount = 0;
    let submitted = false;
    const transport = {
      read: vi.fn((path: string) => {
        if (path === "/joycreator/space/asset/list") {
          return Promise.resolve({
            records: submitted
              ? [{
                  id: "fixture-asset-restart",
                  scene: "image-generation",
                  modelCode: "fixture-model-code",
                  createTime: Date.now() + 1,
                  creationCode: "fixture-creation-restart",
                  taskId: "fixture-task-restart",
                  reqParam: payload,
                  status: 0
                }]
              : []
          });
        }
        if (path === "/openApi/modelmarket/describeUserTask") {
          return Promise.resolve({
            data: {
              task: {
                taskId: "fixture-task-restart",
                status: 1,
                taskResults: [{
                  imageUrl: "https://media.example/fixture-restart.png",
                  width: 1024,
                  height: 1024
                }]
              }
            }
          });
        }
        throw new Error(`Unexpected shutdown path ${path}`);
      }),
      submitOnce: vi.fn(async () => {
        submitCount += 1;
        markWritten?.();
        await submitGate;
        submitted = true;
        return {};
      }),
      uploadApi: vi.fn(),
      putSigned: vi.fn()
    } as unknown as LingjingTransport;
    const coordinator = coordinatorFor(
      repository,
      capacity,
      registry,
      transport
    );
    const creation = coordinator.create({
      kind: "image",
      sourceType: "image-generation",
      model: "fixture-api",
      values: { prompt: "fixture restart prompt" },
      media: [],
      idempotencyKey: "fixture-shutdown-window"
    });
    await written;
    const persisted = repository.list({ status: "submitting", limit: 1 })[0];
    expect(persisted?.status).toBe("submitting");

    const shutdown = shutdownServer({
      app: {
        close: () => Promise.resolve(),
        server: { closeAllConnections: () => undefined }
      },
      registry,
      coordinator,
      recovery: { close: () => undefined },
      repository,
      submitDrainTimeoutMs: 1_000,
      runnerIdleTimeoutMs: 1_000
    });
    let shutdownSettled = false;
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shutdownSettled).toBe(false);
    expect(repository.findById(persisted?.id ?? "")?.status)
      .toBe("submitting");

    releaseSubmit?.();
    await shutdown;
    await creation.catch(() => undefined);
    expect(submitCount).toBe(1);

    const recoverySubmits = { value: 0 };
    await restartAndRecover(
      databasePath,
      persisted?.id ?? "",
      recoverySubmits
    );
    expect(recoverySubmits.value).toBe(0);
  });
});
