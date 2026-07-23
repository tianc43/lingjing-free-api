import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CatalogService } from "../../src/models/catalog.js";
import { normalizeModels } from "../../src/models/normalize.js";

const imageFixture: unknown = JSON.parse(readFileSync(new URL("../fixtures/models/image-generation.json", import.meta.url), "utf8"));

describe("dynamic model normalization", () => {
  it("creates stable apiId and readable alias identifiers", () => {
    const models = normalizeModels("image-generation", imageFixture);
    expect(models[0]).toMatchObject({ id: "707", apiId: "707", alias: "fixture-seedream-5-0-lite", sourceType: "image-generation" });
    expect(models[0]?.parameters.find((item) => item.key === "prompt")).toMatchObject({ required: true, kind: "string" });
  });

  it("changes rawRevision when the upstream schema changes", () => {
    const first = normalizeModels("image-generation", imageFixture);
    const changed = structuredClone(imageFixture) as { result: Array<{ parameters: Array<{ required: boolean }> }> };
    const changedModel = changed.result.at(0); const changedParameter = changedModel?.parameters.at(0);
    if (changedParameter === undefined) throw new Error("fixture is malformed");
    changedParameter.required = true;
    expect(first[0]?.rawRevision).not.toBe(normalizeModels("image-generation", changed)[0]?.rawRevision);
  });

  it("uses fieldName as the request key and Chinese metadata only as display text", () => {
    expect(normalizeModels("image-generation", imageFixture)[0]?.parameters.find((item) => item.idx === "2")).toMatchObject({ key: "prompt", displayName: "提示词" });
  });

  it("coalesces catalog reads, resolves apiId before alias, and refreshes charged models exactly", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const service = new CatalogService({ read: <T>(path: string, init?: { body?: unknown }) => {
      calls.push({ path, ...(init?.body === undefined ? {} : { body: init.body }) });
      return Promise.resolve(imageFixture as T);
    } }, 60_000);
    const [first, second] = await Promise.all([service.list("image-generation"), service.list("image-generation")]);
    expect(first).toEqual(second);
    expect(calls).toHaveLength(1);
    await expect(service.resolve("707", "image-generation", true)).resolves.toMatchObject({ apiId: "707" });
    expect(calls.map((call) => call.path)).toContain("/joycreator/AIModelApiConsole/getByApiId");
  });
});
