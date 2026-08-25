import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { S3ObjectStore } from "../../src/media/s3-object-store.js";

const endpoint=process.env["S3_ENDPOINT"]??"http://127.0.0.1:19000";
const bucket=process.env["S3_BUCKET"]??"lingjing-test";
const client=new S3Client({region:"us-east-1",endpoint,forcePathStyle:true,credentials:{accessKeyId:process.env["AWS_ACCESS_KEY_ID"]??"fixture-minio",secretAccessKey:process.env["AWS_SECRET_ACCESS_KEY"]??"fixture-minio-secret"}});
await client.send(new CreateBucketCommand({Bucket:bucket})).catch((cause:unknown)=>{if(!(typeof cause==="object"&&cause!==null&&"name" in cause&&cause.name==="BucketAlreadyOwnedByYou"))throw cause;});
const store=new S3ObjectStore(client,bucket,"integration");const key=`asset-${randomBytes(8).toString("hex")}`;const body=Buffer.from("abcdef");
const object=await store.put(key,Readable.from([body]),{expectedSize:body.length,maxBytes:100});
if((await read(object.openRead())).toString()!=="abcdef")throw new Error("full read mismatch");
if((await read(object.openRead(1,3))).toString()!=="bcd")throw new Error("range read mismatch");
await object.remove();
if(await store.get(key)!==null)throw new Error("delete failed");
client.destroy();
console.log("minio integration passed");
async function read(stream:NodeJS.ReadableStream){const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk as Uint8Array));return Buffer.concat(chunks);}
