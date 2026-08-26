import { describe, expect, it, vi } from "vitest";
import{errors}from"../../src/errors.js";
import { AccountScheduler } from "../../src/accounts/scheduler.js";
import type { AccountRuntime } from "../../src/accounts/runtime.js";
import type {
  AccountRecord,
  AdmissionInput,
  AdmissionResult
} from "../../src/accounts/types.js";
import type { GenerationRequest } from "../../src/generation/types.js";
import { CapacityManager } from "../../src/jobs/capacity.js";
import { DiscoveryLock } from "../../src/jobs/discovery-lock.js";
import { createRequestFingerprint } from "../../src/jobs/fingerprint.js";
import type { JobRecord } from "../../src/jobs/types.js";
import type { AccountSnapshot } from "../../src/lingjing/account.js";
import type { NormalizedModel } from "../../src/models/types.js";

const NOW = Date.parse("2026-07-24T03:00:00Z");
const REQUEST_FINGERPRINT = "a".repeat(64);
const IDEMPOTENCY_HASH = "b".repeat(64);

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("Deferred was not initialized");
  return { promise, resolve: resolvePromise };
}

const model: NormalizedModel = {
  id: "fixture-id",
  apiId: "707",
  alias: "fixture-model",
  displayName: "Fixture model",
  sourceType: "image-generation",
  modelCode: null,
  refId: "fixture-ref",
  sceneCode: "fixture-scene",
  expectedAssetScene: "image",
  uploadStrategy: "general",
  priceQuerySchema: null,
  parameters: [{
    idx: "1",
    key: "prompt",
    displayName: "Prompt",
    required: true,
    kind: "string"
  }],
  pricing: { unit: "points", amount: 7 },
  rawRevision: "fixture-revision"
};

const request: GenerationRequest = {
  kind: "image",
  sourceType: "image-generation",
  model: "707",
  values: { prompt: "draw a fixture" },
  media: [],
  idempotencyKey: "fixture-key"
};

function record(
  id: string,
  overrides: Partial<AccountRecord> = {}
): AccountRecord {
  return {
    id,
    name: id,
    enabled: true,
    priority: 0,
    dailyPointLimit: 0,
    monthlyPointLimit: 0,
    authDirectory: `data/accounts/${id}`,
    healthStatus: "ready",
    lastErrorCode: null,
    subjectHash: null,
    membership: null,
    pointsBalance: 100,
    totalBalance: 100,
    maxConcurrency: 5,
    lastCheckedAt: NOW,
    lastSelectedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function snapshot(pointsBalance = 100): AccountSnapshot {
  return {
    subject: "fixture-subject",
    spaceId: 91_001,
    membership: null,
    maxConcurrency: 5,
    pointsBalance,
    couponBalance: 0,
    availableAmount: pointsBalance,
    totalBalance: pointsBalance,
    resourcePackages: []
  };
}

function runtime(
  accountRecord: AccountRecord,
  options: {
    capacity?: CapacityManager;
    resolve?: (value: string) => Promise<NormalizedModel>;
    describe?: () => Promise<AccountSnapshot>;
  } = {}
): AccountRuntime {
  return {
    record: accountRecord,
    session: {} as AccountRuntime["session"],
    transport: {} as AccountRuntime["transport"],
    account: {
      describe: options.describe ?? (() => Promise.resolve(snapshot()))
    } as AccountRuntime["account"],
    catalog: {
      resolve: options.resolve ?? (() => Promise.resolve(model))
    } as unknown as AccountRuntime["catalog"],
    capacity: options.capacity ?? new CapacityManager(5, 10),
    discoveryLock: new DiscoveryLock()
  };
}

function job(accountId: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: `job-${accountId}`,
    kind: "image",
    sourceType: "image-generation",
    model: request.model,
    apiId: model.apiId,
    modelCode: model.modelCode,
    expectedAssetScene: model.expectedAssetScene,
    requestFingerprint: REQUEST_FINGERPRINT,
    idempotencyKeyHash: IDEMPOTENCY_HASH,
    spaceId: 91_001,
    accountId,
    quotedPoints: 7,
    status: "queued",
    creationCode: null,
    upstreamTaskId: null,
    upstreamFingerprint: null,
    submittedAt: null,
    discoveredAt: null,
    completedAt: null,
    failedAt: null,
    unknownHoldUntil: null,
    errorCode: null,
    result: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function reservedJobId(input: AdmissionInput): string {
  if (input.jobId === undefined) {
    throw new Error("Scheduler did not provide a job ID before reservation");
  }
  return input.jobId;
}

function schedulerFor(
  runtimes: AccountRuntime[],
  options: {
    usage?: Record<string, { dayUsedPoints: number; monthUsedPoints: number }>;
    existing?: JobRecord | null;
    enabledRuntimes?: AccountRuntime[];
    reserve?: (
      accountId: string,
      input: AdmissionInput
    ) => AdmissionResult;
    globalCapacity?: CapacityManager;
  } = {}
): {
  scheduler: AccountScheduler;
  findByIdempotencyKeyHash: ReturnType<typeof vi.fn>;
  reserveOrGet: ReturnType<typeof vi.fn>;
  failAndRelease: ReturnType<typeof vi.fn>;
  globalCapacity: CapacityManager;
} {
  const records = new Map(runtimes.map((item) => [item.record.id, item.record]));
  const findByIdempotencyKeyHash = vi.fn(
    () => options.existing ?? null
  );
  const reserveOrGet = vi.fn((input: AdmissionInput): AdmissionResult => (
    options.reserve?.(input.accountId, input)
      ?? {
        outcome: "created" as const,
        job: job(input.accountId, {
          id: reservedJobId(input),
          quotedPoints: input.quotedPoints
        })
      }
  ));
  const failAndRelease = vi.fn();
  const globalCapacity = options.globalCapacity ?? new CapacityManager(10, 10);
  return {
    scheduler: new AccountScheduler({
      registry: {
        listEnabled: () => options.enabledRuntimes ?? runtimes,
        listRetained: () => runtimes,
        find: (accountId: string) =>
          runtimes.find((item) => item.record.id === accountId) ?? null,
        require: (accountId: string) => {
          const found = runtimes.find((item) => item.record.id === accountId);
          if (found === undefined) throw new Error("runtime unavailable");
          return found;
        }
      },
      accounts: {
        findById: (accountId: string) => records.get(accountId) ?? null,
        usage: (accountId: string) => options.usage?.[accountId] ?? {
          dayUsedPoints: 0,
          monthUsedPoints: 0
        }
      },
      admissions: {
        findByIdempotencyKeyHash,
        reserveOrGet,
        failAndRelease
      },
      capacity: globalCapacity,
      now: () => NOW
    }),
    findByIdempotencyKeyHash,
    reserveOrGet,
    failAndRelease,
    globalCapacity
  };
}

const admissionInput = {
  request,
  requestFingerprint: REQUEST_FINGERPRINT,
  idempotencyKeyHash: IDEMPOTENCY_HASH
};

describe("AccountScheduler", () => {
  it("orders candidates by priority, active jobs, last selection, then ID", async () => {
    const lowerPriority = runtime(record("acct_priority", {
      priority: 0,
      lastSelectedAt: NOW
    }));
    lowerPriority.capacity.restore("active-priority-a", "processing", null, NOW);
    lowerPriority.capacity.restore("active-priority-b", "processing", null, NOW);
    const fewerActive = runtime(record("acct_active", {
      priority: 0,
      lastSelectedAt: NOW
    }));
    fewerActive.capacity.restore("active-one", "processing", null, NOW);
    const olderSelection = runtime(record("acct_older", {
      priority: 0,
      lastSelectedAt: NOW - 1
    }));
    olderSelection.capacity.restore("active-two", "processing", null, NOW);
    const { scheduler } = schedulerFor([
      lowerPriority,
      fewerActive,
      olderSelection
    ]);

    const admitted = await scheduler.admit(admissionInput);

    if (!admitted.created) throw new Error("Expected a new admission");
    expect(admitted.runtime.record.id).toBe("acct_older");
    admitted.lease.release();
  });

  it("prefers a lower numeric priority before current load", async () => {
    const lowPriorityBusy = runtime(record("acct_low", { priority: 0 }));
    lowPriorityBusy.capacity.restore("busy", "processing", null, NOW);
    const highPriorityIdle = runtime(record("acct_high", { priority: 1 }));
    const { scheduler } = schedulerFor([highPriorityIdle, lowPriorityBusy]);

    const admitted = await scheduler.admit(admissionInput);

    if (!admitted.created) throw new Error("Expected a new admission");
    expect(admitted.runtime.record.id).toBe("acct_low");
    admitted.lease.release();
  });

  it.each([
    ["disabled", record("acct_disabled", { enabled: false }), {}, {}],
    ["unhealthy", record("acct_unhealthy", { healthStatus: "unhealthy" }), {}, {}],
    ["unsupported model", record("acct_model"), {
      resolve: () => Promise.reject(new Error("unsupported"))
    }, {}],
    ["insufficient wallet", record("acct_wallet"), {
      describe: () => Promise.resolve(snapshot(6))
    }, {}],
    ["daily budget", record("acct_daily", { dailyPointLimit: 10 }), {}, {
      dayUsedPoints: 4,
      monthUsedPoints: 0
    }],
    ["monthly budget", record("acct_monthly", { monthlyPointLimit: 10 }), {}, {
      dayUsedPoints: 0,
      monthUsedPoints: 4
    }],
  ] as const)(
    "rejects %s accounts without exposing account details",
    async (_name, accountRecord, runtimeOptions, usage) => {
      const candidate = runtime(accountRecord, runtimeOptions);
      const { scheduler, globalCapacity } = schedulerFor([candidate], {
        usage: { [accountRecord.id]: { dayUsedPoints: 0, monthUsedPoints: 0, ...usage } }
      });

      await expect(scheduler.admit(admissionInput)).rejects.toMatchObject({
        statusCode: 429,
        code: "lingjing_no_eligible_account"
      });
      expect(globalCapacity.counts()).toMatchObject({ active: 0, admitted: 0 });
    }
  );

  it("skips a full preferred account before persistence and admits the next candidate", async () => {
    const accountCapacity = new CapacityManager(1, 0);
    accountCapacity.restore("already-active", "processing", null, NOW);
    const preferred = runtime(record("acct_busy", { priority: 0 }), {
      capacity: accountCapacity
    });
    const fallback = runtime(record("acct_fallback", {
      priority: 1,
      lastSelectedAt: NOW
    }));
    const {
      scheduler,
      reserveOrGet,
      failAndRelease
    } = schedulerFor([preferred, fallback]);

    const admitted = await scheduler.admit(admissionInput);

    if (!admitted.created) throw new Error("Expected a new admission");
    expect(admitted.runtime.record.id).toBe("acct_fallback");
    expect(reserveOrGet).toHaveBeenCalledTimes(1);
    expect(reserveOrGet).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "acct_fallback"
    }));
    expect(failAndRelease).not.toHaveBeenCalled();
    expect(accountCapacity.activeJobIds()).toEqual(["already-active"]);
    admitted.lease.release();
  });

  it("reports temporary capacity exhaustion without persisting a job", async () => {
    const accountCapacity = new CapacityManager(1, 0);
    accountCapacity.restore("already-active", "processing", null, NOW);
    const candidate = runtime(record("acct_busy"), {
      capacity: accountCapacity
    });
    const {
      scheduler,
      reserveOrGet,
      failAndRelease,
      globalCapacity
    } = schedulerFor([candidate]);

    await expect(scheduler.admit(admissionInput)).rejects.toMatchObject({
      statusCode: 429,
      code: "lingjing_capacity_exhausted"
    });
    expect(reserveOrGet).not.toHaveBeenCalled();
    expect(failAndRelease).not.toHaveBeenCalled();
    expect(globalCapacity.counts()).toMatchObject({ active: 0, admitted: 0 });
  });

  it("accepts an unknown quote only for an unlimited account", async () => {
    const candidate = runtime(record("acct_unlimited"), {
      resolve: () => Promise.resolve({ ...model, pricing: null }),
      describe: () => Promise.resolve(snapshot(0))
    });
    const { scheduler, reserveOrGet } = schedulerFor([candidate]);

    const admitted = await scheduler.admit(admissionInput);

    expect(admitted.job.quotedPoints).toBeNull();
    expect(reserveOrGet).toHaveBeenCalledWith(expect.objectContaining({
      quotedPoints: null
    }));
    admitted.lease?.release();
  });

  it("rejects an unknown quote when either account limit is configured", async () => {
    const candidate = runtime(record("acct_limited", {
      monthlyPointLimit: 10
    }), {
      resolve: () => Promise.resolve({ ...model, pricing: null })
    });
    const { scheduler, reserveOrGet } = schedulerFor([candidate]);

    await expect(scheduler.admit(admissionInput)).rejects.toMatchObject({
      statusCode: 429,
      code: "lingjing_no_eligible_account"
    });
    expect(reserveOrGet).not.toHaveBeenCalled();
  });

  it("preserves request validation errors when every resolved model rejects media", async () => {
    const candidate = runtime(record("acct_media"));
    const { scheduler } = schedulerFor([candidate]);

    await expect(scheduler.admit({
      ...admissionInput,
      request: {
        ...request,
        media: [{
          kind: "image",
          source: {
            type: "prepared",
            media: {} as GenerationRequest["media"][number]["source"] extends {
              media: infer T;
            } ? T : never
          }
        }]
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_request"
    });
  });

  it("retries the next candidate when the transaction loses a budget race", async () => {
    const first = runtime(record("acct_first", { lastSelectedAt: NOW - 2 }));
    const second = runtime(record("acct_second", { lastSelectedAt: NOW - 1 }));
    const capacityAtReservation: Array<{
      accountId: string;
      active: number;
      admitted: number;
    }> = [];
    const { scheduler, reserveOrGet } = schedulerFor([first, second], {
      reserve: (accountId, input) => {
        const candidate = accountId === first.record.id ? first : second;
        const counts = candidate.capacity.counts();
        capacityAtReservation.push({
          accountId,
          active: counts.active,
          admitted: counts.admitted
        });
        if (accountId === first.record.id) {
          return { outcome: "budget_exhausted" };
        }
        return {
          outcome: "created",
          job: job(accountId, { id: reservedJobId(input) })
        };
      }
    });

    const admitted = await scheduler.admit(admissionInput);

    if (!admitted.created) throw new Error("Expected a new admission");
    expect(admitted.runtime.record.id).toBe("acct_second");
    expect(reserveOrGet).toHaveBeenCalledTimes(2);
    expect(capacityAtReservation).toEqual([
      { accountId: "acct_first", active: 1, admitted: 0 },
      { accountId: "acct_second", active: 1, admitted: 0 }
    ]);
    expect(first.capacity.counts()).toMatchObject({ active: 0, admitted: 0 });
    admitted.lease.release();
  });

  it("expires unknown capacity across every retained runtime", () => {
    const disabled = runtime(record("acct_disabled", {
      enabled: false
    }));
    disabled.capacity.restore("job-disabled-unknown", "unknown", NOW, NOW - 1);
    const { scheduler } = schedulerFor([disabled], {
      enabledRuntimes: []
    });

    scheduler.expireUnknown(NOW);

    expect(disabled.capacity.activeJobIds()).toEqual([]);
  });

  it("replays before candidate work when the bound runtime is unavailable", async () => {
    const resolve = vi.fn(() => Promise.resolve(model));
    const describe = vi.fn(() => Promise.resolve(snapshot()));
    const alternate = runtime(record("acct_alternate"), { resolve, describe });
    const existing = job("acct_original", { status: "processing" });
    const {
      scheduler,
      findByIdempotencyKeyHash,
      reserveOrGet,
      globalCapacity
    } = schedulerFor([alternate], {
      existing
    });

    const admitted = await scheduler.admit(admissionInput);

    expect(admitted).toEqual({
      created: false,
      lease: null,
      job: existing,
      runtime: null,
      model: null
    });
    expect(findByIdempotencyKeyHash).toHaveBeenCalledWith(IDEMPOTENCY_HASH);
    expect(reserveOrGet).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
    expect(globalCapacity.counts()).toMatchObject({ active: 0, admitted: 0 });
    expect(alternate.capacity.counts()).toMatchObject({ active: 0, admitted: 0 });
  });

  it("replays with zero eligible runtimes using the persisted apiId fingerprint", async () => {
    const inputContentHashes = ["c".repeat(64)];
    const existing = job("acct_original", {
      status: "processing",
      requestFingerprint: createRequestFingerprint({
        model: model.apiId,
        parameters: request.values,
        inputContentHashes
      })
    });
    const {
      scheduler,
      reserveOrGet,
      globalCapacity
    } = schedulerFor([], { existing });

    const admitted = await scheduler.admit({
      ...admissionInput,
      request: { ...request, model: model.alias },
      requestFingerprint: createRequestFingerprint({
        model: model.alias,
        parameters: request.values,
        inputContentHashes
      }),
      inputContentHashes
    });

    expect(admitted).toEqual({
      created: false,
      lease: null,
      job: existing,
      runtime: null,
      model: null
    });
    expect(reserveOrGet).not.toHaveBeenCalled();
    expect(globalCapacity.counts()).toMatchObject({ active: 0, admitted: 0 });
  });

  it("rejects a conflicting replay before candidate work", async () => {
    const existing = job("acct_original", {
      requestFingerprint: "c".repeat(64)
    });
    const {
      scheduler,
      reserveOrGet,
      globalCapacity
    } = schedulerFor([], { existing });

    await expect(scheduler.admit(admissionInput)).rejects.toMatchObject({
      code: "idempotency_conflict"
    });

    expect(reserveOrGet).not.toHaveBeenCalled();
    expect(globalCapacity.counts()).toMatchObject({ active: 0, admitted: 0 });
  });

  it("returns one lease that releases global and selected account capacity", async () => {
    const selected = runtime(record("acct_selected"));
    const { scheduler, globalCapacity } = schedulerFor([selected]);

    const admitted = await scheduler.admit(admissionInput);

    expect(admitted.created).toBe(true);
    expect(admitted.lease).not.toBeNull();
    expect(globalCapacity.activeJobIds()).toEqual([admitted.job.id]);
    expect(selected.capacity.activeJobIds()).toEqual([admitted.job.id]);
    admitted.lease?.release();
    expect(globalCapacity.activeJobIds()).toEqual([]);
    expect(selected.capacity.activeJobIds()).toEqual([]);
  });

  it("persists the canonical resolved model in the request fingerprint", async () => {
    const selected = runtime(record("acct_selected"));
    const { scheduler, reserveOrGet } = schedulerFor([selected]);
    const inputContentHashes = ["c".repeat(64)];

    const admitted = await scheduler.admit({
      ...admissionInput,
      request: { ...request, model: model.alias },
      inputContentHashes
    });

    expect(reserveOrGet).toHaveBeenCalledWith(expect.objectContaining({
      requestFingerprint: createRequestFingerprint({
        model: model.apiId,
        parameters: request.values,
        inputContentHashes
      })
    }));
    admitted.lease?.release();
  });

  it("preserves a precise catalog error instead of reporting no eligible account",async()=>{const candidate=runtime(record("acct_precise"),{resolve:()=>Promise.reject(errors.catalogChanged())}),{scheduler}=schedulerFor([candidate]),global=scheduler.start();await expect(scheduler.admit({...admissionInput,globalAdmission:global})).rejects.toMatchObject({code:"model_catalog_changed",statusCode:409});global.release();});

  it("keeps account queue order as a subsequence of staggered global order", async () => {
    const slowModel = deferred<NormalizedModel>();
    const slowResolutionStarted = deferred<undefined>();
    const globalCapacity = new CapacityManager(1, 2);
    const accountCapacity = new CapacityManager(1, 2);
    const globalBlocker = globalCapacity.restore(
      "global-blocker",
      "processing",
      null,
      NOW
    );
    const accountBlocker = accountCapacity.restore(
      "account-blocker",
      "processing",
      null,
      NOW
    );
    if (globalBlocker === null || accountBlocker === null) {
      throw new Error("Capacity blockers were not restored");
    }
    const candidate = runtime(record("acct_shared"), {
      capacity: accountCapacity,
      resolve: (value) => {
        if (value === "slow") {
          slowResolutionStarted.resolve(undefined);
          return slowModel.promise;
        }
        return Promise.resolve({ ...model, apiId: value });
      }
    });
    const reserveOrder: string[] = [];
    const completionOrder: string[] = [];
    const { scheduler } = schedulerFor([candidate], {
      globalCapacity,
      reserve: (_accountId, input) => {
        reserveOrder.push(input.model);
        return {
          outcome: "created",
          job: job("acct_shared", {
            id: reservedJobId(input),
            model: input.model,
            apiId: input.apiId
          })
        };
      }
    });

    const firstGlobal = scheduler.start();
    const first = scheduler.admit({
      ...admissionInput,
      request: { ...request, model: "slow", idempotencyKey: null },
      idempotencyKeyHash: null,
      globalAdmission: firstGlobal
    }).then((admitted) => {
      completionOrder.push("slow");
      admitted.lease?.release();
      return admitted;
    });
    await slowResolutionStarted.promise;
    const secondGlobal = scheduler.start();
    const second = scheduler.admit({
      ...admissionInput,
      request: { ...request, model: "fast", idempotencyKey: null },
      idempotencyKeyHash: null,
      globalAdmission: secondGlobal
    }).then((admitted) => {
      completionOrder.push("fast");
      admitted.lease?.release();
      return admitted;
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reserveOrder).toEqual([]);
    slowModel.resolve({ ...model, apiId: "slow" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reserveOrder).toEqual([]);
    globalBlocker.release();
    accountBlocker.release();

    await expect(Promise.race([
      Promise.all([first, second]),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("dual capacity acquisition deadlocked"));
        }, 1_000);
      })
    ])).resolves.toHaveLength(2);
    expect(reserveOrder).toEqual(["slow", "fast"]);
    expect(completionOrder).toEqual(["slow", "fast"]);
  });
});
