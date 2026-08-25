import type { SourceType } from "../models/types.js";

export type JobStatus =
  | "queued"
  | "submitting"
  | "discovering"
  | "processing"
  | "unknown"
  | "completed"
  | "failed";

export interface NewJob {
  userId?: string;
  projectId?: string;
  apiKeyId?: string | null;
  kind: "image" | "video";
  sourceType: SourceType;
  model: string;
  apiId: string;
  modelCode: string | null;
  expectedAssetScene: string;
  requestFingerprint: string;
  idempotencyKeyHash: string | null;
  spaceId: number;
}

export interface JobOutput {
  url: string;
  posterUrl: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  format: string | null;
}

export interface JobResult {
  outputs: JobOutput[];
}

export interface JobFence {
  workerId: string;
  leaseToken: string;
  fencingToken: number;
  now: number;
}

export interface JobTransition {
  status: JobStatus;
  creationCode?: string | null;
  upstreamTaskId?: string | null;
  upstreamFingerprint?: string | null;
  submittedAt?: number;
  discoveredAt?: number;
  completedAt?: number;
  failedAt?: number;
  unknownHoldUntil?: number | null;
  processingDeadlineAt?: number | null;
  reconcileAfter?: number | null;
  uncertaintyReason?: string | null;
  pollAttempts?: number;
  lastPolledAt?: number | null;
  errorCode?: string | null;
  archivedResult?: JobResult;
  result?: JobResult | null;
}

export interface JobListFilter {
  projectId?: string;
  status?: JobStatus;
  kind?: "image" | "video";
  before?: number;
  limit: number;
}

export interface ReconciliationFilter {
  dueAt: number;
  limit: number;
}

export interface JobRecord extends NewJob {
  id: string;
  accountId: string;
  quotedPoints: number | null;
  status: JobStatus;
  creationCode: string | null;
  upstreamTaskId: string | null;
  upstreamFingerprint: string | null;
  submittedAt: number | null;
  discoveredAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  unknownHoldUntil: number | null;
  processingDeadlineAt?: number | null;
  reconcileAfter?: number | null;
  uncertaintyReason?: string | null;
  pollAttempts?: number;
  lastPolledAt?: number | null;
  errorCode: string | null;
  result: JobResult | null;
  createdAt: number;
  updatedAt: number;
}

export interface CapacityLease {
  readonly jobId: string;
  release(): void;
}

export interface CapacityAdmission {
  acquire(jobId: string): Promise<CapacityLease>;
  release(): void;
}
