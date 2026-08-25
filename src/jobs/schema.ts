import type Database from "better-sqlite3";

const CURRENT_SCHEMA_VERSION = 16;

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

const VERSION_THREE_SQL = `
  ALTER TABLE jobs ADD COLUMN quote_known INTEGER NOT NULL DEFAULT 1
  CHECK (quote_known IN (0, 1));
`;

const VERSION_FOUR_SQL = `
  UPDATE jobs
  SET quote_known = 0
  WHERE quoted_points = 0
    AND quote_known = 1
    AND created_at < (
      SELECT applied_at
      FROM schema_migrations
      WHERE version = 3
    );

  UPDATE budget_entries
  SET state = 'reserved'
  WHERE state = 'charged'
    AND EXISTS (
      SELECT 1 FROM jobs
      WHERE jobs.id = budget_entries.job_id
        AND jobs.status = 'queued'
    );

  UPDATE budget_entries
  SET state = 'released'
  WHERE state IN ('reserved', 'charged')
    AND EXISTS (
      SELECT 1 FROM jobs
      WHERE jobs.id = budget_entries.job_id
        AND jobs.status = 'failed'
        AND jobs.submitted_at IS NULL
    );

  UPDATE budget_entries
  SET state = 'charged'
  WHERE state = 'reserved'
    AND EXISTS (
      SELECT 1 FROM jobs
      WHERE jobs.id = budget_entries.job_id
        AND (
          jobs.status IN (
            'submitting',
            'discovering',
            'processing',
            'unknown',
            'completed'
          )
          OR (
            jobs.status = 'failed'
            AND jobs.submitted_at IS NOT NULL
          )
        )
    );
`;

const VERSION_FIVE_SQL = `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL UNIQUE,
    key_hash TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  ALTER TABLE accounts ADD COLUMN membership TEXT;
`;

const VERSION_SIX_SQL = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, name)
  );

  INSERT INTO users(id, name, status, created_at, updated_at)
  SELECT 'usr_legacy', 'Legacy operator', 'active', applied_at, applied_at
  FROM schema_migrations WHERE version = 5;

  INSERT INTO projects(id, user_id, name, status, created_at, updated_at)
  SELECT 'prj_legacy', 'usr_legacy', 'Legacy project', 'active', applied_at, applied_at
  FROM schema_migrations WHERE version = 5;

  ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users(id);
  ALTER TABLE api_keys ADD COLUMN project_id TEXT REFERENCES projects(id);
  ALTER TABLE api_keys ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '["models:read","video:create","video:read","image:create","image:read"]';
  ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;

  UPDATE api_keys SET user_id = 'usr_legacy', project_id = 'prj_legacy'
  WHERE user_id IS NULL OR project_id IS NULL;

  ALTER TABLE jobs ADD COLUMN user_id TEXT REFERENCES users(id);
  ALTER TABLE jobs ADD COLUMN project_id TEXT REFERENCES projects(id);
  ALTER TABLE jobs ADD COLUMN api_key_id TEXT REFERENCES api_keys(id);

  UPDATE jobs SET user_id = 'usr_legacy', project_id = 'prj_legacy'
  WHERE user_id IS NULL OR project_id IS NULL;

  CREATE INDEX jobs_project_created_at_idx
  ON jobs(project_id, created_at DESC);

  CREATE INDEX jobs_api_key_created_at_idx
  ON jobs(api_key_id, created_at DESC);
`;

const VERSION_SEVEN_SQL = `
  CREATE TABLE provider_submissions (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    request_fingerprint TEXT NOT NULL,
    upstream_fingerprint TEXT NOT NULL,
    catalog_revision TEXT NOT NULL,
    baseline_json TEXT NOT NULL,
    baseline_captured_at INTEGER NOT NULL,
    submit_started_at INTEGER,
    submit_finished_at INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN (
      'baseline_captured', 'submitting', 'submitted', 'rejected',
      'submission_ambiguous', 'correlated', 'correlation_ambiguous',
      'provider_status_unknown', 'provider_succeeded', 'provider_failed'
    )),
    ambiguity_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(job_id, attempt_number)
  );

  CREATE TABLE provider_correlations (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL UNIQUE REFERENCES provider_submissions(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    upstream_task_id TEXT,
    upstream_asset_id TEXT,
    creation_code TEXT,
    evidence_type TEXT NOT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN ('exact', 'strong', 'ambiguous')),
    conflict_reason TEXT,
    correlated_at INTEGER NOT NULL,
    UNIQUE(provider, account_id, upstream_task_id)
  );

  CREATE TABLE usage_ledger (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    api_key_id TEXT REFERENCES api_keys(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    entry_type TEXT NOT NULL CHECK (entry_type IN ('hold', 'charge', 'release', 'refund', 'adjustment')),
    points REAL NOT NULL CHECK (points >= 0),
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(job_id, entry_type, reason)
  );

  CREATE INDEX provider_submissions_outcome_updated_idx
  ON provider_submissions(outcome, updated_at);

  CREATE INDEX usage_ledger_project_created_idx
  ON usage_ledger(project_id, created_at DESC);
`;

const VERSION_EIGHT_SQL = `
  CREATE TABLE job_worker_leases (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    worker_id TEXT NOT NULL,
    lease_token TEXT NOT NULL UNIQUE,
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    lease_expires_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX job_worker_leases_expires_idx
  ON job_worker_leases(lease_expires_at);
`;

const VERSION_NINE_SQL = `
  ALTER TABLE jobs ADD COLUMN processing_deadline_at INTEGER;
  ALTER TABLE jobs ADD COLUMN reconcile_after INTEGER;
  ALTER TABLE jobs ADD COLUMN uncertainty_reason TEXT;
  ALTER TABLE jobs ADD COLUMN poll_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN last_polled_at INTEGER;

  CREATE INDEX jobs_reconcile_after_idx
  ON jobs(status, reconcile_after)
  WHERE reconcile_after IS NOT NULL;
`;

const VERSION_TEN_SQL = `
  CREATE TABLE job_assets (
    id TEXT PRIMARY KEY,
    job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    role TEXT NOT NULL CHECK (role IN ('input', 'output', 'poster')),
    storage_key TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    width INTEGER,
    height INTEGER,
    duration REAL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX job_assets_job_role_idx ON job_assets(job_id, role);
  CREATE INDEX job_assets_project_created_idx ON job_assets(project_id, created_at DESC);
`;

const VERSION_ELEVEN_SQL = `
  CREATE TABLE generation_request_snapshots (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    source_type TEXT NOT NULL,
    model TEXT NOT NULL,
    values_json TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    api_key_id TEXT REFERENCES api_keys(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const VERSION_TWELVE_SQL = `
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    allowed_modes_json TEXT NOT NULL,
    allowed_models_json TEXT NOT NULL,
    max_duration_seconds INTEGER NOT NULL CHECK (max_duration_seconds >= 0),
    allowed_resolutions_json TEXT NOT NULL,
    daily_limit_points REAL NOT NULL CHECK (daily_limit_points >= 0),
    monthly_limit_points REAL NOT NULL CHECK (monthly_limit_points >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO plans(id,name,enabled,allowed_modes_json,allowed_models_json,max_duration_seconds,allowed_resolutions_json,daily_limit_points,monthly_limit_points,created_at,updated_at)
  VALUES ('plan_legacy','Legacy unrestricted',1,'["text-to-video","image-to-video"]','[]',0,'[]',0,0,?,?);
  ALTER TABLE projects ADD COLUMN plan_id TEXT REFERENCES plans(id);
  UPDATE projects SET plan_id = 'plan_legacy' WHERE plan_id IS NULL;
`;

const VERSION_THIRTEEN_SQL = `
  ALTER TABLE plans ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 0 CHECK (max_concurrency >= 0);
  ALTER TABLE plans ADD COLUMN max_queued_requests INTEGER NOT NULL DEFAULT 0 CHECK (max_queued_requests >= 0);
`;

const VERSION_FOURTEEN_SQL = `
  CREATE TABLE webhook_endpoints (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
    url TEXT NOT NULL, secret TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE webhook_outbox (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), job_id TEXT NOT NULL REFERENCES jobs(id),
    event_type TEXT NOT NULL CHECK(event_type IN('video.completed','video.failed','video.unknown')),
    payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('pending','delivered','dead')),
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    last_error TEXT, delivered_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(job_id,event_type)
  );
  CREATE INDEX webhook_outbox_due_idx ON webhook_outbox(status,next_attempt_at);
`;

const VERSION_FIFTEEN_SQL = `
  ALTER TABLE jobs ADD COLUMN archive_status TEXT NOT NULL DEFAULT 'none' CHECK(archive_status IN('none','pending','complete','failed'));
  ALTER TABLE jobs ADD COLUMN archive_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN archive_retry_at INTEGER;
  ALTER TABLE jobs ADD COLUMN archive_error TEXT;
  CREATE INDEX jobs_archive_due_idx ON jobs(archive_status,archive_retry_at);
`;

const VERSION_SIXTEEN_SQL = `
  CREATE TABLE pending_uploads (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT NOT NULL REFERENCES projects(id),
    storage_key TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN('pending','completed')), expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE INDEX pending_uploads_expiry_idx ON pending_uploads(status,expires_at);
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
      version = 2;
    }
    if (version < 3) {
      database.exec(VERSION_THREE_SQL);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(3, Date.now());
      version = 3;
    }
    if (version < 4) {
      database.exec(VERSION_FOUR_SQL);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(4, Date.now());
      version = 4;
    }
    if (version < 5) {
      database.exec(VERSION_FIVE_SQL);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(5, Date.now());
      version = 5;
    }
    if (version < 6) {
      database.exec(VERSION_SIX_SQL);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(6, Date.now());
      version = 6;
    }
    if (version < 7) {
      database.exec(VERSION_SEVEN_SQL);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(7, Date.now());
      version = 7;
    }
    if (version < 8) {
      database.exec(VERSION_EIGHT_SQL);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(8, Date.now());
      version = 8;
    }
    if (version < 9) {
      database.exec(VERSION_NINE_SQL);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(9, Date.now());
      version = 9;
    }
    if (version < 10) {
      database.exec(VERSION_TEN_SQL);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(10, Date.now());
      version = 10;
    }
    if (version < 11) {
      database.exec(VERSION_ELEVEN_SQL);
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(11, Date.now());
      version = 11;
    }
    if (version < 12) {
      const now = Date.now();
      database.exec(VERSION_TWELVE_SQL.replaceAll("?", String(now)));
      database.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)"
      ).run(12, now);
      version = 12;
    }
    if (version < 13) {
      database.exec(VERSION_THIRTEEN_SQL);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(13, Date.now());
      version = 13;
    }
    if (version < 14) {
      database.exec(VERSION_FOURTEEN_SQL);
      database.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(14,Date.now());
      version=14;
    }
    if(version<15){database.exec(VERSION_FIFTEEN_SQL);database.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(15,Date.now());version=15;}if(version<16){database.exec(VERSION_SIXTEEN_SQL);database.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)").run(16,Date.now());}
  }).immediate();
}
