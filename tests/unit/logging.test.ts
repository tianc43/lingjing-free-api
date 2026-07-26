import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger, redactForLog } from "../../src/logging.js";

describe("redactForLog", () => {
  it("removes credentials, prompts, media and URL queries", () => {
    const safe = redactForLog({
      authorization: "Bearer fixture-downstream",
      cookie: "pt_key=fixture-secret",
      csrfToken: "fixture-csrf-secret",
      prompt: "private prompt",
      input_images: ["https://example.com/a.png?signature=secret"]
    });
    expect(JSON.stringify(safe)).not.toContain("secret");
    expect(safe).toEqual({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      csrfToken: "[REDACTED]",
      prompt: "[TEXT length=14]",
      input_images: "[MEDIA count=1]"
    });
  });

  it("redacts CSRF header aliases and strips relative URL queries without altering ordinary text", () => {
    const safe = redactForLog({
      callbackUrl: "/callback?query-secret=yes#fragment-secret",
      "x-csrf-token": "csrf-header-secret",
      description: "ordinary text"
    });

    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("fragment-secret");
    expect(serialized).not.toContain("csrf-header-secret");
    expect(safe).toEqual({
      callbackUrl: "/callback",
      "x-csrf-token": "[REDACTED]",
      description: "ordinary text"
    });
  });

  it.each([
    ["./callback?query-secret=yes#fragment-secret", "./callback"],
    ["callback?query-secret=yes#fragment-secret", "callback"],
    ["../callback?query-secret=yes#fragment-secret", "../callback"],
    ["?query-secret=yes", ""],
    ["#fragment-secret", ""]
  ])("strips all relative URL reference metadata from %s", (reference, expected) => {
    const safe = redactForLog({ callbackUrl: reference, description: "ordinary text?unchanged#fragment" });
    const serialized = JSON.stringify(safe);

    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("fragment-secret");
    expect(safe).toEqual({ callbackUrl: expected, description: "ordinary text?unchanged#fragment" });
  });

  it("redacts real Pino output and emits only safe serializer fields outside development", () => {
    const output: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output.push(chunk.toString("utf8"));
        callback();
      }
    });
    const testLogger = createLogger("info", stream);

    testLogger.info({
      authorization: "Bearer fixture-top-level-secret",
      cookie: "fixture-top-level-cookie-secret",
      csrfToken: "fixture-csrf-secret",
      originPin: "fixture-origin-pin-secret",
      cookie_input: "fixture-cookie-input-secret",
      cookieInput: "fixture-cookie-input-camel-secret",
      api_key: "fixture-api-key-secret",
      apiKey: "fixture-api-key-camel-secret",
      secret: "fixture-generic-secret",
      prompt: "private prompt",
      input_images: ["https://example.com/image.png?media-secret=yes#fragment-secret"],
      callbackUrl: "https://example.com/callback?query-secret=yes#fragment-secret",
      req: {
        method: "POST",
        url: "/v1/images?request-secret=yes#fragment-secret",
        headers: { authorization: "Bearer fixture-request-secret", cookie: "fixture-request-cookie-secret" },
        body: { prompt: "body-secret" }
      },
      res: {
        statusCode: 201,
        headers: { "set-cookie": "fixture-response-cookie-secret" },
        body: { output: "body-secret" }
      },
      err: { code: "safe_error_code", stack: "private-stack" },
      nested: {
        cause: { cookie: "fixture-nested-cookie-secret" },
        cookie_input: "fixture-nested-cookie-input-secret",
        apiKey: "fixture-nested-api-key-secret",
        secret: "fixture-nested-generic-secret"
      }
    }, "safe log");

    const serialized = output.join("");
    for (const secret of [
      "fixture-top-level-secret", "fixture-top-level-cookie-secret", "fixture-csrf-secret", "fixture-origin-pin-secret",
      "fixture-cookie-input-secret", "fixture-cookie-input-camel-secret", "fixture-api-key-secret", "fixture-api-key-camel-secret", "fixture-generic-secret",
      "private prompt", "media-secret", "query-secret", "fragment-secret", "request-secret",
      "fixture-request-cookie-secret", "body-secret", "fixture-response-cookie-secret", "private-stack", "fixture-nested-cookie-secret",
      "fixture-nested-cookie-input-secret", "fixture-nested-api-key-secret", "fixture-nested-generic-secret"
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(JSON.parse(serialized)).toMatchObject({
      req: { method: "POST", pathname: "/v1/images" },
      res: { statusCode: 201 },
      err: { code: "safe_error_code" },
      csrfToken: "[REDACTED]",
      originPin: "[REDACTED]",
      cookie_input: "[REDACTED]",
      cookieInput: "[REDACTED]",
      api_key: "[REDACTED]",
      apiKey: "[REDACTED]",
      secret: "[REDACTED]",
      prompt: "[REDACTED]",
      input_images: "[REDACTED]",
      callbackUrl: "https://example.com/callback",
      nested: {
        cause: "[REDACTED]",
        cookie_input: "[REDACTED]",
        apiKey: "[REDACTED]",
        secret: "[REDACTED]"
      }
    });
  });

  it("redacts sensitive development error stacks before Pino writes them", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const output: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output.push(chunk.toString("utf8"));
        callback();
      }
    });

    try {
      createLogger("info", stream).info({
        err: {
          code: "safe_error_code",
          stack: "Error: Bearer fixture-stack-secret Cookie fixture-cookie-stack-secret prompt fixture-stack-prompt-secret\n    at safeFrame (app.ts:1:1)"
        }
      }, "safe log");
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }

    const serialized = output.join("");
    for (const secret of ["fixture-stack-secret", "fixture-cookie-stack-secret", "fixture-stack-prompt-secret"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(JSON.parse(serialized)).toMatchObject({
      err: { code: "safe_error_code", stack: "[REDACTED]" }
    });
  });
});
