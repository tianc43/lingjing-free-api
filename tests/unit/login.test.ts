import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runLoginCli, waitForAuthenticatedPage } from "../../src/cli/login.js";
import { copyFixtureToTemporaryFile } from "../helpers/session-fixtures.js";

describe("login CLI", () => {
  it("reads authenticated state and origin pin in one browser evaluation", async () => {
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
