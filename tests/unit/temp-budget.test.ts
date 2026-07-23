import { Readable } from "node:stream";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempBudget } from "../../src/media/temp-budget.js";
import {
  createPreparedTempFileFromBuffer,
  createPreparedTempFileFromStream
} from "../../src/media/temp-files.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTestDirectory(directory);
  }
});

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "temp-budget-test-"));
  directories.push(directory);
  return directory;
}

describe("temporary storage budget", () => {
  it("reserves and grows atomically up to the configured total", () => {
    const budget = createTempBudget(10);
    const first = budget.reserve(4);
    const second = budget.reserve(3);

    first.growTo(7);
    expect(budget.usedBytes()).toBe(10);
    let thrown: unknown;
    try {
      second.growTo(4);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toMatchObject({ code: "temporary_storage_exhausted" });
    expect(budget.usedBytes()).toBe(10);
  });

  it("has an idempotent release that returns usage to zero", () => {
    const budget = createTempBudget(10);
    const lease = budget.reserve(10);

    lease.release();
    lease.release();

    expect(budget.usedBytes()).toBe(0);
  });

  it("rejects a known length before consuming the response stream", async () => {
    const directory = await testDirectory();
    const tempBudget = createTempBudget(4);
    const requestBudget = createTempBudget(20);
    let consumed = false;
    const stream = Readable.from((function* () {
      consumed = true;
      yield Buffer.alloc(8);
    })());

    await expect(
      createPreparedTempFileFromStream(stream, {
        filename: "known.png",
        contentType: "image/png",
        maxBytes: 20,
        declaredSize: 8,
        tempDirectory: directory,
        tempBudget,
        requestBudget
      })
    ).rejects.toMatchObject({ code: "temporary_storage_exhausted" });

    expect(consumed).toBe(false);
    expect(tempBudget.usedBytes()).toBe(0);
    expect(requestBudget.usedBytes()).toBe(0);
  });

  it("fails an unknown-length chunk before writing past its limit", async () => {
    const directory = await testDirectory();
    const tempBudget = createTempBudget(20);
    const requestBudget = createTempBudget(20);

    await expect(
      createPreparedTempFileFromStream(
        Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
        {
          filename: "unknown.png",
          contentType: "image/png",
          maxBytes: 6,
          tempDirectory: directory,
          tempBudget,
          requestBudget
        }
      )
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect(await readdir(directory)).toEqual([]);
    expect(tempBudget.usedBytes()).toBe(0);
    expect(requestBudget.usedBytes()).toBe(0);
  });

  it("holds aggregate request bytes until each prepared media is disposed", async () => {
    const directory = await testDirectory();
    const tempBudget = createTempBudget(20);
    const requestBudget = createTempBudget(5);
    const common = {
      filename: "aggregate.png",
      contentType: "image/png",
      tempDirectory: directory,
      tempBudget,
      requestBudget
    };
    const first = await createPreparedTempFileFromBuffer(
      Buffer.alloc(3),
      common
    );

    await expect(
      createPreparedTempFileFromBuffer(Buffer.alloc(3), common)
    ).rejects.toMatchObject({ code: "temporary_storage_exhausted" });
    expect(tempBudget.usedBytes()).toBe(3);
    expect(requestBudget.usedBytes()).toBe(3);

    await first.dispose();
    const second = await createPreparedTempFileFromBuffer(
      Buffer.alloc(3),
      common
    );
    await second.dispose();
    expect(tempBudget.usedBytes()).toBe(0);
    expect(requestBudget.usedBytes()).toBe(0);
  });
});
