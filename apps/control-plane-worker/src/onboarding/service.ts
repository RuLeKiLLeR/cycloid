import type {
  CredentialValidationStatus,
  OnboardingActionType,
  OnboardingReasonCode,
  OnboardingStep,
  OnboardingStepId,
  OnboardingStepOwner,
  OnboardingStepStatus,
} from "../../../../shared/constants/onboarding.js";
import {
  CREDENTIAL_VALIDATION_STATUS,
  ONBOARDING_ACTION_TYPES,
  ONBOARDING_REASON_CODES,
  ONBOARDING_STEP_IDS,
  ONBOARDING_STEP_META,
  ONBOARDING_STEP_STATUS,
} from "../../../../shared/constants/onboarding.js";
import type { GithubTokenRefreshEnv } from "../auth/db";
import { probeGithubRepoAccess } from "../auth/repo-authorization";
import type { IntegrationScope, ToggleableIntegrationId } from "../enums/integrations";
import { BUSINESS_ONLY_SET, TOGGLEABLE_INTEGRATION_IDS } from "../enums/integrations";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger({ bindings: { component: "onboarding-service" } });

// ---------------------------------------------------------------------------
// Raw DB row shapes (from the batched snapshot query)
// ---------------------------------------------------------------------------

interface UserIntegrationRow {
  integration_id: string;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: number | null;
  api_key: string | null;
  last_validated_at: number | null;
  last_validation_status: CredentialValidationStatus | null;
  last_validation_reason_code: OnboardingReasonCode | null;
}

interface BusinessScopeRow {
  integration_id: string;
  scope: IntegrationScope;
}

interface BusinessCredentialRow {
  integration_id: string;
  oauth_access_token?: string | null;
  last_validated_at: number | null;
  last_validation_status: CredentialValidationStatus | null;
  last_validation_reason_code: OnboardingReasonCode | null;
}

interface InstallationRow {
  installation_id: number;
  owner_login: string;
  suspended_at: number | null;
}

// ---------------------------------------------------------------------------
// Snapshot: single batched DB read for all onboarding state
// ---------------------------------------------------------------------------

export interface OnboardingSnapshot {
  businessId: string | null;
  userIntegrations: Map<string, UserIntegrationRow>;
  scopes: Record<ToggleableIntegrationId, IntegrationScope>;
  businessCredentials: Map<string, BusinessCredentialRow>;
  /** Installation rows keyed by owner_login (lowercase) */
  installations: Map<string, InstallationRow>;
}

export interface GithubRepoAccessResult {
  status: "not_requested" | "verified" | "denied" | "lookup_failed";
}

export interface OnboardingBuildContext {
  repoOwner: string | null;
  repoName: string | null;
  githubAppSetupComplete?: boolean;
  githubRepoAccess?: GithubRepoAccessResult;
}

/**
 * Load all DB state needed for onboarding in a single batched D1 round-trip.
 */
export async function loadOnboardingSnapshot(
  db: D1Database,
  userId: number,
  repoOwner: string | null,
): Promise<OnboardingSnapshot> {
  // Build statements
  const businessStmt = db.prepare("SELECT business_id FROM business_members WHERE user_id = ? LIMIT 1").bind(userId);

  const userIntStmt = db
    .prepare(
      `SELECT integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at, api_key
              , last_validated_at, last_validation_status, last_validation_reason_code
       FROM user_integrations
       WHERE user_id = ?`,
    )
    .bind(userId);

  // First batch: get business membership + user integrations
  const [businessResult, userIntResult] = await db.batch([businessStmt, userIntStmt]);

  const businessId =
    (businessResult.results?.[0] as unknown as { business_id?: string } | undefined)?.business_id ?? null;

  const userIntegrations = new Map<string, UserIntegrationRow>();
  for (const row of (userIntResult.results ?? []) as unknown as UserIntegrationRow[]) {
    userIntegrations.set(row.integration_id, row);
  }

  // Second batch: business scopes, business credentials, and GitHub installations
  // (only if we have a businessId or repoOwner)
  const secondBatchStmts: D1PreparedStatement[] = [];
  const secondBatchKeys: string[] = [];

  if (businessId) {
    secondBatchStmts.push(
      db.prepare("SELECT integration_id, scope FROM business_integrations WHERE business_id = ?").bind(businessId),
    );
    secondBatchKeys.push("scopes");

    secondBatchStmts.push(
      db
        .prepare(
          `SELECT integration_id, oauth_access_token, last_validated_at, last_validation_status, last_validation_reason_code
           FROM business_integration_credentials
           WHERE business_id = ?`,
        )
        .bind(businessId),
    );
    secondBatchKeys.push("credentials");
  }

  if (repoOwner) {
    secondBatchStmts.push(
      db
        .prepare(
          "SELECT installation_id, owner_login, suspended_at FROM github_installations WHERE owner_login = ? COLLATE NOCASE LIMIT 2",
        )
        .bind(repoOwner),
    );
    secondBatchKeys.push("installations");
  }

  // Build defaults
  const scopes: Record<string, IntegrationScope> = {};
  for (const id of TOGGLEABLE_INTEGRATION_IDS) {
    scopes[id] = BUSINESS_ONLY_SET.has(id) ? "disabled" : "user";
  }
  const businessCredentials = new Map<string, BusinessCredentialRow>();
  const installations = new Map<string, InstallationRow>();

  if (secondBatchStmts.length > 0) {
    const secondResults = await db.batch(secondBatchStmts);

    for (let i = 0; i < secondBatchKeys.length; i++) {
      const key = secondBatchKeys[i];
      const results = secondResults[i].results ?? [];

      if (key === "scopes") {
        for (const row of results as unknown as BusinessScopeRow[]) {
          if (row.integration_id in scopes) {
            scopes[row.integration_id] = row.scope;
          }
        }
      } else if (key === "credentials") {
        for (const row of results as unknown as BusinessCredentialRow[]) {
          businessCredentials.set(row.integration_id, row);
        }
      } else if (key === "installations") {
        const rows = results as unknown as InstallationRow[];
        if (rows.length > 1) {
          throw new Error(
            `Multiple GitHub App installations found for owner_login=${repoOwner}; clean up duplicate github_installations rows before building onboarding status.`,
          );
        }
        for (const row of rows) {
          installations.set(row.owner_login.toLowerCase(), row);
        }
      }
    }
  }

  return {
    businessId,
    userIntegrations,
    scopes: scopes as Record<ToggleableIntegrationId, IntegrationScope>,
    businessCredentials,
    installations,
  };
}

// ---------------------------------------------------------------------------
// Step builders
// ---------------------------------------------------------------------------

function step(
  id: OnboardingStepId,
  status: OnboardingStepStatus,
  reasonCode: OnboardingReasonCode,
  actionType: OnboardingActionType,
  ownerOverride?: OnboardingStepOwner,
  validationState?: {
    lastValidatedAt: number | null;
    lastValidationStatus: CredentialValidationStatus | null;
    lastValidationReasonCode: OnboardingReasonCode | null;
  },
): OnboardingStep {
  const meta = ONBOARDING_STEP_META[id];
  return {
    id,
    title: meta.title,
    owner: ownerOverride ?? meta.owner,
    required: meta.required,
    status,
    reasonCode,
    actionType,
    lastValidatedAt: validationState?.lastValidatedAt ?? null,
    lastValidationStatus: validationState?.lastValidationStatus ?? null,
    lastValidationReasonCode: validationState?.lastValidationReasonCode ?? null,
  };
}

function toValidationState(
  row:
    | {
        last_validated_at: number | null;
        last_validation_status: CredentialValidationStatus | null;
        last_validation_reason_code: OnboardingReasonCode | null;
      }
    | undefined,
): {
  lastValidatedAt: number | null;
  lastValidationStatus: CredentialValidationStatus | null;
  lastValidationReasonCode: OnboardingReasonCode | null;
} {
  return {
    lastValidatedAt: row?.last_validated_at ?? null,
    lastValidationStatus: row?.last_validation_status ?? null,
    lastValidationReasonCode: row?.last_validation_reason_code ?? null,
  };
}

function hasGithubLogin(snapshot: OnboardingSnapshot): boolean {
  return snapshot.userIntegrations.has("github");
}

function hasGithubBusinessAuthorization(snapshot: OnboardingSnapshot): boolean {
  return snapshot.businessId !== null;
}

// ---------------------------------------------------------------------------
// Individual step evaluators
// ---------------------------------------------------------------------------

function evaluateGithubLogin(snapshot: OnboardingSnapshot): OnboardingStep {
  // If the user has reached this endpoint they are authenticated via GitHub OAuth
  const hasGithubToken = hasGithubLogin(snapshot);
  if (hasGithubToken) {
    return step(
      "github_login",
      ONBOARDING_STEP_STATUS.CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_LOGGED_IN,
      ONBOARDING_ACTION_TYPES.NONE,
    );
  }
  return step(
    "github_login",
    ONBOARDING_STEP_STATUS.NOT_CONNECTED,
    ONBOARDING_REASON_CODES.GITHUB_NOT_LOGGED_IN,
    ONBOARDING_ACTION_TYPES.CONNECT,
  );
}

function evaluateGithubBusinessAuthorized(snapshot: OnboardingSnapshot): OnboardingStep {
  if (!hasGithubLogin(snapshot)) {
    return step(
      "github_business_authorized",
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_NOT_LOGGED_IN,
      ONBOARDING_ACTION_TYPES.CONNECT,
      "user",
    );
  }

  if (!hasGithubBusinessAuthorization(snapshot)) {
    return step(
      "github_business_authorized",
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_BUSINESS_NOT_AUTHORIZED,
      ONBOARDING_ACTION_TYPES.ASK_ADMIN,
    );
  }

  return step(
    "github_business_authorized",
    ONBOARDING_STEP_STATUS.CONNECTED,
    ONBOARDING_REASON_CODES.GITHUB_BUSINESS_AUTHORIZED,
    ONBOARDING_ACTION_TYPES.NONE,
  );
}

function evaluateGithubAppInstalled(snapshot: OnboardingSnapshot, context: OnboardingBuildContext): OnboardingStep {
  if (!hasGithubLogin(snapshot)) {
    return step(
      "github_app_installed",
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_NOT_LOGGED_IN,
      ONBOARDING_ACTION_TYPES.CONNECT,
      "user",
    );
  }

  if (!hasGithubBusinessAuthorization(snapshot)) {
    return step(
      "github_app_installed",
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_BUSINESS_NOT_AUTHORIZED,
      ONBOARDING_ACTION_TYPES.ASK_ADMIN,
      "admin",
    );
  }

  if (!context.repoOwner) {
    // No repo context, so we can't check installation
    return step(
      "github_app_installed",
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_REPO_NOT_SELECTED,
      ONBOARDING_ACTION_TYPES.NONE,
    );
  }

  const installation = snapshot.installations.get(context.repoOwner.toLowerCase());
  if (!installation) {
    if (context.githubAppSetupComplete) {
      return step(
        "github_app_installed",
        ONBOARDING_STEP_STATUS.NOT_CONNECTED,
        ONBOARDING_REASON_CODES.GITHUB_APP_INSTALL_PENDING_WEBHOOK_SYNC,
        ONBOARDING_ACTION_TYPES.NONE,
      );
    }

    return step(
      "github_app_installed",
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_APP_NOT_INSTALLED,
      ONBOARDING_ACTION_TYPES.MANAGE_ACCESS,
    );
  }

  if (installation.suspended_at !== null) {
    return step(
      "github_app_installed",
      ONBOARDING_STEP_STATUS.NEEDS_RECONNECT,
      ONBOARDING_REASON_CODES.GITHUB_APP_SUSPENDED,
      ONBOARDING_ACTION_TYPES.MANAGE_ACCESS,
    );
  }

  return step(
    "github_app_installed",
    ONBOARDING_STEP_STATUS.CONNECTED,
    ONBOARDING_REASON_CODES.GITHUB_APP_INSTALLED,
    ONBOARDING_ACTION_TYPES.NONE,
  );
}

function evaluateGithubRepoAccess(snapshot: OnboardingSnapshot, context: OnboardingBuildContext): OnboardingStep {
  if (!hasGithubLogin(snapshot)) {
    return step(
      "github_repo_access",
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_NOT_LOGGED_IN,
      ONBOARDING_ACTION_TYPES.CONNECT,
      "user",
    );
  }

  if (!hasGithubBusinessAuthorization(snapshot)) {
    return step(
      "github_repo_access",
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_BUSINESS_NOT_AUTHORIZED,
      ONBOARDING_ACTION_TYPES.ASK_ADMIN,
      "admin",
    );
  }

  if (!context.repoOwner || !context.repoName) {
    return step(
      "github_repo_access",
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_REPO_NOT_SELECTED,
      ONBOARDING_ACTION_TYPES.NONE,
    );
  }

  if (!context.githubRepoAccess || context.githubRepoAccess.status === "lookup_failed") {
    return step(
      "github_repo_access",
      ONBOARDING_STEP_STATUS.LOOKUP_FAILED,
      ONBOARDING_REASON_CODES.GITHUB_REPO_ACCESS_CHECK_FAILED,
      ONBOARDING_ACTION_TYPES.NONE,
    );
  }

  if (context.githubRepoAccess.status === "not_requested") {
    return step(
      "github_repo_access",
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_REPO_NOT_SELECTED,
      ONBOARDING_ACTION_TYPES.NONE,
    );
  }

  if (context.githubRepoAccess.status === "verified") {
    return step(
      "github_repo_access",
      ONBOARDING_STEP_STATUS.CONNECTED,
      ONBOARDING_REASON_CODES.GITHUB_REPO_ACCESS_VERIFIED,
      ONBOARDING_ACTION_TYPES.NONE,
    );
  }

  return step(
    "github_repo_access",
    ONBOARDING_STEP_STATUS.NOT_CONNECTED,
    ONBOARDING_REASON_CODES.GITHUB_REPO_ACCESS_DENIED,
    ONBOARDING_ACTION_TYPES.MANAGE_ACCESS,
  );
}

function evaluateApiKey(snapshot: OnboardingSnapshot, stepId: "openai_key", integrationId: "openai"): OnboardingStep {
  const scope = snapshot.scopes[integrationId];

  if (scope === "disabled") {
    return step(
      stepId,
      ONBOARDING_STEP_STATUS.DISABLED,
      ONBOARDING_REASON_CODES.INTEGRATION_DISABLED,
      ONBOARDING_ACTION_TYPES.NONE,
    );
  }

  if (scope === "business") {
    const businessRow = snapshot.businessCredentials.get(integrationId);
    const hasCreds = !!businessRow;
    return step(
      stepId,
      hasCreds ? ONBOARDING_STEP_STATUS.CONNECTED : ONBOARDING_STEP_STATUS.BUSINESS_MANAGED,
      hasCreds ? ONBOARDING_REASON_CODES.CREDENTIALS_PRESENT : ONBOARDING_REASON_CODES.BUSINESS_MANAGED,
      hasCreds ? ONBOARDING_ACTION_TYPES.NONE : ONBOARDING_ACTION_TYPES.ASK_ADMIN,
      "admin",
      toValidationState(businessRow),
    );
  }

  // scope === "user"
  const userRow = snapshot.userIntegrations.get(integrationId);
  const hasKey = !!userRow?.api_key;
  const validationState = toValidationState(userRow);

  if (hasKey && userRow?.last_validation_status === CREDENTIAL_VALIDATION_STATUS.INVALID) {
    return step(
      stepId,
      ONBOARDING_STEP_STATUS.VALIDATION_FAILED,
      userRow.last_validation_reason_code ?? ONBOARDING_REASON_CODES.CREDENTIALS_INVALID,
      ONBOARDING_ACTION_TYPES.CONNECT,
      undefined,
      validationState,
    );
  }

  if (hasKey && userRow?.last_validation_status === CREDENTIAL_VALIDATION_STATUS.SAVED_UNVERIFIED) {
    return step(
      stepId,
      ONBOARDING_STEP_STATUS.CONNECTED,
      userRow.last_validation_reason_code ?? ONBOARDING_REASON_CODES.NETWORK_VALIDATION_SKIPPED,
      ONBOARDING_ACTION_TYPES.NONE,
      undefined,
      validationState,
    );
  }

  return step(
    stepId,
    hasKey ? ONBOARDING_STEP_STATUS.CONNECTED : ONBOARDING_STEP_STATUS.NOT_CONNECTED,
    hasKey ? ONBOARDING_REASON_CODES.CREDENTIALS_PRESENT : ONBOARDING_REASON_CODES.CREDENTIALS_MISSING,
    hasKey ? ONBOARDING_ACTION_TYPES.NONE : ONBOARDING_ACTION_TYPES.CONNECT,
    undefined,
    validationState,
  );
}

function evaluateOAuth(snapshot: OnboardingSnapshot, stepId: "linear_oauth", integrationId: "linear"): OnboardingStep {
  const scope = snapshot.scopes[integrationId];

  if (scope === "disabled") {
    return step(
      stepId,
      ONBOARDING_STEP_STATUS.DISABLED,
      ONBOARDING_REASON_CODES.INTEGRATION_DISABLED,
      ONBOARDING_ACTION_TYPES.NONE,
    );
  }

  if (scope === "business") {
    const hasCreds = snapshot.businessCredentials.has(integrationId);
    return step(
      stepId,
      hasCreds ? ONBOARDING_STEP_STATUS.CONNECTED : ONBOARDING_STEP_STATUS.BUSINESS_MANAGED,
      hasCreds ? ONBOARDING_REASON_CODES.CREDENTIALS_PRESENT : ONBOARDING_REASON_CODES.BUSINESS_MANAGED,
      hasCreds ? ONBOARDING_ACTION_TYPES.NONE : ONBOARDING_ACTION_TYPES.ASK_ADMIN,
      "admin",
    );
  }

  const userRow = snapshot.userIntegrations.get(integrationId);
  if (!userRow?.oauth_access_token) {
    return step(
      stepId,
      ONBOARDING_STEP_STATUS.NOT_CONNECTED,
      ONBOARDING_REASON_CODES.OAUTH_NOT_CONNECTED,
      ONBOARDING_ACTION_TYPES.CONNECT,
    );
  }

  // Expired with no refresh token -- user must reconnect manually
  if (userRow.oauth_expires_at && userRow.oauth_expires_at < Date.now() && !userRow.oauth_refresh_token) {
    return step(
      stepId,
      ONBOARDING_STEP_STATUS.NEEDS_RECONNECT,
      ONBOARDING_REASON_CODES.OAUTH_NO_REFRESH_TOKEN,
      ONBOARDING_ACTION_TYPES.RECONNECT,
    );
  }

  // Expired with refresh token is still "connected" -- the runtime auto-refreshes
  // on next use (consistent with auth/db.ts token resolution logic)
  return step(
    stepId,
    ONBOARDING_STEP_STATUS.CONNECTED,
    ONBOARDING_REASON_CODES.OAUTH_CONNECTED,
    ONBOARDING_ACTION_TYPES.NONE,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface OnboardingStatusOptions {
  db: D1Database;
  githubTokenEnv?: GithubTokenRefreshEnv;
  userId: number;
  /** Owner/org for GitHub App installation check (e.g. "acme-corp") */
  repoOwner: string | null;
  /** Repo name for GitHub repo-access verification (e.g. "cycloid") */
  repoName: string | null;
  /** Setup callback just completed; webhook may not have synced the install row yet */
  githubAppSetupComplete?: boolean;
  /** Optional KV env used to cache positive repo-access checks */
  reposCacheEnv?: Pick<Env, "REPOS_CACHE"> | null;
}

async function resolveGithubRepoAccess(
  opts: Pick<OnboardingStatusOptions, "db" | "githubTokenEnv" | "userId" | "repoOwner" | "repoName" | "reposCacheEnv">,
  snapshot: OnboardingSnapshot,
): Promise<GithubRepoAccessResult> {
  if (!opts.repoOwner || !opts.repoName || !hasGithubLogin(snapshot) || !hasGithubBusinessAuthorization(snapshot)) {
    return { status: "not_requested" };
  }

  try {
    if (!opts.githubTokenEnv) {
      log.error({ userId: opts.userId }, "GitHub token env missing for onboarding repo access verification");
      return { status: "lookup_failed" };
    }

    const probe = await probeGithubRepoAccess(opts.db, String(opts.userId), opts.repoOwner, opts.repoName, {
      githubTokenEnv: opts.githubTokenEnv,
      reposCacheEnv: opts.reposCacheEnv,
    });

    if (!probe.ok) {
      return { status: "lookup_failed" };
    }
    if (probe.access) {
      return { status: "verified" };
    }
    if (probe.reason === "repo_access_denied") {
      return { status: "denied" };
    }
    return { status: "lookup_failed" };
  } catch (err) {
    log.error(
      {
        userId: opts.userId,
        repoOwner: opts.repoOwner,
        repoName: opts.repoName,
        error: String(err),
      },
      "Failed to verify GitHub repo access for onboarding",
    );
    return { status: "lookup_failed" };
  }
}

/**
 * Compute the full onboarding status for a user.
 *
 * Each step resolves independently: if a DB lookup fails for one step,
 * that step returns `lookup_failed` while the rest still resolve.
 */
export async function getOnboardingStatus(opts: OnboardingStatusOptions): Promise<OnboardingStep[]> {
  let snapshot: OnboardingSnapshot;
  try {
    snapshot = await loadOnboardingSnapshot(opts.db, opts.userId, opts.repoOwner);
  } catch (err) {
    log.error({ userId: opts.userId, error: String(err) }, "Failed to load onboarding snapshot");
    // Return all steps as lookup_failed
    return ONBOARDING_STEP_IDS.map((id) =>
      step(
        id,
        ONBOARDING_STEP_STATUS.LOOKUP_FAILED,
        ONBOARDING_REASON_CODES.DB_LOOKUP_FAILED,
        ONBOARDING_ACTION_TYPES.NONE,
      ),
    );
  }

  const githubRepoAccess = await resolveGithubRepoAccess(opts, snapshot);

  return buildStepsFromSnapshot(snapshot, {
    repoOwner: opts.repoOwner,
    repoName: opts.repoName,
    githubAppSetupComplete: opts.githubAppSetupComplete ?? false,
    githubRepoAccess,
  });
}

/**
 * Build onboarding steps from a pre-loaded snapshot.
 * Exported for testing without DB access.
 */
export function buildStepsFromSnapshot(
  snapshot: OnboardingSnapshot,
  context: OnboardingBuildContext,
): OnboardingStep[] {
  return [
    evaluateGithubLogin(snapshot),
    evaluateGithubBusinessAuthorized(snapshot),
    evaluateGithubAppInstalled(snapshot, context),
    evaluateGithubRepoAccess(snapshot, context),
    evaluateApiKey(snapshot, "openai_key", "openai"),
    evaluateOAuth(snapshot, "linear_oauth", "linear"),
  ];
}
