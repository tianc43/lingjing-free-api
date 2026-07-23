import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { GenerationCoordinator } from "../generation/types.js";
import type { CapacityManager } from "../jobs/capacity.js";
import type { SqliteJobRepository } from "../jobs/sqlite-repository.js";
import type { JobOutput, JobStatus } from "../jobs/types.js";
import type { AccountService } from "../lingjing/account.js";
import type { LingjingTransport } from "../lingjing/types.js";
import type { CatalogService } from "../models/catalog.js";
import type { SessionProvider } from "../session/types.js";
import type {
  PreparedMedia,
  TempBudget
} from "../media/types.js";

export interface RecoveryService {
  readonly ready: boolean;
}

export interface ModelCatalog
extends Pick<CatalogService, "resolve"> {
  list(
    sourceType: Parameters<CatalogService["list"]>[0],
    refresh?: boolean
  ): ReturnType<CatalogService["list"]>;
}

export type JobRepository = Pick<
  SqliteJobRepository,
  "findById" | "list"
>;

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  session: SessionProvider;
  transport: LingjingTransport;
  account: Pick<AccountService, "describe">;
  catalog: ModelCatalog;
  repository: JobRepository;
  coordinator: GenerationCoordinator;
  capacity: Pick<CapacityManager, "counts">;
  recovery: RecoveryService;
  media: {
    createRequestBudget(): TempBudget;
    prepareStream(
      stream: NodeJS.ReadableStream,
      options: {
        filename: string;
        contentType: string;
        maxBytes: number;
        requestBudget: TempBudget;
      }
    ): Promise<PreparedMedia>;
    fetchOutput(
      url: URL,
      options: { kind: "image"; maxBytes: number }
    ): Promise<PreparedMedia>;
  };
}

export interface TaskResponse {
  id: string;
  object: "lingjing.task";
  kind: "image" | "video";
  model: string;
  status: JobStatus;
  created_at: number;
  updated_at: number;
  error: { code: string } | null;
  outputs: JobOutput[];
}
