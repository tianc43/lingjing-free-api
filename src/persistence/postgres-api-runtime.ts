import Fastify, { type FastifyInstance } from "fastify";
import { registerPostgresAdminRoutes } from "../admin/postgres-routes.js";
import { registerAdminStatic } from "../admin/static.js";
import { postgresBearerAuth } from "../api/postgres-auth.js";
import { registerErrorHandler } from "../api/error-handler.js";
import { requestPrincipal } from "../api/principal.js";
import { registerPostgresAssetRoutes } from "../api/routes/postgres-assets.js";
import { registerPostgresUploadRoutes } from "../api/routes/postgres-uploads.js";
import { registerPostgresVideoRoutes } from "../api/routes/postgres-videos.js";
import type { OptionalRedisCoordinator } from "../coordination/redis-coordinator.js";
import type { SignInStatusReader } from "../accounts/sign-in-repositories.js";
import type { VideoQuoteInput, VideoQuoteResult } from "../lingjing/postgres-quote-resolver.js";
import type { ObjectStore } from "../media/object-store.js";
import {
  PostgresModelCatalog,
  type PostgresVideoModel
} from "../models/postgres-model-catalog.js";
import type { PostgresRepositoryGraph } from "./postgres-repository-graph.js";

type QuotePort = { quote(input: VideoQuoteInput): Promise<VideoQuoteResult> };

export async function createPostgresApiRuntime(
  graph: PostgresRepositoryGraph,
  objects?: ObjectStore,
  models: readonly PostgresVideoModel[] = [{
    id: "m",
    apiId: "m",
    sceneCode: "t2v",
    modelCode: "",
    spaceId: 0,
    uploadStrategy: "general",
    modes: ["text-to-video", "image-to-video"]
  }],
  adminPassword?: string,
  redis?: OptionalRedisCoordinator,
  runtimeRefresher?: {
    refresh(accountId: string): Promise<import("../accounts/runtime.js").AccountRuntime | null>;
  },
  dataDirectory?: string,
  quote?: QuotePort,
  dailySignInStatus?: SignInStatusReader
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  if (adminPassword !== undefined) {
    registerPostgresAdminRoutes(
      app,
      graph,
      adminPassword,
      models,
      objects,
      runtimeRefresher,
      dataDirectory,
      quote,
      dailySignInStatus
    );
  }
  await registerAdminStatic(app, adminPassword !== undefined);
  app.get("/healthz", async () => {
    await graph.runtime.pool.query("SELECT 1");
    return {
      status: "ok",
      database: "postgres",
      schema_version: graph.runtime.schemaVersion
    };
  });
  app.register((protectedApp) => {
    protectedApp.addHook("onRequest", postgresBearerAuth(graph.identities));
    registerPostgresVideoRoutes(
      protectedApp,
      graph,
      new PostgresModelCatalog(models),
      quote,
      redis
    );
    if (objects !== undefined) {
      registerPostgresAssetRoutes(protectedApp, graph, objects);
      registerPostgresUploadRoutes(protectedApp, graph, objects);
    }
    protectedApp.get("/v1/principal", (request) => {
      const principal = requestPrincipal(request);
      return {
        user_id: principal.userId,
        project_id: principal.projectId,
        api_key_id: principal.apiKeyId,
        scopes: [...principal.scopes].sort()
      };
    });
  });
  await app.ready();
  return app;
}
