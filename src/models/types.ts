export type SourceType = "image-generation" | "text-to-video" | "image-to-video" | (string & {});

export interface NormalizedParameter {
  idx: string;
  key: string;
  displayName: string;
  required: boolean;
  kind: "string" | "number" | "boolean" | "enum" | "image-list";
  defaultValue?: unknown;
  minimum?: number;
  maximum?: number;
  options?: string[];
  maxFiles?: number;
}

export interface NormalizedPriceSelector {
  matches: string[];
  shortName?: string;
}

export interface NormalizedPriceField {
  index?: string;
  key: string;
  billingItemType: string;
  selectors?: NormalizedPriceSelector[];
}

export interface NormalizedPriceQuery {
  strategy?: "calculate" | "formula";
  priceQueryService?: string;
  shortVender?: string;
  shortSenceCode?: string;
  params?: Record<string, string | number | boolean>;
  fields?: NormalizedPriceField[];
  [key: string]: unknown;
}

export interface NormalizedModel {
  id: string;
  apiId: string;
  alias: string;
  displayName: string;
  sourceType: SourceType;
  modelCode: string | null;
  refId: string;
  sceneCode: string;
  expectedAssetScene: string;
  uploadStrategy: "general" | "materials";
  priceQuerySchema: NormalizedPriceQuery | null;
  parameters: NormalizedParameter[];
  pricing: unknown;
  rawRevision: string;
}

export interface BuiltPayload {
  apiId: string;
  params: Array<{ idx: string; name: string; values: unknown; filePath?: string[] }>;
  refId: string;
  spaceId: number;
  priceQueryResult?: Record<string, unknown>;
}
