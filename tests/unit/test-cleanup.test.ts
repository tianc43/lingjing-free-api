import { describe, expect, it, vi } from "vitest";
import {
  isExpectedWalContentionCloseError,
  removeTestDirectory
} from "../helpers/cleanup.js";

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

  it.each([
    "WAL checkpoint incomplete after 4 bounded attempts (busy=1, log=8, checkpointed=3); repository was closed safely",
    "WAL checkpoint incomplete after 4 bounded attempts (SQLite remained busy or returned an invalid result); repository was closed safely"
  ])("accepts only a complete expected WAL contention message", (message) => {
    expect(isExpectedWalContentionCloseError(new Error(message))).toBe(true);
  });

  it.each([
    "WAL checkpoint incomplete after 3 bounded attempts (busy=1, log=8, checkpointed=3); repository was closed safely",
    "WAL checkpoint incomplete after 4 bounded attempts (not really SQLite contention); repository was closed safely",
    "WAL checkpoint failed; repository was closed safely"
  ])("does not swallow another close error: %s", (message) => {
    expect(isExpectedWalContentionCloseError(new Error(message))).toBe(false);
  });
});
