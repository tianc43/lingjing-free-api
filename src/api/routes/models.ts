import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SourceType } from "../../models/types.js";
import { presentModel } from "../presenters.js";
import type { AppDependencies } from "../types.js";

const modelQuerySchema = z.object({
  type: z.enum(["image", "video"]),
  mode: z.enum(["text-to-video", "image-to-video"]).optional(),
  refresh: z.enum(["true", "false"]).optional().transform(
    (value) => value === "true"
  )
}).superRefine((query, context) => {
  if (query.type === "image" && query.mode !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: "Image models do not accept a video mode"
    });
  }
});

function sourceTypes(query: z.infer<typeof modelQuerySchema>): SourceType[] {
  if (query.type === "image") return ["image-generation"];
  if (query.mode !== undefined) return [query.mode];
  return ["text-to-video", "image-to-video"];
}

export function registerModelRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  app.get("/v1/models", async (request) => {
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
