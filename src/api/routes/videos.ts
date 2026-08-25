import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import { AppError, errors } from "../../errors.js";
import { z } from "zod";
import { presentTask, taskResponseSchema } from "../presenters.js";
import type { MediaInput } from "../../media/types.js";
import { parseGenerationMultipart } from "../multipart.js";
import {
  generationHeadersSchema,
  videoApiRequestSchema,
  videoGenerationResponseSchema,
  videoMultipartRequestSchema
} from "../schemas/generation.js";
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
import type { AppDependencies } from "../types.js";
import {
  assertNoControlCollisions,
  disposeMedia,
  idempotencyKey,
  mediaFromStrings,
  noStore,
  pending,
  setIfSupported,
  setModelIfSupported,
  throwFailed,
  validateDynamicValues,
  validateMediaCount,
  VIDEO_ALWAYS_RESERVED_FIELDS,
  waitedJob
} from "./generation.js";

const VIDEO_DYNAMIC_CONTROL_FIELDS = ["mode", "duration"] as const;

export function registerVideoRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  const schema = routeSchema({
    security: bearerSecurity,
    headers: generationHeadersSchema,
    bodyContent: {
      "application/json": videoApiRequestSchema
    },
    multipartBody: videoMultipartRequestSchema,
    response: {
      200: videoGenerationResponseSchema,
      202: taskResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      409: errorResponseSchema,
      413: errorResponseSchema,
      429: errorResponseSchema,
      502: errorResponseSchema,
      503: errorResponseSchema
    }
  });
  const handler = (defaultMode: "wait" | "async") => async (request: FastifyRequest, reply: FastifyReply) => {
    let media: MediaInput[] = [];
    let transferred = false;
    try {
      const requestIdempotencyKey = idempotencyKey(request);
      const multipart = request.isMultipart()
        ? await parseGenerationMultipart(request, dependencies)
        : null;
      media = multipart?.media ?? [];
      const rawBody = multipart?.body ?? request.body;
      const input = videoApiRequestSchema.parse(
        typeof rawBody === "object" && rawBody !== null && !("response_mode" in rawBody)
          ? { ...rawBody, response_mode: defaultMode }
          : rawBody
      );
      assertNoControlCollisions(
        input.parameters,
        VIDEO_ALWAYS_RESERVED_FIELDS
      );
      media.push(...mediaFromStrings(input.input_images ?? []));
      const principal=requestPrincipal(request);
      const persistentAssets=[];
      for(const id of input.input_asset_ids??[]){const asset=dependencies.assets?.findById(id);if(!asset||asset.projectId!==principal.projectId||asset.role!=="input"||asset.jobId!==null)throw errors.invalidRequest("Input asset is unavailable","input_asset_ids");const prepared=await dependencies.assets?.prepared(asset);if(prepared===undefined)throw errors.invalidRequest("Input asset is unavailable","input_asset_ids");persistentAssets.push(asset);media.push({kind:"image",source:{type:"prepared",media:prepared}});}
      if (input.mode === "image-to-video" && media.length === 0) {
        throw errors.invalidRequest(
          "image-to-video requires an input image",
          "input_images"
        );
      }

      const model = await dependencies.catalog.resolve(
        input.model,
        input.mode,
        true
      );
      for (const field of VIDEO_DYNAMIC_CONTROL_FIELDS) {
        if (
          !model.parameters.some(
            (parameter) =>
              parameter.kind !== "image-list"
              && parameter.key === field
          )
        ) {
          assertNoControlCollisions(
            input.parameters,
            new Set([field])
          );
        }
      }
      if (
        input.duration !== undefined
        && Object.hasOwn(input.parameters ?? {}, "duration")
      ) {
        throw errors.invalidRequest(
          "duration cannot be provided both as a control field and a model parameter",
          "duration"
        );
      }
      const imageParameter = model.parameters.find(
        (parameter) => parameter.kind === "image-list"
      );
      if (
        imageParameter !== undefined
        && Object.hasOwn(input.parameters ?? {}, imageParameter.key)
      ) {
        throw errors.invalidRequest(
          "parameters cannot override input media",
          `parameters.${imageParameter.key}`
        );
      }
      validateMediaCount(model, media.length);

      const values: Record<string, unknown> = {
        ...(input.parameters ?? {})
      };
      setIfSupported(values, model, ["prompt"], input.prompt);
      setModelIfSupported(values, model);
      setIfSupported(values, model, ["duration"], input.duration);
      setIfSupported(values, model, ["resolution"], input.resolution);
      setIfSupported(values, model, ["ratio"], input.ratio);
      validateDynamicValues(model, values);

      transferred = true;
      requireScope(request, "video:create");
      try {
        const parameterDuration = input.parameters?.["duration"];
        const parameterResolution = input.parameters?.["resolution"];
        dependencies.plans.assertVideo(principal.projectId, {
          mode: input.mode,
          model: input.model,
          ...(input.duration !== undefined
            ? { duration: input.duration }
            : typeof parameterDuration === "number" ? { duration: parameterDuration } : {}),
          ...(input.resolution !== undefined
            ? { resolution: input.resolution }
            : typeof parameterResolution === "string" ? { resolution: parameterResolution } : {})
        });
      } catch (cause) {
        throw errors.invalidRequest(cause instanceof Error ? cause.message : "Plan policy rejected request");
      }
      const handle = await dependencies.coordinator.create({
        principal: generationPrincipal(request),
        kind: "video",
        sourceType: input.mode,
        model: input.model,
        values,
        media,
        ...(persistentAssets.length===0?{}:{persistentAssetIds:persistentAssets.map(asset=>asset.id)}),
        idempotencyKey: requestIdempotencyKey
      });
      const waited = await waitedJob(
        handle,
        input.response_mode,
        dependencies.config.videoWaitTimeoutMs
      );
      if (waited === null) return await pending(reply, handle.job);
      if (waited.status === "failed") throwFailed(waited);
      if (waited.status !== "completed" || waited.result === null) {
        return await pending(reply, waited);
      }
      return await noStore(reply).send({
        created: Math.floor(waited.createdAt / 1000),
        job_id: waited.id,
        data: waited.result.outputs.map((output) => ({
          url: output.url,
          poster_url: output.posterUrl,
          width: output.width,
          height: output.height,
          duration: output.duration,
          format: output.format
        }))
      });
    } finally {
      if (!transferred) await disposeMedia(media);
    }
  };

  const paramsSchema=z.object({id:z.string().min(1)});
  const listSchema=z.object({limit:z.coerce.number().int().min(1).max(100).default(20),before:z.coerce.number().optional(),status:z.enum(["queued","submitting","discovering","processing","unknown","completed","failed"]).optional()});
  app.get("/v1/videos/:id",{schema:routeSchema({security:bearerSecurity,params:paramsSchema,response:{200:taskResponseSchema,401:errorResponseSchema,404:errorResponseSchema}})},(request,reply)=>{const principal=requireScope(request,"video:read");const {id}=paramsSchema.parse(request.params);const job=dependencies.repository.findById(id);if(!job||job.projectId!==principal.projectId||job.kind!=="video")throw new AppError(404,"invalid_request_error","video_not_found","Video job not found");return noStore(reply).send(presentTask(job));});
  app.get("/v1/videos",{schema:routeSchema({security:bearerSecurity,querystring:listSchema,response:{200:z.object({object:z.literal("list"),data:z.array(taskResponseSchema),next_cursor:z.number().nullable()}),401:errorResponseSchema}})},(request,reply)=>{const principal=requireScope(request,"video:read");const q=listSchema.parse(request.query);const jobs=dependencies.repository.list({projectId:principal.projectId,kind:"video",limit:q.limit,...(q.before===undefined?{}:{before:q.before}),...(q.status===undefined?{}:{status:q.status})});return noStore(reply).send({object:"list",data:jobs.map(presentTask),next_cursor:jobs.length===q.limit?jobs.at(-1)?.createdAt??null:null});});
  app.post("/v1/videos/:id/cancel",{schema:routeSchema({security:bearerSecurity,params:paramsSchema,response:{200:taskResponseSchema,401:errorResponseSchema,404:errorResponseSchema,409:errorResponseSchema}})},(request,reply)=>{const principal=requireScope(request,"video:create");const {id}=paramsSchema.parse(request.params);try{const job=dependencies.repository.cancelQueued(id,principal.projectId);if(!job||job.kind!=="video")throw new AppError(404,"invalid_request_error","video_not_found","Video job not found");return noStore(reply).send(presentTask(job));}catch(cause){if(cause instanceof AppError)throw cause;throw new AppError(409,"invalid_request_error","video_not_cancellable","Video can only be cancelled before upstream submission");}});

  app.post("/v1/videos/generations", { schema }, handler("wait"));
  app.post("/v1/videos", { schema }, handler("async"));
}
