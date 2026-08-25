import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AppError } from "../../errors.js";
import { presentTask, taskResponseSchema } from "../presenters.js";
import {
  bearerSecurity,
  errorResponseSchema,
  routeSchema
} from "../schema.js";
import {
  requestPrincipal,
  requireScope
} from "../principal.js";
import type { AppDependencies } from "../types.js";

const taskParamsSchema = z.object({
  id: z.string().min(1)
});

const taskListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum([
    "queued",
    "submitting",
    "discovering",
    "processing",
    "unknown",
    "completed",
    "failed"
  ]).optional()
});
const taskListResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(taskResponseSchema)
});

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store");
}

function taskNotFound(): AppError {
  return new AppError(
    404,
    "invalid_request_error",
    "task_not_found",
    "Task not found",
    "id"
  );
}

export function registerTaskRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  app.get("/v1/tasks/:id", {
    schema: routeSchema({
      security: bearerSecurity,
      params: taskParamsSchema,
      response: {
        200: taskResponseSchema,
        401: errorResponseSchema,
        404: errorResponseSchema
      }
    })
  }, async (request, reply) => {
    const params = taskParamsSchema.parse(request.params);
    const principal = requestPrincipal(request);
    const job = dependencies.repository.findById(params.id);
    if (job === null || job.projectId !== principal.projectId) throw taskNotFound();
    requireScope(request, job.kind === "video" ? "video:read" : "image:read");
    return noStore(reply).send(presentTask(job));
  });

  app.get("/v1/tasks", {
    schema: routeSchema({
      security: bearerSecurity,
      querystring: taskListQuerySchema,
      response: {
        200: taskListResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema
      }
    })
  }, async (request, reply) => {
    const query = taskListQuerySchema.parse(request.query);
    const principal = requestPrincipal(request);
    const canReadVideo = principal.scopes.includes("video:read");
    const canReadImage = principal.scopes.includes("image:read");
    if (!canReadVideo && !canReadImage) requireScope(request, "video:read");
    const jobs = dependencies.repository.list({
      projectId: principal.projectId,
      limit: query.limit,
      ...(query.status === undefined ? {} : { status: query.status })
    });
    return noStore(reply).send({
      object: "list",
      data: jobs.filter((job) => (
        job.kind === "video" ? canReadVideo : canReadImage
      )).map(presentTask)
    });
  });
}
