import type { GenerationRequest } from "./types.js";
import type { SqliteStore } from "../persistence/sqlite-store.js";

export interface GenerationRequestSnapshot {
  jobId: string;
  request: Omit<GenerationRequest, "media" | "idempotencyKey">;
  createdAt: number;
  updatedAt: number;
}

interface SnapshotRow {
  job_id: string;
  kind: "image" | "video";
  source_type: string;
  model: string;
  values_json: string;
  user_id: string;
  project_id: string;
  api_key_id: string | null;
  created_at: number;
  updated_at: number;
}

function parseValues(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Generation request snapshot values are invalid");
  }
  return parsed as Record<string, unknown>;
}

function fromRow(row: SnapshotRow): GenerationRequestSnapshot {
  return {
    jobId: row.job_id,
    request: {
      principal: {
        userId: row.user_id,
        projectId: row.project_id,
        apiKeyId: row.api_key_id ?? "key_legacy_environment"
      },
      kind: row.kind,
      sourceType: row.source_type,
      model: row.model,
      values: parseValues(row.values_json)
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class SqliteRequestSnapshotRepository {
  constructor(
    private readonly store: SqliteStore,
    private readonly now: () => number = Date.now
  ) {}

  save(jobId: string, request: GenerationRequest): GenerationRequestSnapshot {
    const principal = request.principal ?? {
      userId: "usr_legacy",
      projectId: "prj_legacy",
      apiKeyId: "key_legacy_environment"
    };
    const valuesJson = JSON.stringify(request.values);
    const now = this.now();
    this.store.immediate((database) => {
      database.prepare(`
        INSERT INTO generation_request_snapshots (
          job_id, kind, source_type, model, values_json,
          user_id, project_id, api_key_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO NOTHING
      `).run(
        jobId,
        request.kind,
        request.sourceType,
        request.model,
        valuesJson,
        principal.userId,
        principal.projectId,
        principal.apiKeyId === "key_legacy_environment" ? null : principal.apiKeyId,
        now,
        now
      );
      const row = this.findRow(database, jobId);
      if (row === undefined) throw new Error("Generation snapshot was not persisted");
      if (
        row.kind !== request.kind
        || row.source_type !== request.sourceType
        || row.model !== request.model
        || row.values_json !== valuesJson
        || row.user_id !== principal.userId
        || row.project_id !== principal.projectId
      ) throw new Error("Generation snapshot conflict");
    });
    const saved = this.find(jobId);
    if (saved === null) throw new Error("Generation snapshot was not found");
    return saved;
  }

  find(jobId: string): GenerationRequestSnapshot | null {
    return this.store.read((database) => {
      const row = this.findRow(database, jobId);
      return row === undefined ? null : fromRow(row);
    });
  }

  private findRow(
    database: import("better-sqlite3").Database,
    jobId: string
  ): SnapshotRow | undefined {
    return database.prepare(`
      SELECT job_id, kind, source_type, model, values_json, user_id, project_id,
        api_key_id, created_at, updated_at
      FROM generation_request_snapshots WHERE job_id = ?
    `).get(jobId) as SnapshotRow | undefined;
  }
}
