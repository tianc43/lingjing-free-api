import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { AppDependencies } from "./api/types.js";
import { parseConfig } from "./config.js";
import {
  LingjingGenerationCoordinator
} from "./generation/coordinator.js";
import { JobRunnerRegistry } from "./generation/runner-registry.js";
import { CapacityManager } from "./jobs/capacity.js";
import { DiscoveryLock } from "./jobs/discovery-lock.js";
import {
  removeOrphanTemporaryFiles,
  StartupRecovery
} from "./jobs/recovery.js";
import { SqliteJobRepository } from "./jobs/sqlite-repository.js";
import { AccountService } from "./lingjing/account.js";
import { LingjingClient } from "./lingjing/client.js";
import type { LingjingTransport } from "./lingjing/types.js";
import { createLogger } from "./logging.js";
import { prepareDataUri } from "./media/data-uri.js";
import { RemoteMediaFetcher } from "./media/remote-fetcher.js";
import { createTempBudget } from "./media/temp-budget.js";
import { createPreparedTempFileFromBuffer } from "./media/temp-files.js";
import type { MediaInput, PreparedMedia } from "./media/types.js";
import { CatalogService } from "./models/catalog.js";
import { createSessionProvider } from "./session/create-provider.js";

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

export interface RunningServer {
  app: FastifyInstance;
  dependencies: AppDependencies;
  repository: SqliteJobRepository;
  registry: JobRunnerRegistry;
  stop(): Promise<void>;
}

export interface StartServerOptions {
  transport?: LingjingTransport;
  registry?: JobRunnerRegistry;
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

  options.repository.close();
}

export async function startServer(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: StartServerOptions = {}
): Promise<RunningServer> {
  const processStart = Date.now();
  const config = parseConfig(env);
  const logger = createLogger(config.logLevel);
  const session = await createSessionProvider(config);
  await session.load();
  const transport = options.transport ?? new LingjingClient({ session });
  const account = new AccountService({
    read: transport.read.bind(transport),
    session,
    config
  });
  const catalog = new CatalogService(transport, config.modelCacheTtlMs);
  const repository = new SqliteJobRepository(config.dbPath);
  const capacity = new CapacityManager(
    config.maxConcurrency,
    config.maxQueuedRequests
  );
  const registry = options.registry ?? new JobRunnerRegistry();
  const discoveryLock = new DiscoveryLock();
  const tempDirectory = join(dirname(resolve(config.dbPath)), "tmp");
  let startupCleanup: (() => Promise<void>) | undefined;

  try {
    await mkdir(tempDirectory, { recursive: true });
    const globalTempBudget = createTempBudget(config.maxTempBytes);
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

    const coordinator = new LingjingGenerationCoordinator({
      repository,
      capacity,
      account,
      catalog,
      transport,
      prepareMedia,
      discoveryLock,
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
      coordinator.stopPollers();
      await withTimeout(
        registry.waitUntilIdle(),
        options.shutdown?.runnerIdleTimeoutMs ?? SHUTDOWN_RUNNER_WAIT_MS,
        "Timed out waiting for job runners"
      );
      repository.close();
    };

    // Recovery must have restored capacity and scheduled all durable work
    // before the first socket can accept traffic.
    await recovery.start();

    const dependencies: AppDependencies = {
      config,
      logger,
      session,
      transport,
      account,
      catalog,
      repository,
      coordinator,
      capacity,
      recovery
    };
    const app = await buildApp(dependencies);
    startupCleanup = () => shutdownServer({
      app,
      registry,
      coordinator,
      recovery,
      repository,
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
        ...options.shutdown
      }).catch((cause: unknown) => {
        stopPromise = undefined;
        throw cause;
      });
      return stopPromise;
    };

    return { app, dependencies, repository, registry, stop };
  } catch (cause) {
    try {
      if (startupCleanup === undefined) repository.close();
      else await startupCleanup();
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

interface SignalStopRuntime {
  stop(): Promise<void>;
  dependencies: {
    logger: Pick<AppDependencies["logger"], "error">;
  };
}

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
      runtime.dependencies.logger.error(
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
