import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

describe("admin static application", () => {
  let testApp: TestApp | undefined;

  afterEach(async () => {
    await testApp?.close();
    testApp = undefined;
  });

  it("serves only the approved same-origin admin routes", async () => {
    testApp = await createTestApp({
      config: { adminPassword: "fixture-admin-password" }
    });

    await expect(testApp.app.inject("/admin/")).resolves.toMatchObject({
      statusCode: 200
    });
    await expect(testApp.app.inject("/admin/accounts")).resolves.toMatchObject({
      headers: expect.objectContaining({
        "content-type": expect.stringContaining("text/html")
      })
    });
    await expect(testApp.app.inject("/assets/not-admin.js")).resolves.toMatchObject({
      statusCode: 404
    });
    await expect(testApp.app.inject("/admin/api/accounts")).resolves.toMatchObject({
      statusCode: 401
    });
  });
});
