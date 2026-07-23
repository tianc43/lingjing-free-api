import { Readable, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logging.js";
import {
  type AddressResolver
} from "../../src/media/address-policy.js";
import {
  RemoteMediaFetcher,
  type RemoteRequest
} from "../../src/media/remote-fetcher.js";
import { createTempBudget } from "../../src/media/temp-budget.js";
import {
  assertNoSensitiveValues,
  collectProjectSecurityInputs,
  scanSecrets
} from "../helpers/secret-scan.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("security regression", () => {
  it("rejects private DNS answers and redirect escapes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lingjing-security-"));
    directories.push(directory);
    const resolver: AddressResolver = (hostname) => Promise.resolve(
      hostname === "fixture-public.test"
        ? [{ address: "93.184.216.34", family: 4 as const }]
        : [{ address: "127.0.0.1", family: 4 as const }]
    );
    const requested: string[] = [];
    const request: RemoteRequest = (url) => {
      requested.push(url.toString());
      return Promise.resolve({
        statusCode: 302,
        headers: { location: "http://fixture-private.test/private.png" },
        body: Readable.from([])
      });
    };
    const fetcher = new RemoteMediaFetcher({
      resolver,
      dispatcherFactory: () => ({ close: () => Promise.resolve() }),
      request,
      tempDirectory: directory,
      tempBudget: createTempBudget(1024),
      requestBudget: createTempBudget(1024)
    });

    await expect(fetcher.fetch(
      new URL("https://fixture-public.test/start.png"),
      { kind: "image", maxBytes: 1024 }
    )).rejects.toMatchObject({ code: "unsafe_media_url" });
    expect(requested).toEqual([
      "https://fixture-public.test/start.png"
    ]);
  });

  it("keeps prompt fixtures and credentials out of captured logs", () => {
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString("utf8"));
        callback();
      }
    });
    const logger = createLogger("info", output);
    const prompt = "fixture-private-prompt-never-log";
    logger.info({
      prompt,
      cookie: "fixture-cookie",
      csrfToken: "fixture-csrf",
      authorization: "Bearer fixture-downstream"
    }, "fixture generation");
    const captured = chunks.join("");

    expect(() => {
      assertNoSensitiveValues(captured, [
        prompt,
        "fixture-cookie",
        "fixture-csrf",
        "fixture-downstream"
      ]);
    }).not.toThrow();
  });

  it("finds injected non-fixture credentials and accepts fixture tokens", () => {
    expect(scanSecrets([
      {
        name: "injected.json",
        content: JSON.stringify({
          cookies: [{ name: "csrfToken", value: "real-secret-value" }],
          origins: [{ origin: "https://lingjing.jdcloud.com" }],
          originPin: "real-account-identifier",
          taskId: "real-task-identifier"
        })
      },
      {
        name: "injected.env",
        content: [
          "LINGJING_API_KEY",
          "=",
          "real-downstream-key-value"
        ].join("")
      }
    ])).toEqual(expect.arrayContaining([
      expect.stringContaining("injected.json"),
      expect.stringContaining("injected.env")
    ]));
    expect(scanSecrets([{
      name: "fixture.json",
      content: JSON.stringify({
        cookies: [{ name: "csrfToken", value: "fixture-csrf" }],
        origins: [{ origin: "https://lingjing.jdcloud.com" }]
      })
    }])).toEqual([]);
  });

  it("scans tracked files, dist, package dry-run output and logs", () => {
    const inputs = collectProjectSecurityInputs(process.cwd(), [
      { name: "captured-test.log", content: "{\"status\":\"fixture-ok\"}" }
    ]);
    expect(inputs.some((input) => input.name.startsWith("git:"))).toBe(true);
    expect(inputs.some((input) => input.name.startsWith("dist:"))).toBe(true);
    expect(inputs.some((input) => input.name === "npm-pack-dry-run.json"))
      .toBe(true);
    expect(inputs.some((input) => input.name === "captured-test.log"))
      .toBe(true);
    expect(scanSecrets(inputs)).toEqual([]);
  });
});
