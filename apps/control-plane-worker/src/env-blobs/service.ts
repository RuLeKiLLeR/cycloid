import { stringifyError } from "../../../../shared/utils/errors.js";
import { createLogger } from "../logger";
import { decrypt, encrypt } from "../settings/encryption";
import {
  deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale,
  deleteRepoEnvBlobByIdIfVersion,
  deleteStaleRepoEnvBlobsForRepoIfCurrentWinner,
  getRepoEnvBlobForRepo,
  insertRepoEnvBlobForRepo,
  type RepoEnvBlobMetadataRow,
  type RepoEnvBlobStoredRow,
  updateRepoEnvBlobByIdIfUnchangedAndCleanupStale,
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
  REPO_LOGIN_ENV_BLOB_NAME,
  RepoRuntimeEnvValidationError,
  type RepoRuntimeEnvVars,
} from "./login-env";

const log = createLogger({ bindings: { component: "repo-runtime-env-service" } });
const REPO_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_SINGLE_KEY_MUTATION_ATTEMPTS = 4;

export interface RepoLoginEnvEntryMeta {
  key: string;
  usageNote: string | null;
  sensitive: boolean;
}

export interface RepoLoginEnvMetadata {
  id: string;
  repoOwner: string;
  repoName: string;
  keyNames: string[];
  entries: RepoLoginEnvEntryMeta[];
  createdAt: number;
  updatedAt: number;
}

export interface RepoLoginEnvVariableUpdateResult {
  loginEnv: RepoLoginEnvMetadata | null;
  changed: boolean;
}

interface ResolvedRepoLoginEnv {
  id: string;
  createdAt: number;
  updatedAt: number;
  repoOwner: string;
  repoName: string;
  envVars: RepoRuntimeEnvVars;
  entryMeta: EnvBlobEntryMetaMap;
}

export class RepoLoginEnvServiceError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "RepoLoginEnvServiceError";
    this.status = status;
  }
}

function rethrowRepoRuntimeValidationError(error: unknown): never {
  if (error instanceof RepoLoginEnvServiceError) throw error;
  if (error instanceof RepoRuntimeEnvValidationError) {
    throw new RepoLoginEnvServiceError(error.message, 400);
  }
  throw error;
}

function assertRepoPart(label: string, value: string): void {
  if (!value || value.length > 100 || !REPO_PART_PATTERN.test(value)) {
    throw new RepoLoginEnvServiceError(`${label} is invalid`);
  }
}

function assertValidRepoBinding(repoOwner: string, repoName: string): void {
  assertRepoPart("repoOwner", repoOwner);
  assertRepoPart("repoName", repoName);
}

function entriesFromMeta(keyNames: string[], entryMeta: EnvBlobEntryMetaMap): RepoLoginEnvEntryMeta[] {
  return keyNames.map((key) => {
    const meta = entryMeta[key] ?? emptyEntryMeta();
    return {
      key,
      usageNote: meta.usageNote,
      sensitive: meta.sensitive !== false,
    };
  });
}

function metadataFromRow(row: RepoEnvBlobMetadataRow): RepoLoginEnvMetadata {
  let keyNames: string[] = [];
  try {
    const parsed = JSON.parse(row.key_names_json) as unknown;
    keyNames = Array.isArray(parsed)
      ? normalizeRepoRuntimeKeyNames(parsed.filter((entry): entry is string => typeof entry === "string"))
      : [];
  } catch (error) {
    log.warn(
      {
        envBlobId: row.id,
        keyNamesJson: row.key_names_json,
        error: stringifyError(error),
      },
      "Malformed key_names_json for repo runtime env blob",
    );
    keyNames = [];
  }

  const entryMeta = pruneEntryMeta(parseEntryMetaJson(row.entry_meta_json), keyNames);
  return {
    id: row.id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    keyNames,
    entries: entriesFromMeta(keyNames, entryMeta),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function metadataFromResolvedRepoLoginEnv(resolved: ResolvedRepoLoginEnv): RepoLoginEnvMetadata {
  const keyNames = normalizeRepoRuntimeKeyNames(Object.keys(resolved.envVars));
  const entryMeta = pruneEntryMeta(resolved.entryMeta, keyNames);
  return {
    id: resolved.id,
    repoOwner: resolved.repoOwner,
    repoName: resolved.repoName,
    keyNames,
    entries: entriesFromMeta(keyNames, entryMeta),
    createdAt: resolved.createdAt,
    updatedAt: resolved.updatedAt,
  };
}

async function decryptRepoLoginEnv(row: RepoEnvBlobStoredRow, encryptionKey: string | undefined): Promise<string> {
  if (row.encrypted === 1 && !encryptionKey) {
    throw new RepoLoginEnvServiceError(
      "TOKEN_ENCRYPTION_KEY is required to decrypt repository environment variables",
      500,
    );
  }
  return row.encrypted === 1 ? decrypt(row.env_text, encryptionKey) : row.env_text;
}

export async function getRepoLoginEnvBlobForRepo(
  db: D1Database,
  businessId: string,
  repoOwner: string,
  repoName: string,
): Promise<RepoLoginEnvMetadata | null> {
  assertValidRepoBinding(repoOwner, repoName);
  const row = await getRepoEnvBlobForRepo(db, businessId, REPO_LOGIN_ENV_BLOB_NAME, repoOwner, repoName);
  return row ? metadataFromRow(row) : null;
}

function assertRepoLoginEnvVariableKey(key: string): void {
  try {
    assertRepoRuntimeEnvKey(key);
  } catch (error) {
    rethrowRepoRuntimeValidationError(error);
  }
}

async function serializeRepoLoginEnvVars(
  envVars: RepoRuntimeEnvVars,
  entryMeta: EnvBlobEntryMetaMap,
  encryptionKey: string | undefined,
): Promise<{ envText: string; encrypted: boolean; keyNames: string[]; keyNamesJson: string; entryMetaJson: string }> {
  const envText = formatRepoRuntimeEnv(envVars);
  const keyNames = normalizeRepoRuntimeKeyNames(Object.keys(parseRepoRuntimeEnv(envText)));
  const prunedMeta = pruneEntryMeta(entryMeta, keyNames);
  const encryptedText = await encrypt(envText, encryptionKey);
  const encrypted = Boolean(encryptionKey);
  return {
    envText: encryptedText,
    encrypted,
    keyNames,
    keyNamesJson: JSON.stringify(keyNames),
    entryMetaJson: serializeEntryMetaJson(prunedMeta),
  };
}

async function cleanupStaleRepoLoginEnvBlobs(
  db: D1Database,
  params: {
    businessId: string;
    repoOwner: string;
    repoName: string;
    keepId: string;
    expectedUpdatedAt: number;
  },
): Promise<boolean> {
  const result = await deleteStaleRepoEnvBlobsForRepoIfCurrentWinner(db, {
    businessId: params.businessId,
    name: REPO_LOGIN_ENV_BLOB_NAME,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    keepId: params.keepId,
    expectedUpdatedAt: params.expectedUpdatedAt,
  });
  return result.keptBlobStillCurrentWinner;
}

async function tryUpdateRepoLoginEnvVars(
  db: D1Database,
  params: {
    businessId: string;
    actorUserId: number;
    repoOwner: string;
    repoName: string;
    envVars: RepoRuntimeEnvVars;
    entryMeta: EnvBlobEntryMetaMap;
    encryptionKey: string | undefined;
    existing: ResolvedRepoLoginEnv;
  },
): Promise<RepoLoginEnvMetadata | null> {
  try {
    const serialized = await serializeRepoLoginEnvVars(params.envVars, params.entryMeta, params.encryptionKey);
    const now = Math.max(Date.now(), params.existing.updatedAt + 1);
    const updated = await updateRepoEnvBlobByIdIfUnchangedAndCleanupStale(db, {
      id: params.existing.id,
      expectedUpdatedAt: params.existing.updatedAt,
      ownerUserId: params.actorUserId,
      businessId: params.businessId,
      name: REPO_LOGIN_ENV_BLOB_NAME,
      envText: serialized.envText,
      encrypted: serialized.encrypted,
      keyNamesJson: serialized.keyNamesJson,
      entryMetaJson: serialized.entryMetaJson,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      now,
    });
    if (!updated) return null;

    return {
      id: params.existing.id,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      keyNames: serialized.keyNames,
      entries: entriesFromMeta(serialized.keyNames, pruneEntryMeta(params.entryMeta, serialized.keyNames)),
      createdAt: params.existing.createdAt,
      updatedAt: now,
    };
  } catch (error) {
    rethrowRepoRuntimeValidationError(error);
  }
}

async function tryCreateRepoLoginEnvVars(
  db: D1Database,
  params: {
    businessId: string;
    actorUserId: number;
    repoOwner: string;
    repoName: string;
    envVars: RepoRuntimeEnvVars;
    entryMeta: EnvBlobEntryMetaMap;
    encryptionKey: string | undefined;
  },
): Promise<RepoLoginEnvMetadata | null> {
  try {
    const serialized = await serializeRepoLoginEnvVars(params.envVars, params.entryMeta, params.encryptionKey);
    const now = Date.now();
    const id = crypto.randomUUID();

    await insertRepoEnvBlobForRepo(db, {
      id,
      ownerUserId: params.actorUserId,
      businessId: params.businessId,
      name: REPO_LOGIN_ENV_BLOB_NAME,
      envText: serialized.envText,
      encrypted: serialized.encrypted,
      keyNamesJson: serialized.keyNamesJson,
      entryMetaJson: serialized.entryMetaJson,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      now,
    });

    const current = await getRepoEnvBlobForRepo(
      db,
      params.businessId,
      REPO_LOGIN_ENV_BLOB_NAME,
      params.repoOwner,
      params.repoName,
    );
    if (!current || current.id !== id) {
      await deleteRepoEnvBlobByIdIfVersion(db, {
        businessId: params.businessId,
        name: REPO_LOGIN_ENV_BLOB_NAME,
        id,
        expectedUpdatedAt: now,
      });
      return null;
    }

    const keptBlobStillCurrentWinner = await cleanupStaleRepoLoginEnvBlobs(db, {
      businessId: params.businessId,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      keepId: id,
      expectedUpdatedAt: now,
    });
    if (!keptBlobStillCurrentWinner) {
      // We lost the winner race during the cleanup window: delete the blob we just inserted so it
      // does not persist as a permanent orphan. Version-guarded so a concurrent writer that has
      // since adopted this row is never clobbered.
      await deleteRepoEnvBlobByIdIfVersion(db, {
        businessId: params.businessId,
        name: REPO_LOGIN_ENV_BLOB_NAME,
        id,
        expectedUpdatedAt: now,
      });
      return null;
    }

    return metadataFromRow(current);
  } catch (error) {
    rethrowRepoRuntimeValidationError(error);
  }
}

export async function upsertRepoLoginEnvVariable(
  db: D1Database,
  params: {
    businessId: string;
    actorUserId: number;
    repoOwner: string;
    repoName: string;
    key: string;
    value: string;
    usageNote?: string | null;
    sensitive?: boolean;
    encryptionKey: string | undefined;
  },
): Promise<RepoLoginEnvMetadata> {
  assertValidRepoBinding(params.repoOwner, params.repoName);
  assertRepoLoginEnvVariableKey(params.key);
  if (params.value.trim().length === 0) {
    throw new RepoLoginEnvServiceError(`Value for ${params.key} must not be empty`, 400);
  }
  try {
    assertRepoRuntimeEnvValue(params.key, params.value);
  } catch (error) {
    rethrowRepoRuntimeValidationError(error);
  }

  for (let attempt = 0; attempt < MAX_SINGLE_KEY_MUTATION_ATTEMPTS; attempt += 1) {
    const existing = await resolveRepoLoginEnvForSandbox(
      db,
      params.businessId,
      params.repoOwner,
      params.repoName,
      params.encryptionKey,
    );
    const nextEnv = {
      ...(existing?.envVars ?? {}),
      [params.key]: params.value,
    };
    const metaPatchProvided = params.usageNote !== undefined || params.sensitive !== undefined;
    // Pure value retry (no meta patch): keep existing meta as-is so idempotent
    // upserts still take the winner-guarded cleanup path.
    let nextMeta = { ...(existing?.entryMeta ?? {}) };
    if (!(params.key in nextMeta)) nextMeta[params.key] = emptyEntryMeta();
    if (metaPatchProvided) {
      nextMeta = mergeEntryMetaForKeys(nextMeta, [params.key], {
        usageNote: params.usageNote,
        sensitive: params.sensitive,
      });
    }

    if (existing?.envVars[params.key] === params.value && !metaPatchProvided) {
      const keptBlobStillCurrentWinner = await cleanupStaleRepoLoginEnvBlobs(db, {
        businessId: params.businessId,
        repoOwner: params.repoOwner,
        repoName: params.repoName,
        keepId: existing.id,
        expectedUpdatedAt: existing.updatedAt,
      });
      if (!keptBlobStillCurrentWinner) continue;
      return metadataFromResolvedRepoLoginEnv(existing);
    }

    const loginEnv = existing
      ? await tryUpdateRepoLoginEnvVars(db, {
          ...params,
          envVars: nextEnv,
          entryMeta: nextMeta,
          existing,
        })
      : await tryCreateRepoLoginEnvVars(db, {
          ...params,
          envVars: nextEnv,
          entryMeta: nextMeta,
        });
    if (loginEnv) return loginEnv;
  }

  log.warn(
    {
      businessId: params.businessId,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      operation: "upsert",
      attempts: MAX_SINGLE_KEY_MUTATION_ATTEMPTS,
    },
    "Repo runtime env upsert exhausted CAS retries under concurrent writers",
  );
  throw new RepoLoginEnvServiceError("Repository environment variables changed during update; retry the request", 409);
}

export async function bulkUpsertRepoLoginEnvVariables(
  db: D1Database,
  params: {
    businessId: string;
    actorUserId: number;
    repoOwner: string;
    repoName: string;
    entries: ReadonlyArray<{ key: string; value: string; usageNote: string | null }>;
    sensitive: boolean;
    encryptionKey: string | undefined;
  },
): Promise<RepoLoginEnvMetadata> {
  assertValidRepoBinding(params.repoOwner, params.repoName);
  if (params.entries.length === 0) {
    throw new RepoLoginEnvServiceError("Add at least one secret to import", 400);
  }
  for (const entry of params.entries) {
    assertRepoLoginEnvVariableKey(entry.key);
    if (entry.value.trim().length === 0) {
      throw new RepoLoginEnvServiceError(`Value for ${entry.key} must not be empty`, 400);
    }
    try {
      assertRepoRuntimeEnvValue(entry.key, entry.value);
    } catch (error) {
      rethrowRepoRuntimeValidationError(error);
    }
  }

  for (let attempt = 0; attempt < MAX_SINGLE_KEY_MUTATION_ATTEMPTS; attempt += 1) {
    const existing = await resolveRepoLoginEnvForSandbox(
      db,
      params.businessId,
      params.repoOwner,
      params.repoName,
      params.encryptionKey,
    );

    const nextEnv = { ...(existing?.envVars ?? {}) };
    for (const entry of params.entries) {
      nextEnv[entry.key] = entry.value;
    }
    const nextMeta = entriesFromImport(params.entries, params.sensitive, existing?.entryMeta ?? {});

    const loginEnv = existing
      ? await tryUpdateRepoLoginEnvVars(db, {
          businessId: params.businessId,
          actorUserId: params.actorUserId,
          repoOwner: params.repoOwner,
          repoName: params.repoName,
          envVars: nextEnv,
          entryMeta: nextMeta,
          encryptionKey: params.encryptionKey,
          existing,
        })
      : await tryCreateRepoLoginEnvVars(db, {
          businessId: params.businessId,
          actorUserId: params.actorUserId,
          repoOwner: params.repoOwner,
          repoName: params.repoName,
          envVars: nextEnv,
          entryMeta: nextMeta,
          encryptionKey: params.encryptionKey,
        });
    if (loginEnv) return loginEnv;
  }

  log.warn(
    {
      businessId: params.businessId,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      operation: "bulk_upsert",
      attempts: MAX_SINGLE_KEY_MUTATION_ATTEMPTS,
    },
    "Repo runtime env bulk upsert exhausted CAS retries under concurrent writers",
  );
  throw new RepoLoginEnvServiceError("Repository environment variables changed during update; retry the request", 409);
}

export async function deleteRepoLoginEnvVariable(
  db: D1Database,
  params: {
    businessId: string;
    actorUserId: number;
    repoOwner: string;
    repoName: string;
    key: string;
    encryptionKey: string | undefined;
  },
): Promise<RepoLoginEnvVariableUpdateResult> {
  assertValidRepoBinding(params.repoOwner, params.repoName);
  assertRepoLoginEnvVariableKey(params.key);

  for (let attempt = 0; attempt < MAX_SINGLE_KEY_MUTATION_ATTEMPTS; attempt += 1) {
    const existing = await resolveRepoLoginEnvForSandbox(
      db,
      params.businessId,
      params.repoOwner,
      params.repoName,
      params.encryptionKey,
    );
    if (!existing) {
      return { loginEnv: null, changed: false };
    }
    if (!(params.key in existing.envVars)) {
      const keptBlobStillCurrentWinner = await cleanupStaleRepoLoginEnvBlobs(db, {
        businessId: params.businessId,
        repoOwner: params.repoOwner,
        repoName: params.repoName,
        keepId: existing.id,
        expectedUpdatedAt: existing.updatedAt,
      });
      if (!keptBlobStillCurrentWinner) continue;
      return {
        loginEnv: metadataFromResolvedRepoLoginEnv(existing),
        changed: false,
      };
    }

    const nextEnv = { ...existing.envVars };
    delete nextEnv[params.key];
    const nextMeta = { ...existing.entryMeta };
    delete nextMeta[params.key];

    if (Object.keys(nextEnv).length === 0) {
      const deleted = await deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale(db, {
        id: existing.id,
        expectedUpdatedAt: existing.updatedAt,
        businessId: params.businessId,
        name: REPO_LOGIN_ENV_BLOB_NAME,
        repoOwner: params.repoOwner,
        repoName: params.repoName,
      });
      if (!deleted) continue;
      return { loginEnv: null, changed: true };
    }

    const loginEnv = await tryUpdateRepoLoginEnvVars(db, {
      ...params,
      envVars: nextEnv,
      entryMeta: nextMeta,
      existing,
    });
    if (loginEnv) {
      return { loginEnv, changed: true };
    }
  }

  log.warn(
    {
      businessId: params.businessId,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      operation: "delete",
      attempts: MAX_SINGLE_KEY_MUTATION_ATTEMPTS,
    },
    "Repo runtime env delete exhausted CAS retries under concurrent writers",
  );
  throw new RepoLoginEnvServiceError("Repository environment variables changed during delete; retry the request", 409);
}

export async function resolveRepoLoginEnvForSandbox(
  db: D1Database,
  businessId: string | null,
  repoOwner: string,
  repoName: string,
  encryptionKey: string | undefined,
): Promise<ResolvedRepoLoginEnv | null> {
  if (!businessId) return null;
  assertValidRepoBinding(repoOwner, repoName);

  const row = await getRepoEnvBlobForRepo(db, businessId, REPO_LOGIN_ENV_BLOB_NAME, repoOwner, repoName);
  if (!row) return null;

  const envText = await decryptRepoLoginEnv(row, encryptionKey);
  const envVars = parseRepoRuntimeEnv(envText);
  const entryMeta = pruneEntryMeta(parseEntryMetaJson(row.entry_meta_json), Object.keys(envVars));
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    envVars,
    entryMeta,
  };
}

export function getRepoLoginEnvCredentialFingerprint(resolved: ResolvedRepoLoginEnv | null): string[] {
  if (!resolved) return [];
  return [`CYCLOID_LOGIN_ENV:${resolved.id}:${resolved.updatedAt}`];
}
