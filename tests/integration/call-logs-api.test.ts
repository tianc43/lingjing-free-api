import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { SqliteCallLogRepository } from "../../src/call-logs/repository.js";
import { createTestApp, type TestApp } from "../helpers/test-app.js";

const fixtures: TestApp[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())); stores.splice(0).forEach((store) => { store.close(); }); });

describe("administrator API call log access", () => {
  it("requires administrator login, supports paginated filtering and details, and never logs its own traffic", async () => {
    const store = new SqliteStore(":memory:"); stores.push(store);
    const callLogs = new SqliteCallLogRepository(store);
    const fixture = await createTestApp({ config: { adminPassword: "admin-fixture-secret" }, callLogs }); fixtures.push(fixture);
    expect((await fixture.app.inject("/admin/api/call-logs")).statusCode).toBe(401);
    expect((await fixture.app.inject({ url: "/admin/api/call-logs", headers: { authorization: "Bearer fixture-downstream-secret" } })).statusCode).toBe(401);
    const failed = await fixture.app.inject({ url: "/v1/models", headers: { authorization: "Bearer fixture-private-wrong-key" } });
    expect(failed.statusCode).toBe(401);
    const login = await fixture.app.inject({ method: "POST", url: "/admin/api/login", payload: { password: "admin-fixture-secret" } });
    expect(login.statusCode).toBe(200);
    const raw = login.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(";")[0] ?? "";
    const response = await fixture.app.inject({ url: "/admin/api/call-logs?direction=inbound&status=error&page=1&page_size=10", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{ items: { id: string; trace_id: string; error_code: string }[]; total: number; page_size: number }>();
    expect(body.total).toBe(1);
    expect(body.items[0]?.trace_id).toBe(failed.headers["x-request-id"]);
    expect(body.items[0]?.error_code).toBe("invalid_api_key");
    const record = body.items[0];
    if (!record) throw new Error("Expected failed request log");
    const details = await fixture.app.inject({ url: `/admin/api/call-logs/${record.id}`, headers: { cookie } });
    expect(details.statusCode).toBe(200);
    expect(details.body).toContain("REDACTED");
    expect(details.body).not.toContain("fixture-private-wrong-key");
    expect(details.body).not.toContain("admin-fixture-secret");
    expect((await fixture.app.inject({ url: "/admin/api/call-logs?page_size=101", headers: { cookie } })).statusCode).toBe(400);
    expect((await fixture.app.inject({ url: "/admin/api/call-logs/missing", headers: { cookie } })).statusCode).toBe(404);
    expect(callLogs.list().total).toBe(1);
  });
});
