import {
  assetsFromResponse,
  type LingjingAsset
} from "./assets.js";
import { abortable } from "./abort.js";
import { fingerprintAssetReqParam } from "./upstream-fingerprint.js";
import type { JobRecord } from "./types.js";
import type { LingjingTransport } from "../lingjing/types.js";

const MAX_ASSET_PAGES = 5;
const ASSET_PAGE_SIZE = 20;
const SUBMISSION_CLOCK_SKEW_MS = 10_000;
const ASSET_SCENE_ALIASES: Record<
JobRecord["sourceType"],
readonly string[]
> = {
  "image-generation": ["ig"],
  "text-to-video": ["t2v"],
  "image-to-video": ["i2v"]
};

export interface DiscoveryResult {
  kind: "unique" | "ambiguous" | "not-found";
  asset?: LingjingAsset;
  candidates: number;
}

function conflicting(
  left: string | null,
  right: string | null
): boolean {
  return left !== null && right !== null && left !== right;
}

function matchesAssetScene(
  job: JobRecord,
  scene: string | null
): boolean {
  if (scene === job.expectedAssetScene) return true;
  if (scene === null) return false;

  const aliases = ASSET_SCENE_ALIASES[job.sourceType];
  if (aliases === undefined) return false;
  return (
    job.expectedAssetScene === job.sourceType
    && aliases.includes(scene)
  ) || (
    scene === job.sourceType
    && aliases.includes(job.expectedAssetScene)
  );
}

function mergeDuplicateAsset(
  left: LingjingAsset,
  right: LingjingAsset
): LingjingAsset | null {
  if (
    conflicting(left.scene, right.scene)
    || conflicting(left.modelCode, right.modelCode)
    || conflicting(left.taskId, right.taskId)
    || conflicting(left.creationCode, right.creationCode)
  ) {
    return null;
  }
  if (left.reqParam !== null && right.reqParam !== null) {
    try {
      if (
        fingerprintAssetReqParam(left.reqParam)
        !== fingerprintAssetReqParam(right.reqParam)
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return {
    ...left,
    scene: right.scene ?? left.scene,
    modelCode: right.modelCode ?? left.modelCode,
    url: right.url ?? left.url,
    waterUrl: right.waterUrl ?? left.waterUrl,
    watermarkUrl: right.watermarkUrl ?? left.watermarkUrl,
    imageUrl: right.imageUrl ?? left.imageUrl,
    videoUrl: right.videoUrl ?? left.videoUrl,
    frameUrl: right.frameUrl ?? left.frameUrl,
    createTime: Math.min(left.createTime, right.createTime),
    creationCode: right.creationCode ?? left.creationCode,
    status: right.status ?? left.status,
    taskId: right.taskId ?? left.taskId,
    taskResults: right.taskResults ?? left.taskResults,
    errMsg: right.errMsg ?? left.errMsg,
    reqParam: right.reqParam ?? left.reqParam,
    width: right.width ?? left.width,
    height: right.height ?? left.height,
    duration: right.duration ?? left.duration,
    fps: right.fps ?? left.fps,
    taskType: right.taskType ?? left.taskType,
    name: right.name ?? left.name
  };
}

export function matchAsset(
  job: JobRecord,
  assets: readonly LingjingAsset[],
  baselineIds: ReadonlySet<string> = new Set()
): DiscoveryResult {
  if (job.submittedAt === null) {
    return { kind: "not-found", candidates: 0 };
  }
  const submittedAt = job.submittedAt;
  const earliest = submittedAt - SUBMISSION_CLOCK_SKEW_MS;
  const candidates = assets.filter((asset) => {
    if (baselineIds.has(asset.id) || asset.createTime < earliest) return false;
    if (!matchesAssetScene(job, asset.scene)) return false;
    if (asset.createTime < submittedAt) {
      if (
        asset.modelCode === null
        || (
          asset.modelCode !== job.modelCode
          && asset.modelCode !== job.apiId
        )
        || job.upstreamFingerprint === null
        || asset.reqParam === null
      ) {
        return false;
      }
      try {
        if (
          fingerprintAssetReqParam(asset.reqParam)
          !== job.upstreamFingerprint
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
    if (
      job.modelCode !== null
      && asset.modelCode !== null
      && asset.modelCode !== job.modelCode
      && asset.modelCode !== job.apiId
    ) {
      return false;
    }
    if (job.upstreamFingerprint !== null && asset.reqParam !== null) {
      try {
        if (
          fingerprintAssetReqParam(asset.reqParam)
          !== job.upstreamFingerprint
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }).sort((left, right) => (
    left.createTime - right.createTime || left.id.localeCompare(right.id)
  ));

  if (candidates.length === 0) {
    return { kind: "not-found", candidates: 0 };
  }
  if (candidates.length > 1) {
    return { kind: "ambiguous", candidates: candidates.length };
  }
  const asset = candidates[0];
  if (asset === undefined) {
    return { kind: "not-found", candidates: 0 };
  }
  return {
    kind: "unique",
    asset,
    candidates: 1
  };
}

export async function listRecentAssets(
  transport: LingjingTransport,
  job: JobRecord,
  signal?: AbortSignal
): Promise<LingjingAsset[]> {
  if (job.submittedAt === null) return [];
  const earliest = job.submittedAt - SUBMISSION_CLOCK_SKEW_MS;
  const collected = new Map<string, LingjingAsset>();
  const conflictingIds = new Set<string>();

  for (let currentPage = 1; currentPage <= MAX_ASSET_PAGES; currentPage += 1) {
    signal?.throwIfAborted();
    const response = await abortable(
      transport.read<unknown>(
        "/joycreator/space/asset/list",
        {
          query: {
            assetType: 1,
            spaceId: job.spaceId,
            currentPage,
            pageSize: ASSET_PAGE_SIZE
          }
        }
      ),
      signal,
      "Asset discovery aborted"
    );
    signal?.throwIfAborted();
    const page = assetsFromResponse(response);
    let reachedOldRecord = false;
    for (const asset of page) {
      if (asset.createTime < earliest) {
        reachedOldRecord = true;
        collected.delete(asset.id);
        conflictingIds.add(asset.id);
      } else if (!conflictingIds.has(asset.id)) {
        const existing = collected.get(asset.id);
        const merged = existing === undefined
          ? asset
          : mergeDuplicateAsset(existing, asset);
        if (merged === null) {
          collected.delete(asset.id);
          conflictingIds.add(asset.id);
        } else {
          collected.set(asset.id, merged);
        }
      }
    }
    if (reachedOldRecord) break;
  }
  return [...collected.values()];
}

export async function discoverAsset(
  transport: LingjingTransport,
  job: JobRecord,
  baselineIds: ReadonlySet<string> = new Set(),
  signal?: AbortSignal
): Promise<DiscoveryResult> {
  return matchAsset(
    job,
    await listRecentAssets(transport, job, signal),
    baselineIds
  );
}

export interface AssetDiscoveryOptions {
  transport: LingjingTransport;
  timeoutMs: number;
  pollIntervalMs: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error
        ? signal.reason
        : new Error("Asset discovery aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const reason: unknown = signal?.reason as unknown;
      reject(reason instanceof Error
        ? reason
        : new Error("Asset discovery aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class LingjingAssetDiscovery {
  private readonly sleep: NonNullable<AssetDiscoveryOptions["sleep"]>;
  private readonly now: NonNullable<AssetDiscoveryOptions["now"]>;

  constructor(private readonly options: AssetDiscoveryOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  async discover(
    job: JobRecord,
    baselineIds: ReadonlySet<string> = new Set(),
    signal?: AbortSignal
  ): Promise<DiscoveryResult> {
    const deadline = this.now() + this.options.timeoutMs;
    let lastResult: DiscoveryResult = {
      kind: "not-found",
      candidates: 0
    };
    do {
      signal?.throwIfAborted();
      lastResult = await discoverAsset(
        this.options.transport,
        job,
        baselineIds,
        signal
      );
      signal?.throwIfAborted();
      if (lastResult.kind !== "not-found") return lastResult;
      if (this.now() >= deadline) return lastResult;
      await this.sleep(this.options.pollIntervalMs, signal);
    } while (this.now() <= deadline);
    return lastResult;
  }
}
