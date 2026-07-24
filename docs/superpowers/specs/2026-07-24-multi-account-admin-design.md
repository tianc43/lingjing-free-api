# Lingjing Multi-Account Admin MVP Design

## Goal

Add a same-repository administration console that manages multiple upstream
JD Cloud Lingjing accounts and enforces a daily and monthly quoted-point budget
per account. Existing API clients continue to use the single shared
`LINGJING_API_KEY`.

The MVP is complete when an operator can create, edit, enable, disable, inspect,
and re-login an upstream account; generation requests are durably bound to one
eligible account; concurrent requests cannot exceed that account's configured
budgets; the existing single-account installation migrates without losing its
session; and the Docker deployment passes account-management plus image/video
end-to-end verification.

## Scope

### Included

- Multiple Lingjing upstream accounts.
- Per-account name, enabled state, priority, daily quoted-point limit, and
  monthly quoted-point limit.
- Per-account session files, health state, current wallet snapshot, concurrency
  state, and budget usage.
- Atomic account selection, job creation, and budget reservation in SQLite.
- Same-origin React administration console served by Fastify.
- Independent administrator authentication.
- Migration of the current `data/auth` session into an account named `legacy`.
- Existing image, video, chat, task, model, and account compatibility routes.

### Later

- Multiple downstream users or API keys and their budgets.
- Role-based access control, SSO, OAuth account onboarding, and proxy pools.
- Billing settlement, invoices, advanced analytics, exports, and alerting.

## Considered Approaches

### A. SQLite orchestration with one runtime per account — selected

Persist accounts, jobs, reservations, and usage in the existing SQLite
database. Construct an isolated session, transport, account service, catalog,
capacity manager, and discovery lock for each enabled account. Build a compact
Vite/React console and serve its production assets from Fastify.

This is the smallest design that remains correct across concurrency and
restarts, preserves the current deployment model, and provides a maintainable
administration UI.

### B. Configuration files and in-memory accounting

This is faster to prototype, but budget counters can be lost on restart and
concurrent requests can overspend. It does not meet the budget-management
requirement.

### C. Separate administration service and database

This provides stronger long-term separation but adds deployment, networking,
and consistency work that the current single-node product does not need.

## Architecture

### Persistent account repository

`AccountRepository` owns account configuration and runtime observations:

- Stable generated account ID.
- Operator-defined display name.
- Enabled flag and integer priority.
- Daily and monthly point limits, where `0` means unlimited.
- Session mode and a fixed relative authentication directory.
- Last health status, last sanitized subject, wallet balance, last error code,
  and timestamps.

Secrets and raw upstream identity are never stored in account rows. Each
account's authentication files live under `data/accounts/<account-id>/`.

### Account runtime registry

`AccountRuntimeRegistry` creates and caches an isolated runtime for each enabled
account:

- `SessionProvider`
- `LingjingClient`
- `AccountService`
- `CatalogService`
- `CapacityManager`
- `DiscoveryLock`

Disabling an account stops new admissions but does not interrupt an already
submitted job. Runtime refresh is explicit after configuration or session
changes. A job always resumes with its original account.

### Scheduler and budget service

`AccountScheduler` asks each eligible runtime for the requested model and a
trusted quoted-point estimate. Eligible accounts must be enabled, have a valid
session, support the requested model, have concurrency capacity, have sufficient
known wallet balance, and have sufficient daily and monthly budget remaining.

Candidates are ordered by:

1. Lower numeric priority.
2. Lower current active job count.
3. Older last-selected timestamp.
4. Stable account ID tie-breaker.

`BudgetService` performs selection finalization inside a SQLite
`BEGIN IMMEDIATE` transaction. The transaction rechecks enabled state and
available budget, creates or reuses the idempotent job, binds `account_id`, and
creates exactly one reservation. This prevents two concurrent requests from
spending the same remaining budget.

### Quoted-point accounting

Budget usage is based on the trusted point quote derived from the selected
model metadata and request parameters, not on a wallet balance delta. Balance
deltas cannot be assigned reliably when an account has concurrent jobs.

- A limit of `0` is unlimited.
- A budgeted account cannot accept a request whose quote is unknown or
  ambiguous.
- A newly created job reserves its full quote.
- An idempotent replay reuses the existing job and reservation.
- A failure proven to occur before upstream submission releases the
  reservation.
- Once submission may have occurred, the reservation becomes charged usage and
  is not refunded.
- Unknown jobs retain their reservation until they become terminal or an
  administrator explicitly resolves them.
- Day and month windows use `Asia/Shanghai` calendar boundaries and store their
  explicit start timestamps, so process timezone changes cannot alter usage.

### Generation coordinator

The current single-account coordinator becomes account-bound at admission.
Media preparation may remain shared, but every upstream action after binding
uses the selected account runtime. `jobs.account_id` is required for all new
jobs and is read during recovery, polling, discovery, model lookup, and result
normalization.

The existing API shape does not change. If no account is eligible, clients
receive a sanitized `429` error distinguishing temporary capacity exhaustion
from account/budget exhaustion without exposing account details.

## Database Migration

Schema version 2 adds:

### `accounts`

- `id` primary key.
- `name`, `enabled`, `priority`.
- `daily_point_limit`, `monthly_point_limit`.
- `auth_directory`.
- `health_status`, `last_error_code`.
- `subject_hash`, wallet summary fields.
- `last_checked_at`, `last_selected_at`, `created_at`, `updated_at`.

### `budget_entries`

- `id` primary key.
- `account_id`, `job_id`.
- `quoted_points`.
- `state`: `reserved`, `charged`, or `released`.
- `day_window_start`, `month_window_start`.
- `created_at`, `updated_at`.

There is one budget entry per job. Indexed sums over non-released rows enforce
both windows.

### Existing `jobs`

Add nullable `account_id` and `quoted_points` columns first. Migration creates
the `legacy` account and assigns all existing jobs to it. After backfill, all
new repository methods require an account ID. SQLite retains the nullable
physical column for a safe additive migration, while application invariants
reject new null values.

On first startup, if `data/auth` exists and no legacy account session exists,
the service moves no files automatically. It records the legacy account with
`auth_directory = data/auth`, preserving the existing mounted path and allowing
an operator to migrate files later without a risky startup mutation.

## Administration API

All endpoints are under `/admin/api` and require a separate administrator
session.

### Authentication

- `POST /admin/api/login`
- `POST /admin/api/logout`
- `GET /admin/api/session`

`LINGJING_ADMIN_PASSWORD` is required when the admin console is enabled. Login
sets a signed, `HttpOnly`, `SameSite=Strict` cookie. State-changing requests
also require a same-origin CSRF header issued with the session. Sessions are
memory-backed in the MVP, so a restart requires re-login.

### Dashboard

- `GET /admin/api/overview`

Returns counts for enabled, ready, unhealthy, and budget-exhausted accounts;
aggregate quoted usage; active/queued tasks; and recent sanitized failures.

### Accounts

- `GET /admin/api/accounts`
- `POST /admin/api/accounts`
- `GET /admin/api/accounts/:id`
- `PATCH /admin/api/accounts/:id`
- `POST /admin/api/accounts/:id/check`
- `POST /admin/api/accounts/:id/enable`
- `POST /admin/api/accounts/:id/disable`
- `POST /admin/api/accounts/:id/resolve-unknown`

Responses expose `has_session` and sanitized status only. They never return
cookies, CSRF tokens, origin pins, session profiles, or raw upstream payloads.

Creating an account returns the exact local login command:

```text
npm run login -- --account-id <id>
```

The CLI writes session files atomically into that account's fixed directory.
The web API never accepts a cookie, password, arbitrary filesystem path, or
authentication file upload.

### Tasks and settings

- `GET /admin/api/jobs`
- `GET /admin/api/jobs/:id`
- `GET /admin/api/settings`

Task data is sanitized and includes account display name, quoted points, budget
state, status, timestamps, and error code. Prompt text, input media, generated
URLs, and upstream identifiers are omitted from admin list responses.

## Administration UI

The administration application is a compact operational console, not a public
marketing site.

### Navigation

- **Overview:** status totals, today's/month's quoted usage, current work, and
  recent failures.
- **Accounts:** dense account table with health, wallet, daily/monthly usage,
  priority, enabled state, and actions. Create/edit use focused dialogs.
- **Tasks:** filterable table for account, kind, status, quoted points, and
  timestamps.
- **Settings:** shared API status, admin-session information, data paths, and
  copyable per-account login instructions.

### Presentation

Use a dark graphite/ink shell, one cyan action accent, and fixed green/amber/red
status colors. Desktop uses a narrow sidebar and dense tables; narrow screens
collapse navigation and convert account rows to cards. The UI must clearly
distinguish wallet balance, configured budget, reserved usage, and exhausted
state.

The frontend is a Vite + React + TypeScript package under `admin/`. Its
production output is built to `dist/admin` and served at `/admin/` by Fastify.
It uses same-origin `fetch` with the administrator cookie and never stores
credentials in browser storage.

## Error Handling

- Invalid administrator credentials return a generic `401`.
- Missing or invalid CSRF state returns `403`.
- Duplicate account names return `409`.
- Invalid budget or priority values return `400`.
- Account checks are bounded by upstream timeouts and persist only sanitized
  error codes.
- If an account becomes unhealthy between selection and transaction commit, the
  transaction skips it and tries the next candidate.
- If no account is eligible, generation fails before upload or upstream
  submission.
- Database failures abort the request; no generation is submitted without a
  durable job and reservation.
- Disabling or deleting authentication files never cancels an already submitted
  job.
- Account deletion is not in the MVP. Disable preserves history and avoids
  orphaned jobs.

## Testing and Verification

### Unit tests

- Schema migration and legacy backfill.
- Account CRUD validation and secret redaction.
- Trusted quote extraction, including unknown quote rejection.
- Daily/monthly window calculations.
- Atomic concurrent budget reservations.
- Reservation charge/release state transitions.
- Deterministic scheduler ordering.
- Account-bound recovery.
- Administrator password, cookie, and CSRF behavior.

### Integration tests

- Create, edit, enable, disable, and check an account through admin routes.
- Two concurrent jobs cannot exceed a remaining budget that only covers one.
- Idempotent replay does not reserve twice.
- A failed pre-submit job releases its reservation.
- A submitted/unknown job retains charged usage.
- Restart resumes a job using the same account.
- Existing shared API key and compatibility routes remain unchanged.
- Admin static assets and SPA fallback are served only under `/admin`.

### Docker and browser verification

1. Build and start the Docker Compose service with an administrator password.
2. Log into `/admin/`.
3. Confirm the legacy account is visible and healthy.
4. Create a second disabled account and verify its per-account login command.
5. Configure a restrictive budget and confirm an over-budget mock/integration
   request is rejected before submission.
6. Restore a usable budget and run one real image generation and one real video
   generation.
7. Confirm both jobs show the bound account and quoted usage in the console.
8. Restart the container and confirm accounts, budgets, jobs, and usage persist.

## Security Boundaries

- Existing `LINGJING_API_KEY` protects generation APIs only.
- `LINGJING_ADMIN_PASSWORD` protects the administration console only.
- Neither value can substitute for the other.
- The service binds to localhost by default and Docker publishes only
  `127.0.0.1:8000`.
- Logs and API responses use account IDs, display names, subject hashes, and
  error codes only.
- Session directories are server-chosen and cannot be supplied by HTTP clients.
- No raw secret, prompt, media content, result URL, or upstream identity is
  written into audit-style admin responses.
