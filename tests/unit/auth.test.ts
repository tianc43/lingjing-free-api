import { describe, expect, it } from "vitest";
import { isAuthorized } from "../../src/api/auth.js";

describe("Bearer authentication", () => {
  it("accepts only the exact configured bearer token", () => {
    expect(isAuthorized("Bearer local-secret", "local-secret")).toBe(true);
    expect(isAuthorized("Bearer local-secreu", "local-secret")).toBe(false);
    expect(isAuthorized(undefined, "local-secret")).toBe(false);
  });

  it("accepts a verified managed bearer token while preserving legacy token access", () => {
    const managedKeys = { verify: (token: string) => token === "ljk_managed" };

    expect(isAuthorized("Bearer local-secret", "local-secret", managedKeys)).toBe(true);
    expect(isAuthorized("Bearer ljk_managed", "local-secret", managedKeys)).toBe(true);
    expect(isAuthorized("Bearer ljk_invalid", "local-secret", managedKeys)).toBe(false);
  });

  const rejectedHeaders: Array<[string, string | string[]]> = [
    ["array value", ["Bearer local-secret"]],
    ["multiple comma-separated values", "Bearer local-secret, Bearer local-secret"],
    ["leading whitespace", " Bearer local-secret"],
    ["extra whitespace after scheme", "Bearer  local-secret"],
    ["Basic scheme", "Basic local-secret"],
    ["wrong-case scheme", "bearer local-secret"],
    ["empty token", "Bearer "],
    ["trailing content", "Bearer local-secret trailing"]
  ];

  it.each(rejectedHeaders)("rejects %s", (_description, authorization) => {
    expect(isAuthorized(authorization, "local-secret")).toBe(false);
  });
});
