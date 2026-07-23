import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { StorageStateProvider } from "../../src/session/storage-state-provider.js";
import { CookieFileProvider } from "../../src/session/cookie-file-provider.js";
import { atomicWritePrivateJson } from "../../src/session/atomic-write.js";
import { stat } from "node:fs/promises";
import {
  copyFixtureToTemporaryFile,
  failingAtomicWriter,
  readValidStorageState,
  readFakeCsrfFromStorageState
} from "../helpers/session-fixtures.js";

const origin = "https://fixture.invalid";

describe("session providers", () => {
  it("imports Playwright cookies and mirrors csrfToken", async () => {
    const provider = new StorageStateProvider(
      new URL("./fixtures/storage-state.json", import.meta.url),
      new URL("./fixtures/session-profile.json", import.meta.url),
      undefined,
      new URL(origin)
    );
    const snapshot = await provider.load();
    expect(await snapshot.jar.getCookieString(origin)).toContain("csrfToken=fixture-csrf");
    expect(snapshot.csrfToken).toBe("fixture-csrf");
    expect(await provider.loadProfile()).toEqual({ originPin: "fixture-origin-pin" });
  });

  it("parses a Cookie header file without exposing it in describe output", async () => {
    const provider = new CookieFileProvider(
      new URL("./fixtures/cookie.txt", import.meta.url),
      new URL("./fixtures/session-profile.json", import.meta.url),
      new URL(origin)
    );
    const snapshot = await provider.load();
    expect(await snapshot.jar.getCookieString(origin)).toContain("fixture_session=value");
    expect(JSON.stringify(provider.describe())).not.toContain("value");
  });

  it("persists browser-state rotation but never rewrites a Cookie file", async () => {
    const browserPath = await copyFixtureToTemporaryFile("storage-state.json");
    const profilePath = await copyFixtureToTemporaryFile("session-profile.json");
    const browserProvider = new StorageStateProvider(browserPath, profilePath, undefined, new URL(origin));
    await browserProvider.load();
    await browserProvider.applySetCookies(new URL(origin), [
      "csrfToken=rotated-fixture-csrf; Path=/; Secure"
    ]);
    expect(await readFakeCsrfFromStorageState(browserPath)).toBe("rotated-fixture-csrf");

    const cookiePath = await copyFixtureToTemporaryFile("cookie.txt");
    const before = await readFile(cookiePath, "utf8");
    const cookieProvider = new CookieFileProvider(cookiePath, profilePath, new URL(origin));
    await cookieProvider.load();
    await cookieProvider.applySetCookies(new URL(origin), [
      "csrfToken=memory-only-fixture; Path=/; Secure"
    ]);
    expect(await readFile(cookiePath, "utf8")).toBe(before);
  });

  it("serializes concurrent browser-state cookie merges", async () => {
    const browserPath = await copyFixtureToTemporaryFile("storage-state.json");
    const profilePath = await copyFixtureToTemporaryFile("session-profile.json");
    const provider = new StorageStateProvider(browserPath, profilePath, undefined, new URL(origin));
    await provider.load();
    await Promise.all([
      provider.applySetCookies(new URL(origin), ["cookieA=fixture-a; Path=/; Secure"]),
      provider.applySetCookies(new URL(origin), ["cookieB=fixture-b; Path=/; Secure"])
    ]);
    const cookieHeader = await (await provider.load()).jar.getCookieString(origin);
    expect(cookieHeader).toContain("cookieA=fixture-a");
    expect(cookieHeader).toContain("cookieB=fixture-b");
  });

  it("leaves the previous browser-state file valid after atomic replacement failure", async () => {
    const browserPath = await copyFixtureToTemporaryFile("storage-state.json");
    const profilePath = await copyFixtureToTemporaryFile("session-profile.json");
    const provider = new StorageStateProvider(browserPath, profilePath, failingAtomicWriter, new URL(origin));
    await provider.load();
    await expect(provider.applySetCookies(new URL(origin), [
      "cookieA=fixture-a; Path=/; Secure"
    ])).rejects.toBeDefined();
    await expect(readValidStorageState(browserPath)).resolves.toBeDefined();
  });

  it.each([
    ["removes expired cookies", "remove-me=value; Path=/; Max-Age=0", "remove-me"],
    ["updates Path cookies", "api-cookie=updated; Path=/api; Secure", "api-cookie=updated"],
    ["keeps domain and host-only cookies distinct", "domain-cookie=updated; Domain=fixture.invalid; Path=/; Secure", "domain-cookie=updated"]
  ])("%s without reviving another cookie", async (_name, header, expected) => {
    const browserPath = await copyFixtureToTemporaryFile("storage-state.json");
    const profilePath = await copyFixtureToTemporaryFile("session-profile.json");
    const provider = new StorageStateProvider(browserPath, profilePath, undefined, new URL(origin));
    await provider.load();
    await provider.applySetCookies(new URL(origin), [header]);
    const state = await readValidStorageState(browserPath) as { cookies: Array<{ name: string; domain: string; path: string; value: string }> };
    if (expected === "remove-me") {
      expect(state.cookies.find((cookie) => cookie.name === expected)).toBeUndefined();
    } else {
      expect(state.cookies.some((cookie) => `${cookie.name}=${cookie.value}` === expected)).toBe(true);
    }
    expect(state.cookies.filter((cookie) => cookie.name === "fixture_session")).toHaveLength(1);
  });

  it("creates missing private-writer parent directories with restrictive permissions", async () => {
    const directory = await copyFixtureToTemporaryFile("session-profile.json");
    const target = `${directory}.parent/auth/profile.json`;
    await atomicWritePrivateJson(target, { originPin: "fixture-origin-pin" });
    expect(await readValidStorageState(target)).toEqual({ originPin: "fixture-origin-pin" });
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o077).toBe(0);
    }
  });
});
