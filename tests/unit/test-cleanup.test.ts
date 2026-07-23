import { describe, expect, it, vi } from "vitest";
import { removeTestDirectory } from "../helpers/cleanup.js";

describe("test directory cleanup", () => {
  it("uses bounded Windows-safe retries for recursive cleanup", () => {
    const remove = vi.fn();

    removeTestDirectory("fixture-directory", remove);

    expect(remove).toHaveBeenCalledWith("fixture-directory", {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20
    });
  });
});
