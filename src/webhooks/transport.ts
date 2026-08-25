import { Agent, fetch as undiciFetch } from "undici";
import {
  assertPublicHttpTarget,
  type AddressResolver
} from "../media/address-policy.js";

export interface WebhookTransport {
  post(url: URL, headers: Record<string,string>, body: string): Promise<number>;
}

export class SafeWebhookTransport implements WebhookTransport {
  constructor(private readonly options: {
    resolver?: AddressResolver;
    timeoutMs?: number;
  } = {}) {}

  async post(url: URL, headers: Record<string,string>, body: string): Promise<number> {
    if (url.protocol !== "https:") throw new Error("Webhook URL must use HTTPS");
    const target = await assertPublicHttpTarget(url, this.options.resolver);
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, _options, callback) => {
          callback(null, target.address, target.family);
        }
      }
    });
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, this.options.timeoutMs ?? 10_000);
    timer.unref();
    try {
      const response = await undiciFetch(url, {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        body,
        dispatcher,
        redirect: "manual",
        signal: controller.signal
      });
      // Never follow redirects: they could escape the validated DNS target.
      if (response.status >= 300 && response.status < 400) {
        throw new Error("Webhook redirects are not allowed");
      }
      await response.body?.cancel();
      return response.status;
    } finally {
      clearTimeout(timer);
      await dispatcher.close();
    }
  }
}
