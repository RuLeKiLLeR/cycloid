import { assertSecretImportText, SecretImportValidationError } from "../../../../shared/secrets/import-format.js";
import {
  bulkUpsertPersonalSecrets,
  deletePersonalSecret,
  getPersonalSecretsMetadata,
  PersonalSecretsServiceError,
  upsertPersonalSecret,
} from "../env-blobs/personal-secrets";
import { assertDatabase } from "../session/state";
import type { AuthInfo } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

function requireUserSessionUserId(auth: AuthInfo): number | Response {
  if (auth.authMode !== "user_session") {
    return jsonErrorResponse("A user session is required to manage personal secrets", 400);
  }
  const userId = Number(auth.userId);
  if (!Number.isFinite(userId)) {
    return jsonErrorResponse("A user session is required to manage personal secrets", 400);
  }
  return userId;
}

export const personalSecretsRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/settings/personal-secrets"),
    auth: "authenticated",
    handler: async (_request, env, _match, auth) => {
      const userId = requireUserSessionUserId(auth!);
      if (userId instanceof Response) return userId;
      const db = assertDatabase(env);
      try {
        const secrets = await getPersonalSecretsMetadata(db, userId, env.TOKEN_ENCRYPTION_KEY);
        return jsonResponse({ ok: true, secrets });
      } catch (error) {
        if (error instanceof PersonalSecretsServiceError) {
          return jsonErrorResponse(error.message, error.status);
        }
        throw error;
      }
    },
  },
  {
    method: "PUT",
    pattern: parsePattern("/api/settings/personal-secrets/:envKey"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const userId = requireUserSessionUserId(auth!);
      if (userId instanceof Response) return userId;
      const envKey = match.groups!.envKey;
      const db = assertDatabase(env);
      const payload = (await parseJsonBody(request)) || {};
      const value = typeof payload.value === "string" ? payload.value : null;
      if (value === null) return jsonErrorResponse("value is required", 400);
      const usageNote =
        payload.usageNote === null ? null : typeof payload.usageNote === "string" ? payload.usageNote : undefined;
      const sensitive = typeof payload.sensitive === "boolean" ? payload.sensitive : undefined;

      try {
        const secrets = await upsertPersonalSecret(db, {
          ownerUserId: userId,
          key: envKey,
          value,
          usageNote,
          sensitive,
          encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
        return jsonResponse({ ok: true, secrets });
      } catch (error) {
        if (error instanceof PersonalSecretsServiceError) {
          return jsonErrorResponse(error.message, error.status);
        }
        throw error;
      }
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/settings/personal-secrets/import"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const userId = requireUserSessionUserId(auth!);
      if (userId instanceof Response) return userId;
      const db = assertDatabase(env);
      const payload = (await parseJsonBody(request)) || {};
      const text = typeof payload.text === "string" ? payload.text : null;
      if (text === null) return jsonErrorResponse("text is required", 400);
      const sensitive = payload.sensitive === false ? false : true;

      try {
        const entries = assertSecretImportText(text);
        const secrets = await bulkUpsertPersonalSecrets(db, {
          ownerUserId: userId,
          entries,
          sensitive,
          encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
        return jsonResponse({ ok: true, secrets, importedCount: entries.length });
      } catch (error) {
        if (error instanceof SecretImportValidationError) {
          return jsonErrorResponse(error.message, 400, { errors: error.errors });
        }
        if (error instanceof PersonalSecretsServiceError) {
          return jsonErrorResponse(error.message, error.status);
        }
        throw error;
      }
    },
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/settings/personal-secrets/:envKey"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const userId = requireUserSessionUserId(auth!);
      if (userId instanceof Response) return userId;
      const envKey = match.groups!.envKey;
      const db = assertDatabase(env);
      try {
        const result = await deletePersonalSecret(db, {
          ownerUserId: userId,
          key: envKey,
          encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
        return jsonResponse({ ok: true, secrets: result.secrets, changed: result.changed });
      } catch (error) {
        if (error instanceof PersonalSecretsServiceError) {
          return jsonErrorResponse(error.message, error.status);
        }
        throw error;
      }
    },
  },
];
