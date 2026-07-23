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
  priceQuerySchema: Record<string, unknown> | null;
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
