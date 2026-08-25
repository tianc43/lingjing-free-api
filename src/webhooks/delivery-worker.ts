import type { SqliteWebhookRepository } from "./sqlite-webhook-repository.js";
import { SafeWebhookTransport, type WebhookTransport } from "./transport.js";
export class WebhookDeliveryWorker{
 constructor(private readonly repository:SqliteWebhookRepository,private readonly transport:WebhookTransport=new SafeWebhookTransport(),private readonly now:()=>number=Date.now){}
 async scan(limit=20):Promise<{delivered:number;failed:number}>{let delivered=0,failed=0;for(const event of this.repository.due(limit)){const timestamp=this.now();try{const status=await this.transport.post(new URL(event.url),{"content-type":"application/json","x-webhook-id":event.id,"x-webhook-timestamp":String(timestamp),"x-webhook-signature":this.repository.sign(event.secret,timestamp,event.payload)},event.payload);if(status<200||status>=300)throw new Error(`HTTP ${String(status)}`);this.repository.delivered(event.id);delivered++;}catch(cause){this.repository.failed(event.id,cause instanceof Error?cause.message:"delivery failed");failed++;}}return{delivered,failed};}
}
