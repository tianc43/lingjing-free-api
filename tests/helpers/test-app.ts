import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { vi } from "vitest";
import { buildApp, type AppDependencies } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import { CapacityManager } from "../../src/jobs/capacity.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import type { AccountSnapshot } from "../../src/lingjing/account.js";
import type { NormalizedModel, SourceType } from "../../src/models/types.js";
import { createLogger } from "../../src/logging.js";
import { createTempBudget } from "../../src/media/temp-budget.js";

const API_KEY = "downstream-secret";

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
  docsEnabled: true
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
  capturedPinoOutput(): string;
  close(): Promise<void>;
}

export async function createTestApp(
  overrides: Partial<AppDependencies> = {}
): Promise<TestApp> {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-api-test-"));
  const repository = new SqliteJobRepository(join(directory, "jobs.sqlite"));
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
  const dependencies: AppDependencies = {
    config,
    logger: createLogger("info", destination),
    session: {
      mode: "browser-state",
      load: vi.fn(),
      loadProfile: vi.fn(() => Promise.resolve({
        originPin: "private-pin"
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
    coordinator: {
      create: vi.fn(),
      resume: vi.fn(),
      stopPollers: vi.fn()
    },
    capacity: new CapacityManager(5, 20),
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
    ...overrides
  };
  const app = await buildApp(dependencies);
  return {
    app,
    dependencies,
    account,
    catalogCalls,
    catalogRefreshes,
    repository,
    capturedPinoOutput: () => logOutput,
    close: async () => {
      await app.close();
      repository.close();
      rmSync(directory, { recursive: true, force: true });
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
