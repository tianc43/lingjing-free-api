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
