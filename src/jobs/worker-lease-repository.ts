import { randomBytes } from "node:crypto";
import type { SqliteStore } from "../persistence/sqlite-store.js";

export interface WorkerLease {
  jobId: string;
  workerId: string;
  leaseToken: string;
  fencingToken: number;
  leaseExpiresAt: number;
  heartbeatAt: number;
  acquiredAt: number;
}

interface LeaseRow {
  job_id: string;
  worker_id: string;
  lease_token: string;
  fencing_token: number;
  lease_expires_at: number;
  heartbeat_at: number;
  acquired_at: number;
}

function fromRow(row: LeaseRow): WorkerLease {
  return {
    jobId: row.job_id,
    workerId: row.worker_id,
    leaseToken: row.lease_token,
    fencingToken: row.fencing_token,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    acquiredAt: row.acquired_at
  };
}

function assertLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Worker lease duration must be a positive safe integer");
  }
}

export class SqliteWorkerLeaseRepository {
  constructor(
    private readonly store: SqliteStore,
    private readonly now: () => number = Date.now
  ) {}

  acquire(jobId: string, workerId: string, durationMs: number): WorkerLease | null {
    assertLeaseDuration(durationMs);
    if (jobId === "" || workerId === "") throw new TypeError("Worker lease identity is required");
    return this.store.immediate((database) => {
      const now = this.now();
      const existing = this.findRow(database, jobId);
      if (existing !== undefined && existing.lease_expires_at > now) {
        return existing.worker_id === workerId ? fromRow(existing) : null;
      }
      const fencingToken = (existing?.fencing_token ?? 0) + 1;
      const leaseToken = `lease_${randomBytes(24).toString("base64url")}`;
      const expiresAt = now + durationMs;
      database.prepare(`
        INSERT INTO job_worker_leases (
          job_id, worker_id, lease_token, fencing_token, lease_expires_at,
          heartbeat_at, acquired_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          worker_id = excluded.worker_id,
          lease_token = excluded.lease_token,
          fencing_token = excluded.fencing_token,
          lease_expires_at = excluded.lease_expires_at,
          heartbeat_at = excluded.heartbeat_at,
          acquired_at = excluded.acquired_at,
          updated_at = excluded.updated_at
        WHERE job_worker_leases.lease_expires_at <= ?
      `).run(
        jobId, workerId, leaseToken, fencingToken, expiresAt,
        now, now, now, now
      );
      const acquired = this.findRow(database, jobId);
      return acquired?.lease_token === leaseToken ? fromRow(acquired) : null;
    });
  }

  heartbeat(lease: WorkerLease, durationMs: number): WorkerLease | null {
    assertLeaseDuration(durationMs);
    return this.store.immediate((database) => {
      const now = this.now();
      const expiresAt = now + durationMs;
      const result = database.prepare(`
        UPDATE job_worker_leases
        SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ? AND worker_id = ? AND lease_token = ?
          AND fencing_token = ? AND lease_expires_at > ?
      `).run(
        now, expiresAt, now, lease.jobId, lease.workerId,
        lease.leaseToken, lease.fencingToken, now
      );
      if (result.changes !== 1) return null;
      const row = this.findRow(database, lease.jobId);
      return row === undefined ? null : fromRow(row);
    });
  }

  owns(lease: WorkerLease): boolean {
    return this.store.read((database) => {
      const row = this.findRow(database, lease.jobId);
      return row !== undefined
        && row.worker_id === lease.workerId
        && row.lease_token === lease.leaseToken
        && row.fencing_token === lease.fencingToken
        && row.lease_expires_at > this.now();
    });
  }

  release(lease: WorkerLease): boolean {
    return this.store.immediate((database) => database.prepare(`
      DELETE FROM job_worker_leases
      WHERE job_id = ? AND worker_id = ? AND lease_token = ? AND fencing_token = ?
    `).run(
      lease.jobId,
      lease.workerId,
      lease.leaseToken,
      lease.fencingToken
    ).changes === 1);
  }

  find(jobId: string): WorkerLease | null {
    return this.store.read((database) => {
      const row = this.findRow(database, jobId);
      return row === undefined ? null : fromRow(row);
    });
  }

  listExpired(limit = 100): WorkerLease[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) {
      throw new RangeError("Expired lease limit must be between 1 and 1000");
    }
    return this.store.read((database) => (database.prepare(`
      SELECT job_id, worker_id, lease_token, fencing_token, lease_expires_at,
        heartbeat_at, acquired_at
      FROM job_worker_leases
      WHERE lease_expires_at <= ?
      ORDER BY lease_expires_at ASC
      LIMIT ?
    `).all(this.now(), limit) as LeaseRow[]).map(fromRow));
  }

  private findRow(
    database: import("better-sqlite3").Database,
    jobId: string
  ): LeaseRow | undefined {
    return database.prepare(`
      SELECT job_id, worker_id, lease_token, fencing_token, lease_expires_at,
        heartbeat_at, acquired_at
      FROM job_worker_leases WHERE job_id = ?
    `).get(jobId) as LeaseRow | undefined;
  }
}
