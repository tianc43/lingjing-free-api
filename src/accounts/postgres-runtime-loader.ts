import { AccountService } from "../lingjing/account.js";
import { LingjingClient } from "../lingjing/client.js";
import { DiscoveryLock } from "../jobs/discovery-lock.js";
import { CapacityManager } from "../jobs/capacity.js";
import { CatalogService } from "../models/catalog.js";
import { createSessionProvider } from "../session/create-provider.js";
import type { AppConfig } from "../config.js";
import type {
  PostgresAccount,
  PostgresAccountRepository,
} from "./postgres-account-repository.js";
import type { AccountRuntime } from "./runtime.js";

export class PostgresRuntimeLoader {
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readonly retiredCoordination = new Map<
    string,
    Pick<AccountRuntime, "capacity" | "discoveryLock">
  >();

  constructor(
    private readonly accounts: PostgresAccountRepository,
    private readonly config: AppConfig,
  ) {}

  async refresh(accountId: string): Promise<AccountRuntime | null> {
    const account = (await this.accounts.list()).find(
      (item) => item.id === accountId,
    );
    if (account === undefined) {
      this.runtimes.delete(accountId);
      this.retiredCoordination.delete(accountId);
      return null;
    }
    return await this.loadOne(account);
  }

  async retire(accountId: string): Promise<void> {
    const runtime = this.runtimes.get(accountId);
    if (runtime !== undefined) {
      this.retiredCoordination.set(accountId, {
        capacity: runtime.capacity,
        discoveryLock: runtime.discoveryLock,
      });
    }
    await runtime?.session.retire?.();
    this.runtimes.delete(accountId);
  }

  async load(): Promise<this> {
    for (const account of await this.accounts.list()) {
      if (account.enabled) await this.loadOne(account);
    }
    return this;
  }

  private async loadOne(
    account: PostgresAccount,
  ): Promise<AccountRuntime | null> {
    try {
      const session = await createSessionProvider(
        this.config,
        account.id === "legacy" ? undefined : account.id,
      );
      await session.load();
      await session.loadProfile();
      const transport = new LingjingClient({ session });
      const service = new AccountService({
        read: transport.read.bind(transport),
        session,
        config: this.config,
      });
      const snapshot = await service.describe();
      const observed = await this.accounts.recordObservation(account.id, {
        healthStatus: "ready",
        lastErrorCode: null,
        membership: snapshot.membership,
        pointsBalance: snapshot.pointsBalance,
        totalBalance: snapshot.totalBalance,
        maxConcurrency: snapshot.maxConcurrency,
      });
      const existing = this.runtimes.get(account.id);
      const retired = this.retiredCoordination.get(account.id);
      const record = {
        id: account.id,
        name: account.name,
        enabled: account.enabled,
        priority: account.priority,
        dailyPointLimit: account.dailyPointLimit,
        monthlyPointLimit: account.monthlyPointLimit,
        authDirectory:
          account.id === "legacy" ? "data/auth" : `data/accounts/${account.id}`,
        healthStatus: "ready" as const,
        lastErrorCode: null,
        subjectHash: snapshot.subject,
        membership: snapshot.membership,
        pointsBalance: snapshot.pointsBalance,
        totalBalance: snapshot.totalBalance,
        maxConcurrency: snapshot.maxConcurrency,
        lastCheckedAt: Date.now(),
        lastSelectedAt: null,
        createdAt: account.updatedAt,
        updatedAt: observed.updatedAt,
      };
      const runtime: AccountRuntime = {
        record,
        session,
        transport,
        account: service,
        catalog: new CatalogService(transport, this.config.modelCacheTtlMs),
        capacity:
          existing?.capacity ??
          retired?.capacity ??
          new CapacityManager(
            snapshot.maxConcurrency,
            this.config.maxQueuedRequests,
          ),
        discoveryLock:
          existing?.discoveryLock ??
          retired?.discoveryLock ??
          new DiscoveryLock(),
      };
      this.runtimes.set(account.id, runtime);
      this.retiredCoordination.delete(account.id);
      return runtime;
    } catch {
      return null;
    }
  }

  listEnabled(): AccountRuntime[] {
    return [...this.runtimes.values()].filter(
      (runtime) => runtime.record.enabled,
    );
  }

  close(): Promise<void> {
    this.runtimes.clear();
    this.retiredCoordination.clear();
    return Promise.resolve();
  }
}
