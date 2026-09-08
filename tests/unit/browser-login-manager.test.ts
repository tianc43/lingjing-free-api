import { describe, expect, it } from "vitest";
import { BrowserLoginManager } from "../../src/accounts/browser-login-manager.js";

describe("BrowserLoginManager", () => {
  it("creates one active local-browser handoff per account", () => {
    const manager = new BrowserLoginManager();
    const first = manager.start("legacy");
    const second = manager.start("legacy");

    expect(second).toBe(first);
    expect(first).toMatchObject({
      accountId: "legacy",
      status: "running",
      error: null,
      loginUrl: "https://lingjing.jdcloud.com/"
    });
  });

  it("marks only the matching account handoff completed", () => {
    const manager = new BrowserLoginManager();
    const login = manager.start("legacy");

    expect(() => manager.complete(login.id, "another"))
      .toThrow("Browser login handoff not found");
    expect(manager.complete(login.id, "legacy")).toMatchObject({
      status: "completed",
      accountId: "legacy"
    });
  });
});
