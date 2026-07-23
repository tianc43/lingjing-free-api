import { describe, expect, it } from "vitest";
import { redactForLog } from "../../src/logging.js";

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
});
