export type AccountHealth =
  | "unknown"
  | "ready"
  | "needs_login"
  | "unhealthy";

export interface AccountRecord {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  dailyPointLimit: number;
  monthlyPointLimit: number;
  authDirectory: string;
  healthStatus: AccountHealth;
  lastErrorCode: string | null;
  subjectHash: string | null;
  pointsBalance: number | null;
  totalBalance: number | null;
  maxConcurrency: number | null;
  lastCheckedAt: number | null;
  lastSelectedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAccountInput {
  name: string;
  priority: number;
  dailyPointLimit: number;
  monthlyPointLimit: number;
}

export interface UpdateAccountInput {
  name?: string;
  enabled?: boolean;
  priority?: number;
  dailyPointLimit?: number;
  monthlyPointLimit?: number;
}

export interface AccountObservation {
  healthStatus: AccountHealth;
  lastErrorCode: string | null;
  subjectHash: string | null;
  pointsBalance: number | null;
  totalBalance: number | null;
  maxConcurrency: number | null;
  checkedAt?: number;
}

export interface BudgetWindow {
  dayWindowStart: number;
  monthWindowStart: number;
}

export interface AccountBudgetUsage {
  dayUsedPoints: number;
  monthUsedPoints: number;
}

export interface AdmissionInput extends NewJob {
  accountId: string;
  quotedPoints: number;
  windows: BudgetWindow;
}

export type AdmissionResult =
  | { outcome: "created"; job: JobRecord }
  | { outcome: "existing"; job: JobRecord }
  | { outcome: "account_unavailable" }
  | { outcome: "budget_exhausted" };
import type { JobRecord, NewJob } from "../jobs/types.js";
