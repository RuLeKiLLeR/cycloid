import { z } from "zod";

import { listCliTokensByUser } from "../auth/cli-tokens";
import { CLI_TOKEN_SCOPES, MAX_CLI_TOKEN_EXPIRY_DAYS } from "../constants/cli-tokens";
import { createCliToken, deleteCliToken, getCliTokenForUser, revokeCliToken } from "../services/cli-tokens";
import {
  beginIdempotentRequest,
  commitIdempotentRequest,
  type IdempotencyToken,
  readIdempotencyKeyHeader,
  releaseIdempotentRequest,
} from "../services/idempotency";
import type { CliTokenScope } from "../types";
import type { AuthInfo, Env } from "../types";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { parseBody, parsePattern } from "./shared";

const CLI_TOKEN_SCOPE_SET = new Set<string>(CLI_TOKEN_SCOPES);

const CreateCliTokenBodySchema = z
  .object({
    expiresInDays: z
      .unknown()
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return undefined;
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_CLI_TOKEN_EXPIRY_DAYS) {
          ctx.addIssue({
            code: "custom",
            message: `expiresInDays must be a positive integer no greater than ${MAX_CLI_TOKEN_EXPIRY_DAYS}`,
          });
          return z.NEVER;
        }
        return value as number;
      }),
    scope: z
      .unknown()
      .optional()
      .transform((value, ctx) => {
        if (value === undefined) return undefined;
        if (typeof value !== "string" || !CLI_TOKEN_SCOPE_SET.has(value)) {
          ctx.addIssue({
            code: "custom",
            message: `scope must be one of: ${CLI_TOKEN_SCOPES.join(", ")}`,
          });
          return z.NEVER;
        }
        return value as CliTokenScope;
      }),
  })
  .passthrough();

export const cliTokenRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/cli-tokens"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => handleListCliTokens(request, env, auth!),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/cli-tokens"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => handleCreateCliToken(request, env, auth!),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/cli-tokens/:id/revoke"),
    auth: "authenticated",
    handler: async (_req, env, match, auth) => handleRevokeCliToken(env, auth!, match.groups!.id),
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/cli-tokens/:id"),
    auth: "authenticated",
    handler: async (_req, env, match, auth) => handleDeleteCliToken(env, auth!, match.groups!.id),
  },
];

async function handleListCliTokens(request: Request, env: Env, auth: AuthInfo): Promise<Response> {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const cursor = url.searchParams.get("cursor") ?? undefined;

  const result = await listCliTokensByUser(env.DB, Number(auth.userId), Number.isFinite(limit) ? limit : 50, cursor);
  return jsonResponse(result);
}

async function handleCreateCliToken(request: Request, env: Env, auth: AuthInfo): Promise<Response> {
  const parsedBody = await parseBody(request, CreateCliTokenBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;

  const requestedScope = body.scope ?? "read";
  if (auth.authMode === "cli_token" && requestedScope === "write") {
    return jsonErrorResponse("CLI tokens cannot create write-scoped tokens", 403);
  }

  let expiresAt: number | undefined;
  if (body.expiresInDays !== undefined) {
    expiresAt = Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000;
  }

  let idempotencyToken: IdempotencyToken | null = null;
  const idempotencyKey = readIdempotencyKeyHeader(request);
  if (idempotencyKey) {
    const decision = await beginIdempotentRequest(env.DB, {
      key: idempotencyKey,
      ownerUserId: auth.userId,
      route: "cli_token_create",
      requestBody: body,
    });
    if (decision.kind === "replay" || decision.kind === "reject") {
      return jsonErrorResponse(
        decision.kind === "reject" && decision.reason === "payload_mismatch"
          ? "Idempotency-Key was already used with a different request payload"
          : "A request with this Idempotency-Key already exists; retry with a new key for a new token",
        409,
        { code: "duplicate_request", retryable: decision.kind === "reject" && decision.reason === "in_progress" },
      );
    }
    if (decision.kind === "proceed") idempotencyToken = decision.token;
  }

  const result = await createCliToken(env.DB, Number(auth.userId), requestedScope, expiresAt);
  if (!result.ok) {
    if (idempotencyToken) await releaseIdempotentRequest(env.DB, idempotencyToken);
    return jsonErrorResponse(result.error, 409);
  }
  if (idempotencyToken) await commitIdempotentRequest(env.DB, idempotencyToken, String(result.id));

  const response = jsonResponse({ ok: true, token: result.token, id: result.id, scope: result.scope });
  response.headers.set("cache-control", "no-store, private");
  return response;
}

async function handleRevokeCliToken(env: Env, auth: AuthInfo, idParam: string): Promise<Response> {
  const tokenId = Number(idParam);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return jsonErrorResponse("Invalid token ID", 400);
  }

  if (auth.authMode === "cli_token" && auth.cliTokenScope === "read") {
    const targetToken = await getCliTokenForUser(env.DB, Number(auth.userId), tokenId);
    if (targetToken?.scope === "write") {
      return jsonErrorResponse("Read-scoped CLI tokens cannot revoke write-scoped CLI tokens", 403);
    }
  }

  await revokeCliToken(env.DB, Number(auth.userId), tokenId);
  return jsonResponse({ ok: true });
}

async function handleDeleteCliToken(env: Env, auth: AuthInfo, idParam: string): Promise<Response> {
  const tokenId = Number(idParam);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return jsonErrorResponse("Invalid token ID", 400);
  }

  await deleteCliToken(env.DB, Number(auth.userId), tokenId);
  return jsonResponse({ ok: true });
}
