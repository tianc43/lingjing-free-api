import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizedInject,
  createTestApp,
  type TestApp
} from "../helpers/test-app.js";

describe("system API", () => {
  let fixture: TestApp;

  beforeEach(async () => {
    fixture = await createTestApp();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("exposes only healthz and ping without authentication", async () => {
    expect((await fixture.app.inject({
      method: "GET",
      url: "/healthz"
    })).statusCode).toBe(200);
    expect((await fixture.app.inject({
      method: "GET",
      url: "/ping"
    })).json()).toEqual({ message: "pong" });
    expect((await fixture.app.inject({
      method: "GET",
      url: "/v1/account"
    })).statusCode).toBe(401);
    expect((await fixture.app.inject({
      method: "GET",
      url: "/v1/models"
    })).statusCode).toBe(401);
    expect((await fixture.app.inject({
      method: "GET",
      url: "/openapi.json"
    })).statusCode).toBe(401);
    expect((await fixture.app.inject({
      method: "GET",
      url: "/docs"
    })).statusCode).toBe(401);
  });

  it("reports recovery and bounded queue health without account details", async () => {
    const response = await fixture.app.inject({
      method: "GET",
      url: "/healthz"
    });
    expect(response.json()).toEqual({
      status: "ok",
      database: "ok",
      queue: {
        active: 0,
        waiting: 0,
        limit: 5
      }
    });
    expect(response.body).not.toContain("safe-subject");
    expect(response.body).not.toContain("91001");
  });

  it("returns 503 until startup recovery is ready", async () => {
    await fixture.close();
    fixture = await createTestApp({
      recovery: { ready: false }
    });
    const response = await fixture.app.inject({
      method: "GET",
      url: "/healthz"
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "starting" });
  });

  it("does not enable CORS or trust proxy headers by default", async () => {
    fixture.app.get("/__test-ip", (request) => ({ ip: request.ip }));
    const forwarded = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/__test-ip",
      headers: { "x-forwarded-for": "203.0.113.10" }
    });
    expect(forwarded.json()).toEqual({ ip: "127.0.0.1" });
    const response = await fixture.app.inject({
      method: "OPTIONS",
      url: "/v1/models",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "GET",
        "x-forwarded-for": "203.0.113.10"
      }
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("authenticates before consuming protected-route rate limit", async () => {
    const responses = await Promise.all(
      Array.from({ length: 105 }, () => fixture.app.inject({
        method: "GET",
        url: "/v1/account",
        headers: { authorization: "Bearer invalid-secret" }
      }))
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
    }
    expect((await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/account"
    })).statusCode).toBe(200);
  });

  it("returns a no-store OpenAI error when a hashed API-key bucket is exhausted", async () => {
    let limited: Awaited<ReturnType<typeof authorizedInject>> | undefined;
    for (let attempt = 0; attempt < 105; attempt += 1) {
      const response = await authorizedInject(fixture.app, {
        method: "GET",
        url: "/v1/session"
      });
      if (response.statusCode === 429) {
        limited = response;
        break;
      }
    }
    expect(limited).toBeDefined();
    expect(limited?.statusCode).toBe(429);
    expect(limited?.headers["cache-control"]).toBe("no-store");
    expect(limited?.json()).toEqual({
      error: {
        message: "Lingjing rate limited",
        type: "rate_limit_error",
        param: null,
        code: "lingjing_rate_limited"
      }
    });
  });

  it("returns OpenAI style errors without internal causes", async () => {
    fixture.account.throwOnDescribe = new Error(
      "internal fixture detail",
      { cause: new Error("nested-cause-secret") }
    );
    const response = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/account"
    });
    expect(response.statusCode).toBe(502);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      error: {
        message: "Lingjing upstream request failed",
        type: "upstream_error",
        param: null,
        code: "lingjing_upstream_error"
      }
    });
    expect(response.body).not.toContain("internal fixture detail");
    expect(response.body).not.toContain("nested-cause-secret");
  });

  it("maps malformed and oversized JSON to client errors", async () => {
    const malformed = await fixture.app.inject({
      method: "POST",
      url: "/token/check",
      headers: {
        authorization: "Bearer downstream-secret",
        "content-type": "application/json"
      },
      payload: "{"
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "invalid_request"
      }
    });

    const oversized = await fixture.app.inject({
      method: "POST",
      url: "/token/check",
      headers: {
        authorization: "Bearer downstream-secret",
        "content-type": "application/json"
      },
      payload: JSON.stringify({ value: "x".repeat(20_000) })
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "request_too_large"
      }
    });
  });

  it("returns a no-store OpenAI error for unknown protected routes", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations?signature=query-secret",
      payload: { prompt: "private fixture prompt" }
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      error: {
        message: "Route not found",
        type: "invalid_request_error",
        param: null,
        code: "route_not_found"
      }
    });
    expect(response.body).not.toContain("query-secret");
    expect(response.body).not.toContain("private fixture prompt");
  });

  it("does not leak bodies, credential headers, URL queries or nested causes to Pino", async () => {
    fixture.account.throwOnDescribe = new Error("outer", {
      cause: new Error("nested-cause-secret")
    });
    await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/account?signature=query-secret",
      headers: {
        cookie: "csrfToken=cookie-secret"
      }
    });
    await fixture.app.inject({
      method: "POST",
      url: "/v1/images/generations?signature=query-secret",
      headers: {
        authorization: "Bearer downstream-secret",
        cookie: "csrfToken=cookie-secret"
      },
      payload: {
        model: "707",
        prompt: "private fixture prompt"
      }
    });
    const logs = fixture.capturedPinoOutput();
    for (const forbidden of [
      "query-secret",
      "downstream-secret",
      "cookie-secret",
      "private fixture prompt",
      "nested-cause-secret"
    ]) {
      expect(logs).not.toContain(forbidden);
    }
  });
});
