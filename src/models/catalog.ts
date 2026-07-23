import { errors } from "../errors.js";
import type { LingjingTransport } from "../lingjing/types.js";
import { normalizeModels } from "./normalize.js";
import type { NormalizedModel, SourceType } from "./types.js";

type RawModel = Record<string, unknown>;

interface Entry {
  models: NormalizedModel[];
  expiresAt: number;
}

function isPlainObject(value: unknown): value is RawModel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rawModels(response: unknown): RawModel[] {
  if (Array.isArray(response)) return response.filter(isPlainObject);
  if (!isPlainObject(response)) return [];
  if (Array.isArray(response.result)) {
    return response.result.filter(isPlainObject);
  }
  if (isPlainObject(response.result)) return [response.result];
  return [response];
}

function asIdentifier(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

function hasNonEmptyValue(value: unknown): boolean {
  const stringValue = asIdentifier(value);
  return stringValue !== undefined && stringValue.trim().length > 0;
}

function usesMaterialsUpload(raw: RawModel): boolean {
  return raw.uploadStrategy === "materials" || raw.materialUpload === true;
}

function hasRequiredMaterialsMetadata(raw: RawModel): boolean {
  return hasNonEmptyValue(raw.modelCode)
    && (hasNonEmptyValue(raw.sceneCode) || hasNonEmptyValue(raw.scene))
    && hasNonEmptyValue(raw.assetScene);
}

function normalizeAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export class CatalogService {
  private readonly cache = new Map<SourceType, Entry>();
  private readonly inFlight = new Map<
    SourceType,
    Promise<NormalizedModel[]>
  >();

  constructor(
    private readonly transport: Pick<LingjingTransport, "read">,
    private readonly ttlMs: number
  ) {}

  async list(
    sourceType: SourceType,
    refresh = false
  ): Promise<NormalizedModel[]> {
    if (refresh) {
      this.cache.delete(sourceType);
    }
    const cached = this.cache.get(sourceType);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.models;
    }

    const pending = this.inFlight.get(sourceType);
    if (pending !== undefined) return pending;

    const request = this.transport.read<unknown>(
      "/joycreator/AIModelApiConsole/getBySourceType",
      {
        method: "POST",
        body: { sourceType }
      }
    ).then((raw) => {
      const models = normalizeModels(sourceType, raw);
      this.cache.set(sourceType, {
        models,
        expiresAt: Date.now() + this.ttlMs
      });
      return models;
    }).finally(() => {
      this.inFlight.delete(sourceType);
    });

    this.inFlight.set(sourceType, request);
    return request;
  }

  async resolve(
    value: string,
    sourceType: SourceType,
    charged = false
  ): Promise<NormalizedModel> {
    const models = await this.list(sourceType);
    const exact = models.find((model) => model.apiId === value);
    const aliases = exact === undefined
      ? models.filter((model) => model.alias === normalizeAlias(value))
      : [];

    if (exact === undefined && aliases.length !== 1) {
      throw errors.catalogChanged();
    }

    const model = exact ?? aliases[0];
    if (model === undefined) throw errors.catalogChanged();
    if (!charged) return model;

    return this.refreshExact(model, sourceType);
  }

  private async refreshExact(
    model: NormalizedModel,
    sourceType: SourceType
  ): Promise<NormalizedModel> {
    const refreshed = await this.transport.read<unknown>(
      "/joycreator/AIModelApiConsole/getByApiId",
      {
        method: "POST",
        body: { apiId: model.apiId }
      }
    );
    const raw = rawModels(refreshed).find(
      (candidate) => asIdentifier(candidate.apiId) === model.apiId
    );
    const next = normalizeModels(sourceType, refreshed).find(
      (candidate) => candidate.apiId === model.apiId
    );
    if (raw === undefined || next === undefined) {
      throw errors.catalogChanged();
    }

    const entry = this.cache.get(sourceType);
    if (entry !== undefined) {
      entry.models = entry.models.map((candidate) => (
        candidate.apiId === next.apiId ? next : candidate
      ));
    }

    if (
      (usesMaterialsUpload(raw) && !hasRequiredMaterialsMetadata(raw))
      || next.rawRevision !== model.rawRevision
    ) {
      throw errors.catalogChanged();
    }

    return next;
  }
}
