import type { FastifyInstance } from "fastify";
import { errors } from "../../errors.js";
import type { MediaInput } from "../../media/types.js";
import { parseGenerationMultipart } from "../multipart.js";
import { taskResponseSchema } from "../presenters.js";
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
import type { AppDependencies } from "../types.js";
import {
  assertNoControlCollisions,
  disposeMedia,
  idempotencyKey,
  mediaFromStrings,
  noStore,
  pending,
  setIfSupported,
  throwFailed,
  validateDynamicValues,
  validateMediaCount,
  VIDEO_CONTROL_FIELDS,
  waitedJob
} from "./generation.js";

export function registerVideoRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  app.post("/v1/videos/generations", {
    schema: routeSchema({
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
    })
  }, async (request, reply) => {
    let media: MediaInput[] = [];
    let transferred = false;
    try {
      const requestIdempotencyKey = idempotencyKey(request);
      const multipart = request.isMultipart()
        ? await parseGenerationMultipart(request, dependencies)
        : null;
      media = multipart?.media ?? [];
      const input = videoApiRequestSchema.parse(
        multipart?.body ?? request.body
      );
      assertNoControlCollisions(input.parameters, VIDEO_CONTROL_FIELDS);
      media.push(...mediaFromStrings(input.input_images ?? []));
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
      setIfSupported(values, model, ["model"], model.alias);
      setIfSupported(values, model, ["duration"], input.duration);
      setIfSupported(values, model, ["resolution"], input.resolution);
      setIfSupported(values, model, ["ratio"], input.ratio);
      validateDynamicValues(model, values);

      transferred = true;
      const handle = await dependencies.coordinator.create({
        kind: "video",
        sourceType: input.mode,
        model: input.model,
        values,
        media,
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
  });
}
