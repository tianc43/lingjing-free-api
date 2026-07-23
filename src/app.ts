import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest
} from "fastify";
import { isAuthorized } from "./api/auth.js";
import { registerErrorHandler } from "./api/error-handler.js";
import { registerAccountRoutes } from "./api/routes/account.js";
import { registerChatRoutes } from "./api/routes/chat.js";
import { registerImageRoutes } from "./api/routes/images.js";
import { registerModelRoutes } from "./api/routes/models.js";
import { registerSystemRoutes } from "./api/routes/system.js";
import { registerTaskRoutes } from "./api/routes/tasks.js";
import { registerVideoRoutes } from "./api/routes/videos.js";
import {
  bearerSecurity,
  emptyQuerySchema,
  routeSchema
} from "./api/schema.js";
import type { AppDependencies } from "./api/types.js";
import { AppError, errors } from "./errors.js";
import { z } from "zod";

export type { AppDependencies } from "./api/types.js";

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return "";
  const match = /^Bearer ([^\s,]+)$/u.exec(authorization);
  return match?.[1] ?? "";
}

function rateLimitKey(request: FastifyRequest): string {
  return createHash("sha256")
    .update(bearerToken(request), "utf8")
    .digest("hex");
}

export async function buildApp(
  dependencies: AppDependencies
): Promise<FastifyInstance> {
  const loggerInstance: FastifyBaseLogger = dependencies.logger;
  const app: FastifyInstance = Fastify({
    loggerInstance,
    trustProxy: false,
    bodyLimit: dependencies.config.jsonBodyLimitBytes,
    ajv: {
      customOptions: {
        removeAdditional: false
      }
    },
    logController: new LogController({ disableRequestLogging: true })
  });

  registerErrorHandler(app);
  app.setNotFoundHandler((request) => {
    if (
      !isAuthorized(
        request.headers.authorization,
        dependencies.config.apiKey
      )
    ) {
      throw errors.authentication();
    }
    throw new AppError(
      404,
      "invalid_request_error",
      "route_not_found",
      "Route not found"
    );
  });
  if (dependencies.config.docsEnabled) {
    await app.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "Lingjing Free API",
          version: "0.1.0"
        },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer"
            }
          }
        }
      }
    });
  }

  registerSystemRoutes(app, dependencies);
  await app.register(async function protectedApi(protectedApp) {
    protectedApp.addHook("onRequest", (request): Promise<void> => {
      if (
        !isAuthorized(
          request.headers.authorization,
          dependencies.config.apiKey
        )
      ) {
        return Promise.reject(errors.authentication());
      }
      return Promise.resolve();
    });

    await protectedApp.register(rateLimit, {
      global: true,
      max: 100,
      timeWindow: "1 minute",
      keyGenerator: rateLimitKey,
      errorResponseBuilder: () => errors.rateLimited()
    });
    await protectedApp.register(multipart, {
      limits: {
        files: 14,
        fields: 50,
        parts: 64,
        fileSize: dependencies.config.maxImageBytes
      }
    });

    if (dependencies.config.docsEnabled) {
      await protectedApp.register(swaggerUi, {
        routePrefix: "/docs"
      });
    }

    registerAccountRoutes(protectedApp, dependencies);
    registerChatRoutes(protectedApp, dependencies);
    registerImageRoutes(protectedApp, dependencies);
    registerModelRoutes(protectedApp, dependencies);
    registerTaskRoutes(protectedApp, dependencies);
    registerVideoRoutes(protectedApp, dependencies);

    if (dependencies.config.docsEnabled) {
      protectedApp.get("/openapi.json", {
        schema: routeSchema({
          security: bearerSecurity,
          querystring: emptyQuerySchema,
          response: {
            200: z.record(z.string(), z.unknown())
          }
        })
      }, () => app.swagger());
    }
  });

  return app;
}
