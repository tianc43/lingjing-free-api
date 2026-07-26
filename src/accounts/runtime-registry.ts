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
    membership: null,
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
    membership: null,
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
  private readonly refreshTails = new Map<string, Promise<void>>();
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly options: AccountRuntimeRegistryOptions) {}

  ready(): Promise<void> {
    this.readyPromise ??= this.loadAll();
    return this.readyPromise;
  }

  listEnabled(): AccountRuntime[] {
    return [...this.runtimes.values()].filter(
      (runtime) =>
        runtime.record.enabled
        && runtime.record.healthStatus === "ready"
    );
  }

  listRetained(): AccountRuntime[] {
    return [...this.runtimes.values()];
  }

  find(accountId: string): AccountRuntime | null {
    return this.runtimes.get(accountId) ?? null;
  }

  require(accountId: string): AccountRuntime {
    const runtime = this.find(accountId);
    if (runtime === null) throw new Error("Account runtime is unavailable");
    return runtime;
  }

  refresh(accountId: string): Promise<AccountRuntime | null> {
    const previous = this.refreshTails.get(accountId)
      ?? Promise.resolve();
    const result = previous.then(() => this.refreshNow(accountId));
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.refreshTails.set(accountId, tail);
    void tail.then(() => {
      if (this.refreshTails.get(accountId) === tail) {
        this.refreshTails.delete(accountId);
      }
    });
    return result;
  }

  private async refreshNow(
    accountId: string
  ): Promise<AccountRuntime | null> {
    const record = this.options.accounts.findById(accountId);
    if (record === null) {
      this.runtimes.delete(accountId);
      return null;
    }
    return await this.createRuntime(record);
  }

  close(): Promise<void> {
    this.runtimes.clear();
    return Promise.resolve();
  }

  private async loadAll(): Promise<void> {
    const records = this.options.accounts.list();
    for (const record of records) {
      await this.createRuntime(record);
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
      membership: snapshot.membership,
      pointsBalance: snapshot.pointsBalance,
      totalBalance: snapshot.totalBalance,
      maxConcurrency: snapshot.maxConcurrency
    });
    const published = this.runtimes.get(record.id);
    const runtime: AccountRuntime = {
      record: observed,
      session,
      transport,
      account,
      catalog: new CatalogService(transport, this.options.config.modelCacheTtlMs),
      capacity: published?.capacity ?? new CapacityManager(
        snapshot.maxConcurrency,
        this.options.config.maxQueuedRequests
      ),
      discoveryLock: published?.discoveryLock ?? new DiscoveryLock()
    };
    this.runtimes.set(record.id, runtime);
    return runtime;
  }

  private recordFailure(
    record: AccountRecord,
    observation: ReturnType<typeof observationForUnavailableSession>
      | ReturnType<typeof observationForUnhealthyRuntime>
  ): AccountRuntime | null {
    const observed = this.options.accounts.recordObservation(
      record.id,
      observation
    );
    const existing = this.runtimes.get(record.id);
    if (existing === undefined) return null;
    existing.record = observed;
    return existing;
  }
}
