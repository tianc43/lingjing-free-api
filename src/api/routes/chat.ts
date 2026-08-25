import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import { z } from "zod";
import { AppError, errors } from "../../errors.js";
import type { GenerationHandle } from "../../generation/types.js";
import type { JobRecord } from "../../jobs/types.js";
import type { MediaInput } from "../../media/types.js";
import type {
  NormalizedModel,
  SourceType
} from "../../models/types.js";
import { extractChatMediaPrompt } from "../chat-input.js";
import {
  bearerSecurity,
  errorResponseSchema,
  routeSchema
} from "../schema.js";
import {
  generationPrincipal,
  requestPrincipal,
  requireScope
} from "../principal.js";
import { SseWriter } from "../sse.js";
import type { AppDependencies } from "../types.js";
import {
  assertNoControlCollisions,
  idempotencyKey,
  mediaFromStrings,
  noStore,
  setIfSupported,
  setModelIfSupported,
  throwFailed,
  validateDynamicValues,
  validateMediaCount
} from "./generation.js";

const SOURCE_TYPES = [
  "image-generation",
  "text-to-video",
  "image-to-video"
] as const satisfies readonly SourceType[];
const TERMINAL = new Set(["completed", "failed", "unknown"]);
const PROGRESS_INTERVAL_MS = 15_000;
const CHAT_DYNAMIC_CONTROL_FIELDS = new Set(["model", "prompt"]);

const imageUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:"
    || protocol === "https:"
    || protocol === "data:";
});
const chatContentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string()
  }).strict(),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: imageUrlSchema
    }).strict()
  }).strict()
]);
const chatMessageSchema = z.object({
  role: z.string().min(1),
  content: z.union([
    z.string(),
    z.array(chatContentBlockSchema).min(1)
  ])
}).strict();
const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().default(false),
  parameters: z.record(z.string(), z.unknown()).optional()
}).strict();

const usageSchema = z.object({
  prompt_tokens: z.literal(0),
  completion_tokens: z.literal(0),
  total_tokens: z.literal(0)
});
const chatCompletionSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number(),
  model: z.string(),
  choices: z.array(z.object({
    index: z.number(),
    message: z.object({
      role: z.literal("assistant"),
      content: z.string()
    }),
    finish_reason: z.literal("stop")
  })),
  usage: usageSchema
});

function normalizeAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function applicableModels(
  groups: readonly NormalizedModel[][],
  hasImages: boolean
): NormalizedModel[] {
  return groups.flat().filter((model) => (
    hasImages
      ? model.sourceType !== "text-to-video"
      : model.sourceType !== "image-to-video"
  ));
}

async function resolveChatModel(
  dependencies: AppDependencies,
  requested: string,
  hasImages: boolean
): Promise<NormalizedModel> {
  const groups = await Promise.all(
    SOURCE_TYPES.map((sourceType) => dependencies.catalog.list(sourceType))
  );
  const candidates = applicableModels(groups, hasImages);
  const exact = candidates.filter((model) => model.apiId === requested);
  const aliases = exact.length === 0
    ? candidates.filter((model) => model.alias === normalizeAlias(requested))
    : [];
  const matches = exact.length > 0 ? exact : aliases;
  if (matches.length !== 1) throw errors.catalogChanged();
  const selected = matches[0];
  if (selected === undefined) throw errors.catalogChanged();
  return dependencies.catalog.resolve(
    selected.apiId,
    selected.sourceType,
    true
  );
}

function requestValues(
  input: z.infer<typeof chatRequestSchema>,
  prompt: string,
  model: NormalizedModel
): Record<string, unknown> {
  assertNoControlCollisions(
    input.parameters,
    CHAT_DYNAMIC_CONTROL_FIELDS
  );
  const values = { ...(input.parameters ?? {}) };
  setIfSupported(values, model, ["prompt"], prompt);
  setModelIfSupported(values, model);
  validateDynamicValues(model, values);
  return values;
}

function markdown(job: JobRecord): string {
  if (job.result === null) return "";
  return job.result.outputs.map((output) => (
    job.kind === "image"
      ? `![generated image](${output.url})`
      : `[generated video](${output.url})`
  )).join("\n");
}

interface CompletionIdentity {
  id: string;
  created: number;
  model: string;
}

function completionIdentity(
  job: JobRecord,
  model: NormalizedModel
): CompletionIdentity {
  return {
    id: `chatcmpl-${job.id.slice(4)}`,
    created: Math.floor(Date.now() / 1000),
    model: model.id
  };
}

function completion(job: JobRecord, model: NormalizedModel): unknown {
  return {
    ...completionIdentity(job, model),
    object: "chat.completion",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: markdown(job)
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

function chunk(
  identity: CompletionIdentity,
  delta: { role?: "assistant"; content?: string },
  finishReason: "stop" | null = null
): unknown {
  return {
    ...identity,
    object: "chat.completion.chunk",
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason
    }]
  };
}

function timeoutError(): AppError {
  return new AppError(
    504,
    "server_error",
    "generation_timeout",
    "Generation timed out"
  );
}

function streamedError(cause: unknown): AppError {
  return cause instanceof AppError ? cause : errors.upstream();
}

async function waitForCompletion(
  handle: GenerationHandle,
  timeoutMs: number
): Promise<JobRecord> {
  const waited = await handle.wait(timeoutMs);
  if (!TERMINAL.has(waited.status)) throw timeoutError();
  if (waited.status === "failed") throwFailed(waited);
  if (waited.status !== "completed" || waited.result === null) {
    throw errors.upstream();
  }
  return waited;
}

function prepareStream(
  reply: FastifyReply
): { writer: SseWriter; abort: AbortController; remove(): void } {
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  const abort = new AbortController();
  const onClose = (): void => {
    abort.abort(new Error("SSE client disconnected"));
  };
  reply.raw.once("close", onClose);
  reply.hijack();
  reply.raw.flushHeaders();
  return {
    writer: new SseWriter(reply.raw),
    abort,
    remove: () => {
      reply.raw.removeListener("close", onClose);
    }
  };
}

async function streamCompletion(
  reply: FastifyReply,
  handle: GenerationHandle,
  model: NormalizedModel,
  timeoutMs: number
): Promise<void> {
  const stream = prepareStream(reply);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let nextProgressAt = startedAt + PROGRESS_INTERVAL_MS;
  let current = handle.job;
  const identity = completionIdentity(current, model);
  try {
    await stream.writer.event(chunk(identity, {
      role: "assistant"
    }));
    while (!TERMINAL.has(current.status)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      current = await handle.wait(
        Math.min(PROGRESS_INTERVAL_MS, remaining),
        stream.abort.signal
      );
      const now = Date.now();
      if (!TERMINAL.has(current.status) && now >= nextProgressAt) {
        await stream.writer.event({
          job_id: current.id,
          status: current.status,
          elapsed_seconds: Math.floor((now - startedAt) / 1000)
        }, "progress");
        nextProgressAt = now + PROGRESS_INTERVAL_MS;
      }
    }
    if (current.status === "failed") throwFailed(current);
    if (current.status !== "completed" || current.result === null) {
      throw errors.upstream();
    }
    await stream.writer.event(chunk(identity, {
      content: markdown(current)
    }));
    await stream.writer.event(chunk(identity, {}, "stop"));
    await stream.writer.done();
  } catch (cause) {
    if (stream.abort.signal.aborted) return;
    const error = streamedError(cause);
    await stream.writer.event(error.toBody(), "error");
    await stream.writer.done();
  } finally {
    stream.remove();
    if (!reply.raw.destroyed) reply.raw.end();
  }
}

export function registerChatRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  app.post("/v1/chat/completions", {
    schema: routeSchema({
      security: bearerSecurity,
      bodyContent: {
        "application/json": chatRequestSchema
      },
      response: {
        200: chatCompletionSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        409: errorResponseSchema,
        413: errorResponseSchema,
        429: errorResponseSchema,
        502: errorResponseSchema,
        503: errorResponseSchema,
        504: errorResponseSchema
      },
      responseContent: {
        200: {
          "application/json": chatCompletionSchema,
          "text/event-stream": z.string()
        }
      }
    })
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const input = chatRequestSchema.parse(request.body);
    const prompt = extractChatMediaPrompt(input.messages);
    const model = await resolveChatModel(
      dependencies,
      input.model,
      prompt.imageUrls.length > 0
    );
    const media: MediaInput[] = mediaFromStrings(prompt.imageUrls);
    validateMediaCount(model, media.length);
    const values = requestValues(input, prompt.prompt, model);
    const kind = model.sourceType === "image-generation"
      ? "image"
      : "video";
    requireScope(request, kind === "image" ? "image:create" : "video:create");
    if(kind==="video"){
      const principal=requestPrincipal(request);
      try{dependencies.plans.assertVideo(principal.projectId,{mode:model.sourceType as "text-to-video"|"image-to-video",model:input.model,...(typeof values["duration"]==="number"?{duration:values["duration"]}:{}),...(typeof values["resolution"]==="string"?{resolution:values["resolution"]}:{})});}
      catch(cause){throw errors.invalidRequest(cause instanceof Error?cause.message:"Plan policy rejected request");}
    }
    const handle = await dependencies.coordinator.create({
      principal: generationPrincipal(request),
      kind,
      sourceType: model.sourceType,
      model: model.apiId,
      values,
      media,
      idempotencyKey: idempotencyKey(request)
    });
    const timeoutMs = kind === "image"
      ? dependencies.config.imageWaitTimeoutMs
      : dependencies.config.videoWaitTimeoutMs;

    if (input.stream) {
      await streamCompletion(reply, handle, model, timeoutMs);
      return;
    }
    const waited = await waitForCompletion(handle, timeoutMs);
    return noStore(reply).send(completion(waited, model));
  });
}
