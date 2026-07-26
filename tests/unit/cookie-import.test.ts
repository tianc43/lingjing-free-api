import { describe, expect, it } from "vitest";
import { parseCookieImport } from "../../src/session/cookie-import.js";

describe("parseCookieImport", () => {
  it("converts a raw Cookie header into a Lingjing candidate session", async () => {
    const result = parseCookieImport({
      format: "header",
      value: "csrfToken=fixture-csrf; pin=fixture%2Dpin; thor=fixture-auth"
    });
    expect(result.originPin).toBe("fixture-pin");
    expect(result.storageState.cookies.map((cookie) => cookie.name))
      .toEqual(["csrfToken", "pin", "thor"]);
    expect((await result.session.load()).csrfToken).toBe("fixture-csrf");
  });

  it("accepts browser cookie JSON and rejects malformed or oversized input", () => {
    expect(parseCookieImport({
      format: "json",
      value: JSON.stringify([
        { name: "csrfToken", value: "fixture-csrf", domain: "lingjing.jdcloud.com", path: "/" },
        { name: "pin", value: "fixture%2Dpin", domain: ".jdcloud.com", path: "/" }
      ])
    }).originPin).toBe("fixture-pin");
    expect(() => parseCookieImport({ format: "header", value: "pin=x" }))
      .toThrow("Lingjing csrfToken cookie is required");
    expect(() => parseCookieImport({ format: "header", value: "x".repeat(65_537) }))
      .toThrow("Cookie input is too large");
  });

  it("requires a non-empty csrfToken and a non-blank decoded pin", () => {
    expect(() => parseCookieImport({ format: "header", value: "csrfToken=; pin=fixture-pin" }))
      .toThrow("Lingjing csrfToken cookie is required");
    expect(() => parseCookieImport({ format: "header", value: "csrfToken=fixture-csrf; pin=%20%20" }))
      .toThrow("Lingjing pin cookie is required");
  });

  it.each([".jd.com", ".jdpay.com"])("requires csrfToken to domain-match Lingjing instead of accepting %s", (domain) => {
    expect(() => parseCookieImport({
      format: "json",
      value: JSON.stringify([
        { name: "csrfToken", value: "fixture-csrf", domain, path: "/" },
        { name: "pin", value: "fixture-pin", domain: ".jdcloud.com", path: "/" }
      ])
    })).toThrow("Lingjing csrfToken cookie is required");
  });

  it("rejects untrusted, duplicate, conflicting and over-limit cookies", () => {
    expect(() => parseCookieImport({ format: "json", value: "not-json" }))
      .toThrow("Invalid browser cookie JSON");
    expect(() => parseCookieImport({
      format: "json",
      value: JSON.stringify([{ name: "csrfToken", value: "a", domain: "example.com", path: "/" }])
    })).toThrow("Unsupported cookie domain");
    expect(() => parseCookieImport({
      format: "header",
      value: "csrfToken=fixture-a; csrfToken=fixture-b; pin=fixture-pin"
    })).toThrow("Duplicate Lingjing csrfToken cookie");
    expect(() => parseCookieImport({
      format: "header",
      value: "csrfToken=fixture-a; pin=first; pin=second"
    })).toThrow("Conflicting Lingjing pin cookies");
    expect(() => parseCookieImport({
      format: "header",
      value: ["csrfToken=fixture-a", "pin=b", ...Array.from({ length: 199 }, (_, index) => `c${String(index)}=v`)].join("; ")
    })).toThrow("Too many cookies");
  });
});
