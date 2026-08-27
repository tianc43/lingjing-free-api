import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { AccountScheduler } from "../../src/accounts/scheduler.js";
import type { AccountRuntime } from "../../src/accounts/runtime.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import { SqliteAdmissionRepository } from "../../src/accounts/sqlite-admission-repository.js";
import { removeTestDirectory } from "./cleanup.js";
import { CapacityManager } from "../../src/jobs/capacity.js";
import { DiscoveryLock } from "../../src/jobs/discovery-lock.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SqliteWorkerLeaseRepository } from "../../src/jobs/worker-lease-repository.js";
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
import { SqliteStore } from "../../src/persistence/sqlite-store.js";

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
  pricing: { unit: "points", amount: 7 },
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
  selectedAccountId: string;
  accountCapacity: CapacityManager;
  removeRuntime(accountId: string): void;
  clearRuntimes(): void;
  budgetEntryCount(jobId: string): number;
  budgetState(jobId: string): "reserved" | "charged" | "released" | null;
  boundActions: string[];
  chargeCount: () => number;
  releaseCount: () => number;
  budgetEvents: string[];
  submitCount: () => number;
  submittedPayloads: () => unknown[];
  maximumCriticalConcurrency: () => number;
  criticalHistory: () => string[];
  warningLogs: Array<{
    bindings: Record<string, unknown>;
    message: string;
  }>;
  addAssetsPerSubmit(count: 1 | 2): void;
  resolveAmbiguity(): void;
  disconnectNextSubmit(): void;
  failNextSubmit(cause: Error): void;
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
  model?: NormalizedModel;
  priceResponse?: unknown;
  now?: () => number;
  unknownCapacityHoldMs?: number;
  mediaMaxFiles?: number;
  capacityActiveLimit?: number;
  capacityMaxQueuedRequests?: number;
  accountCapacityActiveLimit?: number;
  accountCapacityMaxQueuedRequests?: number;
  catalogFailure?: Error;
  initialTaskStatuses?: number[];
  workerLeaseDurationMs?: number;
  workerLeaseHeartbeatMs?: number;
  processingTimeoutMs?: number;
  reconciliationDelayMs?: number;
  configureWorkerLeases?(leases: SqliteWorkerLeaseRepository): void;
} = {}): GenerationHarness {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-generation-"));
  const store = new SqliteStore(join(directory, "jobs.sqlite"));
  const repository = new SqliteJobRepository(store);
  const workerLeases = new SqliteWorkerLeaseRepository(store);
  options.configureWorkerLeases?.(workerLeases);
  const accounts = new SqliteAccountRepository(store);
  const legacy = accounts.ensureLegacyAccount("data/auth");
  accounts.update(legacy.id, { priority: 1 });
  accounts.recordObservation(legacy.id, {
    healthStatus: "ready",
    lastErrorCode: null,
    subjectHash: "legacy-subject",
    membership: null,
    pointsBalance: 100,
    totalBalance: 100,
    maxConcurrency: options.accountCapacityActiveLimit ?? 5
  });
  const selected = accounts.create({
    name: "Selected",
    priority: 0,
    dailyPointLimit: 0,
    monthlyPointLimit: 0
  });
  accounts.update(selected.id, { enabled: true });
  accounts.recordObservation(selected.id, {
    healthStatus: "ready",
    lastErrorCode: null,
    subjectHash: "selected-subject",
    membership: null,
    pointsBalance: 100,
    totalBalance: 100,
    maxConcurrency: options.accountCapacityActiveLimit ?? 5
  });
  const capacity = new CapacityManager(
    options.capacityActiveLimit ?? 5,
    options.capacityMaxQueuedRequests ?? 10
  );
  const registry = new CountingRegistry();
  const assets: FixtureAsset[] = [];
  const statuses = new Map<string, number[]>();
  const events: string[] = [];
  const boundActions: string[] = [];
  const budgetEvents: string[] = [];
  const warningLogs: Array<{
    bindings: Record<string, unknown>;
    message: string;
  }> = [];
  let submissions = 0;
  let uploadCalls = 0;
  let chargeCalls = 0;
  let releaseCalls = 0;
  let assetsPerSubmit: 1 | 2 = 1;
  let disconnect = false;
  let submitFailure: Error | null = null;
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
  const submittedPayloads: unknown[] = [];
  const resolvedModel: NormalizedModel = {
    ...(options.model ?? fixtureModel),
    parameters: (options.model ?? fixtureModel).parameters.map((parameter) =>
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
    if (path === "/joycreator/AIModelApiConsole/calculatePrice") {
      return options.priceResponse ?? {
        result: { totalPrice: 0.924048, discountedTotalPrice: 0.92 }
      };
    }
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
      submittedPayloads.push(payload);
      criticalEvents.push(`submit:${String(submissions)}`);
      if (submitFailure !== null) {
        const cause = submitFailure;
        submitFailure = null;
        throw cause;
      }
      const submittedAt = Date.now();
      for (let offset = 0; offset < assetsPerSubmit; offset += 1) {
        const sequence = submissions * 10 + offset + 1;
        const taskId = `fixture-task-${String(sequence)}`;
        statuses.set(
          taskId,
          statuses.get(taskId) ?? [...(options.initialTaskStatuses ?? [1])]
        );
        assets.push({
          id: `fixture-asset-${String(sequence)}`,
          scene: resolvedModel.expectedAssetScene,
          modelCode: resolvedModel.modelCode ?? "",
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

  const transportFor = (accountId: string): LingjingTransport => ({
    read: vi.fn((...args: Parameters<LingjingTransport["read"]>) => {
      boundActions.push(`read:${accountId}:${args[0]}`);
      return read(...args);
    }) as LingjingTransport["read"],
    submitOnce: vi.fn(async (
      ...args: Parameters<LingjingTransport["submitOnce"]>
    ) => {
      boundActions.push(`submit:${accountId}`);
      budgetEvents.push("submit:start");
      try {
        return await submitOnce(...args);
      } finally {
        budgetEvents.push("submit:end");
      }
    }),
    uploadApi: vi.fn(),
    putSigned: vi.fn()
  } as unknown as LingjingTransport);
  const legacyTransport = transportFor(legacy.id);
  const selectedTransport = transportFor(selected.id);

  const uploadServiceFor = (accountId: string): UploadService => ({
    upload: async (media): Promise<UploadedMaterial> => {
      boundActions.push(`upload:${accountId}`);
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
  });

  const runtimeFor = (
    accountId: string,
    transport: LingjingTransport
  ): AccountRuntime => {
    const accountRecord = accounts.findById(accountId);
    if (accountRecord === null) throw new Error("Fixture account disappeared");
    return {
      record: accountRecord,
      session: {} as AccountRuntime["session"],
      transport,
      account: {
        describe: () => {
          events.push("account");
          return Promise.resolve({
            subject: `${accountId}-subject`,
            spaceId: accountId === legacy.id ? 1 : 2,
            membership: null,
            maxConcurrency: options.accountCapacityActiveLimit ?? 5,
            pointsBalance: 100,
            couponBalance: 0,
            availableAmount: 100,
            totalBalance: 100,
            resourcePackages: []
          });
        }
      } as unknown as AccountRuntime["account"],
      catalog: {
        resolve: (
          requestedModel: string,
          sourceType: GenerationRequest["sourceType"],
          charged?: boolean
        ) => {
          events.push(
            `catalog:${requestedModel}:${sourceType}:${String(charged)}`
          );
          return options.catalogFailure === undefined
            ? Promise.resolve(resolvedModel)
            : Promise.reject(options.catalogFailure);
        }
      } as unknown as AccountRuntime["catalog"],
      capacity: new CapacityManager(
        options.accountCapacityActiveLimit ?? options.capacityActiveLimit ?? 5,
        options.accountCapacityMaxQueuedRequests
          ?? options.capacityMaxQueuedRequests
          ?? 10
      ),
      discoveryLock: new DiscoveryLock()
    };
  };
  const legacyRuntime = runtimeFor(legacy.id, legacyTransport);
  const selectedRuntime = runtimeFor(selected.id, selectedTransport);
  const runtimes = [legacyRuntime, selectedRuntime];
  const availableRuntimes = new Map(
    runtimes.map((runtime) => [runtime.record.id, runtime])
  );
  const admissionsRepository = new SqliteAdmissionRepository(
    store,
    options.now ?? Date.now
  );
  const admissions = {
    findByIdempotencyKeyHash:
      admissionsRepository.findByIdempotencyKeyHash.bind(
        admissionsRepository
      ),
    reserveOrGet: admissionsRepository.reserveOrGet.bind(admissionsRepository),
    charge: (jobId: string) => {
      chargeCalls += 1;
      budgetEvents.push("charge");
      admissionsRepository.charge(jobId);
    },
    releasePreSubmit: (jobId: string) => {
      releaseCalls += 1;
      budgetEvents.push("release");
      admissionsRepository.releasePreSubmit(jobId);
    },
    failAndRelease: (
      jobId: string,
      expectedStatuses: Parameters<
        SqliteAdmissionRepository["failAndRelease"]
      >[1],
      errorCode: string
    ) => {
      releaseCalls += 1;
      budgetEvents.push("release");
      return admissionsRepository.failAndRelease(
        jobId,
        expectedStatuses,
        errorCode
      );
    },
    resolveUnknown: admissionsRepository.resolveUnknown.bind(
      admissionsRepository
    )
  };
  const scheduler = new AccountScheduler({
    registry: {
      listEnabled: () => [...availableRuntimes.values()],
      listRetained: () => runtimes,
      find: (accountId: string) => availableRuntimes.get(accountId) ?? null,
      require: (accountId: string) => {
        const found = availableRuntimes.get(accountId);
        if (found === undefined) throw new Error("Fixture runtime unavailable");
        return found;
      }
    },
    accounts,
    admissions,
    capacity,
    ...(options.now === undefined ? {} : { now: options.now })
  });

  const coordinator = new LingjingGenerationCoordinator({
    repository,
    capacity,
    scheduler,
    admissions,
    workerLeases,
    ...(options.workerLeaseDurationMs === undefined ? {} : {
      workerLeaseDurationMs: options.workerLeaseDurationMs
    }),
    ...(options.workerLeaseHeartbeatMs === undefined ? {} : {
      workerLeaseHeartbeatMs: options.workerLeaseHeartbeatMs
    }),
    ...(options.processingTimeoutMs === undefined ? {} : {
      processingTimeoutMs: options.processingTimeoutMs
    }),
    ...(options.reconciliationDelayMs === undefined ? {} : {
      reconciliationDelayMs: options.reconciliationDelayMs
    }),
    logger: {
      warn: (bindings, message) => {
        warningLogs.push({ bindings, message });
      }
    },
    prepareMedia: (input) => {
      events.push(`prepare:admitted=${String(capacity.counts().admitted)}`);
      if (input.source.type !== "prepared") {
        throw new Error("Fixture only accepts prepared media");
      }
      return Promise.resolve(input.source.media);
    },
    createUploadService: (runtime) => uploadServiceFor(runtime.record.id),
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
    transport: selectedRuntime.transport,
    selectedAccountId: selected.id,
    accountCapacity: selectedRuntime.capacity,
    removeRuntime: (accountId) => {
      availableRuntimes.delete(accountId);
    },
    clearRuntimes: () => {
      availableRuntimes.clear();
    },
    budgetEntryCount: (jobId) => store.read((database) => {
      const row = database.prepare(`
        SELECT COUNT(*) AS count FROM budget_entries WHERE job_id = ?
      `).get(jobId) as { count: number };
      return row.count;
    }),
    budgetState: (jobId) => admissionsRepository.budgetState(jobId),
    boundActions,
    chargeCount: () => chargeCalls,
    releaseCount: () => releaseCalls,
    budgetEvents,
    submitCount: () => submissions,
    submittedPayloads: () => [...submittedPayloads],
    maximumCriticalConcurrency: () => maxCriticalConcurrency,
    criticalHistory: () => [...criticalEvents],
    warningLogs,
    addAssetsPerSubmit: (count) => {
      assetsPerSubmit = count;
    },
    resolveAmbiguity: () => {
      assets.splice(1);
    },
    disconnectNextSubmit: () => {
      disconnect = true;
    },
    failNextSubmit: (cause) => {
      submitFailure = cause;
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
      store.close();
      removeTestDirectory(directory);
    }
  };
}
