import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CapacityManager } from "./capacity.js";
import type { SqliteJobRepository } from "./sqlite-repository.js";
import type { CapacityLease, JobRecord } from "./types.js";

export class JobRunnerRegistry {
  private readonly running = new Map<string, Promise<void>>();

  startOnce(
    jobId: string,
    start: () => Promise<void>
  ): Promise<void> {
    const existing = this.running.get(jobId);
    if (existing !== undefined) return existing;

    const promise = Promise.resolve().then(start);
    this.running.set(jobId, promise);
    void promise.finally(() => {
      if (this.running.get(jobId) === promise) this.running.delete(jobId);
    }).catch(() => undefined);
    return promise;
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  async waitUntilIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()]);
    }
  }
}

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
  private started = false;
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

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.options.cleanupOrphans?.();
      this.failInterruptedQueuedJobs();
      for (const promise of this.scheduleRecoverableJobs()) {
        void promise.catch(() => undefined);
      }
      this.options.capacity.expireUnknown(this.now());
      const sweepMs = Math.max(
        1,
        Math.min(60_000, Math.floor(this.options.unknownCapacityHoldMs / 4))
      );
      this.sweepTimer = this.createInterval(() => {
        this.options.capacity.expireUnknown(this.now());
      }, sweepMs);
      this.sweepTimer.unref();
      this.readyState = true;
    } catch (cause) {
      this.started = false;
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
        this.options.repository.transition(job.id, ["queued"], {
          status: "failed",
          failedAt: this.now(),
          errorCode: "interrupted_before_submit"
        });
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
    const lease = this.options.capacity.restore(
      persisted.id,
      persisted.status,
      persisted.unknownHoldUntil,
      this.now()
    );
    if (lease === null) return null;
    const job = persisted.status === "submitting"
      ? this.options.repository.transition(
          persisted.id,
          ["submitting"],
          { status: "discovering" }
        )
      : persisted;
    const refreshed = this.options.capacity.restore(
      job.id,
      job.status,
      job.unknownHoldUntil,
      this.now()
    );
    return refreshed === null ? null : { job, lease: refreshed };
  }

  private schedule(job: JobRecord, lease: CapacityLease): Promise<void> {
    return this.options.registry.startOnce(
      job.id,
      () => this.options.resumeJob(job, lease)
    );
  }
}
