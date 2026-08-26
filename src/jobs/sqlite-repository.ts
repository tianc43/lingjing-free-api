import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { budgetWindows } from "../accounts/budget.js";
import { errors } from "../errors.js";
import { SqliteStore } from "../persistence/sqlite-store.js";
import type {
  JobListFilter,
  JobOutput,
  JobRecord,
  JobFence,
  JobResult,
  JobStatus,
  JobTransition,
  NewJob,
  ReconciliationFilter
} from "./types.js";

export const allowedTransitions: Record<JobStatus, JobStatus[]> = {
  queued: ["submitting", "failed"],
  submitting: ["discovering", "unknown", "failed"],
  discovering: ["processing", "completed", "unknown", "failed"],
  processing: ["processing", "completed", "failed", "unknown"],
  unknown: ["unknown", "discovering", "processing", "completed", "failed"],
  completed: ["completed"],
  failed: []
};

interface JobRow {
  id: string;
  user_id: string;
  project_id: string;
  api_key_id: string | null;
  kind: "image" | "video";
  source_type: string;
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

const SELECT_COLUMNS = `
  id,
  user_id,
  project_id,
  api_key_id,
  kind,
  source_type,
  model,
  api_id,
  model_code,
  expected_asset_scene,
  request_fingerprint,
  idempotency_key_hash,
  space_id,
  account_id,
  quoted_points,
  quote_known,
  status,
  creation_code,
  upstream_task_id,
  upstream_fingerprint,
  submitted_at,
  discovered_at,
  completed_at,
  failed_at,
  unknown_hold_until,
  processing_deadline_at,
  reconcile_after,
  uncertainty_reason,
  poll_attempts,
  last_polled_at,
  error_code,
  result_json,
  created_at,
  updated_at
`;

const SHA256_HEX = /^[0-9a-f]{64}$/u;

function assertSha256(value: string, name: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hex digest`);
  }
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string or null`);
  }
  return value;
}

function nullableFiniteNumber(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number or null`);
  }
  return value;
}

function sanitizeOutput(value: unknown): JobOutput {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Job output must be an object");
  }
  const output = value as Record<string, unknown>;
  if (typeof output.url !== "string") {
    throw new TypeError("Job output url must be a string");
  }
  return {
    url: output.url,
    posterUrl: nullableString(output.posterUrl, "posterUrl"),
    width: nullableFiniteNumber(output.width, "width"),
    height: nullableFiniteNumber(output.height, "height"),
    duration: nullableFiniteNumber(output.duration, "duration"),
    format: nullableString(output.format, "format")
  };
}

function sanitizeResult(value: JobResult | null): JobResult | null {
  if (value === null) return null;
  if (!Array.isArray(value.outputs)) {
    throw new TypeError("Job result outputs must be an array");
  }
  return { outputs: value.outputs.map((output) => sanitizeOutput(output)) };
}

function parseResult(value: string | null): JobResult | null {
  if (value === null) return null;
  return sanitizeResult(JSON.parse(value) as JobResult);
}

function rowToJob(row: JobRow): JobRecord {
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

export class SqliteJobRepository {
  private readonly store: SqliteStore;
  private readonly ownsStore: boolean;
  private closed = false;

  constructor(pathOrStore: string | SqliteStore) {
    if (typeof pathOrStore === "string") {
      this.ownsStore = true;
      this.store = new SqliteStore(pathOrStore);
    } else {
      this.ownsStore = false;
      this.store = pathOrStore;
    }
  }

  createOrGet(input: NewJob): { created: boolean; job: JobRecord } {
    assertSha256(input.requestFingerprint, "requestFingerprint");
    if (input.idempotencyKeyHash !== null) {
      assertSha256(input.idempotencyKeyHash, "idempotencyKeyHash");
    }
    return this.immediate((database) => {
      if (input.idempotencyKeyHash !== null) {
        const existing = database.prepare(`
          SELECT ${SELECT_COLUMNS}
          FROM jobs
          WHERE idempotency_key_hash = ?
        `).get(input.idempotencyKeyHash) as JobRow | undefined;
        if (existing !== undefined) {
          if (existing.request_fingerprint !== input.requestFingerprint) {
            throw errors.idempotencyConflict();
          }
          return { created: false, job: rowToJob(existing) };
        }
      }

      const id = `job_${randomBytes(16).toString("hex")}`;
      const now = Date.now();
      database.prepare(`
        INSERT INTO jobs (
          id,
          user_id,
          project_id,
          api_key_id,
          kind,
          source_type,
          model,
          api_id,
          model_code,
          expected_asset_scene,
          request_fingerprint,
          idempotency_key_hash,
          space_id,
          account_id,
          quoted_points,
          quote_known,
          status,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @userId,
          @projectId,
          @apiKeyId,
          @kind,
          @sourceType,
          @model,
          @apiId,
          @modelCode,
          @expectedAssetScene,
          @requestFingerprint,
          @idempotencyKeyHash,
          @spaceId,
          'legacy',
          0,
          0,
          'queued',
          @now,
          @now
        )
      `).run({
        id,
        userId: input.userId ?? "usr_legacy",
        projectId: input.projectId ?? "prj_legacy",
        apiKeyId: input.apiKeyId ?? null,
        ...input,
        now
      });
      database.prepare(`
        INSERT INTO job_status_history(job_id, status, created_at)
        VALUES (?, 'queued', ?)
      `).run(id, now);
      const windows = budgetWindows(now);
      database.prepare(`
        INSERT INTO budget_entries (
          account_id, job_id, quoted_points, state, day_window_start,
          month_window_start, created_at, updated_at
        ) VALUES ('legacy', ?, 0, 'reserved', ?, ?, ?, ?)
      `).run(
        id,
        windows.dayWindowStart,
        windows.monthWindowStart,
        now,
        now
      );
      const inserted = this.findRow(database, id);
      if (inserted === undefined) {
        throw new Error("Inserted job could not be read");
      }
      return { created: true, job: rowToJob(inserted) };
    });
  }

  findById(id: string): JobRecord | null {
    return this.read((database) => {
      const row = this.findRow(database, id);
      return row === undefined ? null : rowToJob(row);
    });
  }

  list(filter: JobListFilter): JobRecord[] {
    if (!Number.isSafeInteger(filter.limit) || filter.limit < 1) {
      throw new RangeError("Job list limit must be a positive safe integer");
    }
    return this.read((database) => {
      if (filter.kind !== undefined || filter.before !== undefined) {
        const clauses = [
          ...(filter.projectId === undefined ? [] : ["project_id = @projectId"]),
          ...(filter.status === undefined ? [] : ["status = @status"]),
          ...(filter.kind === undefined ? [] : ["kind = @kind"]),
          ...(filter.before === undefined ? [] : ["created_at < @before"])
        ];
        const rows = database.prepare(`SELECT ${SELECT_COLUMNS} FROM jobs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC,rowid DESC LIMIT @limit`).all({
          projectId: filter.projectId ?? null, status: filter.status ?? null,
          kind: filter.kind ?? null, before: filter.before ?? null, limit: filter.limit
        }) as JobRow[];
        return rows.map(rowToJob);
      }
      const rows = filter.projectId === undefined
        ? filter.status === undefined
          ? database.prepare(`
            SELECT ${SELECT_COLUMNS} FROM jobs
            ORDER BY created_at ASC, rowid ASC LIMIT ?
            `).all(filter.limit) as JobRow[]
          : database.prepare(`
            SELECT ${SELECT_COLUMNS} FROM jobs WHERE status = ?
            ORDER BY created_at ASC, rowid ASC LIMIT ?
            `).all(filter.status, filter.limit) as JobRow[]
        : filter.status === undefined
          ? database.prepare(`
            SELECT ${SELECT_COLUMNS} FROM jobs WHERE project_id = ?
            ORDER BY created_at ASC, rowid ASC LIMIT ?
            `).all(filter.projectId, filter.limit) as JobRow[]
          : database.prepare(`
            SELECT ${SELECT_COLUMNS} FROM jobs WHERE project_id = ? AND status = ?
            ORDER BY created_at ASC, rowid ASC LIMIT ?
            `).all(filter.projectId, filter.status, filter.limit) as JobRow[];
      return rows.map((row) => rowToJob(row));
    });
  }

  reconciliationDue(filter: ReconciliationFilter): JobRecord[] {
    if (
      !Number.isFinite(filter.dueAt)
      || !Number.isSafeInteger(filter.limit)
      || filter.limit < 1
      || filter.limit > 1000
    ) {
      throw new RangeError("Invalid reconciliation filter");
    }
    return this.read((database) => (database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM jobs
      WHERE status = 'unknown'
        AND uncertainty_reason = 'provider_status_unknown'
        AND reconcile_after IS NOT NULL
        AND reconcile_after <= ?
        AND upstream_task_id IS NOT NULL
      ORDER BY reconcile_after ASC, created_at ASC
      LIMIT ?
    `).all(filter.dueAt, filter.limit) as JobRow[]).map(rowToJob));
  }

  archiveDue(now:number,limit:number):JobRecord[]{return this.read(db=>(db.prepare(`SELECT ${SELECT_COLUMNS} FROM jobs WHERE status='completed' AND ((archive_status='failed' AND archive_retry_at<=?) OR archive_status IN('none','pending')) ORDER BY archive_retry_at LIMIT ?`).all(now,limit) as JobRow[]).map(rowToJob));}
  replaceArchivedResult(id:string,result:JobResult,fence?:JobFence):void{this.immediate(db=>{if(fence!==undefined){const owned=db.prepare("SELECT 1 FROM job_worker_leases WHERE job_id=? AND worker_id=? AND lease_token=? AND fencing_token=? AND lease_expires_at>?").get(id,fence.workerId,fence.leaseToken,fence.fencingToken,fence.now);if(owned===undefined)throw new Error("Worker lease fencing conflict");}const now=Date.now(),safe=sanitizeResult(result);db.prepare("UPDATE jobs SET result_json=?,archive_status='complete',archive_error=NULL,archive_retry_at=NULL,updated_at=? WHERE id=? AND status='completed'").run(JSON.stringify(safe),now,id);const job=this.findRow(db,id);if(job?.kind==="video"&&safe?.outputs.every(output=>output.url.startsWith("/v1/assets/"))){const endpoint=db.prepare("SELECT 1 FROM webhook_endpoints WHERE project_id=? AND enabled=1").get(job.project_id);if(endpoint!==undefined)db.prepare(`INSERT INTO webhook_outbox(id,project_id,job_id,event_type,payload_json,status,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'video.completed',?,'pending',?,?,?) ON CONFLICT(job_id,event_type) DO NOTHING`).run(`evt_${randomBytes(16).toString("hex")}`,job.project_id,id,JSON.stringify({id,status:"completed",outputs:safe.outputs}),now,now,now);}});}
  markArchiveFailure(id:string,error:string,fence?:JobFence):void{this.immediate(db=>{if(fence!==undefined){const owned=db.prepare("SELECT 1 FROM job_worker_leases WHERE job_id=? AND worker_id=? AND lease_token=? AND fencing_token=? AND lease_expires_at>?").get(id,fence.workerId,fence.leaseToken,fence.fencingToken,fence.now);if(owned===undefined)throw new Error("Worker lease fencing conflict");}const row=db.prepare("SELECT archive_attempts FROM jobs WHERE id=?").get(id) as{archive_attempts:number}|undefined;if(!row)return;const attempts=row.archive_attempts+1;db.prepare("UPDATE jobs SET archive_status='failed',archive_attempts=?,archive_retry_at=?,archive_error=?,updated_at=? WHERE id=?").run(attempts,Date.now()+Math.min(3600000,1000*2**Math.min(attempts,10)),error.slice(0,500),Date.now(),id);});}

  cancelQueued(id: string, projectId: string): JobRecord | null {
    return this.immediate((database) => {
      const row = this.findRow(database,id);
      if (!row || row.project_id!==projectId || row.kind!=="video") return null;
      if (row.status!=="queued") throw new Error("Only queued jobs can be cancelled");
      const now=Date.now();
      database.prepare("UPDATE jobs SET status='failed',failed_at=?,error_code='cancelled_before_submit',updated_at=? WHERE id=?").run(now,now,id);
      database.prepare("INSERT INTO job_status_history(job_id,status,created_at) VALUES(?,'failed',?)").run(id,now);
      const released=database.prepare("UPDATE budget_entries SET state='released',updated_at=? WHERE job_id=? AND state='reserved'").run(now,id).changes;
      if(released===1){database.prepare(`INSERT INTO usage_ledger(id,job_id,user_id,project_id,api_key_id,account_id,entry_type,points,reason,created_at) VALUES(?,?,?,?,?,?,'release',?,'cancelled_before_submit',?) ON CONFLICT(job_id,entry_type,reason) DO NOTHING`).run(`led_${randomBytes(16).toString("hex")}`,id,row.user_id,row.project_id,row.api_key_id,row.account_id,row.quote_known===1?row.quoted_points:0,now);}
      const cancelled=this.findRow(database,id);return cancelled?rowToJob(cancelled):null;
    });
  }

  transition(
    id: string,
    expectedStatuses: readonly JobStatus[],
    transition: JobTransition,
    fence?: JobFence
  ): JobRecord {
    if (transition.upstreamFingerprint !== undefined && transition.upstreamFingerprint !== null) {
      assertSha256(transition.upstreamFingerprint, "upstreamFingerprint");
    }
    if (
      transition.status === "unknown"
      && (
        transition.unknownHoldUntil === undefined
        || transition.unknownHoldUntil === null
        || !Number.isFinite(transition.unknownHoldUntil)
      )
    ) {
      throw new TypeError("Unknown jobs require a finite hold deadline");
    }
    return this.immediate((database) => {
      if (fence !== undefined) {
        const owned = database.prepare(`
          SELECT 1 AS owned FROM job_worker_leases
          WHERE job_id = ? AND worker_id = ? AND lease_token = ?
            AND fencing_token = ? AND lease_expires_at > ?
        `).get(
          id,
          fence.workerId,
          fence.leaseToken,
          fence.fencingToken,
          fence.now
        ) as { owned: 1 } | undefined;
        if (owned === undefined) throw new Error("Worker lease fencing conflict");
      }
      const currentRow = this.findRow(database, id);
      if (currentRow === undefined) {
        throw new Error(`Job ${id} does not exist`);
      }
      if (!expectedStatuses.includes(currentRow.status)) {
        throw new Error(
          `Job ${id} is ${currentRow.status}; expected ${expectedStatuses.join(", ")}`
        );
      }
      if (!allowedTransitions[currentRow.status].includes(transition.status)) {
        throw new Error(
          `Illegal job transition from ${currentRow.status} to ${transition.status}`
        );
      }

      const current = rowToJob(currentRow);
      const result = transition.archivedResult !== undefined
        ? sanitizeResult(transition.archivedResult)
        : transition.result === undefined ? current.result : sanitizeResult(transition.result);
      const now = Date.now();
      database.prepare(`
        UPDATE jobs
        SET
          status = @status,
          creation_code = @creationCode,
          upstream_task_id = @upstreamTaskId,
          upstream_fingerprint = @upstreamFingerprint,
          submitted_at = @submittedAt,
          discovered_at = @discoveredAt,
          completed_at = @completedAt,
          failed_at = @failedAt,
          unknown_hold_until = @unknownHoldUntil,
          processing_deadline_at = @processingDeadlineAt,
          reconcile_after = @reconcileAfter,
          uncertainty_reason = @uncertaintyReason,
          poll_attempts = @pollAttempts,
          last_polled_at = @lastPolledAt,
          error_code = @errorCode,
          result_json = @resultJson,
          updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id,
        status: transition.status,
        creationCode: transition.creationCode === undefined
          ? current.creationCode
          : transition.creationCode,
        upstreamTaskId: transition.upstreamTaskId === undefined
          ? current.upstreamTaskId
          : transition.upstreamTaskId,
        upstreamFingerprint: transition.upstreamFingerprint === undefined
          ? current.upstreamFingerprint
          : transition.upstreamFingerprint,
        submittedAt: transition.submittedAt ?? current.submittedAt,
        discoveredAt: transition.discoveredAt ?? current.discoveredAt,
        completedAt: transition.completedAt ?? current.completedAt,
        failedAt: transition.failedAt ?? current.failedAt,
        unknownHoldUntil: transition.status === "unknown"
          ? transition.unknownHoldUntil ?? current.unknownHoldUntil
          : null,
        processingDeadlineAt: transition.processingDeadlineAt === undefined
          ? current.processingDeadlineAt
          : transition.processingDeadlineAt,
        reconcileAfter: transition.reconcileAfter === undefined
          ? current.reconcileAfter
          : transition.reconcileAfter,
        uncertaintyReason: transition.uncertaintyReason === undefined
          ? current.uncertaintyReason
          : transition.uncertaintyReason,
        pollAttempts: transition.pollAttempts ?? current.pollAttempts,
        lastPolledAt: transition.lastPolledAt === undefined
          ? current.lastPolledAt
          : transition.lastPolledAt,
        errorCode: transition.errorCode === undefined
          ? current.errorCode
          : transition.errorCode,
        resultJson: result === null ? null : JSON.stringify(result),
        updatedAt: now
      });
      database.prepare(`
        INSERT INTO job_status_history(job_id, status, created_at)
        VALUES (?, ?, ?)
      `).run(id, transition.status, now);
      const terminal = transition.status === "completed" || transition.status === "failed";
      const outputUrlsControlled = result?.outputs.every(output=>output.url.startsWith("/v1/assets/")) ?? false;
      if (terminal && current.kind === "video" && (transition.status === "failed" || outputUrlsControlled)) {
        const endpoint = database.prepare("SELECT 1 FROM webhook_endpoints WHERE project_id=? AND enabled=1").get(current.projectId);
        if (endpoint !== undefined) {
          const eventType = transition.status === "completed" ? "video.completed" : "video.failed";
          const payload = transition.status === "completed"
            ? { id, status: "completed", outputs: result?.outputs ?? [] }
            : { id, status: "failed", error: { code: transition.errorCode ?? current.errorCode } };
          database.prepare(`
            INSERT INTO webhook_outbox(id,project_id,job_id,event_type,payload_json,status,next_attempt_at,created_at,updated_at)
            VALUES(?,?,?,?,?,'pending',?,?,?) ON CONFLICT(job_id,event_type) DO NOTHING
          `).run(`evt_${randomBytes(16).toString("hex")}`,current.projectId,id,eventType,JSON.stringify(payload),now,now,now);
        }
      }
      const updated = this.findRow(database, id);
      if (updated === undefined) {
        throw new Error("Transitioned job could not be read");
      }
      return rowToJob(updated);
    });
  }

  recoverable(now = Date.now()): JobRecord[] {
    return this.read((database) => {
      const rows = database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM jobs
      WHERE status IN ('submitting', 'discovering', 'processing')
         OR (
           status = 'unknown'
           AND unknown_hold_until IS NOT NULL
           AND unknown_hold_until > ?
         )
      ORDER BY updated_at ASC, rowid ASC
      `).all(now) as JobRow[];
      return rows.map((row) => rowToJob(row));
    });
  }

  history(id: string): JobStatus[] {
    return this.read((database) => {
      const rows = database.prepare(`
      SELECT status
      FROM job_status_history
      WHERE job_id = ?
      ORDER BY id ASC
      `).all(id) as Array<{ status: JobStatus }>;
      return rows.map((row) => row.status);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsStore) this.store.close();
  }

  private read<T>(operation: (database: Database.Database) => T): T {
    this.assertOpen();
    return this.store.read(operation);
  }

  private immediate<T>(operation: (database: Database.Database) => T): T {
    this.assertOpen();
    return this.store.immediate(operation);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Job repository is closed");
    }
  }

  private findRow(
    database: Database.Database,
    id: string
  ): JobRow | undefined {
    return database.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM jobs
      WHERE id = ?
    `).get(id) as JobRow | undefined;
  }
}
