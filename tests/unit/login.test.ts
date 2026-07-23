import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runLoginCli } from "../../src/cli/login.js";
import { copyFixtureToTemporaryFile } from "../helpers/session-fixtures.js";

describe("login CLI", () => {
  it("returns non-zero with a concise cancellation and leaves no private artifacts", async () => {
    const marker = await copyFixtureToTemporaryFile("session-profile.json");
    const directory = marker.slice(0, marker.lastIndexOf("\\"));
    const storageStatePath = `${directory}\\storage-state.json`;
    const sessionProfilePath = `${directory}\\new-profile.json`;
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
