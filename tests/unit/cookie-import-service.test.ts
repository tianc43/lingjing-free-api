import { readFile, readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CookieImportRollbackError,
  CookieImportService,
} from "../../src/accounts/cookie-import-service.js";
import type { AccountRuntimeRegistry } from "../../src/accounts/runtime-registry.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import { parseConfig } from "../../src/config.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const filesystem = vi.hoisted(() => ({
  events: [] as string[],
  failRemove: false,
  removeCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (...arguments_: Parameters<typeof actual.rm>) => {
      filesystem.removeCalls += 1;
      filesystem.events.push("session");
      if (filesystem.failRemove) {
        return Promise.reject(new Error("fixture session cleanup failure"));
      }
      return actual.rm(...arguments_);
    },
  };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  filesystem.failRemove = false;
  filesystem.removeCalls = 0;
  filesystem.events = [];
  for (const directory of temporaryDirectories.splice(0)) {
    removeTestDirectory(directory);
  }
});

const validInput = {
  account: {
    name: "Primary subscription",
    priority: 1,
    dailyPointLimit: 0,
    monthlyPointLimit: 0,
  },
  cookies: {
    format: "header" as const,
    value: "csrfToken=fixture-csrf; pin=fixture%2Dpin; thor=fixture-auth",
  },
};

async function fixture(
  sessionMode: "browser-state" | "cookie-file" = "browser-state",
) {
  const directory = await mkdtemp(join(tmpdir(), "lingjing-cookie-import-"));
  temporaryDirectories.push(directory);
  const config = parseConfig({
    LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length",
    DATA_DIRECTORY: join(directory, "data"),
    SESSION_MODE: sessionMode,
  });
  const store = new SqliteStore(":memory:");
  const accounts = new SqliteAccountRepository(store);
  const runtimes = {
    retire: vi.fn<Pick<AccountRuntimeRegistry, "retire">["retire"]>(() =>
      Promise.resolve(),
    ),
    refresh: vi.fn<Pick<AccountRuntimeRegistry, "refresh">["refresh"]>(() =>
      Promise.resolve({
        record: { healthStatus: "ready" },
      } as Awaited<ReturnType<AccountRuntimeRegistry["refresh"]>>),
    ),
  };
  const describeAccount = vi.fn(() =>
    Promise.resolve({
      subject: "fixture-subject",
      spaceId: 0,
      membership: "premium",
      maxConcurrency: 2,
      pointsBalance: 120,
      couponBalance: 0,
      availableAmount: 0,
      totalBalance: 150,
      resourcePackages: [],
    }),
  );
  const importer = new CookieImportService({
    accounts,
    config,
    runtimes,
    describeAccount,
  });
  return { accounts, config, describeAccount, importer, runtimes, store };
}

describe("CookieImportService", () => {
  it("persists and enables only a session validated upstream", async () => {
    const { config, importer, store } = await fixture();

    try {
      const account = await importer.import(validInput);

      expect(account).toMatchObject({
        enabled: true,
        healthStatus: "ready",
        membership: "premium",
        pointsBalance: 120,
        totalBalance: 150,
      });
      expect(JSON.stringify(account)).not.toContain("fixture-csrf");
      expect(JSON.stringify(account)).not.toContain("fixture-pin");
      await expect(
        readdir(join(config.dataDirectory, "accounts", account.id)),
      ).resolves.toEqual(["session-profile.json", "storage-state.json"]);
    } finally {
      store.close();
    }
  });

  it("replaces an existing account session without changing its identity or budgets", async () => {
    const { config, describeAccount, importer, runtimes, store } =
      await fixture();

    try {
      const original = await importer.import(validInput);
      describeAccount.mockResolvedValueOnce({
        subject: "fixture-subject",
        spaceId: 0,
        membership: "premium-renewed",
        maxConcurrency: 3,
        pointsBalance: 220,
        couponBalance: 0,
        availableAmount: 0,
        totalBalance: 250,
        resourcePackages: [],
      });
      const updated = await importer.replace(original.id, {
        format: "header",
        value:
          "csrfToken=fixture-renewed-csrf; pin=fixture%2Dpin; thor=fixture-renewed-auth",
      });

      expect(updated).toMatchObject({
        id: original.id,
        name: original.name,
        enabled: original.enabled,
        dailyPointLimit: original.dailyPointLimit,
        monthlyPointLimit: original.monthlyPointLimit,
        membership: "premium-renewed",
        pointsBalance: 220,
        totalBalance: 250,
      });
      expect(runtimes.refresh).toHaveBeenCalledTimes(2);
      const storage = await readFile(
        join(
          config.dataDirectory,
          "accounts",
          original.id,
          "storage-state.json",
        ),
        "utf8",
      );
      expect(storage).toContain("fixture-renewed-csrf");
      expect(storage).not.toContain("fixture-csrf");
    } finally {
      store.close();
    }
  });

  it("keeps existing session files when replacement validation fails", async () => {
    const { config, describeAccount, importer, store } = await fixture();

    try {
      const original = await importer.import(validInput);
      const storagePath = join(
        config.dataDirectory,
        "accounts",
        original.id,
        "storage-state.json",
      );
      const before = await readFile(storagePath, "utf8");
      describeAccount.mockRejectedValueOnce(new Error("replacement expired"));

      await expect(
        importer.replace(original.id, {
          format: "header",
          value:
            "csrfToken=fixture-bad-csrf; pin=fixture%2Dpin; thor=fixture-bad-auth",
        }),
      ).rejects.toThrow("replacement expired");
      await expect(readFile(storagePath, "utf8")).resolves.toBe(before);
    } finally {
      store.close();
    }
  });

  it("restores the previous session and observation when runtime publication fails", async () => {
    const { accounts, config, describeAccount, importer, runtimes, store } =
      await fixture();

    try {
      const original = await importer.import(validInput);
      const storagePath = join(
        config.dataDirectory,
        "accounts",
        original.id,
        "storage-state.json",
      );
      const profilePath = join(
        config.dataDirectory,
        "accounts",
        original.id,
        "session-profile.json",
      );
      const [storageBefore, profileBefore] = await Promise.all([
        readFile(storagePath, "utf8"),
        readFile(profilePath, "utf8"),
      ]);
      describeAccount.mockResolvedValueOnce({
        subject: "fixture-replacement-subject",
        spaceId: 0,
        membership: "fixture-replacement-membership",
        maxConcurrency: 3,
        pointsBalance: 220,
        couponBalance: 0,
        availableAmount: 0,
        totalBalance: 250,
        resourcePackages: [],
      });
      runtimes.refresh.mockResolvedValueOnce(null).mockResolvedValueOnce({
        record: { healthStatus: "ready" },
      } as Awaited<ReturnType<AccountRuntimeRegistry["refresh"]>>);

      await expect(
        importer.replace(original.id, {
          format: "header",
          value:
            "csrfToken=fixture-failed-refresh-csrf; pin=fixture%2Dpin; thor=fixture-failed-refresh-auth",
        }),
      ).rejects.toThrow("Updated account runtime is not ready");

      await expect(readFile(storagePath, "utf8")).resolves.toBe(storageBefore);
      await expect(readFile(profilePath, "utf8")).resolves.toBe(profileBefore);
      expect(accounts.findById(original.id)).toMatchObject({
        healthStatus: original.healthStatus,
        lastErrorCode: original.lastErrorCode,
        membership: original.membership,
        pointsBalance: original.pointsBalance,
        totalBalance: original.totalBalance,
        maxConcurrency: original.maxConcurrency,
      });
      expect(runtimes.refresh).toHaveBeenCalledTimes(3);
    } finally {
      store.close();
    }
  });

  it("retains neither account nor session files after validation failure", async () => {
    const { accounts, config, describeAccount, importer, store } =
      await fixture();
    describeAccount.mockRejectedValueOnce(new Error("expired"));

    try {
      await expect(importer.import(validInput)).rejects.toThrow("expired");
      expect(accounts.list().map((account) => account.name)).not.toContain(
        "Primary subscription",
      );
      await expect(
        readdir(join(config.dataDirectory, "accounts")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      store.close();
    }
  });

  it("rolls back a newly persisted account after runtime refresh fails", async () => {
    const { accounts, config, importer, runtimes, store } = await fixture();
    runtimes.refresh.mockRejectedValueOnce(
      new Error("upstream refresh failure"),
    );

    try {
      await expect(importer.import(validInput)).rejects.toThrow(
        "upstream refresh failure",
      );
      expect(accounts.list().map((account) => account.name)).not.toContain(
        "Primary subscription",
      );
      await expect(
        readdir(join(config.dataDirectory, "accounts")),
      ).resolves.toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rolls back when runtime refresh returns no runtime", async () => {
    const { accounts, config, importer, runtimes, store } = await fixture();
    runtimes.refresh.mockResolvedValueOnce(null);

    try {
      await expect(importer.import(validInput)).rejects.toThrow(
        "Imported account runtime is not ready",
      );
      expect(accounts.list().map((account) => account.name)).not.toContain(
        "Primary subscription",
      );
      await expect(
        readdir(join(config.dataDirectory, "accounts")),
      ).resolves.toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rolls back when runtime refresh returns a non-ready runtime", async () => {
    const { accounts, config, importer, runtimes, store } = await fixture();
    runtimes.refresh.mockResolvedValueOnce({
      record: { healthStatus: "unhealthy" },
    } as Awaited<ReturnType<AccountRuntimeRegistry["refresh"]>>);

    try {
      await expect(importer.import(validInput)).rejects.toThrow(
        "Imported account runtime is not ready",
      );
      expect(accounts.list().map((account) => account.name)).not.toContain(
        "Primary subscription",
      );
      await expect(
        readdir(join(config.dataDirectory, "accounts")),
      ).resolves.toEqual([]);
    } finally {
      store.close();
    }
  });

  it("keeps a disabled account tombstone and does not delete its row when session cleanup fails", async () => {
    const { accounts, config, importer, runtimes, store } = await fixture();
    const removeUnbound = vi.spyOn(accounts, "removeUnbound");
    runtimes.refresh.mockRejectedValueOnce(
      new Error("upstream refresh failure"),
    );
    filesystem.failRemove = true;

    try {
      const failure = await importer
        .import(validInput)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CookieImportRollbackError);
      expect(failure).toMatchObject({
        code: "cookie_import_rollback_incomplete",
        message: "Cookie import failed and rollback was incomplete",
      });
      expect(JSON.stringify(failure)).not.toContain("fixture-csrf");
      expect(JSON.stringify(failure)).not.toContain("accounts");
      expect(removeUnbound).not.toHaveBeenCalled();
      expect(accounts.list()).toContainEqual(
        expect.objectContaining({
          name: "Primary subscription",
          enabled: false,
        }),
      );
      await expect(
        readdir(join(config.dataDirectory, "accounts")),
      ).resolves.toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("removes the session before row cleanup and keeps the disabled row when row cleanup fails", async () => {
    const { accounts, config, describeAccount, runtimes, store } =
      await fixture();
    const removeUnbound = vi.fn(() => {
      filesystem.events.push("row");
      throw new Error("fixture database cleanup failure");
    });
    const update = vi.fn<SqliteAccountRepository["update"]>((id, patch) => {
      if (patch.enabled === false) filesystem.events.push("disable");
      return accounts.update(id, patch);
    });
    const importer = new CookieImportService({
      accounts: {
        create: accounts.create.bind(accounts),
        findById: accounts.findById.bind(accounts),
        recordObservation: accounts.recordObservation.bind(accounts),
        removeUnbound,
        update,
      },
      config,
      runtimes,
      describeAccount,
    });
    runtimes.refresh.mockRejectedValueOnce(
      new Error("upstream refresh failure"),
    );

    try {
      const failure = await importer
        .import(validInput)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CookieImportRollbackError);
      expect(failure).toMatchObject({
        code: "cookie_import_rollback_incomplete",
        message: "Cookie import failed and rollback was incomplete",
      });
      expect(filesystem.events).toEqual(["disable", "session", "row"]);
      expect(removeUnbound).toHaveBeenCalledTimes(1);
      expect(filesystem.removeCalls).toBe(1);
      await expect(
        readdir(join(config.dataDirectory, "accounts")),
      ).resolves.toEqual([]);
      expect(accounts.list()).toContainEqual(
        expect.objectContaining({
          name: "Primary subscription",
          enabled: false,
        }),
      );
    } finally {
      store.close();
    }
  });

  it("does not remove the session or row when disabling the account fails", async () => {
    const { accounts, config, describeAccount, runtimes, store } =
      await fixture();
    const removeUnbound = vi.fn(() => {
      filesystem.events.push("row");
      accounts.removeUnbound("unreachable");
    });
    const update = vi.fn<SqliteAccountRepository["update"]>((id, patch) => {
      if (patch.enabled === false) {
        filesystem.events.push("disable");
        throw new Error("fixture disable failure C:\\private\\session");
      }
      return accounts.update(id, patch);
    });
    const importer = new CookieImportService({
      accounts: {
        create: accounts.create.bind(accounts),
        findById: accounts.findById.bind(accounts),
        recordObservation: accounts.recordObservation.bind(accounts),
        removeUnbound,
        update,
      },
      config,
      runtimes,
      describeAccount,
    });
    runtimes.refresh.mockRejectedValueOnce(
      new Error("upstream refresh failure"),
    );

    try {
      const failure = await importer
        .import(validInput)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CookieImportRollbackError);
      expect(failure).toMatchObject({
        code: "cookie_import_rollback_incomplete",
        message: "Cookie import failed and rollback was incomplete",
      });
      expect(JSON.stringify(failure)).not.toContain("private");
      expect(filesystem.events).toEqual(["disable"]);
      expect(filesystem.removeCalls).toBe(0);
      expect(removeUnbound).not.toHaveBeenCalled();
      expect(accounts.list()).toContainEqual(
        expect.objectContaining({
          name: "Primary subscription",
          enabled: true,
        }),
      );
      const account = accounts
        .list()
        .find((candidate) => candidate.name === "Primary subscription");
      if (account === undefined) throw new Error("Expected retained account");
      await expect(
        readdir(join(config.dataDirectory, "accounts", account.id)),
      ).resolves.toEqual(["session-profile.json", "storage-state.json"]);
    } finally {
      store.close();
    }
  });

  it("rejects cookie-file mode before validating or creating an account", async () => {
    const { accounts, config, describeAccount, importer, store } =
      await fixture("cookie-file");

    try {
      await expect(importer.import(validInput)).rejects.toThrow(
        "Cookie imports require browser-state sessions",
      );
      expect(describeAccount).not.toHaveBeenCalled();
      expect(accounts.list().map((account) => account.name)).not.toContain(
        "Primary subscription",
      );
      await expect(
        readdir(join(config.dataDirectory, "accounts")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      store.close();
    }
  });
});
