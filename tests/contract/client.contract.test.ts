import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LingjingClient } from "../../src/lingjing/client.js";
import type { PreparedMedia } from "../../src/media/types.js";
import { CookieFileProvider } from "../../src/session/cookie-file-provider.js";
import { StorageStateProvider } from "../../src/session/storage-state-provider.js";
import { LingjingUploadService } from "../../src/uploads/upload-service.js";
import { MockLingjing } from "../helpers/mock-lingjing.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const mocks: MockLingjing[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(mocks.splice(0).map((mock) => mock.dispatcher.close()));
  for (const directory of directories.splice(0)) {
    removeTestDirectory(directory);
  }
});

async function createClientWithSessionMode(mode: "browser-state" | "cookie-file" = "browser-state") {
  const mock = new MockLingjing();
  mocks.push(mock);
  const session = mock.createSession(mode);
  await session.seed();
  return { mock, session, client: new LingjingClient({ baseUrl: mock.baseUrl, session, dispatcher: mock.dispatcher, sleep: () => Promise.resolve() }) };
}

function preparedMedia(): PreparedMedia & { disposeCount: () => number } {
  let disposed = 0;
  return {
    filename: "fixture.png",
    contentType: "image/png",
    size: 3,
    openRead: () => Readable.from("png"),
    dispose: () => {
      disposed += 1;
      return Promise.resolve();
    },
    disposeCount: () => disposed
  };
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
    mock.respondWithSetCookie("csrfToken=fixture-rotated-csrf; Path=/; Secure");
    await client.read("/rotate-cookie");
    await client.read("/after-rotation");
    expect(mock.lastHeaders.cookie).toContain("csrfToken=fixture-rotated-csrf");
    expect(mock.lastHeaders["x-csrf-token"]).toBe("fixture-rotated-csrf");
  });

  it("never sends Lingjing credentials to an external signed upload URL", async () => {
    const { client, mock } = await createClientWithSessionMode();
    mock.respondWithResult({ single: { uploadId: "upload-credentials", uploadUrl: "https://object-storage.example/signed-part" } });
    await client.uploadApi("/joycreator/upload/init", { method: "POST", body: Buffer.from("init"), timeoutMs: 5_000 });
    await client.putSigned(new URL("https://object-storage.example/signed-part"), { method: "PUT", headers: { "content-type": "image/png", authorization: "fixture-leak", cookie: "fixture-leak", origin: "fixture-leak", referer: "fixture-leak", "x-csrf-token": "fixture-leak" }, body: Buffer.from("fixture"), timeoutMs: 5_000 });
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
    mock.respondWithResult({ single: { uploadId: "upload-once", uploadUrl: signed.toString() } });
    await client.uploadApi("/joycreator/upload/init", { method: "POST", body: Buffer.from("init"), timeoutMs: 5_000 });
    await expect(client.putSigned(signed, { method: "POST", body: Buffer.from("x"), timeoutMs: 5_000 })).rejects.toThrow("PUT");
    await client.putSigned(signed, { method: "PUT", body: Buffer.from("x"), timeoutMs: 5_000 });
    await expect(client.putSigned(signed, { method: "PUT", body: Buffer.from("x"), timeoutMs: 5_000 })).rejects.toThrow("trusted");
  });

  it("keeps signed URL capabilities isolated across interleaved uploads", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const first = new URL("https://object-storage.example/concurrent-first");
    const second = new URL("https://object-storage.example/concurrent-second");
    mock.respondWithResult({
      single: { uploadId: "upload-first", uploadUrl: first.toString() }
    });
    await client.uploadApi("/joycreator/upload/init", {
      method: "POST",
      body: Buffer.from("first"),
      timeoutMs: 5_000
    });
    mock.respondWithResult({
      single: { uploadId: "upload-second", uploadUrl: second.toString() }
    });
    await client.uploadApi("/joycreator/upload/init", {
      method: "POST",
      body: Buffer.from("second"),
      timeoutMs: 5_000
    });

    await expect(client.putSigned(first, {
      method: "PUT",
      body: Buffer.from("first"),
      timeoutMs: 5_000
    })).resolves.toMatchObject({ statusCode: 200 });
    await expect(client.putSigned(second, {
      method: "PUT",
      body: Buffer.from("second"),
      timeoutMs: 5_000
    })).resolves.toMatchObject({ statusCode: 200 });
  });

  it("preserves a general upload capability across read, submit, materials and other requests", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const signed = new URL("https://object-storage.example/signed-part");
    mock.respondWithResult({ single: { uploadId: "upload-unrelated", uploadUrl: signed.toString() } });
    await client.uploadApi("/joycreator/upload/init", { method: "POST", body: Buffer.from("init"), timeoutMs: 5_000 });
    await client.read("/unrelated");
    await client.submitOnce("/unrelated-submit", {});
    await client.uploadApi("/joycreator/AIModelApiConsole/uploadMaterials", {
      method: "POST",
      body: Buffer.from("materials"),
      timeoutMs: 5_000
    });
    await client.uploadApi("/some-other-upload", {
      method: "POST",
      body: Buffer.from("other"),
      timeoutMs: 5_000
    });
    await expect(client.putSigned(signed, {
      method: "PUT",
      body: Buffer.from("x"),
      timeoutMs: 5_000
    })).resolves.toMatchObject({ statusCode: 200 });
    await expect(client.putSigned(signed, {
      method: "PUT",
      body: Buffer.from("x"),
      timeoutMs: 5_000
    })).rejects.toThrow("trusted");
  });

  it("complete or cancel removes only the matching upload capability", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const first = new URL("https://object-storage.example/scoped-first");
    const second = new URL("https://object-storage.example/scoped-second");
    mock.respondWithResult({
      single: { uploadId: "scope-first", uploadUrl: first.toString() }
    });
    await client.uploadApi("/joycreator/upload/init", {
      method: "POST",
      body: Buffer.from("first"),
      timeoutMs: 5_000
    });
    mock.respondWithResult({
      single: { uploadId: "scope-second", uploadUrl: second.toString() }
    });
    await client.uploadApi("/joycreator/upload/init", {
      method: "POST",
      body: Buffer.from("second"),
      timeoutMs: 5_000
    });

    await client.uploadApi("/joycreator/upload/cancel", {
      method: "POST",
      body: JSON.stringify({ uploadId: "scope-first" }),
      timeoutMs: 5_000
    });

    await expect(client.putSigned(first, {
      method: "PUT",
      body: Buffer.from("first"),
      timeoutMs: 5_000
    })).rejects.toThrow("trusted");
    await expect(client.putSigned(second, {
      method: "PUT",
      body: Buffer.from("second"),
      timeoutMs: 5_000
    })).resolves.toMatchObject({ statusCode: 200 });
  });

  it("expires abandoned signed URL capabilities", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const { client, mock } = await createClientWithSessionMode();
      const signed = new URL("https://object-storage.example/expired");
      mock.respondWithResult({
        single: { uploadId: "upload-expired", uploadUrl: signed.toString() }
      });
      await client.uploadApi("/joycreator/upload/init", {
        method: "POST",
        body: Buffer.from("init"),
        timeoutMs: 5_000
      });

      vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
      await expect(client.putSigned(signed, {
        method: "PUT",
        body: Buffer.from("x"),
        timeoutMs: 5_000
      })).rejects.toThrow("trusted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels once through the real client when init registration fails after the network response", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const media = preparedMedia();
    const uploads = new LingjingUploadService(client, {
      uploadStrategy: "general"
    });
    mock.respondWithResult({
      single: {
        uploadId: "registration-failed",
        uploadUrl: "http://object-storage.example/unsafe"
      }
    });

    const error = await uploads.upload(media, {
      sceneCode: "fixture-scene",
      modelCode: "fixture-model",
      spaceId: 42
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(error).toMatchObject({
      code: "lingjing_upstream_error",
      message: "Lingjing upstream request failed"
    });
    expect(mock.count("/joycreator/upload/init")).toBe(1);
    expect(mock.count("/joycreator/upload/cancel")).toBe(1);
    expect(mock.count("/joycreator/upload/complete")).toBe(0);
    expect(mock.count("/unsafe")).toBe(0);
    expect(media.disposeCount()).toBe(1);
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

  it.each([
    null,
    [],
    { single: null },
    { single: [] },
    { single: {} },
    { single: { uploadUrl: null } },
    { single: { uploadUrl: "not-a-url" } },
    { single: { uploadUrl: "http://object-storage.example/signed-part" } },
    {
      single: {
        uploadId: "upload-credentials",
        uploadUrl: "https://user:pass@object-storage.example/signed-part"
      }
    },
    { multipart: null },
    { multipart: [] },
    { multipart: {} },
    { multipart: { parts: null } },
    { multipart: { parts: {} } },
    { multipart: { parts: [null] } },
    { multipart: { parts: [{ uploadUrl: null }] } },
    {
      single: { uploadUrl: "https://object-storage.example/signed-part" },
      multipart: { parts: [null] }
    }
  ])("rejects malformed upload init shapes without registering a URL: %j", async (result) => {
    const { client, mock } = await createClientWithSessionMode();
    const signed = new URL("https://object-storage.example/signed-part");
    mock.respondWithResult(result);
    await expect(client.uploadApi("/joycreator/upload/init", {
      method: "POST",
      body: Buffer.from("init"),
      timeoutMs: 5_000
    })).rejects.toMatchObject({ code: "lingjing_upstream_error" });
    await expect(client.putSigned(signed, {
      method: "PUT",
      body: Buffer.from("x"),
      timeoutMs: 5_000
    })).rejects.toThrow("trusted");
  });

  it("registers every validated HTTPS multipart upload URL", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const first = new URL("https://object-storage.example/part-one");
    const second = new URL("https://object-storage.example/part-two");
    mock.respondWithResult({
      multipart: {
        uploadId: "upload-multipart",
        parts: [
          { uploadUrl: first.toString() },
          { uploadUrl: second.toString() }
        ]
      }
    });
    await client.uploadApi("/joycreator/upload/init", {
      method: "POST",
      body: Buffer.from("init"),
      timeoutMs: 5_000
    });
    await expect(client.putSigned(first, {
      method: "PUT",
      body: Buffer.from("first"),
      timeoutMs: 5_000
    })).resolves.toMatchObject({ statusCode: 200 });
    await expect(client.putSigned(second, {
      method: "PUT",
      body: Buffer.from("second"),
      timeoutMs: 5_000
    })).resolves.toMatchObject({ statusCode: 200 });
  });

  it("refreshes a CSRF read failure once and retries with the new cookie and token", async () => {
    const mock = new MockLingjing();
    mocks.push(mock);
    const session = mock.createSession("browser-state");
    await session.seed();
    session.refreshOnInvalidate("fixture-refreshed-csrf");
    const refreshingClient = new LingjingClient({
      baseUrl: mock.baseUrl,
      session,
      dispatcher: mock.dispatcher,
      sleep: () => Promise.resolve()
    });
    mock.failCsrfReads(2);
    await expect(refreshingClient.read("/csrf-refresh")).resolves.toEqual({ ok: true });
    expect(mock.count("/csrf-refresh")).toBe(3);
    expect(session.invalidateCount).toBe(1);
    expect(session.refreshCount).toBe(1);
    expect(session.loadCount).toBe(4);
    for (const retriedHeaders of mock.headersFor("/csrf-refresh").slice(1)) {
      expect(retriedHeaders.cookie).toContain("csrfToken=fixture-refreshed-csrf");
      expect(retriedHeaders.cookie).toContain("session=refreshed-session");
      expect(retriedHeaders["x-csrf-token"]).toBe("fixture-refreshed-csrf");
    }
  });

  it("applies Set-Cookie before reporting malformed JSON", async () => {
    const mock = new MockLingjing();
    mocks.push(mock);
    const session = mock.createSession("browser-state");
    await session.seed();
    const malformedClient = new LingjingClient({ baseUrl: mock.baseUrl, session, dispatcher: mock.dispatcher });
    mock.respondWithSetCookie("csrfToken=fixture-malformed-rotated; Path=/; Secure");
    mock.respondWithMalformedJson();
    await expect(malformedClient.submitOnce("/submit-malformed-cookie", {}))
      .rejects.toMatchObject({ code: "lingjing_submit_ambiguous" });
    expect(session.applySetCookiesCount).toBe(1);
    await expect(session.cookieString()).resolves.toContain("csrfToken=fixture-malformed-rotated");
  });

  it("keeps a timed out submit single-shot and safely mapped", async () => {
    const { mock, session } = await createClientWithSessionMode();
    const client = new LingjingClient({
      baseUrl: mock.baseUrl,
      session,
      dispatcher: mock.timeoutDispatcher
    });
    vi.useFakeTimers();
    try {
      const outcome = client.submitOnce("/submit-timeout", {}).then(
        () => null,
        (cause: unknown) => cause
      );
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await outcome).toMatchObject({
        code: "lingjing_submit_ambiguous",
        statusCode: 502
      });
    } finally {
      vi.useRealTimers();
    }
    expect(mock.lastSubmitHeadersTimeout).toBe(15_000);
    expect(mock.count("/submit-timeout")).toBe(1);
  });

  it.each([
    ["malformed", "lingjing_submit_ambiguous", 502],
    ["csrf", "lingjing_csrf_expired", 503]
  ] as const)("keeps %s submit failures single-shot and safely mapped", async (mode, expectedCode, expectedStatusCode) => {
    const { client, mock } = await createClientWithSessionMode();
    if (mode === "malformed") mock.respondWithMalformedJson();
    if (mode === "csrf") mock.respondWithCsrfError();
    const path = `/submit-${mode}`;
    await expect(client.submitOnce(path, {})).rejects.toMatchObject({
      code: expectedCode,
      statusCode: expectedStatusCode
    });
    expect(mock.count(path)).toBe(1);
  });

  it("times out a signed upload without retrying", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const signed = new URL("https://object-storage.example/timeout-part");
    mock.respondWithResult({ single: { uploadId: "upload-timeout", uploadUrl: signed.toString() } });
    await client.uploadApi("/joycreator/upload/init", {
      method: "POST",
      body: Buffer.from("init"),
      timeoutMs: 5_000
    });
    await expect(client.putSigned(signed, {
      method: "PUT",
      body: Buffer.from("x"),
      timeoutMs: 5
    })).rejects.toThrow();
    expect(mock.count("/timeout-part")).toBe(1);
  });

  it("does not follow signed upload redirects and explicitly disables them", async () => {
    const mock = new MockLingjing();
    mocks.push(mock);
    const session = mock.createSession("browser-state");
    await session.seed();
    const client = new LingjingClient({
      baseUrl: mock.baseUrl,
      session,
      dispatcher: mock.recordingDispatcher
    });
    const signed = new URL("https://object-storage.example/redirect-part");
    mock.respondWithResult({ single: { uploadId: "upload-redirect", uploadUrl: signed.toString() } });
    await client.uploadApi("/joycreator/upload/init", {
      method: "POST",
      body: Buffer.from("init"),
      timeoutMs: 5_000
    });
    const response = await client.putSigned(signed, {
      method: "PUT",
      body: Buffer.from("x"),
      timeoutMs: 5_000
    });
    expect(response.statusCode).toBe(302);
    expect(mock.lastMaxRedirections).toBe(0);
    expect(mock.count("/redirect-part")).toBe(1);
    expect(mock.count("/redirect-target")).toBe(0);
  });

  it("returns raw signed status and preserves duplicate response headers", async () => {
    const { client, mock } = await createClientWithSessionMode();
    const signed = new URL("https://object-storage.example/raw-part");
    mock.respondWithResult({ single: { uploadId: "upload-raw", uploadUrl: signed.toString() } });
    await client.uploadApi("/joycreator/upload/init", {
      method: "POST",
      body: Buffer.from("init"),
      timeoutMs: 5_000
    });
    mock.respondToSignedUpload(206, { "set-cookie": ["part=a", "part=b"] });
    await expect(client.putSigned(signed, {
      method: "PUT",
      body: Buffer.from("x"),
      timeoutMs: 5_000
    })).resolves.toMatchObject({
      statusCode: 206,
      headers: { "set-cookie": ["part=a", "part=b"] }
    });
  });

  it("loads a fresh session for each logical Lingjing request", async () => {
    const mock = new MockLingjing();
    mocks.push(mock);
    const session = mock.createSession("browser-state");
    await session.seed();
    const client = new LingjingClient({ baseUrl: mock.baseUrl, session, dispatcher: mock.dispatcher });
    await client.read("/fresh-read");
    expect(session.loadCount).toBe(1);
    await client.submitOnce("/fresh-submit", {});
    expect(session.loadCount).toBe(2);
    await client.uploadApi("/fresh-upload", {
      method: "POST",
      body: Buffer.from("x"),
      timeoutMs: 5_000
    });
    expect(session.loadCount).toBe(3);
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
    mock.respondWithSetCookie("csrfToken=fixture-realistic-rotated; Path=/; Secure");
    await client.read("/rotate-real");
    await client.read("/after-real");
    expect(mock.lastHeaders["x-csrf-token"]).toBe("fixture-realistic-rotated");
    expect(mock.lastHeaders.cookie).toContain("csrfToken=fixture-realistic-rotated");
  });
});
