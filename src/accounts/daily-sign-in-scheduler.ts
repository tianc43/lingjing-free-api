import type { AccountRuntime } from "./runtime.js";
import type { SignInResult } from "../lingjing/sign-in-service.js";

const HOURLY_CHECK_INTERVAL_MS = 60 * 60_000;

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

export type AccountSignInCheckStatus = SignInResult["status"]
  | "checking"
  | "failed";

export interface AccountSignInCheck {
  accountId: string;
  status: AccountSignInCheckStatus;
  currentFrequency: number | null;
  checkedAt: number;
}

export interface DailySignInStatus {
  enabled: true;
  intervalMs: number;
  running: boolean;
  nextCheckAt: number | null;
  lastRunStartedAt: number | null;
  lastRunFinishedAt: number | null;
  accounts: AccountSignInCheck[];
}

export function nextHourlySignInAt(now: number): number {
  return Math.floor(now / HOURLY_CHECK_INTERVAL_MS + 1)
    * HOURLY_CHECK_INTERVAL_MS;
}

export class DailySignInScheduler {
  private timer: TimerHandle | null = null;
  private running: Promise<DailySignInSummary> | null = null;
  private closed = false;
  private started = false;
  private executing = false;
  private nextCheckAt: number | null = null;
  private lastRunStartedAt: number | null = null;
  private lastRunFinishedAt: number | null = null;
  private readonly accountChecks = new Map<string, AccountSignInCheck>();

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
    stateStore?: {
      beginRun(accountIds: readonly string[], startedAt: number): Promise<void>;
      recordCheck(check: AccountSignInCheck): Promise<void>;
      finishRun(finishedAt: number): Promise<void>;
    };
    now?: () => number;
    setTimeout?: TimerFactory;
    clearTimeout?: (timer: TimerHandle) => void;
  }) {}

  start(): void {
    if (this.closed) throw new Error("Daily sign-in scheduler is closed");
    if (this.started) return;
    this.started = true;
    this.scheduleNext();
    void this.runNow().catch(() => {
      this.options.logger?.warn({
        error_code: "daily_sign_in_run_failed"
      }, "daily sign-in startup check failed");
    });
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

  status(): DailySignInStatus {
    return {
      enabled: true,
      intervalMs: HOURLY_CHECK_INTERVAL_MS,
      running: this.executing,
      nextCheckAt: this.nextCheckAt,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      accounts: [...this.accountChecks.values()].map((value) => ({ ...value }))
    };
  }

  private scheduleNext(): void {
    const now = this.options.now?.() ?? Date.now();
    const createTimer = this.options.setTimeout ?? setTimeout;
    this.nextCheckAt = nextHourlySignInAt(now);
    this.timer = createTimer(() => {
      this.timer = null;
      this.nextCheckAt = null;
      void this.runNow().catch(() => {
        this.options.logger?.warn({
          error_code: "daily_sign_in_run_failed"
        }, "daily sign-in scheduled check failed");
      }).finally(() => {
        if (!this.closed) this.scheduleNext();
      });
    }, this.nextCheckAt - now);
    this.timer.unref();
  }

  private async execute(): Promise<DailySignInSummary> {
    this.executing = true;
    this.lastRunStartedAt = this.options.now?.() ?? Date.now();
    try {
      if (this.options.runExclusive !== undefined) {
        const result = await this.options.runExclusive(
          () => this.executeAccounts()
        );
        if (result !== null) return result;
        this.options.logger?.info({}, "daily sign-in skipped without leader lock");
        return this.emptySummary();
      }
      return await this.executeAccounts();
    } finally {
      this.executing = false;
      this.lastRunFinishedAt = this.options.now?.() ?? Date.now();
    }
  }

  private async executeAccounts(): Promise<DailySignInSummary> {
    const summary = this.emptySummary();
    const runtimes = [...this.options.runtimes.listEnabled()];
    const enabledAccountIds = new Set(
      runtimes.map((runtime) => runtime.record.id)
    );
    for (const accountId of this.accountChecks.keys()) {
      if (!enabledAccountIds.has(accountId)) this.accountChecks.delete(accountId);
    }
    await this.persistState(() => this.options.stateStore?.beginRun(
      [...enabledAccountIds],
      this.options.now?.() ?? Date.now()
    ));
    for (const runtime of runtimes) {
      summary.total += 1;
      await this.recordCheck({
        accountId: runtime.record.id,
        status: "checking",
        currentFrequency: null,
        checkedAt: this.options.now?.() ?? Date.now()
      });
      try {
        const result = await this.options.signIn(runtime);
        if (result.status === "signed") summary.signed += 1;
        else if (result.status === "already_signed") summary.alreadySigned += 1;
        else if (result.status === "no_active_activity") {
          summary.noActiveActivity += 1;
        } else summary.unknown += 1;
        await this.recordCheck({
          accountId: runtime.record.id,
          status: result.status,
          currentFrequency: result.currentFrequency,
          checkedAt: this.options.now?.() ?? Date.now()
        });
        this.options.logger?.info({
          account_id: runtime.record.id,
          sign_in_status: result.status
        }, "daily sign-in account completed");
      } catch {
        summary.failed += 1;
        await this.recordCheck({
          accountId: runtime.record.id,
          status: "failed",
          currentFrequency: null,
          checkedAt: this.options.now?.() ?? Date.now()
        });
        this.options.logger?.warn({
          account_id: runtime.record.id,
          error_code: "daily_sign_in_failed"
        }, "daily sign-in account failed");
      }
    }
    await this.persistState(() => this.options.stateStore?.finishRun(
      this.options.now?.() ?? Date.now()
    ));
    this.options.logger?.info({ ...summary }, "daily sign-in run completed");
    return summary;
  }

  private async recordCheck(check: AccountSignInCheck): Promise<void> {
    this.accountChecks.set(check.accountId, check);
    await this.persistState(() => this.options.stateStore?.recordCheck(check));
  }

  private async persistState(
    operation: () => Promise<void> | undefined
  ): Promise<void> {
    try {
      await operation();
    } catch {
      this.options.logger?.warn({
        error_code: "daily_sign_in_status_persist_failed"
      }, "daily sign-in status persistence failed");
    }
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
