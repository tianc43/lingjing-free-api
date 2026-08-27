import type { Logger } from "pino";
import type { CookieImportService } from "../accounts/cookie-import-service.js";
import type { SignInStatusReader } from "../accounts/sign-in-repositories.js";
import type { SqliteAccountRepository } from "../accounts/sqlite-account-repository.js";
import type {
  SqliteAdmissionRepository
} from "../accounts/sqlite-admission-repository.js";
import type { AccountRecord } from "../accounts/types.js";
import type { AppConfig } from "../config.js";
import type { SqliteApiKeyRepository } from "../api-keys/sqlite-api-key-repository.js";
import type { GenerationCoordinator } from "../generation/types.js";
import type { CapacityManager } from "../jobs/capacity.js";
import type { SqliteJobRepository } from "../jobs/sqlite-repository.js";
import type { SqliteIdentityRepository } from "../identity/sqlite-identity-repository.js";
import type { JobOutput, JobStatus } from "../jobs/types.js";
import type { AccountService } from "../lingjing/account.js";
import type { LingjingTransport } from "../lingjing/types.js";
import type { CatalogService } from "../models/catalog.js";
import type { SessionProvider } from "../session/types.js";
import type { SqliteUsageRepository } from "../usage/sqlite-usage-repository.js";
import type { SqliteWebhookRepository } from "../webhooks/sqlite-webhook-repository.js";
import type { SqlitePlanRepository } from "../plans/sqlite-plan-repository.js";
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
  "findById" | "list" | "cancelQueued"
>;

export interface AdminRuntimeRegistry {
  listEnabled(): AdminRuntimeView[];
  refresh(
    accountId: string
  ): Promise<AdminRuntimeView | null>;
}

export interface AdminRuntimeView {
  record: AccountRecord;
  session: Pick<SessionProvider, "describe">;
  capacity: Pick<CapacityManager, "counts">;
  transport?: Pick<LingjingTransport, "read">;
  account?: Pick<AccountService, "describe">;
  catalog?: ModelCatalog;
}

export interface AdminDependencies {
  config: AppConfig;
  webhooks: Pick<SqliteWebhookRepository, "configure" | "list" | "setEnabled" | "deliveries" | "replay">;
  plans: Pick<SqlitePlanRepository, "create" | "list" | "assign" | "assertVideo">;
  usage: Pick<SqliteUsageRepository, "list" | "summary">;
  identities: Pick<
    SqliteIdentityRepository,
    | "createUser" | "listUsers" | "setUserStatus"
    | "createProject" | "listProjects" | "setProjectStatus"
  >;
  apiKeys: Pick<
    SqliteApiKeyRepository,
    "create" | "list" | "setEnabled" | "revoke" | "verify"
  >;
  cookieImporter: Pick<CookieImportService, "import">;
  browserLogins?: Pick<import("../accounts/browser-login-manager.js").BrowserLoginManager,"start"|"find">;
  dailySignIn?: SignInStatusReader;
  accounts: Pick<
    SqliteAccountRepository,
    "create" | "update" | "findById" | "list" | "usage"
  >;
  admissions: Pick<
    SqliteAdmissionRepository,
    "budgetState" | "usageBreakdown"
  >;
  runtimes: AdminRuntimeRegistry;
  repository: JobRepository;
  coordinator: Pick<GenerationCoordinator, "create" | "resolveUnknown">;
  catalog: ModelCatalog;
  transport: Pick<LingjingTransport, "read">;
}

export interface AppDependencies {
  config: AppConfig;
  webhooks: AdminDependencies["webhooks"];
  plans: AdminDependencies["plans"];
  usage: AdminDependencies["usage"];
  identities: AdminDependencies["identities"];
  apiKeys: AdminDependencies["apiKeys"];
  cookieImporter: AdminDependencies["cookieImporter"];
  browserLogins?: AdminDependencies["browserLogins"];
  dailySignIn?: AdminDependencies["dailySignIn"];
  adminStaticRoot?: string;
  logger: Logger;
  session: SessionProvider;
  transport: LingjingTransport;
  account: Pick<AccountService, "describe">;
  catalog: ModelCatalog;
  repository: JobRepository;
  accounts: AdminDependencies["accounts"];
  admissions: AdminDependencies["admissions"];
  runtimes: AdminRuntimeRegistry;
  coordinator: GenerationCoordinator;
  capacity: Pick<CapacityManager, "counts">;
  recovery: RecoveryService;
  uploads?: Pick<import("../media/upload-repository.js").UploadRepository,"create"|"complete">;
  objectStore?: import("../media/object-store.js").ObjectStore;
  assets?: Pick<import("../media/asset-repository.js").SqliteAssetRepository,"findById"|"prepared">;
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
