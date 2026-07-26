# Lingjing Subscription API Service Console Design

## Goal

Turn one or more JD Cloud Lingjing subscription accounts into a locally hosted,
OpenAI-compatible API service that can be operated entirely from the
administration console.

The MVP is complete when an administrator can:

1. Add a Lingjing account by importing validated browser cookies.
2. Open the official Lingjing login page from the account wizard before
   importing those cookies.
3. Refresh and view each account's subscription, point balance, and last check
   time.
4. Create, list, disable, and revoke downstream API keys.
5. Copy the service Base URL and working image/video request examples.
6. Use a newly created API key to complete one real image request and, when the
   upstream model is available, one real video request.

## Scope

### Included

- Guided login that opens the official Lingjing login page in a new tab.
- Cookie import using either a raw `Cookie` request-header value or a browser
  cookie JSON array.
- Mandatory upstream validation before an imported session is saved.
- Atomic per-account session storage under `data/accounts/<account-id>/`.
- Per-account subscription, point balance, session health, and refresh time.
- Aggregate available point balance on the overview page.
- Downstream API key creation, listing, disabling, enabling, and revocation.
- One-time display of a newly created plaintext API key.
- Hashed API key persistence and last-used timestamp tracking.
- Copyable Base URL and image, video, and OpenAI-compatible examples.
- Transitional support for the existing `LINGJING_API_KEY`.

### Later

- Automatic extraction of cross-origin or `HttpOnly` Lingjing cookies.
- A browser extension, Windows login helper, or browser streamed from Docker.
- Multiple administrator roles, per-key quotas, billing, and analytics.

## Constraints

A normal page served from `127.0.0.1` cannot read cookies owned by
`lingjing.jdcloud.com`. Opening the official login page can therefore guide the
user to authenticate, but it cannot return the session automatically.

The MVP uses an explicit cookie-import step. The UI must not claim that opening
the login page alone connects the account.

## Considered Approaches

### A. Guided official login plus validated cookie import — selected

The account wizard opens the official Lingjing site, explains how to copy the
browser cookie, accepts either raw cookie text or JSON, validates it against the
upstream account endpoint, and only then persists and enables the account.

This works with the current Docker deployment and gives the shortest reliable
path from an existing subscription to a usable API.

### B. Windows host login helper

A separate native process could launch Playwright on the host and write the
captured session into the Docker-mounted data directory. This improves
convenience but adds another service, port, installation path, and lifecycle.

### C. Browser and remote desktop inside Docker

Docker could host Chromium plus a streamed browser UI. This offers a fully
contained online login but substantially increases the image, attack surface,
and maintenance burden.

## User Flow

### Add an upstream account

1. The administrator selects **Add account**.
2. The wizard asks for a display name and optional point limits.
3. The administrator selects either:
   - **Open Lingjing login**, which opens the official site and then returns to
     the cookie-import step; or
   - **Import cookies**, which goes directly to the import step.
4. The administrator pastes a raw Cookie header or browser cookie JSON.
5. The server parses the cookies in memory and performs a bounded upstream
   account and subscription check.
6. If validation succeeds, the server creates the account, atomically saves its
   session, records the sanitized account snapshot, and enables it.
7. If validation fails, no account or session secret is retained.

The wizard reports distinct sanitized failures for malformed cookies, expired
login, upstream timeout, and unsupported cookie shape.

### Operate an account

The Accounts page displays:

- Name and internal ID.
- Enabled and session-health state.
- Subscription status.
- Current point balance.
- Daily and monthly configured limits and usage.
- Last successful refresh time.

**Refresh** revalidates the session and updates the displayed snapshot.
Disabling an account stops new scheduling but preserves its session and
history.

### Create a downstream API key

1. The administrator opens **API access**.
2. They enter a human-readable key name and select **Create key**.
3. The server returns the plaintext key once.
4. The UI requires the administrator to copy it before dismissing the result.
5. Subsequent lists show only name, prefix, state, creation time, and last-used
   time.

Disabled or revoked keys immediately fail authentication. Revocation is
permanent; disabling is reversible.

### Use the API

The API access page derives the displayed origin from the current request and
shows:

- Base URL: `<origin>/v1`
- Authentication: `Authorization: Bearer ${LINGJING_API_KEY}`
- Copyable cURL examples for image generation and video generation.
- An OpenAI client configuration example.

The examples use models returned by `/v1/models` rather than invented model
names.

## Architecture

### Cookie import service

`CookieImportService` has one responsibility: convert supported cookie input
into the existing account-session files.

It:

- Accepts a raw Cookie header or a JSON cookie array.
- Rejects empty, malformed, oversized, and non-Lingjing cookie input.
- Creates an in-memory candidate session.
- Uses the existing Lingjing client and account service to validate the
  candidate.
- Writes session files atomically only after validation succeeds.
- Returns only the existing sanitized account snapshot.

Raw cookies are never written to logs, database rows, error messages, or admin
responses.

### Account onboarding transaction

The admin route reserves a new account ID, validates the proposed session, then
persists the account configuration and session as one logical operation. If a
later persistence step fails, newly created files and rows are removed before
the request returns.

Existing account edit behavior remains unchanged.

### Subscription and balance snapshot

The existing account repository remains the source of sanitized runtime
observations. Its account snapshot is extended only if the upstream response
contains a stable subscription status that is not already represented.

Balance refresh uses the existing account check path so scheduling and the UI
observe the same data.

### Downstream API key repository

SQLite adds an `api_keys` table:

- `id`
- `name`
- `key_prefix`
- `key_hash`
- `enabled`
- `created_at`
- `updated_at`
- `last_used_at`
- `revoked_at`

The plaintext key format is `ljk_<random-secret>`. The secret is generated with
a cryptographically secure random source. Only a keyed or slow password-style
hash is stored; equality checks are timing-safe.

The existing `LINGJING_API_KEY` remains accepted during this MVP so current
clients do not break. It is labeled as the legacy environment key in settings
but is never exposed.

### Authentication middleware

Generation and compatibility routes accept a request when either:

- the bearer token matches an active stored API key; or
- it matches the configured legacy environment key.

Admin-session authentication remains separate. API keys cannot authenticate to
`/admin/api`.

### Administration API

New endpoints:

- `POST /admin/api/accounts/import`
- `GET /admin/api/api-keys`
- `POST /admin/api/api-keys`
- `POST /admin/api/api-keys/:id/enable`
- `POST /admin/api/api-keys/:id/disable`
- `DELETE /admin/api/api-keys/:id`

Changed endpoints:

- Account list/detail responses include subscription status and last successful
  balance refresh when available.
- `GET /admin/api/settings` includes the request-derived API Base URL, API
  route paths, and whether the legacy environment key is configured.
- `GET /admin/api/overview` includes aggregate available point balance.

All state-changing routes retain the existing admin session and CSRF
requirements.

## Error Handling and Security

- Cookie input has a strict size limit.
- Cookie input and plaintext API keys are marked sensitive and excluded from
  structured request logging.
- Invalid or expired cookies return a sanitized `401`.
- Malformed cookie formats return `400`.
- Upstream timeouts return `504` without persisting the account.
- Duplicate account and API-key names return `409`.
- Revoked or disabled API keys return the same generic `401` as unknown keys.
- A generated key is returned only by its successful creation response.
- No endpoint can retrieve a plaintext key later.
- Base URL is derived from the request origin using the existing trusted-proxy
  policy; arbitrary forwarded hosts are not trusted by default.
- Existing localhost-only Docker binding remains unchanged.

## Testing

### Unit tests

- Parse supported raw and JSON cookie formats.
- Reject malformed, oversized, and unrelated cookie input.
- Persist no session when validation fails.
- Hash and verify API keys without storing plaintext.
- Reject disabled, revoked, and unknown keys.

### Integration tests

- Importing a valid mock session creates an enabled, ready account.
- Invalid cookie import creates neither account rows nor session files.
- Account refresh updates the sanitized subscription and balance snapshot.
- Create, list, disable, enable, and revoke an API key through admin routes.
- Plaintext API key appears only in the creation response.
- A stored key authenticates `/v1/models` and generation routes.
- A disabled or revoked key receives `401`.
- The legacy environment key continues to authenticate.
- Settings returns the correct request-derived Base URL and examples.

### Browser tests

- The account wizard clearly separates opening the official site from importing
  cookies.
- Successful import closes the wizard and displays balance and health.
- API-key creation requires copying or explicitly dismissing the one-time key.
- Base URL and examples are visible and copyable.

### Docker acceptance

1. Rebuild and start the service with the existing persisted data.
2. Log in to the admin console.
3. Import a real Lingjing browser session.
4. Confirm subscription and point balance refresh successfully.
5. Create a downstream API key.
6. Call `/v1/models` using the new key.
7. Complete one real image request.
8. Complete one real video request when the subscribed upstream model is
   available.
9. Disable the new key and confirm it receives `401`.
10. Restart Docker and confirm the account and key metadata persist.

## Stop Condition

Stop the current implementation phase once the cookie-onboarded account,
balance refresh, managed API key, displayed Base URL, and authenticated real
image request work end to end. Do not add automatic cookie capture, remote
browser infrastructure, per-key quotas, media libraries, or analytics in this
phase.
