import { describe, expect, it } from "vitest";
import { quotedPoints } from "../../src/accounts/quote.js";
import type { NormalizedModel } from "../../src/models/types.js";

function model(overrides: Partial<NormalizedModel>): NormalizedModel {
  return {
    id: "fixture",
    apiId: "fixture",
    alias: "fixture",
    displayName: "Fixture",
    sourceType: "image-generation",
    modelCode: null,
    refId: "fixture",
    sceneCode: "fixture",
    expectedAssetScene: "fixture",
    uploadStrategy: "general",
    priceQuerySchema: null,
    parameters: [],
    pricing: null,
    rawRevision: "fixture",
    ...overrides
  };
}

describe("quotedPoints", () => {
  it("returns an explicitly point-denominated fixed quote", () => {
    expect(quotedPoints(model({ pricing: {
      billingType: "fixed",
      unit: "points",
      points: 7
    } }), {})).toBe(7);
  });

  it("returns a single explicitly point-denominated amount without an optional billing label", () => {
    expect(quotedPoints(model({ pricing: { unit: "points", amount: 7 } }), {})).toBe(7);
  });

  it("returns the deterministic parameter-table quote for the supplied value", () => {
    expect(quotedPoints(model({
      pricing: null,
      priceQuerySchema: {
        duration: { source: "duration", prices: { "5": 12, "10": 20 } }
      }
    }), { duration: 10 })).toBe(20);
  });

  it("does not fall back to a parameter table when fixed pricing is present but untrusted", () => {
    expect(quotedPoints(model({
      pricing: { amount: 7, unit: "USD" },
      priceQuerySchema: {
        duration: { source: "duration", prices: { "10": 20 } }
      }
    }), { duration: 10 })).toBeNull();
  });

  it.each([
    ["currency", model({ pricing: { amount: 7, unit: "USD" } }), {}],
    ["missing", model({ pricing: null }), {}],
    ["negative", model({ pricing: { billingType: "fixed", unit: "points", points: -1 } }), {}],
    ["non-finite", model({ pricing: { billingType: "fixed", unit: "points", points: Number.POSITIVE_INFINITY } }), {}],
    ["mixed currency", model({ pricing: { billingType: "fixed", unit: "points", currency: "USD", points: 7 } }), {}],
    ["ambiguous", model({ pricing: { billingType: "fixed", unit: "points", points: 7, amount: 7 } }), {}],
    ["missing parameter", model({ priceQuerySchema: { duration: { source: "duration", prices: { "5": 12 } } } }), {}]
  ])("rejects %s pricing", (_name, candidate, values) => {
    expect(quotedPoints(candidate, values)).toBeNull();
  });
});
