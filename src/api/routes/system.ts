import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  emptyQuerySchema,
  publicSecurity,
  routeSchema
} from "../schema.js";
import type { AppDependencies } from "../types.js";

const healthResponseSchema = z.object({
  status: z.enum(["ok", "starting"]),
  database: z.literal("ok"),
  queue: z.object({
    active: z.number(),
    waiting: z.number(),
    limit: z.number()
  })
});

const pingResponseSchema = z.object({
  message: z.literal("pong")
});

export function registerSystemRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  app.get("/healthz", {
    schema: routeSchema({
      security: publicSecurity,
      querystring: emptyQuerySchema,
      response: {
        200: healthResponseSchema,
        503: healthResponseSchema
      }
    })
  }, async (_request, reply) => {
    const counts = dependencies.capacity.counts();
    const ready = dependencies.recovery.ready;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "starting",
      database: "ok",
      queue: {
        active: counts.active,
        waiting: counts.admitted,
        limit: dependencies.config.maxConcurrency
      }
    });
  });

  app.get("/ping", {
    schema: routeSchema({
      security: publicSecurity,
      querystring: emptyQuerySchema,
      response: { 200: pingResponseSchema }
    })
  }, () => ({ message: "pong" }));
}
