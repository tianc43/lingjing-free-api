import { Readable, Writable } from "node:stream";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { removeTestDirectory } from "../helpers/cleanup.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    removeTestDirectory(directory);
  }
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
          cookies: [{
            name: "csrfToken",
            value: ["real", "secret-value"].join("-")
          }],
          origins: [{ origin: "https://lingjing.jdcloud.com" }],
          originPin: ["real", "account-identifier"].join("-"),
          taskId: ["real", "task-identifier"].join("-")
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

  it("rejects cookie-shaped text in atomic storage-state credential values", () => {
    const cookieShapedAtomicValue = ["sid", "fixture-mask"].join("=");
    const similarAtomicValue = ["token", "fixture-mask"].join("=");
    const violations = scanSecrets([
      {
        name: "atomic-storage-state.json",
        content: JSON.stringify({
          cookies: [{
            name: "sid",
            value: cookieShapedAtomicValue
          }],
          origins: []
        })
      },
      {
        name: "atomic-named-record.log",
        content: JSON.stringify({
          name: "cookie",
          value: similarAtomicValue
        })
      }
    ]);

    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining("atomic-storage-state.json"),
      expect.stringContaining("atomic-named-record.log")
    ]));
  });

  it("accepts atomic fixture cookies and fixture-only Cookie header fields", () => {
    expect(scanSecrets([
      {
        name: "fixture-storage-state.json",
        content: JSON.stringify({
          cookies: [{ name: "sid", value: "fixture-cookie" }],
          origins: []
        })
      },
      {
        name: "fixture-cookie-header.log",
        content: JSON.stringify({
          cookie: [
            ["sid", "fixture-cookie"].join("="),
            ["csrf", "fixture-csrf"].join("=")
          ].join("; ")
        })
      }
    ])).toEqual([]);
  });

  it.each([
    [
      "env-prefix-escape.env",
      ["LINGJING_API_KEY", "=", "change-me-but-real"].join("")
    ],
    [
      "env-stolen.env",
      ["LINGJING_API_KEY", "=", "change-me-stolen"].join("")
    ],
    [
      "account.yml",
      ["origin", "Pin: ", "stolen-account-id"].join("")
    ],
    [
      "task.ts",
      ["task", "Id: \"", "stolen-task-id", "\""].join("")
    ],
    [
      "api-key.yml",
      ["api_", "key: ", "stolen-downstream-key"].join("")
    ],
    [
      "storage-state.json",
      JSON.stringify({
        cookies: [{
          name: "csrfToken",
          value: ["change-me", "-stolen"].join("")
        }],
        origins: [{ origin: "https://lingjing.jdcloud.com" }]
      })
    ],
    [
      "storage-state-arbitrary-cookie.json",
      JSON.stringify({
        cookies: [{
          name: "thor",
          value: ["stolen", "cookie-value"].join("-")
        }],
        origins: [{ origin: "https://lingjing.jdcloud.com" }]
      })
    ],
    [
      "placeholder-default-secret.env",
      [
        "LINGJING_API_KEY",
        "=",
        "${SAFE_NAME:-",
        "stolen-secret-value}"
      ].join("")
    ],
    [
      "media.txt",
      [
        "https://img13.",
        "360buyimg.com/",
        "fixture-private-output.png"
      ].join("")
    ]
  ])("independently rejects reviewer escape sample %s", (name, content) => {
    expect(scanSecrets([{ name, content }])).toEqual([
      expect.stringContaining(name)
    ]);
  });

  it.each([
    ["braced", "apiKey=${LINGJING_API_KEY}"],
    ["empty-default", "cookie=${LINGJING_COOKIE:-}"],
    ["shell", "taskId=$LINGJING_TASK_ID"],
    ["powershell", "authorization=$env:LINGJING_API_KEY"]
  ])("accepts the exact %s placeholder form", (_form, content) => {
    expect(scanSecrets([{ name: "placeholder.env", content }])).toEqual([]);
  });

  it("allows exact change-me and fixture-prefixed values", () => {
    expect(scanSecrets([{
      name: "fixtures.yml",
      content: [
        "apiKey: change-me",
        "originPin: fixture-account",
        "taskId: fixture-task",
        "cookie: fixture-cookie",
        "csrfToken: fixture-csrf",
        "apiKey: fixture-downstream"
      ].join("\n")
    }])).toEqual([]);
  });

  it("builds and scans a fresh dist plus tracked files, package output and logs", () => {
    const dist = resolve(process.cwd(), "dist");
    removeTestDirectory(dist);
    expect(existsSync(dist)).toBe(false);
    const inputs = collectProjectSecurityInputs(process.cwd(), [
      { name: "captured-test.log", content: "{\"status\":\"fixture-ok\"}" }
    ]);
    expect(existsSync(dist)).toBe(true);
    expect(inputs.some((input) => input.name.startsWith("git:"))).toBe(true);
    expect(inputs.some((input) => input.name.startsWith("dist:"))).toBe(true);
    expect(inputs.some((input) => input.name === "npm-pack-dry-run.json"))
      .toBe(true);
    expect(inputs.some((input) => input.name === "captured-test.log"))
      .toBe(true);
    expect(scanSecrets(inputs)).toEqual([]);
  }, 30_000);
});
