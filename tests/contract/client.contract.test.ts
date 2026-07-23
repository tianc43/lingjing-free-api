import { afterEach, describe, expect, it } from "vitest";
import { LingjingClient } from "../../src/lingjing/client.js";
import { MockLingjing } from "../helpers/mock-lingjing.js";

const mocks: MockLingjing[] = [];

afterEach(async () => { await Promise.all(mocks.splice(0).map((mock) => mock.dispatcher.close())); });

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
    await client.putSigned(new URL("https://object-storage.example/signed-part"), { method: "PUT", headers: { "content-type": "image/png" }, body: Buffer.from("fixture"), timeoutMs: 5_000 });
    expect(mock.objectStorageHeaders.cookie).toBeUndefined();
    expect(mock.objectStorageHeaders["x-csrf-token"]).toBeUndefined();
    expect(mock.objectStorageHeaders.authorization).toBeUndefined();
    expect(mock.objectStorageHeaders.origin).toBeUndefined();
    expect(mock.objectStorageHeaders.referer).toBeUndefined();
  });
});
