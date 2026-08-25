import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SourceType } from "../../models/types.js";
import { modelResponseSchema, presentModel } from "../presenters.js";
import {
  bearerSecurity,
  errorResponseSchema,
  routeSchema
} from "../schema.js";
import { requireScope } from "../principal.js";
import type { AppDependencies } from "../types.js";

export const modelQuerySchema = z.object({
  type: z.enum(["image", "video"]).optional(),
  mode: z.enum(["text-to-video", "image-to-video"]).optional(),
  refresh: z.enum(["true", "false"]).optional().transform(
    (value) => value === "true"
  )
}).superRefine((query, context) => {
  if (query.type !== "video" && query.mode !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: "Image models do not accept a video mode"
    });
  }
});
const modelListResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(modelResponseSchema)
});

function sourceTypes(query: z.infer<typeof modelQuerySchema>): SourceType[] {
  if (query.type === undefined) {
    return ["image-generation", "text-to-video", "image-to-video"];
  }
  if (query.type === "image") return ["image-generation"];
  if (query.mode !== undefined) return [query.mode];
  return ["text-to-video", "image-to-video"];
}

export function registerModelRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  app.get("/v1/models", {
    schema: routeSchema({
      security: bearerSecurity,
      querystring: modelQuerySchema,
      response: {
        200: modelListResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        502: errorResponseSchema
      }
    })
  }, async (request) => {
    requireScope(request, "models:read");
    const query = modelQuerySchema.parse(request.query);
    const sources = sourceTypes(query);
    const groups = await Promise.all(
      sources.map((sourceType) =>
        dependencies.catalog.list(sourceType, query.refresh)
      )
    );
    return {
      object: "list",
      data: groups.flat().map(presentModel)
    };
  });
}
