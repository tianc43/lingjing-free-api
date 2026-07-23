import { errors } from "../errors.js";

export interface ChatMediaPrompt {
  prompt: string;
  imageUrls: string[];
}

export type ChatMessage = {
  role: string;
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
};

export function extractChatMediaPrompt(
  messages: ChatMessage[]
): ChatMediaPrompt {
  let prompt = "";
  const imageUrls: string[] = [];

  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      const text = message.content.trim();
      if (text.length > 0) prompt = text;
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") {
        const text = block.text.trim();
        if (text.length > 0) prompt = text;
      } else {
        imageUrls.push(block.image_url.url);
      }
    }
  }

  if (prompt.length === 0) {
    throw errors.invalidRequest(
      "A non-empty user text prompt is required",
      "messages"
    );
  }
  return { prompt, imageUrls };
}
