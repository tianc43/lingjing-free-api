import type {
  GenerationHandle,
  GenerationRepository
} from "./types.js";
import type { JobRecord } from "../jobs/types.js";

type Wake = () => void;

const WAIT_COMPLETE = new Set(["completed", "failed", "unknown"]);

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Generation wait aborted");
}

export class JobUpdateNotifier {
  private readonly waiters = new Map<string, Set<Wake>>();

  notify(jobId: string): void {
    const listeners = this.waiters.get(jobId);
    if (listeners === undefined) return;
    this.waiters.delete(jobId);
    for (const wake of listeners) wake();
  }

  wait(jobId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const listeners = this.waiters.get(jobId);
        listeners?.delete(finish);
        if (listeners?.size === 0) this.waiters.delete(jobId);
        resolve();
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const listeners = this.waiters.get(jobId);
        listeners?.delete(finish);
        if (listeners?.size === 0) this.waiters.delete(jobId);
        reject(signal === undefined
          ? new Error("Generation wait aborted")
          : abortError(signal));
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref();
      const listeners = this.waiters.get(jobId) ?? new Set<Wake>();
      listeners.add(finish);
      this.waiters.set(jobId, listeners);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export class RepositoryGenerationHandle implements GenerationHandle {
  constructor(
    readonly job: JobRecord,
    private readonly repository: Pick<GenerationRepository, "findById">,
    private readonly notifier: JobUpdateNotifier
  ) {}

  async wait(timeoutMs: number, signal?: AbortSignal): Promise<JobRecord> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("Wait timeout must be a non-negative number");
    }
    signal?.throwIfAborted();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = this.repository.findById(this.job.id);
      if (current === null) {
        throw new Error(`Generation job ${this.job.id} no longer exists`);
      }
      if (WAIT_COMPLETE.has(current.status)) return current;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return current;
      await this.notifier.wait(current.id, remaining, signal);
    }
  }
}
