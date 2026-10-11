import { z } from "zod";

import {
  createImpersonationIfActorBelowLimit,
  getActiveImpersonationTarget,
  getImpersonationById,
  listImpersonationDirectory,
  revokeImpersonation,
  searchImpersonationTargets,
} from "../auth/impersonation-db";
import {
  IMPERSONATION_COOKIE_NAME,
  IMPERSONATION_MAX_ACTIVE_PER_ACTOR,
  IMPERSONATION_REASON_MAX_LENGTH,
  IMPERSONATION_TTL_MS,
} from "../constants/auth";
import { HTTP_RESPONSE_BODY } from "../constants/http-responses";
import { createLogger } from "../logger";
import { verifyCycloidAdmin } from "../services/internal-feature-gate";
import { assertDatabase } from "../session/state";
import type { AuthInfo, Env } from "../types";
import {
  clearCookieHeader,
  computeSha256Hex,
  generateRandomHex,
  jsonErrorResponse,
  jsonResponse,
  parseSessionTokenCookie,
  setCookieHeader,
} from "../utils";
import type { Route } from "./shared";
import { getRequestSearchParams, getTrimmedQueryParam, parseBody, parsePattern } from "./shared";

const log = createLogger({ bindings: { component: "admin-impersonation-routes" } });

function parsePositiveInt(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function ensureActorCanImpersonate(
  request: Request,
  env: Env,
  auth: AuthInfo,
): Promise<{ ok: true; actorId: number } | { ok: false; response: Response }> {
  // Impersonation can only be minted from a real operator browser session.
  if (auth.authMode !== "user_session") {
    return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403) };
  }

  const actorId = parsePositiveInt(auth.userId);
  if (!actorId) {
    return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403) };
  }

  const db = assertDatabase(env);
  const isCycloidAdmin = await verifyCycloidAdmin(db, auth);
  if (!isCycloidAdmin) {
    return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403) };
  }

  // The router already resolved this as an active user session. Require the
  // current browser cookie as a defense against bearer-token minting, but do
  // not force repeated logout/login cycles while the operator's session remains
  // valid.
  const sessionToken = parseSessionTokenCookie(request);
  if (!sessionToken) {
    return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403) };
  }

  return { ok: true, actorId };
}

function validateReason(raw: unknown): string | null {
  if (raw == null) return "";
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length > IMPERSONATION_REASON_MAX_LENGTH) return null;
  return trimmed;
}

const CreateImpersonationBodySchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    targetUserId: z.unknown().transform((value, ctx) => {
      const targetUserId = parsePositiveInt(value);
      if (!targetUserId) {
        ctx.addIssue({ code: "custom", message: "targetUserId must be a positive integer" });
        return z.NEVER;
      }
      return targetUserId;
    }),
    reason: z
      .unknown()
      .optional()
      .transform((value, ctx) => {
        const reason = validateReason(value);
        if (reason === null) {
          ctx.addIssue({
            code: "custom",
            message: `reason must be a string of at most ${IMPERSONATION_REASON_MAX_LENGTH} characters`,
          });
          return z.NEVER;
        }
        return reason;
      }),
  }),
);

function normalizeSearchQuery(raw: string | null): string | null {
  const normalized = raw?.trim() ?? "";
  if (normalized.length < 2) return null;
  const sessionPathMatch = normalized.match(/(?:^|\/)sessions\/([^/?#\s]+)/i);
  const query = sessionPathMatch?.[1] ?? normalized;
  return query.slice(0, 120);
}

export const adminImpersonationRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/admin/impersonation/directory"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const gate = await ensureActorCanImpersonate(request, env, auth!);
      if (!gate.ok) return gate.response;

      const result = await listImpersonationDirectory(assertDatabase(env));
      return jsonResponse({ ok: true, ...result });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/admin/impersonation/search"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const gate = await ensureActorCanImpersonate(request, env, auth!);
      if (!gate.ok) return gate.response;

      const query = normalizeSearchQuery(getTrimmedQueryParam(getRequestSearchParams(request), "q"));
      if (!query) {
        return jsonResponse({ ok: true, sessions: [] });
      }

      const result = await searchImpersonationTargets(assertDatabase(env), query);
      return jsonResponse({ ok: true, ...result });
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/admin/impersonation"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const gate = await ensureActorCanImpersonate(request, env, auth!);
      if (!gate.ok) return gate.response;

      const parsedBody = await parseBody(request, CreateImpersonationBodySchema);
      if (!parsedBody.ok) return parsedBody.response;
      const { targetUserId, reason } = parsedBody.value;
      if (targetUserId === gate.actorId) {
        return jsonErrorResponse("Cannot impersonate yourself", 400);
      }

      const db = assertDatabase(env);

      const targetRow = await getActiveImpersonationTarget(db, targetUserId);
      if (!targetRow) {
        return jsonErrorResponse("Target user not found", 404);
      }

      const id = generateRandomHex(16);
      const tokenValue = generateRandomHex(32);
      const tokenHash = await computeSha256Hex(tokenValue);
      const row = await createImpersonationIfActorBelowLimit(db, {
        id,
        tokenHash,
        actorUserId: gate.actorId,
        targetUserId,
        reason,
        ttlMs: IMPERSONATION_TTL_MS,
        maxActivePerActor: IMPERSONATION_MAX_ACTIVE_PER_ACTOR,
      });
      if (!row) {
        return jsonErrorResponse("Too many active impersonations; revoke an existing one first", 429);
      }

      log.warn(
        {
          event: "impersonation_session_created",
          impersonationId: id,
          actorUserId: gate.actorId,
          actorGithubUserId: auth!.user?.githubUserId ?? null,
          targetUserId,
          targetLogin: targetRow.login ?? null,
          reason,
        },
        "Impersonation session created",
      );

      const headers = new Headers({ "content-type": "application/json" });
      headers.append(
        "set-cookie",
        setCookieHeader(IMPERSONATION_COOKIE_NAME, tokenValue, { maxAge: IMPERSONATION_TTL_MS, path: "/" }),
      );
      return new Response(
        JSON.stringify({
          ok: true,
          impersonationId: id,
          expiresAt: row.expiresAt,
        }),
        { status: 200, headers },
      );
    },
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/admin/impersonation/:id"),
    auth: "authenticated",
    // Operator must always be able to exit impersonation, even if they are
    // currently impersonating (the cookie will resolve to the same actor).
    impersonationReadOnlyAllowed: true,
    handler: async (_request, env, match, auth) => {
      const id = match.groups?.id;
      if (!id) return jsonErrorResponse("Missing impersonation id", 400);

      const actorIdFromActor = auth?.actorUserId ? parsePositiveInt(auth.actorUserId) : null;
      const actorIdFromUser = parsePositiveInt(auth?.userId);
      const actorId = actorIdFromActor ?? actorIdFromUser;
      if (!actorId) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);

      const db = assertDatabase(env);

      // Anyone can revoke their own impersonation. Authoritative
      // internal-feature gating is not re-checked here because the row already
      // ties the revoke to the actor that minted it.
      const existing = await getImpersonationById(db, id);
      if (!existing) return jsonErrorResponse("Not found", 404);
      if (existing.actorUserId !== actorId) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);

      const ok = await revokeImpersonation(db, id, actorId);
      if (ok) {
        log.warn(
          {
            event: "impersonation_session_revoked",
            impersonationId: id,
            actorUserId: actorId,
            targetUserId: existing.targetUserId,
          },
          "Impersonation session revoked",
        );
      }

      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", clearCookieHeader(IMPERSONATION_COOKIE_NAME));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    },
  },
];
