import type { Dispatcher } from "undici";
import type { SessionProvider } from "../session/types.js";

export interface ReadRequest {
  query?: Record<string, string | number | boolean | undefined>;
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
}

export interface UploadRequest {
  method: "POST" | "PUT";
  headers?: Record<string, string>;
  body: string | Buffer | Uint8Array | FormData | NodeJS.ReadableStream;
  timeoutMs: number;
}

export interface SignedUploadResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
}

export interface LingjingTransport {
  read<T>(path: string, init?: ReadRequest): Promise<T>;
  submitOnce<T>(path: string, body: unknown): Promise<T>;
  uploadApi<T>(path: string, init: UploadRequest): Promise<T>;
  putSigned(url: URL, init: UploadRequest): Promise<SignedUploadResponse>;
}

export interface LingjingClientOptions {
  baseUrl?: URL;
  session: SessionProvider;
  dispatcher?: Dispatcher;
  sleep?: (milliseconds: number) => Promise<void>;
}
