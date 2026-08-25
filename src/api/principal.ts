import type { FastifyRequest } from "fastify";
import type {
  ApiKeyPrincipal,
  ApiKeyScope
} from "../api-keys/types.js";
import { errors } from "../errors.js";

const principals = new WeakMap<FastifyRequest, ApiKeyPrincipal>();

export function bindPrincipal(
  request: FastifyRequest,
  principal: ApiKeyPrincipal
): void {
  principals.set(request, principal);
}

export function requestPrincipal(request: FastifyRequest): ApiKeyPrincipal {
  const principal = principals.get(request);
  if (principal === undefined) throw errors.authentication();
  return principal;
}

export function requireScope(
  request: FastifyRequest,
  scope: ApiKeyScope
): ApiKeyPrincipal {
  const principal = requestPrincipal(request);
  if (!principal.scopes.includes(scope)) throw errors.apiScopeDenied();
  return principal;
}

export function generationPrincipal(request: FastifyRequest): {
  userId: string;
  projectId: string;
  apiKeyId: string;
} {
  const principal = requestPrincipal(request);
  return {
    userId: principal.userId,
    projectId: principal.projectId,
    apiKeyId: principal.apiKeyId
  };
}
