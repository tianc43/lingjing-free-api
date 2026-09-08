import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config.js";
import { AccountService, type AccountSnapshot } from "../lingjing/account.js";
import { LingjingClient } from "../lingjing/client.js";
import {
  atomicWritePrivateJsonPair,
  PrivateJsonPairRollbackError,
  replacePrivateJsonPair,
} from "../session/atomic-write.js";
import {
  parseCookieImport,
  type CookieImportInput,
} from "../session/cookie-import.js";
import { accountSessionPaths } from "../session/create-provider.js";
import type { SessionProvider } from "../session/types.js";
import type { AccountRuntimeRegistry } from "./runtime-registry.js";
import type { SqliteAccountRepository } from "./sqlite-account-repository.js";
import type {
  AccountObservation,
  AccountRecord,
  CreateAccountInput,
} from "./types.js";

type ImportConfig = Pick<
  AppConfig,
  | "dataDirectory"
  | "maxConcurrency"
  | "sessionMode"
  | "storageStatePath"
  | "sessionProfilePath"
>;

export interface ImportAccountInput {
  account: CreateAccountInput;
  cookies: CookieImportInput;
}

export interface CookieImportServiceOptions {
  accounts: Pick<
    SqliteAccountRepository,
    "create" | "findById" | "recordObservation" | "removeUnbound" | "update"
  >;
  config: ImportConfig;
  runtimes: Pick<AccountRuntimeRegistry, "refresh" | "retire">;
  describeAccount?: (session: SessionProvider) => Promise<AccountSnapshot>;
}

export class CookieImportRollbackError extends Error {
  readonly code = "cookie_import_rollback_incomplete";

  constructor() {
    super("Cookie import failed and rollback was incomplete");
    this.name = "CookieImportRollbackError";
  }
}

function observationFrom(snapshot: AccountSnapshot): AccountObservation {
  return {
    healthStatus: "ready",
    lastErrorCode: null,
    subjectHash: snapshot.subject,
    membership: snapshot.membership,
    pointsBalance: snapshot.pointsBalance,
    totalBalance: snapshot.totalBalance,
    maxConcurrency: snapshot.maxConcurrency,
  };
}

function observationFromRecord(account: AccountRecord): AccountObservation {
  return {
    healthStatus: account.healthStatus,
    lastErrorCode: account.lastErrorCode,
    subjectHash: account.subjectHash,
    membership: account.membership,
    pointsBalance: account.pointsBalance,
    totalBalance: account.totalBalance,
    maxConcurrency: account.maxConcurrency,
    ...(account.lastCheckedAt === null
      ? {}
      : { checkedAt: account.lastCheckedAt }),
  };
}

export class CookieImportService {
  constructor(private readonly options: CookieImportServiceOptions) {}

  async import(input: ImportAccountInput): Promise<AccountRecord> {
    if (this.options.config.sessionMode === "cookie-file") {
      throw new Error("Cookie imports require browser-state sessions");
    }
    const candidate = parseCookieImport(input.cookies);
    const snapshot = await this.describe(candidate.session);
    const account = this.options.accounts.create(input.account);
    try {
      const paths = accountSessionPaths(this.options.config, account.id);
      await atomicWritePrivateJsonPair([
        { targetPath: paths.storageStatePath, value: candidate.storageState },
        {
          targetPath: paths.sessionProfilePath,
          value: { originPin: candidate.originPin },
        },
      ]);
      this.options.accounts.recordObservation(
        account.id,
        observationFrom(snapshot),
      );
      this.options.accounts.update(account.id, { enabled: true });
      const runtime = await this.options.runtimes.refresh(account.id);
      if (runtime?.record.healthStatus !== "ready") {
        throw new Error("Imported account runtime is not ready");
      }
      const imported = this.options.accounts.findById(account.id);
      if (imported === null)
        throw new Error("Imported account could not be read");
      return imported;
    } catch (cause) {
      try {
        this.options.accounts.update(account.id, { enabled: false });
      } catch {
        throw new CookieImportRollbackError();
      }
      try {
        await this.removeNewSession(account.id);
      } catch {
        throw new CookieImportRollbackError();
      }
      try {
        this.options.accounts.removeUnbound(account.id);
      } catch {
        throw new CookieImportRollbackError();
      }
      throw cause;
    }
  }

  async replace(
    accountId: string,
    cookies: CookieImportInput,
  ): Promise<AccountRecord> {
    if (this.options.config.sessionMode === "cookie-file") {
      throw new Error("Cookie imports require browser-state sessions");
    }
    const account = this.options.accounts.findById(accountId);
    if (account === null) throw new Error("Account not found");
    const candidate = parseCookieImport(cookies);
    const snapshot = await this.describe(candidate.session);
    const paths =
      accountId === "legacy"
        ? {
            storageStatePath: this.options.config.storageStatePath,
            sessionProfilePath: this.options.config.sessionProfilePath,
          }
        : accountSessionPaths(this.options.config, accountId);
    await this.options.runtimes.retire(accountId);
    try {
      return await replacePrivateJsonPair(
        [
          { targetPath: paths.storageStatePath, value: candidate.storageState },
          {
            targetPath: paths.sessionProfilePath,
            value: { originPin: candidate.originPin },
          },
        ],
        async () => {
          this.options.accounts.recordObservation(
            accountId,
            observationFrom(snapshot),
          );
          const runtime = await this.options.runtimes.refresh(accountId);
          if (runtime?.record.healthStatus !== "ready") {
            throw new Error("Updated account runtime is not ready");
          }
          const updated = this.options.accounts.findById(accountId);
          if (updated === null)
            throw new Error("Updated account could not be read");
          return updated;
        },
        async () => {
          const restored = this.options.accounts.recordObservation(
            accountId,
            observationFromRecord(account),
          );
          const runtime = await this.options.runtimes.refresh(accountId);
          if (
            account.healthStatus === "ready" &&
            runtime?.record.healthStatus !== "ready"
          ) {
            throw new Error("Previous account runtime could not be restored");
          }
          if (runtime !== null) runtime.record = restored;
        },
      );
    } catch (cause) {
      if (cause instanceof PrivateJsonPairRollbackError) {
        throw new CookieImportRollbackError();
      }
      throw cause;
    }
  }

  private async describe(session: SessionProvider): Promise<AccountSnapshot> {
    if (this.options.describeAccount !== undefined) {
      return await this.options.describeAccount(session);
    }
    const transport = new LingjingClient({ session });
    const account = new AccountService({
      read: transport.read.bind(transport),
      session,
      config: this.options.config,
    });
    return await account.describe();
  }

  private async removeNewSession(accountId: string): Promise<void> {
    const paths = accountSessionPaths(this.options.config, accountId);
    const directory = dirname(paths.storageStatePath);
    const accountsDirectory = join(
      this.options.config.dataDirectory,
      "accounts",
    );
    if (dirname(directory) !== accountsDirectory) {
      throw new Error("Invalid generated account session directory");
    }
    await rm(directory, { recursive: true, force: true });
  }
}
