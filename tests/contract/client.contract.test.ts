import { afterEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LingjingClient } from "../../src/lingjing/client.js";
import { CookieFileProvider } from "../../src/session/cookie-file-provider.js";
import { StorageStateProvider } from "../../src/session/storage-state-provider.js";
import { MockLingjing } from "../helpers/mock-lingjing.js";

const mocks: MockLingjing[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(mocks.splice(0).map((mock) => mock.dispatcher.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createClientWithSessionMode(mode: "browser-state" | "cookie-file" = "browser-state") {
  const mock = new MockLingjing();
  mocks.push(mock);
  const session = mock.createSession(mode);
  await session.seed();
  return { mock, client: new LingjingClient({ baseUrl: mock.baseUrl, session, dispatcher: mock.dispatcher, sleep: () => Promise.resolve() }) };
}

describe("LingjingClient contract", () => {
  it("sends Cookie, x-csrf-token and timestamp", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const result = await client.read<{ ok: boolean }>("/read-endpoint");
    expect(result.ok).toBe(true);
    expect(mock.lastHeaders.cookie).toContain("csrfToken=fixture-csrf");
    expect(mock.lastHeaders["x-csrf-token"]).toBe("fixture-csrf");
    expect(mock.lastQuery._t).toMatch(/^\d+$/u);
  });

  it("retries bounded read failures but never retries submitOnce", async () => {
    const { client, mock } = await createClientWithSessionMode();
    mock.failReads(2);
    await expect(client.read("/read-endpoint")).resolves.toBeDefined();
    expect(mock.count("/read-endpoint")).toBe(3);
    mock.disconnectSubmit();
    await expect(client.submitOnce("/joycreator/AIModelApiConsole/executeByApiId", {}))
      .rejects.toMatchObject({ code: "lingjing_submit_ambiguous" });
    expect(mock.count("/joycreator/AIModelApiConsole/executeByApiId")).toBe(1);
  });

  it.each(["browser-state", "cookie-file"] as const)("uses a rotated CSRF cookie on the next %s request", async (mode) => {
    const { client, mock } = await createClientWithSessionMode(mode);
    mock.respondWithSetCookie("csrfToken=rotated-fixture-csrf; Path=/; Secure");
    await client.read("/rotate-cookie");
    await client.read("/after-rotation");
    expect(mock.lastHeaders.cookie).toContain("csrfToken=rotated-fixture-csrf");
    expect(mock.lastHeaders["x-csrf-token"]).toBe("rotated-fixture-csrf");
  });

  it("never sends Lingjing credentials to an external signed upload URL", async () => {
    const { client, mock } = await createClientWithSessionMode();
    mock.respondWithResult({ single: { uploadUrl: "https://object-storage.example/signed-part" } });
    await client.uploadApi("/joycreator/upload/init", { method: "POST", body: Buffer.from("init"), timeoutMs: 5_000 });
    await client.putSigned(new URL("https://object-storage.example/signed-part"), { method: "PUT", headers: { "content-type": "image/png", authorization: "leak", cookie: "leak", origin: "leak", referer: "leak" }, body: Buffer.from("fixture"), timeoutMs: 5_000 });
    expect(mock.objectStorageHeaders.cookie).toBeUndefined();
    expect(mock.objectStorageHeaders["x-csrf-token"]).toBeUndefined();
    expect(mock.objectStorageHeaders.authorization).toBeUndefined();
    expect(mock.objectStorageHeaders.origin).toBeUndefined();
    expect(mock.objectStorageHeaders.referer).toBeUndefined();
  });

  it("requires a fresh trusted init URL and consumes it once", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const signed = new URL("https://object-storage.example/signed-part");
    await expect(client.putSigned(signed, { method: "PUT", body: Buffer.from("x"), timeoutMs: 5_000 })).rejects.toThrow("trusted");
    mock.respondWithResult({ single: { uploadUrl: signed.toString() } });
    await client.uploadApi("/joycreator/upload/init", { method: "POST", body: Buffer.from("init"), timeoutMs: 5_000 });
    await expect(client.putSigned(signed, { method: "POST", body: Buffer.from("x"), timeoutMs: 5_000 })).rejects.toThrow("PUT");
    await client.putSigned(signed, { method: "PUT", body: Buffer.from("x"), timeoutMs: 5_000 });
    await expect(client.putSigned(signed, { method: "PUT", body: Buffer.from("x"), timeoutMs: 5_000 })).rejects.toThrow("trusted");
  });

  it("invalidates signed URL trust after an unrelated logical request", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const signed = new URL("https://object-storage.example/signed-part");
    mock.respondWithResult({ single: { uploadUrl: signed.toString() } });
    await client.uploadApi("/joycreator/upload/init", { method: "POST", body: Buffer.from("init"), timeoutMs: 5_000 });
    await client.read("/unrelated");
    await expect(client.putSigned(signed, { method: "PUT", body: Buffer.from("x"), timeoutMs: 5_000 })).rejects.toThrow("trusted");
  });

  it("passes ReadableStream uploads through without JSON encoding", async () => {
    const { client, mock } = await createClientWithSessionMode();
    await client.uploadApi("/stream-upload", { method: "POST", body: Readable.from("stream-body"), timeoutMs: 5_000 });
    expect(mock.lastHeaders["content-type"]).toBeUndefined();
  });

  it("does not trust URLs in unknown fields or non-init upload responses", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const signed = new URL("https://object-storage.example/signed-part");
    mock.respondWithResult({ echoedUrl: signed.toString() });
    await client.uploadApi("/joycreator/upload/init", { method: "POST", body: Buffer.from("init"), timeoutMs: 5_000 });
    await expect(client.putSigned(signed, { method: "PUT", body: Buffer.from("x"), timeoutMs: 5_000 })).rejects.toThrow("trusted");
    mock.respondWithResult({ uploadUrl: signed.toString() });
    await client.uploadApi("/some-other-upload", { method: "POST", body: Buffer.from("init"), timeoutMs: 5_000 });
    await expect(client.putSigned(signed, { method: "PUT", body: Buffer.from("x"), timeoutMs: 5_000 })).rejects.toThrow("trusted");
  });

  it("rejects absolute, scheme-relative, and cross-origin logical paths", async () => {
    const { client } = await createClientWithSessionMode();
    await expect(client.read("https://object-storage.example/steal")).rejects.toThrow("origin-relative");
    await expect(client.read("//object-storage.example/steal")).rejects.toThrow("origin-relative");
    await expect(client.read("/\\object-storage.example/steal")).rejects.toThrow();
  });

  it.each(["browser-state", "cookie-file"] as const)("rotates CSRF using the real %s provider", async (mode) => {
    const mock = new MockLingjing();
    mocks.push(mock);
    const directory = await mkdtemp(join(tmpdir(), "lingjing-client-"));
    directories.push(directory);
    const profile = join(directory, "profile.json");
    await writeFile(profile, JSON.stringify({ originPin: mock.baseUrl.origin }));
    const provider = mode === "browser-state"
      ? new StorageStateProvider(join(directory, "state.json"), profile, undefined, mock.baseUrl)
      : new CookieFileProvider(join(directory, "cookies.txt"), profile, mock.baseUrl);
    if (mode === "browser-state") {
      await writeFile(join(directory, "state.json"), JSON.stringify({ cookies: [
        { name: "csrfToken", value: "fixture-csrf", domain: "lingjing.test", path: "/", expires: -1, httpOnly: false, secure: true },
        { name: "session", value: "fixture-session", domain: "lingjing.test", path: "/", expires: -1, httpOnly: true, secure: true }
      ], origins: [] }));
    } else await writeFile(join(directory, "cookies.txt"), "csrfToken=fixture-csrf; session=fixture-session");
    const client = new LingjingClient({ baseUrl: mock.baseUrl, session: provider, dispatcher: mock.dispatcher, sleep: () => Promise.resolve() });
    mock.respondWithSetCookie("csrfToken=real-rotated; Path=/; Secure");
    await client.read("/rotate-real");
    await client.read("/after-real");
    expect(mock.lastHeaders["x-csrf-token"]).toBe("real-rotated");
    expect(mock.lastHeaders.cookie).toContain("csrfToken=real-rotated");
  });
});
