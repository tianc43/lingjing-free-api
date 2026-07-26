# Lingjing Subscription API Service Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Docker-hosted administration flow that imports a validated Lingjing browser session, displays subscription balance, creates downstream API keys, shows the Base URL, and authenticates a real image request.

**Architecture:** Add two focused server units: `CookieImportService` converts supported cookie input into an atomic account session after a real upstream validation, and `SqliteApiKeyRepository` owns one-time API key creation plus verification. Extend the existing admin API and React console without changing generation payloads or the account scheduler.

**Tech Stack:** Node.js 20, TypeScript 6, Fastify 5, SQLite/better-sqlite3, React 19, Vite 7, Vitest 3, Playwright 1.61, Docker Compose.

## Global Constraints

- Keep Docker bound to `127.0.0.1:8000`.
- Do not log or return imported cookies, `originPin`, CSRF values, or stored API key hashes.
- Return a plaintext managed API key only from its successful creation response.
- Continue accepting the existing `LINGJING_API_KEY`.
- Do not implement browser extensions, host helpers, a Docker remote browser, per-key quotas, billing, media history, or analytics.
- Every production change starts with a focused failing test and ends with the focused test plus the existing suite passing.

## File Structure

- `src/api-keys/types.ts`: public stored-key and creation-result types.
- `src/api-keys/sqlite-api-key-repository.ts`: create, list, enable, disable, revoke, and verify managed API keys.
- `src/session/cookie-import.ts`: parse raw/JSON cookie input, derive `originPin`, and construct a candidate session.
- `src/accounts/cookie-import-service.ts`: validate a candidate session upstream and commit an enabled account plus session files.
- `src/jobs/schema.ts`: schema version 5 for `api_keys` and membership snapshot storage.
- `src/accounts/types.ts`: add the sanitized membership observation.
- `src/accounts/sqlite-account-repository.ts`: persist membership and remove a newly failed, unbound onboarding row.
- `src/api/auth.ts`: authorize the legacy environment key or a managed key.
- `src/api/types.ts`, `src/index.ts`, `tests/helpers/test-app.ts`: wire the key repository and cookie importer into application dependencies.
- `src/admin/schemas.ts`, `src/admin/routes.ts`: account-import, key-management, balance, and Base URL contracts.
- `admin/src/types.ts`, `admin/src/api.ts`, `admin/src/app.tsx`: client types, resources, and actions.
- `admin/src/components/account-onboarding-dialog.tsx`: guided official login plus Cookie import form.
- `admin/src/components/api-key-dialog.tsx`: one-time managed key display.
- `admin/src/pages/accounts-page.tsx`: membership, balance, and refresh presentation.
- `admin/src/pages/api-access-page.tsx`: key management, Base URL, and copyable examples.
- `admin/src/components/app-shell.tsx`, `admin/src/styles.css`: add the API Access destination and only the styles required by the new controls.

---

### Task 1: Managed API key persistence and verification

**Files:**

- Create: `src/api-keys/types.ts`
- Create: `src/api-keys/sqlite-api-key-repository.ts`
- Create: `tests/unit/api-key-repository.test.ts`
- Modify: `src/jobs/schema.ts`
- Modify: `src/api/auth.ts`
- Modify: `tests/unit/auth.test.ts`

**Interfaces:**

- Produces: `ApiKeyRecord`, `CreatedApiKey`, and `SqliteApiKeyRepository`.
- Produces: `create(name): CreatedApiKey`, `list(): ApiKeyRecord[]`, `setEnabled(id, enabled): ApiKeyRecord`, `revoke(id): void`, and `verify(token): boolean`.
- Produces: `isAuthorized(authorization, legacyToken, managedKeys): boolean`.

- [ ] **Step 1: Write the schema and repository failing tests**

```ts
it("returns a managed key once and persists only a salted hash", () => {
  const created = keys.create("Dify");
  expect(created.secret).toMatch(/^ljk_[A-Za-z0-9_-]{43}$/u);
  expect(keys.list()[0]).toMatchObject({
    name: "Dify",
    keyPrefix: created.secret.slice(0, 12),
    enabled: true,
    revokedAt: null
  });
  expect(JSON.stringify(store.read((db) =>
    db.prepare("SELECT * FROM api_keys").get()
  ))).not.toContain(created.secret);
  expect(keys.verify(created.secret)).toBe(true);
});

it("rejects disabled, revoked, and unknown managed keys", () => {
  const created = keys.create("Automation");
  keys.setEnabled(created.record.id, false);
  expect(keys.verify(created.secret)).toBe(false);
  keys.setEnabled(created.record.id, true);
  keys.revoke(created.record.id);
  expect(keys.verify(created.secret)).toBe(false);
  expect(keys.verify("ljk_unknown")).toBe(false);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- tests/unit/api-key-repository.test.ts tests/unit/auth.test.ts`

Expected: FAIL because `SqliteApiKeyRepository` and the managed-key argument do not exist.

- [ ] **Step 3: Add schema version 5 and the minimal repository**

```ts
export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface CreatedApiKey {
  record: ApiKeyRecord;
  secret: string;
}
```

Add `VERSION_FIVE_SQL`:

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
ALTER TABLE accounts ADD COLUMN membership TEXT;
```

Create keys as `ljk_` plus 32 random bytes encoded with base64url. Store
`scrypt$<salt-base64url>$<digest-base64url>` using a 16-byte random salt and
`scryptSync(secret, salt, 32)`. Locate the candidate row by `key_prefix`, verify
with `timingSafeEqual`, reject disabled/revoked rows, and update
`last_used_at` only after a successful verification.

- [ ] **Step 4: Extend bearer authorization**

```ts
export interface ManagedApiKeyVerifier {
  verify(token: string): boolean;
}

export function isAuthorized(
  header: string | string[] | undefined,
  configuredToken: string,
  managedKeys?: ManagedApiKeyVerifier
): boolean {
  const token = parseBearerToken(header);
  if (token === null) return false;
  return constantTimeEqual(token, configuredToken)
    || managedKeys?.verify(token) === true;
}
```

- [ ] **Step 5: Run focused and migration tests and verify GREEN**

Run: `npm test -- tests/unit/api-key-repository.test.ts tests/unit/auth.test.ts tests/unit/account-repository.test.ts`

Expected: PASS with no plaintext key in SQLite assertions.

- [ ] **Step 6: Commit**

```powershell
git add src/api-keys src/jobs/schema.ts src/api/auth.ts tests/unit/api-key-repository.test.ts tests/unit/auth.test.ts
git commit -m "feat: add managed API keys"
```

### Task 2: Cookie parsing and candidate session construction

**Files:**

- Create: `src/session/cookie-import.ts`
- Create: `tests/unit/cookie-import.test.ts`
- Modify: `src/logging.ts`

**Interfaces:**

- Produces: `CookieImportInput = { format: "header" | "json"; value: string }`.
- Produces: `parseCookieImport(input): { storageState: StorageState; originPin: string; session: SessionProvider }`.
- Requires `csrfToken` and a URL-decoded `pin` cookie.
- Accepts at most 64 KiB and at most 200 cookies.

- [ ] **Step 1: Write failing parser tests**

```ts
it("converts a raw Cookie header into a Lingjing candidate session", async () => {
  const result = parseCookieImport({
    format: "header",
    value: "csrfToken=fixture-csrf; pin=fixture%2Dpin; thor=fixture-auth"
  });
  expect(result.originPin).toBe("fixture-pin");
  expect(result.storageState.cookies.map((cookie) => cookie.name))
    .toEqual(["csrfToken", "pin", "thor"]);
  expect((await result.session.load()).csrfToken).toBe("fixture-csrf");
});

it("accepts browser cookie JSON and rejects malformed or oversized input", () => {
  expect(parseCookieImport({
    format: "json",
    value: JSON.stringify([
      { name: "csrfToken", value: "fixture-csrf", domain: "lingjing.jdcloud.com", path: "/" },
      { name: "pin", value: "fixture%2Dpin", domain: ".jdcloud.com", path: "/" }
    ])
  }).originPin).toBe("fixture-pin");
  expect(() => parseCookieImport({ format: "header", value: "pin=x" }))
    .toThrow("Lingjing csrfToken cookie is required");
  expect(() => parseCookieImport({ format: "header", value: "x".repeat(65_537) }))
    .toThrow("Cookie input is too large");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/unit/cookie-import.test.ts`

Expected: FAIL because `src/session/cookie-import.ts` does not exist.

- [ ] **Step 3: Implement the parser and in-memory provider**

Normalize both formats to Playwright-compatible cookies. For raw Cookie text,
bind cookies to `lingjing.jdcloud.com`; for JSON, accept only
`lingjing.jdcloud.com`, `.jdcloud.com`, `.jd.com`, and `.jdpay.com` domains.
Reject duplicate `csrfToken` or conflicting decoded `pin` values. The returned
in-memory `SessionProvider` must expose the same CookieJar and profile contract
used by `LingjingClient`.

- [ ] **Step 4: Add logging redaction paths**

Add `cookie_input`, `cookieInput`, `api_key`, `apiKey`, `secret`, and their
nested forms to the existing Pino redact list.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- tests/unit/cookie-import.test.ts tests/unit/logging.test.ts tests/unit/session.test.ts`

Expected: PASS and serialized logs contain none of the fixture secrets.

- [ ] **Step 6: Commit**

```powershell
git add src/session/cookie-import.ts src/logging.ts tests/unit/cookie-import.test.ts tests/unit/logging.test.ts
git commit -m "feat: parse Lingjing cookie imports"
```

### Task 3: Validated account onboarding and balance snapshots

**Files:**

- Create: `src/accounts/cookie-import-service.ts`
- Create: `tests/unit/cookie-import-service.test.ts`
- Modify: `src/accounts/types.ts`
- Modify: `src/accounts/sqlite-account-repository.ts`
- Modify: `src/accounts/runtime-registry.ts`
- Modify: `tests/unit/account-repository.test.ts`
- Modify: `tests/unit/account-runtime-registry.test.ts`

**Interfaces:**

- Consumes: `parseCookieImport`.
- Produces: `CookieImportService.import(input): Promise<AccountRecord>`.
- Persists `membership: string | null`.
- Produces `SqliteAccountRepository.removeUnbound(id): void`, which deletes only
  an account with no jobs or budget entries.

- [ ] **Step 1: Write the failing onboarding tests**

```ts
it("persists and enables only a session validated upstream", async () => {
  const account = await importer.import({
    account: {
      name: "Primary subscription",
      priority: 1,
      dailyPointLimit: 0,
      monthlyPointLimit: 0
    },
    cookies: {
      format: "header",
      value: "csrfToken=fixture-csrf; pin=fixture%2Dpin; thor=fixture-auth"
    }
  });
  expect(account).toMatchObject({
    enabled: true,
    healthStatus: "ready",
    membership: "premium",
    pointsBalance: 120,
    totalBalance: 150
  });
  await expectSessionPair(account.id);
});

it("retains neither account nor session files after validation failure", async () => {
  describeAccount.mockRejectedValueOnce(new Error("expired"));
  await expect(importer.import(validInput)).rejects.toThrow("expired");
  expect(accounts.list().map((account) => account.name))
    .not.toContain("Primary subscription");
  await expect(readdir(accountsDirectory)).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/unit/cookie-import-service.test.ts tests/unit/account-repository.test.ts`

Expected: FAIL because membership, `removeUnbound`, and the import service do not exist.

- [ ] **Step 3: Persist membership in account observations**

Extend `AccountRecord`, `AccountObservation`, `AccountRow`, `SELECT_COLUMNS`,
`accountFromRow`, and `recordObservation` with `membership`. Map the existing
`AccountSnapshot.membership` in `AccountRuntimeRegistry`.

- [ ] **Step 4: Implement the onboarding service**

```ts
export interface ImportAccountInput {
  account: CreateAccountInput;
  cookies: CookieImportInput;
}

export class CookieImportService {
  async import(input: ImportAccountInput): Promise<AccountRecord> {
    const candidate = parseCookieImport(input.cookies);
    const snapshot = await this.describe(candidate.session);
    const account = this.accounts.create(input.account);
    try {
      await atomicWritePrivateJsonPair([
        { targetPath: accountSessionPaths(this.config, account.id).storageStatePath, value: candidate.storageState },
        { targetPath: accountSessionPaths(this.config, account.id).sessionProfilePath, value: { originPin: candidate.originPin } }
      ]);
      this.accounts.recordObservation(account.id, observationFrom(snapshot));
      this.accounts.update(account.id, { enabled: true });
      await this.runtimes.refresh(account.id);
      return this.accounts.findById(account.id)!;
    } catch (cause) {
      await this.removeNewSession(account.id);
      this.accounts.removeUnbound(account.id);
      throw cause;
    }
  }
}
```

The production `describe` dependency constructs `LingjingClient` from the
candidate session and calls the existing `AccountService.describe`. Cleanup is
restricted to the newly generated `data/accounts/<generated-id>` directory.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- tests/unit/cookie-import-service.test.ts tests/unit/account-repository.test.ts tests/unit/account-runtime-registry.test.ts`

Expected: PASS, including rollback assertions.

- [ ] **Step 6: Commit**

```powershell
git add src/accounts src/jobs/schema.ts tests/unit/cookie-import-service.test.ts tests/unit/account-repository.test.ts tests/unit/account-runtime-registry.test.ts
git commit -m "feat: onboard validated Lingjing accounts"
```

### Task 4: Administration API for imports, balances, keys, and Base URL

**Files:**

- Modify: `src/api/types.ts`
- Modify: `src/index.ts`
- Modify: `src/app.ts`
- Modify: `src/admin/schemas.ts`
- Modify: `src/admin/routes.ts`
- Modify: `src/errors.ts`
- Modify: `tests/helpers/test-app.ts`
- Modify: `tests/integration/admin-api.test.ts`
- Modify: `tests/integration/security-regression.test.ts`

**Interfaces:**

- Consumes: `CookieImportService` and `SqliteApiKeyRepository`.
- Produces the six new `/admin/api` routes defined in the approved design.
- Produces `settings.api_base_url`, `settings.legacy_api_key_configured`, and
  `overview.balance.available_points`.

- [ ] **Step 1: Write failing admin integration tests**

```ts
it("imports an account without returning cookie material", async () => {
  const response = await adminInject(app, csrf, {
    method: "POST",
    url: "/admin/api/accounts/import",
    payload: {
      name: "Imported",
      priority: 1,
      daily_point_limit: 0,
      monthly_point_limit: 0,
      cookie_format: "header",
      cookie_input: "csrfToken=fixture-csrf; pin=fixture-private-pin; thor=fixture-auth"
    }
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().account).toMatchObject({
    name: "Imported",
    enabled: true,
    health_status: "ready"
  });
  expect(response.body).not.toContain("fixture-csrf");
  expect(response.body).not.toContain("fixture-private-pin");
});

it("creates a key once and uses it on a protected route", async () => {
  const created = await createAdminKey(app, csrf, "Dify");
  expect(created.api_key).toMatch(/^ljk_/u);
  const authHeader = `Bearer ${created.api_key}`;
  expect(await app.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: authHeader }
  })).toHaveProperty("statusCode", 200);
  expect((await listAdminKeys(app)).body).not.toContain(created.api_key);
});
```

Also assert disable returns `401`, enable restores access, revoke permanently
returns `401`, the legacy key still returns `200`, settings returns
`http://localhost:8000/v1` for the injected host, and overview sums only
enabled ready accounts with non-null total balance.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/integration/admin-api.test.ts tests/integration/security-regression.test.ts`

Expected: FAIL with missing dependencies, schemas, and routes.

- [ ] **Step 3: Wire repositories and authentication**

Add `apiKeys` and `cookieImporter` to `AppDependencies`/`AdminDependencies`.
Construct both from the shared `SqliteStore` in `startServer`. Pass `apiKeys`
into both protected-route and not-found authorization checks:

```ts
isAuthorized(
  request.headers.authorization,
  dependencies.config.apiKey,
  dependencies.apiKeys
)
```

- [ ] **Step 4: Add exact admin schemas and routes**

Use:

```ts
const importAccountBodySchema = createAccountBodySchema.extend({
  cookie_format: z.enum(["header", "json"]),
  cookie_input: z.string().min(1).max(65_536)
}).strict();

const createApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(200)
}).strict();
```

Key list responses expose only `id`, `name`, `key_prefix`, `enabled`,
`created_at`, `updated_at`, `last_used_at`, and `revoked_at`. The create
response additionally exposes `api_key`.

Derive the Base URL with
`new URL("/v1", `${request.protocol}://${request.hostname}`).toString()`
and remove the trailing slash.

- [ ] **Step 5: Map sanitized failures**

Map malformed cookie input to `400`. Add sanitized
`invalid_imported_session` (`401`) and `import_validation_timeout` (`504`)
errors for failed and timed-out upstream validation. Map duplicate names to
`409` and unknown key IDs to `404`. Never include the caught error message when
it may contain imported material.

- [ ] **Step 6: Run integration and full server tests**

Run: `npm test -- tests/integration/admin-api.test.ts tests/integration/security-regression.test.ts tests/integration/images-api.test.ts tests/integration/videos-api.test.ts`

Expected: PASS for managed and legacy API authentication.

- [ ] **Step 7: Commit**

```powershell
git add src/api src/admin src/app.ts src/index.ts src/errors.ts tests/helpers/test-app.ts tests/integration/admin-api.test.ts tests/integration/security-regression.test.ts
git commit -m "feat: expose account import and API key admin routes"
```

### Task 5: Account onboarding and balance UI

**Files:**

- Create: `admin/src/components/account-onboarding-dialog.tsx`
- Modify: `admin/src/types.ts`
- Modify: `admin/src/api.ts`
- Modify: `admin/src/app.tsx`
- Modify: `admin/src/pages/accounts-page.tsx`
- Modify: `admin/src/pages/overview-page.tsx`
- Modify: `admin/src/styles.css`
- Modify: `tests/browser/admin.browser.test.ts`

**Interfaces:**

- Consumes: `AdminApi.importAccount`.
- Produces guided link `https://lingjing.jdcloud.com/`.
- Displays `membership`, `points_balance`, `total_balance`, and
  `last_checked_at`.

- [ ] **Step 1: Add failing browser assertions**

```ts
await page.getByRole("button", { name: "Add account" }).click();
await expect(page.getByRole("link", { name: "Open Lingjing login" }))
  .toHaveAttribute("href", "https://lingjing.jdcloud.com/");
await page.getByLabel("Cookie format").selectOption("header");
await page.getByLabel("Lingjing cookies").fill(
  "csrfToken=fixture-csrf; pin=fixture-pin; thor=fixture-auth"
);
await page.getByRole("button", { name: "Validate and add" }).click();
await expect(page.getByText("Premium")).toBeVisible();
await expect(page.getByText("Total balance 150")).toBeVisible();
await expect(page.getByText("npm run login -- --account-id")).toHaveCount(0);
```

- [ ] **Step 2: Build the admin frontend and verify RED**

Run: `npm run build:admin && npx playwright test tests/browser/admin.browser.test.ts`

Expected: FAIL because the onboarding controls and fields do not exist.

- [ ] **Step 3: Implement the focused onboarding dialog**

Keep `AccountDialog` for edits. Use `AccountOnboardingDialog` for creation with
the four account fields, the official-site link, format select, cookie textarea,
and a disclosure stating that opening the site does not import cookies. Submit
only to `AdminApi.importAccount`.

- [ ] **Step 4: Display usable balance information**

Change the account action label from **Check health** to **Refresh balance**.
Show membership, point balance, total balance, and the formatted last successful
refresh time. Add `overview.balance.available_points` as a summary card.

- [ ] **Step 5: Run browser tests at desktop and mobile sizes**

Run: `npm run build:admin && npx playwright test tests/browser/admin.browser.test.ts`

Expected: PASS with no horizontal overflow at 1440×900 or 390×844.

- [ ] **Step 6: Commit**

```powershell
git add admin/src tests/browser/admin.browser.test.ts
git commit -m "feat: add cookie account onboarding UI"
```

### Task 6: API Access UI with keys, Base URL, and examples

**Files:**

- Create: `admin/src/pages/api-access-page.tsx`
- Create: `admin/src/components/api-key-dialog.tsx`
- Modify: `admin/src/types.ts`
- Modify: `admin/src/api.ts`
- Modify: `admin/src/app.tsx`
- Modify: `admin/src/components/app-shell.tsx`
- Modify: `admin/src/styles.css`
- Modify: `tests/browser/admin.browser.test.ts`

**Interfaces:**

- Consumes API key list/create/enable/disable/revoke routes and settings.
- Produces `PageName = "api-access"` and navigation label **API Access**.
- Displays the one-time secret only inside `ApiKeyDialog`.

- [ ] **Step 1: Add failing browser assertions**

```ts
await page.getByRole("link", { name: "API Access" }).click();
await expect(page.getByText("http://127.0.0.1:4174/v1")).toBeVisible();
await page.getByRole("button", { name: "Create API key" }).click();
await page.getByLabel("Key name").fill("Dify");
await page.getByRole("button", { name: "Create key" }).click();
await expect(page.getByText(/^ljk_/u)).toBeVisible();
await expect(page.getByText("This key is shown only once")).toBeVisible();
await page.getByRole("button", { name: "Done" }).click();
await expect(page.getByText(/^ljk_/u)).toHaveCount(0);
await expect(page.getByText("Authorization: Bearer ${LINGJING_API_KEY}"))
  .toBeVisible();
```

- [ ] **Step 2: Build and verify RED**

Run: `npm run build:admin && npx playwright test tests/browser/admin.browser.test.ts`

Expected: FAIL because API Access navigation and key actions do not exist.

- [ ] **Step 3: Implement managed key actions**

`ApiAccessPage` lists key name, prefix, status, creation time, and last use.
Provide Create, Disable/Enable, and Revoke actions. Require `window.confirm`
before revocation. `ApiKeyDialog` renders the returned secret, a copy button,
the one-time warning, and a **Done** action that clears the secret from React
state.

- [ ] **Step 4: Render Base URL and executable examples**

Show the settings-provided Base URL and copyable examples for:

- `GET <base-url>/models`
- `POST <base-url>/images/generations`
- `POST <base-url>/videos`
- OpenAI client initialization with `baseURL` and `apiKey`

Use documented model aliases already returned by the project fixtures.

- [ ] **Step 5: Run browser and static build tests**

Run: `npm run build:admin && npx playwright test tests/browser/admin.browser.test.ts && npm test -- tests/integration/admin-build.test.ts tests/integration/admin-static.test.ts`

Expected: PASS and `/admin/api-access` uses SPA fallback.

- [ ] **Step 6: Commit**

```powershell
git add admin/src tests/browser/admin.browser.test.ts tests/integration/admin-static.test.ts
git commit -m "feat: add API access console"
```

### Task 7: Full verification, Docker acceptance, and public documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/troubleshooting.md`
- Modify: `docker-compose.yml` only if an existing required variable or mount is missing.

**Interfaces:**

- No new runtime interfaces.
- Produces reproducible operator instructions for Cookie import, managed keys,
  Base URL, and the legacy-key transition.

- [ ] **Step 1: Run static verification**

Run: `npm run lint`

Expected: exit code 0 with no warnings.

Run: `npm run typecheck`

Expected: exit code 0.

Run: `npm test`

Expected: all non-live Vitest and Playwright tests pass.

- [ ] **Step 2: Run Karpathy scope checks**

Run:

```powershell
python -X utf8 C:\Users\tc\.codex\skills\karpathy-coder\scripts\complexity_checker.py .
python -X utf8 C:\Users\tc\.codex\skills\karpathy-coder\scripts\diff_surgeon.py --diff fe60336..HEAD
```

Expected: no blocking complexity or unrelated-diff finding. Any unrelated
pre-existing finding is recorded and left unchanged.

- [ ] **Step 3: Update operator documentation**

Document:

1. Open `/admin/` and sign in.
2. Open Lingjing, authenticate, and copy the request Cookie or exported cookie JSON.
3. Import and validate the account.
4. Confirm membership and balance.
5. Create and copy an API key.
6. Use `<origin>/v1` with `Authorization: Bearer ${LINGJING_API_KEY}`.
7. Disable or revoke a key.

State explicitly that the browser page cannot automatically read cross-origin
or `HttpOnly` cookies.

- [ ] **Step 4: Rebuild Docker without deleting persisted data**

Run: `docker compose up -d --build`

Expected: the `lingjing-free-api` service becomes healthy on
`127.0.0.1:8000`, and the existing `data` bind mount remains intact.

- [ ] **Step 5: Perform real end-to-end acceptance**

Using an imported real account:

1. Refresh balance and record the sanitized membership/point values.
2. Create a managed API key.
3. Call `GET http://127.0.0.1:8000/v1/models` with that key and expect `200`.
4. Call `POST /v1/images/generations` with the selected tattoo-image prompt and
   expect a completed image response.
5. Call `POST /v1/videos` with the selected tattoo-video prompt when the listed
   subscribed model is available and expect a completed task/output.
6. Disable the key and expect `401`.
7. Re-enable it, restart Docker, and confirm the account and key metadata remain.

- [ ] **Step 6: Run secret and diff checks**

Run: `npm test -- tests/integration/security-regression.test.ts`

Expected: PASS with no Cookie, `originPin`, plaintext managed key, or key hash in
responses/logs.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 7: Commit and push**

```powershell
git add README.md docs/troubleshooting.md docker-compose.yml
git commit -m "docs: document API service onboarding"
git push -u origin codex/multi-account-admin
```

The Docker Compose file is staged only if it changed.
