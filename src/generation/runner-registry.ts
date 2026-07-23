import type {
  JobRunnerRegistry as JobRunnerRegistryContract
} from "./types.js";

interface RunnerEntry {
  promise: Promise<void>;
}

export interface SubmitCriticalReservation {
  run<T>(operation: () => Promise<T>): Promise<T>;
  cancel(): void;
}

class Reservation implements SubmitCriticalReservation {
  readonly completion: Promise<void>;
  private resolveCompletion: (() => void) | undefined;
  private consumed = false;

  constructor() {
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.consumed) {
      throw new Error("Submit critical reservation was already consumed");
    }
    this.consumed = true;
    try {
      return await operation();
    } finally {
      this.resolveCompletion?.();
      this.resolveCompletion = undefined;
    }
  }

  cancel(): void {
    if (this.consumed) return;
    this.consumed = true;
    this.resolveCompletion?.();
    this.resolveCompletion = undefined;
  }
}

function timeoutAfter(milliseconds: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, milliseconds);
    timer.unref();
  });
}

export class JobRunnerRegistry implements JobRunnerRegistryContract {
  private readonly running = new Map<string, RunnerEntry>();
  private readonly submitReservations = new Set<Promise<void>>();
  private accepting = true;

  startOnce(
    jobId: string,
    work: () => Promise<void>
  ): { promise: Promise<void>; started: boolean } {
    const existing = this.running.get(jobId);
    if (existing !== undefined) {
      return { promise: existing.promise, started: false };
    }
    if (!this.accepting) {
      return {
        promise: Promise.reject(
          new Error("Job runner registry is no longer accepting work")
        ),
        started: false
      };
    }

    const promise = Promise.resolve().then(work);
    const entry = { promise };
    this.running.set(jobId, entry);
    void promise.finally(() => {
      if (this.running.get(jobId) === entry) this.running.delete(jobId);
    }).catch(() => undefined);
    return { promise, started: true };
  }

  has(jobId: string): boolean {
    return this.running.has(jobId);
  }

  isRunning(jobId: string): boolean {
    return this.has(jobId);
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  reserveSubmitCriticalSection(): SubmitCriticalReservation {
    const reservation = new Reservation();
    this.submitReservations.add(reservation.completion);
    void reservation.completion.then(() => {
      this.submitReservations.delete(reservation.completion);
    });
    return reservation;
  }

  runSubmitCriticalSection<T>(operation: () => Promise<T>): Promise<T> {
    return this.reserveSubmitCriticalSection().run(operation);
  }

  async drainSubmitCriticalSections(timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("Drain timeout must be a non-negative number");
    }
    const drain = async (): Promise<void> => {
      while (this.submitReservations.size > 0) {
        await Promise.allSettled([...this.submitReservations]);
      }
    };
    if (timeoutMs === 0) {
      if (this.submitReservations.size > 0) {
        throw new Error("Timed out draining submit critical sections");
      }
      return;
    }
    await Promise.race([
      drain(),
      timeoutAfter(
        timeoutMs,
        "Timed out draining submit critical sections"
      )
    ]);
  }

  async waitUntilIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled(
        [...this.running.values()].map((entry) => entry.promise)
      );
    }
  }
}
