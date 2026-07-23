import { createHash, randomUUID } from "node:crypto";
import { errors } from "../errors.js";
import { assetsFromResponse } from "../jobs/assets.js";
import type { CapacityManager } from "../jobs/capacity.js";
import { DiscoveryLock } from "../jobs/discovery-lock.js";
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
  CapacityLease,
  JobRecord,
  JobStatus,
  JobTransition
} from "../jobs/types.js";
import type { AccountSnapshot } from "../lingjing/account.js";
import { SubmitAmbiguousError } from "../lingjing/error-map.js";
import type { LingjingTransport } from "../lingjing/types.js";
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

type Sleep = (milliseconds: number) => Promise<void>;

interface CatalogResolver {
  resolve(
    value: string,
    sourceType: GenerationRequest["sourceType"],
    charged?: boolean
  ): Promise<NormalizedModel>;
}

export interface LingjingGenerationCoordinatorOptions {
  repository: GenerationRepository;
  capacity: CapacityManager;
  account: { describe(): Promise<AccountSnapshot> };
  catalog: CatalogResolver;
  transport: LingjingTransport;
  prepareMedia(input: MediaInput): Promise<PreparedMedia>;
  createUploadService?: (model: NormalizedModel) => UploadService;
  discoveryLock: DiscoveryLock;
  registry: JobRunnerRegistry;
  assetDiscoveryTimeoutMs: number;
  unknownCapacityHoldMs: number;
  taskPollIntervalMs: number;
  sleep?: Sleep;
  now?: () => number;
  notifier?: JobUpdateNotifier;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function isTerminal(job: JobRecord): boolean {
  return TERMINAL_STATUSES.has(job.status);
}

async function disposeAll(media: Iterable<PreparedMedia>): Promise<void> {
  await Promise.allSettled(
    [...new Set(media)].map((item) => item.dispose())
  );
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

function validateMedia(
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
  if (request.media.length > 0 && model.modelCode === null) {
    throw errors.catalogChanged();
  }
}

function jobErrorTransition(
  status: "failed",
  now: number,
  errorCode: string
): JobTransition {
  return {
    status,
    failedAt: now,
    errorCode
  };
}

export class LingjingGenerationCoordinator
implements GenerationCoordinator {
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly notifier: JobUpdateNotifier;
  private readonly discoverer: LingjingAssetDiscovery;
  private readonly poller: LingjingTaskPoller;

  constructor(private readonly options: LingjingGenerationCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.notifier = options.notifier ?? new JobUpdateNotifier();
    this.discoverer = new LingjingAssetDiscovery({
      transport: options.transport,
      timeoutMs: options.assetDiscoveryTimeoutMs,
      pollIntervalMs: options.taskPollIntervalMs,
      sleep: (milliseconds) => this.sleep(milliseconds),
      now: this.now
    });
    this.poller = new LingjingTaskPoller({
      repository: options.repository,
      transport: options.transport,
      now: this.now
    });
  }

  async create(request: GenerationRequest): Promise<GenerationHandle> {
    const admission = this.options.capacity.admit(randomUUID());
    const prepared: PreparedMedia[] = [];
    let ownsPrepared = true;
    let createdJob: JobRecord | null = null;
    let lease: CapacityLease | null = null;

    try {
      const account = await this.options.account.describe();
      const model = await this.options.catalog.resolve(
        request.model,
        request.sourceType,
        true
      );
      validateMedia(request, model);

      for (const input of request.media) {
        prepared.push(await this.options.prepareMedia(input));
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
        model: model.apiId,
        parameters: request.values,
        inputContentHashes
      });
      const idempotencyKeyHash = request.idempotencyKey === null
        ? null
        : hashIdempotencyKey(request.idempotencyKey);
      const result = this.options.repository.createOrGet({
        kind: request.kind,
        sourceType: request.sourceType,
        model: request.model,
        apiId: model.apiId,
        modelCode: model.modelCode,
        expectedAssetScene: model.expectedAssetScene,
        requestFingerprint,
        idempotencyKeyHash,
        spaceId: account.spaceId
      });
      createdJob = result.job;

      if (!result.created) {
        await disposeAll(prepared);
        ownsPrepared = false;
        admission.release();
        return this.handle(result.job);
      }

      try {
        lease = await admission.acquire(result.job.id);
      } catch (cause) {
        this.transition(result.job.id, ["queued"], jobErrorTransition(
          "failed",
          this.now(),
          "capacity_acquire_failed"
        ));
        admission.release();
        throw cause;
      }

      const submitReservation =
        this.options.registry.reserveSubmitCriticalSection();
      const scheduled = this.options.registry.startOnce(
        result.job.id,
        () => this.runInitial(
          result.job,
          request,
          model,
          account.spaceId,
          prepared,
          lease as CapacityLease,
          submitReservation
        )
      );
      if (!scheduled.started) {
        submitReservation.cancel();
        const current = this.options.repository.findById(result.job.id);
        if (current?.status === "queued") {
          this.transition(current.id, ["queued"], jobErrorTransition(
            "failed",
            this.now(),
            "runner_not_started"
          ));
        }
        await disposeAll(prepared);
        ownsPrepared = false;
        lease.release();
        await scheduled.promise;
      } else {
        ownsPrepared = false;
        void scheduled.promise.catch(() => undefined);
      }

      const durable = await this.waitUntilDurable(result.job.id);
      return this.handle(durable);
    } catch (cause) {
      if (ownsPrepared) await disposeAll(prepared);
      if (createdJob === null) admission.release();
      throw cause;
    }
  }

  resume(jobId: string): Promise<GenerationHandle> {
    const job = this.requireJob(jobId);
    if (isTerminal(job)) return Promise.resolve(this.handle(job));
    const lease = this.options.capacity.restore(
      job.id,
      job.status,
      job.unknownHoldUntil,
      this.now()
    );
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
    try {
      if (current.status === "submitting") {
        current = this.transition(current.id, ["submitting"], {
          status: "discovering"
        });
      }
      await this.runPostSubmit(current, lease);
    } catch {
      this.releaseIfTerminalOrRefreshUnknown(current.id, lease);
    }
  }

  private async runInitial(
    job: JobRecord,
    request: GenerationRequest,
    model: NormalizedModel,
    spaceId: number,
    prepared: PreparedMedia[],
    lease: CapacityLease,
    submitReservation: SubmitCriticalReservation
  ): Promise<void> {
    const remaining = new Set(prepared);
    try {
      const uploader = this.options.createUploadService?.(model)
        ?? new LingjingUploadService(this.options.transport, {
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
        discovery = await submitReservation.run(
          () => this.options.discoveryLock.runExclusive(async () => {
            const baselineIds = await this.snapshotAssetIds(spaceId);
            const submitting = this.transition(job.id, ["queued"], {
              status: "submitting",
              submittedAt: this.now(),
              upstreamFingerprint
            });
            try {
              await this.options.transport.submitOnce(
                GENERATION_ENDPOINT,
                payload
              );
            } catch (cause) {
              if (!(cause instanceof SubmitAmbiguousError)) {
                this.transition(
                  submitting.id,
                  ["submitting"],
                  jobErrorTransition(
                    "failed",
                    this.now(),
                    "generation_submit_rejected"
                  )
                );
                throw cause;
              }
            }
            const discovering = this.transition(
              submitting.id,
              ["submitting"],
              { status: "discovering" }
            );
            return this.discoverer.discover(discovering, baselineIds);
          })
        );
      } catch (cause) {
        const current = this.options.repository.findById(job.id);
        if (current?.status !== "discovering") throw cause;
        const holdUntil = this.now() + this.options.unknownCapacityHoldMs;
        const unknown = this.persistUnknown(
          current.id,
          ["discovering"],
          "generation_discovery_read_failed",
          holdUntil
        );
        await this.recoverUnknown(unknown, lease, holdUntil);
        return;
      }

      await this.persistDiscoveryAndPoll(job.id, discovery, lease);
    } catch {
      const current = this.options.repository.findById(job.id);
      if (current?.status === "queued") {
        this.transition(current.id, ["queued"], jobErrorTransition(
          "failed",
          this.now(),
          "generation_before_submit_failed"
        ));
      }
      this.releaseIfTerminalOrRefreshUnknown(job.id, lease);
    } finally {
      submitReservation.cancel();
      await disposeAll(remaining);
    }
  }

  private async runPostSubmit(
    snapshot: JobRecord,
    lease: CapacityLease
  ): Promise<void> {
    let current = this.requireJob(snapshot.id);
    if (isTerminal(current)) {
      lease.release();
      return;
    }

    if (current.upstreamTaskId === null) {
      if (current.status === "unknown") {
        const holdUntil = current.unknownHoldUntil;
        if (holdUntil === null || holdUntil <= this.now()) {
          this.options.capacity.expireUnknown(this.now());
          return;
        }
        await this.recoverUnknown(current, lease, holdUntil);
        return;
      }
      if (current.status !== "discovering") return;
      let discovery: DiscoveryResult;
      try {
        discovery = await this.options.discoveryLock.runExclusive(
          () => this.discoverer.discover(current)
        );
      } catch {
        const holdUntil = this.now() + this.options.unknownCapacityHoldMs;
        const unknown = this.persistUnknown(
          current.id,
          ["discovering"],
          "generation_discovery_read_failed",
          holdUntil
        );
        await this.recoverUnknown(unknown, lease, holdUntil);
        return;
      }
      await this.persistDiscoveryAndPoll(current.id, discovery, lease);
      return;
    }

    if (current.status === "discovering") {
      current = this.transition(current.id, ["discovering"], {
        status: "processing"
      });
      this.refreshProcessingLease(current);
    }
    if (current.status === "unknown") {
      const holdUntil = current.unknownHoldUntil;
      if (
        holdUntil === null
        || !this.ownsUnknownCapacity(current.id, holdUntil)
      ) {
        this.options.capacity.expireUnknown(this.now());
        return;
      }
      current = this.transition(current.id, ["unknown"], {
        status: "processing"
      });
      this.refreshProcessingLease(current);
    }
    if (current.status === "processing") {
      await this.pollUntilSettled(current, lease);
    }
  }

  private async persistDiscoveryAndPoll(
    jobId: string,
    result: DiscoveryResult,
    lease: CapacityLease,
    existingHoldUntil?: number
  ): Promise<void> {
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
        holdUntil
      );
      if (existingHoldUntil === undefined) {
        await this.recoverUnknown(unknown, lease, holdUntil);
      }
      return;
    }

    if (
      existingHoldUntil !== undefined
      && !this.ownsUnknownCapacity(jobId, existingHoldUntil)
    ) {
      this.options.capacity.expireUnknown(this.now());
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
    this.refreshProcessingLease(processing);
    await this.pollUntilSettled(processing, lease);
  }

  private async recoverUnknown(
    initial: JobRecord,
    lease: CapacityLease,
    holdUntil: number
  ): Promise<void> {
    let current = initial;
    while (this.now() < holdUntil) {
      await this.sleep(this.options.taskPollIntervalMs);
      if (this.now() >= holdUntil) break;
      try {
        const discovery = await this.discoverUnknownWithinHold(
          current,
          holdUntil
        );
        if (discovery === null) break;
        await this.persistDiscoveryAndPoll(
          current.id,
          discovery,
          lease,
          holdUntil
        );
        current = this.requireJob(current.id);
        if (current.status !== "unknown") return;
      } catch {
        current = this.requireJob(current.id);
        if (current.status !== "unknown") return;
      }
    }
    this.options.capacity.expireUnknown(this.now());
  }

  private async pollUntilSettled(
    initial: JobRecord,
    lease: CapacityLease
  ): Promise<void> {
    let current = initial;
    for (;;) {
      try {
        const next = await this.poller.poll(current);
        if (next.updatedAt !== current.updatedAt || next.status !== current.status) {
          this.notifier.notify(next.id);
        }
        current = next;
        this.refreshProcessingLease(current);
      } catch {
        await this.sleep(this.options.taskPollIntervalMs);
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
      await this.sleep(this.options.taskPollIntervalMs);
      current = this.requireJob(current.id);
    }
  }

  private persistUnknown(
    jobId: string,
    expectedStatuses: readonly JobStatus[],
    errorCode: string,
    holdUntil: number
  ): JobRecord {
    const unknown = this.transition(jobId, expectedStatuses, {
      status: "unknown",
      unknownHoldUntil: holdUntil,
      errorCode
    });
    this.options.capacity.restore(
      unknown.id,
      unknown.status,
      unknown.unknownHoldUntil,
      this.now()
    );
    return unknown;
  }

  private ownsUnknownCapacity(jobId: string, holdUntil: number): boolean {
    return this.now() < holdUntil
      && this.options.capacity.activeJobIds().includes(jobId);
  }

  private refreshProcessingLease(job: JobRecord): void {
    if (
      job.status === "processing"
      && this.options.capacity.activeJobIds().includes(job.id)
    ) {
      this.options.capacity.restore(
        job.id,
        job.status,
        job.unknownHoldUntil,
        this.now()
      );
    }
  }

  private async discoverUnknownWithinHold(
    job: JobRecord,
    holdUntil: number
  ): Promise<DiscoveryResult | null> {
    if (!this.ownsUnknownCapacity(job.id, holdUntil)) return null;
    const remaining = Math.max(0, holdUntil - this.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, Math.min(remaining, 2_147_483_647), null);
      timer.unref();
    });
    const discovery = this.options.discoveryLock.runExclusive(
      () => this.discoverer.discover(job)
    );
    const result = await Promise.race([discovery, expired]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === null) {
      this.options.capacity.expireUnknown(this.now());
      await discovery.catch(() => undefined);
      return null;
    }
    if (
      !this.ownsUnknownCapacity(job.id, holdUntil)
    ) {
      return null;
    }
    return result;
  }

  private async snapshotAssetIds(spaceId: number): Promise<Set<string>> {
    const ids = new Set<string>();
    for (let currentPage = 1; currentPage <= MAX_ASSET_PAGES; currentPage += 1) {
      const response = await this.options.transport.read<unknown>(
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
    lease: CapacityLease
  ): void {
    const current = this.options.repository.findById(jobId);
    if (current === null || isTerminal(current)) {
      lease.release();
      return;
    }
    if (current.status === "unknown") {
      this.options.capacity.restore(
        current.id,
        current.status,
        current.unknownHoldUntil,
        this.now()
      );
    }
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
