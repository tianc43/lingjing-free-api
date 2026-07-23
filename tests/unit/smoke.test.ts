import { describe, expect, it } from "vitest";
import { SERVICE_NAME } from "../../src/version.js";

describe("project scaffold", () => {
  it("exports the stable service name", () => {
    expect(SERVICE_NAME).toBe("lingjing-free-api");
  });
});
