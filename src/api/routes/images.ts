import type { FastifyInstance } from "fastify";
import { errors } from "../../errors.js";
import type { JobRecord } from "../../jobs/types.js";
import type { MediaInput } from "../../media/types.js";
import { parseGenerationMultipart } from "../multipart.js";
import {
  generationHeadersSchema,
  imageApiRequestSchema,
  imageGenerationResponseSchema,
  imageMultipartRequestSchema
} from "../schemas/generation.js";
import {
  bearerSecurity,
  errorResponseSchema,
  routeSchema
} from "../schema.js";
import { taskResponseSchema } from "../presenters.js";
import {
  generationPrincipal,
  requireScope
} from "../principal.js";
import type { AppDependencies } from "../types.js";
import {
  assertNoControlCollisions,
  disposeMedia,
  idempotencyKey,
  IMAGE_CONTROL_FIELDS,
  mediaFromStrings,
  noStore,
  pending,
  readBoundedBase64,
  safeOutputUrl,
  setIfSupported,
  throwFailed,
  validateDynamicValues,
  validateMediaCount,
  waitedJob
} from "./generation.js";

function responseCreated(job: JobRecord): number {
  return Math.floor(job.createdAt / 1000);
}

export function registerImageRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  app.post("/v1/images/generations", {
    schema: routeSchema({
      security: bearerSecurity,
      headers: generationHeadersSchema,
      bodyContent: {
        "application/json": imageApiRequestSchema
      },
      multipartBody: imageMultipartRequestSchema,
      response: {
        200: imageGenerationResponseSchema,
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
      const input = imageApiRequestSchema.parse(
        multipart?.body ?? request.body
      );
      assertNoControlCollisions(input.parameters, IMAGE_CONTROL_FIELDS);
      media.push(...mediaFromStrings(input.input_images ?? []));

      const model = await dependencies.catalog.resolve(
        input.model,
        "image-generation",
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
      setIfSupported(values, model, ["size"], input.size);
      setIfSupported(values, model, ["n", "taskNum", "count"], input.n);
      validateDynamicValues(model, values);

      transferred = true;
      requireScope(request, "image:create");
      const handle = await dependencies.coordinator.create({
        principal: generationPrincipal(request),
        kind: "image",
        sourceType: "image-generation",
        model: input.model,
        values,
        media,
        idempotencyKey: requestIdempotencyKey
      });
      const waited = await waitedJob(
        handle,
        input.response_mode,
        dependencies.config.imageWaitTimeoutMs
      );
      if (waited === null) return await pending(reply, handle.job);
      if (waited.status === "failed") throwFailed(waited);
      if (waited.status !== "completed" || waited.result === null) {
        return await pending(reply, waited);
      }

      if (input.response_format === "url") {
        return await noStore(reply).send({
          created: responseCreated(waited),
          job_id: waited.id,
          data: waited.result.outputs.map((output) => ({ url: output.url }))
        });
      }

      const data: Array<{ b64_json: string }> = [];
      for (const output of waited.result.outputs) {
        const url = await safeOutputUrl(output.url);
        const fetched = await dependencies.media.fetchOutput(url, {
          kind: "image",
          maxBytes: dependencies.config.maxImageBytes
        });
        data.push({
          b64_json: await readBoundedBase64(
            fetched,
            dependencies.config.maxImageBytes
          )
        });
      }
      return await noStore(reply).send({
        created: responseCreated(waited),
        job_id: waited.id,
        data
      });
    } finally {
      if (!transferred) await disposeMedia(media);
    }
  });
}
