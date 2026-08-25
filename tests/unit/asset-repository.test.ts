import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAssetRepository } from "../../src/media/asset-repository.js";
import { LocalObjectStore } from "../../src/media/object-store.js";
import type { PreparedMedia } from "../../src/media/types.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) removeTestDirectory(directory);
});

function media(body = Buffer.from("persistent input image")): PreparedMedia {
  return {
    filename: "frame.png",
    contentType: "image/png",
    size: body.byteLength,
    openRead: (start = 0, endInclusive = body.length - 1) => Readable.from([
      body.subarray(start, endInclusive + 1)
    ]),
    dispose: () => Promise.resolve()
  };
}

async function bytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string));
  }
  return Buffer.concat(chunks);
}

describe("persistent job assets", () => {
  it("stores an input object, binds it to a job, and reopens it after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-assets-"));
    directories.push(directory);
    const dbPath = join(directory, "data.sqlite");
    const objectRoot = join(directory, "objects");
    const body = Buffer.from("restart-safe image");
    let assetId: string;
    let jobId: string;
    {
      const store = new SqliteStore(dbPath);
      const assets = new SqliteAssetRepository(store, new LocalObjectStore(objectRoot));
      const jobs = new SqliteJobRepository(store);
      const asset = await assets.persistInput({
        userId: "usr_legacy",
        projectId: "prj_legacy",
        media: media(body),
        maxBytes: 1024
      });
      const job = jobs.createOrGet({
        kind: "video",
        sourceType: "image-to-video",
        model: "fixture-video",
        apiId: "upstream-api",
        modelCode: "model-code",
        expectedAssetScene: "video",
        requestFingerprint: "a".repeat(64),
        idempotencyKeyHash: null,
        spaceId: 1
      }).job;
      assets.bindToJob([asset.id], job.id, "prj_legacy");
      assetId = asset.id;
      jobId = job.id;
      jobs.close(); store.close();
    }
    {
      const store = new SqliteStore(dbPath);
      const assets = new SqliteAssetRepository(store, new LocalObjectStore(objectRoot));
      const listed = assets.listForJob(jobId);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: assetId, role: "input", jobId });
      const stored = listed[0];
      if (stored === undefined) throw new Error("Stored fixture asset was not found");
      const prepared = await assets.prepared(stored);
      expect(await bytes(prepared.openRead())).toEqual(body);
      store.close();
    }
  });

  it("rejects traversal keys and removes partial oversized writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-objects-"));
    directories.push(directory);
    const objects = new LocalObjectStore(directory);
    await expect(objects.put("../escape", Readable.from([Buffer.from("x")]), {
      expectedSize: 1,
      maxBytes: 1
    })).rejects.toThrow(/Invalid object storage key/u);
    await expect(objects.put("safe/large", Readable.from([Buffer.from("too large")]), {
      expectedSize: 9,
      maxBytes: 2
    })).rejects.toThrow(/storage limit/u);
    expect(await objects.get("safe/large")).toBeNull();
  });

  it("detects same-size object tampering before creating prepared media", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-asset-tamper-"));
    directories.push(directory);
    const store = new SqliteStore(join(directory, "data.sqlite"));
    const objects = new LocalObjectStore(join(directory, "objects"));
    const assets = new SqliteAssetRepository(store, objects);
    const asset = await assets.persistInput({
      userId: "usr_legacy",
      projectId: "prj_legacy",
      media: media(Buffer.from("original")),
      maxBytes: 1024
    });
    await objects.put(asset.storageKey, Readable.from([Buffer.from("tampered")]), {
      expectedSize: 8,
      maxBytes: 1024
    });
    await expect(assets.prepared(asset)).rejects.toThrow(/checksum mismatch/u);
    store.close();
  });

  it("cleans every previously persisted asset when a later batch item fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-asset-batch-"));
    directories.push(directory);
    const store = new SqliteStore(join(directory, "data.sqlite"));
    const objects = new LocalObjectStore(join(directory, "objects"));
    const assets = new SqliteAssetRepository(store, objects);
    await expect(assets.persistInputs({
      userId: "usr_legacy",
      projectId: "prj_legacy",
      media: [media(Buffer.from("ok")), media(Buffer.from("too large"))],
      maxBytes: 3
    })).rejects.toThrow(/storage limit/u);
    expect(store.read((database) => database.prepare(
      "SELECT COUNT(*) AS count FROM job_assets"
    ).get())).toEqual({ count: 0 });
    store.close();
  });

  it("deletes old unbound assets through retention cleanup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-asset-gc-"));
    directories.push(directory);
    let now = 100;
    const store = new SqliteStore(join(directory, "data.sqlite"));
    const objects = new LocalObjectStore(join(directory, "objects"));
    const assets = new SqliteAssetRepository(store, objects, () => now);
    const asset = await assets.persistInput({
      userId: "usr_legacy",
      projectId: "prj_legacy",
      media: media(),
      maxBytes: 1024
    });
    now = 200;
    expect(await assets.deleteUnbound(150)).toBe(1);
    expect(assets.findById(asset.id)).toBeNull();
    expect(await objects.get(asset.storageKey)).toBeNull();
    store.close();
  });

  it("deletes expired output assets but preserves unexpired media", async()=>{const directory=mkdtempSync(join(tmpdir(),"lingjing-expired-assets-"));directories.push(directory);let now=100;const store=new SqliteStore(join(directory,"data.sqlite")),objects=new LocalObjectStore(join(directory,"objects")),assets=new SqliteAssetRepository(store,objects,()=>now),jobs=new SqliteJobRepository(store),job=jobs.createOrGet({kind:"video",sourceType:"text-to-video",model:"m",apiId:"a",modelCode:null,expectedAssetScene:"v",requestFingerprint:"a".repeat(64),idempotencyKeyHash:null,spaceId:1}).job;const expired=await assets.persist({jobId:job.id,userId:"usr_legacy",projectId:"prj_legacy",role:"output",media:media(),maxBytes:1024,expiresAt:150});const active=await assets.persist({jobId:job.id,userId:"usr_legacy",projectId:"prj_legacy",role:"output",media:media(),maxBytes:1024,expiresAt:250});now=200;expect(await assets.deleteExpired(now)).toBe(1);expect(assets.findById(expired.id)).toBeNull();expect(assets.findById(active.id)).not.toBeNull();jobs.close();store.close();});

  it("rolls back the object when asset metadata cannot be inserted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-asset-rollback-"));
    directories.push(directory);
    const store = new SqliteStore(join(directory, "data.sqlite"));
    const objects = new LocalObjectStore(join(directory, "objects"));
    const assets = new SqliteAssetRepository(store, objects);
    await expect(assets.persistInput({
      userId: "missing-user",
      projectId: "missing-project",
      media: media(),
      maxBytes: 1024
    })).rejects.toThrow();
    const files = await readFile(join(directory, "data.sqlite")).catch(() => Buffer.alloc(0));
    expect(files.byteLength).toBeGreaterThan(0);
    expect(store.read((database) => database.prepare(
      "SELECT COUNT(*) AS count FROM job_assets"
    ).get())).toEqual({ count: 0 });
    store.close();
  });
});
