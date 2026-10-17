import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { SqliteCallLogRepository, CALL_LOG_RETENTION } from "../../src/call-logs/repository.js";
import { callContext, bindCallJob, withCallJob } from "../../src/call-logs/context.js";
import { registerCallLogHooks } from "../../src/call-logs/hooks.js";
import { sanitize } from "../../src/call-logs/redaction.js";
import { LingjingClient } from "../../src/lingjing/client.js";
import { JobRunnerRegistry } from "../../src/generation/runner-registry.js";
import { MockLingjing } from "../helpers/mock-lingjing.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const operation of cleanup.splice(0).reverse()) await operation(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-call-log-"));
  cleanup.push(() => { removeTestDirectory(directory); });
  const path = join(directory, "logs.sqlite");
  const store = new SqliteStore(path);
  cleanup.push(() => { store.close(); });
  return { path, store, logs: new SqliteCallLogRepository(store) };
}
async function clientFixture(logs: SqliteCallLogRepository) {
  const mock = new MockLingjing();
  cleanup.push(async () => { await mock.dispatcher.close(); });
  const session = mock.createSession("browser-state");
  await session.seed();
  return { mock, client: new LingjingClient({ session, dispatcher: mock.dispatcher, baseUrl: mock.baseUrl, sleep: () => Promise.resolve(), callLogs: logs, accountId: "account-fixture" }) };
}

describe("persistent API call records", () => {
  const officialFailure = {
    requestId: "s-official-failure-1", error: { code: 9, message: "任务执行失败，请稍后重试" },
    result: { result: { success: false, error: "TASK_RUN_FAILED", originError: { venderCode: "byteDance_seedance_video", errCode: "500:INTERNAL", errDesc: "获取模型服务失败" } } }
  };

  it("separates HTTP 200 from official business failure and exposes safe diagnostic facts", () => {
    const { logs } = fixture();
    const id = logs.start({ direction: "outbound", method: "POST", path: "/joycreator/AIModelApiConsole/executeByApiId" });
    logs.finish(id, { statusCode: 200, body: officialFailure });
    expect(logs.find(id ?? "")?.record).toMatchObject({ status_code: 200, status: "error", upstream: {
      httpStatusCode: 200, businessCode: "9", requestId: "s-official-failure-1", taskCode: "TASK_RUN_FAILED",
      vendor: { code: "byteDance_seedance_video", errorCode: "500:INTERNAL", message: "获取模型服务失败" }
    } });
  });

  it("derives historical business failures for list, filter and detail without rewriting their original body", () => {
    const { logs, store } = fixture();
    const id = logs.start({ direction: "outbound", method: "POST", path: "/official/submit" });
    logs.finish(id, { statusCode: 200, body: officialFailure });
    store.read(db => db.prepare("UPDATE api_call_logs SET status='success',error_code=NULL,error_message=NULL WHERE id=?").run(id));
    const storedBody = store.read(db => (db.prepare("SELECT response_body FROM api_call_logs WHERE id=?").get(id) as { response_body: string }).response_body);
    expect(logs.list({ status: "error" }).items[0]).toMatchObject({ id, status: "error", status_code: 200, upstream: { requestId: "s-official-failure-1" } });
    expect(logs.list({ status: "success" }).total).toBe(0);
    expect(logs.find(id ?? "")?.record).toMatchObject({ status: "error", upstream: { vendor: { message: "获取模型服务失败" } } });
    expect(store.read(db => (db.prepare("SELECT response_body FROM api_call_logs WHERE id=?").get(id) as { response_body: string }).response_body)).toBe(storedBody);
  });

  it("recognizes nested-only official failure while accepting a successful envelope with null error", () => {
    const { logs } = fixture();
    const failed = logs.start({ direction: "outbound", method: "POST", path: "/official/nested" });
    logs.finish(failed, { statusCode: 200, body: { error: null, result: officialFailure.result } });
    expect(logs.find(failed ?? "")?.record.status).toBe("error");
    const successful = logs.start({ direction: "outbound", method: "GET", path: "/official/success" });
    logs.finish(successful, { statusCode: 200, body: { error: null, result: { success: true, value: 42 } } });
    expect(logs.find(successful ?? "")?.record.status).toBe("success");
  });

  it("keeps a successful inbound task lookup successful when the returned task has failed", () => {
    const { logs } = fixture();
    const id = logs.start({ direction: "inbound", method: "GET", path: "/v1/videos/job-failed" });
    logs.finish(id, { statusCode: 200, body: { id: "job-failed", status: "failed", error: { code: "generation_submit_rejected", message: "Official generation failed" } } });
    expect(logs.find(id ?? "")?.record).toMatchObject({ status_code: 200, status: "success" });
    expect(logs.find(id ?? "")?.record).not.toHaveProperty("upstream");
  });

  it("does not report success without a verified HTTP response and redacts derived diagnostics", () => {
    const { logs } = fixture();
    const unknown = logs.start({ direction: "outbound", method: "POST", path: "/official/unverified" });
    logs.finish(unknown, {});
    expect(logs.find(unknown ?? "")?.record).toMatchObject({ status: "error", status_code: null, error_code: "response_unverified", upstream_status: "unknown" });
    const failed = logs.start({ direction: "outbound", method: "POST", path: "/official/sensitive" });
    logs.finish(failed, { statusCode: 200, body: { ...officialFailure, error: { code: 9, message: "cookie=fixture-vendor-secret Bearer fixture-upstream-secret https://secret.test/object?signature=fixture-signed-secret" } } });
    const serialized = JSON.stringify(logs.find(failed ?? ""));
    for (const secret of ["fixture-vendor-secret", "fixture-upstream-secret", "fixture-signed-secret"]) expect(serialized).not.toContain(secret);
  });

  it("redacts credentials, signed URL queries and binary input while retaining prompts and bounded output", () => {
    const { logs } = fixture();
    const id = logs.start({ direction: "inbound", method: "POST", path: "/v1/images?api_key=never-store", headers: { Authorization: "Bearer fixture-downstream-secret", Cookie: "session=fixture-secret-cookie" }, body: { prompt: "有生活感的图片", nested: { csrfToken: "fixture-csrf-secret", uploadUrl: "https://store.test/object?X-Amz-Signature=signed-secret" }, image: "data:image/png;base64,AAsecret" } });
    logs.finish(id, { statusCode: 200, body: { text: "中".repeat(100_000) } });
    const detail = logs.find(id ?? "");
    if (!detail) throw new Error("Expected persisted call record");
    const serialized = JSON.stringify(detail);
    for (const secret of ["never-store", "fixture-downstream-secret", "fixture-secret-cookie", "fixture-csrf-secret", "signed-secret", "AAsecret"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("有生活感的图片");
    expect(serialized).toContain("__truncated");
    expect(JSON.stringify(detail.record.response_body).length).toBeLessThan(40_000);
    expect(detail.record.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("persists across reopening and filters with bounded pagination and retention", () => {
    const { logs, store, path } = fixture();
    const id = logs.start({ direction: "outbound", method: "GET", path: "/provider" });
    logs.finish(id, { statusCode: 503, error: new Error("upstream failed") });
    store.read((db) => { db.prepare("UPDATE api_call_logs SET started_at=? WHERE id=?").run(Date.now() - 31 * 86_400_000, id); });
    logs.start({ direction: "inbound", method: "POST", path: "/v1/images" });
    expect(logs.find(id ?? "")).toBeNull();
    const persisted = logs.start({ direction: "outbound", method: "POST", path: "/provider/generate" });
    logs.finish(persisted, { statusCode: 200 });
    store.close();
    const reopenedStore = new SqliteStore(path);
    cleanup.push(() => { reopenedStore.close(); });
    const reopened = new SqliteCallLogRepository(reopenedStore);
    expect(reopened.find(persisted ?? "")?.record.status).toBe("success");
    expect(reopened.list({ direction: "outbound", status: "success", search: "/provider", page_size: 1 })).toMatchObject({ total: 1, page: 1, page_size: 1, retention: CALL_LOG_RETENTION });
    expect(reopened.list({ search: "%" }).total).toBe(0);
  });

  it("records inbound failures and links provider calls across async boundaries, excluding admin login", async () => {
    const { logs } = fixture();
    const { client } = await clientFixture(logs);
    const app = Fastify();
    cleanup.push(async () => { await app.close(); });
    registerCallLogHooks(app, logs);
    app.post("/generate", async (request) => {
      bindCallJob("task-fixture");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await client.submitOnce("/read-endpoint", request.body);
      return { id: "task-fixture", result: "ok" };
    });
    app.get("/fail", () => { throw new Error("fixture failure"); });
    app.post("/admin/api/login", () => ({ ok: true }));
    expect((await app.inject({ method: "POST", url: "/generate", payload: { prompt: "test prompt" }, headers: { authorization: "Bearer fixture-secret-inbound" } })).statusCode).toBe(200);
    expect((await app.inject("/fail")).statusCode).toBe(500);
    await app.inject({ method: "POST", url: "/admin/api/login", payload: { password: "admin-secret" } });
    const items = logs.list().items;
    expect(items).toHaveLength(3);
    const inbound = items.find((item) => item.path === "/generate");
    const outbound = items.find((item) => item.direction === "outbound");
    if (!inbound || !outbound) throw new Error("Expected both directions");
    expect(outbound).toMatchObject({ parent_id: inbound.id, trace_id: inbound.trace_id, job_id: "task-fixture", account_id: "account-fixture", status: "success", status_code: 200 });
    expect(inbound.job_id).toBe("task-fixture");
    expect(logs.find(inbound.id)?.related).toHaveLength(1);
    expect(logs.list({ status: "error" }).items[0]?.path).toBe("/fail");
    expect(JSON.stringify(logs.find(outbound.id))).not.toContain("fixture-csrf");
    expect(JSON.stringify(logs.find(inbound.id))).not.toContain("fixture-secret-inbound");
  });

  it("records HTTP and business failures per attempt without changing bounded read retries", async () => {
    const { logs } = fixture();
    const { mock, client } = await clientFixture(logs);
    mock.failReads(2);
    await client.read("/read-endpoint");
    expect(mock.count("/read-endpoint")).toBe(3);
    expect(logs.list({ status: "error" }).total).toBe(2);
    mock.respondWithResult({ success: true });
    await client.submitOnce("/read-endpoint", { prompt: "single" });
    expect(logs.list({ status: "success" }).total).toBe(2);
    mock.queueEnvelope("/business-failure", { statusCode: 200, error: { code: "NO_PERMISSION", message: "fixture rejected" } });
    await expect(client.submitOnce("/business-failure", {})).rejects.toBeDefined();
    expect(logs.list({ search: "/business-failure" }).items[0]).toMatchObject({ status: "error", status_code: 200 });
    mock.disconnectSubmit();
    await expect(client.submitOnce("/joycreator/AIModelApiConsole/executeByApiId", {})).rejects.toMatchObject({ code: "lingjing_submit_ambiguous" });
    expect(mock.count("/joycreator/AIModelApiConsole/executeByApiId")).toBe(1);
    expect(logs.list({ status: "error" }).total).toBe(4);
  });

  it("records signed uploads with redacted capability and binary omission", async () => {
    const { logs } = fixture();
    const { mock, client } = await clientFixture(logs);
    mock.respondWithResult({ single: { uploadId: "upload-fixture", uploadUrl: "https://object-storage.example/signed-part?signature=capability-secret" } });
    await client.uploadApi("/joycreator/upload/init", { method: "POST", body: "{}", timeoutMs: 1000 });
    await client.putSigned(new URL("https://object-storage.example/signed-part?signature=capability-secret"), { method: "PUT", body: Buffer.from("private-image-bytes"), timeoutMs: 1000 });
    const upload = logs.list().items.find((item) => item.method === "PUT");
    if (!upload) throw new Error("Expected signed upload record");
    expect(upload).toMatchObject({ status: "success", status_code: 200, path: "https://object-storage.example/signed-part" });
    const all = logs.list().items.map((item) => logs.find(item.id));
    expect(JSON.stringify(all)).not.toContain("capability-secret");
    expect(JSON.stringify(all)).not.toContain("private-image-bytes");
  });

  it("does not change successful provider calls when recording cannot write", async () => {
    const { logs, store } = fixture();
    const { client } = await clientFixture(logs);
    store.close();
    await expect(client.read("/read-endpoint")).resolves.toEqual({ ok: true });
  });

  it("retains job context for detached registry work and keeps parallel contexts isolated", async () => {
    const { logs } = fixture();
    const registry = new JobRunnerRegistry();
    await Promise.all(["job-a", "job-b"].map((job) => withCallJob(job, async () => {
      const scheduled = registry.startOnce(job, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const id = logs.start({ direction: "outbound", method: "GET", path: "/poll" });
        logs.finish(id, { statusCode: 200 });
        expect(callContext.getStore()?.jobId).toBe(job);
      });
      await scheduled.promise;
    })));
    expect(new Set(logs.list().items.map((item) => item.job_id))).toEqual(new Set(["job-a", "job-b"]));
  });

  it("handles large serialized JSON and cyclic objects without leaking secrets or throwing", () => {
    const value = { prompt: "x".repeat(150_000), password: "large-json-secret" };
    expect(JSON.stringify(sanitize(JSON.stringify(value)))).not.toContain("large-json-secret");
    const cycle: Record<string, unknown> = { prompt: "good" }; cycle.self = cycle;
    expect(JSON.stringify(sanitize(cycle))).toContain("CIRCULAR");
    expect(JSON.stringify(sanitize({ pin: "fixture-private-pin", originPin: "fixture-private-origin" }))).not.toContain("private-");
    expect(String(sanitize("Invalid credential cookie=session-secret; pin=pin-secret csrfToken=fixture-csrf-secret"))).not.toContain("session-secret");
  });

  it("finalizes a disconnected real HTTP response instead of leaving it pending", async () => {
    const { logs } = fixture();
    const app = Fastify();
    cleanup.push(async () => { await app.close(); });
    registerCallLogHooks(app, logs);
    let resolveClosed = () => { /* assigned below */ };
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    app.get("/slow", (_request, reply) => {
      reply.raw.once("close", resolveClosed);
      reply.hijack();
      reply.raw.write("response started");
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${address}/slow`, (response) => {
        response.once("data", () => { response.destroy(); resolve(); });
      });
      request.once("error", reject);
      request.end();
    });
    await closed;
    expect(logs.list().items[0]).toMatchObject({ status: "error", error_code: "client_disconnected" });
    expect(logs.list({ status: "pending" }).total).toBe(0);
  });
});
