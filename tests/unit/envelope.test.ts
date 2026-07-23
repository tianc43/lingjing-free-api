import { describe, expect, it } from "vitest";
import { unwrapEnvelope } from "../../src/lingjing/envelope.js";

describe("unwrapEnvelope", () => {
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
