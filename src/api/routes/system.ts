import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../types.js";

export function registerSystemRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  app.get("/healthz", async (_request, reply) => {
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

  app.get("/ping", () => ({ message: "pong" }));
}
