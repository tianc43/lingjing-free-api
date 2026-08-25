import { describe, expect, it, vi } from "vitest";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { WebhookDeliveryWorker } from "../../src/webhooks/delivery-worker.js";
import { SqliteWebhookRepository } from "../../src/webhooks/sqlite-webhook-repository.js";
import type { WebhookTransport } from "../../src/webhooks/transport.js";

describe("webhooks", () => {
  it("signs, delivers and deduplicates terminal events", async () => {
    const now=100,store=new SqliteStore(":memory:"),jobs=new SqliteJobRepository(store),hooks=new SqliteWebhookRepository(store,()=>now);
    const endpoint=hooks.configure("prj_legacy","https://hooks.example.test/hook");
    const job=jobs.createOrGet({kind:"video",sourceType:"text-to-video",model:"m",apiId:"a",modelCode:null,expectedAssetScene:"v",requestFingerprint:"a".repeat(64),idempotencyKeyHash:null,spaceId:1}).job;
    hooks.enqueue(job.id,"video.completed",{id:job.id});hooks.enqueue(job.id,"video.completed",{id:job.id});
    const post=vi.fn((...args:[URL,Record<string,string>,string])=>{void args;return Promise.resolve(204);});
    const transport:WebhookTransport={post};
    expect(await new WebhookDeliveryWorker(hooks,transport,()=>now).scan()).toEqual({delivered:1,failed:0});
    const headers=post.mock.calls[0]?.[1];expect(headers?.["x-webhook-signature"]).toBe(hooks.sign(endpoint.secret,100,JSON.stringify({id:job.id})));
    expect(hooks.deliveries()[0]).toMatchObject({status:"delivered",attempts:0});jobs.close();store.close();
  });
});
