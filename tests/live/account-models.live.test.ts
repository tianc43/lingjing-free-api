import { afterAll, beforeAll, describe, it } from "vitest";
import type { SourceType } from "../../src/models/types.js";
import {
  liveTestEnabled,
  startLiveRuntime,
  type LiveRuntime
} from "./live-helpers.js";

const live = liveTestEnabled() ? describe : describe.skip;

function object(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new Error("Live API returned an invalid sanitized response");
  }
  return value as Record<string, unknown>;
}

function nonEmptyModelList(value: unknown): boolean {
  const response = object(value);
  return Array.isArray(response.data) && response.data.length > 0;
}

live("Lingjing live account and models", () => {
  let acceptance: LiveRuntime | undefined;

  beforeAll(async () => {
    acceptance = await startLiveRuntime();
  });

  afterAll(async () => {
    await acceptance?.close();
  });

  it("matches normalized wallet balance and lists current model capabilities", async () => {
    if (acceptance === undefined) {
      throw new Error("Live runtime is unavailable");
    }
    const direct = await acceptance.runtime.dependencies.account.describe();
    const accountResponse = await acceptance.inject({
      method: "GET",
      url: "/v1/account"
    });
    if (accountResponse.statusCode !== 200) {
      throw new Error("Live account check failed");
    }
    const account = object(JSON.parse(accountResponse.body) as unknown);
    if (
      typeof account.points_balance !== "number"
      || account.points_balance !== direct.pointsBalance
    ) {
      throw new Error("Live normalized wallet balance did not match");
    }

    const modelQueries = [
      "/v1/models?type=image&refresh=true",
      "/v1/models?type=video&mode=text-to-video&refresh=true",
      "/v1/models?type=video&mode=image-to-video&refresh=true"
    ];
    for (const url of modelQueries) {
      const response = await acceptance.inject({ method: "GET", url });
      if (
        response.statusCode !== 200
        || !nonEmptyModelList(JSON.parse(response.body) as unknown)
      ) {
        throw new Error("A current live model capability is unavailable");
      }
    }

    const sourceTypes: SourceType[] = [
      "image-generation",
      "text-to-video",
      "image-to-video"
    ];
    for (const sourceType of sourceTypes) {
      const models = await acceptance.runtime.dependencies.catalog.list(
        sourceType
      );
      if (models.length === 0) {
        throw new Error("A current live model capability is unavailable");
      }
    }
  });
});
