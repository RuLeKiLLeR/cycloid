import { stringifyError } from "../../../../shared/utils/errors.js";
import { createLogger } from "../logger";
import { decrypt, encrypt } from "../settings/encryption";
import {
  deletePersonalEnvBlobByIdIfUnchangedAndCleanupStale,
  deletePersonalEnvBlobByIdIfVersion,
  deleteStalePersonalEnvBlobsIfCurrentWinner,
  getPersonalEnvBlobForUser,
  insertPersonalEnvBlob,
  updatePersonalEnvBlobByIdIfUnchanged,
} from "./db";
import {
  emptyEntryMeta,
  entriesFromImport,
  type EnvBlobEntryMetaMap,
  mergeEntryMetaForKeys,
  parseEntryMetaJson,
  pruneEntryMeta,
  serializeEntryMetaJson,
} from "./entry-meta";
import {
  assertRepoRuntimeEnvKey,
  assertRepoRuntimeEnvValue,
  formatRepoRuntimeEnv,
  normalizeRepoRuntimeKeyNames,
  parseRepoRuntimeEnv,
  RepoRuntimeEnvValidationError,
  type RepoRuntimeEnvVars,
} from "./login-env";

export const PERSONAL_SECRETS_BLOB_NAME = "personal_secrets";

const log = createLogger({ bindings: { component: "personal-secrets-service" } });
const MAX_MUTATION_ATTEMPTS = 4;

export interface PersonalSecretEntryMeta {
  key: string;
  usageNote: string | null;
  sensitive: boolean;
}

export interface PersonalSecretsMetadata {
  id: string;
  keyNames: string[];
  entries: PersonalSecretEntryMeta[];
  createdAt: number;
  updatedAt: number;
}

export interface PersonalSecretsUpdateResult {
  secrets: PersonalSecretsMetadata | null;
  changed: boolean;
}

interface ResolvedPersonalSecrets {
  id: string;
  createdAt: number;
  updatedAt: number;
  envVars: RepoRuntimeEnvVars;
  entryMeta: EnvBlobEntryMetaMap;
}

export class PersonalSecretsServiceError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PersonalSecretsServiceError";
    this.status = status;
  }
}

function rethrowValidation(error: unknown): never {
  if (error instanceof PersonalSecretsServiceError) throw error;
  if (error instanceof RepoRuntimeEnvValidationError) {
    throw new PersonalSecretsServiceError(error.message, 400);
  }
  throw error;
}

function entriesFromMeta(keyNames: string[], entryMeta: EnvBlobEntryMetaMap): PersonalSecretEntryMeta[] {
  return keyNames.map((key) => {
    const meta = entryMeta[key] ?? emptyEntryMeta();
    return {
      key,
      usageNote: meta.usageNote,
      sensitive: meta.sensitive !== false,
    };
  });
}

function metadataFromResolved(resolved: ResolvedPersonalSecrets): PersonalSecretsMetadata {
  const keyNames = normalizeRepoRuntimeKeyNames(Object.keys(resolved.envVars));
  const entryMeta = pruneEntryMeta(resolved.entryMeta, keyNames);
  return {
    id: resolved.id,
    keyNames,
    entries: entriesFromMeta(keyNames, entryMeta),
    createdAt: resolved.createdAt,
    updatedAt: resolved.updatedAt,
  };
}

async function decryptPersonalEnv(
  row: { env_text: string; encrypted: number; id: string },
  encryptionKey: string | undefined,
): Promise<string> {
  if (row.encrypted === 1 && !encryptionKey) {
    throw new PersonalSecretsServiceError("TOKEN_ENCRYPTION_KEY is required to decrypt personal secrets", 500);
  }
  return row.encrypted === 1 ? decrypt(row.env_text, encryptionKey) : row.env_text;
}

async function serialize(
  envVars: RepoRuntimeEnvVars,
  entryMeta: EnvBlobEntryMetaMap,
  encryptionKey: string | undefined,
): Promise<{ envText: string; encrypted: boolean; keyNames: string[]; keyNamesJson: string; entryMetaJson: string }> {
  const envText = formatRepoRuntimeEnv(envVars);
  const keyNames = normalizeRepoRuntimeKeyNames(Object.keys(parseRepoRuntimeEnv(envText)));
  const pruned = pruneEntryMeta(entryMeta, keyNames);
  const encryptedText = await encrypt(envText, encryptionKey);
  return {
    envText: encryptedText,
    encrypted: Boolean(encryptionKey),
    keyNames,
    keyNamesJson: JSON.stringify(keyNames),
    entryMetaJson: serializeEntryMetaJson(pruned),
  };
}

export async function resolvePersonalSecretsForSandbox(
  db: D1Database,
  ownerUserId: number,
  encryptionKey: string | undefined,
): Promise<ResolvedPersonalSecrets | null> {
  const row = await getPersonalEnvBlobForUser(db, ownerUserId, PERSONAL_SECRETS_BLOB_NAME);
  if (!row) return null;
  const envText = await decryptPersonalEnv(row, encryptionKey);
  let envVars: RepoRuntimeEnvVars;
  try {
    envVars = parseRepoRuntimeEnv(envText);
  } catch (error) {
    log.warn({ ownerUserId, envBlobId: row.id, error: stringifyError(error) }, "Malformed personal secrets blob");
    throw new PersonalSecretsServiceError("Stored personal secrets are invalid", 500);
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    envVars,
    entryMeta: pruneEntryMeta(parseEntryMetaJson(row.entry_meta_json), Object.keys(envVars)),
  };
}

export async function getPersonalSecretsMetadata(
  db: D1Database,
  ownerUserId: number,
  encryptionKey: string | undefined,
): Promise<PersonalSecretsMetadata | null> {
  const resolved = await resolvePersonalSecretsForSandbox(db, ownerUserId, encryptionKey);
  return resolved ? metadataFromResolved(resolved) : null;
}

export function getPersonalSecretsCredentialFingerprint(resolved: ResolvedPersonalSecrets | null): string[] {
  if (!resolved) return [];
  return [`CYCLOID_PERSONAL_SECRETS:${resolved.id}:${resolved.updatedAt}`];
}

async function tryUpdate(
  db: D1Database,
  params: {
    ownerUserId: number;
    envVars: RepoRuntimeEnvVars;
    entryMeta: EnvBlobEntryMetaMap;
    encryptionKey: string | undefined;
    existing: ResolvedPersonalSecrets;
  },
): Promise<PersonalSecretsMetadata | null> {
  try {
    const serialized = await serialize(params.envVars, params.entryMeta, params.encryptionKey);
    const now = Math.max(Date.now(), params.existing.updatedAt + 1);
    const updated = await updatePersonalEnvBlobByIdIfUnchanged(db, {
      id: params.existing.id,
      expectedUpdatedAt: params.existing.updatedAt,
      ownerUserId: params.ownerUserId,
      name: PERSONAL_SECRETS_BLOB_NAME,
      envText: serialized.envText,
      encrypted: serialized.encrypted,
      keyNamesJson: serialized.keyNamesJson,
      entryMetaJson: serialized.entryMetaJson,
      now,
    });
    if (!updated) return null;
    return {
      id: params.existing.id,
      keyNames: serialized.keyNames,
      entries: entriesFromMeta(serialized.keyNames, pruneEntryMeta(params.entryMeta, serialized.keyNames)),
      createdAt: params.existing.createdAt,
      updatedAt: now,
    };
  } catch (error) {
    rethrowValidation(error);
  }
}

async function tryCreate(
  db: D1Database,
  params: {
    ownerUserId: number;
    envVars: RepoRuntimeEnvVars;
    entryMeta: EnvBlobEntryMetaMap;
    encryptionKey: string | undefined;
  },
): Promise<PersonalSecretsMetadata | null> {
  try {
    const serialized = await serialize(params.envVars, params.entryMeta, params.encryptionKey);
    const now = Date.now();
    const id = crypto.randomUUID();
    await insertPersonalEnvBlob(db, {
      id,
      ownerUserId: params.ownerUserId,
      name: PERSONAL_SECRETS_BLOB_NAME,
      envText: serialized.envText,
      encrypted: serialized.encrypted,
      keyNamesJson: serialized.keyNamesJson,
      entryMetaJson: serialized.entryMetaJson,
      now,
    });

    const current = await getPersonalEnvBlobForUser(db, params.ownerUserId, PERSONAL_SECRETS_BLOB_NAME);
    if (!current || current.id !== id) {
      await deletePersonalEnvBlobByIdIfVersion(db, {
        ownerUserId: params.ownerUserId,
        name: PERSONAL_SECRETS_BLOB_NAME,
        id,
        expectedUpdatedAt: now,
      });
      return null;
    }

    const cleanup = await deleteStalePersonalEnvBlobsIfCurrentWinner(db, {
      ownerUserId: params.ownerUserId,
      name: PERSONAL_SECRETS_BLOB_NAME,
      keepId: id,
      expectedUpdatedAt: now,
    });
    if (!cleanup.keptBlobStillCurrentWinner) {
      // We lost the winner race during the cleanup window: delete the blob we just inserted so it
      // does not persist as a permanent orphan. Version-guarded so a concurrent writer that has
      // since adopted this row is never clobbered.
      await deletePersonalEnvBlobByIdIfVersion(db, {
        ownerUserId: params.ownerUserId,
        name: PERSONAL_SECRETS_BLOB_NAME,
        id,
        expectedUpdatedAt: now,
      });
      return null;
    }

    return {
      id,
      keyNames: serialized.keyNames,
      entries: entriesFromMeta(serialized.keyNames, pruneEntryMeta(params.entryMeta, serialized.keyNames)),
      createdAt: current.created_at,
      updatedAt: now,
    };
  } catch (error) {
    rethrowValidation(error);
  }
}

function assertKey(key: string): void {
  try {
    assertRepoRuntimeEnvKey(key);
  } catch (error) {
    rethrowValidation(error);
  }
}

export async function upsertPersonalSecret(
  db: D1Database,
  params: {
    ownerUserId: number;
    key: string;
    value: string;
    usageNote?: string | null;
    sensitive?: boolean;
    encryptionKey: string | undefined;
  },
): Promise<PersonalSecretsMetadata> {
  assertKey(params.key);
  if (params.value.trim().length === 0) {
    throw new PersonalSecretsServiceError(`Value for ${params.key} must not be empty`, 400);
  }
  try {
    assertRepoRuntimeEnvValue(params.key, params.value);
  } catch (error) {
    rethrowValidation(error);
  }

  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const existing = await resolvePersonalSecretsForSandbox(db, params.ownerUserId, params.encryptionKey);
    const nextEnv = { ...(existing?.envVars ?? {}), [params.key]: params.value };
    const nextMeta = mergeEntryMetaForKeys(existing?.entryMeta ?? {}, [params.key], {
      usageNote: params.usageNote,
      sensitive: params.sensitive,
    });

    const secrets = existing
      ? await tryUpdate(db, {
          ownerUserId: params.ownerUserId,
          envVars: nextEnv,
          entryMeta: nextMeta,
          encryptionKey: params.encryptionKey,
          existing,
        })
      : await tryCreate(db, {
          ownerUserId: params.ownerUserId,
          envVars: nextEnv,
          entryMeta: nextMeta,
          encryptionKey: params.encryptionKey,
        });
    if (secrets) return secrets;
  }

  throw new PersonalSecretsServiceError("Personal secrets changed during update; retry the request", 409);
}

export async function bulkUpsertPersonalSecrets(
  db: D1Database,
  params: {
    ownerUserId: number;
    entries: ReadonlyArray<{ key: string; value: string; usageNote: string | null }>;
    sensitive: boolean;
    encryptionKey: string | undefined;
  },
): Promise<PersonalSecretsMetadata> {
  if (params.entries.length === 0) {
    throw new PersonalSecretsServiceError("Add at least one secret to import", 400);
  }
  for (const entry of params.entries) {
    assertKey(entry.key);
    if (entry.value.trim().length === 0) {
      throw new PersonalSecretsServiceError(`Value for ${entry.key} must not be empty`, 400);
    }
    try {
      assertRepoRuntimeEnvValue(entry.key, entry.value);
    } catch (error) {
      rethrowValidation(error);
    }
  }

  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const existing = await resolvePersonalSecretsForSandbox(db, params.ownerUserId, params.encryptionKey);
    const nextEnv = { ...(existing?.envVars ?? {}) };
    for (const entry of params.entries) {
      nextEnv[entry.key] = entry.value;
    }
    const nextMeta = entriesFromImport(params.entries, params.sensitive, existing?.entryMeta ?? {});

    const secrets = existing
      ? await tryUpdate(db, {
          ownerUserId: params.ownerUserId,
          envVars: nextEnv,
          entryMeta: nextMeta,
          encryptionKey: params.encryptionKey,
          existing,
        })
      : await tryCreate(db, {
          ownerUserId: params.ownerUserId,
          envVars: nextEnv,
          entryMeta: nextMeta,
          encryptionKey: params.encryptionKey,
        });
    if (secrets) return secrets;
  }

  throw new PersonalSecretsServiceError("Personal secrets changed during update; retry the request", 409);
}

export async function deletePersonalSecret(
  db: D1Database,
  params: {
    ownerUserId: number;
    key: string;
    encryptionKey: string | undefined;
  },
): Promise<PersonalSecretsUpdateResult> {
  assertKey(params.key);

  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    const existing = await resolvePersonalSecretsForSandbox(db, params.ownerUserId, params.encryptionKey);
    if (!existing) return { secrets: null, changed: false };
    if (!(params.key in existing.envVars)) {
      const cleanup = await deleteStalePersonalEnvBlobsIfCurrentWinner(db, {
        ownerUserId: params.ownerUserId,
        name: PERSONAL_SECRETS_BLOB_NAME,
        keepId: existing.id,
        expectedUpdatedAt: existing.updatedAt,
      });
      if (!cleanup.keptBlobStillCurrentWinner) continue;
      return { secrets: metadataFromResolved(existing), changed: false };
    }

    const nextEnv = { ...existing.envVars };
    delete nextEnv[params.key];
    const nextMeta = { ...existing.entryMeta };
    delete nextMeta[params.key];

    if (Object.keys(nextEnv).length === 0) {
      const deleted = await deletePersonalEnvBlobByIdIfUnchangedAndCleanupStale(db, {
        id: existing.id,
        expectedUpdatedAt: existing.updatedAt,
        ownerUserId: params.ownerUserId,
        name: PERSONAL_SECRETS_BLOB_NAME,
      });
      if (!deleted) continue;
      return { secrets: null, changed: true };
    }

    const secrets = await tryUpdate(db, {
      ownerUserId: params.ownerUserId,
      envVars: nextEnv,
      entryMeta: nextMeta,
      encryptionKey: params.encryptionKey,
      existing,
    });
    if (secrets) return { secrets, changed: true };
  }

  throw new PersonalSecretsServiceError("Personal secrets changed during delete; retry the request", 409);
}
