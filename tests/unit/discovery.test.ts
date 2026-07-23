import { describe, expect, it, vi } from "vitest";
import { listRecentAssets, matchAsset } from "../../src/jobs/discovery.js";
import { fingerprintUpstreamPayload } from "../../src/jobs/upstream-fingerprint.js";
import type { LingjingAsset } from "../../src/jobs/assets.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
import type { JobRecord } from "../../src/jobs/types.js";

const submittedAt = 10_000;
const submitPayload = {
  apiId: "707",
  refId: "fixture-ref",
  params: [{ idx: "1", name: "Prompt", values: "mountain lake" }]
};
const upstreamFingerprint = fingerprintUpstreamPayload(submitPayload);

const jobFixture: JobRecord = {
  id: "job-fixture",
  kind: "image",
  sourceType: "image-generation",
  model: "fixture-model",
  apiId: "707",
  modelCode: "model-v1",
  expectedAssetScene: "image-generation",
  requestFingerprint: "a".repeat(64),
  idempotencyKeyHash: null,
  spaceId: 0,
  status: "discovering",
  creationCode: null,
  upstreamTaskId: null,
  upstreamFingerprint,
  submittedAt,
  discoveredAt: null,
  completedAt: null,
  failedAt: null,
  unknownHoldUntil: null,
  errorCode: null,
  result: null,
  createdAt: 9_000,
  updatedAt: 10_000
};

function asset(overrides: Partial<LingjingAsset> = {}): LingjingAsset {
  return {
    id: "asset-exact",
    scene: "image-generation",
    modelCode: "model-v1",
    url: "https://media.example/result.png",
    waterUrl: null,
    watermarkUrl: null,
    imageUrl: null,
    videoUrl: null,
    frameUrl: null,
    createTime: 10_100,
    creationCode: "creation-fixture",
    status: 1,
    taskId: "fixture-task",
    taskResults: [],
    errMsg: null,
    reqParam: JSON.stringify(submitPayload),
    width: 1024,
    height: 1024,
    duration: null,
    fps: null,
    taskType: null,
    name: null,
    ...overrides
  };
}

describe("matchAsset", () => {
  it("matches by time, scene, modelCode and request fingerprint", () => {
    const exactAsset = asset();
    const result = matchAsset(jobFixture, [
      asset({ id: "older", createTime: 7_999 }),
      exactAsset,
      asset({ id: "wrong-model", modelCode: "model-v2" })
    ]);

    expect(result).toEqual({
      kind: "unique",
      asset: exactAsset,
      candidates: 1
    });
  });

  it("returns ambiguous instead of guessing between equal candidates", () => {
    const result = matchAsset(jobFixture, [
      asset(),
      asset({ id: "asset-second", createTime: 10_200 })
    ]);

    expect(result).toEqual({ kind: "ambiguous", candidates: 2 });
  });

  it("does not bind assets created before submission or present in the baseline", () => {
    expect(matchAsset(jobFixture, [asset({ createTime: 7_999 })]).kind)
      .toBe("not-found");
    expect(matchAsset(jobFixture, [asset()], new Set(["asset-exact"])).kind)
      .toBe("not-found");
  });

  it("accepts the current asset modelCode when it equals the API id", () => {
    const currentAsset = asset({ modelCode: "707" });

    expect(matchAsset(jobFixture, [currentAsset])).toEqual({
      kind: "unique",
      asset: currentAsset,
      candidates: 1
    });
  });

  it("matches only the known full and short aliases for a current asset scene", () => {
    const shortSceneJob = {
      ...jobFixture,
      expectedAssetScene: "ig"
    };
    expect(matchAsset(shortSceneJob, [
      asset({ scene: "image-generation" })
    ]).kind).toBe("unique");
    expect(matchAsset(shortSceneJob, [
      asset({ scene: "ig" })
    ]).kind).toBe("unique");
    expect(matchAsset(shortSceneJob, [
      asset({ scene: "unrelated-scene" })
    ])).toEqual({ kind: "not-found", candidates: 0 });
  });

  it("conservatively rejects scene, fingerprint and model mismatches", () => {
    expect(matchAsset(jobFixture, [
      asset({ id: "scene", scene: "video-generation" }),
      asset({
        id: "fingerprint",
        reqParam: { ...submitPayload, params: [{ idx: "1", values: "other" }] }
      }),
      asset({ id: "model", modelCode: "model-v2" })
    ])).toEqual({ kind: "not-found", candidates: 0 });
  });
});

describe("listRecentAssets", () => {
  it("uses the personal space query and stops at the first page containing old records", async () => {
    const read = vi.fn((_path: string, init?: { query?: Record<string, unknown> }) => Promise.resolve({
      records: Number(init?.query?.currentPage) === 1
        ? [asset({ id: "new" })]
        : [asset({ id: "still-new" }), asset({ id: "old", createTime: 7_999 })]
    }));
    const transport = { read } as unknown as LingjingTransport;

    const assets = await listRecentAssets(transport, jobFixture);

    expect(assets.map((item) => item.id)).toEqual(["new", "still-new"]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(1, "/joycreator/space/asset/list", {
      query: {
        assetType: 1,
        spaceId: 0,
        currentPage: 1,
        pageSize: 20
      }
    });
  });

  it("never scans more than five pages", async () => {
    const read = vi.fn((_path: string, init?: { query?: Record<string, unknown> }) => Promise.resolve({
      data: {
        list: [asset({
          id: `asset-${String(init?.query?.currentPage)}`,
          createTime: 10_001
        })]
      }
    }));
    const transport = { read } as unknown as LingjingTransport;

    await listRecentAssets(transport, jobFixture);

    expect(read).toHaveBeenCalledTimes(5);
  });

  it("deduplicates the same asset when shifting pages overlap", async () => {
    const read = vi.fn((_path: string, init?: { query?: Record<string, unknown> }) => Promise.resolve({
      records: Number(init?.query?.currentPage) === 1
        ? [asset({ id: "overlap" })]
        : [
            asset({ id: "overlap" }),
            asset({ id: "old", createTime: 7_999 })
          ]
    }));

    const assets = await listRecentAssets(
      { read } as unknown as LingjingTransport,
      jobFixture
    );

    expect(assets.map((item) => item.id)).toEqual(["overlap"]);
  });

  it("uses an enriched duplicate discriminator instead of weaker page data", async () => {
    const read = vi.fn((_path: string, init?: { query?: Record<string, unknown> }) => Promise.resolve({
      records: Number(init?.query?.currentPage) === 1
        ? [asset({
            id: "enriched",
            modelCode: null,
            reqParam: null
          })]
        : [
            asset({
              id: "enriched",
              modelCode: "model-v1",
              reqParam: {
                ...submitPayload,
                params: [{ idx: "1", values: "different request" }]
              }
            }),
            asset({ id: "old", createTime: 7_999 })
          ]
    }));

    const assets = await listRecentAssets(
      { read } as unknown as LingjingTransport,
      jobFixture
    );

    expect(matchAsset(jobFixture, assets)).toEqual({
      kind: "not-found",
      candidates: 0
    });
  });

  it("rejects an id when any overlapping page reports it as old", async () => {
    const read = vi.fn((_path: string, init?: { query?: Record<string, unknown> }) => Promise.resolve({
      records: Number(init?.query?.currentPage) === 1
        ? [asset({ id: "clock-conflict", createTime: 10_100 })]
        : [
            asset({ id: "clock-conflict", createTime: 7_999 }),
            asset({ id: "old", createTime: 7_999 })
          ]
    }));

    const assets = await listRecentAssets(
      { read } as unknown as LingjingTransport,
      jobFixture
    );

    expect(assets).toEqual([]);
  });

  it("keeps an old id blacklisted when a recent representation follows", async () => {
    const read = vi.fn(() => Promise.resolve({
      records: [
        asset({ id: "old-then-recent", createTime: 7_999 }),
        asset({ id: "old-then-recent", createTime: 10_100 })
      ]
    }));

    const assets = await listRecentAssets(
      { read } as unknown as LingjingTransport,
      jobFixture
    );

    expect(assets).toEqual([]);
  });
});
