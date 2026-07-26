import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetWindows } from "../../src/accounts/budget.js";
import { AccountRuntimeRegistry } from "../../src/accounts/runtime-registry.js";
import { AccountScheduler } from "../../src/accounts/scheduler.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import { SqliteAdmissionRepository } from "../../src/accounts/sqlite-admission-repository.js";
import type { AccountRecord } from "../../src/accounts/types.js";
import { parseConfig } from "../../src/config.js";
import { LingjingGenerationCoordinator } from "../../src/generation/coordinator.js";
import { JobRunnerRegistry } from "../../src/generation/runner-registry.js";
import { CapacityManager } from "../../src/jobs/capacity.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { accountSessionPaths, createSessionProvider } from "../../src/session/create-provider.js";
import type { SessionProvider } from "../../src/session/types.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeTestDirectory(directory);
  }
});

function transport(pointsBalance = 40): LingjingTransport {
  return {
    read<T>(path: string): Promise<T> {
      const responses: Record<string, unknown> = {
        "/api/user/describeBaseInfo": {},
        "/joycreator/team/space/menu/list": [{ spaceId: 0 }],
        "/joycreator/member/queryMember?pin=fixture-origin-pin": { membership: "fixture" },
        "/api/wallet/describeAccountCoupons": {
          pointsBalance,
          totalBalance: 55
        }
      };
      return Promise.resolve(responses[path] as T);
    },
    submitOnce: () => Promise.reject(new Error("not used")),
    uploadApi: () => Promise.reject(new Error("not used")),
    putSigned: () => Promise.reject(new Error("not used"))
  };
}

function accountRecord(id: string): AccountRecord {
  return {
    id,
    name: id,
    enabled: true,
    priority: 0,
    dailyPointLimit: 0,
    monthlyPointLimit: 0,
    authDirectory: "data/auth",
    healthStatus: "unknown",
    lastErrorCode: null,
    subjectHash: null,
    membership: null,
    pointsBalance: null,
    totalBalance: null,
    maxConcurrency: null,
    lastCheckedAt: null,
    lastSelectedAt: null,
    createdAt: 1,
    updatedAt: 1
  };
}

function session(): SessionProvider {
  return {
    mode: "browser-state",
    load: () => Promise.resolve({} as Awaited<ReturnType<SessionProvider["load"]>>),
    loadProfile: () => Promise.resolve({ originPin: "fixture-origin-pin" }),
    applySetCookies: () => Promise.resolve(),
    describe: () => ({ mode: "browser-state", source: "fixture", sourceMtimeMs: null, hasCsrf: false }),
    invalidate: () => undefined
  };
}

describe("AccountRuntimeRegistry", () => {
  it("derives generated account paths from the configured data directory", () => {
    const config = parseConfig({
      LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length",
      DATA_DIRECTORY: "fixture-data"
    });
    expect(accountSessionPaths(config, "acct_0123456789abcdef01234567")).toEqual({
      storageStatePath: join("fixture-data", "accounts", "acct_0123456789abcdef01234567", "storage-state.json"),
      cookieFilePath: join("fixture-data", "accounts", "acct_0123456789abcdef01234567", "cookie.txt"),
      sessionProfilePath: join("fixture-data", "accounts", "acct_0123456789abcdef01234567", "session-profile.json")
    });
    expect(() => accountSessionPaths(config, "legacy")).toThrow("Invalid account ID");
    expect(() => accountSessionPaths(config, "../../escape")).toThrow("Invalid account ID");
  });

  it("records the upstream membership in a ready account observation", async () => {
    const store = new SqliteStore(":memory:");
    const accounts = new SqliteAccountRepository(store);
    accounts.ensureLegacyAccount("data/auth");
    const registry = new AccountRuntimeRegistry({
      accounts,
      config: parseConfig({
        LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length"
      }),
      sessionFactory: () => Promise.resolve(session()),
      transportFactory: () => transport()
    });

    try {
      await registry.ready();
      expect(accounts.findById("legacy")).toMatchObject({
        healthStatus: "ready",
        membership: "fixture"
      });
    } finally {
      await registry.close();
      store.close();
    }
  });

  it("isolates enabled account sessions and refreshes one runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lingjing-runtime-"));
    temporaryDirectories.push(directory);
    const config = parseConfig({
      LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length",
      LINGJING_STORAGE_STATE: join(directory, "legacy-state.json"),
      LINGJING_SESSION_PROFILE: join(directory, "legacy-profile.json"),
      DATA_DIRECTORY: join(directory, "data")
    });
    const source = new URL("fixtures/", import.meta.url);
    await cp(source, directory, { recursive: true });
    await cp(join(directory, "storage-state.json"), config.storageStatePath);
    await cp(join(directory, "session-profile.json"), config.sessionProfilePath);

    const store = new SqliteStore(":memory:");
    const accounts = new SqliteAccountRepository(store);
    accounts.ensureLegacyAccount("data/auth");
    const second = accounts.create({ name: "Second", priority: 1, dailyPointLimit: 0, monthlyPointLimit: 0 });
    accounts.update(second.id, { enabled: true });
    const secondPaths = accountSessionPaths(config, second.id);
    await mkdir(dirname(secondPaths.storageStatePath), { recursive: true });
    await cp(join(directory, "storage-state.json"), secondPaths.storageStatePath, { recursive: true, force: true });
    await cp(join(directory, "session-profile.json"), secondPaths.sessionProfilePath, { recursive: true, force: true });

    const transportFactory = vi.fn(() => transport());
    const registry = new AccountRuntimeRegistry({
      accounts,
      config,
      sessionFactory: createSessionProvider,
      transportFactory
    });

    await registry.ready();
    expect(registry.listEnabled().map((runtime) => runtime.record.id))
      .toEqual(["legacy", second.id]);
    expect(registry.require("legacy").session)
      .not.toBe(registry.require(second.id).session);
    await registry.refresh(second.id);
    expect(transportFactory).toHaveBeenCalledTimes(3);
    await registry.close();
    store.close();
  });

  it("retains a usable disabled runtime but excludes it from new admissions", async () => {
    let disabled = { ...accountRecord("legacy"), enabled: false };
    const registry = new AccountRuntimeRegistry({
      accounts: {
        list: () => [disabled],
        findById: () => disabled,
        recordObservation: (_id, observation) => {
          disabled = {
            ...disabled,
            ...observation,
            lastCheckedAt: 1,
            updatedAt: 1
          };
          return disabled;
        }
      },
      config: parseConfig({
        LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length"
      }),
      sessionFactory: () => Promise.resolve(session()),
      transportFactory: () => transport()
    });

    await registry.ready();
    expect(registry.require("legacy").record.enabled).toBe(false);
    expect(registry.listEnabled()).toEqual([]);

    await registry.refresh("legacy");
    expect(registry.require("legacy").record.enabled).toBe(false);
    expect(registry.listEnabled()).toEqual([]);
  });

  it("serializes overlapping first refreshes and keeps the published coordination identity", async () => {
    const store = new SqliteStore(":memory:");
    const accounts = new SqliteAccountRepository(store);
    accounts.ensureLegacyAccount("data/auth");
    accounts.recordObservation("legacy", {
      healthStatus: "ready",
      lastErrorCode: null,
      subjectHash: "fixture-subject",
      membership: null,
      pointsBalance: 100,
      totalBalance: 100,
      maxConcurrency: 1
    });
    const repository = new SqliteJobRepository(store);
    const admissions = new SqliteAdmissionRepository(store);
    const admitted = admissions.reserveOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "fixture-image",
      apiId: "707",
      modelCode: "fixture-model",
      expectedAssetScene: "image-generation",
      requestFingerprint: "c".repeat(64),
      idempotencyKeyHash: null,
      spaceId: 0,
      accountId: "legacy",
      quotedPoints: 2,
      windows: budgetWindows()
    });
    if (admitted.outcome !== "created") {
      throw new Error("Fixture admission was not created");
    }
    repository.transition(admitted.job.id, ["queued"], {
      status: "submitting",
      submittedAt: Date.now()
    });
    const holdUntil = Date.now() + 60_000;
    const unknown = repository.transition(
      admitted.job.id,
      ["submitting"],
      { status: "unknown", unknownHoldUntil: holdUntil }
    );

    let refreshCalls = 0;
    let markSlowStarted: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const registry = new AccountRuntimeRegistry({
      accounts,
      config: parseConfig({
        LINGJING_API_KEY:
          "fixture-local-secret-with-sufficient-length",
        LINGJING_MAX_CONCURRENCY: "1",
        MAX_QUEUED_REQUESTS: "0"
      }),
      sessionFactory: async () => {
        refreshCalls += 1;
        if (refreshCalls === 2) {
          markSlowStarted?.();
          await slowGate;
        }
        return session();
      },
      transportFactory: () => transport()
    });

    const fastPromise = registry.refresh("legacy");
    const slowPromise = registry.refresh("legacy");
    const fast = await fastPromise;
    if (fast === null) throw new Error("Fast refresh did not publish");
    await slowStarted;
    const globalCapacity = new CapacityManager(1, 0);
    globalCapacity.restore(unknown.id, "unknown", holdUntil);
    fast.capacity.restore(unknown.id, "unknown", holdUntil);
    releaseSlow?.();
    const final = await slowPromise;
    if (final === null) throw new Error("Slow refresh did not publish");

    expect(final).not.toBe(fast);
    expect(registry.require("legacy")).toBe(final);
    expect(final.capacity).toBe(fast.capacity);
    expect(final.discoveryLock).toBe(fast.discoveryLock);
    expect(final.capacity.activeJobIds()).toEqual([unknown.id]);
    expect(() => final.capacity.admit("fixture-over-admission"))
      .toThrow("Generation capacity queue is full");

    const coordinator = new LingjingGenerationCoordinator({
      repository,
      capacity: globalCapacity,
      scheduler: new AccountScheduler({
        registry,
        accounts,
        admissions,
        capacity: globalCapacity
      }),
      admissions,
      prepareMedia: () => Promise.reject(
        new Error("Fixture does not prepare media")
      ),
      registry: new JobRunnerRegistry(),
      assetDiscoveryTimeoutMs: 30,
      unknownCapacityHoldMs: 60_000,
      taskPollIntervalMs: 1
    });
    expect(coordinator.resolveUnknown(
      "legacy",
      unknown.id,
      "release"
    )).toMatchObject({
      state: "released",
      job: { status: "failed" }
    });
    expect(globalCapacity.counts().active).toBe(0);
    expect(fast.capacity.counts().active).toBe(0);

    coordinator.stopPollers();
    await registry.close();
    repository.close();
    store.close();
  });

  it("continues a queued refresh after the previous refresh rejects", async () => {
    let current = accountRecord("legacy");
    let observationCalls = 0;
    let factoryCalls = 0;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const registry = new AccountRuntimeRegistry({
      accounts: {
        list: () => [],
        findById: () => current,
        recordObservation: (_id, observation) => {
          observationCalls += 1;
          if (observationCalls === 1) {
            throw new Error("fixture first observation failure");
          }
          current = {
            ...current,
            ...observation,
            lastCheckedAt: observationCalls,
            updatedAt: observationCalls
          };
          return current;
        }
      },
      config: parseConfig({
        LINGJING_API_KEY:
          "fixture-local-secret-with-sufficient-length"
      }),
      sessionFactory: () => {
        factoryCalls += 1;
        if (factoryCalls !== 1) return Promise.resolve(session());
        const firstSession = session();
        return Promise.resolve({
          ...firstSession,
          load: async () => {
            markFirstStarted?.();
            await firstGate;
            return {} as Awaited<
              ReturnType<SessionProvider["load"]>
            >;
          }
        });
      },
      transportFactory: () => transport()
    });

    const failed = registry.refresh("legacy");
    const failedResult = failed.then(
      (value) => ({ value, cause: null }),
      (cause: unknown) => ({ value: null, cause })
    );
    await firstStarted;
    const queued = registry.refresh("legacy");
    const queuedResult = queued.then(
      (value) => ({ value, cause: null }),
      (cause: unknown) => ({ value: null, cause })
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const callsWhileFirstWasBlocked = factoryCalls;
    releaseFirst?.();
    const [firstOutcome, queuedOutcome] = await Promise.all([
      failedResult,
      queuedResult
    ]);

    expect(firstOutcome.cause).toMatchObject({
      message: "fixture first observation failure"
    });
    expect(firstOutcome.value).toBeNull();
    expect(queuedOutcome.cause).toBeNull();
    expect(queuedOutcome.value).toMatchObject({
      record: { healthStatus: "ready" }
    });
    expect(callsWhileFirstWasBlocked).toBe(1);
    await expect(registry.refresh("legacy")).resolves.toMatchObject({
      record: { healthStatus: "ready" }
    });
    expect(factoryCalls).toBe(3);
  });

  it("allows different accounts to refresh concurrently", async () => {
    const first = accountRecord(
      "acct_0123456789abcdef01234567"
    );
    const second = accountRecord(
      "acct_89abcdef0123456701234567"
    );
    const records = new Map([
      [first.id, first],
      [second.id, second]
    ]);
    const started = new Set<string>();
    let markBothStarted: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    let releaseBoth: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const registry = new AccountRuntimeRegistry({
      accounts: {
        list: () => [],
        findById: (id) => records.get(id) ?? null,
        recordObservation: (id, observation) => ({
          ...(records.get(id) as AccountRecord),
          ...observation,
          lastCheckedAt: 1,
          updatedAt: 1
        })
      },
      config: parseConfig({
        LINGJING_API_KEY:
          "fixture-local-secret-with-sufficient-length"
      }),
      sessionFactory: async (_config, accountId) => {
        if (accountId === undefined) {
          throw new Error("Fixture account ID is required");
        }
        started.add(accountId);
        if (started.size === 2) markBothStarted?.();
        await gate;
        return session();
      },
      transportFactory: () => transport()
    });

    const firstRefresh = registry.refresh(first.id);
    const secondRefresh = registry.refresh(second.id);
    await bothStarted;
    expect(started).toEqual(new Set([first.id, second.id]));
    releaseBoth?.();
    await expect(Promise.all([firstRefresh, secondRefresh]))
      .resolves.toHaveLength(2);
  });

  it.each(["charge", "release"] as const)(
    "keeps coordination identity across disabled check and re-enable before unknown %s resolution",
    async (action) => {
      const store = new SqliteStore(":memory:");
      const accounts = new SqliteAccountRepository(store);
      accounts.ensureLegacyAccount("data/auth");
      const repository = new SqliteJobRepository(store);
      const admissions = new SqliteAdmissionRepository(store);
      let pointsBalance = 40;
      const transportFactory = vi.fn(() => transport(pointsBalance));
      const registry = new AccountRuntimeRegistry({
        accounts,
        config: parseConfig({
          LINGJING_API_KEY:
            "fixture-local-secret-with-sufficient-length",
          LINGJING_MAX_CONCURRENCY: "1",
          MAX_QUEUED_REQUESTS: "0"
        }),
        sessionFactory: () => Promise.resolve(session()),
        transportFactory
      });
      const globalCapacity = new CapacityManager(1, 0);
      const runnerRegistry = new JobRunnerRegistry();
      const scheduler = new AccountScheduler({
        registry,
        accounts,
        admissions,
        capacity: globalCapacity
      });
      const coordinator = new LingjingGenerationCoordinator({
        repository,
        capacity: globalCapacity,
        scheduler,
        admissions,
        prepareMedia: () => Promise.reject(
          new Error("Fixture does not prepare media")
        ),
        registry: runnerRegistry,
        assetDiscoveryTimeoutMs: 30,
        unknownCapacityHoldMs: 60_000,
        taskPollIntervalMs: 1
      });

      await registry.ready();
      const initial = registry.require("legacy");
      const initialCheckedAt = initial.record.lastCheckedAt;
      const admitted = admissions.reserveOrGet({
        kind: "image",
        sourceType: "image-generation",
        model: "fixture-image",
        apiId: "707",
        modelCode: "fixture-model",
        expectedAssetScene: "image-generation",
        requestFingerprint: (
          action === "charge" ? "a" : "b"
        ).repeat(64),
        idempotencyKeyHash: null,
        spaceId: 0,
        accountId: "legacy",
        quotedPoints: 2,
        windows: budgetWindows()
      });
      if (admitted.outcome !== "created") {
        throw new Error("Fixture admission was not created");
      }
      repository.transition(admitted.job.id, ["queued"], {
        status: "submitting",
        submittedAt: Date.now()
      });
      const holdUntil = Date.now() + 60_000;
      const unknown = repository.transition(
        admitted.job.id,
        ["submitting"],
        { status: "unknown", unknownHoldUntil: holdUntil }
      );
      globalCapacity.restore(
        unknown.id,
        unknown.status,
        holdUntil
      );
      initial.capacity.restore(
        unknown.id,
        unknown.status,
        holdUntil
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      pointsBalance = 73;
      accounts.update("legacy", { enabled: false });
      const checked = await registry.refresh("legacy");
      if (checked === null) throw new Error("Fixture runtime disappeared");
      expect(checked).not.toBe(initial);
      expect(checked.capacity).toBe(initial.capacity);
      expect(checked.discoveryLock).toBe(initial.discoveryLock);
      expect(checked.record).toMatchObject({
        enabled: false,
        healthStatus: "ready",
        pointsBalance: 73
      });
      expect(checked.record.lastCheckedAt).toBeGreaterThan(
        initialCheckedAt ?? 0
      );
      expect(transportFactory).toHaveBeenCalledTimes(2);
      expect(registry.listEnabled()).toEqual([]);

      accounts.update("legacy", { enabled: true });
      const reenabled = await registry.refresh("legacy");
      if (reenabled === null) {
        throw new Error("Fixture runtime was not re-enabled");
      }
      expect(reenabled).not.toBe(checked);
      expect(reenabled.capacity).toBe(initial.capacity);
      expect(reenabled.discoveryLock).toBe(initial.discoveryLock);
      expect(registry.listEnabled()).toEqual([reenabled]);
      expect(() => reenabled.capacity.admit("fixture-over-admission"))
        .toThrow("Generation capacity queue is full");

      const resolved = coordinator.resolveUnknown(
        "legacy",
        unknown.id,
        action
      );
      expect(resolved.state).toBe(
        action === "charge" ? "charged" : "released"
      );
      expect(globalCapacity.counts().active).toBe(0);
      expect(initial.capacity.counts().active).toBe(0);

      coordinator.stopPollers();
      await registry.close();
      repository.close();
      store.close();
    }
  );

  it("retains bound runtime services when a refresh becomes unhealthy", async () => {
    let current = accountRecord("legacy");
    let failSession = false;
    const registry = new AccountRuntimeRegistry({
      accounts: {
        list: () => [current],
        findById: () => current,
        recordObservation: (_id, observation) => {
          current = {
            ...current,
            ...observation,
            lastCheckedAt: 2,
            updatedAt: 2
          };
          return current;
        }
      },
      config: parseConfig({
        LINGJING_API_KEY:
          "fixture-local-secret-with-sufficient-length"
      }),
      sessionFactory: () => failSession
        ? Promise.reject(new Error("fixture session rebuild failure"))
        : Promise.resolve(session()),
      transportFactory: () => transport()
    });

    await registry.ready();
    const initial = registry.require("legacy");
    initial.capacity.restore(
      "job-bound",
      "processing",
      null
    );
    failSession = true;

    const refreshed = await registry.refresh("legacy");

    expect(refreshed).toBe(initial);
    expect(registry.require("legacy")).toBe(initial);
    expect(initial.record).toMatchObject({
      healthStatus: "unhealthy",
      lastErrorCode: "lingjing_runtime_unhealthy"
    });
    expect(initial.capacity.activeJobIds()).toEqual(["job-bound"]);
    expect(registry.listEnabled()).toEqual([]);
  });

  it("keeps a healthy runtime when another transport factory fails", async () => {
    const legacy = accountRecord("legacy");
    const second = accountRecord("acct_0123456789abcdef01234567");
    const observations: Array<{ id: string; healthStatus: string }> = [];
    let transports = 0;
    const registry = new AccountRuntimeRegistry({
      accounts: {
        list: () => [legacy, second],
        findById: () => null,
        recordObservation: (id, observation) => {
          observations.push({ id, healthStatus: observation.healthStatus });
          return { ...(id === legacy.id ? legacy : second), ...observation, lastCheckedAt: 1, updatedAt: 1 };
        }
      },
      config: parseConfig({ LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length" }),
      sessionFactory: () => Promise.resolve(session()),
      transportFactory: () => {
        if (transports++ === 0) return transport();
        throw new Error("fixture transport failure");
      }
    });

    await registry.ready();
    expect(registry.listEnabled().map((runtime) => runtime.record.id)).toEqual(["legacy"]);
    expect(observations).toContainEqual({ id: second.id, healthStatus: "unhealthy" });
  });

  it("records unexpected session setup failures as unhealthy", async () => {
    const legacy = accountRecord("legacy");
    const observations: string[] = [];
    const registry = new AccountRuntimeRegistry({
      accounts: {
        list: () => [legacy],
        findById: () => legacy,
        recordObservation: (_id, observation) => {
          observations.push(observation.healthStatus);
          return { ...legacy, ...observation, lastCheckedAt: 1, updatedAt: 1 };
        }
      },
      config: parseConfig({ LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length" }),
      sessionFactory: () => Promise.reject(new Error("fixture I/O failure"))
    });

    await registry.ready();
    expect(observations).toEqual(["unhealthy"]);
  });

  it("propagates repository failures while recording a ready observation", async () => {
    const legacy = accountRecord("legacy");
    const registry = new AccountRuntimeRegistry({
      accounts: {
        list: () => [legacy],
        findById: () => legacy,
        recordObservation: (_id, observation) => {
          if (observation.healthStatus === "ready") throw new Error("fixture repository failure");
          return { ...legacy, ...observation, lastCheckedAt: 1, updatedAt: 1 };
        }
      },
      config: parseConfig({ LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length" }),
      sessionFactory: () => Promise.resolve(session()),
      transportFactory: () => transport()
    });

    await expect(registry.ready()).rejects.toThrow("fixture repository failure");
  });
});
