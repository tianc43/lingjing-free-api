import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStore, PresignedPut, StoredObject } from "./object-store.js";

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly prefix = ""
  ) {}

  async presignPut(key:string,options:{contentType:string;size:number;expiresInSeconds:number}):Promise<PresignedPut>{const full=this.objectKey(key);const url=await getSignedUrl(this.client,new PutObjectCommand({Bucket:this.bucket,Key:full,ContentType:options.contentType,ContentLength:options.size}),{expiresIn:options.expiresInSeconds});return{key,url,headers:{"content-type":options.contentType},expiresAt:Date.now()+options.expiresInSeconds*1000};}

  async put(key: string, stream: NodeJS.ReadableStream, options: { expectedSize: number; maxBytes: number }): Promise<StoredObject> {
    if (options.expectedSize > options.maxBytes) throw new RangeError("Object exceeds storage limit");
    const full = this.objectKey(key);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: full, Body: stream as Readable,
      ContentLength: options.expectedSize
    }));
    const object = await this.get(key);
    if (object === null || object.size !== options.expectedSize) {
      await this.remove(key).catch(() => undefined);
      throw new Error("Stored object size mismatch");
    }
    return object;
  }

  async get(key: string): Promise<StoredObject | null> {
    const full = this.objectKey(key);
    let size: number;
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: full }));
      size = head.ContentLength ?? -1;
      if (size < 0) throw new Error("S3 object has no content length");
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "$metadata" in cause
        && (cause as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw cause;
    }
    return {
      key,
      size,
      openRead: (start, endInclusive) => Readable.from(this.read(full, start, endInclusive)),
      remove: () => this.remove(key)
    };
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }

  private async *read(full: string, start?: number, endInclusive?: number): AsyncGenerator<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: full,
      ...(start === undefined ? {} : { Range: `bytes=${String(start)}-${endInclusive === undefined ? "" : String(endInclusive)}` })
    }));
    if (response.Body === undefined) throw new Error("S3 object body is unavailable");
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) yield chunk;
  }

  private objectKey(key: string): string {
    if (key.includes("..") || key.startsWith("/")) throw new TypeError("Invalid object storage key");
    return [this.prefix.replace(/^\/+|\/+$/gu, ""), key].filter(Boolean).join("/");
  }
}
