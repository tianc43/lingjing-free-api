import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { AppError } from "../../errors.js";
import {
  accountResponseSchema,
  presentAccount,
  presentPoints
} from "../presenters.js";
import {
  bearerSecurity,
  emptyQuerySchema,
  errorResponseSchema,
  routeSchema
} from "../schema.js";
import type { AppDependencies } from "../types.js";

const emptyBodySchema = z.object({}).strict();
const optionalRequestBodySchema = z.union([
  emptyBodySchema,
  z.undefined()
]);
const sessionResponseSchema = z.object({
  mode: z.enum(["browser-state", "cookie-file"]),
  logged_in: z.boolean(),
  login_required: z.boolean()
});
const tokenCheckResponseSchema = z.object({ valid: z.boolean() });
const pointsResponseSchema = accountResponseSchema.omit({
  object: true,
  subject: true,
  membership: true,
  max_concurrency: true
});

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
  app.get("/v1/session", {
    schema: routeSchema({
      security: bearerSecurity,
      querystring: emptyQuerySchema,
      response: {
        200: sessionResponseSchema,
        401: errorResponseSchema
      }
    })
  }, async (_request, reply) => {
    const session = dependencies.session.describe();
    const loggedIn = session.hasCsrf;
    return noStore(reply).send({
      mode: dependencies.session.mode,
      logged_in: loggedIn,
      login_required: !loggedIn
    });
  });

  app.get("/v1/account", {
    schema: routeSchema({
      security: bearerSecurity,
      querystring: emptyQuerySchema,
      response: {
        200: accountResponseSchema,
        401: errorResponseSchema,
        502: errorResponseSchema
      }
    })
  }, async (_request, reply) => {
    const account = await dependencies.account.describe();
    return noStore(reply).send(presentAccount(account));
  });

  app.post("/token/check", {
    schema: routeSchema({
      security: bearerSecurity,
      body: optionalRequestBodySchema,
      querystring: emptyQuerySchema,
      response: {
        200: tokenCheckResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        502: errorResponseSchema
      }
    })
  }, async (request, reply) => {
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

  app.post("/token/points", {
    schema: routeSchema({
      security: bearerSecurity,
      body: optionalRequestBodySchema,
      querystring: emptyQuerySchema,
      response: {
        200: pointsResponseSchema,
        400: errorResponseSchema,
        401: errorResponseSchema,
        502: errorResponseSchema
      }
    })
  }, async (request, reply) => {
    requireEmptyBody(request.body);
    const account = await dependencies.account.describe();
    return noStore(reply).send(presentPoints(account));
  });
}
