import { parseNeonBranchCredentialConfig } from "../../../../shared/integrations/neon.js";
import type { PreviewContractE2ECredentialDeclaration } from "../../../../shared/types/sandbox.js";
import { computeSha256Hex } from "../crypto";
import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import { decrypt } from "../settings/encryption";
import { readBusinessCredentialRow } from "./db";
import { getIntegrationScopes } from "./service";

const neonLog = createLogger({ bindings: { component: "integration-neon" } });
const NEON_API_BASE = "https://console.neon.tech/api/v2";
const NEON_SOURCE = "business_neon_branch";

export const SESSION_NEON_BRANCH_STORAGE_KEY = "integration:neon:session-branch";

export interface NeonBranchStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | void>;
}

export type SessionNeonBranchRecord = {
  projectId: string;
  parentBranchId: string | null;
  branchId: string;
  branchName: string;
  connectionUri: string;
  createdAt: number;
};

type NeonBusinessCredential = {
  apiKey: string;
  projectId: string;
  parentBranchId: string | null;
};

type NeonCreateBranchResponse = {
  connection_uris?: Array<{ connection_uri?: string | null } | null> | null;
  branch?: {
    id?: string | null;
    name?: string | null;
    current_state?: string | null;
    parent_id?: string | null;
    connection_uris?: Array<{ connection_uri?: string | null } | null> | null;
  } | null;
};

class NeonApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "NeonApiError";
    this.statusCode = statusCode;
  }
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

async function decryptIfNeeded(
  value: string | null | undefined,
  encrypted: number | null | undefined,
  encryptionKey: string | undefined,
): Promise<string | null> {
  if (!value) return null;
  return encrypted === 1 ? decrypt(value, encryptionKey) : value;
}

async function readResponseBodyPreview(response: Response): Promise<string | null> {
  try {
    const text = (await response.text()).trim();
    if (!text) return null;
    return text.length > 400 ? `${text.slice(0, 400)}...` : text;
  } catch {
    return null;
  }
}

async function neonApiRequest<T>(apiKey: string, path: string, init: RequestInit, traceName: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("accept", "application/json");
  if (init.body) {
    headers.set("content-type", "application/json");
  }
  const response = await tracedFetch(
    `${NEON_API_BASE}${path}`,
    {
      ...init,
      headers,
    },
    traceName,
  );
  if (!response.ok) {
    const bodyPreview = await readResponseBodyPreview(response);
    throw new NeonApiError(
      `Neon API request failed (${response.status})${bodyPreview ? `: ${bodyPreview}` : ""}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

async function neonApiDelete(apiKey: string, path: string, traceName: string): Promise<void> {
  const headers = new Headers();
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("accept", "application/json");
  const response = await tracedFetch(
    `${NEON_API_BASE}${path}`,
    {
      method: "DELETE",
      headers,
    },
    traceName,
  );
  if (response.ok || response.status === 404) {
    return;
  }
  const bodyPreview = await readResponseBodyPreview(response);
  throw new NeonApiError(
    `Neon API request failed (${response.status})${bodyPreview ? `: ${bodyPreview}` : ""}`,
    response.status,
  );
}

function extractConnectionUri(response: NeonCreateBranchResponse): string | null {
  for (const source of [response.connection_uris, response.branch?.connection_uris]) {
    for (const candidate of source ?? []) {
      const connectionUri = trimToNull(candidate?.connection_uri);
      if (connectionUri) return connectionUri;
    }
  }
  return null;
}

async function buildSessionBranchName(sessionId: string): Promise<string> {
  const digest = await computeSha256Hex(sessionId);
  return `cycloid-${digest.slice(0, 16)}`;
}

async function getNeonBusinessCredential(
  db: D1Database,
  businessId: string,
  encryptionKey: string | undefined,
  logger: Logger,
): Promise<NeonBusinessCredential | null> {
  const row = await readBusinessCredentialRow(db, businessId, "neon", ["api_key", "service_url", "encrypted"]);
  if (!row) return null;
  if (row.encrypted === 1 && !encryptionKey) {
    logger.warn(
      { businessId, reason: "encryption_key_missing" },
      "Cannot decrypt Neon credential because TOKEN_ENCRYPTION_KEY is missing",
    );
    return null;
  }

  let apiKey: string | null;
  try {
    apiKey = trimToNull(await decryptIfNeeded(row.api_key, row.encrypted, encryptionKey));
  } catch (error) {
    logger.warn({ businessId, error: String(error) }, "Failed to decrypt workspace Neon credential");
    return null;
  }

  const config = parseNeonBranchCredentialConfig(row.service_url);
  if (!apiKey || !config) return null;
  return {
    apiKey,
    projectId: config.projectId,
    parentBranchId: config.parentBranchId ?? null,
  };
}

async function createSessionNeonBranch(
  credential: NeonBusinessCredential,
  sessionId: string,
): Promise<SessionNeonBranchRecord> {
  const branchName = await buildSessionBranchName(sessionId);
  const response = await neonApiRequest<NeonCreateBranchResponse>(
    credential.apiKey,
    `/projects/${encodeURIComponent(credential.projectId)}/branches`,
    {
      method: "POST",
      body: JSON.stringify({
        branch: {
          name: branchName,
          ...(credential.parentBranchId ? { parent_id: credential.parentBranchId } : {}),
        },
        endpoints: [{ type: "read_write" }],
      }),
    },
    "neon.create_branch",
  );

  const branchId = trimToNull(response.branch?.id);
  const resolvedBranchName = trimToNull(response.branch?.name) ?? branchName;
  const connectionUri = extractConnectionUri(response);
  if (!branchId || !connectionUri) {
    throw new Error("Neon branch creation response did not include a branch ID and connection URI.");
  }

  return {
    projectId: credential.projectId,
    parentBranchId: credential.parentBranchId,
    branchId,
    branchName: resolvedBranchName,
    connectionUri,
    createdAt: Date.now(),
  };
}

export async function resolveSessionNeonBranchCredentialEnvs(
  db: D1Database,
  opts: {
    storage: NeonBranchStorage;
    businessId: string;
    sessionId: string;
    repoOwner: string;
    repoName: string;
    declarations: readonly PreviewContractE2ECredentialDeclaration[];
    encryptionKey: string | undefined;
    logger?: Logger;
  },
): Promise<Record<string, string>> {
  const declarations = opts.declarations.filter((declaration) => declaration.source === NEON_SOURCE);
  if (declarations.length === 0) return {};

  const logger = opts.logger ?? neonLog;
  const scopes = await getIntegrationScopes(db, opts.businessId);
  if (scopes.neon !== "business") {
    throw new Error(
      `Cannot start session: Neon runtime credentials are declared for ${opts.repoOwner}/${opts.repoName}, ` +
        `but the workspace Neon integration is disabled.`,
    );
  }

  const credential = await getNeonBusinessCredential(db, opts.businessId, opts.encryptionKey, logger);
  if (!credential) {
    throw new Error(
      `Cannot start session: Neon runtime credentials are declared for ${opts.repoOwner}/${opts.repoName}, ` +
        `but the workspace Neon integration is not fully configured.`,
    );
  }

  const storedBranch = await opts.storage.get<SessionNeonBranchRecord>(SESSION_NEON_BRANCH_STORAGE_KEY);
  if (storedBranch?.connectionUri?.trim()) {
    const configMatches =
      storedBranch.projectId === credential.projectId &&
      (storedBranch.parentBranchId ?? null) === (credential.parentBranchId ?? null);
    if (configMatches) {
      return Object.fromEntries(declarations.map((declaration) => [declaration.envVar, storedBranch.connectionUri]));
    }

    try {
      await neonApiDelete(
        credential.apiKey,
        `/projects/${encodeURIComponent(storedBranch.projectId)}/branches/${encodeURIComponent(storedBranch.branchId)}`,
        "neon.delete_branch",
      );
    } catch (error) {
      logger.warn(
        {
          businessId: opts.businessId,
          sessionId: opts.sessionId,
          projectId: storedBranch.projectId,
          branchId: storedBranch.branchId,
          error: String(error),
        },
        "Failed to delete stale Neon session branch after workspace config change",
      );
    }
    await opts.storage.delete(SESSION_NEON_BRANCH_STORAGE_KEY);
  }

  let branchRecord: SessionNeonBranchRecord;
  try {
    branchRecord = await createSessionNeonBranch(credential, opts.sessionId);
  } catch (error) {
    logger.warn(
      {
        businessId: opts.businessId,
        sessionId: opts.sessionId,
        projectId: credential.projectId,
        parentBranchId: credential.parentBranchId,
        error: String(error),
      },
      "Failed to create session-scoped Neon branch",
    );
    if (error instanceof NeonApiError && (error.statusCode === 401 || error.statusCode === 403)) {
      throw new Error(
        `Cannot start session: Neon rejected the workspace API key while creating a session branch for ${opts.repoOwner}/${opts.repoName}.`,
      );
    }
    throw new Error(`Cannot start session: failed to provision a Neon branch for ${opts.repoOwner}/${opts.repoName}.`);
  }

  await opts.storage.put(SESSION_NEON_BRANCH_STORAGE_KEY, branchRecord);
  return Object.fromEntries(declarations.map((declaration) => [declaration.envVar, branchRecord.connectionUri]));
}

export async function cleanupSessionNeonBranch(
  db: D1Database | undefined,
  opts: {
    storage: NeonBranchStorage;
    businessId: string | null | undefined;
    sessionId: string;
    encryptionKey: string | undefined;
    logger?: Logger;
  },
): Promise<void> {
  const logger = opts.logger ?? neonLog;
  const branchRecord = await opts.storage.get<SessionNeonBranchRecord>(SESSION_NEON_BRANCH_STORAGE_KEY);
  if (!branchRecord) return;

  if (!db || !opts.businessId) {
    logger.warn(
      { sessionId: opts.sessionId, businessId: opts.businessId ?? null, branchId: branchRecord.branchId },
      "Skipping Neon branch cleanup because business DB context is unavailable",
    );
    return;
  }

  const credential = await getNeonBusinessCredential(db, opts.businessId, opts.encryptionKey, logger);
  if (!credential) {
    logger.warn(
      { sessionId: opts.sessionId, businessId: opts.businessId, branchId: branchRecord.branchId },
      "Skipping Neon branch cleanup because the workspace credential is unavailable",
    );
    return;
  }

  try {
    await neonApiDelete(
      credential.apiKey,
      `/projects/${encodeURIComponent(branchRecord.projectId)}/branches/${encodeURIComponent(branchRecord.branchId)}`,
      "neon.delete_branch",
    );
    await opts.storage.delete(SESSION_NEON_BRANCH_STORAGE_KEY);
  } catch (error) {
    logger.warn(
      {
        sessionId: opts.sessionId,
        businessId: opts.businessId,
        projectId: branchRecord.projectId,
        branchId: branchRecord.branchId,
        error: String(error),
      },
      "Failed to delete session-scoped Neon branch",
    );
  }
}
