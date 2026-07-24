import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { errors } from "../errors.js";
import type { JobRecord, JobStatus } from "../jobs/types.js";
import type { SqliteStore } from "../persistence/sqlite-store.js";
import { budgetWindows } from "./budget.js";
import type { AdmissionInput, AdmissionResult } from "./types.js";

interface JobRow {
  id: string;
  kind: "image" | "video";
  source_type: JobRecord["sourceType"];
  model: string;
  api_id: string;
  model_code: string | null;
  expected_asset_scene: string;
  request_fingerprint: string;
  idempotency_key_hash: string | null;
  space_id: number;
  account_id: string;
  quoted_points: number;
  status: JobStatus;
  creation_code: string | null;
  upstream_task_id: string | null;
  upstream_fingerprint: string | null;
  submitted_at: number | null;
  discovered_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  unknown_hold_until: number | null;
  error_code: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

interface AccountBudgetRow {
  enabled: number;
  health_status: string;
  daily_point_limit: number;
  monthly_point_limit: number;
}

const JOB_SELECT_COLUMNS = `
  id, kind, source_type, model, api_id, model_code, expected_asset_scene,
  request_fingerprint, idempotency_key_hash, space_id, account_id, quoted_points,
  status, creation_code, upstream_task_id, upstream_fingerprint, submitted_at,
  discovered_at, completed_at, failed_at, unknown_hold_until, error_code,
  result_json, created_at, updated_at
`;

const SHA256_HEX = /^[0-9a-f]{64}$/u;

function assertSha256(value: string, name: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hex digest`);
  }
}

function parseResult(value: string | null): JobRecord["result"] {
  return value === null ? null : JSON.parse(value) as JobRecord["result"];
}

function jobFromRow(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    sourceType: row.source_type,
    model: row.model,
    apiId: row.api_id,
    modelCode: row.model_code,
    expectedAssetScene: row.expected_asset_scene,
    requestFingerprint: row.request_fingerprint,
    idempotencyKeyHash: row.idempotency_key_hash,
    spaceId: row.space_id,
    accountId: row.account_id,
    quotedPoints: row.quoted_points,
    status: row.status,
    creationCode: row.creation_code,
    upstreamTaskId: row.upstream_task_id,
    upstreamFingerprint: row.upstream_fingerprint,
    submittedAt: row.submitted_at,
    discoveredAt: row.discovered_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    unknownHoldUntil: row.unknown_hold_until,
    errorCode: row.error_code,
    result: parseResult(row.result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function assertAdmissionInput(input: AdmissionInput, canonicalWindows: AdmissionInput["windows"]): void {
  assertSha256(input.requestFingerprint, "requestFingerprint");
  if (input.idempotencyKeyHash !== null) {
    assertSha256(input.idempotencyKeyHash, "idempotencyKeyHash");
  }
  if (typeof input.accountId !== "string" || input.accountId === "") {
    throw new TypeError("accountId must be a non-empty string");
  }
  if (typeof input.quotedPoints !== "number" || !Number.isFinite(input.quotedPoints) || input.quotedPoints < 0) {
    throw new RangeError("quotedPoints must be a non-negative finite number");
  }
  if (!Number.isFinite(input.windows.dayWindowStart) || !Number.isFinite(input.windows.monthWindowStart)) {
    throw new TypeError("Budget windows must be finite");
  }
  if (
    input.windows.dayWindowStart !== canonicalWindows.dayWindowStart
    || input.windows.monthWindowStart !== canonicalWindows.monthWindowStart
  ) {
    throw new RangeError("Budget windows must match canonical Asia/Shanghai windows");
  }
}

export class SqliteAdmissionRepository {
  constructor(
    private readonly store: SqliteStore,
    private readonly now: () => number = Date.now
  ) {}

  reserveOrGet(input: AdmissionInput): AdmissionResult {
    const windows = budgetWindows(this.now());
    assertAdmissionInput(input, windows);
    return this.store.immediate((database) => {
      const existing = this.findExisting(database, input);
      if (existing !== undefined) return { outcome: "existing", job: jobFromRow(existing) };

      const account = database.prepare(`
        SELECT enabled, health_status, daily_point_limit, monthly_point_limit
        FROM accounts
        WHERE id = ?
      `).get(input.accountId) as AccountBudgetRow | undefined;
      if (account === undefined || account.enabled !== 1 || account.health_status !== "ready") {
        return { outcome: "account_unavailable" };
      }

      const usage = database.prepare(`
        SELECT
          COALESCE(SUM(CASE
            WHEN day_window_start = @dayWindowStart AND state IN ('reserved', 'charged')
            THEN quoted_points ELSE 0 END), 0) AS day_used_points,
          COALESCE(SUM(CASE
            WHEN month_window_start = @monthWindowStart AND state IN ('reserved', 'charged')
            THEN quoted_points ELSE 0 END), 0) AS month_used_points
        FROM budget_entries
        WHERE account_id = @accountId
      `).get({ accountId: input.accountId, ...windows }) as {
        day_used_points: number;
        month_used_points: number;
      };
      if (
        (account.daily_point_limit !== 0 && usage.day_used_points + input.quotedPoints > account.daily_point_limit)
        || (account.monthly_point_limit !== 0 && usage.month_used_points + input.quotedPoints > account.monthly_point_limit)
      ) {
        return { outcome: "budget_exhausted" };
      }

      const id = `job_${randomBytes(16).toString("hex")}`;
      const now = Date.now();
      database.prepare(`
        INSERT INTO jobs (
          id, kind, source_type, model, api_id, model_code, expected_asset_scene,
          request_fingerprint, idempotency_key_hash, space_id, account_id,
          quoted_points, status, created_at, updated_at
        ) VALUES (
          @id, @kind, @sourceType, @model, @apiId, @modelCode, @expectedAssetScene,
          @requestFingerprint, @idempotencyKeyHash, @spaceId, @accountId,
          @quotedPoints, 'queued', @now, @now
        )
      `).run({ id, ...input, now });
      database.prepare(`
        INSERT INTO job_status_history(job_id, status, created_at)
        VALUES (?, 'queued', ?)
      `).run(id, now);
      database.prepare(`
        INSERT INTO budget_entries (
          account_id, job_id, quoted_points, state, day_window_start,
          month_window_start, created_at, updated_at
        ) VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?)
      `).run(
        input.accountId,
        id,
        input.quotedPoints,
        windows.dayWindowStart,
        windows.monthWindowStart,
        now,
        now
      );
      database.prepare(`
        UPDATE accounts SET last_selected_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, input.accountId);
      const inserted = this.findJob(database, id);
      if (inserted === undefined) throw new Error("Admitted job could not be read");
      return { outcome: "created", job: jobFromRow(inserted) };
    });
  }

  charge(jobId: string): void {
    this.store.immediate((database) => {
      const changed = database.prepare(`
        UPDATE budget_entries
        SET state = 'charged', updated_at = ?
        WHERE job_id = ? AND state = 'reserved'
      `).run(Date.now(), jobId).changes;
      if (changed !== 0) return;
      const current = database.prepare("SELECT state FROM budget_entries WHERE job_id = ?").get(jobId) as {
        state: "reserved" | "charged" | "released";
      } | undefined;
      if (current === undefined) throw new Error(`Budget entry for job ${jobId} does not exist`);
      if (current.state === "released") throw new Error(`Budget entry for job ${jobId} is released`);
    });
  }

  releasePreSubmit(jobId: string): void {
    this.store.immediate((database) => {
      const changed = database.prepare(`
        UPDATE budget_entries
        SET state = 'released', updated_at = ?
        WHERE job_id = ? AND state = 'reserved'
      `).run(Date.now(), jobId).changes;
      if (changed !== 0) return;
      const current = database.prepare("SELECT state FROM budget_entries WHERE job_id = ?").get(jobId) as {
        state: "reserved" | "charged" | "released";
      } | undefined;
      if (current === undefined) throw new Error(`Budget entry for job ${jobId} does not exist`);
    });
  }

  private findExisting(database: Database.Database, input: AdmissionInput): JobRow | undefined {
    if (input.idempotencyKeyHash === null) return undefined;
    const existing = database.prepare(`
      SELECT ${JOB_SELECT_COLUMNS}
      FROM jobs
      WHERE idempotency_key_hash = ?
    `).get(input.idempotencyKeyHash) as JobRow | undefined;
    if (existing !== undefined && existing.request_fingerprint !== input.requestFingerprint) {
      throw errors.idempotencyConflict();
    }
    return existing;
  }

  private findJob(database: Database.Database, id: string): JobRow | undefined {
    return database.prepare(`
      SELECT ${JOB_SELECT_COLUMNS}
      FROM jobs
      WHERE id = ?
    `).get(id) as JobRow | undefined;
  }
}
