import type { AccountRuntime } from "./runtime.js";
import type { SignInResult } from "../lingjing/sign-in-service.js";

const DAY_MS = 24 * 60 * 60_000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;
const SIGN_IN_MINUTES_AFTER_MIDNIGHT = 10;

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerFactory = (callback: () => void, milliseconds: number) => TimerHandle;

export interface DailySignInSummary {
  total: number;
  signed: number;
  alreadySigned: number;
  noActiveActivity: number;
  unknown: number;
  failed: number;
}

export function nextShanghaiSignInAt(now: number): number {
  const local = new Date(now + SHANGHAI_OFFSET_MS);
  const localDayStart = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate()
  ) - SHANGHAI_OFFSET_MS;
  const todayTarget = localDayStart
    + SIGN_IN_MINUTES_AFTER_MIDNIGHT * 60_000;
  return todayTarget > now ? todayTarget : todayTarget + DAY_MS;
}

export class DailySignInScheduler {
  private timer: TimerHandle | null = null;
  private running: Promise<DailySignInSummary> | null = null;
  private closed = false;

  constructor(private readonly options: {
    runtimes: { listEnabled(): readonly AccountRuntime[] };
    signIn(runtime: AccountRuntime): Promise<SignInResult>;
    logger?: {
      info(bindings: Record<string, unknown>, message: string): void;
      warn(bindings: Record<string, unknown>, message: string): void;
    };
    runExclusive?(work: () => Promise<DailySignInSummary>): Promise<
      DailySignInSummary | null
    >;
    now?: () => number;
    setTimeout?: TimerFactory;
    clearTimeout?: (timer: TimerHandle) => void;
  }) {}

  start(): void {
    if (this.closed) throw new Error("Daily sign-in scheduler is closed");
    if (this.timer !== null) return;
    this.scheduleNext();
  }

  runNow(): Promise<DailySignInSummary> {
    if (this.closed) {
      return Promise.reject(new Error("Daily sign-in scheduler is closed"));
    }
    this.running ??= this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      (this.options.clearTimeout ?? clearTimeout)(this.timer);
      this.timer = null;
    }
    await this.running;
  }

  private scheduleNext(): void {
    const now = this.options.now?.() ?? Date.now();
    const createTimer = this.options.setTimeout ?? setTimeout;
    this.timer = createTimer(() => {
      this.timer = null;
      void this.runNow().finally(() => {
        if (!this.closed) this.scheduleNext();
      });
    }, nextShanghaiSignInAt(now) - now);
    this.timer.unref();
  }

  private async execute(): Promise<DailySignInSummary> {
    if (this.options.runExclusive !== undefined) {
      const result = await this.options.runExclusive(
        () => this.executeAccounts()
      );
      if (result !== null) return result;
      this.options.logger?.info({}, "daily sign-in skipped without leader lock");
      return this.emptySummary();
    }
    return await this.executeAccounts();
  }

  private async executeAccounts(): Promise<DailySignInSummary> {
    const summary = this.emptySummary();
    for (const runtime of this.options.runtimes.listEnabled()) {
      summary.total += 1;
      try {
        const result = await this.options.signIn(runtime);
        if (result.status === "signed") summary.signed += 1;
        else if (result.status === "already_signed") summary.alreadySigned += 1;
        else if (result.status === "no_active_activity") {
          summary.noActiveActivity += 1;
        } else summary.unknown += 1;
        this.options.logger?.info({
          account_id: runtime.record.id,
          sign_in_status: result.status
        }, "daily sign-in account completed");
      } catch {
        summary.failed += 1;
        this.options.logger?.warn({
          account_id: runtime.record.id,
          error_code: "daily_sign_in_failed"
        }, "daily sign-in account failed");
      }
    }
    this.options.logger?.info({ ...summary }, "daily sign-in run completed");
    return summary;
  }

  private emptySummary(): DailySignInSummary {
    return {
      total: 0,
      signed: 0,
      alreadySigned: 0,
      noActiveActivity: 0,
      unknown: 0,
      failed: 0
    };
  }
}
