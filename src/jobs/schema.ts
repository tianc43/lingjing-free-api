import type Database from "better-sqlite3";

const CURRENT_SCHEMA_VERSION = 2;

const VERSION_ONE_SQL = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    source_type TEXT NOT NULL,
    model TEXT NOT NULL,
    api_id TEXT NOT NULL,
    model_code TEXT,
    expected_asset_scene TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    idempotency_key_hash TEXT,
    space_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN (
        'queued',
        'submitting',
        'discovering',
        'processing',
        'unknown',
        'completed',
        'failed'
      )
    ),
    creation_code TEXT,
    upstream_task_id TEXT,
    upstream_fingerprint TEXT,
    submitted_at INTEGER,
    discovered_at INTEGER,
    completed_at INTEGER,
    failed_at INTEGER,
    unknown_hold_until INTEGER,
    error_code TEXT,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE job_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (
      status IN (
        'queued',
        'submitting',
        'discovering',
        'processing',
        'unknown',
        'completed',
        'failed'
      )
    ),
    created_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX jobs_idempotency_key_hash_unique
  ON jobs(idempotency_key_hash)
  WHERE idempotency_key_hash IS NOT NULL;

  CREATE INDEX jobs_status_updated_at_idx
  ON jobs(status, updated_at);
`;

const VERSION_TWO_SQL = `
  ALTER TABLE jobs ADD COLUMN account_id TEXT;
  ALTER TABLE jobs ADD COLUMN quoted_points REAL NOT NULL DEFAULT 0;

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    priority INTEGER NOT NULL CHECK (priority >= 0),
    daily_point_limit REAL NOT NULL CHECK (daily_point_limit >= 0),
    monthly_point_limit REAL NOT NULL CHECK (monthly_point_limit >= 0),
    auth_directory TEXT NOT NULL UNIQUE,
    health_status TEXT NOT NULL CHECK (
      health_status IN ('unknown', 'ready', 'needs_login', 'unhealthy')
    ),
    last_error_code TEXT,
    subject_hash TEXT,
    points_balance REAL,
    total_balance REAL,
    max_concurrency INTEGER,
    last_checked_at INTEGER,
    last_selected_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE budget_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
    quoted_points REAL NOT NULL CHECK (quoted_points >= 0),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'charged', 'released')),
    day_window_start INTEGER NOT NULL,
    month_window_start INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX budget_entries_account_day_idx
  ON budget_entries(account_id, day_window_start, state);

  CREATE INDEX budget_entries_account_month_idx
  ON budget_entries(account_id, month_window_start, state);
`;

export function configureJobDatabase(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 10000");
  const retryBuffer = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = NORMAL");
      return;
    } catch (cause) {
      const code = typeof cause === "object" && cause !== null && "code" in cause
        ? (cause as { code?: unknown }).code
        : undefined;
      if (
        (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED")
        || Date.now() >= deadline
      ) {
        throw cause;
      }
      Atomics.wait(retryBuffer, 0, 0, 10);
    }
  }
  throw new Error("Timed out while enabling SQLite WAL mode");
}

export function migrateJobDatabase(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  database.transaction(() => {
    const current = database.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
    ).get() as { version: number };
    if (current.version > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Job database schema ${String(current.version)} is newer than supported version ${String(CURRENT_SCHEMA_VERSION)}`
      );
    }
    let version = current.version;
    if (version < 1) {
      database.exec(VERSION_ONE_SQL);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(1, Date.now());
      version = 1;
    }
    if (version < 2) {
      database.exec(VERSION_TWO_SQL);
      const now = Date.now();
      database.prepare(`
        INSERT INTO accounts (
          id, name, enabled, priority, daily_point_limit, monthly_point_limit,
          auth_directory, health_status, created_at, updated_at
        ) VALUES ('legacy', 'Legacy account', 1, 0, 0, 0, 'data/auth', 'unknown', ?, ?)
      `).run(now, now);
      database.prepare("UPDATE jobs SET account_id = 'legacy' WHERE account_id IS NULL").run();
      database.prepare(`
        INSERT INTO budget_entries (
          account_id, job_id, quoted_points, state, day_window_start,
          month_window_start, created_at, updated_at
        )
        SELECT account_id, id, 0, 'charged', 0, 0, created_at, updated_at
        FROM jobs
      `).run();
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(2, now);
    }
  }).immediate();
}
