import type Database from "better-sqlite3";

const CURRENT_SCHEMA_VERSION = 1;

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

export function configureJobDatabase(database: Database.Database): void {
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 10000");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
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
    if (current.version === CURRENT_SCHEMA_VERSION) return;

    database.exec(VERSION_ONE_SQL);
    database.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
    ).run(CURRENT_SCHEMA_VERSION, Date.now());
  }).immediate();
}
