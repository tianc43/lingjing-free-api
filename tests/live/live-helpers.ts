import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import type {
  InjectOptions,
  LightMyRequestResponse
} from "fastify";
import { parseConfig } from "../../src/config.js";
import {
  startServer,
  type RunningServer
} from "../../src/index.js";
import { LingjingClient } from "../../src/lingjing/client.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
import type {
  NormalizedModel,
  NormalizedParameter
} from "../../src/models/types.js";
import {
  assertPublicHttpTarget,
  defaultAddressResolver,
  type AddressResolver
} from "../../src/media/address-policy.js";
import {
  createPinnedLookup,
  RemoteMediaFetcher
} from "../../src/media/remote-fetcher.js";
import { createTempBudget } from "../../src/media/temp-budget.js";
import type { PreparedMedia } from "../../src/media/types.js";
import { createSessionProvider } from "../../src/session/create-provider.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

type LiveEnvironment = Record<string, string | undefined>;
type LiveKind = "image" | "video";
type LiveStatus =
  | "queued"
  | "submitting"
  | "discovering"
  | "processing"
  | "unknown"
  | "completed"
  | "failed";
interface LiveFetchInit {
  dispatcher: Dispatcher;
  headers: Record<string, string>;
  method: "HEAD" | "GET";
  redirect: "manual";
  signal: AbortSignal;
}

type LiveFetch = (
  input: URL,
  init: LiveFetchInit
) => Promise<Response>;
type LiveWrite = (line: string) => void;

const MAX_VALIDATION_BYTES = 65_536;
const MAX_VALIDATION_REDIRECTS = 3;
const POINT_UNITS = new Set([
  "point",
  "points",
  "credit",
  "credits",
  "灵感值"
]);
const FIXED_BILLING_TYPES = new Set([
  "fixed",
  "once",
  "total",
  "task",
  "per_task",
  "per-task"
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORMAT_CHARACTER = /\p{Cf}/u;
const LIVE_STATUS = new Set<LiveStatus>([
  "queued",
  "submitting",
  "discovering",
  "processing",
  "unknown",
  "completed",
  "failed"
]);

export interface LiveGenerationSelection {
  model: NormalizedModel;
  estimatedDebit: number;
  request: Record<string, unknown>;
}

export interface SubmitCountingTransport {
  transport: LingjingTransport;
  submitCount(): number;
}

export interface LiveRuntime {
  runtime: RunningServer;
  inject(options: InjectOptions): Promise<LightMyRequestResponse>;
  submitCount(): number;
  assertLegacyAdminUsage(
    jobId: string,
    quotedPoints: number
  ): Promise<void>;
  close(): Promise<void>;
}

export interface LiveUrlValidationOptions {
  resolver?: AddressResolver;
  fetch?: LiveFetch;
}

export function liveTestEnabled(
  env: LiveEnvironment = process.env
): boolean {
  return env.LIVE_TEST === "1";
}

export function liveVideoTestEnabled(
  env: LiveEnvironment = process.env
): boolean {
  return liveTestEnabled(env) && env.LIVE_VIDEO_TEST === "1";
}

export function createSubmitCountingTransport(
  delegate: LingjingTransport
): SubmitCountingTransport {
  let submissions = 0;
  return {
    transport: {
      read: delegate.read.bind(delegate),
      uploadApi: delegate.uploadApi.bind(delegate),
      putSigned: delegate.putSigned.bind(delegate),
      async submitOnce<T>(path: string, body: unknown): Promise<T> {
        submissions += 1;
        return delegate.submitOnce<T>(path, body);
      }
    },
    submitCount: () => submissions
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    ? value
    : undefined;
}

function pointUnit(value: unknown): boolean {
  return typeof value === "string"
    && POINT_UNITS.has(value.trim().toLowerCase());
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : undefined;
}

function consistentBillingType(
  record: Record<string, unknown>
): string | null | undefined {
  const values = ["billingType", "billing_type"]
    .filter((key) => Object.hasOwn(record, key))
    .map((key) => normalizedString(record[key]));
  if (
    values.some((value) => value === undefined)
    || (values.length === 2 && values[0] !== values[1])
  ) {
    return null;
  }
  return values[0];
}

function consistentPointUnit(
  record: Record<string, unknown>
): boolean {
  const values = ["unit", "currency"]
    .filter((key) => Object.hasOwn(record, key))
    .map((key) => record[key]);
  return values.every(pointUnit);
}

function estimatedDebit(
  pricing: unknown,
  requireExplicitTotal = false,
  fixedContext = false
): number | undefined {
  if (
    typeof pricing !== "object"
    || pricing === null
    || Array.isArray(pricing)
  ) {
    return undefined;
  }
  const record = pricing as Record<string, unknown>;
  const currentBilling = consistentBillingType(record);
  if (
    currentBilling === null
    || (
      currentBilling !== undefined
      && !FIXED_BILLING_TYPES.has(currentBilling)
    )
    || !consistentPointUnit(record)
    || Object.hasOwn(record, "rate")
  ) {
    return undefined;
  }
  const fixed = fixedContext || currentBilling !== undefined;
  const representations = [
    "points",
    "credits",
    "amount",
    "cost",
    "price"
  ].filter((key) => Object.hasOwn(record, key));
  if (representations.length !== 1) return undefined;

  const representation = representations[0];
  if (representation === undefined) return undefined;
  if (representation === "cost" || representation === "price") {
    return estimatedDebit(
      record[representation],
      requireExplicitTotal,
      fixed
    );
  }
  const amount = finiteNonNegative(record[representation]);
  if (
    amount === undefined
    || (requireExplicitTotal && !fixed)
    || (
      representation === "amount"
      && !pointUnit(record.unit ?? record.currency)
    )
  ) {
    return undefined;
  }
  return amount;
}

function validNumber(
  parameter: NormalizedParameter,
  value: number
): boolean {
  return Number.isFinite(value)
    && (
      parameter.minimum === undefined
      || value >= parameter.minimum
    )
    && (
      parameter.maximum === undefined
      || value <= parameter.maximum
    );
}

function parameterValue(
  parameter: NormalizedParameter
): unknown {
  if (parameter.kind === "enum") {
    if (
      typeof parameter.defaultValue === "string"
      && parameter.options?.includes(parameter.defaultValue) === true
    ) {
      return parameter.defaultValue;
    }
    return parameter.options?.[0];
  }
  if (parameter.kind === "number") {
    if (
      typeof parameter.defaultValue === "number"
      && validNumber(parameter, parameter.defaultValue)
    ) {
      return parameter.defaultValue;
    }
    const candidate = parameter.minimum ?? 1;
    return validNumber(parameter, candidate) ? candidate : undefined;
  }
  if (parameter.kind === "boolean") {
    return typeof parameter.defaultValue === "boolean"
      ? parameter.defaultValue
      : false;
  }
  if (parameter.kind === "string") {
    return typeof parameter.defaultValue === "string"
      && parameter.defaultValue.trim().length > 0
      ? parameter.defaultValue
      : "live-acceptance";
  }
  return undefined;
}

function requiredValue(
  parameter: NormalizedParameter
): unknown {
  const value = parameterValue(parameter);
  if (value === undefined) {
    throw new Error("Selected live model has unsupported required parameters");
  }
  return value;
}

function modelParameter(
  model: NormalizedModel,
  key: string
): NormalizedParameter | undefined {
  return model.parameters.find((parameter) => parameter.key === key);
}

function compatibleImageRequest(
  model: NormalizedModel,
  prompt: string
): Record<string, unknown> {
  if (
    model.sourceType !== "image-generation"
    || model.parameters.some(
      (parameter) => parameter.kind === "image-list" && parameter.required
    )
  ) {
    throw new Error("Selected live model requires input media");
  }

  const request: Record<string, unknown> = {
    model: model.alias,
    prompt,
    n: 1,
    response_format: "url",
    response_mode: "wait"
  };
  const parameters: Record<string, unknown> = {};
  const size = modelParameter(model, "size");
  if (size !== undefined) {
    const value = parameterValue(size);
    if (typeof value === "string") request.size = value;
    else if (size.required) requiredValue(size);
  }

  for (const parameter of model.parameters) {
    if (
      parameter.kind === "image-list"
      || parameter.key === "prompt"
      || parameter.key === "size"
    ) {
      continue;
    }
    if (parameter.key === "model") {
      requiredValue(parameter);
      continue;
    }
    if (["n", "taskNum", "count"].includes(parameter.key)) {
      if (!validNumber(parameter, 1)) {
        throw new Error("Selected live image model cannot generate once");
      }
      continue;
    }
    if (parameter.required) {
      parameters[parameter.key] = requiredValue(parameter);
    }
  }

  if (Object.keys(parameters).length > 0) request.parameters = parameters;
  return request;
}

function compatibleVideoRequest(
  model: NormalizedModel,
  prompt: string
): Record<string, unknown> {
  if (
    model.sourceType !== "text-to-video"
    || model.parameters.some(
      (parameter) => parameter.kind === "image-list" && parameter.required
    )
  ) {
    throw new Error("Selected live model requires input media");
  }

  const request: Record<string, unknown> = {
    model: model.alias,
    prompt,
    mode: "text-to-video",
    response_mode: "wait"
  };
  const parameters: Record<string, unknown> = {};

  for (const parameter of model.parameters) {
    if (parameter.kind === "image-list" || parameter.key === "prompt") {
      continue;
    }
    if (parameter.key === "model") {
      requiredValue(parameter);
      continue;
    }
    if (["duration", "resolution", "ratio"].includes(parameter.key)) {
      if (parameter.defaultValue !== undefined) continue;
      const value = parameter.required
        ? requiredValue(parameter)
        : parameterValue(parameter);
      if (value !== undefined) request[parameter.key] = value;
      continue;
    }
    if (parameter.required && parameter.defaultValue === undefined) {
      parameters[parameter.key] = requiredValue(parameter);
    }
  }

  if (Object.keys(parameters).length > 0) request.parameters = parameters;
  return request;
}

export function selectLiveGeneration(
  models: readonly NormalizedModel[],
  kind: LiveKind,
  prompt: string
): LiveGenerationSelection {
  for (const candidate of models) {
    const debit = estimatedDebit(
      candidate.pricing,
      candidate.priceQuerySchema !== null
    );
    if (debit === undefined) continue;
    try {
      return {
        model: candidate,
        estimatedDebit: debit,
        request: kind === "image"
          ? compatibleImageRequest(candidate, prompt)
          : compatibleVideoRequest(candidate, prompt)
      };
    } catch {
      // Continue to the next current model rather than guessing parameters.
    }
  }
  throw new Error(
    "No current live model has compatible parameters and quoted pricing"
  );
}

export function assertSufficientLiveBalance(
  balance: number,
  debit: number
): void {
  if (
    !Number.isFinite(balance)
    || !Number.isFinite(debit)
    || balance < 0
    || debit < 0
    || balance < debit
  ) {
    throw new Error(
      "Live balance is insufficient for the selected model"
    );
  }
}

function defaultWrite(line: string): void {
  console.log(line);
}

function safeDisplayName(value: string): string {
  let withoutControls = "";
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index) ?? 0;
    const character = String.fromCodePoint(codePoint);
    withoutControls += codePoint <= 31
      || (codePoint >= 127 && codePoint <= 159)
      || FORMAT_CHARACTER.test(character)
      ? " "
      : character;
    index += character.length;
  }
  const safe = withoutControls
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
  return safe.length > 0 ? safe : "unavailable";
}

function writeSafe(
  value: Record<string, string | number>,
  write: LiveWrite
): void {
  write(JSON.stringify(value));
}

export function reportLiveSelection(
  selection: LiveGenerationSelection,
  write: LiveWrite = defaultWrite
): void {
  if (
    !Number.isFinite(selection.estimatedDebit)
    || selection.estimatedDebit < 0
  ) {
    throw new Error("Live estimated cost is unavailable");
  }
  writeSafe({
    model_display_name: safeDisplayName(selection.model.displayName)
  }, write);
  writeSafe({
    estimated_cost: `${String(selection.estimatedDebit)} points`
  }, write);
}

export function reportLiveJob(
  jobId: string,
  status: LiveStatus,
  write: LiveWrite = defaultWrite
): void {
  if (!/^job_[0-9a-f]{32}$/iu.test(jobId)) {
    throw new Error("Live response did not contain a local job ID");
  }
  if (!LIVE_STATUS.has(status)) {
    throw new Error("Live response contained an invalid status");
  }
  writeSafe({ job_id: jobId }, write);
  writeSafe({ status }, write);
}

export function reportLiveBalanceDelta(
  delta: number,
  write: LiveWrite = defaultWrite
): void {
  if (!Number.isFinite(delta)) {
    throw new Error("Live balance delta is unavailable");
  }
  writeSafe({ balance_delta: delta }, write);
}

function expectedContentType(
  response: Response,
  kind: LiveKind
): boolean {
  const contentType = response.headers.get("content-type");
  return contentType === null
    || contentType.toLowerCase().startsWith(`${kind}/`);
}

async function readBounded(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (reader === undefined) return;
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      size += chunk.value.byteLength;
      if (size > MAX_VALIDATION_BYTES) {
        throw new Error("Live output response exceeded validation limit");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function closeResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

interface LiveValidationResponse {
  response: Response;
  dispatcher: Agent;
  url: URL;
}

function safeHttpsUrl(value: string | URL): URL {
  try {
    const url = value instanceof URL ? new URL(value) : new URL(value);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
    ) {
      throw new Error("unsafe");
    }
    return url;
  } catch {
    throw new Error("Live output URL validation failed");
  }
}

const defaultLiveFetch: LiveFetch = async (url, init) => {
  return await undiciFetch(url, init) as unknown as Response;
};

async function requestLiveOutput(
  initialUrl: URL,
  method: "HEAD" | "GET",
  kind: LiveKind,
  options: Required<LiveUrlValidationOptions>
): Promise<LiveValidationResponse> {
  let currentUrl = new URL(initialUrl);
  for (let redirects = 0; ; redirects += 1) {
    currentUrl = safeHttpsUrl(currentUrl);
    const target = await assertPublicHttpTarget(
      currentUrl,
      options.resolver
    );
    const dispatcher = new Agent({
      connect: { lookup: createPinnedLookup(target) }
    });
    let response: Response;
    try {
      response = await options.fetch(currentUrl, {
        method,
        dispatcher,
        headers: method === "GET"
          ? {
              Accept: `${kind}/*`,
              Range: `bytes=0-${String(MAX_VALIDATION_BYTES - 1)}`
            }
          : { Accept: `${kind}/*` },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      await dispatcher.close().catch(() => undefined);
      throw new Error("Live output URL validation failed");
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, dispatcher, url: currentUrl };
    }

    const location = response.headers.get("location");
    await closeResponse(response);
    await dispatcher.close().catch(() => undefined);
    if (
      location === null
      || redirects >= MAX_VALIDATION_REDIRECTS
    ) {
      throw new Error("Live output URL validation failed");
    }
    try {
      currentUrl = new URL(location, currentUrl);
    } catch {
      throw new Error("Live output URL validation failed");
    }
  }
}

export async function validateLiveOutputUrl(
  value: string,
  kind: LiveKind,
  overrides: LiveUrlValidationOptions = {}
): Promise<void> {
  const options: Required<LiveUrlValidationOptions> = {
    resolver: overrides.resolver ?? defaultAddressResolver,
    fetch: overrides.fetch ?? defaultLiveFetch
  };
  let url: URL;
  try {
    url = safeHttpsUrl(value);
  } catch {
    throw new Error("Live output URL validation failed");
  }

  try {
    const headResult = await requestLiveOutput(
      url,
      "HEAD",
      kind,
      options
    );
    const head = headResult.response;
    if (
      head.ok
      && expectedContentType(head, kind)
    ) {
      await closeResponse(head);
      await headResult.dispatcher.close().catch(() => undefined);
      return;
    }
    if (![403, 405, 501].includes(head.status)) {
      await closeResponse(head);
      await headResult.dispatcher.close().catch(() => undefined);
      throw new Error("unreachable");
    }
    await closeResponse(head);
    await headResult.dispatcher.close().catch(() => undefined);

    const getResult = await requestLiveOutput(
      headResult.url,
      "GET",
      kind,
      options
    );
    try {
      if (
        !getResult.response.ok
        || !expectedContentType(getResult.response, kind)
      ) {
        throw new Error("unreachable");
      }
      await readBounded(getResult.response);
    } finally {
      await closeResponse(getResult.response);
      await getResult.dispatcher.close().catch(() => undefined);
    }
  } catch {
    throw new Error("Live output URL validation failed");
  }
}

async function mediaPrefix(
  media: PreparedMedia,
  length = 12
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of media.openRead(0, length - 1)) {
    const value = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array | string);
    chunks.push(value);
    size += value.byteLength;
  }
  return Buffer.concat(chunks, size);
}

function mediaExtension(kind: LiveKind, prefix: Buffer): string {
  if (kind === "image") {
    if (
      prefix.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ) return "png";
    if (
      prefix[0] === 0xff
      && prefix[1] === 0xd8
      && prefix[2] === 0xff
    ) return "jpg";
    if (
      prefix.subarray(0, 4).toString("ascii") === "RIFF"
      && prefix.subarray(8, 12).toString("ascii") === "WEBP"
    ) return "webp";
    if (prefix.subarray(0, 3).toString("ascii") === "GIF") return "gif";
  } else {
    if (prefix.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
    if (
      prefix.subarray(0, 4).equals(
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
      )
    ) return "webm";
  }
  throw new Error("Live output media structure is invalid");
}

export async function downloadLiveOutput(
  value: string,
  kind: LiveKind,
  jobId: string
): Promise<void> {
  if (!/^job_[0-9a-f]{32}$/iu.test(jobId)) {
    throw new Error("Live output job ID is invalid");
  }
  const maxBytes = kind === "image" ? 20_971_520 : 209_715_200;
  const tempDirectory = resolve("outputs", ".tmp");
  await mkdir(tempDirectory, { recursive: true });
  const media = await new RemoteMediaFetcher({
    tempDirectory,
    tempBudget: createTempBudget(maxBytes),
    requestBudget: createTempBudget(maxBytes)
  }).fetch(safeHttpsUrl(value), { kind, maxBytes });
  try {
    if (
      media.size === 0
      || !media.contentType.toLowerCase().startsWith(`${kind}/`)
    ) {
      throw new Error("Live output media metadata is invalid");
    }
    const extension = mediaExtension(kind, await mediaPrefix(media));
    const outputDirectory = resolve("outputs");
    await mkdir(outputDirectory, { recursive: true });
    await pipeline(
      media.openRead(),
      createWriteStream(
        join(outputDirectory, `task6-${kind}-${jobId}.${extension}`),
        { flags: "wx", mode: 0o600 }
      )
    );
  } finally {
    await media.dispose();
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise<void>((resolveClose, reject) => {
    server.close((cause) => {
      if (cause === undefined) resolveClose();
      else reject(cause);
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a live test port");
  }
  return address.port;
}

function liveEnvironment(
  env: LiveEnvironment,
  directory: string,
  port: number,
  apiKey: string,
  adminPassword: string
): LiveEnvironment {
  const sessionMode = env.SESSION_MODE === "cookie-file"
    ? "cookie-file"
    : "browser-state";
  return {
    ...env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    LINGJING_API_KEY: apiKey,
    LINGJING_ADMIN_PASSWORD: adminPassword,
    SESSION_MODE: sessionMode,
    LINGJING_STORAGE_STATE: resolve(
      env.LINGJING_STORAGE_STATE
        ?? "./data/auth/storage-state.json"
    ),
    LINGJING_COOKIE_FILE: resolve(
      env.LINGJING_COOKIE_FILE
        ?? "./data/auth/cookie.txt"
    ),
    LINGJING_SESSION_PROFILE: resolve(
      env.LINGJING_SESSION_PROFILE
        ?? "./data/auth/session-profile.json"
    ),
    DB_PATH: liveDatabasePath(env, directory),
    LOG_LEVEL: "silent",
    DOCS_ENABLED: "false"
  };
}

export function liveDatabasePath(
  env: LiveEnvironment,
  directory: string
): string {
  const persistentPath = env.LIVE_ACCEPTANCE_DB_PATH?.trim();
  return persistentPath === undefined || persistentPath.length === 0
    ? join(directory, "jobs.sqlite")
    : persistentPath;
}

export async function startLiveRuntime(
  env: LiveEnvironment = process.env
): Promise<LiveRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "lingjing-live-"));
  const apiKey = randomBytes(32).toString("hex");
  const adminPassword = randomBytes(32).toString("hex");
  let runtime: RunningServer | undefined;
  try {
    const runtimeEnvironment = liveEnvironment(
      env,
      directory,
      await availablePort(),
      apiKey,
      adminPassword
    );
    const config = parseConfig(runtimeEnvironment);
    const transportSession = await createSessionProvider(config);
    await transportSession.load();
    const counted = createSubmitCountingTransport(
      new LingjingClient({ session: transportSession })
    );
    runtime = await startServer(runtimeEnvironment, {
      transport: counted.transport
    });
    let closePromise: Promise<void> | undefined;
    return {
      runtime,
      inject: (options) => runtime?.app.inject({
        ...options,
        headers: {
          ...options.headers,
          authorization: `Bearer ${apiKey}`
        }
      }) ?? Promise.reject(new Error("Live runtime is unavailable")),
      submitCount: () => counted.submitCount(),
      assertLegacyAdminUsage: async (jobId, quotedPoints) => {
        const activeRuntime = runtime;
        if (activeRuntime === undefined) {
          throw new Error("Live runtime is unavailable");
        }
        const job = activeRuntime.repository.findById(jobId);
        if (
          job?.accountId !== "legacy"
          || job.quotedPoints !== quotedPoints
        ) {
          throw new Error("Live job binding or quote did not persist");
        }
        const login = await activeRuntime.app.inject({
          method: "POST",
          url: "/admin/api/login",
          payload: { password: adminPassword }
        });
        const setCookie = login.headers["set-cookie"];
        const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
          ?.split(";")[0];
        if (login.statusCode !== 200 || cookie === undefined) {
          throw new Error("Live administrator verification could not log in");
        }
        const detail = await activeRuntime.app.inject({
          url: `/admin/api/jobs/${jobId}`,
          headers: { cookie }
        });
        const view = detail.json<{
          job?: {
            account_name?: unknown;
            quoted_points?: unknown;
            budget_state?: unknown;
            status?: unknown;
          };
        }>().job;
        if (
          detail.statusCode !== 200
          || view?.account_name !== "Legacy account"
          || view.quoted_points !== quotedPoints
          || view.budget_state !== "charged"
          || view.status !== "completed"
        ) {
          throw new Error(
            "Live job usage was not visible in the administrator API"
          );
        }
      },
      close: () => {
        closePromise ??= runtime?.stop().finally(() => {
          removeTestDirectory(directory);
        }) ?? Promise.resolve();
        return closePromise;
      }
    };
  } catch {
    if (runtime !== undefined) {
      await runtime.stop().catch(() => undefined);
    }
    removeTestDirectory(directory);
    throw new Error(
      "Live runtime could not start; verify the local login state"
    );
  }
}
