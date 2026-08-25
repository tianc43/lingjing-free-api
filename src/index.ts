import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import type { FastifyInstance } from "fastify";
import { AccountScheduler } from "./accounts/scheduler.js";
import { CookieImportService } from "./accounts/cookie-import-service.js";
import { AccountRuntimeRegistry } from "./accounts/runtime-registry.js";
import type { AccountRuntime } from "./accounts/runtime.js";
import { SqliteAccountRepository } from "./accounts/sqlite-account-repository.js";
import { SqliteAdmissionRepository } from "./accounts/sqlite-admission-repository.js";
import { buildApp } from "./app.js";
import { SqliteApiKeyRepository } from "./api-keys/sqlite-api-key-repository.js";
import type { AppDependencies } from "./api/types.js";
import { createRequestMediaBudget } from "./api/multipart.js";
import { parseConfig } from "./config.js";
import { errors } from "./errors.js";
import {
  LingjingGenerationCoordinator
} from "./generation/coordinator.js";
import { SqliteExecutionRepository } from "./generation/execution-repository.js";
import { SqliteRequestSnapshotRepository } from "./generation/request-snapshot-repository.js";
import { JobRunnerRegistry } from "./generation/runner-registry.js";
import { CapacityManager } from "./jobs/capacity.js";
import { SqliteIdentityRepository } from "./identity/sqlite-identity-repository.js";
import {
  removeOrphanTemporaryFiles,
  StartupRecovery
} from "./jobs/recovery.js";
import { ArchiveRecoveryWorker } from "./jobs/archive-recovery-worker.js";
import { MaintenanceScheduler } from "./jobs/maintenance-scheduler.js";
import { ReconciliationWorker } from "./jobs/reconciliation-worker.js";
import { SqliteJobRepository } from "./jobs/sqlite-repository.js";
import { SqliteWorkerLeaseRepository } from "./jobs/worker-lease-repository.js";
import type { LingjingTransport } from "./lingjing/types.js";
import { createLogger } from "./logging.js";
import { prepareDataUri } from "./media/data-uri.js";
import { RemoteMediaFetcher } from "./media/remote-fetcher.js";
import { createTempBudget } from "./media/temp-budget.js";
import { createPreparedTempFileFromBuffer } from "./media/temp-files.js";
import { UploadRepository } from "./media/upload-repository.js";
import { OutputArchiver } from "./media/output-archiver.js";
import { SqliteAssetRepository } from "./media/asset-repository.js";
import { LocalObjectStore } from "./media/object-store.js";
import { S3ObjectStore } from "./media/s3-object-store.js";
import { S3Client } from "@aws-sdk/client-s3";
import { createPreparedTempFileFromStream } from "./media/temp-files.js";
import type { MediaInput, PreparedMedia } from "./media/types.js";
import { SqliteStore } from "./persistence/sqlite-store.js";
import { startPostgresEntrypoint } from "./persistence/postgres-entrypoint.js";
import { SqliteUsageRepository } from "./usage/sqlite-usage-repository.js";
import { SqliteWebhookRepository } from "./webhooks/sqlite-webhook-repository.js";
import { WebhookDeliveryWorker } from "./webhooks/delivery-worker.js";
import { SqlitePlanRepository } from "./plans/sqlite-plan-repository.js";

const SHUTDOWN_DRAIN_MS = 30_000;
const SHUTDOWN_RUNNER_WAIT_MS = 30_000;

function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string
): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return Promise.reject(new RangeError(
      "Shutdown timeout must be a non-negative number"
    ));
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, milliseconds);
    timer.unref();
    void operation.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

function maxMediaBytes(
  input: MediaInput,
  config: Pick<AppDependencies["config"], "maxImageBytes" | "maxVideoBytes">
): number {
  return input.kind === "image"
    ? config.maxImageBytes
    : config.maxVideoBytes;
}

function assertBufferMedia(
  input: Extract<MediaInput["source"], { type: "buffer" }>,
  kind: MediaInput["kind"],
  maxBytes: number
): void {
  if (
    !input.contentType.toLowerCase().startsWith(`${kind}/`)
    || input.data.byteLength > maxBytes
  ) {
    throw new Error("Invalid prepared media buffer");
  }
}

function lazyService<T extends object>(service: () => T): T {
  return new Proxy({} as T, {
    get: (_target, property) => {
      const current = service();
      const value: unknown = Reflect.get(current, property, current);
      if (typeof value !== "function") return value;
      const bound: unknown = value.bind(current);
      return bound;
    }
  });
}

interface RunningServerBase { app: FastifyInstance; stop(): Promise<void>; }
export interface SqliteRunningServer extends RunningServerBase { driver:"sqlite"; dependencies:AppDependencies; repository:SqliteJobRepository; registry:JobRunnerRegistry; }
export interface PostgresRunningServer extends RunningServerBase { driver:"postgres"; runtime:Awaited<ReturnType<typeof startPostgresEntrypoint>>; }
export type RunningServer=SqliteRunningServer|PostgresRunningServer;

export interface StartServerOptions {
  transport?: LingjingTransport;
  registry?: JobRunnerRegistry;
  postgresRuntimes?: import("./lingjing/postgres-account-transport-resolver.js").RuntimeLookup;
  shutdown?: {
    submitDrainTimeoutMs?: number;
    runnerIdleTimeoutMs?: number;
  };
}

export interface ShutdownServerOptions {
  app: {
    close(): Promise<unknown>;
    server: {
      closeAllConnections(): void;
    };
  };
  registry: Pick<
    JobRunnerRegistry,
    "stopAccepting" | "drainSubmitCriticalSections" | "waitUntilIdle"
  >;
  coordinator: Pick<LingjingGenerationCoordinator, "stopPollers">;
  recovery: Pick<StartupRecovery, "close">;
  repository: Pick<SqliteJobRepository, "close">;
  runtimes?: Pick<AccountRuntimeRegistry, "close">;
  store?: Pick<SqliteStore, "close">;
  maintenance?: Pick<MaintenanceScheduler, "close">;
  submitDrainTimeoutMs?: number;
  runnerIdleTimeoutMs?: number;
}

export async function shutdownServer(
  options: ShutdownServerOptions
): Promise<void> {
  options.registry.stopAccepting();
  const httpClose = options.app.close();
  // The drain phase can fail before we await HTTP close. Attach a handler
  // immediately so a concurrent close failure never becomes unhandled.
  void httpClose.catch(() => undefined);

  await options.registry.drainSubmitCriticalSections(
    options.submitDrainTimeoutMs ?? SHUTDOWN_DRAIN_MS
  );
  options.recovery.close();
  await options.maintenance?.close();
  options.coordinator.stopPollers();
  options.app.server.closeAllConnections();

  const results = await withTimeout(
    Promise.allSettled([
      httpClose,
      options.registry.waitUntilIdle()
    ]),
    options.runnerIdleTimeoutMs ?? SHUTDOWN_RUNNER_WAIT_MS,
    "Timed out waiting for job runners"
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected"
  );
  if (failure !== undefined) throw failure.reason;

  await options.runtimes?.close();
  options.repository.close();
  options.store?.close();
}

export function startServer(env:{DATABASE_DRIVER:"postgres"}&Record<string,string|undefined>,options:StartServerOptions):Promise<PostgresRunningServer>;
export function startServer(env?:NodeJS.ProcessEnv|Record<string,string|undefined>,options?:StartServerOptions):Promise<SqliteRunningServer>;
export async function startServer(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: StartServerOptions = {}
): Promise<RunningServer> {
  const processStart = Date.now();
  const config = parseConfig(env);
  const logger = createLogger(config.logLevel);
  if(config.databaseDriver==="postgres"){
    if(options.transport===undefined)throw new Error("PostgreSQL runtime currently requires an explicit Lingjing transport");
    const runtime=await startPostgresEntrypoint(config,options.transport,options.postgresRuntimes);
    return {driver:"postgres",app:runtime.app,runtime,stop:()=>runtime.close()};
  }
  const store = new SqliteStore(config.dbPath);
  const accounts = new SqliteAccountRepository(store);
  const identities = new SqliteIdentityRepository(store);
  const usage = new SqliteUsageRepository(store);
  const plans = new SqlitePlanRepository(store);
  const webhooks = new SqliteWebhookRepository(store);
  const apiKeys = new SqliteApiKeyRepository(store);
  accounts.ensureLegacyAccount("data/auth");
  const repository = new SqliteJobRepository(store);
  const admissions = new SqliteAdmissionRepository(store);
  const executions = new SqliteExecutionRepository(store);
  const snapshots = new SqliteRequestSnapshotRepository(store);
  const objectStore=config.objectStore.mode==="local"
    ? new LocalObjectStore(join(config.dataDirectory,"objects"))
    : new S3ObjectStore(new S3Client({region:config.objectStore.region,...(config.objectStore.endpoint===null?{}:{endpoint:config.objectStore.endpoint}),forcePathStyle:config.objectStore.forcePathStyle}),config.objectStore.bucket,config.objectStore.prefix);
  const assets = new SqliteAssetRepository(store,objectStore);
  const uploads=new UploadRepository(store,objectStore,assets);
  const workerLeases = new SqliteWorkerLeaseRepository(store);
  const capacity = new CapacityManager(
    config.maxConcurrency,
    config.maxQueuedRequests
  );
  const registry = options.registry ?? new JobRunnerRegistry();
  const runtimes = new AccountRuntimeRegistry({
    accounts,
    config,
    ...(options.transport === undefined
      ? {}
      : { transportFactory: () => options.transport as LingjingTransport })
  });
  const cookieImporter = new CookieImportService({
    accounts,
    config,
    runtimes
  });
  const tempDirectory = join(dirname(resolve(config.dbPath)), "tmp");
  let startupCleanup: (() => Promise<void>) | undefined;
  let maintenance: MaintenanceScheduler | undefined;

  try {
    await runtimes.ready();
    const scheduler = new AccountScheduler({
      registry: runtimes,
      accounts,
      admissions,
      capacity
    });
    await mkdir(tempDirectory, { recursive: true });
    const globalTempBudget = createTempBudget(config.maxTempBytes);
    const media = {
      createRequestBudget: () => createRequestMediaBudget(
        config.maxRequestMediaBytes
      ),
      prepareStream: (
        stream: NodeJS.ReadableStream,
        options: {
          filename: string;
          contentType: string;
          maxBytes: number;
          requestBudget: ReturnType<typeof createTempBudget>;
        }
      ) => createPreparedTempFileFromStream(stream, {
        ...options,
        tempDirectory,
        tempBudget: globalTempBudget
      }),
      fetchOutput: (
        url: URL,
        options: { kind: "image"; maxBytes: number }
      ) => new RemoteMediaFetcher({
        tempDirectory,
        tempBudget: globalTempBudget,
        requestBudget: createTempBudget(config.maxRequestMediaBytes)
      }).fetch(url, options)
    };
    const prepareMedia = async (input: MediaInput): Promise<PreparedMedia> => {
      if (input.source.type === "prepared") return input.source.media;
      const maxBytes = maxMediaBytes(input, config);
      const requestBudget = createTempBudget(config.maxRequestMediaBytes);
      if (input.source.type === "buffer") {
        assertBufferMedia(input.source, input.kind, maxBytes);
        return createPreparedTempFileFromBuffer(input.source.data, {
          filename: input.source.filename,
          contentType: input.source.contentType,
          tempDirectory,
          tempBudget: globalTempBudget,
          requestBudget
        });
      }
      if (input.source.type === "data-uri") {
        return prepareDataUri(input.source.value, {
          kind: input.kind,
          maxBytes,
          tempDirectory,
          tempBudget: globalTempBudget,
          requestBudget
        });
      }
      let url: URL;
      try {
        url = new URL(input.source.value);
      } catch {
        throw new Error("Invalid remote media URL");
      }
      return new RemoteMediaFetcher({
        tempDirectory,
        tempBudget: globalTempBudget,
        requestBudget
      }).fetch(url, {
        kind: input.kind,
        maxBytes
      });
    };

    const outputArchiver=new OutputArchiver(assets,(url,archiveOptions)=>media.fetchOutput(url,archiveOptions),config.maxVideoBytes,config.outputRetentionMs);
    const coordinator = new LingjingGenerationCoordinator({
      repository,
      capacity,
      scheduler,
      admissions,
      executions,
      outputArchiver,
      snapshots,
      assets,
      maxPersistedInputBytes: config.maxImageBytes,
      workerLeases,
      logger,
      prepareMedia,
      registry,
      assetDiscoveryTimeoutMs: config.assetDiscoveryTimeoutMs,
      unknownCapacityHoldMs: config.unknownCapacityHoldMs,
      taskPollIntervalMs: config.taskPollIntervalMs
    });
    const recovery = new StartupRecovery({
      repository,
      capacity,
      registry,
      resumeJob: coordinator.recoveryResumeRunner,
      resumeQueuedJob: coordinator.queuedRecoveryRunner,
      scheduler,
      admissions,
      unknownCapacityHoldMs: config.unknownCapacityHoldMs,
      cleanupOrphans: () => removeOrphanTemporaryFiles(
        tempDirectory,
        processStart
      )
    });
    startupCleanup = async () => {
      registry.stopAccepting();
      await registry.drainSubmitCriticalSections(
        options.shutdown?.submitDrainTimeoutMs ?? SHUTDOWN_DRAIN_MS
      );
      recovery.close();
      await maintenance?.close();
      coordinator.stopPollers();
      await withTimeout(
        registry.waitUntilIdle(),
        options.shutdown?.runnerIdleTimeoutMs ?? SHUTDOWN_RUNNER_WAIT_MS,
        "Timed out waiting for job runners"
      );
      await runtimes.close();
      repository.close();
      store.close();
    };

    // Recovery must have restored capacity and scheduled all durable work
    // before the first socket can accept traffic.
    await recovery.start();
    const archiveRecovery=new ArchiveRecoveryWorker(repository,outputArchiver,workerLeases,`archive_${process.pid.toString(10)}`);
    const reconciler = new ReconciliationWorker({
      repository,
      executions,
      workerLeases,
      runtimes,
      workerId: `reconciler_${process.pid.toString(10)}`
    });
    maintenance = new MaintenanceScheduler({
      reconcile: async () => {
        await reconciler.scan();
        await archiveRecovery.scan();
        await new WebhookDeliveryWorker(webhooks).scan();
      },
      cleanupAssets: (olderThan) => assets.deleteUnbound(olderThan),
      cleanupExpiredAssets:(now)=>assets.deleteExpired(now),
      cleanupExpiredUploads:(now)=>uploads.cleanupExpired(now),
      intervalMs: 60_000,
      unboundAssetRetentionMs: 60 * 60_000
    });
    await maintenance.start();

    const compatibilityRuntime = (): AccountRuntime => {
      const runtime = runtimes.listEnabled()[0];
      if (runtime === undefined) throw errors.loginRequired();
      return runtime;
    };
    const dependencies: AppDependencies = {
      config,
      webhooks,
      plans,
      usage,
      identities,
      apiKeys,
      cookieImporter,
      logger,
      session: lazyService(() => compatibilityRuntime().session),
      transport: lazyService(() => compatibilityRuntime().transport),
      account: lazyService(() => compatibilityRuntime().account),
      catalog: lazyService(() => compatibilityRuntime().catalog),
      repository,
      accounts,
      admissions,
      runtimes,
      coordinator,
      capacity,
      recovery,
      objectStore,
      uploads,
      assets,
      media
    };
    const app = await buildApp(dependencies);
    startupCleanup = () => shutdownServer({
      app,
      registry,
      coordinator,
      recovery,
      repository,
      runtimes,
      store,
      ...(maintenance === undefined ? {} : { maintenance }),
      ...options.shutdown
    });
    await app.listen({ host: config.host, port: config.port });

    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopPromise ??= shutdownServer({
        app,
        registry,
        coordinator,
        recovery,
        repository,
        runtimes,
        store,
        ...(maintenance === undefined ? {} : { maintenance }),
        ...options.shutdown
      }).catch((cause: unknown) => {
        stopPromise = undefined;
        throw cause;
      });
      return stopPromise;
    };

    return { driver:"sqlite",app, dependencies, repository, registry, stop };
  } catch (cause) {
    try {
      if (startupCleanup === undefined) {
        await runtimes.close();
        repository.close();
        store.close();
      } else {
        await startupCleanup();
      }
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        "Server startup failed and cleanup did not complete"
      );
    }
    throw cause;
  }
}

function directInvocation(): boolean {
  const script = process.argv[1];
  return script !== undefined
    && pathToFileURL(resolve(script)).href === import.meta.url;
}

interface SignalStopRuntime {stop():Promise<void>;dependencies?:{logger:Pick<AppDependencies["logger"],"error">};}

interface ExitCodeTarget {
  exitCode?: string | number | undefined;
}

export function createSignalStopHandler(
  runtime: SignalStopRuntime,
  target: ExitCodeTarget = process
): () => void {
  let stopping = false;
  return (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.stop().catch((cause: unknown) => {
      runtime.dependencies?.logger.error(
        {
          error_code: cause instanceof Error
            ? "shutdown_failed"
            : "unknown_shutdown_failure"
        },
        "shutdown failed"
      );
      target.exitCode = 1;
      stopping = false;
    });
  };
}

async function main(): Promise<void> {
  loadEnv();
  const runtime = await startServer(process.env);
  const stop = createSignalStopHandler(runtime);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (directInvocation()) {
  void main().catch((cause: unknown) => {
    const logger = createLogger();
    logger.fatal(
      {
        error_code: cause instanceof Error
          ? "startup_failed"
          : "unknown_startup_failure"
      },
      "server startup failed"
    );
    process.exitCode = 1;
  });
}
