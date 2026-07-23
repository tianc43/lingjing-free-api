import { describe, expect, it } from "vitest";
import { isAuthorized } from "../../src/api/auth.js";

describe("Bearer authentication", () => {
  it("accepts only the exact configured bearer token", () => {
    expect(isAuthorized("Bearer local-secret", "local-secret")).toBe(true);
    expect(isAuthorized("Bearer local-secreu", "local-secret")).toBe(false);
    expect(isAuthorized(undefined, "local-secret")).toBe(false);
  });
});
