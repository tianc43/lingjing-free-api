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
