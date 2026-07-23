import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempBudget } from "../../src/media/temp-budget.js";

const fsFault = vi.hoisted(() => ({
  open: vi.fn(),
  chmod: vi.fn(),
  rm: vi.fn(),
  close: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: fsFault.open,
    chmod: fsFault.chmod,
    rm: fsFault.rm
  };
});

import { createPreparedTempFileFromBuffer } from "../../src/media/temp-files.js";

beforeEach(() => {
  fsFault.open.mockReset();
  fsFault.chmod.mockReset();
  fsFault.rm.mockReset();
  fsFault.close.mockReset();
});

describe("private temp-file creation", () => {
  it("closes and unlinks an opened file when chmod fails", async () => {
    const chmodFailure = new Error("fixture chmod failure");
    fsFault.open.mockResolvedValue({
      close: fsFault.close,
      writeFile: vi.fn()
    });
    fsFault.close.mockResolvedValue(undefined);
    fsFault.chmod.mockRejectedValue(chmodFailure);
    fsFault.rm.mockResolvedValue(undefined);
    const tempBudget = createTempBudget(10);
    const requestBudget = createTempBudget(10);

    await expect(
      createPreparedTempFileFromBuffer(Buffer.from("abc"), {
        filename: "fixture.png",
        contentType: "image/png",
        tempDirectory: "C:\\fixture-private-temp",
        tempBudget,
        requestBudget
      })
    ).rejects.toBe(chmodFailure);

    expect(fsFault.close).toHaveBeenCalledOnce();
    expect(fsFault.rm).toHaveBeenCalledOnce();
    expect(fsFault.rm).toHaveBeenCalledWith(
      expect.stringMatching(/fixture-[a-f0-9-]+\.png$/u),
      { force: true }
    );
    expect(tempBudget.usedBytes()).toBe(0);
    expect(requestBudget.usedBytes()).toBe(0);
  });
});
