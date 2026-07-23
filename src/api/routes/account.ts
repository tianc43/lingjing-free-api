import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AppError } from "../../errors.js";
import { presentAccount, presentPoints } from "../presenters.js";
import type { AppDependencies } from "../types.js";

const emptyBodySchema = z.object({}).strict();

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store");
}

function requireEmptyBody(body: unknown): void {
  emptyBodySchema.parse(body ?? {});
}

export function registerAccountRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies
): void {
  app.get("/v1/session", async (_request, reply) => {
    const session = dependencies.session.describe();
    const loggedIn = session.hasCsrf;
    return noStore(reply).send({
      mode: dependencies.session.mode,
      logged_in: loggedIn,
      login_required: !loggedIn
    });
  });

  app.get("/v1/account", async (_request, reply) => {
    const account = await dependencies.account.describe();
    return noStore(reply).send(presentAccount(account));
  });

  app.post("/token/check", async (request, reply) => {
    requireEmptyBody(request.body);
    try {
      await dependencies.account.describe();
      return await noStore(reply).send({ valid: true });
    } catch (cause) {
      if (
        cause instanceof AppError
        && (
          cause.code === "lingjing_session_expired"
          || cause.code === "lingjing_csrf_expired"
        )
      ) {
        return noStore(reply).send({ valid: false });
      }
      throw cause;
    }
  });

  app.post("/token/points", async (request, reply) => {
    requireEmptyBody(request.body);
    const account = await dependencies.account.describe();
    return noStore(reply).send(presentPoints(account));
  });
}
