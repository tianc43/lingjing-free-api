import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { Readable } from "node:stream";
import type { SqliteStore } from "../persistence/sqlite-store.js";
import type { PreparedMedia } from "./types.js";
import type { ObjectStore } from "./object-store.js";

export interface JobAssetRecord {
  id: string;
  jobId: string | null;
  userId: string;
  projectId: string;
  role: "input" | "output" | "poster";
  storageKey: string;
  sha256: string;
  mimeType: string;
  filename: string;
  sizeBytes: number;
  createdAt: number;
  expiresAt: number | null;
}

interface AssetRow {
  id: string;
  job_id: string | null;
  user_id: string;
  project_id: string;
  role: "input" | "output" | "poster";
  storage_key: string;
  sha256: string;
  mime_type: string;
  filename: string;
  size_bytes: number;
  created_at: number;
  expires_at: number | null;
}

function fromRow(row: AssetRow): JobAssetRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    projectId: row.project_id,
    role: row.role,
    storageKey: row.storage_key,
    sha256: row.sha256,
    mimeType: row.mime_type,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

export class SqliteAssetRepository {
  constructor(
    private readonly store: SqliteStore,
    private readonly objects: ObjectStore,
    private readonly now: () => number = Date.now
  ) {}

  async persist(input:{jobId:string;userId:string;projectId:string;role:"output"|"poster";media:PreparedMedia;maxBytes:number;expiresAt?:number|null}):Promise<JobAssetRecord>{const id=`asset_${randomBytes(16).toString("hex")}`;const key=`projects/${input.projectId}/${input.role}s/${id}`;const hash=createHash("sha256");async function* stream(){for await(const chunk of input.media.openRead()){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array|string);hash.update(buffer);yield buffer;}}await this.objects.put(key,Readable.from(stream()),{expectedSize:input.media.size,maxBytes:input.maxBytes});const now=this.now();try{this.store.immediate(db=>db.prepare(`INSERT INTO job_assets(id,job_id,user_id,project_id,role,storage_key,sha256,mime_type,filename,size_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.jobId,input.userId,input.projectId,input.role,key,hash.digest("hex"),input.media.contentType,input.media.filename,input.media.size,input.expiresAt??null,now));}catch(cause){await this.objects.remove(key).catch(()=>undefined);throw cause;}const record=this.findById(id);if(!record)throw new Error("Persisted output asset not found");return record;}

  async persistInput(input: {
    userId: string;
    projectId: string;
    media: PreparedMedia;
    maxBytes: number;
  }): Promise<JobAssetRecord> {
    const id = `asset_${randomBytes(16).toString("hex")}`;
    const key = `projects/${input.projectId}/inputs/${id}`;
    const hash = createHash("sha256");
    async function* hashingStream(): AsyncGenerator<Buffer> {
      for await (const chunk of input.media.openRead()) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array | string);
        hash.update(buffer);
        yield buffer;
      }
    }
    await this.objects.put(
      key,
      Readable.from(hashingStream()),
      { expectedSize: input.media.size, maxBytes: input.maxBytes }
    );
    const now = this.now();
    try {
      this.store.immediate((database) => database.prepare(`
        INSERT INTO job_assets (
          id, job_id, user_id, project_id, role, storage_key, sha256,
          mime_type, filename, size_bytes, created_at
        ) VALUES (?, NULL, ?, ?, 'input', ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.userId, input.projectId, key, hash.digest("hex"),
        input.media.contentType, input.media.filename, input.media.size, now
      ));
    } catch (cause) {
      await this.objects.remove(key).catch(() => undefined);
      throw cause;
    }
    const record = this.findById(id);
    if (record === null) throw new Error("Persisted asset was not found");
    return record;
  }

  bindToJob(assetIds: readonly string[], jobId: string, projectId: string): void {
    this.store.immediate((database) => {
      for (const assetId of assetIds) {
        const result = database.prepare(`
          UPDATE job_assets SET job_id = ?
          WHERE id = ? AND project_id = ? AND job_id IS NULL AND role = 'input'
        `).run(jobId, assetId, projectId);
        if (result.changes !== 1) throw new Error("Input asset binding conflict");
      }
    });
  }

  listForJob(jobId: string, role: JobAssetRecord["role"] = "input"): JobAssetRecord[] {
    return this.store.read((database) => (database.prepare(`
      SELECT id, job_id, user_id, project_id, role, storage_key, sha256,
        mime_type, filename, size_bytes, created_at
      FROM job_assets WHERE job_id = ? AND role = ? ORDER BY created_at, id
    `).all(jobId, role) as AssetRow[]).map(fromRow));
  }

  async persistInputs(input: {
    userId: string;
    projectId: string;
    media: readonly PreparedMedia[];
    maxBytes: number;
  }): Promise<JobAssetRecord[]> {
    const persisted: JobAssetRecord[] = [];
    try {
      for (const media of input.media) {
        persisted.push(await this.persistInput({
          userId: input.userId,
          projectId: input.projectId,
          media,
          maxBytes: input.maxBytes
        }));
      }
      return persisted;
    } catch (cause) {
      await Promise.allSettled(persisted.map((asset) => this.delete(asset.id)));
      throw cause;
    }
  }

  async delete(id: string): Promise<boolean> {
    const asset = this.findById(id);
    if (asset === null) return false;
    await this.objects.remove(asset.storageKey);
    this.store.immediate((database) => {
      const result = database.prepare("DELETE FROM job_assets WHERE id = ?").run(id);
      if (result.changes !== 1) throw new Error("Asset metadata delete conflict");
    });
    return true;
  }

  async deleteForJob(jobId:string,roles:readonly JobAssetRecord["role"][]):Promise<number>{const assets=this.store.read(db=>(db.prepare(`SELECT id,job_id,user_id,project_id,role,storage_key,sha256,mime_type,filename,size_bytes,created_at,expires_at FROM job_assets WHERE job_id=?`).all(jobId) as AssetRow[]).map(fromRow).filter(asset=>roles.includes(asset.role)));let deleted=0;for(const asset of assets)if(await this.delete(asset.id))deleted++;return deleted;}

  async deleteExpired(now:number,limit=100):Promise<number>{const assets=this.store.read(db=>(db.prepare(`SELECT id,job_id,user_id,project_id,role,storage_key,sha256,mime_type,filename,size_bytes,created_at,expires_at FROM job_assets WHERE expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT ?`).all(now,limit) as AssetRow[]).map(fromRow));let deleted=0;for(const asset of assets)if(await this.delete(asset.id))deleted++;return deleted;}

  async deleteUnbound(olderThan: number, limit = 100): Promise<number> {
    const assets = this.store.read((database) => database.prepare(`
      SELECT id, job_id, user_id, project_id, role, storage_key, sha256,
        mime_type, filename, size_bytes, created_at
      FROM job_assets
      WHERE job_id IS NULL AND created_at < ?
      ORDER BY created_at ASC LIMIT ?
    `).all(olderThan, limit) as AssetRow[]).map(fromRow);
    let deleted = 0;
    for (const asset of assets) {
      if (await this.delete(asset.id)) deleted += 1;
    }
    return deleted;
  }

  async prepared(asset: JobAssetRecord): Promise<PreparedMedia> {
    const object = await this.objects.get(asset.storageKey);
    if (object === null || object.size !== asset.sizeBytes) {
      throw new Error("Persisted input asset is unavailable");
    }
    const hash = createHash("sha256");
    for await (const chunk of object.openRead()) {
      hash.update(Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array | string));
    }
    const actual = hash.digest();
    const expected = Buffer.from(asset.sha256, "hex");
    if (
      actual.length !== expected.length
      || !timingSafeEqual(actual, expected)
    ) {
      throw new Error("Persisted input asset checksum mismatch");
    }
    return {
      filename: asset.filename,
      contentType: asset.mimeType,
      size: asset.sizeBytes,
      openRead: (start, endInclusive) => object.openRead(start, endInclusive),
      // Object lifecycle belongs to retention policy, not one Worker attempt.
      dispose: () => Promise.resolve()
    };
  }

  findById(id: string): JobAssetRecord | null {
    return this.store.read((database) => {
      const row = database.prepare(`
        SELECT id, job_id, user_id, project_id, role, storage_key, sha256,
          mime_type, filename, size_bytes, created_at
        FROM job_assets WHERE id = ?
      `).get(id) as AssetRow | undefined;
      return row === undefined ? null : fromRow(row);
    });
  }
}
