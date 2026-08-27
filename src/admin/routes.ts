import{z}from"zod";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import { existsSync } from "node:fs";
import { budgetWindows } from "../accounts/budget.js";
import { CookieImportRollbackError } from "../accounts/cookie-import-service.js";
import type { BudgetState } from "../accounts/sqlite-admission-repository.js";
import type { AccountRecord } from "../accounts/types.js";
import type { ApiKeyRecord } from "../api-keys/types.js";
import {
  emptyQuerySchema,
  errorResponseSchema,
  publicSecurity,
  routeSchema
} from "../api/schema.js";
import type { AdminDependencies, AdminRuntimeView } from "../api/types.js";
import { errors } from "../errors.js";
import { presentModel } from "../api/presenters.js";
import { buildPriceQuery } from "../lingjing/price-query.js";
import { LingjingPriceService } from "../lingjing/price-service.js";
import {
  setIfSupported,
  validateDynamicValues
} from "../api/routes/generation.js";
import type { JobRecord, JobStatus } from "../jobs/types.js";
import type { SourceType } from "../models/types.js";
import { accountSessionPaths } from "../session/create-provider.js";
import {
  accountListResponseSchema,
  accountParamsSchema,
  accountResponseSchema,
  accountViewSchema,
  apiKeyListResponseSchema,
  apiKeyParamsSchema,
  apiKeyResponseSchema,
  adminJobViewSchema,
  createApiKeyBodySchema,
  createApiKeyResponseSchema,
  createProjectBodySchema,
  createUserBodySchema,
  createPlanBodySchema,
  configureWebhookBodySchema,
  webhookResponseSchema,
  webhookListResponseSchema,
  webhookStatusBodySchema,
  webhookDeliveryListSchema,
  assignPlanBodySchema,
  planListResponseSchema,
  planResponseSchema,
  createAccountBodySchema,
  createAccountResponseSchema,
  identityParamsSchema,
  importAccountBodySchema,
  jobListQuerySchema,
  jobListResponseSchema,
  jobParamsSchema,
  jobResponseSchema,
  loginBodySchema,
  loginResponseSchema,
  overviewResponseSchema,
  playgroundModelsQuerySchema,
  playgroundModelsResponseSchema,
  playgroundQuoteBodySchema,
  playgroundQuoteResponseSchema,
  playgroundRunBodySchema,
  playgroundRunResponseSchema,
  resolveUnknownBodySchema,
  sessionResponseSchema,
  setIdentityStatusBodySchema,
  settingsResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  userListResponseSchema,
  userResponseSchema,
  updateAccountBodySchema,
  usageQuerySchema,
  usageResponseSchema
} from "./schemas.js";
import type { AdminSession } from "./session.js";
import { AdminSessionStore } from "./session.js";

const ADMIN_COOKIE = "lingjing_admin_session";
const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set([
  "queued",
  "submitting",
  "discovering",
  "processing",
  "unknown"
]);

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store");
}

function secureRequest(request: Pick<FastifyRequest, "protocol">): boolean {
  return request.protocol === "https";
}

export function adminCookieOptions(request: Pick<FastifyRequest, "protocol">) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/admin",
    secure: secureRequest(request)
  };
}

function runtimeFor(
  dependencies: AdminDependencies,
  accountId: string
) {
  return dependencies.runtimes.listEnabled().find(
    (runtime) => runtime.record.id === accountId
  );
}

function hasSessionFiles(
  dependencies: AdminDependencies,
  account: AccountRecord
): boolean {
  const paths = account.id === "legacy"
    ? {
        storageStatePath: dependencies.config.storageStatePath,
        cookieFilePath: dependencies.config.cookieFilePath,
        sessionProfilePath: dependencies.config.sessionProfilePath
      }
    : accountSessionPaths(dependencies.config, account.id);
  const source = dependencies.config.sessionMode === "browser-state"
    ? paths.storageStatePath
    : paths.cookieFilePath;
  return existsSync(source) && existsSync(paths.sessionProfilePath);
}

function accountView(
  dependencies: AdminDependencies,
  account: AccountRecord,
  jobs: readonly JobRecord[]
) {
  const usage = dependencies.admissions.usageBreakdown(
    account.id,
    budgetWindows()
  );
  const runtime = runtimeFor(dependencies, account.id);
  const accountJobs = jobs.filter((job) => job.accountId === account.id);
  return {
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    priority: account.priority,
    daily_point_limit: account.dailyPointLimit,
    monthly_point_limit: account.monthlyPointLimit,
    daily_used_points: usage.dayChargedPoints,
    monthly_used_points: usage.monthChargedPoints,
    daily_reserved_points: usage.dayReservedPoints,
    monthly_reserved_points: usage.monthReservedPoints,
    health_status: account.healthStatus,
    last_error_code: account.lastErrorCode,
    has_session: runtime?.session.describe().hasCsrf
      ?? hasSessionFiles(dependencies, account),
    subject_hash: account.subjectHash,
    membership: account.membership,
    points_balance: account.pointsBalance,
    total_balance: account.totalBalance,
    max_concurrency: account.maxConcurrency,
    active_jobs: accountJobs.filter((job) =>
      ACTIVE_STATUSES.has(job.status)
    ).length,
    last_checked_at: account.lastCheckedAt,
    updated_at: account.updatedAt
  };
}

function jobView(
  job: JobRecord,
  accountNames: ReadonlyMap<string, string>,
  budgetState: BudgetState | null
) {
  return {
    id: job.id,
    account_name: accountNames.get(job.accountId) ?? "Unknown account",
    kind: job.kind,
    model: job.model,
    status: job.status,
    quoted_points: job.quotedPoints,
    budget_state: budgetState,
    submitted_at: job.submittedAt,
    discovered_at: job.discoveredAt,
    completed_at: job.completedAt,
    failed_at: job.failedAt,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    error_code: job.errorCode,
    outputs: (job.result?.outputs ?? []).map(output=>({url:output.url,poster_url:output.posterUrl,width:output.width,height:output.height,duration:output.duration,format:output.format}))
  };
}

function accountNames(dependencies: AdminDependencies) {
  return new Map(
    dependencies.accounts.list().map((account) => [account.id, account.name])
  );
}

function allJobs(dependencies: AdminDependencies): JobRecord[] {
  return dependencies.repository.list({ limit: 10_000 });
}

function playgroundSourceTypes(query: {
  type: "image" | "video";
  mode?: "text-to-video" | "image-to-video" | undefined;
}): SourceType[] {
  if (query.type === "image") return ["image-generation"];
  return query.mode === undefined
    ? ["text-to-video", "image-to-video"]
    : [query.mode];
}

type PlaygroundQuoteRuntime = AdminRuntimeView & Required<Pick<
  AdminRuntimeView,
  "transport" | "account" | "catalog"
>>;

function quoteCapableRuntime(
  runtime: AdminRuntimeView
): runtime is PlaygroundQuoteRuntime {
  return runtime.transport !== undefined
    && runtime.account !== undefined
    && runtime.catalog !== undefined;
}

function compareQuoteRuntimes(
  left: PlaygroundQuoteRuntime,
  right: PlaygroundQuoteRuntime
): number {
  return left.record.priority - right.record.priority
    || left.capacity.counts().active - right.capacity.counts().active
    || (left.record.lastSelectedAt ?? Number.NEGATIVE_INFINITY)
      - (right.record.lastSelectedAt ?? Number.NEGATIVE_INFINITY)
    || left.record.id.localeCompare(right.record.id);
}

async function livePlaygroundPoints(
  dependencies: AdminDependencies,
  input: {
    model: string;
    mode: "text-to-video" | "image-to-video";
    parameters: Record<string, unknown>;
  }
): Promise<number> {
  const candidates = dependencies.runtimes.listEnabled()
    .filter(quoteCapableRuntime)
    .sort(compareQuoteRuntimes);
  for (const runtime of candidates) {
    const record = dependencies.accounts.findById(runtime.record.id);
    if (record === null || !record.enabled || record.healthStatus !== "ready") {
      continue;
    }
    try {
      const [model, account] = await Promise.all([
        runtime.catalog.resolve(input.model, input.mode, true),
        runtime.account.describe()
      ]);
      const query = buildPriceQuery(model, input.parameters);
      if (query === null) continue;
      const quote = await new LingjingPriceService(runtime.transport)
        .calculate(query);
      const usage = dependencies.accounts.usage(
        record.id,
        budgetWindows()
      );
      if (
        account.pointsBalance < quote.points
        || (
          record.dailyPointLimit !== 0
          && usage.dayUsedPoints + quote.points > record.dailyPointLimit
        )
        || (
          record.monthlyPointLimit !== 0
          && usage.monthUsedPoints + quote.points > record.monthlyPointLimit
        )
      ) {
        continue;
      }
      return quote.points;
    } catch {
      continue;
    }
  }
  if (candidates.length > 0) throw errors.upstream();

  const model = await dependencies.catalog.resolve(
    input.model,
    input.mode,
    true
  );
  const query = buildPriceQuery(model, input.parameters);
  if (query === null) throw errors.upstream();
  return (await new LingjingPriceService(dependencies.transport)
    .calculate(query)).points;
}

function findAccount(
  dependencies: AdminDependencies,
  id: string
): AccountRecord {
  const account = dependencies.accounts.findById(id);
  if (account === null) throw errors.accountNotFound();
  return account;
}

function authenticatedSession(
  sessions: WeakMap<FastifyRequest, AdminSession>,
  request: FastifyRequest
): AdminSession {
  const session = sessions.get(request);
  if (session === undefined) throw errors.adminAuthentication();
  return session;
}

function accountMutation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof TypeError || cause instanceof RangeError) {
      throw errors.invalidRequest("Invalid account");
    }
    if (
      cause instanceof Error
      && "code" in cause
      && cause.code === "SQLITE_CONSTRAINT_UNIQUE"
      && cause.message === "UNIQUE constraint failed: accounts.name"
    ) {
      throw errors.accountNameConflict();
    }
    throw cause;
  }
}

function userView(user: import("../identity/types.js").UserRecord) {
  return { id: user.id, name: user.name, status: user.status,
    created_at: user.createdAt, updated_at: user.updatedAt };
}
function projectView(project: import("../identity/types.js").ProjectRecord) {
  return { id: project.id, user_id: project.userId, name: project.name,
    status: project.status, created_at: project.createdAt, updated_at: project.updatedAt };
}

function apiKeyView(key: ApiKeyRecord) {
  return {
    id: key.id,
    user_id: key.userId,
    project_id: key.projectId,
    name: key.name,
    key_prefix: key.keyPrefix,
    scopes: key.scopes,
    enabled: key.enabled,
    expires_at: key.expiresAt,
    created_at: key.createdAt,
    updated_at: key.updatedAt,
    last_used_at: key.lastUsedAt,
    revoked_at: key.revokedAt
  };
}

function apiKeyMutation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof TypeError || cause instanceof RangeError) {
      throw errors.invalidRequest("Invalid API key");
    }
    if (
      cause instanceof Error
      && "code" in cause
      && cause.code === "SQLITE_CONSTRAINT_UNIQUE"
      && cause.message === "UNIQUE constraint failed: api_keys.name"
    ) {
      throw errors.apiKeyNameConflict();
    }
    if (
      cause instanceof Error
      && cause.message.includes("was not found")
    ) {
      throw errors.apiKeyNotFound();
    }
    throw cause;
  }
}

const INVALID_COOKIE_IMPORT_MESSAGES = new Set([
  "Cookie input is too large",
  "Invalid browser cookie JSON",
  "Unsupported cookie domain",
  "Invalid Cookie header",
  "Too many cookies",
  "Lingjing csrfToken cookie is required",
  "Duplicate Lingjing csrfToken cookie",
  "Invalid Lingjing pin cookie",
  "Lingjing pin cookie is required",
  "Conflicting Lingjing pin cookies"
]);

function importFailure(cause: unknown) {
  if (cause instanceof CookieImportRollbackError) {
    return errors.cookieImportRollbackIncomplete();
  }
  if (
    cause instanceof Error
    && INVALID_COOKIE_IMPORT_MESSAGES.has(cause.message)
  ) {
    return errors.invalidRequest("Invalid cookie import", "cookie_input");
  }
  if (
    cause instanceof Error
    && /timed?\s*out|timeout/iu.test(cause.message)
  ) {
    return errors.importValidationTimeout();
  }
  return errors.invalidImportedSession();
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminDependencies
): Promise<void> {
  const password = dependencies.config.adminPassword;
  if (password === null) return;
  const store = new AdminSessionStore({ password });
  const requestSessions = new WeakMap<FastifyRequest, AdminSession>();

  await app.register(function adminApi(adminApp) {
    adminApp.addHook("onRequest", (request, reply): Promise<void> => {
      noStore(reply);
      if (
        request.method === "POST"
        && request.url.split("?", 1)[0] === "/admin/api/login"
      ) {
        return Promise.resolve();
      }
      const session = store.authenticate(request.cookies[ADMIN_COOKIE]);
      if (session === null) {
        return Promise.reject(errors.adminAuthentication());
      }
      requestSessions.set(request, session);
      if (request.method !== "GET" && request.method !== "HEAD") {
        try {
          store.assertCsrf(
            session,
            request.headers["x-csrf-token"] as string | undefined
          );
        } catch {
          return Promise.reject(errors.adminCsrf());
        }
      }
      return Promise.resolve();
    });

    adminApp.post("/login", {
      schema: routeSchema({
        security: publicSecurity,
        body: loginBodySchema,
        response: {
          200: loginResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const body = loginBodySchema.parse(request.body);
      const session = store.login(body.password);
      if (session === null) throw errors.adminAuthentication();
      reply.setCookie(ADMIN_COOKIE, session.id, adminCookieOptions(request));
      return noStore(reply).send({
        authenticated: true,
        csrf_token: session.csrfToken,
        expires_at: session.expiresAt
      });
    });

    adminApp.get("/session", {
      schema: routeSchema({
        security: publicSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: sessionResponseSchema,
          401: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const session = authenticatedSession(requestSessions, request);
      return noStore(reply).send({
        authenticated: true,
        csrf_token: session.csrfToken,
        expires_at: session.expiresAt
      });
    });

    adminApp.post("/logout", {
      schema: routeSchema({
        security: publicSecurity,
        response: {
          401: errorResponseSchema,
          403: errorResponseSchema
        }
      })
    }, (request, reply) => {
      store.logout(request.cookies[ADMIN_COOKIE]);
      reply.clearCookie(ADMIN_COOKIE, adminCookieOptions(request));
      return noStore(reply).code(204).send();
    });

    adminApp.get("/accounts", {
      schema: routeSchema({
        security: publicSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: accountListResponseSchema,
          401: errorResponseSchema
        }
      })
    }, (_request, reply) => {
      const jobs = allJobs(dependencies);
      return noStore(reply).send({
        accounts: dependencies.accounts.list().map((account) =>
          accountView(dependencies, account, jobs)
        )
      });
    });

    adminApp.get("/accounts/:id", {
      schema: routeSchema({
        security: publicSecurity,
        params: accountParamsSchema,
        response: {
          200: accountResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const { id } = accountParamsSchema.parse(request.params);
      return noStore(reply).send({
        account: accountView(
          dependencies,
          findAccount(dependencies, id),
          allJobs(dependencies)
        )
      });
    });

    adminApp.post("/accounts", {
      schema: routeSchema({
        security: publicSecurity,
        body: createAccountBodySchema,
        response: {
          201: createAccountResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const body = createAccountBodySchema.parse(request.body);
      const account = accountMutation(() => dependencies.accounts.create({
        name: body.name,
        priority: body.priority,
        dailyPointLimit: body.daily_point_limit,
        monthlyPointLimit: body.monthly_point_limit
      }));
      return noStore(reply).code(201).send({
        account: accountView(dependencies, account, allJobs(dependencies)),
        login_command: `npm run login -- --account-id ${account.id}`
      });
    });

    adminApp.post("/accounts/import", {
      schema: routeSchema({
        security: publicSecurity,
        body: importAccountBodySchema,
        response: {
          201: accountResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
          504: errorResponseSchema
        }
      })
    }, async (request, reply) => {
      const body = importAccountBodySchema.parse(request.body);
      let account: AccountRecord;
      try {
        account = await dependencies.cookieImporter.import({
          account: {
            name: body.name,
            priority: body.priority,
            dailyPointLimit: body.daily_point_limit,
            monthlyPointLimit: body.monthly_point_limit
          },
          cookies: {
            format: body.cookie_format,
            value: body.cookie_input
          }
        });
      } catch (cause) {
        try {
          accountMutation(() => { throw cause; });
        } catch (mapped) {
          if (mapped !== cause) throw mapped;
        }
        throw importFailure(cause);
      }
      return noStore(reply).code(201).send({
        account: accountView(dependencies, account, allJobs(dependencies))
      });
    });

    adminApp.get("/users", {
      schema: routeSchema({ security: publicSecurity, querystring: emptyQuerySchema,
        response: { 200: userListResponseSchema, 401: errorResponseSchema } })
    }, (_request, reply) => noStore(reply).send({
      users: dependencies.identities.listUsers().map(userView)
    }));
    adminApp.post("/users", {
      schema: routeSchema({ security: publicSecurity, body: createUserBodySchema,
        response: { 201: userResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema } })
    }, (request, reply) => {
      const body = createUserBodySchema.parse(request.body);
      return noStore(reply).code(201).send({ user: userView(dependencies.identities.createUser(body.name)) });
    });
    adminApp.post("/users/:id/status", {
      schema: routeSchema({ security: publicSecurity, params: identityParamsSchema,
        body: setIdentityStatusBodySchema,
        response: { 200: userResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema } })
    }, (request, reply) => {
      const { id } = identityParamsSchema.parse(request.params);
      const { status } = setIdentityStatusBodySchema.parse(request.body);
      return noStore(reply).send({ user: userView(dependencies.identities.setUserStatus(id, status)) });
    });
    adminApp.get("/projects", {
      schema: routeSchema({ security: publicSecurity, querystring: emptyQuerySchema,
        response: { 200: projectListResponseSchema, 401: errorResponseSchema } })
    }, (_request, reply) => noStore(reply).send({
      projects: dependencies.identities.listProjects().map(projectView)
    }));
    adminApp.post("/projects", {
      schema: routeSchema({ security: publicSecurity, body: createProjectBodySchema,
        response: { 201: projectResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema } })
    }, (request, reply) => {
      const body = createProjectBodySchema.parse(request.body);
      return noStore(reply).code(201).send({
        project: projectView(dependencies.identities.createProject(body.user_id, body.name))
      });
    });
    adminApp.post("/projects/:id/status", {
      schema: routeSchema({ security: publicSecurity, params: identityParamsSchema,
        body: setIdentityStatusBodySchema,
        response: { 200: projectResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema } })
    }, (request, reply) => {
      const { id } = identityParamsSchema.parse(request.params);
      const { status } = setIdentityStatusBodySchema.parse(request.body);
      return noStore(reply).send({ project: projectView(dependencies.identities.setProjectStatus(id, status)) });
    });

    adminApp.get("/api-keys", {
      schema: routeSchema({
        security: publicSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: apiKeyListResponseSchema,
          401: errorResponseSchema
        }
      })
    }, (_request, reply) => noStore(reply).send({
      api_keys: dependencies.apiKeys.list().map(apiKeyView)
    }));

    adminApp.post("/api-keys", {
      schema: routeSchema({
        security: publicSecurity,
        body: createApiKeyBodySchema,
        response: {
          201: createApiKeyResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          409: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const body = createApiKeyBodySchema.parse(request.body);
      const created = apiKeyMutation(() => dependencies.apiKeys.create(body.name, {
        ...(body.user_id === undefined ? {} : { userId: body.user_id }),
        ...(body.project_id === undefined ? {} : { projectId: body.project_id }),
        ...(body.scopes === undefined ? {} : { scopes: body.scopes }),
        ...(body.expires_at === undefined ? {} : { expiresAt: body.expires_at })
      }));
      return noStore(reply).code(201).send({
        key: apiKeyView(created.record),
        api_key: created.secret
      });
    });

    const updateApiKey = (
      id: string,
      enabled: boolean,
      reply: FastifyReply
    ) => {
      const existing = dependencies.apiKeys.list().find((key) => key.id === id);
      if (existing === undefined) throw errors.apiKeyNotFound();
      if (existing.revokedAt !== null) throw errors.apiKeyRevoked();
      const key = apiKeyMutation(() => dependencies.apiKeys.setEnabled(id, enabled));
      return noStore(reply).send({ key: apiKeyView(key) });
    };

    adminApp.post("/api-keys/:id/enable", {
      schema: routeSchema({
        security: publicSecurity,
        params: apiKeyParamsSchema,
        response: {
          200: apiKeyResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const { id } = apiKeyParamsSchema.parse(request.params);
      return updateApiKey(id, true, reply);
    });

    adminApp.post("/api-keys/:id/disable", {
      schema: routeSchema({
        security: publicSecurity,
        params: apiKeyParamsSchema,
        response: {
          200: apiKeyResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const { id } = apiKeyParamsSchema.parse(request.params);
      return updateApiKey(id, false, reply);
    });

    adminApp.delete("/api-keys/:id", {
      schema: routeSchema({
        security: publicSecurity,
        params: apiKeyParamsSchema,
        response: {
          200: apiKeyResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const { id } = apiKeyParamsSchema.parse(request.params);
      apiKeyMutation(() => {
        dependencies.apiKeys.revoke(id);
      });
      const key = dependencies.apiKeys.list().find((item) => item.id === id);
      if (key === undefined) throw errors.apiKeyNotFound();
      return noStore(reply).send({ key: apiKeyView(key) });
    });

    adminApp.patch("/accounts/:id", {
      schema: routeSchema({
        security: publicSecurity,
        params: accountParamsSchema,
        body: updateAccountBodySchema,
        response: {
          200: accountResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const { id } = accountParamsSchema.parse(request.params);
      findAccount(dependencies, id);
      const body = updateAccountBodySchema.parse(request.body);
      const account = accountMutation(() => dependencies.accounts.update(id, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        ...(body.daily_point_limit === undefined
          ? {}
          : { dailyPointLimit: body.daily_point_limit }),
        ...(body.monthly_point_limit === undefined
          ? {}
          : { monthlyPointLimit: body.monthly_point_limit })
      }));
      return noStore(reply).send({
        account: accountView(dependencies, account, allJobs(dependencies))
      });
    });

    const refreshAccount = async (
      id: string,
      reply: FastifyReply
    ) => {
      findAccount(dependencies, id);
      await dependencies.runtimes.refresh(id);
      return noStore(reply).send({
        account: accountView(
          dependencies,
          findAccount(dependencies, id),
          allJobs(dependencies)
        )
      });
    };

    adminApp.post("/accounts/:id/browser-login",{schema:routeSchema({security:publicSecurity,params:accountParamsSchema,response:{200:z.object({login:z.object({id:z.string(),account_id:z.string(),status:z.enum(["running","completed","failed"]),error:z.string().nullable()})})}})},async(request,reply)=>{const account=dependencies.accounts.findById((request.params as{id:string}).id);if(account===null)throw errors.invalidRequest("Account not found");if(dependencies.browserLogins===undefined)throw errors.invalidRequest("Browser login is unavailable");const login=dependencies.browserLogins.start(account.id);return noStore(reply).send({login:{id:login.id,account_id:login.accountId,status:login.status,error:login.error}});});
    adminApp.get("/accounts/browser-logins/:loginId",{schema:routeSchema({security:publicSecurity,params:z.object({loginId:z.string()}),response:{200:z.object({login:z.object({id:z.string(),account_id:z.string(),status:z.enum(["running","completed","failed"]),error:z.string().nullable()})})}})},async(request,reply)=>{if(dependencies.browserLogins===undefined)throw errors.invalidRequest("Browser login is unavailable");const login=dependencies.browserLogins.find((request.params as{loginId:string}).loginId);if(!login)throw errors.invalidRequest("Browser login not found");return noStore(reply).send({login:{id:login.id,account_id:login.accountId,status:login.status,error:login.error}});});
    adminApp.post("/accounts/:id/check", {
      schema: routeSchema({
        security: publicSecurity,
        params: accountParamsSchema,
        response: {
          200: accountResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema
        }
      })
    }, async (request, reply) => {
      const { id } = accountParamsSchema.parse(request.params);
      return await refreshAccount(id, reply);
    });

    adminApp.post("/accounts/:id/enable", {
      schema: routeSchema({
        security: publicSecurity,
        params: accountParamsSchema,
        response: {
          200: accountResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema
        }
      })
    }, async (request, reply) => {
      const { id } = accountParamsSchema.parse(request.params);
      findAccount(dependencies, id);
      dependencies.accounts.update(id, { enabled: true });
      return await refreshAccount(id, reply);
    });

    adminApp.post("/accounts/:id/disable", {
      schema: routeSchema({
        security: publicSecurity,
        params: accountParamsSchema,
        response: {
          200: accountResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema
        }
      })
    }, async (request, reply) => {
      const { id } = accountParamsSchema.parse(request.params);
      findAccount(dependencies, id);
      dependencies.accounts.update(id, { enabled: false });
      await dependencies.runtimes.refresh(id);
      return noStore(reply).send({
        account: accountView(
          dependencies,
          findAccount(dependencies, id),
          allJobs(dependencies)
        )
      });
    });

    adminApp.post("/accounts/:id/resolve-unknown", {
      schema: routeSchema({
        security: publicSecurity,
        params: accountParamsSchema,
        body: resolveUnknownBodySchema,
        response: {
          200: jobResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const { id } = accountParamsSchema.parse(request.params);
      findAccount(dependencies, id);
      const body = resolveUnknownBodySchema.parse(request.body);
      try {
        const resolved = dependencies.coordinator.resolveUnknown(
          id,
          body.job_id,
          body.action
        );
        return noStore(reply).send({
          job: jobView(
            resolved.job,
            accountNames(dependencies),
            resolved.state
          )
        });
      } catch (cause) {
        if (
          cause instanceof Error
          && cause.message === "Unknown job resolution conflict"
        ) {
          throw errors.adminConflict();
        }
        throw cause;
      }
    });

    adminApp.get("/playground/models", {
      schema: routeSchema({
        security: publicSecurity,
        querystring: playgroundModelsQuerySchema,
        response: {
          200: playgroundModelsResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          502: errorResponseSchema
        }
      })
    }, async (request, reply) => {
      const query = playgroundModelsQuerySchema.parse(request.query);
      const groups = await Promise.all(
        playgroundSourceTypes(query).map((sourceType) =>
          dependencies.catalog.list(sourceType, query.refresh)
        )
      );
      return noStore(reply).send({
        models: groups.flat().map((model) => {
          const presented = presentModel(model);
          return {
            id: presented.id,
            display_name: presented.display_name,
            type: presented.type,
            ...(presented.mode === undefined ? {} : { mode: presented.mode }),
            capabilities: presented.capabilities,
            parameters: presented.parameters,
            pricing: presented.pricing
          };
        })
      });
    });

    adminApp.post("/playground/quote", {
      schema: routeSchema({
        security: publicSecurity,
        body: playgroundQuoteBodySchema,
        response: {
          200: playgroundQuoteResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          502: errorResponseSchema
        }
      })
    }, async (request, reply) => {
      const body = playgroundQuoteBodySchema.parse(request.body);
      const points = await livePlaygroundPoints(dependencies, body);
      return noStore(reply).send({ points, source: "live" });
    });

    adminApp.post("/playground/run", {
      schema: routeSchema({
        security: publicSecurity,
        body: playgroundRunBodySchema,
        response: {
          202: playgroundRunResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
          502: errorResponseSchema,
          503: errorResponseSchema
        }
      })
    }, async (request, reply) => {
      const body = playgroundRunBodySchema.parse(request.body);
      const sourceType: SourceType = body.kind === "image"
        ? "image-generation"
        : body.mode ?? "text-to-video";
      const model = await dependencies.catalog.resolve(
        body.model,
        sourceType,
        true
      );
      const values = { ...body.parameters };
      setIfSupported(values, model, ["prompt"], body.prompt);
      validateDynamicValues(model, values);
      const media=body.input_image===undefined?[]:[{kind:"image" as const,source:{type:"data-uri" as const,value:body.input_image}}];
      const handle = await dependencies.coordinator.create({
        kind: body.kind,
        sourceType,
        model: body.model,
        values,
        media,
        idempotencyKey: null
      });
      return noStore(reply).code(202).send({
        job: jobView(
          handle.job,
          accountNames(dependencies),
          dependencies.admissions.budgetState(handle.job.id)
        )
      });
    });

    adminApp.get("/jobs", {
      schema: routeSchema({
        security: publicSecurity,
        querystring: jobListQuerySchema,
        response: {
          200: jobListResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const query = jobListQuerySchema.parse(request.query);
      const names = accountNames(dependencies);
      const jobs = dependencies.repository.list({
        limit: query.limit,
        ...(query.status === undefined ? {} : { status: query.status })
      });
      return noStore(reply).send({
        jobs: jobs.map((job) => jobView(
          job,
          names,
          dependencies.admissions.budgetState(job.id)
        ))
      });
    });

    adminApp.get("/jobs/:id", {
      schema: routeSchema({
        security: publicSecurity,
        params: jobParamsSchema,
        response: {
          200: jobResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema
        }
      })
    }, (request, reply) => {
      const { id } = jobParamsSchema.parse(request.params);
      const job = dependencies.repository.findById(id);
      if (job === null) throw errors.adminJobNotFound();
      return noStore(reply).send({
        job: jobView(
          job,
          accountNames(dependencies),
          dependencies.admissions.budgetState(job.id)
        )
      });
    });

    adminApp.get("/overview", {
      schema: routeSchema({
        security: publicSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: overviewResponseSchema,
          401: errorResponseSchema
        }
      })
    }, (_request, reply) => {
      const accounts = dependencies.accounts.list();
      const jobs = allJobs(dependencies);
      const views = accounts.map((account) =>
        accountView(dependencies, account, jobs)
      );
      const names = accountNames(dependencies);
      const recentFailures = jobs
        .filter((job) => job.status === "failed")
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 5)
        .map((job) => jobView(
          job,
          names,
          dependencies.admissions.budgetState(job.id)
        ));
      return noStore(reply).send({
        accounts: {
          total: accounts.length,
          enabled: accounts.filter((account) => account.enabled).length,
          ready: accounts.filter(
            (account) => account.healthStatus === "ready"
          ).length,
          unhealthy: accounts.filter(
            (account) => account.healthStatus === "needs_login"
              || account.healthStatus === "unhealthy"
          ).length,
          budget_exhausted: views.filter((view) =>
            (
              view.daily_point_limit !== 0
              && view.daily_used_points + view.daily_reserved_points
                >= view.daily_point_limit
            )
            || (
              view.monthly_point_limit !== 0
              && view.monthly_used_points + view.monthly_reserved_points
                >= view.monthly_point_limit
            )
          ).length
        },
        usage: {
          daily_used_points: views.reduce(
            (sum, view) => sum + view.daily_used_points,
            0
          ),
          monthly_used_points: views.reduce(
            (sum, view) => sum + view.monthly_used_points,
            0
          ),
          daily_reserved_points: views.reduce(
            (sum, view) => sum + view.daily_reserved_points,
            0
          ),
          monthly_reserved_points: views.reduce(
            (sum, view) => sum + view.monthly_reserved_points,
            0
          )
        },
        jobs: {
          active: jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).length,
          queued: jobs.filter((job) => job.status === "queued").length
        },
        balance: {
          available_points: accounts.reduce((sum, account) => (
            account.enabled
            && account.healthStatus === "ready"
            && account.totalBalance !== null
              ? sum + account.totalBalance
              : sum
          ), 0)
        },
        recent_failures: recentFailures
      });
    });

    adminApp.get("/webhook-deliveries",{schema:routeSchema({security:publicSecurity,querystring:emptyQuerySchema,response:{200:webhookDeliveryListSchema,401:errorResponseSchema}})},(_request,reply)=>noStore(reply).send({deliveries:dependencies.webhooks.deliveries().map(d=>({id:d.id,project_id:d.projectId,job_id:d.jobId,event_type:d.eventType,status:d.status??"pending",attempts:d.attempts,next_attempt_at:d.nextAttemptAt,last_error:d.lastError??null,delivered_at:d.deliveredAt??null,created_at:d.createdAt??0}))}));
    adminApp.post("/webhook-deliveries/:id/replay",{schema:routeSchema({security:publicSecurity,params:identityParamsSchema,response:{400:errorResponseSchema,401:errorResponseSchema}})},(request,reply)=>{const{id}=identityParamsSchema.parse(request.params);dependencies.webhooks.replay(id);return noStore(reply).code(204).send();});
    adminApp.get("/webhooks",{schema:routeSchema({security:publicSecurity,querystring:emptyQuerySchema,response:{200:webhookListResponseSchema,401:errorResponseSchema}})},(_request,reply)=>noStore(reply).send({webhooks:dependencies.webhooks.list().map(w=>({id:w.id,project_id:w.projectId,url:w.url,secret:"",enabled:w.enabled}))}));
    adminApp.post("/webhooks/:id/status",{schema:routeSchema({security:publicSecurity,params:identityParamsSchema,body:webhookStatusBodySchema,response:{200:webhookResponseSchema,400:errorResponseSchema,401:errorResponseSchema}})},(request,reply)=>{const {id}=identityParamsSchema.parse(request.params);const {enabled}=webhookStatusBodySchema.parse(request.body);const w=dependencies.webhooks.setEnabled(id,enabled);return noStore(reply).send({webhook:{id:w.id,project_id:w.projectId,url:w.url,secret:"",enabled:w.enabled}});});
    adminApp.post("/webhooks",{schema:routeSchema({security:publicSecurity,body:configureWebhookBodySchema,response:{201:webhookResponseSchema,400:errorResponseSchema,401:errorResponseSchema}})},(request,reply)=>{const b=configureWebhookBodySchema.parse(request.body);const webhook=dependencies.webhooks.configure(b.project_id,b.url);return noStore(reply).code(201).send({webhook:{id:webhook.id,project_id:webhook.projectId,url:webhook.url,secret:webhook.secret,enabled:webhook.enabled}});});

    adminApp.get("/plans", { schema: routeSchema({security:publicSecurity,querystring:emptyQuerySchema,response:{200:planListResponseSchema,401:errorResponseSchema}})},(_request,reply)=>noStore(reply).send({plans:dependencies.plans.list().map((p)=>({id:p.id,name:p.name,enabled:p.enabled,allowed_modes:p.allowedModes,allowed_models:p.allowedModels,max_duration_seconds:p.maxDurationSeconds,allowed_resolutions:p.allowedResolutions,daily_limit_points:p.dailyLimitPoints,monthly_limit_points:p.monthlyLimitPoints,max_concurrency:p.maxConcurrency,max_queued_requests:p.maxQueuedRequests,created_at:p.createdAt,updated_at:p.updatedAt}))}));
    adminApp.post("/plans", { schema: routeSchema({security:publicSecurity,body:createPlanBodySchema,response:{201:planResponseSchema,400:errorResponseSchema,401:errorResponseSchema}})},(request,reply)=>{const b=createPlanBodySchema.parse(request.body);const p=dependencies.plans.create({name:b.name,enabled:b.enabled,allowedModes:b.allowed_modes,allowedModels:b.allowed_models,maxDurationSeconds:b.max_duration_seconds,allowedResolutions:b.allowed_resolutions,dailyLimitPoints:b.daily_limit_points,monthlyLimitPoints:b.monthly_limit_points,maxConcurrency:b.max_concurrency,maxQueuedRequests:b.max_queued_requests});return noStore(reply).code(201).send({plan:{id:p.id,name:p.name,enabled:p.enabled,allowed_modes:p.allowedModes,allowed_models:p.allowedModels,max_duration_seconds:p.maxDurationSeconds,allowed_resolutions:p.allowedResolutions,daily_limit_points:p.dailyLimitPoints,monthly_limit_points:p.monthlyLimitPoints,max_concurrency:p.maxConcurrency,max_queued_requests:p.maxQueuedRequests,created_at:p.createdAt,updated_at:p.updatedAt}});});
    adminApp.post("/plans/assign", { schema: routeSchema({security:publicSecurity,body:assignPlanBodySchema,response:{400:errorResponseSchema,401:errorResponseSchema}})},(request,reply)=>{const b=assignPlanBodySchema.parse(request.body);dependencies.plans.assign(b.project_id,b.plan_id);return noStore(reply).code(204).send();});

    adminApp.get("/usage", {
      schema: routeSchema({ security: publicSecurity, querystring: usageQuerySchema,
        response: { 200: usageResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema } })
    }, (request, reply) => {
      const query = usageQuerySchema.parse(request.query);
      const filter = {
        ...(query.user_id === undefined ? {} : { userId: query.user_id }),
        ...(query.project_id === undefined ? {} : { projectId: query.project_id }),
        ...(query.api_key_id === undefined ? {} : { apiKeyId: query.api_key_id }),
        ...(query.account_id === undefined ? {} : { accountId: query.account_id }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to })
      };
      const summary = dependencies.usage.summary(filter);
      return noStore(reply).send({
        summary: {
          held_points: summary.heldPoints, charged_points: summary.chargedPoints,
          released_points: summary.releasedPoints, refunded_points: summary.refundedPoints,
          adjusted_points: summary.adjustedPoints, net_points: summary.netPoints,
          entry_count: summary.entryCount
        },
        entries: dependencies.usage.list({ ...filter, limit: query.limit }).map((entry) => ({
          id:entry.id, job_id:entry.jobId, user_id:entry.userId, project_id:entry.projectId,
          api_key_id:entry.apiKeyId, account_id:entry.accountId, type:entry.type,
          points:entry.points, reason:entry.reason, created_at:entry.createdAt
        }))
      });
    });

    adminApp.get("/settings", {
      schema: routeSchema({
        security: publicSecurity,
        querystring: emptyQuerySchema,
        response: {
          200: settingsResponseSchema,
          401: errorResponseSchema
        }
      })
    }, (request, reply) => noStore(reply).send({
      max_concurrency: dependencies.config.maxConcurrency,
      max_queued_requests: dependencies.config.maxQueuedRequests,
      unknown_capacity_hold_ms: dependencies.config.unknownCapacityHoldMs,
      image_wait_timeout_ms: dependencies.config.imageWaitTimeoutMs,
      video_wait_timeout_ms: dependencies.config.videoWaitTimeoutMs,
      docs_enabled: dependencies.config.docsEnabled,
      shared_api_key_configured: dependencies.config.apiKey.trim().length > 0,
      legacy_api_key_configured: dependencies.config.apiKey.trim().length > 0,
      output_retention_ms:dependencies.config.outputRetentionMs,
      api_base_url: new URL(
        "/v1",
        `${request.protocol}://${request.headers.host ?? request.hostname}`
      ).toString().replace(/\/$/u, "")
    }));
  }, { prefix: "/admin/api" });
}

export {
  accountViewSchema,
  adminJobViewSchema
};
