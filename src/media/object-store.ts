import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export interface StoredObject {
  key: string;
  size: number;
  openRead(start?: number, endInclusive?: number): NodeJS.ReadableStream;
  remove(): Promise<void>;
}

export interface PresignedPut { key:string; url:string; headers:Record<string,string>; expiresAt:number; }
export interface ObjectStore {
  presignPut?(key:string,options:{contentType:string;size:number;expiresInSeconds:number}):Promise<PresignedPut>;
  put(
    key: string,
    stream: NodeJS.ReadableStream,
    options: { expectedSize: number; maxBytes: number }
  ): Promise<StoredObject>;
  get(key: string): Promise<StoredObject | null>;
  remove(key: string): Promise<void>;
}

function safeKey(key: string): boolean {
  return key !== ""
    && !key.startsWith("/")
    && !key.startsWith("\\")
    && !key.includes("..")
    && !key.includes(":")
    && /^[A-Za-z0-9_./-]+$/u.test(key);
}

export class LocalObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(
    key: string,
    stream: NodeJS.ReadableStream,
    options: { expectedSize: number; maxBytes: number }
  ): Promise<StoredObject> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    let size = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array | string);
        size += buffer.byteLength;
        if (size > options.maxBytes) throw new RangeError("Object exceeds storage limit");
        await handle.write(buffer);
      }
      await handle.sync();
      await handle.close();
      if (size !== options.expectedSize) throw new Error("Object size changed while storing");
      await rename(temporary, target);
      return this.object(key, target, size);
    } catch (cause) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const target = this.pathFor(key);
    try {
      const handle = await open(target, "r");
      const stat = await handle.stat();
      await handle.close();
      return this.object(key, target, stat.size);
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause
        && (cause as { code?: unknown }).code === "ENOENT") return null;
      throw cause;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private object(key: string, target: string, size: number): StoredObject {
    return {
      key,
      size,
      openRead: (start, endInclusive) => createReadStream(target, {
        ...(start === undefined ? {} : { start }),
        ...(endInclusive === undefined ? {} : { end: endInclusive })
      }),
      remove: () => this.remove(key)
    };
  }

  private pathFor(key: string): string {
    if (!safeKey(key)) throw new TypeError("Invalid object storage key");
    const target = resolve(this.root, ...key.split("/"));
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      throw new TypeError("Object storage key escaped its root");
    }
    return target;
  }
}
