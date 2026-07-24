import { createHash } from "node:crypto";
import {
  combineCapacityLeases,
  type AccountScheduler
} from "../accounts/scheduler.js";
import type { AccountRuntime } from "../accounts/runtime.js";
import type { SqliteAdmissionRepository } from "../accounts/sqlite-admission-repository.js";
import { errors } from "../errors.js";
import { abortable } from "../jobs/abort.js";
import { assetsFromResponse } from "../jobs/assets.js";
import type { CapacityManager } from "../jobs/capacity.js";
import {
  LingjingAssetDiscovery,
  type DiscoveryResult
} from "../jobs/discovery.js";
import {
  createRequestFingerprint,
  hashIdempotencyKey
} from "../jobs/fingerprint.js";
import { LingjingTaskPoller } from "../jobs/poller.js";
import { fingerprintUpstreamPayload } from "../jobs/upstream-fingerprint.js";
import type {
  CapacityAdmission,
  CapacityLease,
  JobRecord,
  JobStatus,
  JobTransition
} from "../jobs/types.js";
import { SubmitAmbiguousError } from "../lingjing/error-map.js";
import type { MediaInput, PreparedMedia } from "../media/types.js";
import type { NormalizedModel } from "../models/types.js";
import { buildPayload } from "../models/payload-builder.js";
import { LingjingUploadService } from "../uploads/upload-service.js";
import type { UploadService } from "../uploads/types.js";
import {
  JobRunnerRegistry,
  type SubmitCriticalReservation
} from "./runner-registry.js";
import type {
  GenerationCoordinator,
  GenerationHandle,
  GenerationRepository,
  GenerationRequest,
  RecoveryResumeRunner
} from "./types.js";
import {
  JobUpdateNotifier,
  RepositoryGenerationHandle
} from "./waiter.js";

const GENERATION_ENDPOINT =
  "/joycreator/AIModelApiConsole/executeByApiId";
const ASSET_LIST_ENDPOINT = "/joycreator/space/asset/list";
const ASSET_PAGE_SIZE = 20;
const MAX_ASSET_PAGES = 5;
const DURABLE_CREATE_STATUSES = new Set<JobStatus>([
  "discovering",
  "processing",
  "completed",
  "failed",
  "unknown"
]);
const TERMINAL_STATUSES = new Set<JobStatus>(["completed", "failed"]);

type Sleep = (
  milliseconds: number,
  signal?: AbortSignal
) => Promise<void>;

export interface LingjingGenerationCoordinatorOptions {
  repository: GenerationRepository;
  capacity: CapacityManager;
  scheduler: Pick<AccountScheduler, "start" | "admit" | "restore">;
  admissions: Pick<
    SqliteAdmissionRepository,
    "charge" | "failAndRelease" | "resolveUnknown"
  >;
  prepareMedia(input: MediaInput): Promise<PreparedMedia>;
  createUploadService?: (
    runtime: AccountRuntime,
    model: NormalizedModel
  ) => UploadService;
  registry: JobRunnerRegistry;
  assetDiscoveryTimeoutMs: number;
  unknownCapacityHoldMs: number;
  taskPollIntervalMs: number;
  sleep?: Sleep;
  now?: () => number;
  notifier?: JobUpdateNotifier;
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  const operation = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
  return abortable(operation, signal, "Generation polling stopped");
}

function isTerminal(job: JobRecord): boolean {
  return TERMINAL_STATUSES.has(job.status);
}

async function disposeAll(media: Iterable<PreparedMedia>): Promise<void> {
  await Promise.allSettled(
    [...new Set(media)].map((item) => item.dispose())
  );
}

function preparedInputs(media: Iterable<MediaInput>): PreparedMedia[] {
  return [...media].flatMap((input) => (
    input.source.type === "prepared" ? [input.source.media] : []
  ));
}

async function hashMedia(media: PreparedMedia): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of media.openRead()) {
    hash.update(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array | string)
    );
  }
  return hash.digest("hex");
}

function mediaParameter(model: NormalizedModel): (
  NormalizedModel["parameters"][number] | undefined
) {
  const parameters = model.parameters.filter(
    (parameter) => parameter.kind === "image-list"
  );
  if (parameters.length > 1) {
    throw errors.catalogChanged();
  }
  return parameters[0];
}

export class LingjingGenerationCoordinator
implements GenerationCoordinator {
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly notifier: JobUpdateNotifier;
  private readonly pollerAbort = new AbortController();

  constructor(private readonly options: LingjingGenerationCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.notifier = options.notifier ?? new JobUpdateNotifier();
  }

  stopPollers(): void {
    if (!this.pollerAbort.signal.aborted) {
      this.pollerAbort.abort(new Error("Generation polling stopped"));
    }
  }

  async create(request: GenerationRequest): Promise<GenerationHandle> {
    const ownedPrepared = new Set(preparedInputs(request.media));
    const prepared: PreparedMedia[] = [];
    let ownsPrepared = true;
    let globalAdmission: CapacityAdmission | null = null;

    try {
      globalAdmission = this.options.scheduler.start();
      for (const input of request.media) {
        const media = await this.options.prepareMedia(input);
        prepared.push(media);
        ownedPrepared.add(media);
      }
      if (new Set(prepared).size !== prepared.length) {
        throw errors.invalidRequest(
          "Duplicate prepared media input",
          "media"
        );
      }
      const inputContentHashes: string[] = [];
      for (const media of prepared) {
        inputContentHashes.push(await hashMedia(media));
      }

      const requestFingerprint = createRequestFingerprint({
        model: request.model,
        parameters: request.values,
        inputContentHashes
      });
      const idempotencyKeyHash = request.idempotencyKey === null
        ? null
        : hashIdempotencyKey(request.idempotencyKey);
      const admission = await this.options.scheduler.admit({
        request,
        requestFingerprint,
        idempotencyKeyHash,
        inputContentHashes,
        globalAdmission
      });
      globalAdmission = null;

      if (!admission.created) {
        await disposeAll(ownedPrepared);
        ownsPrepared = false;
        return this.handle(admission.job);
      }

      const submitReservation =
        this.options.registry.reserveSubmitCriticalSection();
      const scheduled = this.options.registry.startOnce(
        admission.job.id,
        () => this.runInitial(
          admission.job,
          request,
          admission.runtime,
          admission.model,
          admission.job.spaceId,
          prepared,
          admission.lease,
          submitReservation
        )
      );
      if (!scheduled.started) {
        submitReservation.cancel();
        const current = this.options.repository.findById(admission.job.id);
        if (current?.status === "queued") {
          this.failAndRelease(
            current.id,
            ["queued"],
            "runner_not_started"
          );
        }
        await disposeAll(ownedPrepared);
        ownsPrepared = false;
        admission.lease.release();
        await scheduled.promise;
      } else {
        ownsPrepared = false;
        void scheduled.promise.catch(() => undefined);
      }

      const durable = await this.waitUntilDurable(admission.job.id);
      return this.handle(durable);
    } catch (cause) {
      globalAdmission?.release();
      if (ownsPrepared) await disposeAll(ownedPrepared);
      throw cause;
    }
  }

  resume(jobId: string): Promise<GenerationHandle> {
    const job = this.requireJob(jobId);
    this.chargeRecoverable(job);
    if (isTerminal(job)) return Promise.resolve(this.handle(job));
    const runtime = this.options.scheduler.restore(job);
    const lease = this.restoreBoundCapacity(job, runtime);
    if (lease === null) return Promise.resolve(this.handle(job));
    const scheduled = this.options.registry.startOnce(
      job.id,
      () => this.resumeRecovered(job, lease)
    );
    void scheduled.promise.catch(() => undefined);
    return Promise.resolve(this.handle(this.requireJob(job.id)));
  }

  readonly recoveryResumeRunner: RecoveryResumeRunner = async (
    job,
    lease
  ) => {
    await this.resumeRecovered(job, lease);
  };

  async resumeRecovered(
    snapshot: JobRecord,
    lease: CapacityLease
  ): Promise<void> {
    let current = this.requireJob(snapshot.id);
    const runtime = this.options.scheduler.restore(current);
    try {
      this.pollerAbort.signal.throwIfAborted();
      this.chargeRecoverable(current);
      if (current.status === "submitting") {
        current = this.transition(current.id, ["submitting"], {
          status: "discovering"
        });
      }
      await this.runPostSubmit(current, runtime, lease);
    } catch {
      if (this.pollerAbort.signal.aborted) {
        lease.release();
        return;
      }
      this.releaseIfTerminalOrRefreshUnknown(current.id, runtime, lease);
    }
  }

  private async runInitial(
    job: JobRecord,
    request: GenerationRequest,
    runtime: AccountRuntime,
    model: NormalizedModel,
    spaceId: number,
    prepared: PreparedMedia[],
    lease: CapacityLease,
    submitReservation: SubmitCriticalReservation
  ): Promise<void> {
    const remaining = new Set(prepared);
    let budgetState: "reserved" | "charged" | "released" = "reserved";
    const charge = (): void => {
      if (budgetState !== "reserved") return;
      this.options.admissions.charge(job.id);
      budgetState = "charged";
    };
    const failAndRelease = (
      jobId: string,
      expectedStatuses: readonly JobStatus[],
      errorCode: string
    ): void => {
      if (budgetState !== "reserved") return;
      this.failAndRelease(jobId, expectedStatuses, errorCode);
      budgetState = "released";
    };
    try {
      const uploader = this.options.createUploadService?.(runtime, model)
        ?? new LingjingUploadService(runtime.transport, {
          uploadStrategy: model.uploadStrategy
        });
      const uploaded = [];
      for (const media of prepared) {
        try {
          uploaded.push(await uploader.upload(media, {
            sceneCode: model.sceneCode,
            modelCode: model.modelCode ?? "",
            spaceId
          }));
        } finally {
          remaining.delete(media);
        }
      }

      const parameter = mediaParameter(model);
      const values = parameter === undefined
        ? request.values
        : {
            ...request.values,
            [parameter.key]: uploaded.map((material) => material.value)
          };
      const payload = buildPayload({ model, spaceId, values });
      const upstreamFingerprint = fingerprintUpstreamPayload(payload);

      let discovery: DiscoveryResult;
      try {
        discovery = await runtime.discoveryLock.runExclusive(async () => {
          const baselineIds = await this.snapshotAssetIds(runtime, spaceId);
          const submitting = this.transition(job.id, ["queued"], {
            status: "submitting",
            submittedAt: this.now(),
            upstreamFingerprint
          });
          await submitReservation.run(async () => {
            try {
              await runtime.transport.submitOnce(
                GENERATION_ENDPOINT,
                payload
              );
            } catch (cause) {
              if (!(cause instanceof SubmitAmbiguousError)) {
                failAndRelease(
                  submitting.id,
                  ["submitting"],
                  "generation_submit_rejected"
                );
                throw cause;
              }
            }
            charge();
          });
          const discovering = this.transition(
            submitting.id,
            ["submitting"],
            { status: "discovering" }
          );
          return this.discovererFor(runtime).discover(
            discovering,
            baselineIds,
            this.pollerAbort.signal
          );
        });
      } catch (cause) {
        const current = this.options.repository.findById(job.id);
        if (current?.status !== "discovering") throw cause;
        this.pollerAbort.signal.throwIfAborted();
        const holdUntil = this.now() + this.options.unknownCapacityHoldMs;
        const unknown = this.persistUnknown(
          current.id,
          ["discovering"],
          "generation_discovery_read_failed",
          holdUntil,
          runtime
        );
        await this.recoverUnknown(unknown, runtime, lease, holdUntil);
        return;
      }

      await this.persistDiscoveryAndPoll(
        job.id,
        discovery,
        runtime,
        lease
      );
    } catch {
      const current = this.options.repository.findById(job.id);
      if (this.pollerAbort.signal.aborted) {
        lease.release();
        return;
      }
      if (current?.status === "queued") {
        failAndRelease(
          current.id,
          ["queued"],
          "generation_before_submit_failed"
        );
      }
      this.releaseIfTerminalOrRefreshUnknown(job.id, runtime, lease);
    } finally {
      submitReservation.cancel();
      await disposeAll(remaining);
    }
  }

  private async runPostSubmit(
    snapshot: JobRecord,
    runtime: AccountRuntime,
    lease: CapacityLease
  ): Promise<void> {
    this.pollerAbort.signal.throwIfAborted();
    let current = this.requireJob(snapshot.id);
    if (isTerminal(current)) {
      lease.release();
      return;
    }

    if (current.upstreamTaskId === null) {
      if (current.status === "unknown") {
        const holdUntil = current.unknownHoldUntil;
        if (holdUntil === null || holdUntil <= this.now()) {
          this.expireBoundUnknown(runtime, this.now());
          return;
        }
        await this.recoverUnknown(current, runtime, lease, holdUntil);
        return;
      }
      if (current.status !== "discovering") return;
      let discovery: DiscoveryResult;
      try {
        discovery = await runtime.discoveryLock.runExclusive(
          () => this.discovererFor(runtime).discover(
            current,
            new Set(),
            this.pollerAbort.signal
          )
        );
      } catch {
        this.pollerAbort.signal.throwIfAborted();
        const holdUntil = this.now() + this.options.unknownCapacityHoldMs;
        const unknown = this.persistUnknown(
          current.id,
          ["discovering"],
          "generation_discovery_read_failed",
          holdUntil,
          runtime
        );
        await this.recoverUnknown(unknown, runtime, lease, holdUntil);
        return;
      }
      await this.persistDiscoveryAndPoll(
        current.id,
        discovery,
        runtime,
        lease
      );
      return;
    }

    if (current.status === "discovering") {
      current = this.transition(current.id, ["discovering"], {
        status: "processing"
      });
      this.refreshProcessingLease(current, runtime);
    }
    if (current.status === "unknown") {
      const holdUntil = current.unknownHoldUntil;
      if (
        holdUntil === null
        || !this.ownsUnknownCapacity(current.id, holdUntil, runtime)
      ) {
        this.expireBoundUnknown(runtime, this.now());
        return;
      }
      current = this.transition(current.id, ["unknown"], {
        status: "processing"
      });
      this.refreshProcessingLease(current, runtime);
    }
    if (current.status === "processing") {
      await this.pollUntilSettled(current, runtime, lease);
    }
  }

  resolveUnknown(
    accountId: string,
    jobId: string,
    action: "charge" | "release"
  ) {
    const current = this.options.repository.findById(jobId);
    if (
      current === null
      || current.accountId !== accountId
      || current.status !== "unknown"
    ) {
      throw new Error("Unknown job resolution conflict");
    }
    const runtime = this.options.scheduler.restore(current);
    const resolved = this.options.admissions.resolveUnknown(
      accountId,
      jobId,
      action
    );
    this.options.capacity.releaseJob(jobId);
    runtime.capacity.releaseJob(jobId);
    this.notifier.notify(jobId);
    return resolved;
  }

  private async persistDiscoveryAndPoll(
    jobId: string,
    result: DiscoveryResult,
    runtime: AccountRuntime,
    lease: CapacityLease,
    existingHoldUntil?: number
  ): Promise<void> {
    this.pollerAbort.signal.throwIfAborted();
    const asset = result.kind === "unique" ? result.asset : undefined;
    if (
      asset === undefined
      || asset.taskId === null
      || asset.creationCode === null
    ) {
      const persisted = this.requireJob(jobId);
      if (
        persisted.status === "unknown"
        && existingHoldUntil !== undefined
      ) {
        return;
      }
      const holdUntil = existingHoldUntil
        ?? this.now() + this.options.unknownCapacityHoldMs;
      const unknown = this.persistUnknown(
        jobId,
        ["discovering", "processing"],
        result.kind === "ambiguous"
          ? "generation_discovery_ambiguous"
          : "generation_discovery_timeout",
        holdUntil,
        runtime
      );
      if (existingHoldUntil === undefined) {
        await this.recoverUnknown(unknown, runtime, lease, holdUntil);
      }
      return;
    }

    if (
      existingHoldUntil !== undefined
      && !this.ownsUnknownCapacity(jobId, existingHoldUntil, runtime)
    ) {
      this.expireBoundUnknown(runtime, this.now());
      return;
    }
    const processing = this.transition(
      jobId,
      ["discovering", "unknown"],
      {
        status: "processing",
        creationCode: asset.creationCode,
        upstreamTaskId: asset.taskId,
        discoveredAt: this.now()
      }
    );
    this.refreshProcessingLease(processing, runtime);
    await this.pollUntilSettled(processing, runtime, lease);
  }

  private async recoverUnknown(
    initial: JobRecord,
    runtime: AccountRuntime,
    lease: CapacityLease,
    holdUntil: number
  ): Promise<void> {
    let current = initial;
    while (this.now() < holdUntil) {
      await this.waitForPollInterval();
      if (this.now() >= holdUntil) break;
      try {
        const discovery = await this.discoverUnknownWithinHold(
          current,
          holdUntil,
          runtime
        );
        if (discovery === null) break;
        await this.persistDiscoveryAndPoll(
          current.id,
          discovery,
          runtime,
          lease,
          holdUntil
        );
        current = this.requireJob(current.id);
        if (current.status !== "unknown") return;
      } catch {
        this.pollerAbort.signal.throwIfAborted();
        current = this.requireJob(current.id);
        if (current.status !== "unknown") return;
      }
    }
    this.expireBoundUnknown(runtime, this.now());
  }

  private async pollUntilSettled(
    initial: JobRecord,
    runtime: AccountRuntime,
    lease: CapacityLease
  ): Promise<void> {
    let current = initial;
    const poller = this.pollerFor(runtime);
    for (;;) {
      try {
        const next = await poller.poll(
          current,
          this.pollerAbort.signal
        );
        if (next.updatedAt !== current.updatedAt || next.status !== current.status) {
          this.notifier.notify(next.id);
        }
        current = next;
        this.refreshProcessingLease(current, runtime);
      } catch {
        this.pollerAbort.signal.throwIfAborted();
        await this.waitForPollInterval();
        current = this.requireJob(current.id);
        if (isTerminal(current)) {
          lease.release();
          return;
        }
        continue;
      }
      if (isTerminal(current)) {
        lease.release();
        return;
      }
      await this.waitForPollInterval();
      current = this.requireJob(current.id);
    }
  }

  private persistUnknown(
    jobId: string,
    expectedStatuses: readonly JobStatus[],
    errorCode: string,
    holdUntil: number,
    runtime: AccountRuntime
  ): JobRecord {
    const unknown = this.transition(jobId, expectedStatuses, {
      status: "unknown",
      unknownHoldUntil: holdUntil,
      errorCode
    });
    this.refreshBoundCapacity(unknown, runtime);
    return unknown;
  }

  private ownsUnknownCapacity(
    jobId: string,
    holdUntil: number,
    runtime: AccountRuntime
  ): boolean {
    return this.now() < holdUntil
      && this.options.capacity.activeJobIds().includes(jobId)
      && runtime.capacity.activeJobIds().includes(jobId);
  }

  private refreshProcessingLease(
    job: JobRecord,
    runtime: AccountRuntime
  ): void {
    if (
      job.status === "processing"
      && this.options.capacity.activeJobIds().includes(job.id)
      && runtime.capacity.activeJobIds().includes(job.id)
    ) {
      this.refreshBoundCapacity(job, runtime);
    }
  }

  private async discoverUnknownWithinHold(
    job: JobRecord,
    holdUntil: number,
    runtime: AccountRuntime
  ): Promise<DiscoveryResult | null> {
    if (!this.ownsUnknownCapacity(job.id, holdUntil, runtime)) return null;
    const remaining = Math.max(0, holdUntil - this.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, Math.min(remaining, 2_147_483_647), null);
      timer.unref();
    });
    const discovery = runtime.discoveryLock.runExclusive(
      () => this.discovererFor(runtime).discover(
        job,
        new Set(),
        this.pollerAbort.signal
      )
    );
    let result: DiscoveryResult | null;
    try {
      result = await Promise.race([discovery, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (result === null) {
      this.expireBoundUnknown(runtime, this.now());
      await discovery.catch(() => undefined);
      return null;
    }
    if (
      !this.ownsUnknownCapacity(job.id, holdUntil, runtime)
    ) {
      return null;
    }
    return result;
  }

  private waitForPollInterval(): Promise<void> {
    return this.sleep(
      this.options.taskPollIntervalMs,
      this.pollerAbort.signal
    );
  }

  private async snapshotAssetIds(
    runtime: AccountRuntime,
    spaceId: number
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    for (let currentPage = 1; currentPage <= MAX_ASSET_PAGES; currentPage += 1) {
      const response = await runtime.transport.read<unknown>(
        ASSET_LIST_ENDPOINT,
        {
          query: {
            assetType: 1,
            spaceId,
            currentPage,
            pageSize: ASSET_PAGE_SIZE
          }
        }
      );
      const page = assetsFromResponse(response);
      for (const asset of page) ids.add(asset.id);
      if (page.length < ASSET_PAGE_SIZE) break;
    }
    return ids;
  }

  private discovererFor(runtime: AccountRuntime): LingjingAssetDiscovery {
    return new LingjingAssetDiscovery({
      transport: runtime.transport,
      timeoutMs: this.options.assetDiscoveryTimeoutMs,
      pollIntervalMs: this.options.taskPollIntervalMs,
      sleep: (milliseconds, signal) => this.sleep(milliseconds, signal),
      now: this.now
    });
  }

  private pollerFor(runtime: AccountRuntime): LingjingTaskPoller {
    return new LingjingTaskPoller({
      repository: this.options.repository,
      transport: runtime.transport,
      now: this.now
    });
  }

  private chargeRecoverable(job: JobRecord): void {
    if (
      job.status === "submitting"
      || job.status === "discovering"
      || job.status === "processing"
      || job.status === "unknown"
      || job.status === "completed"
    ) {
      this.options.admissions.charge(job.id);
    }
  }

  private restoreBoundCapacity(
    job: JobRecord,
    runtime: AccountRuntime
  ): CapacityLease | null {
    const globalLease = this.options.capacity.restore(
      job.id,
      job.status,
      job.unknownHoldUntil,
      this.now()
    );
    if (globalLease === null) return null;
    const accountLease = runtime.capacity.restore(
      job.id,
      job.status,
      job.unknownHoldUntil,
      this.now()
    );
    if (accountLease === null) {
      globalLease.release();
      return null;
    }
    return combineCapacityLeases(globalLease, accountLease);
  }

  private refreshBoundCapacity(
    job: JobRecord,
    runtime: AccountRuntime
  ): void {
    this.options.capacity.restore(
      job.id,
      job.status,
      job.unknownHoldUntil,
      this.now()
    );
    runtime.capacity.restore(
      job.id,
      job.status,
      job.unknownHoldUntil,
      this.now()
    );
  }

  private expireBoundUnknown(runtime: AccountRuntime, now: number): void {
    this.options.capacity.expireUnknown(now);
    runtime.capacity.expireUnknown(now);
  }

  private transition(
    id: string,
    expectedStatuses: readonly JobStatus[],
    transition: JobTransition
  ): JobRecord {
    const job = this.options.repository.transition(
      id,
      expectedStatuses,
      transition
    );
    this.notifier.notify(id);
    return job;
  }

  private releaseIfTerminalOrRefreshUnknown(
    jobId: string,
    runtime: AccountRuntime,
    lease: CapacityLease
  ): void {
    const current = this.options.repository.findById(jobId);
    if (current === null || isTerminal(current)) {
      lease.release();
      return;
    }
    if (current.status === "unknown") {
      this.refreshBoundCapacity(current, runtime);
    }
  }

  private failAndRelease(
    id: string,
    expectedStatuses: readonly JobStatus[],
    errorCode: string
  ): JobRecord {
    const failed = this.options.admissions.failAndRelease(
      id,
      expectedStatuses,
      errorCode
    );
    this.notifier.notify(failed.id);
    return failed;
  }

  private async waitUntilDurable(jobId: string): Promise<JobRecord> {
    for (;;) {
      const current = this.requireJob(jobId);
      if (DURABLE_CREATE_STATUSES.has(current.status)) return current;
      await this.notifier.wait(jobId, 60_000);
    }
  }

  private requireJob(jobId: string): JobRecord {
    const job = this.options.repository.findById(jobId);
    if (job === null) throw new Error(`Generation job ${jobId} not found`);
    return job;
  }

  private handle(job: JobRecord): GenerationHandle {
    return new RepositoryGenerationHandle(
      job,
      this.options.repository,
      this.notifier
    );
  }
}
