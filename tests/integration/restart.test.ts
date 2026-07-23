import { mkdtempSync } from "node:fs";
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
import type { JobRecord } from "../../src/jobs/types.js";
import { SubmitAmbiguousError } from "../../src/lingjing/error-map.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
import type { NormalizedModel } from "../../src/models/types.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

type Boundary = "submitting" | "discovering" | "processing";

const directories: string[] = [];
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
    removeTestDirectory(directory);
  }
});

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) {
    throw new Error("Deferred promise could not be initialized");
  }
  return { promise, resolve: resolvePromise };
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-runtime-restart-"));
  directories.push(directory);
  return join(directory, "jobs.sqlite");
}

function account(): {
  describe(): Promise<{
    subject: string;
    spaceId: number;
    membership: null;
    maxConcurrency: number;
    pointsBalance: number;
    couponBalance: number;
    availableAmount: number;
    totalBalance: number;
    resourcePackages: never[];
  }>;
} {
  return {
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
  };
}

function coordinatorFor(
  repository: SqliteJobRepository,
  registry: JobRunnerRegistry,
  transport: LingjingTransport
): LingjingGenerationCoordinator {
  return new LingjingGenerationCoordinator({
    repository,
    capacity: new CapacityManager(5),
    registry,
    transport,
    account: account(),
    catalog: { resolve: () => Promise.resolve(fixtureModel) },
    prepareMedia: () => Promise.reject(new Error("No media expected")),
    discoveryLock: new DiscoveryLock(),
    assetDiscoveryTimeoutMs: 30,
    unknownCapacityHoldMs: 100,
    taskPollIntervalMs: 1,
    sleep: () => Promise.resolve()
  });
}

function asset(payload: unknown, submittedAt: number): Record<string, unknown> {
  return {
    id: "fixture-asset-restart",
    scene: "image-generation",
    modelCode: "fixture-model-code",
    createTime: submittedAt + 1,
    creationCode: "fixture-creation-restart",
    taskId: "fixture-task-restart",
    reqParam: payload,
    status: 0
  };
}

interface FirstRuntime {
  repository: SqliteJobRepository;
  coordinator: LingjingGenerationCoordinator;
  registry: JobRunnerRegistry;
  reached: Promise<void>;
  release(): void;
  submitCount(): number;
  payload(): unknown;
}

function startFirstRuntime(
  path: string,
  boundary: Boundary
): FirstRuntime {
  const repository = new SqliteJobRepository(path);
  const registry = new JobRunnerRegistry();
  const gate = deferred();
  const boundaryReached = deferred();
  let assetReads = 0;
  let submits = 0;
  let submittedPayload: unknown;
  let submittedAt = Date.now();
  const transport = {
    read: vi.fn(async (requestPath: string) => {
      if (requestPath === "/joycreator/space/asset/list") {
        assetReads += 1;
        if (assetReads === 1) return { records: [] };
        if (boundary === "discovering" && assetReads === 2) {
          boundaryReached.resolve();
          await gate.promise;
          return { records: [] };
        }
        return { records: [asset(submittedPayload, submittedAt)] };
      }
      if (requestPath === "/openApi/modelmarket/describeUserTask") {
        if (boundary === "processing") {
          boundaryReached.resolve();
          await gate.promise;
        }
        return {
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
        };
      }
      throw new Error(`Unexpected first-runtime read ${requestPath}`);
    }),
    submitOnce: vi.fn(async (_requestPath: string, payload: unknown) => {
      submits += 1;
      submittedPayload = payload;
      submittedAt = Date.now();
      if (boundary === "submitting") {
        boundaryReached.resolve();
        await gate.promise;
        throw new SubmitAmbiguousError();
      }
      return {};
    }),
    uploadApi: vi.fn(),
    putSigned: vi.fn()
  } as unknown as LingjingTransport;
  const coordinator = coordinatorFor(repository, registry, transport);
  void coordinator.create({
    kind: "image",
    sourceType: "image-generation",
    model: "fixture-api",
    values: { prompt: "fixture restart prompt" },
    media: [],
    idempotencyKey: `fixture-${boundary}-restart`
  }).catch(() => undefined);
  return {
    repository,
    coordinator,
    registry,
    reached: boundaryReached.promise,
    release: () => {
      gate.resolve();
    },
    submitCount: () => submits,
    payload: () => submittedPayload
  };
}

interface RecoveryEvidence {
  job: JobRecord;
  assetReads: number;
  taskPolls: number;
  submitCount: number;
}

async function recoverSecondRuntime(
  path: string,
  jobId: string,
  payload: unknown
): Promise<RecoveryEvidence> {
  const repository = new SqliteJobRepository(path);
  const registry = new JobRunnerRegistry();
  let assetReads = 0;
  let taskPolls = 0;
  let submitCount = 0;
  const persisted = repository.findById(jobId);
  if (persisted?.submittedAt === null || persisted === null) {
    repository.close();
    throw new Error("Persisted runtime job has no submission time");
  }
  const transport = {
    read: vi.fn((requestPath: string) => {
      if (requestPath === "/joycreator/space/asset/list") {
        assetReads += 1;
        return Promise.resolve({
          records: [asset(payload, persisted.submittedAt ?? 0)]
        });
      }
      if (requestPath === "/openApi/modelmarket/describeUserTask") {
        taskPolls += 1;
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
      throw new Error(`Unexpected second-runtime read ${requestPath}`);
    }),
    submitOnce: vi.fn(() => {
      submitCount += 1;
      return Promise.resolve({});
    }),
    uploadApi: vi.fn(),
    putSigned: vi.fn()
  } as unknown as LingjingTransport;
  const coordinator = coordinatorFor(repository, registry, transport);
  const recovery = new StartupRecovery({
    repository,
    capacity: new CapacityManager(5),
    registry,
    resumeJob: coordinator.recoveryResumeRunner,
    unknownCapacityHoldMs: 100
  });
  try {
    await recovery.start();
    await recovery.waitUntilIdle();
    const job = repository.findById(jobId);
    if (job === null) throw new Error("Recovered job was not found");
    return { job, assetReads, taskPolls, submitCount };
  } finally {
    recovery.close();
    coordinator.stopPollers();
    repository.close();
  }
}

function onlyJob(repository: SqliteJobRepository): JobRecord {
  const job = repository.list({ limit: 2 })[0];
  if (job === undefined) throw new Error("Runtime did not persist a job");
  return job;
}

describe("durable restart recovery", () => {
  it.each(["discovering", "processing"] as const)(
    "uses a real first coordinator to stop at %s and a second runtime to finish without submit",
    async (boundary) => {
      const path = databasePath();
      const first = startFirstRuntime(path, boundary);
      await first.reached;
      expect(onlyJob(first.repository).status).toBe(boundary);
      first.coordinator.stopPollers();
      first.release();
      await first.registry.waitUntilIdle();
      const stopped = onlyJob(first.repository);
      const payload = first.payload();
      expect(first.submitCount()).toBe(1);
      first.repository.close();

      expect(stopped.status).toBe(boundary);
      const recovered = await recoverSecondRuntime(
        path,
        stopped.id,
        payload
      );
      expect(recovered.submitCount).toBe(0);
      expect(recovered.taskPolls).toBeGreaterThan(0);
      if (boundary === "discovering") {
        expect(recovered.assetReads).toBeGreaterThan(0);
      } else {
        expect(recovered.assetReads).toBe(0);
      }
      expect(recovered.job).toMatchObject({
        status: "completed",
        result: {
          outputs: [{
            url: "https://media.example/fixture-restart.png"
          }]
        }
      });
    }
  );

  it("drains one written submit, closes once, and recovers it in the second runtime", async () => {
    const path = databasePath();
    const first = startFirstRuntime(path, "submitting");
    await first.reached;
    const beforeShutdown = onlyJob(first.repository);
    expect(beforeShutdown.status).toBe("submitting");
    const app = {
      close: () => Promise.resolve(),
      server: { closeAllConnections: () => undefined }
    };
    const recovery = { close: () => undefined };

    let shutdownSettled = false;
    const shutdown = shutdownServer({
      app,
      registry: first.registry,
      coordinator: first.coordinator,
      recovery,
      repository: first.repository,
      submitDrainTimeoutMs: 1_000,
      runnerIdleTimeoutMs: 1_000
    }).finally(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shutdownSettled).toBe(false);
    expect(onlyJob(first.repository).status).toBe("submitting");

    first.release();
    const payload = first.payload();
    await shutdown;
    expect(shutdownSettled).toBe(true);

    const stoppedRepository = new SqliteJobRepository(path);
    const stopped = onlyJob(stoppedRepository);
    expect(["submitting", "discovering"]).toContain(stopped.status);
    expect(stopped.status).not.toBe("completed");
    stoppedRepository.close();
    const recovered = await recoverSecondRuntime(
      path,
      stopped.id,
      payload
    );
    expect(first.submitCount()).toBe(1);
    expect(recovered.submitCount).toBe(0);
    expect(recovered.assetReads).toBeGreaterThan(0);
    expect(recovered.taskPolls).toBeGreaterThan(0);
    expect(recovered.job.status).toBe("completed");
    expect(recovered.job.result).toEqual({
      outputs: [{
        url: "https://media.example/fixture-restart.png",
        posterUrl: null,
        width: 1024,
        height: 1024,
        duration: null,
        format: null
      }]
    });
  });
});
