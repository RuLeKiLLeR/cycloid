import {
  extractSessionStartModelIdAnyBackend,
  normalizeRetiredBasetenModelId,
} from "../../../../shared/constants/models.js";
import { isValidGithubRepoSegment } from "../../../../shared/github/repo-url.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { createLogger } from "../logger";
import { gateGithubSessionStart } from "../services/integration-gating";
import { encrypt } from "../settings/encryption";
import type { Env } from "../types";
import { generateRandomHex } from "../utils";
import {
  getPagerDutyWebhookInstallationByBusiness,
  type PagerDutyWebhookInstallation,
  revokePagerDutyWebhookInstallationByBusiness,
  upsertPagerDutyWebhookInstallation,
} from "../webhooks/db";

const log = createLogger({ bindings: { component: "pagerduty-dispatch-admin" } });

const PAGERDUTY_DISPATCH_WEBHOOK_PATH_PREFIX = "/api/webhooks/pagerduty/";

export type PagerDutyDispatchInstallationSummary = {
  status: "not_configured" | "active" | "revoked";
  repoOwner: string | null;
  repoName: string | null;
  modelId: string | null;
  webhookUrl: string | null;
  webhookSigningSecretConfigured: boolean;
  connectedAt: number | null;
  updatedAt: number | null;
  revokedAt: number | null;
};

export class PagerDutyDispatchAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${publicMessage}`);
    this.name = "PagerDutyDispatchAdminError";
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PagerDutyDispatchAdminError(400, "invalid_input", `${field} is required`);
  }
  return value.trim();
}

function validateRepoSegment(value: unknown, field: string): string {
  const segment = requireString(value, field);
  if (!isValidGithubRepoSegment(segment)) {
    throw new PagerDutyDispatchAdminError(400, "invalid_repo", `${field} is not a valid GitHub identifier`);
  }
  return segment;
}

function sanitizeModelId(value: unknown): string | null {
  if (value == null || value === "") return null;
  const modelId = extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(value));
  if (!modelId) {
    throw new PagerDutyDispatchAdminError(400, "invalid_model", "modelId is not a supported session model");
  }
  return modelId;
}

function buildPagerDutyWebhookUrl(publicBaseUrl: string, installationToken: string): string {
  return new URL(
    `${PAGERDUTY_DISPATCH_WEBHOOK_PATH_PREFIX}${encodeURIComponent(installationToken)}`,
    publicBaseUrl,
  ).toString();
}

function toSummary(
  installation: PagerDutyWebhookInstallation | null,
  publicBaseUrl: string,
): PagerDutyDispatchInstallationSummary {
  if (!installation) {
    return {
      status: "not_configured",
      repoOwner: null,
      repoName: null,
      modelId: null,
      webhookUrl: null,
      webhookSigningSecretConfigured: false,
      connectedAt: null,
      updatedAt: null,
      revokedAt: null,
    };
  }

  return {
    status: installation.status,
    repoOwner: installation.repoOwner,
    repoName: installation.repoName,
    modelId: installation.modelId,
    webhookUrl:
      installation.status === "active" ? buildPagerDutyWebhookUrl(publicBaseUrl, installation.installationToken) : null,
    webhookSigningSecretConfigured: Boolean(installation.webhookSigningSecretEncrypted),
    connectedAt: installation.connectedAt,
    updatedAt: installation.updatedAt,
    revokedAt: installation.revokedAt,
  };
}

export async function getPagerDutyDispatchInstallationSummary(
  db: D1Database,
  businessId: string,
  publicBaseUrl: string,
): Promise<PagerDutyDispatchInstallationSummary> {
  return toSummary(await getPagerDutyWebhookInstallationByBusiness(db, businessId), publicBaseUrl);
}

export async function savePagerDutyDispatchInstallation(
  env: Env,
  input: {
    callerUserId: string;
    businessId: string;
    repoOwner: unknown;
    repoName: unknown;
    modelId?: unknown;
    webhookSigningSecret?: unknown;
    rotateToken?: boolean;
    publicBaseUrl: string;
  },
): Promise<PagerDutyDispatchInstallationSummary> {
  const repoOwner = validateRepoSegment(input.repoOwner, "repoOwner");
  const repoName = validateRepoSegment(input.repoName, "repoName");
  const modelId = sanitizeModelId(input.modelId);
  const connectedByUserId = Number(input.callerUserId);
  if (!Number.isFinite(connectedByUserId)) {
    throw new PagerDutyDispatchAdminError(400, "invalid_user", "A numeric caller user id is required");
  }

  const existing = await getPagerDutyWebhookInstallationByBusiness(env.DB, input.businessId);
  const webhookSigningSecret =
    typeof input.webhookSigningSecret === "string" && input.webhookSigningSecret.trim()
      ? input.webhookSigningSecret.trim()
      : null;
  if (!webhookSigningSecret && !existing?.webhookSigningSecretEncrypted) {
    throw new PagerDutyDispatchAdminError(
      400,
      "invalid_input",
      "webhookSigningSecret is required when configuring PagerDuty dispatch.",
    );
  }

  const gate = await gateGithubSessionStart(env, {
    userId: input.callerUserId,
    businessId: input.businessId,
    sessionId: `pagerduty-dispatch-preflight-${input.businessId}`,
    repoOwner,
    repoName,
  });
  if (!gate.ok) {
    log.warn(
      { businessId: input.businessId, repoOwner, repoName, reasonCode: gate.body.reasonCode },
      "pagerduty_dispatch_blocked_by_repo_gate",
    );
    throw new PagerDutyDispatchAdminError(
      404,
      "repo_not_available",
      "Repository is not available for PagerDuty dispatch.",
      { stage: gate.body.stage, reasonCode: gate.body.reasonCode },
    );
  }

  const installationToken =
    existing?.status === "active" && !input.rotateToken ? existing.installationToken : generateRandomHex(32);

  let webhookSigningSecretEncrypted: string | null = null;
  if (webhookSigningSecret) {
    try {
      webhookSigningSecretEncrypted = await encrypt(webhookSigningSecret, env.TOKEN_ENCRYPTION_KEY);
    } catch (err) {
      throw new PagerDutyDispatchAdminError(
        500,
        "save_failed",
        "Failed to encrypt the PagerDuty webhook signing secret.",
        {
          error: stringifyError(err),
        },
      );
    }
  }

  try {
    await upsertPagerDutyWebhookInstallation(env.DB, {
      businessId: input.businessId,
      installationToken,
      connectedByUserId,
      repoOwner,
      repoName,
      modelId,
      webhookSigningSecretEncrypted,
    });
  } catch (err) {
    throw new PagerDutyDispatchAdminError(500, "save_failed", "Failed to save PagerDuty dispatch configuration.", {
      error: stringifyError(err),
    });
  }

  const saved = await getPagerDutyWebhookInstallationByBusiness(env.DB, input.businessId);
  if (!saved) {
    throw new PagerDutyDispatchAdminError(500, "save_failed", "PagerDuty dispatch configuration was not persisted.");
  }

  return toSummary(saved, input.publicBaseUrl);
}

export async function removePagerDutyDispatchInstallation(
  db: D1Database,
  businessId: string,
): Promise<{ disconnected: boolean }> {
  const disconnected = await revokePagerDutyWebhookInstallationByBusiness(db, businessId);
  return { disconnected };
}
