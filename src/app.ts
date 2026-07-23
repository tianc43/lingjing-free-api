import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
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
import { registerModelRoutes } from "./api/routes/models.js";
import { registerSystemRoutes } from "./api/routes/system.js";
import { registerTaskRoutes } from "./api/routes/tasks.js";
import type { AppDependencies } from "./api/types.js";
import { AppError, errors } from "./errors.js";

export type { AppDependencies } from "./api/types.js";

const PUBLIC_PATHS = new Set(["/healthz", "/ping"]);

function pathname(request: FastifyRequest): string {
  return new URL(request.raw.url ?? "/", "http://localhost").pathname;
}

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
    logController: new LogController({ disableRequestLogging: true })
  });

  registerErrorHandler(app);
  app.setNotFoundHandler(() => {
    throw new AppError(
      404,
      "invalid_request_error",
      "route_not_found",
      "Route not found"
    );
  });
  app.addHook("onRequest", (request): Promise<void> => {
    if (PUBLIC_PATHS.has(pathname(request))) return Promise.resolve();
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

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: "1 minute",
    allowList: (request) => PUBLIC_PATHS.has(pathname(request)),
    keyGenerator: rateLimitKey,
    errorResponseBuilder: () => errors.rateLimited()
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
        },
        security: [{ bearerAuth: [] }]
      }
    });
    await app.register(swaggerUi, {
      routePrefix: "/docs"
    });
  }

  registerSystemRoutes(app, dependencies);
  registerAccountRoutes(app, dependencies);
  registerModelRoutes(app, dependencies);
  registerTaskRoutes(app, dependencies);

  if (dependencies.config.docsEnabled) {
    app.get("/openapi.json", () => app.swagger());
  }

  return app;
}
