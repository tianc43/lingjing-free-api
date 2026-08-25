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
    expect(config.dataDirectory).toBe("./data");
    expect(config.outputRetentionMs).toBe(604_800_000);
    expect(config.redisUrl).toBeNull();
  });

  it("requires a URL for PostgreSQL and preserves it for bootstrap",()=>{expect(()=>parseConfig({...validEnv,DATABASE_DRIVER:"postgres"})).toThrow(/DATABASE_URL/u);const config=parseConfig({...validEnv,DATABASE_DRIVER:"postgres",DATABASE_URL:"postgres://db/lingjing"});expect(config.databaseDriver).toBe("postgres");expect(config.databaseUrl).toBe("postgres://db/lingjing");});

  it("accepts an explicit data directory for server-derived account sessions", () => {
    expect(parseConfig({ ...validEnv, DATA_DIRECTORY: "./private-data" }).dataDirectory)
      .toBe("./private-data");
  });

  it("enables administrator access only for a trimmed non-empty password", () => {
    expect(parseConfig(validEnv).adminPassword).toBeNull();
    expect(parseConfig({
      ...validEnv,
      LINGJING_ADMIN_PASSWORD: "   "
    }).adminPassword).toBeNull();
    expect(parseConfig({
      ...validEnv,
      LINGJING_ADMIN_PASSWORD: "  fixture-admin-password  "
    }).adminPassword).toBe("fixture-admin-password");
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
