import { AppError } from "../errors.js";
import type {
  CapacityAdmission,
  CapacityLease,
  JobStatus
} from "./types.js";

export interface CapacityCounts {
  active: number;
  admitted: number;
  activeLimit: number;
  maxQueuedRequests: number;
}

interface PendingLease {
  promise: Promise<CapacityLease>;
  resolve: (lease: CapacityLease) => void;
  reject: (cause: Error) => void;
}

function capacityQueueFull(): AppError {
  return new AppError(
    429,
    "rate_limit_error",
    "lingjing_capacity_queue_full",
    "Generation capacity queue is full"
  );
}

class Lease implements CapacityLease {
  private released = false;

  constructor(
    readonly jobId: string,
    private readonly owner: CapacityManager,
    readonly unknownHoldUntil: number | null
  ) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    this.owner.releaseLease(this);
  }
}

class Admission implements CapacityAdmission {
  jobId: string | null = null;
  pending: PendingLease | null = null;
  released = false;

  constructor(
    readonly requestId: string,
    private readonly owner: CapacityManager
  ) {}

  acquire(jobId: string): Promise<CapacityLease> {
    return this.owner.acquireAdmission(this, jobId);
  }

  release(): void {
    this.owner.releaseAdmission(this);
  }
}

export class CapacityManager {
  private readonly admissions = new Map<string, Admission>();
  private readonly queue: Admission[] = [];
  private readonly activeLeases = new Map<string, Lease>();
  private readonly queuedJobs = new Map<string, Admission>();

  constructor(
    private readonly activeLimit: number,
    private readonly maxQueuedRequests = 100
  ) {
    if (!Number.isSafeInteger(activeLimit) || activeLimit < 1) {
      throw new RangeError("Capacity limit must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxQueuedRequests) || maxQueuedRequests < 0) {
      throw new RangeError("Maximum queued requests must be a non-negative safe integer");
    }
  }

  admit(requestId: string): CapacityAdmission {
    const existing = this.admissions.get(requestId);
    if (existing !== undefined) return existing;
    if (
      this.activeLeases.size + this.queue.length
      >= this.activeLimit + this.maxQueuedRequests
    ) {
      throw capacityQueueFull();
    }
    const admission = new Admission(requestId, this);
    this.admissions.set(requestId, admission);
    this.queue.push(admission);
    return admission;
  }

  restore(
    jobId: string,
    status: JobStatus,
    unknownHoldUntil: number | null,
    now?: number
  ): CapacityLease | null {
    const existing = this.activeLeases.get(jobId);
    if (existing !== undefined) return existing;
    if (
      status !== "submitting"
      && status !== "discovering"
      && status !== "processing"
      && status !== "unknown"
    ) {
      return null;
    }
    if (
      status === "unknown"
      && (
        unknownHoldUntil === null
        || !Number.isFinite(unknownHoldUntil)
        || (now !== undefined && unknownHoldUntil <= now)
      )
    ) {
      return null;
    }

    const lease = new Lease(
      jobId,
      this,
      status === "unknown" ? unknownHoldUntil : null
    );
    this.activeLeases.set(jobId, lease);
    const queued = this.queuedJobs.get(jobId);
    if (queued !== undefined && queued.pending !== null) {
      this.queuedJobs.delete(jobId);
      this.removeQueuedAdmission(queued);
      queued.pending.resolve(lease);
    }
    this.pump();
    return lease;
  }

  expireUnknown(now: number): void {
    for (const lease of [...this.activeLeases.values()]) {
      if (
        lease.unknownHoldUntil !== null
        && lease.unknownHoldUntil <= now
      ) {
        lease.release();
      }
    }
  }

  activeJobIds(): string[] {
    return [...this.activeLeases.keys()];
  }

  counts(): CapacityCounts {
    return {
      active: this.activeLeases.size,
      admitted: this.queue.length,
      activeLimit: this.activeLimit,
      maxQueuedRequests: this.maxQueuedRequests
    };
  }

  acquireAdmission(
    admission: Admission,
    jobId: string
  ): Promise<CapacityLease> {
    if (admission.released) {
      return Promise.reject(new Error("Capacity admission has been released"));
    }
    if (admission.jobId !== null && admission.jobId !== jobId) {
      return Promise.reject(
        new Error(`Capacity admission already acquired for ${admission.jobId}`)
      );
    }
    if (admission.pending !== null) return admission.pending.promise;

    const active = this.activeLeases.get(jobId);
    if (active !== undefined) {
      admission.jobId = jobId;
      this.removeQueuedAdmission(admission);
      admission.pending = {
        promise: Promise.resolve(active),
        resolve: () => undefined,
        reject: () => undefined
      };
      this.pump();
      return admission.pending.promise;
    }

    const queued = this.queuedJobs.get(jobId);
    if (
      queued !== undefined
      && queued !== admission
      && queued.pending !== null
    ) {
      admission.jobId = jobId;
      this.removeQueuedAdmission(admission);
      admission.pending = queued.pending;
      this.pump();
      return queued.pending.promise;
    }

    admission.jobId = jobId;
    let resolveLease: ((lease: CapacityLease) => void) | undefined;
    let rejectLease: ((cause: Error) => void) | undefined;
    const promise = new Promise<CapacityLease>((resolve, reject) => {
      resolveLease = resolve;
      rejectLease = reject;
    });
    if (resolveLease === undefined || rejectLease === undefined) {
      throw new Error("Capacity lease promise could not be initialized");
    }
    admission.pending = {
      promise,
      resolve: resolveLease,
      reject: rejectLease
    };
    this.queuedJobs.set(jobId, admission);
    this.pump();
    return promise;
  }

  releaseAdmission(admission: Admission): void {
    if (admission.released) return;
    admission.released = true;
    this.admissions.delete(admission.requestId);

    if (admission.jobId !== null) {
      const active = this.activeLeases.get(admission.jobId);
      if (active !== undefined) {
        active.release();
        return;
      }
      if (this.queuedJobs.get(admission.jobId) === admission) {
        this.queuedJobs.delete(admission.jobId);
        admission.pending?.reject(
          new Error("Capacity admission was released before acquiring a lease")
        );
      }
    }
    this.removeQueuedAdmission(admission);
    this.pump();
  }

  releaseLease(lease: Lease): void {
    if (this.activeLeases.get(lease.jobId) !== lease) return;
    this.activeLeases.delete(lease.jobId);
    this.queuedJobs.delete(lease.jobId);
    for (const [requestId, admission] of this.admissions) {
      if (admission.jobId === lease.jobId) {
        admission.released = true;
        this.admissions.delete(requestId);
      }
    }
    this.pump();
  }

  private pump(): void {
    while (
      this.activeLeases.size < this.activeLimit
      && this.queue.length > 0
    ) {
      const admission = this.queue[0];
      if (admission === undefined) return;
      if (admission.released) {
        this.queue.shift();
        continue;
      }
      if (admission.jobId === null || admission.pending === null) return;

      this.queue.shift();
      this.queuedJobs.delete(admission.jobId);
      const lease = new Lease(admission.jobId, this, null);
      this.activeLeases.set(admission.jobId, lease);
      admission.pending.resolve(lease);
    }
  }

  private removeQueuedAdmission(admission: Admission): void {
    const index = this.queue.indexOf(admission);
    if (index !== -1) this.queue.splice(index, 1);
  }
}
