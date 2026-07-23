import { errors } from "../errors.js";
import type { LingjingTransport } from "../lingjing/types.js";
import { normalizeModels } from "./normalize.js";
import type { NormalizedModel, SourceType } from "./types.js";

interface Entry { models: NormalizedModel[]; expiresAt: number; }
export class CatalogService {
  private readonly cache = new Map<SourceType, Entry>();
  private readonly inFlight = new Map<SourceType, Promise<NormalizedModel[]>>();
  constructor(private readonly transport: Pick<LingjingTransport, "read">, private readonly ttlMs: number) {}
  async list(sourceType: SourceType): Promise<NormalizedModel[]> {
    const cached = this.cache.get(sourceType); if (cached !== undefined && cached.expiresAt > Date.now()) return cached.models;
    const pending = this.inFlight.get(sourceType); if (pending !== undefined) return pending;
    const request = this.transport.read<unknown>("/joycreator/AIModelApiConsole/getBySourceType", { method: "POST", body: { sourceType } }).then((raw) => {
      const models = normalizeModels(sourceType, raw); this.cache.set(sourceType, { models, expiresAt: Date.now() + this.ttlMs }); return models;
    }).finally(() => { this.inFlight.delete(sourceType); });
    this.inFlight.set(sourceType, request); return request;
  }
  async resolve(value: string, sourceType: SourceType, charged = false): Promise<NormalizedModel> {
    const models = await this.list(sourceType);
    const exact = models.find((model) => model.apiId === value);
    const aliases = exact === undefined ? models.filter((model) => model.alias === value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "")) : [];
    if (exact === undefined && aliases.length !== 1) throw errors.catalogChanged();
    const model = exact ?? aliases[0];
    if (model === undefined) throw errors.catalogChanged();
    if (!charged) return model;
    const refreshed = await this.transport.read<unknown>("/joycreator/AIModelApiConsole/getByApiId", { method: "POST", body: { apiId: model.apiId } });
    const next = normalizeModels(sourceType, refreshed).find((candidate) => candidate.apiId === model.apiId);
    if (next === undefined) throw errors.catalogChanged();
    const entry = this.cache.get(sourceType);
    if (entry !== undefined) entry.models = entry.models.map((candidate) => candidate.apiId === next.apiId ? next : candidate);
    const missingMaterialMetadata = next.uploadStrategy === "materials" && (next.modelCode === null || next.modelCode.length === 0 || next.sceneCode === sourceType || next.expectedAssetScene === sourceType);
    if (missingMaterialMetadata || next.rawRevision !== model.rawRevision) throw errors.catalogChanged();
    return next;
  }
}
