import { isBusinessAdmin } from "../business/service";
import { HTTP_RESPONSE_BODY } from "../constants/http-responses";
import {
  deleteBusinessTestCredential,
  listBusinessTestCredentials,
  upsertBusinessTestCredential,
} from "../integrations/test-credentials-db";
import { createLogger } from "../logger";
import { assertDatabase } from "../session/state";
import type { AuthInfo } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

const log = createLogger({ bindings: { component: "test-credentials-routes" } });

const NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

async function requireAdmin(db: D1Database, auth: AuthInfo, businessId: string): Promise<Response | null> {
  if (auth.canAccessAllSessions) return null;
  const userId = Number(auth.userId);
  if (!Number.isFinite(userId)) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
  const admin = await isBusinessAdmin(db, userId, businessId);
  if (!admin) return jsonErrorResponse(HTTP_RESPONSE_BODY.FORBIDDEN, 403);
  return null;
}

function validateName(name: string): Response | null {
  if (!NAME_PATTERN.test(name)) {
    return jsonErrorResponse(
      "name must match [a-zA-Z0-9_.-]{1,64} (matches the credential name in .cycloid.json)",
      400,
    );
  }
  return null;
}

export const testCredentialRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/businesses/:businessId/repos/:owner/:name/test-credentials"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const { businessId, owner, name: repoName } = match.groups!;
      const db = assertDatabase(env);
      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      const credentials = await listBusinessTestCredentials(db, {
        businessId,
        repoOwner: owner,
        repoName,
      });
      return jsonResponse({ ok: true, credentials });
    },
  },

  {
    method: "PUT",
    pattern: parsePattern("/api/businesses/:businessId/repos/:owner/:name/test-credentials/:credName"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const { businessId, owner, name: repoName, credName } = match.groups!;
      const db = assertDatabase(env);
      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      const invalid = validateName(credName);
      if (invalid) return invalid;

      const payload = (await parseJsonBody(request)) || {};
      const value = payload.value;
      if (typeof value !== "string" || value.trim().length === 0) {
        return jsonErrorResponse("value must be a non-empty string", 400);
      }
      if (value.length > 8192) {
        return jsonErrorResponse("value exceeds 8192 byte limit", 400);
      }

      await upsertBusinessTestCredential(db, {
        businessId,
        repoOwner: owner,
        repoName,
        name: credName,
        plaintextValue: value,
        rotatedByUserId: Number.isFinite(Number(auth!.userId)) ? Number(auth!.userId) : null,
        encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      });
      log.info(
        { businessId, repoOwner: owner, repoName, name: credName, actorUserId: auth!.userId },
        "Test credential set",
      );
      return jsonResponse({ ok: true });
    },
  },

  {
    method: "DELETE",
    pattern: parsePattern("/api/businesses/:businessId/repos/:owner/:name/test-credentials/:credName"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const { businessId, owner, name: repoName, credName } = match.groups!;
      const db = assertDatabase(env);
      const forbidden = await requireAdmin(db, auth!, businessId);
      if (forbidden) return forbidden;

      const invalid = validateName(credName);
      if (invalid) return invalid;

      await deleteBusinessTestCredential(db, {
        businessId,
        repoOwner: owner,
        repoName,
        name: credName,
      });
      log.info(
        { businessId, repoOwner: owner, repoName, name: credName, actorUserId: auth!.userId },
        "Test credential deleted",
      );
      return jsonResponse({ ok: true });
    },
  },
];
