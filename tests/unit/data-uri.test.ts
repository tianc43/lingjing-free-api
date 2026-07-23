import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDataUri } from "../../src/media/data-uri.js";
import { createTempBudget } from "../../src/media/temp-budget.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
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
