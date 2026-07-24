import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  combineCapacityLeases,
  type AccountScheduler
} from "../accounts/scheduler.js";
import type { SqliteAdmissionRepository } from "../accounts/sqlite-admission-repository.js";
import { JobRunnerRegistry } from "../generation/runner-registry.js";
import type { CapacityManager } from "./capacity.js";
import type { SqliteJobRepository } from "./sqlite-repository.js";
import type { CapacityLease, JobRecord } from "./types.js";

export { JobRunnerRegistry } from "../generation/runner-registry.js";

export async function removeOrphanTemporaryFiles(
  directory: string,
  lastCleanProcessStart: number
): Promise<void> {
  // `directory` must be an application-owned, dedicated media-temp directory.
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (cause: unknown) => {
      if (
        typeof cause === "object"
        && cause !== null
        && "code" in cause
        && cause.code === "ENOENT"
      ) {
        return [];
      }
      throw cause;
    }
  );
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const path = join(directory, entry.name);
    const details = await stat(path);
    if (details.mtimeMs < lastCleanProcessStart) {
      await rm(path, { force: true });
    }
  }));
}

export interface StartupRecoveryOptions {
  repository: SqliteJobRepository;
  capacity: CapacityManager;
  registry: JobRunnerRegistry;
  resumeJob: (job: JobRecord, lease: CapacityLease) => Promise<void>;
  scheduler?: Pick<AccountScheduler, "restore" | "expireUnknown">;
  admissions?: Pick<
    SqliteAdmissionRepository,
    "charge" | "releasePreSubmit" | "failAndRelease"
  >;
  unknownCapacityHoldMs: number;
  cleanupOrphans?: () => Promise<void>;
  now?: () => number;
  setInterval?: (
    callback: () => void,
    milliseconds: number
  ) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

export class StartupRecovery {
  private initializationPromise: Promise<void> | null = null;
  private readyState = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly createInterval: NonNullable<StartupRecoveryOptions["setInterval"]>;
  private readonly destroyInterval: NonNullable<StartupRecoveryOptions["clearInterval"]>;

  constructor(private readonly options: StartupRecoveryOptions) {
    this.now = options.now ?? Date.now;
    this.createInterval = options.setInterval ?? setInterval;
    this.destroyInterval = options.clearInterval ?? clearInterval;
  }

  get ready(): boolean {
    return this.readyState;
  }

  start(): Promise<void> {
    if (this.initializationPromise !== null) {
      return this.initializationPromise;
    }
    const initializationPromise = this.initialize();
    this.initializationPromise = initializationPromise;
    void initializationPromise.catch(() => {
      if (this.initializationPromise === initializationPromise) {
        this.initializationPromise = null;
      }
    });
    return initializationPromise;
  }

  private async initialize(): Promise<void> {
    try {
      await this.options.cleanupOrphans?.();
      this.chargeCompletedJobs();
      this.releaseFailedReservations();
      this.failInterruptedQueuedJobs();
      for (const promise of this.scheduleRecoverableJobs()) {
        void promise.catch(() => undefined);
      }
      this.options.capacity.expireUnknown(this.now());
      this.options.scheduler?.expireUnknown(this.now());
      const sweepMs = Math.max(
        1,
        Math.min(60_000, Math.floor(this.options.unknownCapacityHoldMs / 4))
      );
      this.sweepTimer = this.createInterval(() => {
        this.options.capacity.expireUnknown(this.now());
        this.options.scheduler?.expireUnknown(this.now());
      }, sweepMs);
      this.sweepTimer.unref();
      this.readyState = true;
    } catch (cause) {
      this.readyState = false;
      if (this.sweepTimer !== null) {
        this.destroyInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
      throw cause;
    }
  }

  async scan(): Promise<void> {
    await Promise.allSettled(this.scheduleRecoverableJobs());
  }

  resume(jobId: string): Promise<void> {
    const job = this.options.repository.findById(jobId);
    if (job === null) return Promise.reject(new Error(`Job ${jobId} not found`));
    if (
      job.status !== "submitting"
      && job.status !== "discovering"
      && job.status !== "processing"
      && job.status !== "unknown"
    ) {
      return Promise.resolve();
    }
    const prepared = this.prepare(job);
    return prepared === null
      ? Promise.resolve()
      : this.schedule(prepared.job, prepared.lease);
  }

  waitUntilIdle(): Promise<void> {
    return this.options.registry.waitUntilIdle();
  }

  close(): void {
    if (this.sweepTimer !== null) {
      this.destroyInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private failInterruptedQueuedJobs(): void {
    let queued = this.options.repository.list({
      status: "queued",
      limit: 1_000
    });
    while (queued.length > 0) {
      for (const job of queued) {
        if (this.options.admissions === undefined) {
          this.options.repository.transition(job.id, ["queued"], {
            status: "failed",
            failedAt: this.now(),
            errorCode: "interrupted_before_submit"
          });
        } else {
          this.options.admissions.failAndRelease(
            job.id,
            ["queued"],
            "interrupted_before_submit"
          );
        }
      }
      queued = this.options.repository.list({
        status: "queued",
        limit: 1_000
      });
    }
  }

  private scheduleRecoverableJobs(): Promise<void>[] {
    const jobs = this.options.repository.recoverable(this.now());
    const scheduled: Promise<void>[] = [];
    for (const persisted of jobs) {
      const prepared = this.prepare(persisted);
      if (prepared !== null) {
        scheduled.push(this.schedule(prepared.job, prepared.lease));
      }
    }
    return scheduled;
  }

  private prepare(
    persisted: JobRecord
  ): { job: JobRecord; lease: CapacityLease } | null {
    this.options.admissions?.charge(persisted.id);
    const runtime = this.options.scheduler?.restore(persisted);
    const globalLease = this.options.capacity.restore(
      persisted.id,
      persisted.status,
      persisted.unknownHoldUntil,
      this.now()
    );
    if (globalLease === null) return null;
    let lease = globalLease;
    if (runtime !== undefined) {
      const accountLease = runtime.capacity.restore(
        persisted.id,
        persisted.status,
        persisted.unknownHoldUntil,
        this.now()
      );
      if (accountLease === null) {
        globalLease.release();
        return null;
      }
      lease = combineCapacityLeases(globalLease, accountLease);
    }
    const job = persisted.status === "submitting"
      ? this.options.repository.transition(
          persisted.id,
          ["submitting"],
          { status: "discovering" }
        )
      : persisted;
    return { job, lease };
  }

  private schedule(job: JobRecord, lease: CapacityLease): Promise<void> {
    return this.options.registry.startOnce(
      job.id,
      () => this.options.resumeJob(job, lease)
    ).promise;
  }

  private chargeCompletedJobs(): void {
    if (this.options.admissions === undefined) return;
    const completed = this.options.repository.list({
      status: "completed",
      limit: 1_000_000
    });
    for (const job of completed) this.options.admissions.charge(job.id);
  }

  private releaseFailedReservations(): void {
    if (this.options.admissions === undefined) return;
    const failed = this.options.repository.list({
      status: "failed",
      limit: 1_000_000
    });
    for (const job of failed) {
      this.options.admissions.releasePreSubmit(job.id);
    }
  }
}
