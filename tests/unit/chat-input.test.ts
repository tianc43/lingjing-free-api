import { describe, expect, it } from "vitest";
import { extractChatMediaPrompt } from "../../src/api/chat-input.js";

describe("extractChatMediaPrompt", () => {
  it("uses the last non-empty user text and standard image_url blocks", () => {
    const result = extractChatMediaPrompt([
      { role: "user", content: "older prompt" },
      {
        role: "user",
        content: [
          { type: "text", text: "final prompt" },
          {
            type: "image_url",
            image_url: { url: "https://media.example/input.png" }
          }
        ]
      }
    ]);

    expect(result).toEqual({
      prompt: "final prompt",
      imageUrls: ["https://media.example/input.png"]
    });
  });

  it("does not concatenate system or assistant text into the prompt", () => {
    expect(extractChatMediaPrompt([
      { role: "system", content: "secret system instruction" },
      { role: "user", content: "  first user prompt  " },
      { role: "assistant", content: "assistant reply" },
      {
        role: "user",
        content: [
          { type: "text", text: "   " },
          {
            type: "image_url",
            image_url: { url: "https://media.example/reference.png" }
          }
        ]
      }
    ])).toEqual({
      prompt: "first user prompt",
      imageUrls: ["https://media.example/reference.png"]
    });
  });

  it("rejects a conversation without non-empty user text", () => {
    expect(() => extractChatMediaPrompt([
      { role: "system", content: "system only" },
      { role: "assistant", content: "assistant only" },
      { role: "user", content: [{ type: "text", text: "  " }] }
    ])).toThrow(/user text/iu);
  });
});
