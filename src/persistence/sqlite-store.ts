import Database from "better-sqlite3";
import { configureJobDatabase, migrateJobDatabase } from "../jobs/schema.js";

interface WalCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

function retryableSqliteLock(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return false;
  }
  const code = (cause as Record<string, unknown>)["code"];
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function parseCheckpointResult(value: unknown): WalCheckpointResult | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const row = (value as unknown[])[0];
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  if (
    typeof record.busy !== "number"
    || typeof record.log !== "number"
    || typeof record.checkpointed !== "number"
  ) {
    return null;
  }
  return {
    busy: record.busy,
    log: record.log,
    checkpointed: record.checkpointed
  };
}

function checkpointWalForClose(database: Database.Database): void {
  const retryBuffer = new Int32Array(new SharedArrayBuffer(4));
  const attempts = 4;
  const retryDelayMs = 25;
  let lastResult: WalCheckpointResult | null = null;
  let lastCause: unknown;

  database.pragma(`busy_timeout = ${String(retryDelayMs)}`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = parseCheckpointResult(database.pragma("wal_checkpoint(TRUNCATE)"));
      if (result !== null && result.busy === 0 && result.log === result.checkpointed) {
        return;
      }
      lastResult = result;
    } catch (cause) {
      if (!retryableSqliteLock(cause)) {
        throw new Error("WAL checkpoint failed; repository was closed safely", { cause });
      }
      lastCause = cause;
    }
    if (attempt + 1 < attempts) {
      Atomics.wait(retryBuffer, 0, 0, retryDelayMs);
    }
  }

  const detail = lastResult === null
    ? "SQLite remained busy or returned an invalid result"
    : `busy=${String(lastResult.busy)}, log=${String(lastResult.log)}, checkpointed=${String(lastResult.checkpointed)}`;
  throw new Error(
    `WAL checkpoint incomplete after ${String(attempts)} bounded attempts (${detail}); repository was closed safely`,
    lastCause === undefined ? undefined : { cause: lastCause }
  );
}

export class SqliteStore {
  private database: Database.Database | null;

  constructor(path: string) {
    const database = new Database(path);
    this.database = database;
    try {
      configureJobDatabase(database);
      migrateJobDatabase(database);
    } catch (cause) {
      this.database = null;
      database.close();
      throw cause;
    }
  }

  read<T>(operation: (database: Database.Database) => T): T {
    return operation(this.openDatabase());
  }

  immediate<T>(operation: (database: Database.Database) => T): T {
    const database = this.openDatabase();
    return database.transaction(() => operation(database)).immediate();
  }

  close(): void {
    const database = this.database;
    if (database === null) return;
    this.database = null;
    try {
      checkpointWalForClose(database);
    } finally {
      database.close();
    }
  }

  private openDatabase(): Database.Database {
    if (this.database === null) {
      throw new Error("SQLite store is closed");
    }
    return this.database;
  }
}
