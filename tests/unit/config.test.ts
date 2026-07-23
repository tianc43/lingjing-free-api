import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";

const validEnv = {
  LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length",
  LINGJING_STORAGE_STATE: "./fixtures/storage-state.json",
  LINGJING_SESSION_PROFILE: "./fixtures/session-profile.json"
};

describe("parseConfig", () => {
  it("uses local-only defaults and concurrency five", () => {
    const config = parseConfig(validEnv);
    expect(config.host).toBe("127.0.0.1");
    expect(config.maxConcurrency).toBe(5);
    expect(config.sessionMode).toBe("browser-state");
  });

  it("rejects the sample key and invalid concurrency", () => {
    expect(() => parseConfig({ LINGJING_API_KEY: "change-me" })).toThrow();
    expect(() => parseConfig({
      LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length",
      LINGJING_MAX_CONCURRENCY: "6"
    })).toThrow();
  });

  it("requires all waits and unknown holds to exceed polling", () => {
    expect(() => parseConfig({
      ...validEnv,
      TASK_POLL_INTERVAL_MS: "5000",
      IMAGE_WAIT_TIMEOUT_MS: "4000"
    })).toThrow();
  });

  it("rejects unsafe body, temporary-disk and queue limits", () => {
    expect(() => parseConfig({
      ...validEnv,
      JSON_BODY_LIMIT_BYTES: "0"
    })).toThrow();
    expect(() => parseConfig({
      ...validEnv,
      MAX_TEMP_BYTES: "1024",
      MAX_VIDEO_BYTES: "2048"
    })).toThrow();
    expect(() => parseConfig({
      ...validEnv,
      MAX_QUEUED_REQUESTS: "101"
    })).toThrow();
  });
});
