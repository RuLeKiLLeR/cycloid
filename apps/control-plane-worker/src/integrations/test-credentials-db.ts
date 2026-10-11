import { upsertRow } from "../db-helpers";
import { createLogger } from "../logger";
import { decrypt, encrypt } from "../settings/encryption";

const log = createLogger({ bindings: { component: "test-credentials-db" } });
const D1_MAX_BINDINGS = 100;
const TEST_CREDENTIAL_LOOKUP_NAME_BATCH_SIZE = D1_MAX_BINDINGS - 3;

export interface BusinessTestCredentialSummary {
  name: string;
  updatedAt: number;
  rotatedByUserId: number | null;
}

export async function upsertBusinessTestCredential(
  db: D1Database,
  params: {
    businessId: string;
    repoOwner: string;
    repoName: string;
    name: string;
    plaintextValue: string;
    rotatedByUserId: number | null;
    encryptionKey: string | undefined;
  },
): Promise<void> {
  const { businessId, repoOwner, repoName, name, plaintextValue, rotatedByUserId, encryptionKey } = params;
  const stored = await encrypt(plaintextValue, encryptionKey);
  const now = Date.now();
  await upsertRow(db, {
    table: "business_test_credentials",
    columns: [
      "business_id",
      "repo_owner",
      "repo_name",
      "name",
      "encrypted_value",
      "encrypted",
      "created_at",
      "updated_at",
      "rotated_by_user_id",
    ],
    values: [businessId, repoOwner, repoName, name, stored, encryptionKey ? 1 : 0, now, now, rotatedByUserId],
    conflictKeys: ["business_id", "repo_owner", "repo_name", "name"],
    excludeFromUpdate: ["created_at"],
  });
}

export async function deleteBusinessTestCredential(
  db: D1Database,
  params: { businessId: string; repoOwner: string; repoName: string; name: string },
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM business_test_credentials
       WHERE business_id = ? AND repo_owner = ? AND repo_name = ? AND name = ?`,
    )
    .bind(params.businessId, params.repoOwner, params.repoName, params.name)
    .run();
}

export async function listBusinessTestCredentials(
  db: D1Database,
  params: { businessId: string; repoOwner: string; repoName: string },
): Promise<BusinessTestCredentialSummary[]> {
  const result = await db
    .prepare(
      `SELECT name, updated_at, rotated_by_user_id
       FROM business_test_credentials
       WHERE business_id = ? AND repo_owner = ? AND repo_name = ?
       ORDER BY name ASC`,
    )
    .bind(params.businessId, params.repoOwner, params.repoName)
    .all<{ name: string; updated_at: number; rotated_by_user_id: number | null }>();
  return (result.results ?? []).map((row) => ({
    name: row.name,
    updatedAt: row.updated_at,
    rotatedByUserId: row.rotated_by_user_id,
  }));
}

/**
 * Discriminated lookup result for declared test credentials. Distinguishing
 * "row not in DB" from "row exists but couldn't be decrypted" matters for the
 * diagnostic surface — operators need to know whether to set the credential
 * (not_found) or fix encryption setup (decrypt_failed).
 */
export type GetTestCredentialResult =
  { ok: true; value: string } | { ok: false; reason: "not_found" | "decrypt_failed" };

interface TestCredentialValueRow {
  name: string;
  encrypted_value: string;
  encrypted: number;
}

async function decryptTestCredentialRow(params: {
  row: Pick<TestCredentialValueRow, "encrypted_value" | "encrypted">;
  businessId: string;
  repoOwner: string;
  repoName: string;
  name: string;
  encryptionKey: string | undefined;
}): Promise<GetTestCredentialResult> {
  if (params.row.encrypted === 1 && !params.encryptionKey) {
    log.warn(
      {
        businessId: params.businessId,
        repoOwner: params.repoOwner,
        repoName: params.repoName,
        name: params.name,
        action: "test_credential.decrypt_failed",
        reason: "encryption_key_missing",
      },
      "Cannot decrypt test credential: TOKEN_ENCRYPTION_KEY missing",
    );
    return { ok: false, reason: "decrypt_failed" };
  }

  try {
    const value =
      params.row.encrypted === 1
        ? await decrypt(params.row.encrypted_value, params.encryptionKey)
        : params.row.encrypted_value;
    return { ok: true, value };
  } catch (err) {
    log.warn(
      {
        businessId: params.businessId,
        repoOwner: params.repoOwner,
        repoName: params.repoName,
        name: params.name,
        action: "test_credential.decrypt_failed",
        reason: "decrypt_threw",
        error: String(err),
      },
      "Failed to decrypt test credential",
    );
    return { ok: false, reason: "decrypt_failed" };
  }
}

export interface ResolvedTestCredentialEnv {
  name: string;
  envVar: string;
  value: string;
}

export interface MissingTestCredential {
  name: string;
  envVar: string;
  // empty_value: the credential row (or repo env fallback) exists but holds an
  // empty/whitespace value, which would boot the app with a blank secret.
  // byok_unavailable: the declaration opted into a business provider-key source
  // but the business has no runnable key for that provider.
  reason: "not_found" | "decrypt_failed" | "empty_value" | "byok_unavailable";
}

async function listBusinessTestCredentialRowsByName(
  db: D1Database,
  params: {
    businessId: string;
    repoOwner: string;
    repoName: string;
    names: string[];
  },
): Promise<TestCredentialValueRow[]> {
  const rows: TestCredentialValueRow[] = [];
  for (let offset = 0; offset < params.names.length; offset += TEST_CREDENTIAL_LOOKUP_NAME_BATCH_SIZE) {
    const names = params.names.slice(offset, offset + TEST_CREDENTIAL_LOOKUP_NAME_BATCH_SIZE);
    const placeholders = names.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT name, encrypted_value, encrypted
         FROM business_test_credentials
         WHERE business_id = ? AND repo_owner = ? AND repo_name = ? AND name IN (${placeholders})`,
      )
      .bind(params.businessId, params.repoOwner, params.repoName, ...names)
      .all<TestCredentialValueRow>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

/**
 * Resolve declared E2E credentials for a session into env-var/value pairs ready
 * for the sandbox start request. Any declared credential that cannot be loaded
 * is returned in the `missing` array so callers can fail closed. The reason
 * preserves "not_found" vs "decrypt_failed" so diagnostics can tell operators
 * whether the value was never set vs encryption is mis-configured.
 */
export async function resolveDeclaredTestCredentials(
  db: D1Database,
  params: {
    businessId: string;
    repoOwner: string;
    repoName: string;
    declarations: Array<{ name: string; envVar: string }>;
    encryptionKey: string | undefined;
  },
): Promise<{ resolved: ResolvedTestCredentialEnv[]; missing: MissingTestCredential[] }> {
  const resolved: ResolvedTestCredentialEnv[] = [];
  const missing: MissingTestCredential[] = [];
  const names = [...new Set(params.declarations.map((declaration) => declaration.name))];
  const rows = await listBusinessTestCredentialRowsByName(db, {
    businessId: params.businessId,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    names,
  });
  const rowsByName = new Map(rows.map((row) => [row.name, row]));

  for (const declaration of params.declarations) {
    const row = rowsByName.get(declaration.name);
    if (!row) {
      missing.push({ name: declaration.name, envVar: declaration.envVar, reason: "not_found" });
      continue;
    }
    const result = await decryptTestCredentialRow({
      row,
      businessId: params.businessId,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      name: declaration.name,
      encryptionKey: params.encryptionKey,
    });
    if (!result.ok) {
      missing.push({ name: declaration.name, envVar: declaration.envVar, reason: result.reason });
      continue;
    }
    resolved.push({ name: declaration.name, envVar: declaration.envVar, value: result.value });
  }
  return { resolved, missing };
}
