import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SqliteCallLogRepository } from "./repository.js";

const querySchema = z.object({
  direction: z.enum(["inbound", "outbound"]).optional(), status: z.enum(["pending", "success", "error"]).optional(),
  search: z.string().max(200).optional(), page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25)
}).strict();

// Must be registered inside the existing authenticated admin scope.
export function registerCallLogRoutes(app: FastifyInstance, repository?: SqliteCallLogRepository): void {
  const requireRepository = () => {
    if (!repository) throw new AppError(503, "server_error", "call_logs_unavailable", "API call logging is available on the SQLite runtime only");
    return repository;
  };
  app.get("/call-logs", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) throw new AppError(400, "invalid_request_error", "invalid_call_log_filter", "Invalid API call log filter");
    return requireRepository().list(parsed.data);
  });
  app.get<{ Params: { id: string } }>("/call-logs/:id", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const found = requireRepository().find(request.params.id);
    if (!found) throw new AppError(404, "invalid_request_error", "call_log_not_found", "API call record not found");
    return found;
  });
}
