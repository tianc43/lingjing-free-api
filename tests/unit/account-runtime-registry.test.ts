import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRuntimeRegistry } from "../../src/accounts/runtime-registry.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import type { AccountRecord } from "../../src/accounts/types.js";
import { parseConfig } from "../../src/config.js";
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

function transport(): LingjingTransport {
  return {
    read<T>(path: string): Promise<T> {
      const responses: Record<string, unknown> = {
        "/api/user/describeBaseInfo": {},
        "/joycreator/team/space/menu/list": [{ spaceId: 0 }],
        "/joycreator/member/queryMember?pin=fixture-origin-pin": { membership: "fixture" },
        "/api/wallet/describeAccountCoupons": { pointsBalance: 40, totalBalance: 55 }
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
