import { afterEach, describe, expect, it } from "vitest";
import type {
  InjectOptions,
  LightMyRequestResponse
} from "fastify";
import { budgetWindows } from "../../src/accounts/budget.js";
import { adminCookieOptions } from "../../src/admin/routes.js";
import {
  createTestApp,
  fixtureHash,
  type TestApp
} from "../helpers/test-app.js";
import { assertNoSensitiveValues } from "../helpers/secret-scan.js";

const ADMIN_PASSWORD = "fixture-admin-password";
const fixtures: TestApp[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => fixture.close()));
});

async function adminFixture(enabled = true): Promise<TestApp> {
  const fixture = await createTestApp({
    config: {
      adminPassword: enabled ? ADMIN_PASSWORD : null
    }
  });
  fixtures.push(fixture);
  return fixture;
}

async function login(fixture: TestApp) {
  const response = await fixture.app.inject({
    method: "POST",
    url: "/admin/api/login",
    payload: { password: ADMIN_PASSWORD }
  });
  const body = response.json<{
    csrf_token: string;
    expires_at: number;
  }>();
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("Admin cookie was not set");
  return { response, body, cookie };
}

function mutate(
  fixture: TestApp,
  cookie: string,
  csrfToken: string,
  options: {
    method: "POST" | "PATCH" | "DELETE";
    url: string;
    payload?: object;
  }
): Promise<LightMyRequestResponse> {
  const injectOptions: InjectOptions = {
    ...options,
    headers: {
      cookie,
      "x-csrf-token": csrfToken
    }
  };
  return fixture.app.inject(injectOptions);
}

describe("administrator API", () => {
  it("returns an explicit sanitized 404 when administration is disabled", async () => {
    const fixture = await adminFixture(false);

    for (const url of ["/admin", "/admin/", "/admin/api/session"]) {
      const response = await fixture.app.inject({ url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: { code: "route_not_found" }
      });
      expect(response.body).not.toContain("invalid_api_key");
    }
  });

  it("authenticates with an isolated secure cookie and CSRF token", async () => {
    const fixture = await adminFixture();
    const rejected = await fixture.app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { password: "fixture-wrong-password" }
    });
    expect(rejected.statusCode).toBe(401);

    const { response, body, cookie } = await login(fixture);
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(response.headers["set-cookie"]).toContain("Path=/admin");
    expect(response.headers["set-cookie"]).not.toContain("Secure");
    expect(body.csrf_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(body.expires_at).toBeGreaterThan(Date.now());

    const session = await fixture.app.inject({
      url: "/admin/api/session",
      headers: { cookie }
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true });

    const forwarded = await fixture.app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "x-forwarded-proto": "https" },
      payload: { password: ADMIN_PASSWORD }
    });
    expect(forwarded.headers["set-cookie"]).not.toContain("Secure");

    expect(adminCookieOptions({ protocol: "https" }).secure).toBe(true);
  });

  it("requires session authentication and CSRF for state changes", async () => {
    const fixture = await adminFixture();
    const unauthenticated = await fixture.app.inject({
      url: "/admin/api/accounts"
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toMatchObject({
      error: { code: "admin_authentication_required" }
    });

    const { cookie } = await login(fixture);
    const missing = await fixture.app.inject({
      method: "POST",
      url: "/admin/api/accounts",
      headers: { cookie },
      payload: {
        name: "Fixture account",
        priority: 1,
        daily_point_limit: 20,
        monthly_point_limit: 100
      }
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({
      error: { code: "invalid_csrf_token" }
    });
  });

  it("imports an account without returning cookie material", async () => {
    const fixture = await adminFixture();
    const { cookie, body } = await login(fixture);
    const response = await mutate(fixture, cookie, body.csrf_token, {
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
    expect(response.json()).toMatchObject({
      account: {
        name: "Imported",
        enabled: true,
        health_status: "ready"
      }
    });
    expect(response.body).not.toContain("fixture-csrf");
    expect(response.body).not.toContain("fixture-private-pin");

    const malformed = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: "/admin/api/accounts/import",
      payload: {
        name: "Malformed imported account",
        priority: 0,
        daily_point_limit: 0,
        monthly_point_limit: 0,
        cookie_format: "header",
        cookie_input: "pin=fixture-private-pin"
      }
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: { code: "invalid_request" }
    });

    const duplicate = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: "/admin/api/accounts/import",
      payload: {
        name: "Imported",
        priority: 1,
        daily_point_limit: 0,
        monthly_point_limit: 0,
        cookie_format: "header",
        cookie_input: "csrfToken=fixture-csrf; pin=fixture-private-pin"
      }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: "account_name_conflict" }
    });
  });

  it("sanitizes invalid and timed-out imported sessions", async () => {
    const fixture = await adminFixture();
    const { cookie, body } = await login(fixture);
    const importer = (fixture.dependencies as unknown as {
      cookieImporter: { import(): Promise<never> };
    }).cookieImporter;
    const originalImport = importer.import.bind(importer);
    importer.import = () => Promise.reject(
      new Error("fixture-private-pin upstream refused imported cookie")
    );
    const invalid = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: "/admin/api/accounts/import",
      payload: {
        name: "Invalid imported account",
        priority: 0,
        daily_point_limit: 0,
        monthly_point_limit: 0,
        cookie_format: "header",
        cookie_input: "csrfToken=fixture-csrf; pin=fixture-private-pin"
      }
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({
      error: { code: "invalid_imported_session" }
    });
    expect(invalid.body).not.toContain("fixture-private-pin");

    importer.import = () => Promise.reject(new Error("fixture import timed out"));
    const timedOut = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: "/admin/api/accounts/import",
      payload: {
        name: "Timed out imported account",
        priority: 0,
        daily_point_limit: 0,
        monthly_point_limit: 0,
        cookie_format: "header",
        cookie_input: "csrfToken=fixture-csrf; pin=fixture-private-pin"
      }
    });
    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.json()).toMatchObject({
      error: { code: "import_validation_timeout" }
    });
    importer.import = originalImport;
  });

  it("creates, lists, disables, enables and revokes a managed API key", async () => {
    const fixture = await adminFixture();
    const { cookie, body } = await login(fixture);
    const create = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: "/admin/api/api-keys",
      payload: { name: "Dify" }
    });
    expect(create.statusCode).toBe(201);
    const created = create.json<{
      api_key: string;
      key: { id: string; name: string };
    }>();
    expect(created.api_key).toMatch(/^ljk_/u);

    const managedAuthorization = `Bearer ${created.api_key}`;
    expect(await fixture.app.inject({
      method: "GET",
      url: "/v1/models?type=image",
      headers: { authorization: managedAuthorization }
    })).toHaveProperty("statusCode", 200);
    expect(await fixture.app.inject({
      method: "GET",
      url: "/unregistered-api-route",
      headers: { authorization: managedAuthorization }
    })).toHaveProperty("statusCode", 404);
    expect(await fixture.app.inject({
      method: "GET",
      url: "/v1/models?type=image",
      headers: { authorization: "Bearer fixture-downstream-secret" }
    })).toHaveProperty("statusCode", 200);

    const listed = await fixture.app.inject({
      url: "/admin/api/api-keys",
      headers: { cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(created.api_key);
    expect(listed.json()).toMatchObject({
      api_keys: [expect.objectContaining({ id: created.key.id, name: "Dify" })]
    });

    const disabled = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: `/admin/api/api-keys/${created.key.id}/disable`
    });
    expect(disabled.statusCode).toBe(200);
    expect(await fixture.app.inject({
      url: "/v1/models?type=image",
      headers: { authorization: managedAuthorization }
    })).toHaveProperty("statusCode", 401);

    const enabled = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: `/admin/api/api-keys/${created.key.id}/enable`
    });
    expect(enabled.statusCode).toBe(200);
    expect(await fixture.app.inject({
      url: "/v1/models?type=image",
      headers: { authorization: managedAuthorization }
    })).toHaveProperty("statusCode", 200);

    const revoked = await mutate(fixture, cookie, body.csrf_token, {
      method: "DELETE",
      url: `/admin/api/api-keys/${created.key.id}`
    });
    expect(revoked.statusCode).toBe(200);
    const revokedKey = revoked.json<{ key: Record<string, unknown> }>().key;
    expect(revokedKey).toMatchObject({
      id: created.key.id,
      enabled: true,
      revoked_at: expect.any(Number)
    });
    expect(await fixture.app.inject({
      url: "/v1/models",
      headers: { authorization: managedAuthorization }
    })).toHaveProperty("statusCode", 401);

    for (const action of ["enable", "disable"] as const) {
      const rejected = await mutate(fixture, cookie, body.csrf_token, {
        method: "POST",
        url: `/admin/api/api-keys/${created.key.id}/${action}`
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json()).toMatchObject({
        error: { code: "api_key_revoked" }
      });
    }
    const afterRejectedUpdates = await fixture.app.inject({
      url: "/admin/api/api-keys",
      headers: { cookie }
    });
    expect(afterRejectedUpdates.json()).toMatchObject({
      api_keys: [expect.objectContaining(revokedKey)]
    });

    const unknown = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: "/admin/api/api-keys/unknown/enable"
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("maps only account validation failures to 400", async () => {
    const fixture = await adminFixture();
    const { cookie, body } = await login(fixture);
    const originalCreate = fixture.dependencies.accounts.create;
    fixture.dependencies.accounts.create = () => {
      throw new TypeError("fixture repository validation detail");
    };

    const invalid = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: "/admin/api/accounts",
      payload: {
        name: "Valid schema input",
        priority: 0,
        daily_point_limit: 0,
        monthly_point_limit: 0
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain("fixture repository validation detail");

    fixture.dependencies.accounts.create = originalCreate;
    fixture.dependencies.accounts.create = () => {
      throw new Error("fixture unrelated database failure");
    };
    const unrelated = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: "/admin/api/accounts",
      payload: {
        name: "Another valid schema input",
        priority: 0,
        daily_point_limit: 0,
        monthly_point_limit: 0
      }
    });
    expect(unrelated.statusCode).toBe(502);
    expect(unrelated.body).not.toContain("fixture unrelated database failure");
  });

  it("creates, edits, checks, enables, disables, and lists safe account views", async () => {
    const fixture = await adminFixture();
    const { cookie, body } = await login(fixture);
    const created = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: "/admin/api/accounts",
      payload: {
        name: "Fixture account",
        priority: 2,
        daily_point_limit: 20,
        monthly_point_limit: 100
      }
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json<{
      account: Record<string, unknown> & { id: string; enabled: boolean };
      login_command: string;
    }>();
    expect(createdBody.account.enabled).toBe(false);
    expect(createdBody.login_command).toBe(
      `npm run login -- --account-id ${createdBody.account.id}`
    );
    expect(Object.keys(createdBody.account).sort()).toEqual([
      "active_jobs",
      "daily_point_limit",
      "daily_reserved_points",
      "daily_used_points",
      "enabled",
      "has_session",
      "health_status",
      "id",
      "last_checked_at",
      "last_error_code",
      "max_concurrency",
      "monthly_point_limit",
      "monthly_reserved_points",
      "monthly_used_points",
      "name",
      "points_balance",
      "priority",
      "subject_hash",
      "total_balance",
      "updated_at"
    ]);

    const duplicateCreate = await mutate(
      fixture,
      cookie,
      body.csrf_token,
      {
        method: "POST",
        url: "/admin/api/accounts",
        payload: {
          name: "Fixture account",
          priority: 0,
          daily_point_limit: 0,
          monthly_point_limit: 0
        }
      }
    );
    expect(duplicateCreate.statusCode).toBe(409);
    expect(duplicateCreate.json()).toMatchObject({
      error: { code: "account_name_conflict" }
    });

    const patched = await mutate(fixture, cookie, body.csrf_token, {
      method: "PATCH",
      url: `/admin/api/accounts/${createdBody.account.id}`,
      payload: {
        name: "Renamed fixture",
        priority: 1,
        daily_point_limit: 30,
        monthly_point_limit: 120
      }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      account: {
        name: "Renamed fixture",
        daily_point_limit: 30
      }
    });

    const duplicateRename = await mutate(
      fixture,
      cookie,
      body.csrf_token,
      {
        method: "PATCH",
        url: `/admin/api/accounts/${createdBody.account.id}`,
        payload: { name: "Legacy account" }
      }
    );
    expect(duplicateRename.statusCode).toBe(409);
    expect(duplicateRename.json()).toMatchObject({
      error: { code: "account_name_conflict" }
    });

    for (const payload of [
      { cookie: "fixture-cookie" },
      { auth_directory: "fixture-private-path" },
      { password: "fixture-password" },
      { credentials: "fixture-credentials" },
      { enabled: true },
      { priority: Number.MAX_SAFE_INTEGER + 1 },
      { priority: -1 },
      { daily_point_limit: 1.5 },
      { monthly_point_limit: -1 }
    ]) {
      const rejected = await mutate(fixture, cookie, body.csrf_token, {
        method: "PATCH",
        url: `/admin/api/accounts/${createdBody.account.id}`,
        payload
      });
      expect(rejected.statusCode).toBe(400);
    }

    const enabled = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: `/admin/api/accounts/${createdBody.account.id}/enable`
    });
    expect(enabled.statusCode).toBe(200);
    expect(fixture.runtimes.refresh).toHaveBeenLastCalledWith(
      createdBody.account.id
    );

    const checked = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: `/admin/api/accounts/${createdBody.account.id}/check`
    });
    expect(checked.statusCode).toBe(200);
    expect(fixture.runtimes.refresh).toHaveBeenLastCalledWith(
      createdBody.account.id
    );

    const disabled = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: `/admin/api/accounts/${createdBody.account.id}/disable`
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ account: { enabled: false } });

    const listed = await fixture.app.inject({
      url: "/admin/api/accounts",
      headers: { cookie }
    });
    expect(listed.statusCode).toBe(200);
    assertNoSensitiveValues(
      listed.body,
      [
        ADMIN_PASSWORD,
        "data/auth",
        "fixture-private-pin",
        "private-storage-state-path"
      ]
    );
  });

  it("returns sanitized overview, jobs, settings and resolves only a bound unknown job", async () => {
    const fixture = await adminFixture();
    const { cookie, body } = await login(fixture);
    const account = fixture.accounts.create({
      name: "Unknown owner",
      priority: 1,
      dailyPointLimit: 100,
      monthlyPointLimit: 100
    });
    fixture.accounts.update(account.id, { enabled: true });
    fixture.accounts.recordObservation(account.id, {
      healthStatus: "ready",
      lastErrorCode: null,
      subjectHash: "fixture-subject-hash",
      membership: null,
      pointsBalance: 100,
      totalBalance: 100,
      maxConcurrency: 2
    });
    await fixture.runtimes.refresh(account.id);
    const disabledReady = fixture.accounts.create({
      name: "Disabled ready",
      priority: 2,
      dailyPointLimit: 0,
      monthlyPointLimit: 0
    });
    fixture.accounts.recordObservation(disabledReady.id, {
      healthStatus: "ready",
      lastErrorCode: null,
      subjectHash: "fixture-disabled-subject",
      membership: null,
      pointsBalance: 50,
      totalBalance: 50,
      maxConcurrency: 1
    });
    const unhealthy = fixture.accounts.create({
      name: "Unhealthy account",
      priority: 3,
      dailyPointLimit: 0,
      monthlyPointLimit: 0
    });
    fixture.accounts.update(unhealthy.id, { enabled: true });
    fixture.accounts.recordObservation(unhealthy.id, {
      healthStatus: "unhealthy",
      lastErrorCode: "fixture-health-failure",
      subjectHash: "fixture-unhealthy-subject",
      membership: null,
      pointsBalance: 70,
      totalBalance: 70,
      maxConcurrency: 1
    });
    const admitted = fixture.admissions.reserveOrGet({
      accountId: account.id,
      quotedPoints: 4,
      windows: budgetWindows(),
      kind: "image",
      sourceType: "image-generation",
      model: "fixture-model",
      apiId: "fixture-api-id",
      modelCode: "fixture-model-code",
      expectedAssetScene: "fixture-scene",
      requestFingerprint: fixtureHash(),
      idempotencyKeyHash: null,
      spaceId: 1
    });
    if (admitted.outcome !== "created") {
      throw new Error("Fixture job was not created");
    }
    fixture.repository.transition(admitted.job.id, ["queued"], {
      status: "submitting"
    });
    fixture.admissions.charge(admitted.job.id);
    fixture.repository.transition(admitted.job.id, ["submitting"], {
      status: "unknown",
      unknownHoldUntil: Date.now() + 60_000
    });

    for (const url of [
      "/admin/api/overview",
      "/admin/api/jobs",
      `/admin/api/jobs/${admitted.job.id}`,
      "/admin/api/settings"
    ]) {
      const response = await fixture.app.inject({
        url,
        headers: { cookie }
      });
      expect(response.statusCode).toBe(200);
      assertNoSensitiveValues(response.body, [
        ADMIN_PASSWORD,
        admitted.job.requestFingerprint,
        "fixture-api-id",
        "fixture-model-code",
        "fixture-scene"
      ]);
    }

    const settings = await fixture.app.inject({
      url: "/admin/api/settings",
      headers: {
        cookie,
        host: "localhost:8000",
        "x-forwarded-host": "proxy.example:9443",
        "x-forwarded-proto": "https"
      }
    });
    expect(settings.json()).toMatchObject({
      shared_api_key_configured: true,
      legacy_api_key_configured: true,
      api_base_url: "http://localhost:8000/v1"
    });

    const overview = await fixture.app.inject({
      url: "/admin/api/overview",
      headers: { cookie }
    });
    expect(overview.json()).toMatchObject({
      balance: { available_points: 100 }
    });

    const detail = await fixture.app.inject({
      url: `/admin/api/jobs/${admitted.job.id}`,
      headers: { cookie }
    });
    expect(detail.json()).toMatchObject({
      job: {
        id: admitted.job.id,
        account_name: "Unknown owner",
        quoted_points: 4,
        budget_state: "charged",
        status: "unknown"
      }
    });

    const wrongAccount = fixture.accounts.create({
      name: "Wrong owner",
      priority: 2,
      dailyPointLimit: 0,
      monthlyPointLimit: 0
    });
    const rejected = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: `/admin/api/accounts/${wrongAccount.id}/resolve-unknown`,
      payload: { job_id: admitted.job.id, action: "release" }
    });
    expect(rejected.statusCode).toBe(409);

    const resolved = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: `/admin/api/accounts/${account.id}/resolve-unknown`,
      payload: { job_id: admitted.job.id, action: "release" }
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      job: { id: admitted.job.id, budget_state: "released" }
    });

    const repeated = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: `/admin/api/accounts/${account.id}/resolve-unknown`,
      payload: { job_id: admitted.job.id, action: "charge" }
    });
    expect(repeated.statusCode).toBe(409);

    const logout = await mutate(fixture, cookie, body.csrf_token, {
      method: "POST",
      url: "/admin/api/logout"
    });
    expect(logout.statusCode).toBe(204);
    const expired = await fixture.app.inject({
      url: "/admin/api/session",
      headers: { cookie }
    });
    expect(expired.statusCode).toBe(401);
  });
});
