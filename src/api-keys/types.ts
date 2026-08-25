export type ApiKeyScope =
  | "models:read"
  | "video:create"
  | "video:read"
  | "image:create"
  | "image:read";

export interface ApiKeyPrincipal {
  userId: string;
  projectId: string;
  apiKeyId: string;
  scopes: readonly ApiKeyScope[];
  legacy: boolean;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  projectId: string;
  name: string;
  keyPrefix: string;
  scopes: readonly ApiKeyScope[];
  enabled: boolean;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface CreatedApiKey {
  record: ApiKeyRecord;
  secret: string;
}
