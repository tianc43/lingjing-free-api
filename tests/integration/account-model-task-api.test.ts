import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errors } from "../../src/errors.js";
import {
  authorizedInject,
  createTestApp,
  fixtureHash,
  type TestApp
} from "../helpers/test-app.js";

describe("account, model, and task API", () => {
  let fixture: TestApp;

  beforeEach(async () => {
    fixture = await createTestApp();
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("returns only safe session state and disables caching", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/session"
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      mode: "browser-state",
      logged_in: true,
      login_required: false
    });
  });

  it("returns the normalized account snapshot without upstream space data", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/account"
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      object: "lingjing.account",
      subject: "safe-subject",
      membership: "pro",
      max_concurrency: 5,
      points_balance: 120,
      coupon_balance: 3,
      available_amount: 123,
      total_balance: 130,
      resource_packages: [{ name: "fixture", balance: 7 }]
    });
    expect(response.body).not.toContain("91001");
    expect(response.body).not.toContain("space");
  });

  it("checks the current saved session without accepting an upstream token", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/token/check"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: true });

    const withBody = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/token/check",
      payload: { token: "upstream-cookie-secret" }
    });
    expect(withBody.statusCode).toBe(400);
    expect(withBody.body).not.toContain("upstream-cookie-secret");
  });

  it("reports an expired saved session as invalid without leaking an upstream error", async () => {
    fixture.account.throwOnDescribe = errors.loginRequired();
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/token/check"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: false });
  });

  it("returns current balance fields without accepting an upstream token", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/token/points"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      points_balance: 120,
      coupon_balance: 3,
      available_amount: 123,
      total_balance: 130,
      resource_packages: [{ name: "fixture", balance: 7 }]
    });
  });

  it("queries only the requested image model source and presents safe fields", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/models?type=image"
    });
    expect(response.statusCode).toBe(200);
    expect(fixture.catalogCalls).toEqual(["image-generation"]);
    expect(response.json()).toMatchObject({
      object: "list",
      data: [{
        id: "fixture-image",
        object: "model",
        owned_by: "lingjing",
        type: "image",
        display_name: "Fixture Image"
      }]
    });
    expect(response.json<{
      data: Array<{ pricing: unknown }>;
    }>().data[0]?.pricing).toEqual({
      points: 2,
      currency: "CNY",
      price: {
        amount: 2,
        unit: "image"
      }
    });
    for (const forbidden of [
      "707",
      "upstream-image-id",
      "private-model-code",
      "private-ref-id",
      "private-scene-code",
      "private-asset-scene",
      "private-revision",
      "private-index",
      "private-pricing-api-id",
      "private-pricing-asset-id",
      "private-pricing-user-id",
      "private-pricing-scene-code",
      "private-pricing-token",
      "private-adversarial-price-key",
      "private-price-signature",
      "private-raw-payload",
      "private-pricing-mystery",
      "\"nested\"",
      "\"mystery\"",
      "91001"
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it("queries only image-to-video when that mode is selected", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/models?type=video&mode=image-to-video"
    });
    expect(response.statusCode).toBe(200);
    expect(fixture.catalogCalls).toEqual(["image-to-video"]);
    expect(response.json()).toMatchObject({
      data: [{ id: "fixture-video", type: "video", mode: "image-to-video" }]
    });
  });

  it("forwards an explicit model catalog refresh without coercing false to true", async () => {
    await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/models?type=image&refresh=false"
    });
    await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/models?type=image&refresh=true"
    });
    expect(fixture.catalogRefreshes).toEqual([false, true]);
  });

  it("validates model query parameters with a 400 OpenAI error", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/models?type=audio"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "invalid_request"
      }
    });
  });

  it("returns 404 for an unknown local task", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/tasks/job_missing"
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      error: {
        type: "invalid_request_error",
        code: "task_not_found"
      }
    });
  });

  it("lists only matching local tasks and never presents private persistence fields", async () => {
    const processing = fixture.repository.createOrGet({
      kind: "image",
      sourceType: "image-generation",
      model: "fixture-image",
      apiId: "private-api-id",
      modelCode: "private-model-code",
      expectedAssetScene: "private-asset-scene",
      requestFingerprint: fixtureHash(),
      idempotencyKeyHash: fixtureHash(),
      spaceId: 91_001
    }).job;
    fixture.repository.transition(processing.id, ["queued"], {
      status: "submitting",
      upstreamFingerprint: fixtureHash(),
      submittedAt: Date.now()
    });
    fixture.repository.transition(processing.id, ["submitting"], {
      status: "discovering"
    });
    fixture.repository.transition(processing.id, ["discovering"], {
      status: "processing",
      creationCode: "private-creation-code",
      upstreamTaskId: "private-upstream-task-id"
    });
    fixture.repository.createOrGet({
      kind: "video",
      sourceType: "text-to-video",
      model: "fixture-video",
      apiId: "another-private-api-id",
      modelCode: null,
      expectedAssetScene: "video",
      requestFingerprint: fixtureHash(),
      idempotencyKeyHash: null,
      spaceId: 91_001
    });

    const response = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/v1/tasks?limit=10&status=processing"
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      object: "list",
      data: [{
        id: processing.id,
        object: "lingjing.task",
        kind: "image",
        model: "fixture-image",
        status: "processing",
        error: null,
        outputs: []
      }]
    });
    expect(response.json<{ data: unknown[] }>().data).toHaveLength(1);
    for (const forbidden of [
      processing.requestFingerprint,
      processing.idempotencyKeyHash ?? "",
      "private-api-id",
      "private-model-code",
      "private-asset-scene",
      "private-creation-code",
      "private-upstream-task-id",
      "91001"
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it("protects both OpenAPI JSON and documentation UI", async () => {
    expect((await fixture.app.inject({
      method: "GET",
      url: "/openapi.json"
    })).statusCode).toBe(401);
    expect((await fixture.app.inject({
      method: "GET",
      url: "/docs/"
    })).statusCode).toBe(401);

    const specification = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/openapi.json"
    });
    expect(specification.statusCode).toBe(200);
    const document = specification.json<{
      openapi: string;
      paths: Record<string, Record<string, {
        security?: unknown[];
        parameters?: Array<{ name?: string }>;
        requestBody?: unknown;
        responses?: Record<string, { content?: unknown }>;
      }>>;
    }>();
    expect(document.openapi).toMatch(/^3\./u);
    expect(document.paths["/healthz"]?.get?.security).toEqual([]);
    expect(document.paths["/ping"]?.get?.security).toEqual([]);
    expect(document.paths["/v1/models"]?.get?.security).toEqual([
      { bearerAuth: [] }
    ]);
    expect(
      document.paths["/v1/models"]?.get?.parameters?.map(
        (parameter) => parameter.name
      )
    ).toEqual(expect.arrayContaining(["type", "mode", "refresh"]));
    expect(
      document.paths["/v1/models"]?.get?.responses?.["200"]?.content
    ).toBeDefined();
    expect(
      document.paths["/v1/tasks/{id}"]?.get?.parameters?.map(
        (parameter) => parameter.name
      )
    ).toContain("id");
    expect(
      document.paths["/token/check"]?.post?.requestBody
    ).toBeDefined();
    expect((await authorizedInject(fixture.app, {
      method: "GET",
      url: "/docs/"
    })).statusCode).toBe(200);
  });

  it("does not reveal unknown route existence before authentication", async () => {
    for (const url of ["/does-not-exist", "/v1/not-a-real-route"]) {
      const anonymous = await fixture.app.inject({
        method: "GET",
        url
      });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers["cache-control"]).toBe("no-store");
      expect(anonymous.json()).toMatchObject({
        error: { code: "invalid_api_key" }
      });

      const authorized = await authorizedInject(fixture.app, {
        method: "GET",
        url
      });
      expect(authorized.statusCode).toBe(404);
      expect(authorized.headers["cache-control"]).toBe("no-store");
      expect(authorized.json()).toMatchObject({
        error: { code: "route_not_found" }
      });
    }
  });
});
