import type {
  CapacityLease,
  JobRecord,
  JobStatus,
  JobTransition,
  NewJob
} from "../jobs/types.js";
import type { MediaInput, PreparedMedia } from "../media/types.js";
import type { NormalizedModel, SourceType } from "../models/types.js";

export interface GenerationRequest {
  kind: "image" | "video";
  sourceType: SourceType;
  model: string;
  values: Record<string, unknown>;
  media: MediaInput[];
  idempotencyKey: string | null;
}

export interface GenerationHandle {
  job: JobRecord;
  wait(timeoutMs: number, signal?: AbortSignal): Promise<JobRecord>;
}

export interface GenerationCoordinator {
  /**
   * Takes ownership of every prepared media input when invoked, including
   * requests that reject before a job is created.
   */
  create(request: GenerationRequest): Promise<GenerationHandle>;
  resume(jobId: string): Promise<GenerationHandle>;
  resolveUnknown(
    accountId: string,
    jobId: string,
    action: "charge" | "release"
  ): {
    job: JobRecord;
    state: "reserved" | "charged" | "released";
  };
  stopPollers(): void;
}

export interface JobRunnerRegistry {
  startOnce(
    jobId: string,
    work: () => Promise<void>
  ): { promise: Promise<void>; started: boolean };
  has(jobId: string): boolean;
  stopAccepting(): void;
  drainSubmitCriticalSections(timeoutMs: number): Promise<void>;
}

export interface GenerationRepository {
  createOrGet(input: NewJob): { created: boolean; job: JobRecord };
  findById(id: string): JobRecord | null;
  transition(
    id: string,
    expectedStatuses: readonly JobStatus[],
    transition: JobTransition
  ): JobRecord;
}

export interface PreparedGeneration {
  request: GenerationRequest;
  model: NormalizedModel;
  spaceId: number;
  media: PreparedMedia[];
  inputContentHashes: string[];
}

export type RecoveryResumeRunner = (
  job: JobRecord,
  lease: CapacityLease
) => Promise<void>;
