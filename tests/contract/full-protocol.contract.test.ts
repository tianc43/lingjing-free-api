import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { LingjingClient } from "../../src/lingjing/client.js";
import { CatalogService } from "../../src/models/catalog.js";
import type { PreparedMedia } from "../../src/media/types.js";
import { LingjingUploadService } from "../../src/uploads/upload-service.js";
import {
  createGenerationHarness,
  fixtureRequest
} from "../helpers/generation-harness.js";
import { MockLingjing } from "../helpers/mock-lingjing.js";

const mocks: MockLingjing[] = [];
const harnesses: ReturnType<typeof createGenerationHarness>[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(mocks.splice(0).map((mock) => mock.dispatcher.close()));
});

async function clientFixture(): Promise<{
  client: LingjingClient;
  mock: MockLingjing;
}> {
  const mock = new MockLingjing();
  mocks.push(mock);
  const session = mock.createSession("browser-state");
  await session.seed();
  return {
    mock,
    client: new LingjingClient({
      baseUrl: mock.baseUrl,
      session,
      dispatcher: mock.dispatcher,
      sleep: () => Promise.resolve()
    })
  };
}

function media(body = Buffer.from("fixture")): PreparedMedia {
  return {
    filename: "fixture.png",
    contentType: "image/png",
    size: body.byteLength,
    openRead: (start = 0, endInclusive = body.byteLength - 1) =>
      Readable.from(body.subarray(start, endInclusive + 1)),
    dispose: () => Promise.resolve()
  };
}

function rawModel(apiId: string, name: string): Record<string, unknown> {
  return {
    apiId,
    id: apiId,
    modelName: name,
    sourceType: "image-generation",
    modelCode: `fixture-code-${apiId}`,
    refId: `fixture-ref-${apiId}`,
    sceneCode: "fixture-scene",
    assetScene: "image-generation",
    uploadStrategy: "general",
    parameters: [{
      index: 1,
      fieldName: "prompt",
      fieldName4View: "Prompt",
      required: true,
      style: { type: "textarea" }
    }]
  };
}

describe("complete Lingjing web protocol contract", () => {
  it("accepts a logged-in envelope and maps HTTP-200 USER_NOT_LOGIN", async () => {
    const { client, mock } = await clientFixture();
    mock.respondToPath("/api/user/describeBaseInfo", {
      pinName: "fixture-user"
    });
    await expect(client.read("/api/user/describeBaseInfo")).resolves.toEqual({
      pinName: "fixture-user"
    });

    mock.queueEnvelope("/api/user/describeBaseInfo", {
      statusCode: 200,
      error: { code: "USER_NOT_LOGIN", message: "fixture expired" }
    });
    await expect(client.read("/api/user/describeBaseInfo")).rejects.toMatchObject({
      statusCode: 503,
      code: "lingjing_session_expired"
    });
  });

  it("refreshes CSRF exactly once before retrying a read", async () => {
    const mock = new MockLingjing();
    mocks.push(mock);
    const session = mock.createSession("browser-state");
    await session.seed();
    session.refreshOnInvalidate("fixture-refreshed-csrf");
    const client = new LingjingClient({
      baseUrl: mock.baseUrl,
      session,
      dispatcher: mock.dispatcher,
      sleep: () => Promise.resolve()
    });
    mock.failCsrfReads(2);

    await expect(client.read("/fixture-csrf")).resolves.toEqual({ ok: true });
    expect(session.invalidateCount).toBe(1);
    expect(session.refreshCount).toBe(1);
    expect(mock.count("/fixture-csrf")).toBe(3);
  });

  it("rejects ambiguous aliases and a charged model schema change", async () => {
    const { client, mock } = await clientFixture();
    const catalog = new CatalogService(client, 60_000);
    const first = rawModel("fixture-1", "Fixture Same");
    const second = rawModel("fixture-2", "Fixture Same");
    mock.respondToPath(
      "/joycreator/AIModelApiConsole/getBySourceType",
      [first, second]
    );

    await expect(
      catalog.resolve("fixture-same", "image-generation")
    ).rejects.toMatchObject({ code: "model_catalog_changed" });

    mock.respondToPath(
      "/joycreator/AIModelApiConsole/getBySourceType",
      [first]
    );
    await catalog.list("image-generation", true);
    mock.respondToPath(
      "/joycreator/AIModelApiConsole/getByApiId",
      [{ ...first, parameters: [] }]
    );
    await expect(
      catalog.resolve("fixture-1", "image-generation", true)
    ).rejects.toMatchObject({ code: "model_catalog_changed" });
  });

  it.each(["single", "multipart"] as const)(
    "uploads through the complete %s protocol",
    async (uploadType) => {
      const { client, mock } = await clientFixture();
      const body = Buffer.from("abcdef");
      mock.respondToPath(
        "/joycreator/upload/init",
        uploadType === "single"
          ? {
              single: {
                uploadId: "fixture-upload-single",
                uploadUrl: `${mock.objectUrl.origin}/fixture-single`
              }
            }
          : {
              multipart: {
                uploadId: "fixture-upload-multipart",
                totalParts: 2,
                parts: [
                  {
                    partNumber: 1,
                    byteStart: 0,
                    byteEndInclusive: 2,
                    uploadUrl: `${mock.objectUrl.origin}/fixture-part-1`
                  },
                  {
                    partNumber: 2,
                    byteStart: 3,
                    byteEndInclusive: 5,
                    uploadUrl: `${mock.objectUrl.origin}/fixture-part-2`
                  }
                ]
              }
            }
      );
      mock.respondToPath("/joycreator/upload/complete", {
        filePath: "fixture/uploads/result.png",
        frameUrl: null
      });
      const service = new LingjingUploadService(client, {
        uploadStrategy: "general"
      });

      await expect(service.upload(media(body), {
        sceneCode: "fixture-scene",
        modelCode: "fixture-model",
        spaceId: 0
      })).resolves.toMatchObject({
        filePath: "fixture/uploads/result.png"
      });
      expect(mock.count("/joycreator/upload/init")).toBe(1);
      expect(mock.count("/joycreator/upload/complete")).toBe(1);
      expect(mock.count("/joycreator/upload/cancel")).toBe(0);
      expect(mock.count(uploadType === "single"
        ? "/fixture-single"
        : "/fixture-part-1")).toBe(1);
      if (uploadType === "multipart") {
        expect(mock.count("/fixture-part-2")).toBe(1);
      }
    }
  );

  it.each([
    ["insufficient points", "POINT_NOT_ENOUGH", 200, "lingjing_insufficient_points"],
    ["rate limit", "RATE_LIMIT", 429, "lingjing_rate_limited"],
    ["policy refusal", "CONTENT_AUDIT", 200, "content_policy_violation"],
    ["upstream 5xx", "UPSTREAM_FAILURE", 503, "lingjing_upstream_error"]
  ] as const)(
    "maps %s without retrying generation submit",
    async (_name, code, statusCode, expectedCode) => {
      const { client, mock } = await clientFixture();
      const path = "/joycreator/AIModelApiConsole/executeByApiId";
      mock.queueEnvelope(path, {
        statusCode,
        error: { code, message: "fixture failure" }
      });

      await expect(client.submitOnce(path, {})).rejects.toMatchObject({
        code: expectedCode
      });
      expect(mock.count(path)).toBe(1);
    }
  );

  it.each([
    "normal-no-task-id",
    "ambiguous-assets",
    "disconnect-after-write",
    "post-submit-read-failure"
  ] as const)(
    "keeps generation submit at most once for %s",
    async (scenario) => {
      const harness = createGenerationHarness({
        unknownCapacityHoldMs: 20
      });
      harnesses.push(harness);
      if (scenario === "ambiguous-assets") harness.addAssetsPerSubmit(2);
      if (scenario === "disconnect-after-write") {
        harness.disconnectNextSubmit();
      }
      if (scenario === "post-submit-read-failure") {
        harness.failNextPostSubmitAssetRead();
      }

      const handle = await harness.coordinator.create(fixtureRequest());
      if (scenario === "normal-no-task-id" || scenario === "disconnect-after-write") {
        await expect(handle.wait(1_000)).resolves.toMatchObject({
          status: "completed"
        });
      } else {
        await harness.registry.waitUntilIdle();
        expect(harness.repository.findById(handle.job.id)?.status).toBe("unknown");
      }
      expect(harness.submitCount()).toBe(1);
    }
  );

  it.each([
    [[0, 1], "completed"],
    [[1], "completed"],
    [[2], "failed"]
  ] as const)(
    "normalizes upstream task statuses %j to %s",
    async (initialTaskStatuses, expected) => {
      const harness = createGenerationHarness({
        initialTaskStatuses: [...initialTaskStatuses]
      });
      harnesses.push(harness);
      const handle = await harness.coordinator.create(fixtureRequest());
      await expect(handle.wait(1_000)).resolves.toMatchObject({
        status: expected
      });
      expect(harness.submitCount()).toBe(1);
    }
  );
});
