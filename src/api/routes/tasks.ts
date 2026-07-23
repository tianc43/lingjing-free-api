import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AppError } from "../../errors.js";
import { presentTask } from "../presenters.js";
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
  app.get("/v1/tasks/:id", async (request, reply) => {
    const params = taskParamsSchema.parse(request.params);
    const job = dependencies.repository.findById(params.id);
    if (job === null) throw taskNotFound();
    return noStore(reply).send(presentTask(job));
  });

  app.get("/v1/tasks", async (request, reply) => {
    const query = taskListQuerySchema.parse(request.query);
    const jobs = dependencies.repository.list({
      limit: query.limit,
      ...(query.status === undefined ? {} : { status: query.status })
    });
    return noStore(reply).send({
      object: "list",
      data: jobs.map(presentTask)
    });
  });
}
