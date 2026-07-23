import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { StorageStateProvider } from "../../src/session/storage-state-provider.js";
import { CookieFileProvider } from "../../src/session/cookie-file-provider.js";
import { atomicWritePrivateJson, atomicWritePrivateJsonPair } from "../../src/session/atomic-write.js";
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

  it("serializes positive Max-Age as an absolute expiry and leaves missing SameSite unset", async () => {
    const browserPath = await copyFixtureToTemporaryFile("storage-state.json");
    const profilePath = await copyFixtureToTemporaryFile("session-profile.json");
    const provider = new StorageStateProvider(browserPath, profilePath, undefined, new URL(origin));
    const before = Math.floor(Date.now() / 1000);
    await provider.load();
    await provider.applySetCookies(new URL(origin), ["max-age-cookie=value; Max-Age=120; Path=/; Secure"]);
    const state = await readValidStorageState(browserPath) as { cookies: Array<{ name: string; expires: number; sameSite?: string }> };
    const cookie = state.cookies.find((item) => item.name === "max-age-cookie");
    expect(cookie?.expires).toBeGreaterThanOrEqual(before + 119);
    expect(cookie?.expires).toBeLessThanOrEqual(before + 121);
    expect(cookie).not.toHaveProperty("sameSite");
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

  it("restores both existing files and cleans artifacts when the second replacement fails", async () => {
    const storagePath = await copyFixtureToTemporaryFile("storage-state.json");
    const profilePath = await copyFixtureToTemporaryFile("session-profile.json");
    const beforeStorage = await readFile(storagePath, "utf8");
    const beforeProfile = await readFile(profilePath, "utf8");
    await expect(atomicWritePrivateJsonPair([
      { targetPath: storagePath, value: { changed: "storage" } },
      { targetPath: profilePath, value: { changed: "profile" } }
    ], async (from, to) => {
      if (to === profilePath && from.endsWith(".tmp")) throw new Error("second replacement failed");
      await (await import("node:fs/promises")).rename(from, to);
    })).rejects.toThrow("second replacement failed");
    expect(await readFile(storagePath, "utf8")).toBe(beforeStorage);
    expect(await readFile(profilePath, "utf8")).toBe(beforeProfile);
    expect((await readdir(dirname(storagePath))).filter((name) => name.includes(".tmp") || name.includes(".bak"))).toEqual([]);
  });

  it("leaves no half-pair or artifacts when replacement fails before absent targets are created", async () => {
    const original = await copyFixtureToTemporaryFile("session-profile.json");
    const directory = join(dirname(original), "absent");
    const storagePath = join(directory, "storage-state.json");
    const profilePath = join(directory, "session-profile.json");
    await expect(atomicWritePrivateJsonPair([
      { targetPath: storagePath, value: { storage: true } },
      { targetPath: profilePath, value: { profile: true } }
    ], async (from, to) => {
      if (to === profilePath && from.endsWith(".tmp")) throw new Error("second replacement failed");
      await (await import("node:fs/promises")).rename(from, to);
    })).rejects.toThrow("second replacement failed");
    await expect(readFile(storagePath, "utf8")).rejects.toBeDefined();
    await expect(readFile(profilePath, "utf8")).rejects.toBeDefined();
    expect((await readdir(directory)).filter((name) => name.includes(".tmp") || name.includes(".bak"))).toEqual([]);
  });

  it("cleans every temporary file when preparing the second file fails", async () => {
    const storagePath = await copyFixtureToTemporaryFile("storage-state.json");
    const profilePath = await copyFixtureToTemporaryFile("session-profile.json");
    const beforeStorage = await readFile(storagePath, "utf8");
    const beforeProfile = await readFile(profilePath, "utf8");
    let writes = 0;
    await expect(atomicWritePrivateJsonPair([
      { targetPath: storagePath, value: { changed: "storage" } },
      { targetPath: profilePath, value: { changed: "profile" } }
    ], {
      mkdir,
      writeFile: async (...args) => {
        writes += 1;
        if (writes === 2) throw new Error("second prepare write failed");
        return writeFile(...args);
      },
      chmod,
      rename,
      unlink
    })).rejects.toThrow("second prepare write failed");
    expect(await readFile(storagePath, "utf8")).toBe(beforeStorage);
    expect(await readFile(profilePath, "utf8")).toBe(beforeProfile);
    expect((await readdir(dirname(storagePath))).filter((name) => name.includes(".tmp") || name.includes(".bak"))).toEqual([]);
  });

  it("restores originals without deletion when a later backup cannot be made", async () => {
    const storagePath = await copyFixtureToTemporaryFile("storage-state.json");
    const profilePath = await copyFixtureToTemporaryFile("session-profile.json");
    const beforeStorage = await readFile(storagePath, "utf8");
    const beforeProfile = await readFile(profilePath, "utf8");
    let backups = 0;
    await expect(atomicWritePrivateJsonPair([
      { targetPath: storagePath, value: { changed: "storage" } },
      { targetPath: profilePath, value: { changed: "profile" } }
    ], {
      mkdir,
      writeFile,
      chmod,
      rename: async (from, to) => {
        if (to.endsWith(".bak")) {
          backups += 1;
          if (backups === 2) throw new Error("second backup failed");
        }
        return rename(from, to);
      },
      unlink
    })).rejects.toThrow("second backup failed");
    expect(await readFile(storagePath, "utf8")).toBe(beforeStorage);
    expect(await readFile(profilePath, "utf8")).toBe(beforeProfile);
    expect((await readdir(dirname(storagePath))).filter((name) => name.includes(".tmp") || name.includes(".bak"))).toEqual([]);
  });

  it("recovers the original pair if backup cleanup fails instead of leaving credential backups", async () => {
    const storagePath = await copyFixtureToTemporaryFile("storage-state.json");
    const profilePath = await copyFixtureToTemporaryFile("session-profile.json");
    const beforeStorage = await readFile(storagePath, "utf8");
    const beforeProfile = await readFile(profilePath, "utf8");
    let failed = false;
    await expect(atomicWritePrivateJsonPair([
      { targetPath: storagePath, value: { changed: "storage" } },
      { targetPath: profilePath, value: { changed: "profile" } }
    ], {
      mkdir,
      writeFile,
      chmod,
      rename,
      unlink: async (path) => {
        if (path.endsWith(".bak") && !failed) {
          failed = true;
          throw new Error("backup cleanup failed");
        }
        return unlink(path);
      }
    })).rejects.toThrow("backup cleanup failed");
    expect(await readFile(storagePath, "utf8")).toBe(beforeStorage);
    expect(await readFile(profilePath, "utf8")).toBe(beforeProfile);
    expect((await readdir(dirname(storagePath))).filter((name) => name.includes(".tmp") || name.includes(".bak"))).toEqual([]);
  });
});
