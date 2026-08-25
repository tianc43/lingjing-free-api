import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { S3ObjectStore } from "../../src/media/s3-object-store.js";

describe("S3 object store",()=>{it("writes, heads and reads through an S3-compatible client",async()=>{const send=vi.fn((command:{constructor:{name:string}})=>{if(command.constructor.name==="HeadObjectCommand")return Promise.resolve({ContentLength:3});if(command.constructor.name==="GetObjectCommand")return Promise.resolve({Body:Readable.from([Buffer.from("abc")])});return Promise.resolve({});});const client={send} as unknown as S3Client;const store=new S3ObjectStore(client,"bucket","prefix");const object=await store.put("projects/p/input",Readable.from([Buffer.from("abc")]),{expectedSize:3,maxBytes:10});expect(object.size).toBe(3);const chunks:Buffer[]=[];for await(const chunk of object.openRead())chunks.push(Buffer.from(chunk as Uint8Array));expect(Buffer.concat(chunks).toString()).toBe("abc");expect(send).toHaveBeenCalledTimes(3);});});
