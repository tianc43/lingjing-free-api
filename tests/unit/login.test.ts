import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseLoginArguments, runLoginCli, waitForAuthenticatedPage } from "../../src/cli/login.js";
import { copyFixtureToTemporaryFile } from "../helpers/session-fixtures.js";

describe("login CLI", () => {
  it("accepts only generated account IDs for the account login option", () => {
    expect(parseLoginArguments(["--account-id", "acct_0123456789abcdef01234567"]))
      .toEqual({ accountId: "acct_0123456789abcdef01234567" });
    expect(parseLoginArguments([])).toEqual({});
    expect(() => parseLoginArguments(["--account-id", "legacy"])).toThrow("Invalid account ID");
    expect(() => parseLoginArguments(["--account-id", "../../escape"])).toThrow("Invalid account ID");
  });

  it("reads authenticated state and origin pin in one browser evaluation", async () => {
    vi.stubGlobal("location", { origin: "https://lingjing.jdcloud.com" });
    vi.stubGlobal("fetch", () => Promise.resolve({ json: () => Promise.resolve({ result: { user: "fixture" } }) }));
    vi.stubGlobal("window", { JDCloud: { account: { originPin: "fixture-origin-pin" } } });
    let evaluations = 0;
    const pin = await waitForAuthenticatedPage({
      goto: () => Promise.resolve(undefined),
      url: () => "https://lingjing.jdcloud.com/",
      evaluate: async <T>(callback: () => T | Promise<T>) => {
        evaluations += 1;
        return callback();
      },
      isClosed: () => false,
      waitForTimeout: () => Promise.resolve(undefined)
    });
    expect(pin).toBe("fixture-origin-pin");
    expect(evaluations).toBe(1);
    vi.unstubAllGlobals();
  });

  it("checks the page origin before requesting authenticated browser state", async () => {
    let fetches = 0;
    vi.stubGlobal("location", { origin: "https://fixture.invalid" });
    vi.stubGlobal("fetch", () => {
      fetches += 1;
      return Promise.resolve({ json: () => Promise.resolve({ result: { user: "fixture" } }) });
    });
    vi.stubGlobal("window", { JDCloud: { account: { originPin: "fixture-origin-pin" } } });
    await expect(waitForAuthenticatedPage({
      goto: () => Promise.resolve(undefined),
      url: () => "https://lingjing.jdcloud.com/",
      evaluate: <T>(callback: () => T | Promise<T>) => Promise.resolve(callback()),
      isClosed: () => true,
      waitForTimeout: () => Promise.resolve(undefined)
    })).rejects.toThrow("Login cancelled before completion.");
    expect(fetches).toBe(0);
    vi.unstubAllGlobals();
  });

  it("waits through the JD login origin until the page returns authenticated", async () => {
    let evaluations = 0;
    let fetches = 0;
    const pin = await waitForAuthenticatedPage({
      goto: () => Promise.resolve(undefined),
      url: () => evaluations === 0
        ? "https://passport.jd.com/new/login.aspx"
        : "https://lingjing.jdcloud.com/",
      evaluate: async <T>(callback: () => T | Promise<T>) => {
        evaluations += 1;
        vi.stubGlobal("location", {
          origin: evaluations === 1
            ? "https://passport.jd.com"
            : "https://lingjing.jdcloud.com"
        });
        vi.stubGlobal("fetch", () => {
          fetches += 1;
          return Promise.resolve({ json: () => Promise.resolve({ result: { user: "fixture" } }) });
        });
        vi.stubGlobal("window", { JDCloud: { account: { originPin: "fixture-origin-pin" } } });
        return callback();
      },
      isClosed: () => false,
      waitForTimeout: () => Promise.resolve(undefined)
    });
    expect(pin).toBe("fixture-origin-pin");
    expect(evaluations).toBe(2);
    expect(fetches).toBe(1);
    vi.unstubAllGlobals();
  });

  it("returns non-zero with a concise cancellation and leaves no private artifacts", async () => {
    const marker = await copyFixtureToTemporaryFile("session-profile.json");
    const directory = dirname(marker);
    const storageStatePath = join(directory, "storage-state.json");
    const sessionProfilePath = join(directory, "new-profile.json");
    const messages: string[] = [];
    const exitCode = await runLoginCli({ storageStatePath, sessionProfilePath }, () => Promise.resolve({
      newContext: () => Promise.resolve({
        newPage: () => Promise.resolve({
          goto: () => Promise.resolve(undefined),
          url: () => "https://lingjing.jdcloud.com/",
          evaluate: <T>() => Promise.reject<T>(new Error("browser closed")),
          isClosed: () => true,
          waitForTimeout: () => Promise.resolve(undefined)
        }),
        storageState: () => Promise.resolve({ cookies: [], origins: [] }),
        close: () => Promise.resolve(undefined)
      }),
      close: () => Promise.resolve(undefined)
    }), (message) => messages.push(message));
    expect(exitCode).toBe(1);
    expect(messages).toEqual(["Login cancelled before completion."]);
    expect(existsSync(storageStatePath)).toBe(false);
    expect(existsSync(sessionProfilePath)).toBe(false);
    expect((await (await import("node:fs/promises")).readdir(directory)).filter((name) => name.includes(".tmp") || name.includes(".bak"))).toEqual([]);
  });
});
