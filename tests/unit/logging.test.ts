import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger, redactForLog } from "../../src/logging.js";

describe("redactForLog", () => {
  it("removes credentials, prompts, media and URL queries", () => {
    const safe = redactForLog({
      authorization: "Bearer downstream",
      cookie: "pt_key=secret",
      csrfToken: "csrf-secret",
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
      authorization: "Bearer top-level-secret",
      cookie: "top-level-cookie-secret",
      csrfToken: "csrf-secret",
      originPin: "origin-pin-secret",
      prompt: "private prompt",
      input_images: ["https://example.com/image.png?media-secret=yes#fragment-secret"],
      callbackUrl: "https://example.com/callback?query-secret=yes#fragment-secret",
      req: {
        method: "POST",
        url: "/v1/images?request-secret=yes#fragment-secret",
        headers: { authorization: "Bearer request-secret", cookie: "request-cookie-secret" },
        body: { prompt: "body-secret" }
      },
      res: {
        statusCode: 201,
        headers: { "set-cookie": "response-cookie-secret" },
        body: { output: "body-secret" }
      },
      err: { code: "safe_error_code", stack: "private-stack" },
      nested: { cause: { cookie: "nested-cookie-secret" } }
    }, "safe log");

    const serialized = output.join("");
    for (const secret of [
      "top-level-secret", "top-level-cookie-secret", "csrf-secret", "origin-pin-secret",
      "private prompt", "media-secret", "query-secret", "fragment-secret", "request-secret",
      "request-cookie-secret", "body-secret", "response-cookie-secret", "private-stack", "nested-cookie-secret"
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(JSON.parse(serialized)).toMatchObject({
      req: { method: "POST", pathname: "/v1/images" },
      res: { statusCode: 201 },
      err: { code: "safe_error_code" },
      csrfToken: "[REDACTED]",
      originPin: "[REDACTED]",
      prompt: "[REDACTED]",
      input_images: "[REDACTED]",
      callbackUrl: "https://example.com/callback",
      nested: { cause: "[REDACTED]" }
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
          stack: "Error: Bearer stack-secret Cookie cookie-stack-secret prompt stack-prompt-secret\n    at safeFrame (app.ts:1:1)"
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
    for (const secret of ["stack-secret", "cookie-stack-secret", "stack-prompt-secret"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(JSON.parse(serialized)).toMatchObject({
      err: { code: "safe_error_code", stack: "[REDACTED]" }
    });
  });
});
