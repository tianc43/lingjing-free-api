import { randomBytes } from "node:crypto";
import type { JobFence } from "../jobs/types.js";
import type { SqliteStore } from "../persistence/sqlite-store.js";

export type SubmissionOutcome =
  | "baseline_captured"
  | "submitting"
  | "submitted"
  | "rejected"
  | "submission_ambiguous"
  | "correlated"
  | "correlation_ambiguous"
  | "provider_status_unknown"
  | "provider_succeeded"
  | "provider_failed";

export interface ProviderSubmissionRecord {
  id: string;
  jobId: string;
  provider: "lingjing";
  accountId: string;
  requestFingerprint: string;
  upstreamFingerprint: string;
  catalogRevision: string;
  baselineAssetIds: readonly string[];
  baselineCapturedAt: number;
  outcome: SubmissionOutcome;
  ambiguityReason: string | null;
}

interface SubmissionRow {
  id: string;
  job_id: string;
  provider: "lingjing";
  account_id: string;
  request_fingerprint: string;
  upstream_fingerprint: string;
  catalog_revision: string;
  baseline_json: string;
  baseline_captured_at: number;
  outcome: SubmissionOutcome;
  ambiguity_reason: string | null;
}

function submissionFromRow(row: SubmissionRow): ProviderSubmissionRecord {
  const parsed: unknown = JSON.parse(row.baseline_json);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("Provider submission baseline is invalid");
  }
  return {
    id: row.id,
    jobId: row.job_id,
    provider: row.provider,
    accountId: row.account_id,
    requestFingerprint: row.request_fingerprint,
    upstreamFingerprint: row.upstream_fingerprint,
    catalogRevision: row.catalog_revision,
    baselineAssetIds: parsed,
    baselineCapturedAt: row.baseline_captured_at,
    outcome: row.outcome,
    ambiguityReason: row.ambiguity_reason
  };
}

export class SqliteExecutionRepository {
  constructor(private readonly store: SqliteStore) {}

  private assertFence(
    database: import("better-sqlite3").Database,
    jobId: string,
    fence?: JobFence
  ): void {
    if (fence === undefined) return;
    const owned = database.prepare(`
      SELECT 1 AS owned FROM job_worker_leases
      WHERE job_id = ? AND worker_id = ? AND lease_token = ?
        AND fencing_token = ? AND lease_expires_at > ?
    `).get(
      jobId,
      fence.workerId,
      fence.leaseToken,
      fence.fencingToken,
      fence.now
    ) as { owned: 1 } | undefined;
    if (owned === undefined) throw new Error("Worker lease fencing conflict");
  }

  captureBaseline(input: {
    jobId: string;
    accountId: string;
    requestFingerprint: string;
    upstreamFingerprint: string;
    catalogRevision: string;
    baselineAssetIds: readonly string[];
    capturedAt: number;
    fence?: JobFence;
  }): ProviderSubmissionRecord {
    return this.store.immediate((database) => {
      this.assertFence(database, input.jobId, input.fence);
      const existing = this.findRow(database, input.jobId);
      if (existing !== undefined) {
        if (
          existing.account_id !== input.accountId
          || existing.upstream_fingerprint !== input.upstreamFingerprint
          || existing.request_fingerprint !== input.requestFingerprint
        ) throw new Error("Provider submission conflict");
        return submissionFromRow(existing);
      }
      const id = `sub_${randomBytes(16).toString("hex")}`;
      const baseline = JSON.stringify([...new Set(input.baselineAssetIds)].sort());
      database.prepare(`
        INSERT INTO provider_submissions (
          id, job_id, provider, account_id, attempt_number, request_fingerprint,
          upstream_fingerprint, catalog_revision, baseline_json,
          baseline_captured_at, outcome, created_at, updated_at
        ) VALUES (?, ?, 'lingjing', ?, 1, ?, ?, ?, ?, ?, 'baseline_captured', ?, ?)
      `).run(
        id, input.jobId, input.accountId, input.requestFingerprint,
        input.upstreamFingerprint, input.catalogRevision, baseline,
        input.capturedAt, input.capturedAt, input.capturedAt
      );
      const inserted = this.findRow(database, input.jobId);
      if (inserted === undefined) throw new Error("Provider submission was not persisted");
      return submissionFromRow(inserted);
    });
  }

  markSubmitting(jobId: string, at: number, fence?: JobFence): void {
    this.transition(jobId, ["baseline_captured"], "submitting", at, {
      timestampColumn: "submit_started_at",
      ...(fence === undefined ? {} : { fence })
    });
  }

  markSubmitted(jobId: string, at: number, fence?: JobFence): void {
    this.transition(jobId, ["submitting"], "submitted", at, {
      timestampColumn: "submit_finished_at",
      ...(fence === undefined ? {} : { fence })
    });
  }

  markRejected(jobId: string, at: number, fence?: JobFence): void {
    this.transition(jobId, ["submitting"], "rejected", at, {
      timestampColumn: "submit_finished_at",
      ...(fence === undefined ? {} : { fence })
    });
  }

  markAmbiguous(jobId: string, reason: string, at: number, fence?: JobFence): void {
    this.transition(jobId, ["submitting"], "submission_ambiguous", at, {
      timestampColumn: "submit_finished_at",
      reason,
      ...(fence === undefined ? {} : { fence })
    });
  }

  markCorrelationAmbiguous(
    jobId: string,
    reason: string,
    at: number,
    fence?: JobFence
  ): void {
    this.updateOutcome(
      jobId,
      ["submitted", "submission_ambiguous", "correlation_ambiguous"],
      "correlation_ambiguous",
      reason,
      at,
      fence
    );
  }

  markProviderTerminal(
    jobId: string,
    outcome: "provider_succeeded" | "provider_failed",
    at: number,
    fence?: JobFence
  ): void {
    this.updateOutcome(
      jobId,
      ["correlated", "provider_status_unknown"],
      outcome,
      null,
      at,
      fence
    );
  }

  markProviderStatusUnknown(
    jobId: string,
    reason: string,
    at: number,
    fence?: JobFence
  ): void {
    this.updateOutcome(
      jobId,
      ["correlated", "provider_status_unknown"],
      "provider_status_unknown",
      reason,
      at,
      fence
    );
  }

  correlate(input: {
    jobId: string;
    upstreamTaskId: string;
    upstreamAssetId: string;
    creationCode: string;
    correlatedAt: number;
    fence?: JobFence;
  }): void {
    const conflict = this.store.immediate((database) => {
      this.assertFence(database, input.jobId, input.fence);
      const submission = this.findRow(database, input.jobId);
      // Jobs migrated from pre-v7 databases have no submission record. They
      // remain recoverable without inventing historical submission evidence.
      if (submission === undefined) return false;
      const bound = database.prepare(`SELECT job_id FROM provider_correlations WHERE provider='lingjing' AND account_id=? AND upstream_task_id=?`).get(submission.account_id,input.upstreamTaskId) as {job_id:string}|undefined;
      if(bound!==undefined&&bound.job_id!==input.jobId){
        database.prepare(`UPDATE provider_submissions SET outcome='correlation_ambiguous',ambiguity_reason='upstream_task_already_bound',updated_at=? WHERE job_id=?`).run(input.correlatedAt,input.jobId);
        return true;
      }
      database.prepare(`
        INSERT INTO provider_correlations (
          id, submission_id, job_id, provider, account_id, upstream_task_id,
          upstream_asset_id, creation_code, evidence_type, confidence, correlated_at
        ) VALUES (?, ?, ?, 'lingjing', ?, ?, ?, ?, 'asset_discovery', 'exact', ?)
        ON CONFLICT(job_id) DO NOTHING
      `).run(
        `cor_${randomBytes(16).toString("hex")}`,
        submission.id,
        input.jobId,
        submission.account_id,
        input.upstreamTaskId,
        input.upstreamAssetId,
        input.creationCode,
        input.correlatedAt
      );
      database.prepare(`
        UPDATE provider_submissions SET outcome = 'correlated', updated_at = ?
        WHERE job_id = ? AND outcome IN ('submitted','submission_ambiguous','correlation_ambiguous')
      `).run(input.correlatedAt, input.jobId);
      return false;
    });
    if(conflict)throw new Error("Provider correlation conflict: upstream_task_already_bound");
  }

  appendLedger(input: {
    jobId: string;
    type: "hold" | "charge" | "release" | "refund" | "adjustment";
    points: number;
    reason: string;
    createdAt: number;
  }): void {
    this.store.immediate((database) => {
      const job = database.prepare(`
        SELECT user_id, project_id, api_key_id, account_id FROM jobs WHERE id = ?
      `).get(input.jobId) as {
        user_id: string;
        project_id: string;
        api_key_id: string | null;
        account_id: string;
      } | undefined;
      if (job === undefined) throw new Error("Ledger job was not found");
      database.prepare(`
        INSERT INTO usage_ledger (
          id, job_id, user_id, project_id, api_key_id, account_id,
          entry_type, points, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, entry_type, reason) DO NOTHING
      `).run(
        `led_${randomBytes(16).toString("hex")}`,
        input.jobId,
        job.user_id,
        job.project_id,
        job.api_key_id,
        job.account_id,
        input.type,
        input.points,
        input.reason,
        input.createdAt
      );
    });
  }

  findSubmission(jobId: string): ProviderSubmissionRecord | null {
    return this.store.read((database) => {
      const row = this.findRow(database, jobId);
      return row === undefined ? null : submissionFromRow(row);
    });
  }

  private updateOutcome(
    jobId: string,
    expected: readonly SubmissionOutcome[],
    outcome: SubmissionOutcome,
    reason: string | null,
    at: number,
    fence?: JobFence
  ): void {
    this.store.immediate((database) => {
      this.assertFence(database, jobId, fence);
      if (this.findRow(database, jobId) === undefined) return;
      const placeholders = expected.map(() => "?").join(",");
      const result = database.prepare(`
        UPDATE provider_submissions
        SET outcome = ?, ambiguity_reason = ?, updated_at = ?
        WHERE job_id = ? AND outcome IN (${placeholders})
      `).run(outcome, reason, at, jobId, ...expected);
      if (result.changes !== 1) throw new Error("Provider submission transition conflict");
    });
  }

  private transition(
    jobId: string,
    expected: readonly SubmissionOutcome[],
    outcome: SubmissionOutcome,
    at: number,
    options: {
      timestampColumn: "submit_started_at" | "submit_finished_at";
      reason?: string;
      fence?: JobFence;
    }
  ): void {
    this.store.immediate((database) => {
      this.assertFence(database, jobId, options.fence);
      const placeholders = expected.map(() => "?").join(",");
      const result = database.prepare(`
        UPDATE provider_submissions
        SET outcome = ?, ${options.timestampColumn} = ?, ambiguity_reason = ?, updated_at = ?
        WHERE job_id = ? AND outcome IN (${placeholders})
      `).run(outcome, at, options.reason ?? null, at, jobId, ...expected);
      if (result.changes !== 1) throw new Error("Provider submission transition conflict");
    });
  }

  private findRow(database: import("better-sqlite3").Database, jobId: string): SubmissionRow | undefined {
    return database.prepare(`
      SELECT id, job_id, provider, account_id, request_fingerprint,
        upstream_fingerprint, catalog_revision, baseline_json,
        baseline_captured_at, outcome, ambiguity_reason
      FROM provider_submissions WHERE job_id = ?
    `).get(jobId) as SubmissionRow | undefined;
  }
}
