import { createHash, timingSafeEqual } from "node:crypto";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function parseBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== "string" || Array.isArray(header)) {
    return null;
  }
  const match = /^Bearer ([^\s,]+)$/.exec(header);
  return match?.[1] ?? null;
}

function constantTimeEqual(provided: string, configured: string): boolean {
  const providedDigest = sha256(provided);
  const configuredDigest = sha256(configured);
  return providedDigest.length === configuredDigest.length && timingSafeEqual(providedDigest, configuredDigest);
}

export interface ManagedApiKeyVerifier {
  verify(token: string): boolean;
}

export function isAuthorized(
  header: string | string[] | undefined,
  configuredToken: string,
  managedKeys?: ManagedApiKeyVerifier
): boolean {
  const token = parseBearerToken(header);
  if (token === null) {
    return false;
  }
  return constantTimeEqual(token, configuredToken) || managedKeys?.verify(token) === true;
}
