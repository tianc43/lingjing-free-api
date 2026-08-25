import type { SqliteStore } from "../persistence/sqlite-store.js";

export type LedgerEntryType = "hold" | "charge" | "release" | "refund" | "adjustment";
export interface UsageEntry {
  id: string;
  jobId: string;
  userId: string;
  projectId: string;
  apiKeyId: string | null;
  accountId: string;
  type: LedgerEntryType;
  points: number;
  reason: string;
  createdAt: number;
}
export interface UsageSummary {
  heldPoints: number;
  chargedPoints: number;
  releasedPoints: number;
  refundedPoints: number;
  adjustedPoints: number;
  netPoints: number;
  entryCount: number;
}
export interface UsageFilter {
  userId?: string;
  projectId?: string;
  apiKeyId?: string;
  accountId?: string;
  from?: number;
  to?: number;
  limit: number;
}
interface Row { id:string; job_id:string; user_id:string; project_id:string; api_key_id:string|null; account_id:string; entry_type:LedgerEntryType; points:number; reason:string; created_at:number }
function fromRow(row: Row): UsageEntry { return { id:row.id, jobId:row.job_id, userId:row.user_id, projectId:row.project_id, apiKeyId:row.api_key_id, accountId:row.account_id, type:row.entry_type, points:row.points, reason:row.reason, createdAt:row.created_at }; }

export class SqliteUsageRepository {
  constructor(private readonly store: SqliteStore) {}
  list(filter: UsageFilter): UsageEntry[] {
    if (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 1000) throw new RangeError("Usage limit must be between 1 and 1000");
    const clauses: string[] = []; const params: unknown[] = [];
    for (const [column, value] of [["user_id",filter.userId],["project_id",filter.projectId],["api_key_id",filter.apiKeyId],["account_id",filter.accountId]] as const) {
      if (value !== undefined) { clauses.push(`${column} = ?`); params.push(value); }
    }
    if (filter.from !== undefined) { clauses.push("created_at >= ?"); params.push(filter.from); }
    if (filter.to !== undefined) { clauses.push("created_at <= ?"); params.push(filter.to); }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return this.store.read((database) => (database.prepare(`
      SELECT id,job_id,user_id,project_id,api_key_id,account_id,entry_type,points,reason,created_at
      FROM usage_ledger ${where} ORDER BY created_at DESC,id DESC LIMIT ?
    `).all(...params, filter.limit) as Row[]).map(fromRow));
  }
  summary(filter: Omit<UsageFilter,"limit"> = {}): UsageSummary {
    const clauses:string[]=[];const params:unknown[]=[];
    for(const[column,value]of[["user_id",filter.userId],["project_id",filter.projectId],["api_key_id",filter.apiKeyId],["account_id",filter.accountId]]as const){if(value!==undefined){clauses.push(`${column}=?`);params.push(value);}}
    if(filter.from!==undefined){clauses.push("created_at>=?");params.push(filter.from);}if(filter.to!==undefined){clauses.push("created_at<=?");params.push(filter.to);}
    const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
    const row=this.store.read(db=>db.prepare(`SELECT COALESCE(SUM(CASE WHEN entry_type='hold' THEN points ELSE 0 END),0) held,COALESCE(SUM(CASE WHEN entry_type='charge' THEN points ELSE 0 END),0) charged,COALESCE(SUM(CASE WHEN entry_type='release' THEN points ELSE 0 END),0) released,COALESCE(SUM(CASE WHEN entry_type='refund' THEN points ELSE 0 END),0) refunded,COALESCE(SUM(CASE WHEN entry_type='adjustment' THEN points ELSE 0 END),0) adjusted,COUNT(*) count FROM usage_ledger ${where}`).get(...params)as{held:number;charged:number;released:number;refunded:number;adjusted:number;count:number});
    return{heldPoints:row.held,chargedPoints:row.charged,releasedPoints:row.released,refundedPoints:row.refunded,adjustedPoints:row.adjusted,netPoints:row.charged-row.refunded+row.adjusted,entryCount:row.count};
  }
}
