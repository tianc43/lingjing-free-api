import { describe, expect, it } from "vitest";
import { SafeWebhookTransport } from "../../src/webhooks/transport.js";

describe("safe webhook transport", () => {
  it("rejects HTTP and private DNS targets before connecting", async () => {
    const transport=new SafeWebhookTransport({resolver:()=>Promise.resolve([{address:"127.0.0.1",family:4}])});
    await expect(transport.post(new URL("http://example.com/hook"),{},"{}")).rejects.toThrow(/HTTPS/u);
    await expect(transport.post(new URL("https://example.com/hook"),{},"{}")).rejects.toMatchObject({code:"unsafe_media_url"});
  });
});
