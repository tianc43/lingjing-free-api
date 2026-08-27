import type { FastifyInstance } from "fastify";
import type { SignInStatusReader } from "../accounts/sign-in-repositories.js";
import type { OptionalRedisCoordinator } from "../coordination/redis-coordinator.js";
import { PostgresArchiveWorker } from "../jobs/postgres-archive-worker.js";
import { PostgresReconciliationWorker } from "../jobs/postgres-reconciliation-worker.js";
import { PostgresWorkerOrchestrator } from "../jobs/postgres-worker-orchestrator.js";
import { createPostgresProtocolWorkers } from "../lingjing/postgres-protocol-worker-factory.js";
import type { VideoQuoteInput, VideoQuoteResult } from "../lingjing/postgres-quote-resolver.js";
import type { RuntimeLookup } from "../lingjing/postgres-account-transport-resolver.js";
import type { ObjectStore } from "../media/object-store.js";
import type { PreparedMedia } from "../media/types.js";
import type { PostgresVideoModel } from "../models/postgres-model-catalog.js";
import {
  PostgresWebhookDeliveryWorker,
  type WebhookSendPort
} from "../webhooks/postgres-delivery-worker.js";
import { createPostgresApiRuntime } from "./postgres-api-runtime.js";
import type { PostgresRepositoryGraph } from "./postgres-repository-graph.js";

export async function createPostgresServerRuntime(input: {
  graph: PostgresRepositoryGraph;
  objects: ObjectStore;
  runtimes: RuntimeLookup;
  workerId: string;
  fetchOutput(url: URL): Promise<PreparedMedia>;
  webhookTransport: WebhookSendPort;
  retentionMs: number;
  models?: readonly PostgresVideoModel[];
  adminPassword?: string | null;
  dataDirectory?: string;
  runtimeRefresher?: {
    refresh(accountId: string): Promise<import("../accounts/runtime.js").AccountRuntime | null>;
  };
  quote?: { quote(input: VideoQuoteInput): Promise<VideoQuoteResult> };
  dailySignInStatus?: SignInStatusReader;
  redis?: OptionalRedisCoordinator;
}): Promise<{
  app: FastifyInstance;
  workers: PostgresWorkerOrchestrator;
  start(): void;
  close(): Promise<void>;
}> {
  const protocol = createPostgresProtocolWorkers(input);
  const app = await createPostgresApiRuntime(
    input.graph,
    input.objects,
    input.models,
    input.adminPassword ?? undefined,
    input.redis,
    input.runtimeRefresher,
    input.dataDirectory,
    input.quote,
    input.dailySignInStatus
  );
  const reconcile = new PostgresReconciliationWorker(
    input.graph,
    protocol.poller,
    `${input.workerId}-reconcile`
  );
  const archive = new PostgresArchiveWorker(
    input.graph,
    input.objects,
    (url) => input.fetchOutput(url),
    `${input.workerId}-archive`,
    input.retentionMs
  );
  const webhooks = new PostgresWebhookDeliveryWorker(
    input.graph.webhooks,
    input.webhookTransport,
    `${input.workerId}-webhook`
  );
  const workers = new PostgresWorkerOrchestrator(input.graph, {
    ...protocol,
    reconcile,
    archive,
    webhooks
  });
  let closed = false;
  let subscription: Awaited<ReturnType<NonNullable<typeof input.redis>["subscribeJobs"]>> | null = null;
  return {
    app,
    workers,
    start: () => {
      workers.start();
      if (input.redis !== undefined) {
        void input.redis.subscribeJobs(() => void workers.tick()).then(
          (value) => { subscription = value; }
        );
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await subscription?.close();
      await workers.close();
      await app.close();
      await input.graph.close();
    }
  };
}
