import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertSufficientLiveBalance,
  downloadLiveOutput,
  liveTestEnabled,
  reportLiveBalanceDelta,
  reportLiveJob,
  reportLiveSelection,
  selectLiveGeneration,
  startLiveRuntime,
  type LiveRuntime
} from "./live-helpers.js";

const live = liveTestEnabled() ? describe : describe.skip;

function completedImage(value: unknown): {
  jobId: string;
  url: string;
} {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new Error("Live image response was not completed");
  }
  const response = value as {
    job_id?: unknown;
    data?: unknown;
  };
  const output = Array.isArray(response.data)
    && response.data.length === 1
    && typeof response.data[0] === "object"
    && response.data[0] !== null
    ? response.data[0] as { url?: unknown }
    : null;
  if (
    typeof response.job_id !== "string"
    || typeof output?.url !== "string"
  ) {
    throw new Error("Live image response was not completed");
  }
  return { jobId: response.job_id, url: output.url };
}

function safeErrorCode(value: unknown): string {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) return "none";
  const error = (value as { error?: unknown }).error;
  if (
    typeof error !== "object"
    || error === null
    || Array.isArray(error)
  ) return "none";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "none";
}

live("Lingjing live image generation", () => {
  let acceptance: LiveRuntime | undefined;

  beforeAll(async () => {
    acceptance = await startLiveRuntime();
  });

  afterAll(async () => {
    await acceptance?.close();
  });

  it("submits exactly one current image task and verifies its result", async () => {
    if (acceptance === undefined) {
      throw new Error("Live runtime is unavailable");
    }
    const starting = await acceptance.runtime.dependencies.account.describe();
    const models = await acceptance.runtime.dependencies.catalog.list(
      "image-generation",
      true
    );
    const selection = selectLiveGeneration(
      models,
      "image",
      "黑白写实风格的龙形纹身图案设计，干净白色背景，清晰线稿和细节，适合作为纹身手稿，无文字"
    );
    assertSufficientLiveBalance(
      starting.pointsBalance,
      selection.estimatedDebit
    );
    reportLiveSelection(selection);

    const response = await acceptance.inject({
      method: "POST",
      url: "/v1/images/generations",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `live-image-${randomUUID()}`
      },
      payload: selection.request
    });
    if (response.statusCode !== 200) {
      const body = JSON.parse(response.body) as unknown;
      throw new Error(
        `Live image generation did not complete (status=${String(response.statusCode)}; code=${safeErrorCode(body)}; submits=${String(acceptance.submitCount())})`
      );
    }
    const result = completedImage(JSON.parse(response.body) as unknown);
    if (acceptance.submitCount() !== 1) {
      throw new Error("Live image generation submit count was not one");
    }
    reportLiveJob(result.jobId, "completed");
    await acceptance.assertLegacyAdminUsage(
      result.jobId,
      selection.estimatedDebit
    );
    await downloadLiveOutput(result.url, "image", result.jobId);

    const ending = await acceptance.runtime.dependencies.account.describe();
    if (ending.pointsBalance > starting.pointsBalance) {
      throw new Error("Live ending balance exceeded starting balance");
    }
    reportLiveBalanceDelta(
      ending.pointsBalance - starting.pointsBalance
    );
  });
});
