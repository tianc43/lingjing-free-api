import { Agent, request as undiciRequest, type Dispatcher } from "undici";
import { basename } from "node:path";
import type { AddressResolver, ValidatedTarget } from "./address-policy.js";
import {
  assertPublicHttpTarget,
  defaultAddressResolver
} from "./address-policy.js";
import { errors, sanitizeError } from "../errors.js";
import type { PreparedMedia, TempBudget } from "./types.js";
import { createPreparedTempFileFromStream } from "./temp-files.js";

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface PinnedDispatcher {
  close(): Promise<void>;
}

export type PinnedDispatcherFactory = (
  target: ValidatedTarget
) => PinnedDispatcher;

export interface RemoteResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: NodeJS.ReadableStream;
}

export type RemoteRequest = (
  url: URL,
  options: {
    dispatcher: PinnedDispatcher;
    headers: Record<string, string>;
  }
) => Promise<RemoteResponse>;

export interface RemoteMediaFetcherOptions {
  resolver?: AddressResolver;
  dispatcherFactory?: PinnedDispatcherFactory;
  request?: RemoteRequest;
  tempDirectory: string;
  tempBudget: TempBudget;
  requestBudget: TempBudget;
}

export interface RemoteFetchOptions {
  kind: "image" | "video";
  maxBytes: number;
}

function createPinnedDispatcher(target: ValidatedTarget): PinnedDispatcher {
  return new Agent({
    connect: {
      lookup(_hostname, options, callback): void {
        if (options.all) {
          callback(null, [{
            address: target.address,
            family: target.family
          }]);
          return;
        }
        callback(null, target.address, target.family);
      }
    }
  });
}

const defaultRemoteRequest: RemoteRequest = async (url, options) => {
  const requestOptions: NonNullable<
    Parameters<typeof undiciRequest>[1]
  > & { maxRedirections: number } = {
    method: "GET",
    dispatcher: options.dispatcher as Dispatcher,
    headers: options.headers,
    maxRedirections: 0
  };
  const response = await undiciRequest(url, requestOptions);
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body
  };
};

function firstHeader(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function contentLength(
  value: string | string[] | undefined
): number | undefined {
  const header = firstHeader(value);
  if (header === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(header)) throw errors.unsafeMedia();
  const parsed = Number(header);
  if (!Number.isSafeInteger(parsed)) throw errors.unsafeMedia();
  return parsed;
}

interface AbortableReadable {
  destroy(): void;
}

function isAbortableReadable(
  stream: NodeJS.ReadableStream
): stream is NodeJS.ReadableStream & AbortableReadable {
  const candidate: unknown = Reflect.get(stream, "destroy");
  return typeof candidate === "function";
}

function abortBody(stream: NodeJS.ReadableStream): void {
  if (isAbortableReadable(stream)) {
    stream.destroy();
  }
}

function filenameFor(url: URL, contentType: string): string {
  let leaf = "";
  try {
    leaf = basename(decodeURIComponent(url.pathname));
  } catch {
    leaf = basename(url.pathname);
  }
  if (leaf.length > 0 && leaf.includes(".")) return leaf;
  const subtype = contentType.split("/")[1]?.split("+")[0]
    ?.replace(/[^a-z0-9]+/gu, "")
    .slice(0, 12);
  return `media.${subtype || "bin"}`;
}

export class RemoteMediaFetcher {
  private readonly resolver: AddressResolver;
  private readonly dispatcherFactory: PinnedDispatcherFactory;
  private readonly request: RemoteRequest;

  constructor(private readonly options: RemoteMediaFetcherOptions) {
    this.resolver = options.resolver ?? defaultAddressResolver;
    this.dispatcherFactory = options.dispatcherFactory
      ?? createPinnedDispatcher;
    this.request = options.request ?? defaultRemoteRequest;
  }

  async fetch(
    initialUrl: URL,
    options: RemoteFetchOptions
  ): Promise<PreparedMedia> {
    let currentUrl = new URL(initialUrl);

    for (let redirects = 0; ; redirects += 1) {
      const target = await assertPublicHttpTarget(currentUrl, this.resolver);
      const dispatcher = this.dispatcherFactory(target);
      let response: RemoteResponse;
      try {
        response = await this.request(currentUrl, {
          dispatcher,
          headers: {
            Accept: `${options.kind}/*`
          }
        });
      } catch {
        await dispatcher.close().catch(() => undefined);
        throw errors.unsafeMedia();
      }

      if (REDIRECT_STATUSES.has(response.statusCode)) {
        abortBody(response.body);
        await dispatcher.close().catch(() => undefined);
        if (redirects >= MAX_REDIRECTS) throw errors.unsafeMedia();
        const location = firstHeader(response.headers.location);
        if (location === undefined) throw errors.unsafeMedia();
        try {
          currentUrl = new URL(location, currentUrl);
        } catch {
          throw errors.unsafeMedia();
        }
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        abortBody(response.body);
        await dispatcher.close().catch(() => undefined);
        throw errors.unsafeMedia();
      }

      const contentTypeHeader = firstHeader(response.headers["content-type"]);
      const mediaType = contentTypeHeader?.split(";", 1)[0]?.trim().toLowerCase();
      if (
        mediaType === undefined
        || !/^(?:image|video)\/[a-z0-9][a-z0-9.+-]*$/u.test(mediaType)
        || !mediaType.startsWith(`${options.kind}/`)
      ) {
        abortBody(response.body);
        await dispatcher.close().catch(() => undefined);
        throw errors.invalidRequest("Unsupported remote media content type");
      }

      try {
        const declaredSize = contentLength(
          response.headers["content-length"]
        );
        return await createPreparedTempFileFromStream(response.body, {
          filename: filenameFor(currentUrl, mediaType),
          contentType: mediaType,
          tempDirectory: this.options.tempDirectory,
          tempBudget: this.options.tempBudget,
          requestBudget: this.options.requestBudget,
          maxBytes: options.maxBytes,
          ...(declaredSize === undefined
            ? {}
            : { declaredSize })
        });
      } catch (cause) {
        abortBody(response.body);
        throw sanitizeError(cause, errors.unsafeMedia());
      } finally {
        await dispatcher.close().catch(() => undefined);
      }
    }
  }
}
