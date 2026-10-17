import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { callContext, type CallContext } from "./context.js";
import type { SqliteCallLogRepository } from "./repository.js";

export function registerCallLogHooks(app: FastifyInstance, repository: SqliteCallLogRepository): void {
  const requests = new WeakMap<FastifyRequest, { id: string | null; context: CallContext; output?: unknown; error?: unknown; finished?: boolean }>();
  const finish = (request: FastifyRequest, reply: FastifyReply, forcedError?: unknown) => {
    const entry = requests.get(request);
    if (!entry || entry.finished) return;
    entry.finished = true;
    const error = forcedError ?? entry.context.stream?.error ?? entry.error;
    repository.finish(entry.id, { statusCode: reply.statusCode, body: entry.context.stream ?? entry.output, headers: reply.raw.getHeaders(), requestBody: { query: request.query, body: request.body }, jobId: entry.context.jobId, ...(error === undefined ? {} : { error }) });
  };
  app.addHook("onRequest", (request, reply, done) => {
    const path = request.url.split("?", 1)[0] ?? "";
    if (path === "/admin" || path.startsWith("/admin/") || path === "/healthz" || path.startsWith("/assets/")) { done(); return; }
    const context: CallContext = { traceId: randomUUID(), parentId: null, jobId: null };
    reply.header("x-request-id", context.traceId);
    reply.raw.setHeader("x-request-id", context.traceId);
    callContext.run(context, () => {
      const id = repository.start({ direction: "inbound", method: request.method, path: request.url, headers: request.headers });
      context.parentId = id;
      requests.set(request, { id, context });
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) finish(request, reply, new AppError(499, "server_error", "client_disconnected", "Client disconnected before the response completed"));
      });
      done();
    });
  });
  app.addHook("onError", async (request, _reply, error) => { const entry = requests.get(request); if (entry) entry.error = error; });
  app.addHook("onSend", async (request, _reply, payload) => { const entry = requests.get(request); if (entry) entry.output = payload; return payload; });
  app.addHook("onResponse", async (request, reply) => {
    finish(request, reply);
  });
}
