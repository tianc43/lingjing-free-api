import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareDataUri } from "../../src/media/data-uri.js";
import { createTempBudget } from "../../src/media/temp-budget.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTestDirectory(directory);
  }
});

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "data-uri-test-"));
  directories.push(directory);
  return directory;
}

describe("data URI media preparation", () => {
  it("accepts only base64 image or video payloads", async () => {
    const directory = await testDirectory();
    const options = {
      kind: "image" as const,
      maxBytes: 1024,
      tempDirectory: directory,
      tempBudget: createTempBudget(2048),
      requestBudget: createTempBudget(2048)
    };

    await expect(
      prepareDataUri("data:text/plain;base64,Zm9v", options)
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      prepareDataUri("data:image/png,not-base64", options)
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      prepareDataUri("data:video/mp4;base64,Zm9v", options)
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects an oversized decoded payload before materializing it", async () => {
    const directory = await testDirectory();
    const tempBudget = createTempBudget(1024);
    const requestBudget = createTempBudget(1024);

    await expect(
      prepareDataUri(
        `data:image/png;base64,${Buffer.alloc(65).toString("base64")}`,
        {
          kind: "image",
          maxBytes: 64,
          tempDirectory: directory,
          tempBudget,
          requestBudget
        }
      )
    ).rejects.toMatchObject({ code: "invalid_request" });

    expect(tempBudget.usedBytes()).toBe(0);
    expect(requestBudget.usedBytes()).toBe(0);
  });

  it("reserves decoded bytes before calling Buffer.from", async () => {
    const directory = await testDirectory();
    const encoded = Buffer.alloc(3).toString("base64");
    const tempBudget = createTempBudget(2);
    const requestBudget = createTempBudget(10);
    const from = vi.spyOn(Buffer, "from");
    try {
      await expect(
        prepareDataUri(`data:image/png;base64,${encoded}`, {
          kind: "image",
          maxBytes: 10,
          tempDirectory: directory,
          tempBudget,
          requestBudget
        })
      ).rejects.toMatchObject({ code: "temporary_storage_exhausted" });

      const base64Calls = from.mock.calls.filter(
        (call) => (call as unknown[])[1] === "base64"
      );
      expect(base64Calls).toHaveLength(0);
      expect(tempBudget.usedBytes()).toBe(0);
      expect(requestBudget.usedBytes()).toBe(0);
    } finally {
      from.mockRestore();
    }
  });

  it("writes a private disposable temp file with a safe generated name", async () => {
    const directory = await testDirectory();
    const tempBudget = createTempBudget(1024);
    const requestBudget = createTempBudget(1024);
    const media = await prepareDataUri(
      "data:image/png;base64,Zm9v",
      {
        kind: "image",
        maxBytes: 1024,
        tempDirectory: directory,
        tempBudget,
        requestBudget
      }
    );

    expect(media).toMatchObject({
      contentType: "image/png",
      size: 3
    });
    expect(media.filename).toMatch(/^media-[a-f0-9-]+\.png$/u);
    const files = await stat(join(directory, media.filename));
    if (process.platform !== "win32") {
      expect(files.mode & 0o777).toBe(0o600);
    }

    await media.dispose();
    await media.dispose();
    expect(tempBudget.usedBytes()).toBe(0);
    expect(requestBudget.usedBytes()).toBe(0);
  });
});
