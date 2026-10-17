import { describe, expect, it } from "vitest";
import { unwrapEnvelope } from "../../src/lingjing/envelope.js";
import { upstreamDiagnostics, extractUpstreamDiagnostics } from "../../src/lingjing/error-map.js";

describe("unwrapEnvelope", () => {
  it.each(["pin", "originPin", "password", "passwd", "credential", "access_key", "sign", "signature"])("redacts quoted %s credentials in official and vendor messages", (key) => {
    const secret = `fixture-private-${key}`;
    const message = JSON.stringify({ [key]: secret });
    const diagnostics = extractUpstreamDiagnostics({ error: { code: 9, message }, result: { result: { originError: { errDesc: message } } } }, 200);
    expect(diagnostics?.message).toContain("[REDACTED]");
    expect(diagnostics?.vendor?.message).toContain("[REDACTED]");
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });
  it("redacts JSON quoted credential and prompt values in both official and vendor messages", () => {
    const secrets = { authorization: "fixture-private-auth", cookie: "fixture-private-cookie", access_token: "fixture-private-token", prompt: 'fixture-private-prompt with "quotes"' };
    const message = JSON.stringify(secrets);
    const diagnostics = extractUpstreamDiagnostics({ error: { code: 9, message }, result: { result: { originError: { venderCode: "vendor", errCode: "500:INTERNAL", errDesc: message } } } }, 200);
    for (const secret of Object.values(secrets)) expect(JSON.stringify(diagnostics)).not.toContain(secret);
    for (const fragment of ["fixture-private-auth", "fixture-private-cookie", "fixture-private-token", "fixture-private-prompt"]) expect(JSON.stringify(diagnostics)).not.toContain(fragment);
    expect(diagnostics?.message).toContain("[REDACTED]");
    expect(diagnostics?.vendor?.message).toContain("[REDACTED]");
  });
  it("preserves the real HTTP 200 Seedance failure and official/vendor diagnostics", () => {
    try {
      unwrapEnvelope({ requestId: "s-9013039a4a07482b91f246269ac4c00a", error: { code: 9, message: "任务执行失败，请稍后重试" }, result: { result: { error: "TASK_RUN_FAILED", success: false, originError: { venderCode: "byteDance_seedance_video", errCode: "500:INTERNAL", errDesc: "获取模型服务失败" } } } }, 200);
      expect.fail("expected business rejection");
    } catch (cause) {
      expect(upstreamDiagnostics(cause)).toEqual({ httpStatusCode: 200, requestId: "s-9013039a4a07482b91f246269ac4c00a", businessCode: "9", message: "任务执行失败，请稍后重试", taskCode: "TASK_RUN_FAILED", vendor: { code: "byteDance_seedance_video", errorCode: "500:INTERNAL", message: "获取模型服务失败" } });
    }
  });

  it("rejects nested explicit task failure even without an outer error", () => {
    expect(() => unwrapEnvelope({ error: null, result: { result: { success: false, error: "TASK_RUN_FAILED" } } }, 200)).toThrow();
  });
  it("returns a successful result", () => {
    expect(unwrapEnvelope({ requestId: "r1", error: null, result: { ok: true } }))
      .toEqual({ ok: true });
  });

  it("maps login errors delivered with HTTP 200", () => {
    try {
      unwrapEnvelope({ requestId: "r2", error: { code: 406, message: "USER_NOT_LOGIN" }, result: null });
      throw new Error("Expected unwrapEnvelope to throw");
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 503, code: "lingjing_session_expired" });
    }
  });

  it("maps HTTP 5xx even when the envelope claims success", () => {
    try {
      unwrapEnvelope({ error: null, result: { ok: true } }, 503);
      throw new Error("Expected unwrapEnvelope to throw");
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 502, code: "lingjing_upstream_error" });
    }
  });

  it("preserves sanitized upstream diagnostics separately from the mapped error", () => {
    try {
      unwrapEnvelope({
        error: {
          code: "MODEL_ACCESS_DENIED",
          message: "prompt=\"private prompt\" token=private-token; model is unavailable https://example.test/a?secret=value"
        },
        result: null
      }, 422);
      throw new Error("Expected unwrapEnvelope to throw");
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 502,
        code: "lingjing_upstream_error"
      });
      expect(upstreamDiagnostics(error)).toEqual({
        httpStatusCode: 422,
        businessCode: "MODEL_ACCESS_DENIED",
        message: "prompt=[REDACTED] token=[REDACTED]; model is unavailable [URL]"
      });
    }
  });

  it.each([
    [403, null, "lingjing_permission_denied"],
    [429, null, "lingjing_rate_limited"],
    [400, { code: "AUDIT", message: "audit rejected" }, "content_policy_violation"],
    [400, { code: "CSRF", message: "expired" }, "lingjing_csrf_expired"],
    [402, { code: "QUOTA", message: "empty" }, "lingjing_insufficient_points"]
  ])("maps every non-2xx envelope (%i)", (statusCode, error, code) => {
    try {
      unwrapEnvelope({ error, result: null }, statusCode);
      throw new Error("Expected unwrapEnvelope to throw");
    } catch (caught) {
      expect(caught).toMatchObject({ code });
    }
  });
});
