import { randomUUID } from "node:crypto";
import { AppError, errors } from "../errors.js";
import type {
  GenerationRequest
} from "../generation/types.js";
import type { CapacityManager } from "../jobs/capacity.js";
import { createRequestFingerprint } from "../jobs/fingerprint.js";
import type {
  CapacityAdmission,
  CapacityLease,
  JobRecord
} from "../jobs/types.js";
import type { NormalizedModel } from "../models/types.js";
import { budgetWindows } from "./budget.js";
import { quotedPoints } from "./quote.js";
import type { AccountRuntime } from "./runtime.js";
import type { AccountRuntimeRegistry } from "./runtime-registry.js";
import type { SqliteAccountRepository } from "./sqlite-account-repository.js";
import type { SqliteAdmissionRepository } from "./sqlite-admission-repository.js";
import type { AccountRecord } from "./types.js";

export type AccountAdmission =
  | {
    runtime: AccountRuntime;
    model: NormalizedModel;
    job: JobRecord;
    lease: CapacityLease;
    created: true;
  }
  | {
    runtime: null;
    model: null;
    job: JobRecord;
    lease: null;
    created: false;
  };

export interface AccountSchedulerOptions {
  registry: Pick<
    AccountRuntimeRegistry,
    "find" | "listEnabled" | "listRetained" | "require"
  >;
  accounts: Pick<SqliteAccountRepository, "findById" | "usage">;
  admissions: Pick<
    SqliteAdmissionRepository,
    "findByIdempotencyKeyHash" | "reserveOrGet" | "failAndRelease"
  >;
  capacity: CapacityManager;
  now?: () => number;
}

interface Candidate {
  runtime: AccountRuntime;
  record: AccountRecord;
  model: NormalizedModel;
  spaceId: number;
  quote: number | null;
  activeJobs: number;
}

class CompositeCapacityLease implements CapacityLease {
  readonly jobId: string;
  private released = false;

  constructor(private readonly leases: readonly CapacityLease[]) {
    const first = leases[0];
    if (first === undefined) throw new Error("Composite capacity lease is empty");
    this.jobId = first.jobId;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const lease of this.leases) lease.release();
  }
}

export function combineCapacityLeases(
  ...leases: CapacityLease[]
): CapacityLease {
  return new CompositeCapacityLease(leases);
}

function mediaParameter(model: NormalizedModel): (
  NormalizedModel["parameters"][number] | undefined
) {
  const parameters = model.parameters.filter(
    (parameter) => parameter.kind === "image-list"
  );
  return parameters.find(parameter=>parameter.required)??parameters[0];
}

export function validateGenerationMedia(
  request: GenerationRequest,
  model: NormalizedModel
): void {
  const parameter = mediaParameter(model);
  if (request.media.some((input) => input.kind !== "image")) {
    throw errors.invalidRequest("Model only accepts image media", "media");
  }
  if (parameter === undefined) {
    if (request.media.length > 0) {
      throw errors.invalidRequest("Model does not accept media", "media");
    }
    return;
  }
  if (parameter.required && request.media.length === 0) {
    throw errors.invalidRequest("Model requires media", "media");
  }
  if (
    parameter.maxFiles !== undefined
    && request.media.length > parameter.maxFiles
  ) {
    throw errors.invalidRequest("Too many media inputs", "media");
  }

}

function capacityFull(cause: unknown): boolean {
  return cause instanceof AppError
    && cause.code === "lingjing_capacity_queue_full";
}

function newJobId(): string {
  return `job_${randomUUID().replaceAll("-", "")}`;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return left.record.priority - right.record.priority
    || left.activeJobs - right.activeJobs
    || (left.record.lastSelectedAt ?? Number.NEGATIVE_INFINITY)
      - (right.record.lastSelectedAt ?? Number.NEGATIVE_INFINITY)
    || left.record.id.localeCompare(right.record.id);
}

export class AccountScheduler {
  private readonly now: () => number;

  constructor(private readonly options: AccountSchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): CapacityAdmission {
    try {
      return this.options.capacity.admit(randomUUID());
    } catch (cause) {
      if (capacityFull(cause)) throw errors.capacityExhausted();
      throw cause;
    }
  }

  async admit(input: {
    request: GenerationRequest;
    requestFingerprint: string;
    idempotencyKeyHash: string | null;
    inputContentHashes?: readonly string[];
    globalAdmission?: CapacityAdmission;
  }): Promise<AccountAdmission> {
    let globalAdmission = input.globalAdmission ?? this.start();
    let transferred = false;
    try {
      if (input.idempotencyKeyHash !== null) {
        const existing = this.options.admissions.findByIdempotencyKeyHash(
          input.idempotencyKeyHash
        );
        if (existing !== null) {
          if (
            existing.requestFingerprint
            !== this.fingerprintForApiId(input, existing.apiId)
          ) {
            throw errors.idempotencyConflict();
          }
          globalAdmission.release();
          transferred = true;
          return {
            runtime: null,
            model: null,
            job: existing,
            lease: null,
            created: false
          };
        }
      }
      const evaluation = await this.candidates(input.request);
      const { candidates } = evaluation;
      if (candidates.length === 0) {
        throw evaluation.validationError ?? errors.noEligibleAccount();
      }

      let fullCandidates = 0;
      for (const [index, candidate] of candidates.entries()) {
        const hasNextCandidate = index < candidates.length - 1;
        const requestFingerprint = this.fingerprintForApiId(
          input,
          candidate.model.apiId
        );
        const jobId = newJobId();
        const globalLease = await globalAdmission.acquire(jobId);
        let accountAdmission: CapacityAdmission;
        try {
          accountAdmission = candidate.runtime.capacity.admit(randomUUID());
        } catch (cause) {
          globalLease.release();
          if (capacityFull(cause)) {
            fullCandidates += 1;
            if (hasNextCandidate) globalAdmission = this.start();
            continue;
          }
          throw cause;
        }

        let accountLease: CapacityLease;
        try {
          accountLease = await accountAdmission.acquire(jobId);
        } catch (cause) {
          accountAdmission.release();
          globalLease.release();
          throw cause;
        }

        let result;
        try {
          result = this.options.admissions.reserveOrGet({
            jobId,
            userId: input.request.principal?.userId ?? "usr_legacy",
            projectId: input.request.principal?.projectId ?? "prj_legacy",
            apiKeyId: input.request.principal?.apiKeyId === "key_legacy_environment"
              ? null
              : input.request.principal?.apiKeyId ?? null,
            kind: input.request.kind,
            sourceType: input.request.sourceType,
            model: input.request.model,
            apiId: candidate.model.apiId,
            modelCode: candidate.model.modelCode,
            expectedAssetScene: candidate.model.expectedAssetScene,
            requestFingerprint,
            idempotencyKeyHash: input.idempotencyKeyHash,
            spaceId: candidate.spaceId,
            accountId: candidate.record.id,
            quotedPoints: candidate.quote,
            windows: budgetWindows(this.now())
          });
        } catch (cause) {
          accountLease.release();
          globalLease.release();
          throw cause;
        }

        if (result.outcome === "created") {
          transferred = true;
          return {
            runtime: candidate.runtime,
            model: candidate.model,
            job: result.job,
            lease: combineCapacityLeases(globalLease, accountLease),
            created: true
          };
        }

        accountLease.release();
        globalLease.release();
        if (result.outcome === "project_quota_exhausted") throw errors.insufficientQuota();
        if (result.outcome === "project_capacity_exhausted") throw errors.capacityExhausted();
        if (result.outcome === "existing") {
          transferred = true;
          return {
            runtime: null,
            model: null,
            job: result.job,
            lease: null,
            created: false
          };
        }
        if (hasNextCandidate) globalAdmission = this.start();
      }

      throw fullCandidates === candidates.length
        ? errors.capacityExhausted()
        : errors.noEligibleAccount();
    } finally {
      if (!transferred) globalAdmission.release();
    }
  }

  restore(job: JobRecord): AccountRuntime {
    return this.options.registry.require(job.accountId);
  }

  tryRestore(job: JobRecord): AccountRuntime | null {
    return this.options.registry.find(job.accountId);
  }

  expireUnknown(now: number): void {
    for (const runtime of this.options.registry.listRetained()) {
      runtime.capacity.expireUnknown(now);
    }
  }

  private fingerprintForApiId(
    input: {
      request: GenerationRequest;
      requestFingerprint: string;
      inputContentHashes?: readonly string[];
    },
    apiId: string
  ): string {
    return input.inputContentHashes === undefined
      ? input.requestFingerprint
      : createRequestFingerprint({
          model: apiId,
          parameters: input.request.values,
          inputContentHashes: input.inputContentHashes
        });
  }

  private async candidates(request: GenerationRequest): Promise<{
    candidates: Candidate[];
    validationError: AppError | null;
  }> {
    const windows = budgetWindows(this.now());
    const candidates: Candidate[] = [];
    let validationError: AppError | null = null;
    let validatedModel = false;
    for (const runtime of this.options.registry.listEnabled()) {
      const record = this.options.accounts.findById(runtime.record.id);
      if (
        record === null
        || !record.enabled
        || record.healthStatus !== "ready"
      ) {
        continue;
      }
      const usage = this.options.accounts.usage(record.id, windows);
      let resolved: [
        NormalizedModel,
        Awaited<ReturnType<AccountRuntime["account"]["describe"]>>
      ];
      try {
        resolved = await Promise.all([
          runtime.catalog.resolve(request.model, request.sourceType, true),
          runtime.account.describe()
        ]);
      } catch {
        continue;
      }
      const [model, account] = resolved;
      try {
        validateGenerationMedia(request, model);
      } catch (cause) {
        if (cause instanceof AppError) validationError ??= cause;
        continue;
      }
      validatedModel = true;
      const quote = quotedPoints(model, request.values);
      if (quote === null) {
        if (
          record.dailyPointLimit !== 0
          || record.monthlyPointLimit !== 0
        ) {
          continue;
        }
      } else {
        if (
          account.pointsBalance < quote
          || (
            record.dailyPointLimit !== 0
            && usage.dayUsedPoints + quote > record.dailyPointLimit
          )
          || (
            record.monthlyPointLimit !== 0
            && usage.monthUsedPoints + quote > record.monthlyPointLimit
          )
        ) {
          continue;
        }
      }
      candidates.push({
        runtime,
        record,
        model,
        spaceId: account.spaceId,
        quote,
        activeJobs: runtime.capacity.counts().active
      });
    }
    return {
      candidates: candidates.sort(compareCandidates),
      validationError: validatedModel ? null : validationError
    };
  }
}
