import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { vi } from "vitest";
import { buildApp, type AppDependencies } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import { CapacityManager } from "../../src/jobs/capacity.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import { SqliteAdmissionRepository } from "../../src/accounts/sqlite-admission-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { removeTestDirectory } from "./cleanup.js";
import type { AccountSnapshot } from "../../src/lingjing/account.js";
import type { NormalizedModel, SourceType } from "../../src/models/types.js";
import { createLogger } from "../../src/logging.js";
import { createTempBudget } from "../../src/media/temp-budget.js";

const API_KEY = "fixture-downstream-secret";

export const imageModel: NormalizedModel = {
  id: "upstream-image-id",
  apiId: "707",
  alias: "fixture-image",
  displayName: "Fixture Image",
  sourceType: "image-generation",
  modelCode: "private-model-code",
  refId: "private-ref-id",
  sceneCode: "private-scene-code",
  expectedAssetScene: "private-asset-scene",
  uploadStrategy: "general",
  priceQuerySchema: null,
  parameters: [{
    idx: "private-index",
    key: "prompt",
    displayName: "Prompt",
    required: true,
    kind: "string"
  }],
  pricing: {
    points: 2,
    currency: "CNY",
    price: {
      amount: 2,
      unit: "image",
      cost: 2,
      signature: "private-price-signature",
      rawPayload: "private-raw-payload"
    },
    apiId: "private-pricing-api-id",
    assetId: "private-pricing-asset-id",
    userId: "private-pricing-user-id",
    sceneCode: "private-pricing-scene-code",
    token: "private-pricing-token",
    "p-r_i.c e": "private-adversarial-price-key",
    nested: { spaceId: 91_001 },
    mystery: "private-pricing-mystery"
  },
  rawRevision: "private-revision"
};

export const videoModel: NormalizedModel = {
  ...imageModel,
  id: "upstream-video-id",
  apiId: "808",
  alias: "fixture-video",
  displayName: "Fixture Video",
  sourceType: "image-to-video"
};

const accountSnapshot: AccountSnapshot = {
  subject: "safe-subject",
  spaceId: 91_001,
  membership: "pro",
  maxConcurrency: 5,
  pointsBalance: 120,
  couponBalance: 3,
  availableAmount: 123,
  totalBalance: 130,
  resourcePackages: [{ name: "fixture", balance: 7 }]
};

const config: AppConfig = {
  host: "127.0.0.1",
  port: 8_000,
  apiKey: API_KEY,
  sessionMode: "browser-state",
  storageStatePath: "fixture-storage-state.json",
  cookieFilePath: "fixture-cookie.txt",
  sessionProfilePath: "fixture-profile.json",
  dataDirectory: "fixture-data",
  dbPath: ":memory:",
  maxConcurrency: 5,
  modelCacheTtlMs: 300_000,
  assetDiscoveryTimeoutMs: 60_000,
  unknownCapacityHoldMs: 900_000,
  taskPollIntervalMs: 5_000,
  imageWaitTimeoutMs: 300_000,
  videoWaitTimeoutMs: 900_000,
  maxImageBytes: 20_971_520,
  maxVideoBytes: 209_715_200,
  jsonBodyLimitBytes: 16_384,
  maxRequestMediaBytes: 230_686_720,
  maxTempBytes: 1_073_741_824,
  maxQueuedRequests: 20,
  logLevel: "info",
  docsEnabled: true,
  adminPassword: null
};

export interface TestApp {
  app: FastifyInstance;
  dependencies: AppDependencies;
  account: {
    throwOnDescribe: Error | null;
    describe: ReturnType<typeof vi.fn<() => Promise<AccountSnapshot>>>;
  };
  catalogCalls: SourceType[];
  catalogRefreshes: boolean[];
  repository: SqliteJobRepository;
  accounts: SqliteAccountRepository;
  admissions: SqliteAdmissionRepository;
  runtimes: {
    refresh: ReturnType<typeof vi.fn>;
    listEnabled: ReturnType<typeof vi.fn>;
  };
  capturedPinoOutput(): string;
  close(): Promise<void>;
}

type TestAppOverrides = Omit<Partial<AppDependencies>, "config"> & {
  config?: Partial<AppConfig>;
};

export async function createTestApp(
  overrides: TestAppOverrides = {}
): Promise<TestApp> {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-api-test-"));
  const store = new SqliteStore(join(directory, "jobs.sqlite"));
  const repository = new SqliteJobRepository(store);
  const accounts = new SqliteAccountRepository(store);
  const admissions = new SqliteAdmissionRepository(store);
  accounts.ensureLegacyAccount("data/auth");
  let logOutput = "";
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      logOutput += String(chunk);
      callback();
    }
  });
  const account = {
    throwOnDescribe: null as Error | null,
    describe: vi.fn((): Promise<AccountSnapshot> => {
      return account.throwOnDescribe === null
        ? Promise.resolve(accountSnapshot)
        : Promise.reject(account.throwOnDescribe);
    })
  };
  const catalogCalls: SourceType[] = [];
  const catalogRefreshes: boolean[] = [];
  const loadedRuntimes: Array<{
    record: NonNullable<ReturnType<SqliteAccountRepository["findById"]>>;
    session: {
      describe(): {
        mode: string;
        source: string;
        sourceMtimeMs: number | null;
        hasCsrf: boolean;
      };
    };
    capacity: CapacityManager;
  }> = [];
  const runtimes = {
    refresh: vi.fn((accountId: string) => {
      const record = accounts.findById(accountId);
      if (record === null || !record.enabled) return Promise.resolve(null);
      const runtime = {
        record,
        session: {
          describe: () => ({
            mode: "browser-state",
            source: "fixture-admin-session",
            sourceMtimeMs: 123,
            hasCsrf: true
          })
        },
        capacity: new CapacityManager(
          record.maxConcurrency ?? config.maxConcurrency,
          config.maxQueuedRequests
        )
      };
      const existing = loadedRuntimes.findIndex(
        (item) => item.record.id === accountId
      );
      if (existing === -1) loadedRuntimes.push(runtime);
      else loadedRuntimes[existing] = runtime;
      return Promise.resolve(runtime);
    }),
    listEnabled: vi.fn(() => loadedRuntimes)
  };
  const capacity = new CapacityManager(5, 20);
  const { config: configOverrides, ...dependencyOverrides } = overrides;
  const dependencies: AppDependencies = {
    config: { ...config, ...configOverrides },
    logger: createLogger("info", destination),
    session: {
      mode: "browser-state",
      load: vi.fn(),
      loadProfile: vi.fn(() => Promise.resolve({
        originPin: "fixture-private-pin"
      })),
      applySetCookies: vi.fn(),
      describe: () => ({
        mode: "browser-state",
        source: "private-storage-state-path",
        sourceMtimeMs: 123,
        hasCsrf: true
      }),
      invalidate: vi.fn()
    },
    transport: {
      read: vi.fn(),
      submitOnce: vi.fn(),
      uploadApi: vi.fn(),
      putSigned: vi.fn()
    },
    account,
    catalog: {
      list: vi.fn((
        sourceType: SourceType,
        refresh: boolean = false
      ) => {
        catalogCalls.push(sourceType);
        catalogRefreshes.push(refresh);
        return Promise.resolve(sourceType === "image-generation"
          ? [imageModel]
          : [videoModel]);
      }),
      resolve: vi.fn()
    },
    repository,
    accounts,
    admissions,
    runtimes,
    coordinator: {
      create: vi.fn(),
      resume: vi.fn(),
      resolveUnknown: vi.fn((
        accountId: string,
        jobId: string,
        action: "charge" | "release"
      ) => {
        const resolved = admissions.resolveUnknown(accountId, jobId, action);
        capacity.releaseJob(jobId);
        loadedRuntimes.find(
          (runtime) => runtime.record.id === accountId
        )?.capacity.releaseJob(jobId);
        return resolved;
      }),
      stopPollers: vi.fn()
    },
    capacity,
    recovery: {
      ready: true
    },
    media: {
      createRequestBudget: () => createTempBudget(
        config.maxRequestMediaBytes
      ),
      prepareStream: () => Promise.reject(
        new Error("Fixture media stream is not configured")
      ),
      fetchOutput: () => Promise.reject(
        new Error("Fixture output fetch is not configured")
      )
    },
    ...dependencyOverrides
  };
  const app = await buildApp(dependencies);
  return {
    app,
    dependencies,
    account,
    catalogCalls,
    catalogRefreshes,
    repository,
    accounts,
    admissions,
    runtimes,
    capturedPinoOutput: () => logOutput,
    close: async () => {
      await app.close();
      repository.close();
      store.close();
      removeTestDirectory(directory);
    }
  };
}

export function authorizedInject(
  app: FastifyInstance,
  options: InjectOptions
): Promise<LightMyRequestResponse> {
  return app.inject({
    ...options,
    headers: {
      ...options.headers,
      authorization: `Bearer ${API_KEY}`
    }
  });
}

export function fixtureHash(): string {
  return randomBytes(32).toString("hex");
}
