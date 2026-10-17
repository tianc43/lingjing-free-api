import { randomUUID } from "node:crypto";
import type { SqliteStore } from "../persistence/sqlite-store.js";
import { extractUpstreamDiagnostics, upstreamBusinessFailed, type UpstreamDiagnostics } from "../lingjing/error-map.js";
import { callContext } from "./context.js";
import { MAX_BODY_CHARS, sanitize, sanitizedPath } from "./redaction.js";

export const CALL_LOG_RETENTION = { days: 30, max_records: 10_000, max_body_chars: MAX_BODY_CHARS };
export interface CallLogSummary {
  id: string; trace_id: string; parent_id: string | null; direction: "inbound" | "outbound";
  method: string; path: string; status_code: number | null; status: "pending" | "success" | "error";
  duration_ms: number | null; started_at: number; finished_at: number | null;
  job_id: string | null; account_id: string | null; error_code: string | null;
  upstream?: UpstreamDiagnostics;
  upstream_status?: "failed" | "not_reported" | "unknown";
}
export interface CallLog extends CallLogSummary {
  request_headers: unknown; request_body: unknown; response_headers: unknown; response_body: unknown; error_message: string | null;
}
export interface CallLogFilter { direction?: "inbound" | "outbound" | undefined; status?: "pending" | "success" | "error" | undefined; search?: string | undefined; page?: number; page_size?: number; }
export interface CallStart { direction: CallLogSummary["direction"]; method: string; path: string; headers?: unknown; body?: unknown; accountId?: string; }
const SUMMARY_COLUMNS = "id,trace_id,parent_id,direction,method,path,status_code,status,duration_ms,started_at,finished_at,job_id,account_id,error_code,response_body";
// Derive historical mistakes at read time; preserve the original stored HTTP/body evidence.
const EFFECTIVE_STATUS = "CASE WHEN direction='outbound' AND status='success' AND call_log_business_failed(response_body)=1 THEN 'error' ELSE status END";
function parseBody(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}
function summarize(row: CallLogSummary & { response_body?: unknown }): CallLogSummary {
  const { response_body: body, ...record } = row;
  if (record.direction !== "outbound") return record;
  const response = parseBody(body);
  const failed = upstreamBusinessFailed(response);
  const upstream = extractUpstreamDiagnostics(response, record.status_code ?? undefined);
  return {
    ...record,
    ...(failed && record.status === "success" ? { status: "error" } : {}),
    ...(upstream === undefined ? {} : { upstream }),
    upstream_status: failed ? "failed" : record.status === "success" && response != null ? "not_reported" : "unknown"
  };
}
function errorText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "Request failed";
}

export class SqliteCallLogRepository {
  constructor(private readonly store: SqliteStore) {
    store.read(db => db.function("call_log_business_failed", { deterministic: true }, (body: unknown) => upstreamBusinessFailed(parseBody(body)) ? 1 : 0));
    store.read((db) => db.exec(`CREATE TABLE IF NOT EXISTS api_call_logs (
      id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT, direction TEXT NOT NULL,
      method TEXT NOT NULL, path TEXT NOT NULL, status_code INTEGER, status TEXT NOT NULL,
      duration_ms INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, job_id TEXT, account_id TEXT,
      error_code TEXT, error_message TEXT, request_headers TEXT, request_body TEXT, response_headers TEXT, response_body TEXT
    ); CREATE INDEX IF NOT EXISTS api_call_logs_started ON api_call_logs(started_at DESC);
    CREATE INDEX IF NOT EXISTS api_call_logs_trace ON api_call_logs(trace_id);
    CREATE INDEX IF NOT EXISTS api_call_logs_job ON api_call_logs(job_id);`));
    store.read((db) => db.prepare("UPDATE api_call_logs SET status='error',error_code='process_interrupted',error_message='Service stopped before the call completed',finished_at=?,duration_ms=MAX(0,?-started_at) WHERE status='pending'").run(Date.now(), Date.now()));
  }

  // Observability must never cause an API request or provider operation to fail.
  start(input: CallStart): string | null {
    try {
      const id = randomUUID();
      const context = callContext.getStore();
      this.store.immediate((db) => {
        db.prepare(`INSERT INTO api_call_logs (id,trace_id,parent_id,direction,method,path,status,started_at,job_id,account_id,request_headers,request_body) VALUES (?,?,?,?,?,?,'pending',?,?,?,?,?)`)
          .run(id, context?.traceId ?? randomUUID(), context?.parentId ?? null, input.direction, input.method, sanitizedPath(input.path), Date.now(), context?.jobId ?? null, input.accountId ?? null, JSON.stringify(sanitize(input.headers, 8192)), JSON.stringify(sanitize(input.body)));
        db.prepare("DELETE FROM api_call_logs WHERE started_at < ?").run(Date.now() - CALL_LOG_RETENTION.days * 86_400_000);
        db.prepare("DELETE FROM api_call_logs WHERE id IN (SELECT id FROM api_call_logs ORDER BY started_at DESC,id DESC LIMIT -1 OFFSET ?)").run(CALL_LOG_RETENTION.max_records);
      });
      return id;
    } catch { return null; }
  }

  finish(id: string | null, input: { statusCode?: number; body?: unknown; headers?: unknown; error?: unknown; requestBody?: unknown; requestHeaders?: unknown; jobId?: string | null }): void {
    if (id === null) return;
    try {
      let responseValue: unknown = input.body;
      if (typeof responseValue === "string") { try { responseValue = JSON.parse(responseValue) as unknown; } catch { /* text response */ } }
      const outbound = this.store.read(db => (db.prepare("SELECT direction FROM api_call_logs WHERE id=?").get(id) as { direction: string } | undefined)?.direction === "outbound");
      const businessFailed = outbound && upstreamBusinessFailed(responseValue);
      const responseError = ((input.statusCode ?? 200) >= 400 || businessFailed) && typeof responseValue === "object" && responseValue !== null && "error" in responseValue ? responseValue.error ?? undefined : undefined;
      const error = input.error ?? responseError ?? (input.statusCode === undefined ? { code: "response_unverified", message: "No HTTP response was verified; official outcome is unknown" } : undefined);
      const codeValue = typeof error === "object" && "code" in error ? sanitize(errorText(error.code), 256) : error === undefined ? businessFailed ? "upstream_business_failed" : null : "request_failed";
      const code = typeof codeValue === "string" || codeValue === null ? codeValue : JSON.stringify(codeValue);
      const message = error instanceof Error ? error.message : typeof error === "object" && "message" in error ? errorText(error.message) : error === undefined ? null : errorText(error);
      const safeMessage = message === null ? null : sanitize(message, 2048);
      this.store.read((db) => db.prepare(`UPDATE api_call_logs SET status_code=?,status=?,finished_at=?,duration_ms=MAX(0,?-started_at),response_headers=?,response_body=?,error_code=?,error_message=?,request_body=COALESCE(?,request_body),request_headers=COALESCE(?,request_headers),job_id=COALESCE(?,job_id) WHERE id=?`)
        .run(input.statusCode ?? null, error !== undefined || businessFailed || (input.statusCode ?? 200) >= 400 ? "error" : "success", Date.now(), Date.now(), JSON.stringify(sanitize(input.headers, 8192)), JSON.stringify(sanitize(input.body)), code, typeof safeMessage === "string" || safeMessage === null ? safeMessage : JSON.stringify(safeMessage), input.requestBody === undefined ? null : JSON.stringify(sanitize(input.requestBody)), input.requestHeaders === undefined ? null : JSON.stringify(sanitize(input.requestHeaders, 8192)), input.jobId ?? callContext.getStore()?.jobId ?? null, id));
    } catch { /* best effort */ }
  }

  list(filter: CallLogFilter = {}) {
    const page = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filter.page_size ?? 25));
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    for (const name of ["direction", "status"] as const) if (filter[name]) { conditions.push(`${name === "status" ? EFFECTIVE_STATUS : name}=?`); values.push(filter[name]); }
    if (filter.search) {
      conditions.push("(path LIKE ? ESCAPE '\\' OR trace_id LIKE ? ESCAPE '\\' OR job_id LIKE ? ESCAPE '\\' OR account_id LIKE ? ESCAPE '\\' OR error_code LIKE ? ESCAPE '\\' OR response_body LIKE ? ESCAPE '\\')");
      const query = `%${filter.search.replace(/[\\%_]/gu, "\\$&")}%`;
      values.push(query, query, query, query, query, query);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.store.read((db) => ({
      items: (db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM api_call_logs ${where} ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize) as (CallLogSummary & { response_body: unknown })[]).map(summarize),
      total: (db.prepare(`SELECT COUNT(*) AS total FROM api_call_logs ${where}`).get(...values) as { total: number }).total,
      page, page_size: pageSize, retention: CALL_LOG_RETENTION
    }));
  }

  find(id: string): { record: CallLog; related: CallLogSummary[] } | null {
    return this.store.read((db) => {
      const row = db.prepare("SELECT * FROM api_call_logs WHERE id=?").get(id) as (CallLog & Record<string, unknown>) | undefined;
      if (!row) return null;
      const record: CallLog = { ...row, ...summarize(row) };
      for (const key of ["request_headers", "request_body", "response_headers", "response_body"] as const) record[key] = parseBody(row[key]);
      const related = (db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM api_call_logs WHERE id<>? AND (trace_id=? OR (job_id IS NOT NULL AND job_id=?)) ORDER BY started_at ASC,id ASC LIMIT 100`).all(id, row.trace_id, row.job_id) as (CallLogSummary & { response_body: unknown })[]).map(summarize);
      return { record, related };
    });
  }
}
