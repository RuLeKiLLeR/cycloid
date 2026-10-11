import type { PrReviewExpectedBot } from "../../../../shared/constants/pr-review-bots.js";
import { createBoundedTtlMemoryCache } from "../bounded-memory-cache";
import {
  getInstallationByOwner,
  type InstallationRow,
  updateInstallationPermissions,
} from "../github/installations-db";
import { getAppInstallationCapabilities } from "../github/octokit";
import { createLogger } from "../logger";
import { emitReviewLoopInstallationCapabilitiesMissingMetric } from "../observability/pr-metrics";
import { resolveCustomMergeConflictResolution, resolveEffectiveAutonomySettings } from "../settings/autonomy";
import {
  getUserPrReviewBotSettings,
  getUserSettingsIfExists,
  type UserPrReviewBotSettingsPayload,
} from "../settings/db";
import type { Env } from "../types";
import { EMPTY_EXPECTED_BOTS_HASH, type ReviewLoopSourceKind } from "./review-loop-epochs";

const log = createLogger({ bindings: { component: "review-loop-settings" } });

// Must stay a subset of the events the production GitHub App actually subscribes to: event
// subscriptions are app-level, so a re-approval can never fix an event gap — a required event
// outside the app's subscription fails closed for every installation. The app does not
// subscribe to `push` (head changes arrive via `pull_request` synchronize).
const REVIEW_LOOP_REQUIRED_INSTALLATION_EVENTS = [
  "check_run",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "status",
];
const REVIEW_LOOP_REQUIRED_INSTALLATION_PERMISSIONS = {
  checks: "read",
  contents: "write",
  metadata: "read",
  pull_requests: "write",
  statuses: "read",
} as const;

export type ReviewLoopChecklistResolution =
  | { ok: true; expectedBots: PrReviewExpectedBot[]; expectedBotsHash: string; installationId: number }
  | {
      ok: false;
      reason: "expected_bots_changed" | "installation_capabilities_missing" | "review_handling_disabled";
      reapproveUrl?: string;
    };

export type ReviewLoopChecklistFailureReason = Extract<ReviewLoopChecklistResolution, { ok: false }>["reason"];

/**
 * Whether a checklist failure disables ONLY the code-review (bot-comment) arm, leaving the always-on
 * CI-fix + verification arm to run. RLA v2 scopes the expected-bots checklist to the code-review arm
 * only (docs/design/rla-v2.md); the complement — missing installation capabilities — disables the
 * whole loop and must fail closed. Exhaustive over the reason
 * union: a newly added reason makes the default branch a tsc error, forcing an explicit classification
 * here instead of silently inheriting one side.
 */
export function isCodeReviewArmOnlyChecklistFailure(reason: ReviewLoopChecklistFailureReason): boolean {
  switch (reason) {
    case "expected_bots_changed":
      return true;
    // Manual review mode (ARC-1514): automatic review handling is off, so the code-review/human arms are
    // suppressed — but the always-on CI-fix arm keeps running (CI-green still reaches MERGE_READY). Arm-only.
    case "review_handling_disabled":
      return true;
    case "installation_capabilities_missing":
      return false;
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      // Runtime fail-safe: an unclassified reason is treated as whole-loop disabled (fail closed).
      return false;
    }
  }
}

function parseJsonRecord(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") record[key] = value;
    }
    return record;
  } catch {
    return null;
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return null;
  }
}

function permissionSatisfies(actual: string | undefined, required: "read" | "write"): boolean {
  if (required === "read") return actual === "read" || actual === "write";
  return actual === "write";
}

function getReviewLoopInstallationCapabilityGaps(installation: InstallationRow): {
  missingPermissions: string[];
  missingEvents: string[];
  unknown: boolean;
} {
  const permissions = parseJsonRecord(installation.permissions_json);
  const events = parseJsonStringArray(installation.events_json);
  return {
    unknown: permissions === null || events === null,
    missingPermissions:
      permissions === null
        ? []
        : Object.entries(REVIEW_LOOP_REQUIRED_INSTALLATION_PERMISSIONS)
            .filter(([name, required]) => !permissionSatisfies(permissions[name], required))
            .map(([name]) => name),
    missingEvents:
      events === null ? [] : REVIEW_LOOP_REQUIRED_INSTALLATION_EVENTS.filter((event) => !events.includes(event)),
  };
}

type InstallationCapabilityResult =
  | { ok: true; installation: InstallationRow }
  | {
      ok: false;
      reason: "installation_capabilities_missing";
      reapproveUrl?: string;
      missingPermissions?: string[];
      missingEvents?: string[];
    };

type ReviewLoopCapabilityEnv = Pick<Env, "DB"> &
  Partial<Pick<Env, "DD_API_KEY" | "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "WORKER_ENV">>;

// Cached capabilities can rot silently: GitHub sends no webhook when an app's event
// subscription changes (only `new_permissions_accepted` for permissions), so a cached gap may
// reflect a since-fixed subscription. Gap-triggered refreshes give the row a chance to heal
// before failing closed, throttled per isolate so a genuinely missing capability doesn't
// refetch from GitHub on every webhook/sweep capability check.
const CAPABILITY_GAP_REFRESH_TTL_MS = 10 * 60 * 1000;
const capabilityGapRefreshAttempts = createBoundedTtlMemoryCache<number, true>(1000);

function reviewLoopSettingsRepoKey(input: { ownerUserId: number; repoOwner: string; repoName: string }): string {
  return `${input.ownerUserId}:${input.repoOwner.trim().toLowerCase()}/${input.repoName.trim().toLowerCase()}`;
}

function installationSettingsUrl(installation: InstallationRow): string {
  const ownerLogin = installation.owner_login.trim();
  if (installation.owner_type.toLowerCase() === "organization" && ownerLogin) {
    return `https://github.com/organizations/${encodeURIComponent(ownerLogin)}/settings/installations/${installation.installation_id}`;
  }
  return `https://github.com/settings/installations/${installation.installation_id}`;
}

function installationWithCapabilities(
  installation: InstallationRow,
  capabilities: {
    ownerLogin: string;
    ownerId: number;
    ownerType: string;
    repositorySelection: string | null;
    permissions: Record<string, string>;
    events: string[];
  },
): InstallationRow {
  return {
    ...installation,
    owner_login: capabilities.ownerLogin || installation.owner_login,
    owner_id: capabilities.ownerId || installation.owner_id,
    owner_type: capabilities.ownerType || installation.owner_type,
    repository_selection: capabilities.repositorySelection ?? installation.repository_selection,
    permissions_json: JSON.stringify(capabilities.permissions),
    events_json: JSON.stringify(capabilities.events),
  };
}

async function refreshInstallationCapabilities(
  env: ReviewLoopCapabilityEnv,
  installation: InstallationRow,
): Promise<InstallationRow> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GitHub App credentials are unavailable for installation capability refresh");
  }
  const capabilities = await getAppInstallationCapabilities(
    { GITHUB_APP_ID: env.GITHUB_APP_ID, GITHUB_PRIVATE_KEY: env.GITHUB_PRIVATE_KEY },
    installation.installation_id,
  );
  const refreshed = installationWithCapabilities(installation, capabilities);
  await updateInstallationPermissions(env.DB, {
    installationId: refreshed.installation_id,
    ownerLogin: refreshed.owner_login,
    ownerId: refreshed.owner_id,
    ownerType: refreshed.owner_type,
    repositorySelection: refreshed.repository_selection,
    permissions: capabilities.permissions,
    events: capabilities.events,
  });
  return refreshed;
}

async function reportMissingInstallationCapabilities(
  env: ReviewLoopCapabilityEnv,
  input: {
    ownerUserId: number;
    repoOwner: string;
    repoName: string;
    installation: InstallationRow;
    missingPermissions: string[];
    missingEvents: string[];
  },
): Promise<void> {
  log.warn(
    {
      event: "review_loop.installation_capabilities_missing",
      ownerUserId: input.ownerUserId,
      owner: input.repoOwner,
      repo: input.repoName,
      installation_id: input.installation.installation_id,
      missing_permissions: input.missingPermissions,
      missing_events: input.missingEvents,
    },
    "Review-loop installation capabilities missing",
  );
  await emitReviewLoopInstallationCapabilitiesMissingMetric(env, {
    repo: `${input.repoOwner}/${input.repoName}`,
    owner: input.repoOwner,
    ownerUserId: input.ownerUserId,
    installationId: input.installation.installation_id,
    missingPermissions: input.missingPermissions,
    missingEvents: input.missingEvents,
  });
}

async function checkReviewLoopInstallationCapabilities(
  env: ReviewLoopCapabilityEnv,
  input: {
    ownerUserId: number;
    repoOwner: string;
    repoName: string;
    installationByOwnerLogin?: ReadonlyMap<string, InstallationRow>;
  },
): Promise<InstallationCapabilityResult> {
  const installation = input.installationByOwnerLogin
    ? (input.installationByOwnerLogin.get(input.repoOwner.trim().toLowerCase()) ?? null)
    : await getInstallationByOwner(env.DB, input.repoOwner);
  if (!installation || installation.suspended_at !== null) {
    log.warn(
      {
        event: "review_loop_install_capabilities_missing",
        ownerUserId: input.ownerUserId,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        missingInstallation: !installation,
        suspended: installation ? installation.suspended_at !== null : false,
      },
      "Review-loop install capability check failed closed",
    );
    return {
      ok: false,
      reason: "installation_capabilities_missing",
      reapproveUrl: installation ? installationSettingsUrl(installation) : undefined,
    };
  }

  let effectiveInstallation = installation;
  let gaps = getReviewLoopInstallationCapabilityGaps(effectiveInstallation);
  // A gap of any kind — an unknown (NULL/unparseable) cache or a recorded missing permission/event —
  // may reflect a since-fixed subscription, so try a refresh before trusting it. Gate every kind on
  // the throttle so a refresh that keeps failing (or keeps not healing) is not refetched from GitHub
  // on every webhook/sweep check; the first attempt still runs because the throttle starts unset.
  const hasGap = gaps.unknown || gaps.missingPermissions.length > 0 || gaps.missingEvents.length > 0;
  const shouldRefresh = hasGap && capabilityGapRefreshAttempts.get(effectiveInstallation.installation_id) === null;
  if (shouldRefresh) {
    try {
      effectiveInstallation = await refreshInstallationCapabilities(env, effectiveInstallation);
      gaps = getReviewLoopInstallationCapabilityGaps(effectiveInstallation);
      if (input.installationByOwnerLogin instanceof Map) {
        input.installationByOwnerLogin.set(input.repoOwner.trim().toLowerCase(), effectiveInstallation);
      }
      // Throttle only refreshes that did not heal. A healed refresh must not set the throttle:
      // webhook-ingest loops preload one installation row for many sessions, and later sessions
      // still holding the stale row need their own refresh instead of failing closed for the TTL.
      if (gaps.missingPermissions.length > 0 || gaps.missingEvents.length > 0) {
        capabilityGapRefreshAttempts.set(effectiveInstallation.installation_id, true, CAPABILITY_GAP_REFRESH_TTL_MS);
      }
    } catch (error) {
      // Throttle every failed attempt — unknown caches included — so a failing GitHub call is not
      // refetched on every check. A failed fetch proves nothing fresh, so the same TTL backoff fits
      // both gap kinds; the throttle starts unset, so the first attempt for an isolate still runs.
      capabilityGapRefreshAttempts.set(effectiveInstallation.installation_id, true, CAPABILITY_GAP_REFRESH_TTL_MS);
      log.warn(
        {
          event: "review_loop.installation_capabilities_refresh_failed",
          ownerUserId: input.ownerUserId,
          owner: input.repoOwner,
          repo: input.repoName,
          installation_id: effectiveInstallation.installation_id,
          error: String(error),
        },
        "Review-loop installation capability refresh failed closed",
      );
      // Fall through: the unknown/known gap checks below decide the verdict for both gap kinds.
    }
  }

  // An unknown cache that the refresh could not resolve — because it was throttled or failed — proves
  // nothing, so fail closed without specifics rather than treating no capability data as capable.
  if (gaps.unknown) {
    return {
      ok: false,
      reason: "installation_capabilities_missing",
      reapproveUrl: installationSettingsUrl(effectiveInstallation),
    };
  }

  if (gaps.missingPermissions.length > 0 || gaps.missingEvents.length > 0) {
    await reportMissingInstallationCapabilities(env, {
      ownerUserId: input.ownerUserId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      installation: effectiveInstallation,
      missingPermissions: gaps.missingPermissions,
      missingEvents: gaps.missingEvents,
    });
    return {
      ok: false,
      reason: "installation_capabilities_missing",
      reapproveUrl: installationSettingsUrl(effectiveInstallation),
      missingPermissions: gaps.missingPermissions,
      missingEvents: gaps.missingEvents,
    };
  }

  return { ok: true, installation: effectiveInstallation };
}

/**
 * Manual review mode (ARC-1514): the per-user `automatic_reviews_enabled` setting. Default OFF (manual)
 * — a missing settings row resolves `false`, so review handling is suppressed until a user opts in.
 *
 * READ-ONLY: reads via `getUserSettingsIfExists` (NEVER `getUserSettings`, which creates-if-missing and
 * would WRITE a settings row on every gate check). Called at the top of the review-arm gates below; the
 * always-on CI-fix gate (`resolveReviewLoopCiEligibility`) never consults it.
 */
export async function resolveAutomaticReviewsEnabled(input: { db: D1Database; ownerUserId: number }): Promise<boolean> {
  try {
    const s = await getUserSettingsIfExists(input.db, input.ownerUserId);
    return resolveEffectiveAutonomySettings(s).automaticReviewsEnabled;
  } catch (error) {
    log.warn(
      { ownerUserId: input.ownerUserId, error: String(error) },
      "Failed to load autonomy profile; disabling reviews",
    );
    return false;
  }
}

/**
 * Resolve the bot-comment review checklist for a repo: manual-review-mode gate, then the configured
 * expected-bot set plus the GitHub App installation capabilities. Fails with `review_handling_disabled`
 * (arm-only — manual mode) or `expected_bots_changed` (arm-only — the CI-fix + verification arm still
 * runs) or `installation_capabilities_missing` (whole-loop). Walltime removal: a zero-bot repo is no
 * longer a failure — it resolves ok:true with an empty expected-bot set (epochs are immediately due),
 * and the capability check runs for it like any other repo.
 */
export async function resolveReviewLoopChecklist(
  env: ReviewLoopCapabilityEnv,
  input: {
    ownerUserId: number;
    repoOwner: string;
    repoName: string;
    expectedBotsHash?: string | null;
    installationByOwnerLogin?: ReadonlyMap<string, InstallationRow>;
    botSettingsByOwnerRepo?: ReadonlyMap<string, UserPrReviewBotSettingsPayload>;
  },
): Promise<ReviewLoopChecklistResolution> {
  // Manual review mode (ARC-1514): when automatic review handling is off, suppress the code-review arm
  // before any expected-bots/capability work. Arm-only — the always-on CI-fix arm keeps running.
  if (!(await resolveAutomaticReviewsEnabled({ db: env.DB, ownerUserId: input.ownerUserId }))) {
    return { ok: false, reason: "review_handling_disabled" };
  }

  const botSettings = input.botSettingsByOwnerRepo
    ? (input.botSettingsByOwnerRepo.get(reviewLoopSettingsRepoKey(input)) ?? null)
    : await getUserPrReviewBotSettings(env.DB, input.ownerUserId, input.repoOwner, input.repoName);
  // Walltime removal: a zero-bot repo is no longer a checklist failure — the code-review arm arms with
  // an empty expected-bot set (there is nothing to wait for; epochs are immediately due).
  const expectedBots = botSettings?.expectedBots ?? [];
  const expectedBotsHash = botSettings?.expectedBotsHash ?? EMPTY_EXPECTED_BOTS_HASH;
  if (input.expectedBotsHash && expectedBotsHash !== input.expectedBotsHash) {
    return { ok: false, reason: "expected_bots_changed" };
  }

  const caps = await checkReviewLoopInstallationCapabilities(env, input);
  if (!caps.ok) return caps;

  return { ok: true, expectedBots, expectedBotsHash, installationId: caps.installation.installation_id };
}

export type ReviewLoopHumanEligibility =
  | { ok: true; ownerUserId: number; installationId: number }
  | { ok: false; reason: "installation_capabilities_missing" | "review_handling_disabled"; reapproveUrl?: string };

export async function resolveReviewLoopHumanEligibility(
  env: ReviewLoopCapabilityEnv,
  input: {
    ownerUserId: number;
    repoOwner: string;
    repoName: string;
    installationByOwnerLogin?: ReadonlyMap<string, InstallationRow>;
    // Epoch source kind. Verification (QA needs-work) epochs share this human gate for the bot-checklist
    // bypass, but they are INDEPENDENT of manual review mode — QA lives on the separate auto_verify axis —
    // so they must skip the manual `automatic_reviews_enabled` gate below. Genuine reviewer epochs
    // (human/mixed) stay gated. Omitted (default) keeps the gate applied so any untouched caller is safe.
    sourceKind?: ReviewLoopSourceKind;
  },
): Promise<ReviewLoopHumanEligibility> {
  // Manual review mode (ARC-1514): the human-review arm is suppressed when automatic review handling is off.
  // Verification epochs bypass this gate — QA verification is independent of manual review mode.
  if (input.sourceKind !== "verification") {
    if (!(await resolveAutomaticReviewsEnabled({ db: env.DB, ownerUserId: input.ownerUserId }))) {
      return { ok: false, reason: "review_handling_disabled" };
    }
  }
  const caps = await checkReviewLoopInstallationCapabilities(env, input);
  if (!caps.ok) return caps;
  return { ok: true, ownerUserId: input.ownerUserId, installationId: caps.installation.installation_id };
}

export type ReviewLoopMergeConflictEligibility =
  | { ok: true; ownerUserId: number; installationId: number }
  | {
      ok: false;
      reason: "merge_conflict_resolution_disabled" | "installation_capabilities_missing" | "review_handling_disabled";
      reapproveUrl?: string;
    };

export async function resolveReviewLoopMergeConflictEligibility(
  env: ReviewLoopCapabilityEnv,
  input: {
    ownerUserId: number;
    repoOwner: string;
    repoName: string;
    installationByOwnerLogin?: ReadonlyMap<string, InstallationRow>;
    botSettingsByOwnerRepo?: ReadonlyMap<string, UserPrReviewBotSettingsPayload>;
  },
): Promise<ReviewLoopMergeConflictEligibility> {
  // Manual review mode (ARC-1514): the merge-conflict-resolution arm is suppressed when automatic review
  // handling is off, alongside the other review arms. CI-fix is unaffected.
  if (!(await resolveAutomaticReviewsEnabled({ db: env.DB, ownerUserId: input.ownerUserId }))) {
    return { ok: false, reason: "review_handling_disabled" };
  }

  const botSettings = input.botSettingsByOwnerRepo
    ? (input.botSettingsByOwnerRepo.get(reviewLoopSettingsRepoKey(input)) ?? null)
    : await getUserPrReviewBotSettings(env.DB, input.ownerUserId, input.repoOwner, input.repoName);
  let settings = null;
  try {
    settings = await getUserSettingsIfExists(env.DB, input.ownerUserId);
  } catch (error) {
    log.warn(
      { ownerUserId: input.ownerUserId, error: String(error) },
      "Failed to load autonomy profile; disabling merge conflicts",
    );
    return { ok: false, reason: "review_handling_disabled" };
  }
  const mergeConflictResolutionEnabled = resolveCustomMergeConflictResolution(
    settings,
    botSettings?.mergeConflictResolutionEnabled ?? true,
  );
  if (!mergeConflictResolutionEnabled) {
    return { ok: false, reason: "merge_conflict_resolution_disabled" };
  }

  const caps = await checkReviewLoopInstallationCapabilities(env, input);
  if (!caps.ok) return caps;

  return { ok: true, ownerUserId: input.ownerUserId, installationId: caps.installation.installation_id };
}

export type ReviewLoopCiEligibility =
  | { ok: true; ownerUserId: number; installationId: number }
  | { ok: false; reason: "installation_capabilities_missing"; reapproveUrl?: string };

/**
 * CI-failure gate. Unlike resolveReviewLoopChecklist, this does NOT require a bot
 * checklist — a repo with zero configured bots is eligible. Gated only by
 * installation capabilities. The auto-response / ci_response opt-outs were removed
 * (ARC-1288): review-listening always arms for capable repos so post-PR
 * verification always runs.
 */
export async function resolveReviewLoopCiEligibility(
  env: ReviewLoopCapabilityEnv,
  input: {
    ownerUserId: number;
    repoOwner: string;
    repoName: string;
    installationByOwnerLogin?: ReadonlyMap<string, InstallationRow>;
  },
): Promise<ReviewLoopCiEligibility> {
  const caps = await checkReviewLoopInstallationCapabilities(env, input);
  if (!caps.ok) return caps;

  return { ok: true, ownerUserId: input.ownerUserId, installationId: caps.installation.installation_id };
}
