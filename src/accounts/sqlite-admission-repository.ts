import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { errors } from "../errors.js";
import type { JobRecord, JobStatus } from "../jobs/types.js";
import { allowedTransitions } from "../jobs/sqlite-repository.js";
import type { SqliteStore } from "../persistence/sqlite-store.js";
import { budgetWindows } from "./budget.js";
import type { AdmissionInput, AdmissionResult } from "./types.js";

export type BudgetState = "reserved" | "charged" | "released";

export interface BudgetUsageBreakdown {
  dayChargedPoints: number;
  monthChargedPoints: number;
  dayReservedPoints: number;
  monthReservedPoints: number;
}

interface JobRow {
  id: string;
  user_id: string;
  project_id: string;
  api_key_id: string | null;
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
  quote_known: 0 | 1;
  status: JobStatus;
  creation_code: string | null;
  upstream_task_id: string | null;
  upstream_fingerprint: string | null;
  submitted_at: number | null;
  discovered_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  unknown_hold_until: number | null;
  processing_deadline_at: number | null;
  reconcile_after: number | null;
  uncertainty_reason: string | null;
  poll_attempts: number;
  last_polled_at: number | null;
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
  id, user_id, project_id, api_key_id, kind, source_type, model, api_id,
  model_code, expected_asset_scene,
  request_fingerprint, idempotency_key_hash, space_id, account_id, quoted_points,
  quote_known,
  status, creation_code, upstream_task_id, upstream_fingerprint, submitted_at,
  discovered_at, completed_at, failed_at, unknown_hold_until,
  processing_deadline_at, reconcile_after, uncertainty_reason, poll_attempts,
  last_polled_at, error_code, result_json, created_at, updated_at
`;

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const JOB_ID = /^job_[0-9a-f]{32}$/u;

function assertSha256(value: string, name: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hex digest`);
  }
}

function parseResult(value: string | null): JobRecord["result"] {
  return value === null ? null : JSON.parse(value) as JobRecord["result"];
}

function appendLedger(
  database: Database.Database,
  job: JobRow,
  type: "hold" | "charge" | "release" | "refund" | "adjustment",
  reason: string,
  now: number
): void {
  database.prepare(`
    INSERT INTO usage_ledger (
      id, job_id, user_id, project_id, api_key_id, account_id,
      entry_type, points, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, entry_type, reason) DO NOTHING
  `).run(
    `led_${randomBytes(16).toString("hex")}`,
    job.id,
    job.user_id,
    job.project_id,
    job.api_key_id,
    job.account_id,
    type,
    job.quote_known === 1 ? job.quoted_points : 0,
    reason,
    now
  );
}

function jobFromRow(row: JobRow): JobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    apiKeyId: row.api_key_id,
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
    quotedPoints: row.quote_known === 1 ? row.quoted_points : null,
    status: row.status,
    creationCode: row.creation_code,
    upstreamTaskId: row.upstream_task_id,
    upstreamFingerprint: row.upstream_fingerprint,
    submittedAt: row.submitted_at,
    discoveredAt: row.discovered_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    unknownHoldUntil: row.unknown_hold_until,
    processingDeadlineAt: row.processing_deadline_at,
    reconcileAfter: row.reconcile_after,
    uncertaintyReason: row.uncertainty_reason,
    pollAttempts: row.poll_attempts,
    lastPolledAt: row.last_polled_at,
    errorCode: row.error_code,
    result: parseResult(row.result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function assertAdmissionInput(input: AdmissionInput, canonicalWindows: AdmissionInput["windows"]): void {
  if (input.jobId !== undefined && !JOB_ID.test(input.jobId)) {
    throw new TypeError("jobId must be a generated job ID");
  }
  assertSha256(input.requestFingerprint, "requestFingerprint");
  if (input.idempotencyKeyHash !== null) {
    assertSha256(input.idempotencyKeyHash, "idempotencyKeyHash");
  }
  if (typeof input.accountId !== "string" || input.accountId === "") {
    throw new TypeError("accountId must be a non-empty string");
  }
  if (
    input.quotedPoints !== null
    && (
      typeof input.quotedPoints !== "number"
      || !Number.isFinite(input.quotedPoints)
      || input.quotedPoints < 0
    )
  ) {
    throw new RangeError("quotedPoints must be null or a non-negative finite number");
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

  findByIdempotencyKeyHash(idempotencyKeyHash: string): JobRecord | null {
    assertSha256(idempotencyKeyHash, "idempotencyKeyHash");
    return this.store.read((database) => {
      const row = database.prepare(`
        SELECT ${JOB_SELECT_COLUMNS}
        FROM jobs
        WHERE idempotency_key_hash = ?
      `).get(idempotencyKeyHash) as JobRow | undefined;
      return row === undefined ? null : jobFromRow(row);
    });
  }

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

      const projectPlan = database.prepare(`
        SELECT pl.daily_limit_points, pl.monthly_limit_points, pl.max_concurrency, pl.max_queued_requests
        FROM projects p JOIN users u ON u.id=p.user_id
        JOIN plans pl ON pl.id=p.plan_id
        WHERE p.id=? AND p.user_id=? AND p.status='active' AND u.status='active' AND pl.enabled=1
      `).get(input.projectId ?? "prj_legacy", input.userId ?? "usr_legacy") as {
        daily_limit_points:number; monthly_limit_points:number; max_concurrency:number; max_queued_requests:number;
      } | undefined;
      if (projectPlan === undefined) return { outcome: "project_quota_exhausted" };
      const projectCounts = database.prepare(`
        SELECT
          SUM(CASE WHEN status IN ('submitting','discovering','processing') OR (status='unknown' AND unknown_hold_until IS NOT NULL AND unknown_hold_until>?) THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued
        FROM jobs WHERE project_id=?
      `).get(Date.now(),input.projectId ?? "prj_legacy") as {active:number|null;queued:number|null};
      if (
        (projectPlan.max_concurrency!==0 && (projectCounts.active??0)>=projectPlan.max_concurrency)
        || (projectPlan.max_queued_requests!==0 && (projectCounts.queued??0)>=projectPlan.max_queued_requests)
      ) return { outcome:"project_capacity_exhausted" };
      const projectUsage = database.prepare(`
        SELECT COALESCE(SUM(be.quoted_points),0) AS used
        FROM budget_entries be JOIN jobs j ON j.id=be.job_id
        WHERE j.project_id=? AND be.state IN ('reserved','charged')
          AND ((?='day' AND be.day_window_start=?) OR (?='month' AND be.month_window_start=?))
      `);
      const projectId = input.projectId ?? "prj_legacy";
      const dayUsed = (projectUsage.get(projectId,"day",windows.dayWindowStart,"day",windows.dayWindowStart) as {used:number}).used;
      const monthUsed = (projectUsage.get(projectId,"month",windows.monthWindowStart,"month",windows.monthWindowStart) as {used:number}).used;
      if (input.quotedPoints === null && (projectPlan.daily_limit_points!==0 || projectPlan.monthly_limit_points!==0)) return { outcome:"project_quota_exhausted" };
      if (input.quotedPoints !== null && (
        (projectPlan.daily_limit_points!==0 && dayUsed+input.quotedPoints>projectPlan.daily_limit_points)
        || (projectPlan.monthly_limit_points!==0 && monthUsed+input.quotedPoints>projectPlan.monthly_limit_points)
      )) return { outcome: "project_quota_exhausted" };

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
      if (input.quotedPoints === null) {
        if (
          account.daily_point_limit !== 0
          || account.monthly_point_limit !== 0
        ) {
          return { outcome: "budget_exhausted" };
        }
      } else if (
        (account.daily_point_limit !== 0 && usage.day_used_points + input.quotedPoints > account.daily_point_limit)
        || (account.monthly_point_limit !== 0 && usage.month_used_points + input.quotedPoints > account.monthly_point_limit)
      ) {
        return { outcome: "budget_exhausted" };
      }

      const id = input.jobId ?? `job_${randomBytes(16).toString("hex")}`;
      const now = Date.now();
      const storedQuotedPoints = input.quotedPoints ?? 0;
      const quoteKnown = input.quotedPoints === null ? 0 : 1;
      database.prepare(`
        INSERT INTO jobs (
          id, user_id, project_id, api_key_id, kind, source_type, model, api_id,
          model_code, expected_asset_scene, request_fingerprint,
          idempotency_key_hash, space_id, account_id, quoted_points,
          quote_known, status, created_at, updated_at
        ) VALUES (
          @id, @userId, @projectId, @apiKeyId, @kind, @sourceType, @model,
          @apiId, @modelCode, @expectedAssetScene, @requestFingerprint,
          @idempotencyKeyHash, @spaceId, @accountId, @storedQuotedPoints,
          @quoteKnown, 'queued', @now, @now
        )
      `).run({
        id,
        ...input,
        userId: input.userId ?? "usr_legacy",
        projectId: input.projectId ?? "prj_legacy",
        apiKeyId: input.apiKeyId ?? null,
        storedQuotedPoints,
        quoteKnown,
        now
      });
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
        storedQuotedPoints,
        windows.dayWindowStart,
        windows.monthWindowStart,
        now,
        now
      );
      const admitted = this.findJob(database, id);
      if (admitted === undefined) throw new Error("Admitted job could not be read");
      appendLedger(database, admitted, "hold", "quoted_generation_cost", now);
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
      const job = this.findJob(database, jobId);
      if (job === undefined) throw new Error(`Job ${jobId} does not exist`);
      const changed = database.prepare(`
        UPDATE budget_entries
        SET state = 'charged', updated_at = ?
        WHERE job_id = ? AND state = 'reserved'
      `).run(Date.now(), jobId).changes;
      if (changed !== 0) {
        appendLedger(database, job, "charge", "upstream_submit_may_have_occurred", Date.now());
        return;
      }
      const current = database.prepare("SELECT state FROM budget_entries WHERE job_id = ?").get(jobId) as {
        state: "reserved" | "charged" | "released";
      } | undefined;
      if (current === undefined) throw new Error(`Budget entry for job ${jobId} does not exist`);
      if (current.state === "released") throw new Error(`Budget entry for job ${jobId} is released`);
      appendLedger(database, job, "charge", "upstream_submit_may_have_occurred", Date.now());
    });
  }

  budgetState(jobId: string): BudgetState | null {
    return this.store.read((database) => {
      const row = database.prepare(
        "SELECT state FROM budget_entries WHERE job_id = ?"
      ).get(jobId) as { state: BudgetState } | undefined;
      return row?.state ?? null;
    });
  }

  usageBreakdown(
    accountId: string,
    windows: { dayWindowStart: number; monthWindowStart: number }
  ): BudgetUsageBreakdown {
    return this.store.read((database) => {
      const row = database.prepare(`
        SELECT
          COALESCE(SUM(CASE
            WHEN day_window_start = @dayWindowStart AND state = 'charged'
            THEN quoted_points ELSE 0 END), 0) AS day_charged_points,
          COALESCE(SUM(CASE
            WHEN month_window_start = @monthWindowStart AND state = 'charged'
            THEN quoted_points ELSE 0 END), 0) AS month_charged_points,
          COALESCE(SUM(CASE
            WHEN day_window_start = @dayWindowStart AND state = 'reserved'
            THEN quoted_points ELSE 0 END), 0) AS day_reserved_points,
          COALESCE(SUM(CASE
            WHEN month_window_start = @monthWindowStart AND state = 'reserved'
            THEN quoted_points ELSE 0 END), 0) AS month_reserved_points
        FROM budget_entries
        WHERE account_id = @accountId
      `).get({ accountId, ...windows }) as {
        day_charged_points: number;
        month_charged_points: number;
        day_reserved_points: number;
        month_reserved_points: number;
      };
      return {
        dayChargedPoints: row.day_charged_points,
        monthChargedPoints: row.month_charged_points,
        dayReservedPoints: row.day_reserved_points,
        monthReservedPoints: row.month_reserved_points
      };
    });
  }

  resolveUnknown(
    accountId: string,
    jobId: string,
    action: "charge" | "release"
  ): { state: BudgetState; job: JobRecord } {
    return this.store.immediate((database) => {
      const current = this.findJob(database, jobId);
      if (
        current === undefined
        || current.account_id !== accountId
        || current.status !== "unknown"
      ) {
        throw new Error("Unknown job resolution conflict");
      }
      const budget = database.prepare(
        "SELECT state FROM budget_entries WHERE job_id = ? AND account_id = ?"
      ).get(jobId, accountId) as { state: BudgetState } | undefined;
      if (
        budget === undefined
        || (budget.state !== "reserved" && budget.state !== "charged")
      ) {
        throw new Error("Unknown job resolution conflict");
      }
      const state: BudgetState = action === "charge" ? "charged" : "released";
      const now = Date.now();
      database.prepare(`
        UPDATE budget_entries
        SET state = ?, updated_at = ?
        WHERE job_id = ? AND account_id = ?
      `).run(state, now, jobId, accountId);
      appendLedger(
        database,
        current,
        action === "charge" ? "charge" : "release",
        `admin_resolved_unknown_${action}`,
        now
      );
      database.prepare(`
        UPDATE jobs
        SET status = 'failed',
            failed_at = ?,
            unknown_hold_until = NULL,
            error_code = 'admin_resolved_unknown',
            updated_at = ?
        WHERE id = ?
      `).run(now, now, jobId);
      database.prepare(`
        INSERT INTO job_status_history(job_id, status, created_at)
        VALUES (?, 'failed', ?)
      `).run(jobId, now);
      const resolved = this.findJob(database, jobId);
      if (resolved === undefined) throw new Error("Resolved job could not be read");
      return { state, job: jobFromRow(resolved) };
    });
  }

  releasePreSubmit(jobId: string): void {
    this.store.immediate((database) => {
      const job = this.findJob(database, jobId);
      if (job === undefined) throw new Error(`Job ${jobId} does not exist`);
      const changed = database.prepare(`
        UPDATE budget_entries
        SET state = 'released', updated_at = ?
        WHERE job_id = ? AND state = 'reserved'
      `).run(Date.now(), jobId).changes;
      if (changed !== 0) {
        appendLedger(database, job, "release", "pre_submit_release", Date.now());
        return;
      }
      const current = database.prepare("SELECT state FROM budget_entries WHERE job_id = ?").get(jobId) as {
        state: "reserved" | "charged" | "released";
      } | undefined;
      if (current === undefined) throw new Error(`Budget entry for job ${jobId} does not exist`);
    });
  }

  failAndRelease(
    jobId: string,
    expectedStatuses: readonly JobStatus[],
    errorCode: string
  ): JobRecord {
    return this.store.immediate((database) => {
      const current = this.findJob(database, jobId);
      if (current === undefined) throw new Error(`Job ${jobId} does not exist`);
      if (!expectedStatuses.includes(current.status)) {
        throw new Error(
          `Job ${jobId} is ${current.status}; expected ${expectedStatuses.join(", ")}`
        );
      }
      if (!allowedTransitions[current.status].includes("failed")) {
        throw new Error(`Illegal job transition from ${current.status} to failed`);
      }

      const now = Date.now();
      database.prepare(`
        UPDATE jobs
        SET status = 'failed',
            failed_at = ?,
            unknown_hold_until = NULL,
            error_code = ?,
            updated_at = ?
        WHERE id = ?
      `).run(now, errorCode, now, jobId);
      database.prepare(`
        INSERT INTO job_status_history(job_id, status, created_at)
        VALUES (?, 'failed', ?)
      `).run(jobId, now);
      const released = database.prepare(`
        UPDATE budget_entries
        SET state = 'released', updated_at = ?
        WHERE job_id = ? AND state = 'reserved'
      `).run(now, jobId).changes;
      if (released !== 0) {
        appendLedger(database, current, "release", errorCode, now);
      }
      if (released === 0) {
        const budget = database.prepare(
          "SELECT state FROM budget_entries WHERE job_id = ?"
        ).get(jobId) as {
          state: "reserved" | "charged" | "released";
        } | undefined;
        if (budget === undefined) {
          throw new Error(`Budget entry for job ${jobId} does not exist`);
        }
        if (budget.state === "charged") {
          throw new Error(`Budget entry for job ${jobId} is charged`);
        }
      }
      const failed = this.findJob(database, jobId);
      if (failed === undefined) throw new Error("Failed job could not be read");
      return jobFromRow(failed);
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
