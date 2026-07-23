import { describe, expect, it } from "vitest";
import {
  fingerprintAssetReqParam,
  fingerprintUpstreamPayload
} from "../../src/jobs/upstream-fingerprint.js";

const outboundPayload = {
  apiId: "707",
  refId: "fixture-ref",
  spaceId: 0,
  priceQueryResult: { taskNum: 1 },
  timestamp: 1_700_000_000_000,
  params: [
    {
      idx: "10",
      name: "Prompt image",
      values: ["material-1"],
      filePath: ["material-1"]
    },
    {
      idx: "2",
      name: "Prompt",
      values: {
        prompt: "a lighthouse",
        nested: { z: true, a: 1 }
      }
    }
  ]
};

const observedAssetReqParam = {
  refId: "fixture-ref",
  uiState: { selectedTab: "advanced" },
  params: [
    {
      values: { nested: { a: 1, z: true }, prompt: "a lighthouse" },
      displayName: "Prompt shown in history",
      idx: 2
    },
    {
      filePath: ["material-1"],
      values: ["material-1"],
      idx: "10",
      name: "历史展示名"
    }
  ],
  apiId: 707,
  price: 0.04,
  createTime: 1_700_000_001_000
};

describe("upstream payload fingerprints", () => {
  it("matches canonical payload and asset reqParam shapes", () => {
    expect(fingerprintAssetReqParam(JSON.stringify(observedAssetReqParam)))
      .toBe(fingerprintUpstreamPayload(outboundPayload));
  });

  it("ignores display, price, timestamp and UI-only fields", () => {
    const changedUiOnlyFields = {
      ...observedAssetReqParam,
      uiState: { selectedTab: "basic" },
      price: 999,
      createTime: 2,
      params: observedAssetReqParam.params.map((param) => ({
        ...param,
        name: "different display name"
      }))
    };

    expect(fingerprintAssetReqParam(changedUiOnlyFields))
      .toBe(fingerprintAssetReqParam(observedAssetReqParam));
  });

  it("ignores an empty optional media parameter inserted into asset history", () => {
    const observedWithEmptyMedia = {
      ...observedAssetReqParam,
      params: [
        {
          idx: "1",
          name: "Optional image",
          values: [],
          filePath: []
        },
        ...observedAssetReqParam.params
      ]
    };

    expect(fingerprintAssetReqParam(observedWithEmptyMedia))
      .toBe(fingerprintUpstreamPayload(outboundPayload));
  });

  it("ignores an unused optional parameter placeholder without values", () => {
    const observedWithPlaceholder = {
      ...observedAssetReqParam,
      params: [
        ...observedAssetReqParam.params,
        { idx: "11", name: "Optional seed" }
      ]
    };

    expect(fingerprintAssetReqParam(observedWithPlaceholder))
      .toBe(fingerprintUpstreamPayload(outboundPayload));
  });

  it("rejects malformed asset reqParam instead of hashing an unrelated value", () => {
    expect(() => fingerprintAssetReqParam("{not-json"))
      .toThrowError(/reqParam/u);
    expect(() => fingerprintAssetReqParam({ params: [] }))
      .toThrowError(/apiId/u);
  });
});
