import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.live.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 1_200_000,
    hookTimeout: 120_000
  }
});
