import { createHash, timingSafeEqual } from "node:crypto";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isAuthorized(authorization: string | string[] | undefined, configuredToken: string): boolean {
  if (typeof authorization !== "string" || Array.isArray(authorization)) {
    return false;
  }

  const match = /^Bearer ([^\s,]+)$/.exec(authorization);
  if (match === null) {
    return false;
  }

  const token = match[1];
  if (token === undefined) {
    return false;
  }

  const providedDigest = sha256(token);
  const configuredDigest = sha256(configuredToken);
  return providedDigest.length === configuredDigest.length && timingSafeEqual(providedDigest, configuredDigest);
}
