import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { errors } from "../errors.js";
import { SqliteStore } from "../persistence/sqlite-store.js";
import type {
  JobListFilter,
  JobOutput,
  JobRecord,
  JobResult,
  JobStatus,
  JobTransition,
  NewJob
} from "./types.js";

export const allowedTransitions: Record<JobStatus, JobStatus[]> = {
  queued: ["submitting", "failed"],
  submitting: ["discovering", "unknown", "failed"],
  discovering: ["processing", "completed", "unknown", "failed"],
  processing: ["completed", "failed", "unknown"],
  unknown: ["discovering", "processing", "completed", "failed"],
  completed: [],
  failed: []
};

interface JobRow {
  id: string;
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

const SELECT_COLUMNS = `
  id,
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
  status,
  creation_code,
  upstream_task_id,
  upstream_fingerprint,
  submitted_at,
  discovered_at,
  completed_at,
  failed_at,
  unknown_hold_until,
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
          status,
          created_at,
          updated_at
        ) VALUES (
          @id,
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
          'queued',
          @now,
          @now
        )
      `).run({ id, ...input, now });
      database.prepare(`
        INSERT INTO job_status_history(job_id, status, created_at)
        VALUES (?, 'queued', ?)
      `).run(id, now);
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
      const rows = filter.status === undefined
        ? database.prepare(`
          SELECT ${SELECT_COLUMNS}
          FROM jobs
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?
          `).all(filter.limit) as JobRow[]
        : database.prepare(`
          SELECT ${SELECT_COLUMNS}
          FROM jobs
          WHERE status = ?
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?
          `).all(filter.status, filter.limit) as JobRow[];
      return rows.map((row) => rowToJob(row));
    });
  }

  transition(
    id: string,
    expectedStatuses: readonly JobStatus[],
    transition: JobTransition
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
      const result = transition.result === undefined
        ? current.result
        : sanitizeResult(transition.result);
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
