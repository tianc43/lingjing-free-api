import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiKeyPrincipal, ApiKeyScope } from "../api-keys/types.js";

const LEGACY_SCOPES: readonly ApiKeyScope[] = [
  "models:read",
  "video:create",
  "video:read",
  "image:create",
  "image:read"
];

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function parseBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string" || Array.isArray(header)) return null;
  const match = /^Bearer ([^\s,]+)$/.exec(header);
  return match?.[1] ?? null;
}

function constantTimeEqual(provided: string, configured: string): boolean {
  const providedDigest = sha256(provided);
  const configuredDigest = sha256(configured);
  return providedDigest.length === configuredDigest.length
    && timingSafeEqual(providedDigest, configuredDigest);
}

export interface ManagedApiKeyAuthenticator {
  authenticate?(token: string): ApiKeyPrincipal | null;
  verify?(token: string): boolean;
}

export function authenticateBearer(
  header: string | string[] | undefined,
  configuredToken: string,
  managedKeys?: ManagedApiKeyAuthenticator
): ApiKeyPrincipal | null {
  const token = parseBearerToken(header);
  if (token === null) return null;
  if (constantTimeEqual(token, configuredToken)) {
    return {
      userId: "usr_legacy",
      projectId: "prj_legacy",
      apiKeyId: "key_legacy_environment",
      scopes: LEGACY_SCOPES,
      legacy: true
    };
  }
  const principal = managedKeys?.authenticate?.(token);
  if (principal !== undefined && principal !== null) return principal;
  if (managedKeys?.verify?.(token) === true) {
    return {
      userId: "usr_legacy",
      projectId: "prj_legacy",
      apiKeyId: "key_legacy_managed",
      scopes: LEGACY_SCOPES,
      legacy: true
    };
  }
  return null;
}

export function isAuthorized(
  header: string | string[] | undefined,
  configuredToken: string,
  managedKeys?: ManagedApiKeyAuthenticator
): boolean {
  return authenticateBearer(header, configuredToken, managedKeys) !== null;
}
