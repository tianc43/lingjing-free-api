import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

describe("admin static application", () => {
  let testApp: TestApp | undefined;
  let adminRoot: string | undefined;

  afterEach(async () => {
    await testApp?.close();
    testApp = undefined;
    if (adminRoot !== undefined) await rm(adminRoot, { recursive: true, force: true });
    adminRoot = undefined;
  });

  it("serves only the approved same-origin admin routes", async () => {
    adminRoot = await mkdtemp(join(tmpdir(), "lingjing-admin-static-"));
    await mkdir(join(adminRoot, "assets"));
    await writeFile(join(adminRoot, "index.html"), "<main>fixture admin</main>");
    await writeFile(join(adminRoot, "assets", "app.js"), "fixture asset", {
      encoding: "utf8",
      flush: true
    });
    testApp = await createTestApp({
      adminStaticRoot: adminRoot,
      config: { adminPassword: "fixture-admin-password" }
    });

    await expect(testApp.app.inject("/admin/")).resolves.toMatchObject({
      statusCode: 200,
      payload: "<main>fixture admin</main>"
    });
    await expect(testApp.app.inject("/admin/accounts")).resolves.toMatchObject({
      headers: expect.objectContaining({
        "content-type": expect.stringContaining("text/html")
      })
    });
    await expect(testApp.app.inject("/admin/api-access")).resolves.toMatchObject({
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
