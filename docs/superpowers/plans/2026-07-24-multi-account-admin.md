# Lingjing Multi-Account Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a same-origin administration console that manages multiple upstream Lingjing accounts and durably enforces daily/monthly quoted-point budgets while preserving the existing shared API key contract.

**Architecture:** Keep one Fastify process and one SQLite database. Add a shared SQLite store with focused job/account/admission repositories, construct an isolated upstream runtime per enabled account, and bind every job to one runtime through an atomic scheduler admission. Build a Vite/React admin client into `dist/admin` and serve it from Fastify behind a separate in-memory administrator session.

**Tech Stack:** Node.js 20.19+, TypeScript 6, Fastify 5, better-sqlite3, Zod 4, Vitest 3, React 19, Vite 7, Playwright 1.61, Docker Compose.

## Global Constraints

- Existing clients continue to authenticate with the single shared `LINGJING_API_KEY`.
- Only upstream accounts receive daily and monthly quoted-point budgets.
- A point limit of `0` means unlimited.
- Budget windows are calendar days and months in `Asia/Shanghai`.
- An account with a configured limit cannot accept a request whose quoted point cost is unknown.
- Idempotent replay never creates a second reservation.
- Proven pre-submit failures release reserved usage; possible or completed submissions remain charged.
- Raw cookies, CSRF tokens, origin pins, prompts, media, result URLs, and upstream identifiers never appear in admin responses or logs.
- New account sessions use only `data/accounts/<generated-id>/`; HTTP clients cannot select filesystem paths or upload credentials.
- Existing `data/auth` remains in place and is registered as the `legacy` account.
- The current total request queue limit remains global; account concurrency is enforced independently per runtime.
- Account deletion, downstream user management, RBAC, SSO, proxy pools, exports, alerts, billing, and advanced analytics are out of scope.

---

## File Map

### Persistence and domain

- Create `src/persistence/sqlite-store.ts`: own one SQLite connection, migration, immediate transactions, checkpoint, and close.
- Modify `src/jobs/schema.ts`: schema version 2 with accounts, budget entries, and account-bound jobs.
- Modify `src/jobs/types.ts`: add `accountId` and `quotedPoints` to durable jobs.
- Modify `src/jobs/sqlite-repository.ts`: consume `SqliteStore`, retain job transitions and backward-compatible path construction.
- Create `src/accounts/types.ts`: account, health, wallet, budget, and patch types.
- Create `src/accounts/sqlite-account-repository.ts`: account CRUD and sanitized runtime observations.
- Create `src/accounts/sqlite-admission-repository.ts`: atomic idempotency, account recheck, job insertion, and budget reservation.
- Create `src/accounts/budget.ts`: Shanghai window calculation and reservation state rules.

### Runtime and scheduling

- Create `src/accounts/quote.ts`: trusted quoted-point extraction.
- Create `src/accounts/runtime.ts`: account-bound session/transport/account/catalog/capacity/discovery runtime.
- Create `src/accounts/runtime-registry.ts`: lifecycle and refresh of enabled account runtimes.
- Create `src/accounts/scheduler.ts`: candidate filtering, ordering, and atomic admission retry.
- Modify `src/session/create-provider.ts`: accept account-specific resolved session paths.
- Modify `src/cli/login.ts`: support `--account-id` and fixed account directories.
- Modify `src/generation/coordinator.ts`: operate on the admitted account runtime and persist budget state transitions.
- Modify `src/generation/types.ts`, `src/jobs/recovery.ts`, `src/index.ts`, and `src/api/types.ts`: account-bound dependencies and lifecycle.

### Administration backend

- Create `src/admin/session.ts`: password verification, random sessions, expiry, and CSRF.
- Create `src/admin/schemas.ts`: Zod request/response contracts.
- Create `src/admin/routes.ts`: login, overview, account, job, and settings endpoints.
- Create `src/admin/static.ts`: admin assets and SPA fallback.
- Modify `src/config.ts`, `src/app.ts`, `src/errors.ts`, and `src/api/error-handler.ts`: admin configuration and routing.

### Administration frontend

- Create `admin/index.html`, `admin/vite.config.ts`, `admin/src/main.tsx`, `admin/src/app.tsx`, `admin/src/api.ts`, `admin/src/types.ts`, and focused page/component/style files.
- Modify `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `Dockerfile`, and `docker-compose.yml`: build and runtime wiring.

### Verification and documentation

- Create focused unit/integration/browser tests listed in each task.
- Modify `README.md`, `.env.example`, `docs/security.md`, and `docs/troubleshooting.md`.

---

### Task 1: Shared SQLite Store, Accounts, and Atomic Budgets

**Files:**

- Create: `src/persistence/sqlite-store.ts`
- Create: `src/accounts/types.ts`
- Create: `src/accounts/budget.ts`
- Create: `src/accounts/sqlite-account-repository.ts`
- Create: `src/accounts/sqlite-admission-repository.ts`
- Modify: `src/jobs/schema.ts`
- Modify: `src/jobs/types.ts`
- Modify: `src/jobs/sqlite-repository.ts`
- Test: `tests/unit/account-repository.test.ts`
- Test: `tests/unit/admission-repository.test.ts`
- Test: `tests/unit/job-repository.test.ts`

**Interfaces:**

- Produces:

```ts
export type AccountHealth =
  | "unknown"
  | "ready"
  | "needs_login"
  | "unhealthy";

export interface AccountRecord {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  dailyPointLimit: number;
  monthlyPointLimit: number;
  authDirectory: string;
  healthStatus: AccountHealth;
  lastErrorCode: string | null;
  subjectHash: string | null;
  pointsBalance: number | null;
  totalBalance: number | null;
  maxConcurrency: number | null;
  lastCheckedAt: number | null;
  lastSelectedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface BudgetWindow {
  dayWindowStart: number;
  monthWindowStart: number;
}

export interface AdmissionInput extends NewJob {
  accountId: string;
  quotedPoints: number;
  windows: BudgetWindow;
}

export type AdmissionResult =
  | { outcome: "created"; job: JobRecord }
  | { outcome: "existing"; job: JobRecord }
  | { outcome: "account_unavailable" }
  | { outcome: "budget_exhausted" };

export class SqliteStore {
  constructor(path: string);
  read<T>(operation: (database: Database.Database) => T): T;
  immediate<T>(operation: (database: Database.Database) => T): T;
  close(): void;
}

export class SqliteAccountRepository {
  constructor(store: SqliteStore);
  ensureLegacyAccount(authDirectory: string): AccountRecord;
  create(input: CreateAccountInput): AccountRecord;
  update(id: string, patch: UpdateAccountInput): AccountRecord;
  findById(id: string): AccountRecord | null;
  list(): AccountRecord[];
  recordObservation(id: string, observation: AccountObservation): AccountRecord;
  usage(id: string, windows: BudgetWindow): AccountBudgetUsage;
}

export class SqliteAdmissionRepository {
  constructor(store: SqliteStore);
  reserveOrGet(input: AdmissionInput): AdmissionResult;
  charge(jobId: string): void;
  releasePreSubmit(jobId: string): void;
}
```

- `JobRecord` gains required application fields `accountId: string` and
  `quotedPoints: number`.

- [ ] **Step 1: Write schema and account CRUD tests that fail**

Add tests that create a version-1 fixture database, open the new store, and
assert:

```ts
expect(accounts.ensureLegacyAccount("data/auth")).toMatchObject({
  id: "legacy",
  name: "Legacy account",
  enabled: true,
  authDirectory: "data/auth",
  dailyPointLimit: 0,
  monthlyPointLimit: 0
});
expect(accounts.create({
  name: "Backup",
  priority: 20,
  dailyPointLimit: 100,
  monthlyPointLimit: 1000
})).toMatchObject({
  name: "Backup",
  enabled: false,
  priority: 20,
  dailyPointLimit: 100,
  monthlyPointLimit: 1000
});
```

Also assert generated IDs match `/^acct_[0-9a-f]{24}$/u`, auth directories are
exactly `data/accounts/<id>`, duplicate names fail, negative/fractional limits
fail, and account APIs never accept an auth directory.

- [ ] **Step 2: Run the account repository tests and confirm the red state**

Run:

```powershell
npm test -- tests/unit/account-repository.test.ts
```

Expected: FAIL because `SqliteStore` and `SqliteAccountRepository` do not exist.

- [ ] **Step 3: Add the shared store and schema-v2 migration**

Implement `SqliteStore` by moving connection setup and bounded WAL checkpoint
logic out of `SqliteJobRepository`. Change `CURRENT_SCHEMA_VERSION` to `2`.
Migration 2 must:

```sql
ALTER TABLE jobs ADD COLUMN account_id TEXT;
ALTER TABLE jobs ADD COLUMN quoted_points REAL NOT NULL DEFAULT 0;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL CHECK (priority >= 0),
  daily_point_limit REAL NOT NULL CHECK (daily_point_limit >= 0),
  monthly_point_limit REAL NOT NULL CHECK (monthly_point_limit >= 0),
  auth_directory TEXT NOT NULL UNIQUE,
  health_status TEXT NOT NULL CHECK (
    health_status IN ('unknown', 'ready', 'needs_login', 'unhealthy')
  ),
  last_error_code TEXT,
  subject_hash TEXT,
  points_balance REAL,
  total_balance REAL,
  max_concurrency INTEGER,
  last_checked_at INTEGER,
  last_selected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE budget_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  quoted_points REAL NOT NULL CHECK (quoted_points >= 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'charged', 'released')),
  day_window_start INTEGER NOT NULL,
  month_window_start INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX budget_entries_account_day_idx
ON budget_entries(account_id, day_window_start, state);

CREATE INDEX budget_entries_account_month_idx
ON budget_entries(account_id, month_window_start, state);
```

Insert `legacy`, set every existing null `jobs.account_id` to `legacy`, and
create zero-point charged budget entries for existing jobs. Keep the physical
column nullable for SQLite additive migration safety.

- [ ] **Step 4: Implement account repository validation and mapping**

Use exact integer booleans, reject non-safe integer priorities, reject
non-finite/fractional/negative point limits, and allow patching only:

```ts
export interface UpdateAccountInput {
  name?: string;
  enabled?: boolean;
  priority?: number;
  dailyPointLimit?: number;
  monthlyPointLimit?: number;
}
```

No secret or path field belongs to either create or update input.

- [ ] **Step 5: Run account and existing job tests**

Run:

```powershell
npm test -- tests/unit/account-repository.test.ts tests/unit/job-repository.test.ts
```

Expected: PASS. Existing version-1 job behavior remains green after backfill.

- [ ] **Step 6: Write atomic admission tests that fail**

Create a ready account with a daily limit of `10`. Start two independent
`SqliteStore` connections to the same file and attempt two 7-point admissions
at the same time. Assert exactly one result is `created`, the other is
`budget_exhausted`, and non-released usage equals `7`.

Add cases for:

```ts
expect(secondReplay.outcome).toBe("existing");
expect(accounts.usage(account.id, windows).dayUsedPoints).toBe(7);

admissions.releasePreSubmit(created.job.id);
expect(accounts.usage(account.id, windows).dayUsedPoints).toBe(0);

admissions.charge(created.job.id);
admissions.releasePreSubmit(created.job.id);
expect(accounts.usage(account.id, windows).dayUsedPoints).toBe(7);
```

- [ ] **Step 7: Run admission tests and confirm the red state**

Run:

```powershell
npm test -- tests/unit/admission-repository.test.ts
```

Expected: FAIL because reservation methods are not implemented.

- [ ] **Step 8: Implement Shanghai windows and atomic admission**

`budgetWindows(now)` must compute midnight on day one and midnight today in
`Asia/Shanghai`, then return UTC epoch milliseconds. Test DST-independent
examples such as `2026-07-24T03:00:00Z`.

`reserveOrGet` must execute in `store.immediate(...)`, check idempotency before
budget accounting, re-read the account, require `enabled = 1` and
`health_status = 'ready'`, sum `reserved` plus `charged`, enforce both non-zero
limits, insert the job and budget row, and update `last_selected_at`.

- [ ] **Step 9: Run persistence tests and commit**

Run:

```powershell
npm test -- tests/unit/account-repository.test.ts tests/unit/admission-repository.test.ts tests/unit/job-repository.test.ts
npm run typecheck
```

Expected: all selected tests PASS and TypeScript exits `0`.

Commit:

```powershell
git add src/persistence src/accounts src/jobs tests/unit/account-repository.test.ts tests/unit/admission-repository.test.ts tests/unit/job-repository.test.ts
git commit -m "feat: add account and budget persistence"
```

---

### Task 2: Trusted Quotes, Account Runtimes, and Login Paths

**Files:**

- Create: `src/accounts/quote.ts`
- Create: `src/accounts/runtime.ts`
- Create: `src/accounts/runtime-registry.ts`
- Modify: `src/session/create-provider.ts`
- Modify: `src/cli/login.ts`
- Modify: `src/config.ts`
- Test: `tests/unit/quote.test.ts`
- Test: `tests/unit/account-runtime-registry.test.ts`
- Test: `tests/unit/login.test.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**

- Consumes: `AccountRecord`, `SqliteAccountRepository`, `SqliteStore`.
- Produces:

```ts
export function quotedPoints(
  model: NormalizedModel,
  values: Record<string, unknown>
): number | null;

export interface AccountRuntime {
  record: AccountRecord;
  session: SessionProvider;
  transport: LingjingTransport;
  account: AccountService;
  catalog: CatalogService;
  capacity: CapacityManager;
  discoveryLock: DiscoveryLock;
}

export class AccountRuntimeRegistry {
  constructor(options: AccountRuntimeRegistryOptions);
  ready(): Promise<void>;
  listEnabled(): AccountRuntime[];
  require(accountId: string): AccountRuntime;
  refresh(accountId: string): Promise<AccountRuntime | null>;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write quote extraction tests that fail**

Cover fixed and parameterized trusted forms already seen in model metadata:

```ts
expect(quotedPoints(model({ pricing: {
  billingType: "fixed",
  unit: "points",
  points: 7
}}), {})).toBe(7);

expect(quotedPoints(model({
  pricing: null,
  priceQuerySchema: {
    duration: { source: "duration", prices: { "5": 12, "10": 20 } }
  }
}), { duration: 10 })).toBe(20);

expect(quotedPoints(model({ pricing: { amount: 7, unit: "USD" } }), {}))
  .toBeNull();
expect(quotedPoints(model({ pricing: null }), {})).toBeNull();
```

Reject negative, non-finite, mixed-currency, ambiguous, and missing parameter
prices.

- [ ] **Step 2: Run quote tests and confirm the red state**

Run:

```powershell
npm test -- tests/unit/quote.test.ts
```

Expected: FAIL because `quotedPoints` does not exist.

- [ ] **Step 3: Implement a strict quote extractor**

Move only the relevant trusted-point parsing behavior from
`tests/live/live-helpers.ts` into production. Accept explicit point units and
deterministic parameter price tables. Never guess from an unlabeled arbitrary
number. Return `null` when one unambiguous non-negative finite point value
cannot be proven.

- [ ] **Step 4: Write runtime registry and account-path tests that fail**

Use two temporary account rows with separate fixture session files and injected
transport factories. Assert:

```ts
await registry.ready();
expect(registry.listEnabled().map((runtime) => runtime.record.id))
  .toEqual(["legacy", second.id]);
expect(registry.require("legacy").session)
  .not.toBe(registry.require(second.id).session);
await registry.refresh(second.id);
expect(transportFactory).toHaveBeenCalledTimes(3);
```

For the CLI parser assert:

```ts
expect(parseLoginArguments(["--account-id", "acct_0123456789abcdef01234567"]))
  .toEqual({ accountId: "acct_0123456789abcdef01234567" });
expect(() => parseLoginArguments(["--account-id", "../../escape"]))
  .toThrow("Invalid account ID");
```

- [ ] **Step 5: Run runtime/login tests and confirm the red state**

Run:

```powershell
npm test -- tests/unit/account-runtime-registry.test.ts tests/unit/login.test.ts tests/unit/config.test.ts
```

Expected: FAIL on missing registry and account argument behavior.

- [ ] **Step 6: Implement account-specific session resolution**

Keep current legacy paths. For generated accounts resolve exactly:

```ts
{
  storageStatePath: join(dataDirectory, "accounts", accountId, "storage-state.json"),
  cookieFilePath: join(dataDirectory, "accounts", accountId, "cookie.txt"),
  sessionProfilePath: join(dataDirectory, "accounts", accountId, "session-profile.json")
}
```

Validate the ID before path construction. Do not call `resolve` on a
client-supplied path. The login CLI creates only the generated account
directory and uses existing atomic session writes.

- [ ] **Step 7: Implement runtime registry health loading**

At `ready()`, create runtimes for enabled accounts. A successful
`account.describe()` records `ready`, subject hash, wallet values, and bounded
upstream concurrency. Missing/invalid session records `needs_login`; other
failures record `unhealthy` with a sanitized error code. Startup must continue
when one account is unhealthy, but must fail if the repository itself fails.

- [ ] **Step 8: Run runtime tests and commit**

Run:

```powershell
npm test -- tests/unit/quote.test.ts tests/unit/account-runtime-registry.test.ts tests/unit/login.test.ts tests/unit/config.test.ts
npm run typecheck
```

Expected: all selected tests PASS and TypeScript exits `0`.

Commit:

```powershell
git add src/accounts src/session/create-provider.ts src/cli/login.ts src/config.ts tests/unit/quote.test.ts tests/unit/account-runtime-registry.test.ts tests/unit/login.test.ts tests/unit/config.test.ts
git commit -m "feat: add isolated account runtimes"
```

---

### Task 3: Scheduler and Account-Bound Generation

**Files:**

- Create: `src/accounts/scheduler.ts`
- Modify: `src/generation/coordinator.ts`
- Modify: `src/generation/types.ts`
- Modify: `src/generation/runner-registry.ts`
- Modify: `src/jobs/recovery.ts`
- Modify: `src/index.ts`
- Modify: `src/api/types.ts`
- Test: `tests/unit/account-scheduler.test.ts`
- Test: `tests/unit/coordinator.test.ts`
- Test: `tests/integration/restart.test.ts`
- Test: `tests/integration/concurrency.test.ts`
- Modify: `tests/helpers/generation-harness.ts`
- Modify: `tests/helpers/test-app.ts`

**Interfaces:**

- Consumes: `AccountRuntimeRegistry`, `SqliteAdmissionRepository`,
  `quotedPoints`, `budgetWindows`.
- Produces:

```ts
export interface AccountAdmission {
  runtime: AccountRuntime;
  model: NormalizedModel;
  job: JobRecord;
  lease: CapacityLease;
  created: boolean;
}

export class AccountScheduler {
  constructor(options: AccountSchedulerOptions);
  admit(input: {
    request: GenerationRequest;
    requestFingerprint: string;
    idempotencyKeyHash: string | null;
  }): Promise<AccountAdmission>;
  restore(job: JobRecord): AccountRuntime;
}
```

- [ ] **Step 1: Write deterministic scheduler tests that fail**

Create three fake ready runtimes and assert the scheduler chooses lower
priority, then fewer active jobs, then older selection time. Add cases for
disabled, unhealthy, unsupported-model, insufficient wallet, account
concurrency exhausted, daily budget exhausted, monthly budget exhausted, and
unknown quote.

Assert a transaction race retries the next candidate:

```ts
admissions.reserveOrGet
  .mockReturnValueOnce({ outcome: "budget_exhausted" })
  .mockReturnValueOnce({ outcome: "created", job });
await expect(scheduler.admit(input)).resolves.toMatchObject({
  runtime: { record: { id: "acct_second" } }
});
```

- [ ] **Step 2: Run scheduler tests and confirm the red state**

Run:

```powershell
npm test -- tests/unit/account-scheduler.test.ts
```

Expected: FAIL because `AccountScheduler` does not exist.

- [ ] **Step 3: Implement scheduler candidate evaluation**

Resolve the requested model independently per runtime. Validate request media
against that model. Derive a trusted quote. Read budget usage and wallet. Sort
eligible candidates by the specified stable ordering. Acquire the candidate's
capacity admission before calling `reserveOrGet`; release it when the
transaction rejects and continue to the next candidate.

Map terminal no-candidate states to:

```ts
errors.noEligibleAccount();      // account/session/model/budget failure
errors.capacityExhausted();      // only temporary capacity blocked
```

Both responses are sanitized `429` errors.

- [ ] **Step 4: Write coordinator account-binding tests that fail**

Update the generation harness with two transports. Assert:

- Submission, upload, discovery, and polling use only the admitted runtime.
- `job.accountId` never changes.
- Pre-submit validation/upload failures call `releasePreSubmit(job.id)`.
- Accepted or ambiguous submissions call `charge(job.id)` exactly once.
- An idempotent replay returns the original account and creates no runner.
- Recovery requires `registry.require(job.accountId)` and never chooses again.

- [ ] **Step 5: Run coordinator/restart tests and confirm the red state**

Run:

```powershell
npm test -- tests/unit/coordinator.test.ts tests/integration/restart.test.ts tests/integration/concurrency.test.ts
```

Expected: FAIL until the coordinator consumes `AccountAdmission`.

- [ ] **Step 6: Refactor the coordinator around admitted runtime**

Preserve media preparation and request fingerprint behavior. Replace global
account/catalog/transport/capacity/discovery dependencies with the scheduler
admission. Pass the selected runtime into `runInitial`, `runPostSubmit`,
discovery, polling, and recovery. Charge immediately before `submitOnce`; if a
failure occurs before that point, release. An ambiguous submit remains charged.

Register runner identity as `job.id`; account identity remains durable in the
job record and need not be encoded in runner keys.

- [ ] **Step 7: Wire application startup and shutdown**

`startServer` must:

1. Open one `SqliteStore`.
2. Ensure the legacy account using `data/auth`.
3. Construct job, account, and admission repositories on the store.
4. Initialize the runtime registry.
5. Construct the scheduler and coordinator.
6. Run account-bound recovery before listening.

Shutdown stops new admissions, drains runners, stops pollers, closes account
runtimes, and closes the shared store once.

- [ ] **Step 8: Run generation regression tests and commit**

Run:

```powershell
npm test -- tests/unit/account-scheduler.test.ts tests/unit/coordinator.test.ts tests/integration/restart.test.ts tests/integration/concurrency.test.ts tests/integration/images-api.test.ts tests/integration/videos-api.test.ts tests/integration/chat-api.test.ts
npm run typecheck
```

Expected: all selected tests PASS and TypeScript exits `0`.

Commit:

```powershell
git add src/accounts/scheduler.ts src/generation src/jobs/recovery.ts src/index.ts src/api/types.ts src/errors.ts tests/unit/account-scheduler.test.ts tests/unit/coordinator.test.ts tests/integration/restart.test.ts tests/integration/concurrency.test.ts tests/helpers
git commit -m "feat: schedule generation across budgeted accounts"
```

---

### Task 4: Administrator Authentication and API

**Files:**

- Create: `src/admin/session.ts`
- Create: `src/admin/schemas.ts`
- Create: `src/admin/routes.ts`
- Modify: `src/config.ts`
- Modify: `src/app.ts`
- Modify: `src/api/types.ts`
- Modify: `src/errors.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/unit/admin-session.test.ts`
- Test: `tests/integration/admin-api.test.ts`
- Test: `tests/integration/security-regression.test.ts`
- Modify: `tests/helpers/test-app.ts`

**Interfaces:**

- Produces:

```ts
export interface AdminSession {
  id: string;
  readonly csrfToken: string;
  expiresAt: number;
}

export class AdminSessionStore {
  constructor(options: {
    password: string;
    ttlMs?: number;
    now?: () => number;
  });
  login(password: string): AdminSession | null;
  authenticate(sessionId: string | undefined): AdminSession | null;
  logout(sessionId: string | undefined): void;
  assertCsrf(session: AdminSession, token: string | undefined): void;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  dependencies: AdminDependencies
): Promise<void>;
```

- [ ] **Step 1: Write administrator session tests that fail**

Assert constant-time password comparison behavior through results, random
32-byte-url-safe session IDs and CSRF tokens, 8-hour expiry, logout, and no
password/session/token in JSON serialization or logs.

```ts
expect(store.login("wrong")).toBeNull();
const session = store.login("correct");
expect(session?.id).toMatch(/^[A-Za-z0-9_-]{43}$/u);
expect(store.authenticate(session?.id)).toEqual(session);
expect(() => store.assertCsrf(session!, "wrong")).toThrow();
```

- [ ] **Step 2: Run session tests and confirm the red state**

Run:

```powershell
npm test -- tests/unit/admin-session.test.ts
```

Expected: FAIL because the admin session store does not exist.

- [ ] **Step 3: Implement bounded in-memory sessions**

Use `timingSafeEqual` on fixed SHA-256 password digests. Store only random
session IDs, CSRF tokens, and expiry. Prune expired entries on login and
authentication. Never log submitted passwords or tokens.

Install and register the cookie parser used by these routes:

```powershell
npm install @fastify/cookie
```

- [ ] **Step 4: Write admin API integration tests that fail**

Build an app with `LINGJING_ADMIN_PASSWORD=fixture-admin-password`. Test:

```ts
POST /admin/api/login
GET  /admin/api/session
GET  /admin/api/overview
GET  /admin/api/accounts
POST /admin/api/accounts
PATCH /admin/api/accounts/:id
POST /admin/api/accounts/:id/check
POST /admin/api/accounts/:id/enable
POST /admin/api/accounts/:id/disable
POST /admin/api/accounts/:id/resolve-unknown
GET  /admin/api/jobs
GET  /admin/api/jobs/:id
GET  /admin/api/settings
POST /admin/api/logout
```

Assert cookie attributes include `HttpOnly`, `SameSite=Strict`, `Path=/admin`,
and `Secure` when the request is HTTPS. State-changing requests without the
session's `X-CSRF-Token` return `403`. Account create/update bodies reject
unknown fields, auth paths, cookies, and credentials. All responses pass the
secret scanner.

- [ ] **Step 5: Run admin API tests and confirm the red state**

Run:

```powershell
npm test -- tests/integration/admin-api.test.ts tests/integration/security-regression.test.ts
```

Expected: FAIL because admin routes are absent.

- [ ] **Step 6: Implement admin schemas and route hooks**

Admin mode is enabled only when trimmed `LINGJING_ADMIN_PASSWORD` is non-empty.
When disabled, `/admin` and `/admin/api/*` return `404`, not generation API
authentication errors.

Protect all non-login routes with an admin session hook. Protect non-GET/HEAD
routes with CSRF. Return account views containing only:

```ts
{
  id, name, enabled, priority,
  daily_point_limit, monthly_point_limit,
  daily_used_points, monthly_used_points,
  daily_reserved_points, monthly_reserved_points,
  health_status, last_error_code, has_session,
  subject_hash, points_balance, total_balance,
  max_concurrency, active_jobs,
  last_checked_at, updated_at
}
```

`POST /accounts` returns a `login_command` constructed from the generated ID.
`check` refreshes only that runtime. `resolve-unknown` requires a body
`{ action: "charge" | "release" }` and a specific `job_id`; it can affect only
an unknown job bound to the account.

- [ ] **Step 7: Run admin and full backend tests, then commit**

Run:

```powershell
npm test -- tests/unit/admin-session.test.ts tests/integration/admin-api.test.ts tests/integration/security-regression.test.ts
npm test
npm run lint
npm run typecheck
```

Expected: all commands exit `0`.

Commit:

```powershell
git add src/admin src/config.ts src/app.ts src/api/types.ts src/errors.ts tests/unit/admin-session.test.ts tests/integration/admin-api.test.ts tests/integration/security-regression.test.ts tests/helpers/test-app.ts
git commit -m "feat: add secure account administration api"
```

---

### Task 5: Same-Origin React Administration Console

**Files:**

- Create: `admin/index.html`
- Create: `admin/vite.config.ts`
- Create: `admin/src/main.tsx`
- Create: `admin/src/app.tsx`
- Create: `admin/src/api.ts`
- Create: `admin/src/types.ts`
- Create: `admin/src/styles.css`
- Create: `admin/src/components/app-shell.tsx`
- Create: `admin/src/components/status-pill.tsx`
- Create: `admin/src/components/budget-meter.tsx`
- Create: `admin/src/components/account-dialog.tsx`
- Create: `admin/src/pages/login-page.tsx`
- Create: `admin/src/pages/overview-page.tsx`
- Create: `admin/src/pages/accounts-page.tsx`
- Create: `admin/src/pages/tasks-page.tsx`
- Create: `admin/src/pages/settings-page.tsx`
- Create: `src/admin/static.ts`
- Modify: `src/app.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `eslint.config.js`
- Test: `tests/integration/admin-static.test.ts`
- Test: `tests/browser/admin.browser.test.ts`

**Interfaces:**

- Consumes the Task 4 `/admin/api` contract.
- Produces `dist/admin/index.html` plus hashed assets and serves them under
  `/admin/`.

- [ ] **Step 1: Add failing static and browser tests**

Static integration assertions:

```ts
expect((await app.inject("/admin/")).statusCode).toBe(200);
expect((await app.inject("/admin/accounts")).headers["content-type"])
  .toContain("text/html");
expect((await app.inject("/assets/not-admin.js")).statusCode).toBe(404);
expect((await app.inject("/admin/api/accounts")).statusCode).toBe(401);
```

Browser test at 1440×900 and 390×844:

1. Login.
2. Create a disabled account with daily/monthly limits.
3. Copy its login command.
4. Edit limits and priority.
5. Enable and disable it.
6. Confirm overview totals and task filters.
7. Confirm no horizontal page overflow at either viewport.

- [ ] **Step 2: Run tests and confirm the red state**

Run:

```powershell
npm test -- tests/integration/admin-static.test.ts
npx playwright test tests/browser/admin.browser.test.ts
```

Expected: FAIL because no admin bundle or static routes exist.

- [ ] **Step 3: Add the frontend toolchain and production build**

Install exact project-compatible dependencies:

```powershell
npm install react react-dom @fastify/static
npm install --save-dev vite @vitejs/plugin-react @types/react @types/react-dom
```

Add scripts:

```json
{
  "build:server": "tsc -p tsconfig.build.json",
  "build:admin": "vite build --config admin/vite.config.ts",
  "build": "npm run build:server && npm run build:admin"
}
```

Configure Vite root as `admin`, base as `/admin/`, and output as
`../dist/admin` without deleting server output.

- [ ] **Step 4: Implement the API client and authentication flow**

`admin/src/api.ts` must use `credentials: "same-origin"`, keep the CSRF token
only in React memory, attach it to state-changing requests, map non-2xx JSON
errors to one typed `ApiError`, and redirect to login on `401`.

Do not use `localStorage`, `sessionStorage`, URL credentials, or console logging
of response bodies.

- [ ] **Step 5: Implement the dense operational UI**

Use semantic HTML and accessible native controls. Implement:

- Graphite shell with 224px desktop sidebar and compact mobile header.
- Cyan only for primary actions and current navigation.
- Green/amber/red status pills with icon/text in addition to color.
- Overview cards for ready/unhealthy/exhausted accounts, today/month usage, and
  active jobs.
- Account table/cards showing wallet separately from daily/month budgets.
- Create/edit dialog with name, priority, daily limit, and monthly limit.
- Explicit confirmation for disabling an account with active jobs.
- Task filters for account, kind, and status.
- Settings view with masked shared API status and copyable login commands.
- Loading skeleton, empty state, inline validation, and retryable error state.

Do not add charting, animation libraries, gradients, glass effects, marketing
copy, theme switching, or speculative settings.

- [ ] **Step 6: Serve static assets without weakening API auth**

Register `@fastify/static` only when admin mode is enabled and the bundle
exists. Serve `/admin/assets/*` immutably, `/admin/` and known client routes with
`no-store`, and use an allowlist SPA fallback:

```ts
const ADMIN_CLIENT_ROUTES = new Set([
  "/admin",
  "/admin/",
  "/admin/accounts",
  "/admin/tasks",
  "/admin/settings"
]);
```

Never fallback for `/admin/api/*` or arbitrary missing paths.

- [ ] **Step 7: Build and run UI verification**

Run:

```powershell
npm run build
npm test -- tests/integration/admin-static.test.ts
npx playwright test tests/browser/admin.browser.test.ts
npm run lint
npm run typecheck
```

Expected: build emits `dist/index.js` and `dist/admin/index.html`; all tests and
checks exit `0`.

- [ ] **Step 8: Commit the admin console**

Commit:

```powershell
git add admin src/admin/static.ts src/app.ts package.json package-lock.json tsconfig.json eslint.config.js tests/integration/admin-static.test.ts tests/browser/admin.browser.test.ts
git commit -m "feat: add multi-account admin console"
```

---

### Task 6: Docker, Documentation, and End-to-End Acceptance

**Files:**

- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.dockerignore`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/security.md`
- Modify: `docs/troubleshooting.md`
- Create: `tests/integration/admin-lifecycle.test.ts`
- Modify: `tests/live/image.live.test.ts`
- Modify: `tests/live/video.live.test.ts`

**Interfaces:**

- Consumes all prior tasks.
- Produces one Docker image containing server and admin assets and one persisted
  `data/` volume holding SQLite plus account sessions.

- [ ] **Step 1: Add a failing lifecycle acceptance test**

The integration test must:

1. Start with a version-1 database and fixture legacy session.
2. Confirm legacy account migration.
3. Create a second disabled account via admin API.
4. Configure a 7-point daily/monthly budget.
5. Race two 7-point generation requests and assert one upstream submission.
6. Restart the app against the same database.
7. Confirm account, usage, job binding, and budget state persist.
8. Confirm image and video compatibility endpoints retain their response shape.

- [ ] **Step 2: Run lifecycle acceptance and confirm the red state**

Run:

```powershell
npm test -- tests/integration/admin-lifecycle.test.ts
```

Expected: FAIL on any remaining migration, restart, or wiring gap.

- [ ] **Step 3: Fix only lifecycle-blocking defects**

Make the smallest changes required for the eight acceptance assertions. Do not
add alerts, exports, roles, deletion, theme settings, or aggregate
multi-instance coordination.

- [ ] **Step 4: Update Docker build and configuration**

The build stage must run the combined `npm run build` and copy both server and
admin output into the runtime image. Compose adds:

```yaml
LINGJING_ADMIN_PASSWORD: ${LINGJING_ADMIN_PASSWORD:-}
LINGJING_DATA_DIRECTORY: /app/data
```

Keep the localhost-only port mapping, dropped capabilities, no-new-privileges,
non-root runtime user, and existing `./data:/app/data` volume.

- [ ] **Step 5: Document operator workflows and security**

Document:

```powershell
$env:LINGJING_ADMIN_PASSWORD = 'change-me'
docker compose up -d --build
Start-Process 'http://127.0.0.1:8000/admin/'
npm run login -- --account-id acct_0123456789abcdef01234567
```

Explain quoted-point accounting, `0 = unlimited`, Shanghai reset windows,
reservation release/charge rules, legacy account behavior, session directory
permissions, admin password separation, backup of SQLite plus account session
directories, and recovery of `needs_login`.

- [ ] **Step 6: Run the complete local quality gate**

Run:

```powershell
npm run check
npm run build
```

Expected: lint, typecheck, all non-live tests, server build, and admin build exit
`0`.

- [ ] **Step 7: Build and verify Docker**

Run:

```powershell
docker compose build --pull
docker compose up -d
docker compose ps
docker compose exec -T lingjing-free-api node -e "fetch('http://127.0.0.1:8000/healthz').then(async r=>{console.log(r.status,await r.text());if(!r.ok)process.exit(1)})"
```

Expected: service is `running (healthy)` and health request returns `200`.

Verify the admin UI through Playwright against
`http://127.0.0.1:8000/admin/`, including create/edit/enable/disable and budget
exhaustion.

- [ ] **Step 8: Run real image and video acceptance**

With the already authenticated legacy account and explicit live flags:

```powershell
$env:LIVE_TEST = '1'
$env:LIVE_VIDEO_TEST = '1'
npm run test:live -- tests/live/image.live.test.ts tests/live/video.live.test.ts
```

Expected: one real image and one real video flow complete; each job is bound to
`legacy`; its quoted usage is visible in the admin API; no secret scanner
failure occurs. If the upstream platform is unavailable, retain the passing
mock/integration evidence and report the exact external blocker without
claiming live success.

- [ ] **Step 9: Restart persistence verification**

Run:

```powershell
docker compose restart lingjing-free-api
docker compose ps
```

Then confirm via the admin API that accounts, budgets, usage, and the two job
bindings remain. Expected: container returns to `healthy` and persisted values
match before restart.

- [ ] **Step 10: Commit the verified MVP**

Commit only project files, never `.env`, `data/`, `outputs/`, generated media,
or unrelated workspace artifacts:

```powershell
git add lingjing-free-api/Dockerfile lingjing-free-api/docker-compose.yml lingjing-free-api/README.md lingjing-free-api/docs lingjing-free-api/tests
git commit -m "docs: complete multi-account admin operations"
```

---

### Task 7: Final Review and GitHub Delivery

**Files:**

- Review all files changed since the design commit.
- Do not modify unrelated root artifacts:
  `farm_battle.mp4`, `farm_battle.sample`, `farm_battle_analysis/`, or
  `lingjing-free-api/outputs/`.

**Interfaces:**

- Produces the final reviewed Git history and updated public GitHub `main`.

- [ ] **Step 1: Run secret and tracked-artifact checks**

Run:

```powershell
git status --short
git diff --check 0fbcccc..HEAD
git ls-files lingjing-free-api/data lingjing-free-api/outputs lingjing-free-api/.env
```

Expected: diff check exits `0`; the tracked secret/media query prints nothing.

- [ ] **Step 2: Run final quality and Docker gates**

Run:

```powershell
Set-Location lingjing-free-api
npm run check
npm run build
docker compose ps
```

Expected: all checks exit `0` and Docker service is healthy.

- [ ] **Step 3: Perform two-stage review**

First verify exact conformance to
`docs/superpowers/specs/2026-07-24-multi-account-admin-design.md`; then review
code quality, concurrency safety, secret handling, and regression risk.
Immediately fix only blockers, security/data-integrity defects, or failures of
the stated completion criteria. Re-run affected tests after each fix.

- [ ] **Step 4: Push the subtree to public GitHub main**

The Git repository root contains other workspace content, so create a fresh
subtree split and force-with-lease only against the known remote main:

```powershell
$expectedMain = git ls-remote origin refs/heads/main |
  ForEach-Object { ($_ -split "`t")[0] }
$splitCommit = git subtree split --prefix=lingjing-free-api HEAD
git push --force-with-lease="refs/heads/main:$expectedMain" origin "${splitCommit}:refs/heads/main"
```

Expected: push succeeds and updates only `origin/main`. Do not use an
unconditional force.

- [ ] **Step 5: Verify the public repository**

Run:

```powershell
gh repo view tianc43/lingjing-free-api --json url,visibility,defaultBranchRef
git ls-remote origin refs/heads/main
```

Expected: repository is `PUBLIC`, default branch is `main`, and the remote hash
equals the subtree split commit.

---

## Plan Self-Review

- Every included design requirement maps to a task: persistence and migration
  (Task 1), isolated runtimes and authentication paths (Task 2), scheduling and
  generation/recovery binding (Task 3), administrator security and APIs
  (Task 4), responsive same-origin UI (Task 5), Docker/live acceptance and
  operator docs (Task 6), and secure delivery (Task 7).
- No account deletion, downstream identities, RBAC, OAuth onboarding, proxy
  pools, exports, alerts, billing, or advanced analytics task is present.
- Shared types and signatures used by later tasks are defined by earlier tasks.
- Each implementation task begins with a failing test, verifies the red state,
  implements the minimum behavior, verifies green, and commits independently.
