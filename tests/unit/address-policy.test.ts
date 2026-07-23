import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPublicHttpTarget,
  type AddressResolver
} from "../../src/media/address-policy.js";
import {
  RemoteMediaFetcher,
  type PinnedDispatcherFactory,
  type RemoteRequest
} from "../../src/media/remote-fetcher.js";
import { createTempBudget } from "../../src/media/temp-budget.js";

const publicAnswer = [{ address: "93.184.216.34", family: 4 as const }];
const fakeResolver: AddressResolver = () => Promise.resolve(publicAnswer);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("remote media address policy", () => {
  it.each([
    "http://127.0.0.1/a.png",
    "http://[::1]/a.png",
    "http://169.254.169.254/latest/meta-data",
    "http://10.1.2.3/a.png",
    "http://172.16.0.1/a.png",
    "http://192.168.1.2/a.png",
    "http://100.64.0.1/a.png",
    "http://192.0.2.1/a.png",
    "http://198.18.0.1/a.png",
    "http://198.51.100.1/a.png",
    "http://203.0.113.1/a.png",
    "http://224.0.0.1/a.png",
    "http://240.0.0.1/a.png",
    "http://[::]/a.png",
    "http://[::ffff:127.0.0.1]/a.png",
    "http://[::ffff:8.8.8.8]/a.png",
    "http://[64:ff9b::7f00:1]/a.png",
    "http://[fec0::1]/a.png",
    "http://[fc00::1]/a.png",
    "http://[fe80::1]/a.png",
    "http://[ff00::1]/a.png",
    "http://[2001:2::1]/a.png",
    "http://[2001:db8::1]/a.png",
    "http://[3fff::1]/a.png",
    "http://[4000::1]/a.png",
    "http://0x7f000001/a.png",
    "http://0177.0.0.1/a.png",
    "http://2130706433/a.png",
    "http://user:pass@example.com/a.png",
    "ftp://example.com/a.png"
  ])("blocks unsafe target %s", async (url) => {
    await expect(
      assertPublicHttpTarget(new URL(url), fakeResolver)
    ).rejects.toMatchObject({ code: "unsafe_media_url" });
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    const resolver: AddressResolver = () => Promise.resolve([
      { address: "93.184.216.34", family: 4 as const },
      { address: "127.0.0.1", family: 4 as const }
    ]);

    await expect(
      assertPublicHttpTarget(new URL("https://mixed.test/a.png"), resolver)
    ).rejects.toMatchObject({ code: "unsafe_media_url" });
  });

  it("pins the validated public address for the actual connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-fetcher-test-"));
    directories.push(directory);
    const resolverCalls: string[] = [];
    const pinnedAddresses: string[] = [];
    const resolver: AddressResolver = (hostname) => {
      resolverCalls.push(hostname);
      return Promise.resolve(resolverCalls.length === 1
        ? publicAnswer
        : [{ address: "127.0.0.1", family: 4 as const }]);
    };
    const dispatcherFactory: PinnedDispatcherFactory = (target) => {
      pinnedAddresses.push(target.address);
      return { close: () => Promise.resolve() };
    };
    const request: RemoteRequest = () => Promise.resolve({
      statusCode: 200,
      headers: {
        "content-type": "image/png",
        "content-length": "7"
      },
      body: Readable.from(Buffer.from("fixture"))
    });
    const fetcher = new RemoteMediaFetcher({
      resolver,
      dispatcherFactory,
      request,
      tempDirectory: directory,
      tempBudget: createTempBudget(1024),
      requestBudget: createTempBudget(1024)
    });

    const media = await fetcher.fetch(
      new URL("https://rebind.test/a.png"),
      { kind: "image", maxBytes: 1024 }
    );
    await media.dispose();

    expect(resolverCalls).toEqual(["rebind.test"]);
    expect(pinnedAddresses).toEqual(["93.184.216.34"]);
  });

  it("resolves and validates every redirect before the next request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-fetcher-test-"));
    directories.push(directory);
    const requested: string[] = [];
    const request: RemoteRequest = (url) => {
      requested.push(url.toString());
      return Promise.resolve({
        statusCode: 302,
        headers: { location: "http://127.0.0.1/private.png" },
        body: Readable.from([])
      });
    };
    const fetcher = new RemoteMediaFetcher({
      resolver: fakeResolver,
      dispatcherFactory: () => ({ close: () => Promise.resolve() }),
      request,
      tempDirectory: directory,
      tempBudget: createTempBudget(1024),
      requestBudget: createTempBudget(1024)
    });

    await expect(
      fetcher.fetch(new URL("https://public.test/a.png"), {
        kind: "image",
        maxBytes: 1024
      })
    ).rejects.toMatchObject({ code: "unsafe_media_url" });
    expect(requested).toEqual(["https://public.test/a.png"]);
  });

  it("allows at most three redirects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-fetcher-test-"));
    directories.push(directory);
    let requestCount = 0;
    const request: RemoteRequest = (url) => {
      requestCount += 1;
      return Promise.resolve({
        statusCode: 302,
        headers: {
          location: new URL(`/hop-${String(requestCount)}`, url).toString()
        },
        body: Readable.from([])
      });
    };
    const fetcher = new RemoteMediaFetcher({
      resolver: fakeResolver,
      dispatcherFactory: () => ({ close: () => Promise.resolve() }),
      request,
      tempDirectory: directory,
      tempBudget: createTempBudget(1024),
      requestBudget: createTempBudget(1024)
    });

    await expect(
      fetcher.fetch(new URL("https://public.test/start"), {
        kind: "image",
        maxBytes: 1024
      })
    ).rejects.toMatchObject({ code: "unsafe_media_url" });
    expect(requestCount).toBe(4);
  });

  it("re-resolves and pins each public redirect hop independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-fetcher-test-"));
    directories.push(directory);
    const resolvedHosts: string[] = [];
    const pinnedAddresses: string[] = [];
    const resolver: AddressResolver = (hostname) => {
      resolvedHosts.push(hostname);
      return Promise.resolve(hostname === "first.test"
        ? [{ address: "93.184.216.34", family: 4 as const }]
        : [{ address: "142.250.72.14", family: 4 as const }]);
    };
    const request: RemoteRequest = (url) => Promise.resolve(
      url.hostname === "first.test"
        ? {
            statusCode: 302,
            headers: { location: "https://second.test/final.png" },
            body: Readable.from([])
          }
        : {
            statusCode: 200,
            headers: {
              "content-type": "image/png",
              "content-length": "3"
            },
            body: Readable.from("png")
          }
    );
    const fetcher = new RemoteMediaFetcher({
      resolver,
      dispatcherFactory: (target) => {
        pinnedAddresses.push(target.address);
        return { close: () => Promise.resolve() };
      },
      request,
      tempDirectory: directory,
      tempBudget: createTempBudget(1024),
      requestBudget: createTempBudget(1024)
    });

    const media = await fetcher.fetch(
      new URL("https://first.test/start"),
      { kind: "image", maxBytes: 1024 }
    );
    await media.dispose();

    expect(resolvedHosts).toEqual(["first.test", "second.test"]);
    expect(pinnedAddresses).toEqual([
      "93.184.216.34",
      "142.250.72.14"
    ]);
  });

  it("aborts a redirect body without consuming it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-fetcher-test-"));
    directories.push(directory);
    let reads = 0;
    const body = new Readable({
      read() {
        reads += 1;
        this.push("ignored");
        this.push(null);
      }
    });
    const fetcher = new RemoteMediaFetcher({
      resolver: fakeResolver,
      dispatcherFactory: () => ({ close: () => Promise.resolve() }),
      request: () => Promise.resolve({
        statusCode: 302,
        headers: { location: "http://127.0.0.1/private.png" },
        body
      }),
      tempDirectory: directory,
      tempBudget: createTempBudget(1024),
      requestBudget: createTempBudget(1024)
    });

    await expect(
      fetcher.fetch(new URL("https://public.test/start"), {
        kind: "image",
        maxBytes: 1024
      })
    ).rejects.toMatchObject({ code: "unsafe_media_url" });
    expect(reads).toBe(0);
    expect(body.destroyed).toBe(true);
  });

  it("aborts before consuming a declared oversized body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-fetcher-test-"));
    directories.push(directory);
    let reads = 0;
    const body = new Readable({
      read() {
        reads += 1;
        this.push(Buffer.alloc(100));
        this.push(null);
      }
    });
    const fetcher = new RemoteMediaFetcher({
      resolver: fakeResolver,
      dispatcherFactory: () => ({ close: () => Promise.resolve() }),
      request: () => Promise.resolve({
        statusCode: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "100"
        },
        body
      }),
      tempDirectory: directory,
      tempBudget: createTempBudget(1024),
      requestBudget: createTempBudget(1024)
    });

    await expect(
      fetcher.fetch(new URL("https://public.test/large.png"), {
        kind: "image",
        maxBytes: 10
      })
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(reads).toBe(0);
    expect(body.destroyed).toBe(true);
  });

  it("strips query credentials and fragments from stream errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-fetcher-test-"));
    directories.push(directory);
    const body = new Readable({
      read() {
        this.destroy(
          new Error(
            "download failed HTTPS://user:pass@cdn.test/a.png?token=secret#private"
          )
        );
      }
    });
    const fetcher = new RemoteMediaFetcher({
      resolver: fakeResolver,
      dispatcherFactory: () => ({ close: () => Promise.resolve() }),
      request: () => Promise.resolve({
        statusCode: 200,
        headers: { "content-type": "image/png" },
        body
      }),
      tempDirectory: directory,
      tempBudget: createTempBudget(1024),
      requestBudget: createTempBudget(1024)
    });

    const error = await fetcher.fetch(
      new URL("https://public.test/a.png"),
      { kind: "image", maxBytes: 1024 }
    ).then(
      () => undefined,
      (cause: unknown) => cause
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).not.toContain("#private");
    expect((error as Error).message).not.toContain("user:pass");
  });
});
