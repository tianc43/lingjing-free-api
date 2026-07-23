import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { CapacityManager } from "../../src/jobs/capacity.js";
import { DiscoveryLock } from "../../src/jobs/discovery-lock.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SubmitAmbiguousError } from "../../src/lingjing/error-map.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
import type { PreparedMedia, UploadedMaterial } from "../../src/media/types.js";
import type { NormalizedModel } from "../../src/models/types.js";
import type { UploadService } from "../../src/uploads/types.js";
import {
  LingjingGenerationCoordinator
} from "../../src/generation/coordinator.js";
import {
  JobRunnerRegistry
} from "../../src/generation/runner-registry.js";
import type { GenerationRequest } from "../../src/generation/types.js";

export const fixtureModel: NormalizedModel = {
  id: "fixture-model-id",
  apiId: "707",
  alias: "fixture-model",
  displayName: "Fixture model",
  sourceType: "image-generation",
  modelCode: "model-v1",
  refId: "fixture-ref",
  sceneCode: "fixture-scene",
  expectedAssetScene: "image-generation",
  uploadStrategy: "general",
  priceQuerySchema: null,
  parameters: [
    {
      idx: "1",
      key: "prompt",
      displayName: "Prompt",
      required: true,
      kind: "string"
    },
    {
      idx: "2",
      key: "images",
      displayName: "Images",
      required: true,
      kind: "image-list",
      maxFiles: 1
    }
  ],
  pricing: null,
  rawRevision: "fixture-revision"
};

export interface TrackedPreparedMedia extends PreparedMedia {
  readonly disposeCount: () => number;
}

export function trackedMedia(
  body = Buffer.from("fixture image")
): TrackedPreparedMedia {
  let disposals = 0;
  return {
    filename: "fixture.png",
    contentType: "image/png",
    size: body.byteLength,
    openRead: (start = 0, endInclusive = body.byteLength - 1) => (
      Readable.from([body.subarray(start, endInclusive + 1)])
    ),
    dispose: () => {
      disposals += 1;
      return Promise.resolve();
    },
    disposeCount: () => disposals
  };
}

export function fixtureRequest(
  overrides: Partial<GenerationRequest> = {}
): GenerationRequest {
  return {
    kind: "image",
    sourceType: "image-generation",
    model: fixtureModel.apiId,
    values: { prompt: "draw a fixture" },
    media: [{
      source: { type: "prepared", media: trackedMedia() },
      kind: "image"
    }],
    idempotencyKey: null,
    ...overrides
  };
}

interface FixtureAsset {
  id: string;
  scene: string;
  modelCode: string;
  createTime: number;
  creationCode: string;
  taskId: string;
  reqParam: unknown;
  status: number;
}

class CountingRegistry extends JobRunnerRegistry {
  private readonly starts = new Map<string, number>();

  override startOnce(
    jobId: string,
    work: () => Promise<void>
  ): { promise: Promise<void>; started: boolean } {
    const result = super.startOnce(jobId, work);
    if (result.started) {
      this.starts.set(jobId, (this.starts.get(jobId) ?? 0) + 1);
    }
    return result;
  }

  startCountFor(jobId: string): number {
    return this.starts.get(jobId) ?? 0;
  }
}

export interface GenerationHarness {
  coordinator: LingjingGenerationCoordinator;
  repository: SqliteJobRepository;
  capacity: CapacityManager;
  registry: CountingRegistry;
  transport: LingjingTransport;
  submitCount: () => number;
  maximumCriticalConcurrency: () => number;
  criticalHistory: () => string[];
  addAssetsPerSubmit(count: 1 | 2): void;
  resolveAmbiguity(): void;
  disconnectNextSubmit(): void;
  failNextPostSubmitAssetRead(): void;
  failNextTaskRead(): void;
  blockNextAssetRead(): {
    started: Promise<void>;
    release(): void;
  };
  blockNextTaskRead(): {
    started: Promise<void>;
    release(): void;
  };
  addPersistedAsset(input: {
    payload: unknown;
    submittedAt: number;
    taskId: string;
    creationCode: string;
  }): void;
  setTaskStatuses(taskId: string, statuses: number[]): void;
  failUpload(cause: Error): void;
  events: string[];
  uploadCount: () => number;
  close(): Promise<void>;
}

export function createGenerationHarness(options: {
  now?: () => number;
  unknownCapacityHoldMs?: number;
  mediaMaxFiles?: number;
} = {}): GenerationHarness {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-generation-"));
  const repository = new SqliteJobRepository(join(directory, "jobs.sqlite"));
  const capacity = new CapacityManager(5, 10);
  const registry = new CountingRegistry();
  const assets: FixtureAsset[] = [];
  const statuses = new Map<string, number[]>();
  const events: string[] = [];
  let submissions = 0;
  let uploadCalls = 0;
  let assetsPerSubmit: 1 | 2 = 1;
  let disconnect = false;
  let failPostSubmitAssetRead = false;
  let failTaskRead = false;
  let assetReadGate: {
    started: Promise<void>;
    markStarted(): void;
    wait: Promise<void>;
    release(): void;
  } | null = null;
  let taskReadGate: {
    started: Promise<void>;
    markStarted(): void;
    wait: Promise<void>;
    release(): void;
  } | null = null;
  let uploadFailure: Error | null = null;
  let criticalConcurrency = 0;
  let maxCriticalConcurrency = 0;
  const criticalEvents: string[] = [];
  const resolvedModel: NormalizedModel = {
    ...fixtureModel,
    parameters: fixtureModel.parameters.map((parameter) =>
      parameter.kind === "image-list" && options.mediaMaxFiles !== undefined
        ? { ...parameter, maxFiles: options.mediaMaxFiles }
        : parameter
    )
  };

  const critical = async <T>(work: () => T | Promise<T>): Promise<T> => {
    criticalConcurrency += 1;
    maxCriticalConcurrency = Math.max(
      maxCriticalConcurrency,
      criticalConcurrency
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    try {
      return await work();
    } finally {
      criticalConcurrency -= 1;
    }
  };

  const read = vi.fn(async (path: string, init?: {
    query?: Record<string, unknown>;
    body?: unknown;
  }) => {
    if (path === "/joycreator/space/asset/list") {
      return critical(async () => {
        if (assetReadGate !== null) {
          const gate = assetReadGate;
          assetReadGate = null;
          gate.markStarted();
          await gate.wait;
        }
        if (failPostSubmitAssetRead && submissions > 0) {
          failPostSubmitAssetRead = false;
          throw new Error("injected post-submit asset read failure");
        }
        const page = Number(init?.query?.currentPage ?? 1);
        if (page === 1) {
          criticalEvents.push(
            `assets:submits=${String(submissions)}:count=${String(assets.length)}`
          );
        }
        return { records: page === 1 ? [...assets] : [] };
      });
    }
    if (path === "/openApi/modelmarket/describeUserTask") {
      if (taskReadGate !== null) {
        const gate = taskReadGate;
        taskReadGate = null;
        gate.markStarted();
        await gate.wait;
      }
      if (failTaskRead) {
        failTaskRead = false;
        throw new Error("injected task read failure");
      }
      const body = init?.body as {
        params?: { taskId?: string };
      } | undefined;
      const taskId = body?.params?.taskId ?? "";
      const sequence = statuses.get(taskId) ?? [1];
      const status = sequence.length > 1
        ? sequence.shift() ?? 1
        : sequence[0] ?? 1;
      statuses.set(taskId, sequence);
      return {
        data: {
          task: {
            taskId,
            status,
            taskResults: status === 1
              ? [{
                  imageUrl: `https://media.example/${taskId}.png`,
                  width: 1024,
                  height: 1024
                }]
              : []
          }
        }
      };
    }
    throw new Error(`Unexpected read path ${path}`);
  });

  const submitOnce = vi.fn(async (path: string, payload: unknown) => (
    critical(() => {
      if (path !== "/joycreator/AIModelApiConsole/executeByApiId") {
        throw new Error(`Unexpected submit path ${path}`);
      }
      submissions += 1;
      criticalEvents.push(`submit:${String(submissions)}`);
      const submittedAt = Date.now();
      for (let offset = 0; offset < assetsPerSubmit; offset += 1) {
        const sequence = submissions * 10 + offset + 1;
        const taskId = `fixture-task-${String(sequence)}`;
        statuses.set(taskId, statuses.get(taskId) ?? [1]);
        assets.push({
          id: `fixture-asset-${String(sequence)}`,
          scene: fixtureModel.expectedAssetScene,
          modelCode: fixtureModel.modelCode ?? "",
          createTime: submittedAt + offset,
          creationCode: `fixture-creation-${String(sequence)}`,
          taskId,
          reqParam: payload,
          status: 0
        });
      }
      if (disconnect) {
        disconnect = false;
        throw new SubmitAmbiguousError();
      }
      return {};
    })
  ));

  const transport = {
    read,
    submitOnce,
    uploadApi: vi.fn(),
    putSigned: vi.fn()
  } as unknown as LingjingTransport;

  const uploadService: UploadService = {
    upload: async (media): Promise<UploadedMaterial> => {
      uploadCalls += 1;
      try {
        if (uploadFailure !== null) throw uploadFailure;
        return {
          value: "https://uploads.example/same.png",
          filePath: "uploads/same.png",
          frameUrl: null,
          vendor: null
        };
      } finally {
        await media.dispose();
      }
    }
  };

  const coordinator = new LingjingGenerationCoordinator({
    repository,
    capacity,
    account: {
      describe: () => {
        events.push("account");
        return Promise.resolve({
          subject: "fixture-subject",
          spaceId: 0,
          membership: null,
          maxConcurrency: 5,
          pointsBalance: 100,
          couponBalance: 0,
          availableAmount: 100,
          totalBalance: 100,
          resourcePackages: []
        });
      }
    },
    catalog: {
      resolve: (model, sourceType, charged) => {
        events.push(`catalog:${model}:${sourceType}:${String(charged)}`);
        return Promise.resolve(resolvedModel);
      }
    },
    transport,
    prepareMedia: (input) => {
      events.push(`prepare:admitted=${String(capacity.counts().admitted)}`);
      if (input.source.type !== "prepared") {
        throw new Error("Fixture only accepts prepared media");
      }
      return Promise.resolve(input.source.media);
    },
    createUploadService: () => uploadService,
    discoveryLock: new DiscoveryLock(),
    registry,
    assetDiscoveryTimeoutMs: 30,
    unknownCapacityHoldMs: options.unknownCapacityHoldMs ?? 100,
    taskPollIntervalMs: 1,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    ...(options.now === undefined ? {} : { now: options.now })
  });

  return {
    coordinator,
    repository,
    capacity,
    registry,
    transport,
    submitCount: () => submissions,
    maximumCriticalConcurrency: () => maxCriticalConcurrency,
    criticalHistory: () => [...criticalEvents],
    addAssetsPerSubmit: (count) => {
      assetsPerSubmit = count;
    },
    resolveAmbiguity: () => {
      assets.splice(1);
    },
    disconnectNextSubmit: () => {
      disconnect = true;
    },
    failNextPostSubmitAssetRead: () => {
      failPostSubmitAssetRead = true;
    },
    failNextTaskRead: () => {
      failTaskRead = true;
    },
    blockNextAssetRead: () => {
      let markStarted: (() => void) | undefined;
      let release: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (markStarted === undefined || release === undefined) {
        throw new Error("Asset read gate could not be initialized");
      }
      assetReadGate = {
        started,
        markStarted,
        wait,
        release
      };
      return { started, release };
    },
    blockNextTaskRead: () => {
      let markStarted: (() => void) | undefined;
      let release: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (markStarted === undefined || release === undefined) {
        throw new Error("Task read gate could not be initialized");
      }
      taskReadGate = {
        started,
        markStarted,
        wait,
        release
      };
      return { started, release };
    },
    addPersistedAsset: (input) => {
      assets.push({
        id: `fixture-asset-restored-${input.taskId}`,
        scene: fixtureModel.expectedAssetScene,
        modelCode: fixtureModel.modelCode ?? "",
        createTime: input.submittedAt + 1,
        creationCode: input.creationCode,
        taskId: input.taskId,
        reqParam: input.payload,
        status: 0
      });
      statuses.set(input.taskId, [1]);
    },
    setTaskStatuses: (taskId, nextStatuses) => {
      statuses.set(taskId, [...nextStatuses]);
    },
    failUpload: (cause) => {
      uploadFailure = cause;
    },
    events,
    uploadCount: () => uploadCalls,
    close: async () => {
      await registry.waitUntilIdle();
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
