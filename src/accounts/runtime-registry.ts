import type { AppConfig } from "../config.js";
import { AccountService } from "../lingjing/account.js";
import { LingjingClient } from "../lingjing/client.js";
import type { LingjingTransport } from "../lingjing/types.js";
import { CapacityManager } from "../jobs/capacity.js";
import { DiscoveryLock } from "../jobs/discovery-lock.js";
import { CatalogService } from "../models/catalog.js";
import { createSessionProvider } from "../session/create-provider.js";
import type { SessionProvider } from "../session/types.js";
import { SqliteAccountRepository } from "./sqlite-account-repository.js";
import type { AccountRecord } from "./types.js";
import type { AccountRuntime } from "./runtime.js";

type RuntimeConfig = Pick<AppConfig,
  "sessionMode" | "storageStatePath" | "cookieFilePath" | "sessionProfilePath" |
  "dataDirectory" | "maxConcurrency" | "maxQueuedRequests" | "modelCacheTtlMs">;

export interface AccountRuntimeRegistryOptions {
  accounts: Pick<SqliteAccountRepository, "list" | "findById" | "recordObservation">;
  config: RuntimeConfig;
  sessionFactory?: (config: RuntimeConfig, accountId?: string) => Promise<SessionProvider>;
  transportFactory?: (session: SessionProvider) => LingjingTransport;
}

function observationForUnavailableSession() {
  return {
    healthStatus: "needs_login" as const,
    lastErrorCode: "lingjing_session_missing",
    subjectHash: null,
    pointsBalance: null,
    totalBalance: null,
    maxConcurrency: null
  };
}

function observationForUnhealthyRuntime() {
  return {
    healthStatus: "unhealthy" as const,
    lastErrorCode: "lingjing_runtime_unhealthy",
    subjectHash: null,
    pointsBalance: null,
    totalBalance: null,
    maxConcurrency: null
  };
}

function invalidSession(cause: unknown): boolean {
  if (cause instanceof SyntaxError) return true;
  if (!(cause instanceof Error)) return false;
  return cause.message === "Lingjing login required: run npm run login"
    || cause.message === "Invalid Playwright storage-state file"
    || cause.message === "Invalid Lingjing session profile";
}

export class AccountRuntimeRegistry {
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly options: AccountRuntimeRegistryOptions) {}

  ready(): Promise<void> {
    this.readyPromise ??= this.loadEnabled();
    return this.readyPromise;
  }

  listEnabled(): AccountRuntime[] {
    return [...this.runtimes.values()];
  }

  require(accountId: string): AccountRuntime {
    const runtime = this.runtimes.get(accountId);
    if (runtime === undefined) throw new Error("Account runtime is unavailable");
    return runtime;
  }

  async refresh(accountId: string): Promise<AccountRuntime | null> {
    const record = this.options.accounts.findById(accountId);
    if (record === null || !record.enabled) {
      this.runtimes.delete(accountId);
      return null;
    }
    return await this.createRuntime(record);
  }

  close(): Promise<void> {
    this.runtimes.clear();
    return Promise.resolve();
  }

  private async loadEnabled(): Promise<void> {
    const records = this.options.accounts.list();
    for (const record of records) {
      if (record.enabled) await this.createRuntime(record);
    }
  }

  private async createRuntime(record: AccountRecord): Promise<AccountRuntime | null> {
    const sessionFactory = this.options.sessionFactory ?? createSessionProvider;
    let session: SessionProvider;
    try {
      session = await sessionFactory(this.options.config, record.id === "legacy" ? undefined : record.id);
      await session.load();
      await session.loadProfile();
    } catch (cause) {
      return this.recordFailure(
        record,
        invalidSession(cause)
          ? observationForUnavailableSession()
          : observationForUnhealthyRuntime()
      );
    }

    let transport: LingjingTransport;
    let account: AccountService;
    let snapshot: Awaited<ReturnType<AccountService["describe"]>>;
    try {
      transport = (this.options.transportFactory ?? ((item) => new LingjingClient({ session: item })))(session);
      account = new AccountService({
        read: transport.read.bind(transport),
        session,
        config: this.options.config
      });
      snapshot = await account.describe();
    } catch {
      return this.recordFailure(record, observationForUnhealthyRuntime());
    }

    const observed = this.options.accounts.recordObservation(record.id, {
      healthStatus: "ready",
      lastErrorCode: null,
      subjectHash: snapshot.subject,
      pointsBalance: snapshot.pointsBalance,
      totalBalance: snapshot.totalBalance,
      maxConcurrency: snapshot.maxConcurrency
    });
    const runtime: AccountRuntime = {
      record: observed,
      session,
      transport,
      account,
      catalog: new CatalogService(transport, this.options.config.modelCacheTtlMs),
      capacity: new CapacityManager(snapshot.maxConcurrency, this.options.config.maxQueuedRequests),
      discoveryLock: new DiscoveryLock()
    };
    this.runtimes.set(record.id, runtime);
    return runtime;
  }

  private recordFailure(
    record: AccountRecord,
    observation: ReturnType<typeof observationForUnavailableSession>
      | ReturnType<typeof observationForUnhealthyRuntime>
  ): null {
    this.runtimes.delete(record.id);
    this.options.accounts.recordObservation(record.id, observation);
    return null;
  }
}
