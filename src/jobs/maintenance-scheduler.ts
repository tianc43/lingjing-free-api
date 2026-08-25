export interface MaintenanceRunResult {
  reconciliationRan: boolean;
  assetsDeleted: number;
}

export class MaintenanceScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<MaintenanceRunResult> | null = null;
  private closed = false;

  constructor(private readonly options: {
    reconcile(): Promise<unknown>;
    cleanupAssets(olderThan: number): Promise<number>;
    cleanupExpiredAssets?(now:number):Promise<number>;
    cleanupExpiredUploads?(now:number):Promise<number>;
    intervalMs: number;
    unboundAssetRetentionMs: number;
    now?: () => number;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
  }) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new RangeError("Maintenance interval must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(options.unboundAssetRetentionMs)
      || options.unboundAssetRetentionMs < 0
    ) throw new RangeError("Asset retention must be a non-negative safe integer");
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("Maintenance scheduler is closed");
    if (this.timer !== null) return;
    await this.runNow();
    const createInterval = this.options.setInterval ?? setInterval;
    this.timer = createInterval(() => {
      void this.runNow().catch(() => undefined);
    }, this.options.intervalMs);
    this.timer.unref();
  }

  runNow(): Promise<MaintenanceRunResult> {
    if (this.closed) return Promise.reject(new Error("Maintenance scheduler is closed"));
    this.running ??= this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      const destroyInterval = this.options.clearInterval ?? clearInterval;
      destroyInterval(this.timer);
      this.timer = null;
    }
    await this.running;
  }

  private async execute(): Promise<MaintenanceRunResult> {
    const now = this.options.now?.() ?? Date.now();
    await this.options.reconcile();
    const assetsDeleted = await this.options.cleanupAssets(
      now - this.options.unboundAssetRetentionMs
    ) + await (this.options.cleanupExpiredAssets?.(now) ?? Promise.resolve(0))
      + await (this.options.cleanupExpiredUploads?.(now) ?? Promise.resolve(0));
    return { reconciliationRan: true, assetsDeleted };
  }
}
