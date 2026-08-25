import type { AccountRecord } from "../accounts/types.js";
import type { LingjingTransport } from "../lingjing/types.js";
import type { SqliteExecutionRepository } from "../generation/execution-repository.js";
import { LingjingTaskPoller } from "./poller.js";
import type { SqliteJobRepository } from "./sqlite-repository.js";
import type { JobFence } from "./types.js";
import type { SqliteWorkerLeaseRepository } from "./worker-lease-repository.js";

export interface ReconciliationScanResult {
  scanned: number;
  completed: number;
  failed: number;
  deferred: number;
  skipped: number;
}

export class ReconciliationWorker {
  constructor(private readonly options: {
    repository: Pick<
      SqliteJobRepository,
      "reconciliationDue" | "findById" | "transition"
    >;
    executions: Pick<
      SqliteExecutionRepository,
      "markProviderTerminal" | "markProviderStatusUnknown"
    >;
    workerLeases: Pick<
      SqliteWorkerLeaseRepository,
      "acquire" | "heartbeat" | "owns" | "release"
    >;
    runtimes: {
      listEnabled(): Array<{
        record: AccountRecord;
        transport: LingjingTransport;
      }>;
    };
    workerId: string;
    leaseDurationMs?: number;
    heartbeatMs?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    now?: () => number;
  }) {}

  async scan(limit = 20): Promise<ReconciliationScanResult> {
    const now = this.options.now?.() ?? Date.now();
    const result: ReconciliationScanResult = {
      scanned: 0,
      completed: 0,
      failed: 0,
      deferred: 0,
      skipped: 0
    };
    const jobs = this.options.repository.reconciliationDue({ dueAt: now, limit });
    for (const job of jobs) {
      result.scanned += 1;
      const lease = this.options.workerLeases.acquire(
        job.id,
        this.options.workerId,
        this.options.leaseDurationMs ?? 60_000
      );
      if (lease === null) {
        result.skipped += 1;
        continue;
      }
      let currentLease=lease;let lost=false;
      const heartbeat=setInterval(()=>{if(lost)return;const renewed=this.options.workerLeases.heartbeat(currentLease,this.options.leaseDurationMs??60_000);if(renewed===null)lost=true;else currentLease=renewed;},this.options.heartbeatMs??20_000);heartbeat.unref();
      try {
        if (!this.options.workerLeases.owns(currentLease)) {
          result.skipped += 1;
          continue;
        }
        const initialFence:JobFence={workerId:currentLease.workerId,leaseToken:currentLease.leaseToken,fencingToken:currentLease.fencingToken,now:this.options.now?.()??Date.now()};
        const runtime = this.options.runtimes.listEnabled().find(
          (candidate) => candidate.record.id === job.accountId
        );
        if (runtime === undefined) {
          this.defer(job.id, job.pollAttempts ?? 0, "bound_account_unavailable",initialFence);
          result.deferred += 1;
          continue;
        }
        const fence: JobFence = {
          workerId: currentLease.workerId,
          leaseToken: currentLease.leaseToken,
          fencingToken: currentLease.fencingToken,
          now: this.options.now?.() ?? Date.now()
        };
        const next = await new LingjingTaskPoller({
          repository: {
            transition: (id, expected, transition) => this.options.repository.transition(
              id,
              expected,
              transition,
              fence
            )
          },
          transport: runtime.transport,
          ...(this.options.now === undefined ? {} : { now: this.options.now })
        }).poll(job);
        if(!this.options.workerLeases.owns(currentLease)){result.skipped+=1;continue;}
        fence.now=this.options.now?.()??Date.now();
        if (next.status === "completed") {
          this.options.executions.markProviderTerminal(
            job.id,
            "provider_succeeded",
            this.options.now?.() ?? Date.now(),
            fence
          );
          result.completed += 1;
        } else if (next.status === "failed") {
          this.options.executions.markProviderTerminal(
            job.id,
            "provider_failed",
            this.options.now?.() ?? Date.now(),
            fence
          );
          result.failed += 1;
        } else {
          if (next.status === "processing") {
            this.options.repository.transition(job.id, ["processing"], {
              status: "unknown",
              unknownHoldUntil: (this.options.now?.() ?? Date.now()) + 1,
              uncertaintyReason: "provider_status_unknown"
            });
          }
          this.defer(job.id, job.pollAttempts ?? 0, "provider_still_processing",fence);
          result.deferred += 1;
        }
      } catch {
        if(!this.options.workerLeases.owns(currentLease)){result.skipped+=1;continue;}
        const fence:JobFence={workerId:currentLease.workerId,leaseToken:currentLease.leaseToken,fencingToken:currentLease.fencingToken,now:this.options.now?.()??Date.now()};
        this.defer(job.id, job.pollAttempts ?? 0, "provider_poll_unavailable",fence);
        result.deferred += 1;
      } finally {
        clearInterval(heartbeat);
        this.options.workerLeases.release(currentLease);
      }
    }
    return result;
  }

  private defer(jobId: string, attempts: number, reason: string,fence:JobFence): void {
    const now = this.options.now?.() ?? Date.now();
    const base = this.options.baseDelayMs ?? 5 * 60_000;
    const maximum = this.options.maxDelayMs ?? 6 * 60 * 60_000;
    const delay = Math.min(maximum, base * 2 ** Math.min(attempts, 10));
    this.options.repository.transition(jobId, ["unknown"], {
      status: "unknown",
      unknownHoldUntil: now + delay,
      reconcileAfter: now + delay,
      uncertaintyReason: "provider_status_unknown",
      pollAttempts: attempts + 1,
      lastPolledAt: now,
      errorCode: reason
    },fence);
    this.options.executions.markProviderStatusUnknown(jobId, reason, now,fence);
  }
}
