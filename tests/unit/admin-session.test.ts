import { describe, expect, it } from "vitest";
import { AdminSessionStore } from "../../src/admin/session.js";

describe("AdminSessionStore", () => {
  it("accepts only the configured administrator password", () => {
    const store = new AdminSessionStore({ password: "correct" });

    expect(store.login("wrong")).toBeNull();
    expect(store.login("correct")).not.toBeNull();
  });

  it("creates independent 32-byte URL-safe session and CSRF values", () => {
    const store = new AdminSessionStore({ password: "correct" });
    const first = store.login("correct");
    const second = store.login("correct");

    expect(first?.id).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first?.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first?.id).not.toBe(first?.csrfToken);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.csrfToken).not.toBe(first?.csrfToken);
  });

  it("authenticates until the default eight-hour expiry", () => {
    let now = 1_000;
    const store = new AdminSessionStore({
      password: "correct",
      now: () => now
    });
    const session = store.login("correct");

    expect(session?.expiresAt).toBe(1_000 + 8 * 60 * 60 * 1_000);
    expect(store.authenticate(session?.id)).toBe(session);
    now = session?.expiresAt ?? 0;
    expect(store.authenticate(session?.id)).toBeNull();
  });

  it("logs out an authenticated session", () => {
    const store = new AdminSessionStore({ password: "correct" });
    const session = store.login("correct");

    store.logout(session?.id);

    expect(store.authenticate(session?.id)).toBeNull();
  });

  it("requires the exact CSRF token", () => {
    const store = new AdminSessionStore({ password: "correct" });
    const session = store.login("correct");
    if (session === null) throw new Error("Fixture login failed");

    expect(() => {
      store.assertCsrf(session, undefined);
    }).toThrow();
    expect(() => {
      store.assertCsrf(session, "wrong");
    }).toThrow();
    expect(() => {
      store.assertCsrf(session, session.csrfToken);
    })
      .not.toThrow();
  });

  it("does not serialize credentials, session IDs, or CSRF values", () => {
    const password = "correct-password";
    const store = new AdminSessionStore({ password });
    const session = store.login(password);
    const serialized = JSON.stringify({ store, session });

    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(session?.id);
    expect(serialized).not.toContain(session?.csrfToken);
  });
});
