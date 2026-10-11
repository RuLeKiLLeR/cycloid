import { USER_API_KEY_PROVIDER_IDS } from "../../../../shared/constants/integration-helpers.js";
import type { ProviderApiKeyState } from "../../../../shared/constants/onboarding.js";
import {
  MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED,
  normalizePrReviewExpectedBot,
  PR_REVIEW_KNOWN_BOT_ID_SET,
  type PrReviewExpectedBot,
  type PrReviewKnownBotId,
} from "../../../../shared/constants/pr-review-bots.js";
import type { PlanModeSetting } from "../../../../shared/plan-mode.js";
import { computeSha256Hex } from "../crypto";
import { UserRowMissingError } from "../db/errors";
import {
  clearProviderApiKey as clearKey,
  getProviderKeyStates as getKeyStates,
  getProviderKeyStatus as getKeyStatus,
  getUserApiKey as getApiKey,
  mapProviderKeyStateRows,
  type ProviderKeyStateRow,
  setProviderApiKey as setKey,
} from "../integrations/db";
import { normalizeSettingsProfile, type SettingsProfile } from "./autonomy";

export type { KeyProvider } from "../integrations/db";

export interface UserSettingsRow {
  user_id: number;
  default_pr_draft: number;
  auto_verify_enabled: number;
  automatic_reviews_enabled: number;
  plan_mode_setting: PlanModeSetting;
  plan_approval_required: number | null;
  settings_profile: SettingsProfile | null;
  use_codex_subscription: number;
  default_model: string | null;
  default_repo: string | null;
  created_at: number;
  updated_at: number;
}

export type UserSettingsCache = Map<number, Promise<UserSettingsRow>>;

const USER_API_KEY_PROVIDER_SQL_LIST = USER_API_KEY_PROVIDER_IDS.map((p) => `'${p}'`).join(", ");
const PR_REVIEW_BOT_SETTINGS_BATCH_SELECT_MAX_USER_IDS = 98;
const USER_SETTINGS_COLUMNS = [
  "user_id",
  "default_pr_draft",
  "auto_verify_enabled",
  "automatic_reviews_enabled",
  "plan_mode_setting",
  "plan_approval_required",
  "settings_profile",
  "use_codex_subscription",
  "default_model",
  "default_repo",
  "created_at",
  "updated_at",
] as const;
export const USER_SETTINGS_COLUMNS_SQL = USER_SETTINGS_COLUMNS.join(", ");
export const USER_SETTINGS_SELECT_BY_USER_ID_SQL = `SELECT ${USER_SETTINGS_COLUMNS_SQL} FROM user_settings WHERE user_id = ? LIMIT 1`;

function validateUserSettingsRow(row: UserSettingsRow): UserSettingsRow {
  if (row.plan_mode_setting !== "off" && row.plan_mode_setting !== "on" && row.plan_mode_setting !== "auto") {
    throw new Error(`Invalid plan_mode_setting in user_settings: ${String(row.plan_mode_setting)}`);
  }
  if (
    row.settings_profile !== null &&
    row.settings_profile !== undefined &&
    normalizeSettingsProfile(row.settings_profile) !== row.settings_profile
  ) {
    throw new Error(`Invalid settings_profile in user_settings: ${String(row.settings_profile)}`);
  }
  return row;
}

// Shared so the auth and settings layers throw the same class (route
// `instanceof` checks must resolve identically). Re-exported for existing
// importers of this module.
export { UserRowMissingError };

async function createUserSettingsIfMissing(db: D1Database, userId: number): Promise<UserSettingsRow> {
  const now = Date.now();
  // Insert only if the user still exists. `SELECT id ... FROM users WHERE id = ?`
  // fails closed on a missing user (no row inserted, no FK violation); the WHERE
  // clause also satisfies SQLite's upsert-with-SELECT parsing requirement.
  await db
    .prepare(
      `INSERT INTO user_settings (user_id, default_pr_draft, auto_verify_enabled, automatic_reviews_enabled, plan_mode_setting, plan_approval_required, settings_profile, use_codex_subscription, default_model, default_repo, created_at, updated_at)
       SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM users WHERE id = ?
       ON CONFLICT (user_id) DO NOTHING`,
    )
    .bind(0, 0, 0, "off", null, "manual", 0, null, null, now, now, userId)
    .run();

  const row = await db.prepare(USER_SETTINGS_SELECT_BY_USER_ID_SQL).bind(userId).first<UserSettingsRow>();

  if (!row) {
    throw new UserRowMissingError(userId);
  }

  return validateUserSettingsRow(row);
}

export async function getUserSettings(db: D1Database, userId: number): Promise<UserSettingsRow> {
  const row = await db.prepare(USER_SETTINGS_SELECT_BY_USER_ID_SQL).bind(userId).first<UserSettingsRow>();

  if (row) return validateUserSettingsRow(row);

  return createUserSettingsIfMissing(db, userId);
}

export async function getUserSettingsIfExists(db: D1Database, userId: number): Promise<UserSettingsRow | null> {
  const row = await db.prepare(USER_SETTINGS_SELECT_BY_USER_ID_SQL).bind(userId).first<UserSettingsRow>();
  return row ? validateUserSettingsRow(row) : null;
}

export async function updateUserSettings(
  db: D1Database,
  userId: number,
  fields: {
    defaultPrDraft?: boolean;
    autoVerifyEnabled?: boolean;
    automaticReviewsEnabled?: boolean;
    planMode?: PlanModeSetting;
    planApprovalRequired?: boolean | null;
    settingsProfile?: SettingsProfile | null;
    useCodexSubscription?: boolean;
    defaultModel?: string | null;
    defaultRepo?: string | null;
  },
): Promise<UserSettingsRow> {
  const now = Date.now();

  // Default-off: opening PRs as drafts is opt-in.
  const insertDefaultPrDraft = fields.defaultPrDraft !== undefined ? (fields.defaultPrDraft ? 1 : 0) : 0;
  // Default-off: verification is opt-in per user.
  const insertAutoVerify = fields.autoVerifyEnabled !== undefined ? (fields.autoVerifyEnabled ? 1 : 0) : 0;
  // Default-off: automatic review handling is opt-in per user (manual is the default).
  const insertAutomaticReviews =
    fields.automaticReviewsEnabled !== undefined ? (fields.automaticReviewsEnabled ? 1 : 0) : 0;
  // Default-off: planning before implementation is opt-in per user.
  const insertPlanMode = fields.planMode ?? "off";
  const insertPlanApprovalRequired =
    fields.planApprovalRequired === undefined || fields.planApprovalRequired === null
      ? null
      : fields.planApprovalRequired
        ? 1
        : 0;
  const insertSettingsProfile = fields.settingsProfile === undefined ? "manual" : fields.settingsProfile;
  const insertUseCodexSubscription =
    fields.useCodexSubscription !== undefined ? (fields.useCodexSubscription ? 1 : 0) : 0;
  const insertDefaultModel = fields.defaultModel !== undefined ? fields.defaultModel : null;
  const insertDefaultRepo = fields.defaultRepo !== undefined ? fields.defaultRepo : null;

  const conflictSets: string[] = [];
  if (fields.defaultPrDraft !== undefined) conflictSets.push("default_pr_draft = excluded.default_pr_draft");
  if (fields.autoVerifyEnabled !== undefined) conflictSets.push("auto_verify_enabled = excluded.auto_verify_enabled");
  if (fields.automaticReviewsEnabled !== undefined)
    conflictSets.push("automatic_reviews_enabled = excluded.automatic_reviews_enabled");
  if (fields.planMode !== undefined) conflictSets.push("plan_mode_setting = excluded.plan_mode_setting");
  if (fields.planApprovalRequired !== undefined)
    conflictSets.push("plan_approval_required = excluded.plan_approval_required");
  if (fields.settingsProfile !== undefined) conflictSets.push("settings_profile = excluded.settings_profile");
  if (fields.useCodexSubscription !== undefined)
    conflictSets.push("use_codex_subscription = excluded.use_codex_subscription");
  if (fields.defaultModel !== undefined) conflictSets.push("default_model = excluded.default_model");
  if (fields.defaultRepo !== undefined) conflictSets.push("default_repo = excluded.default_repo");
  if (conflictSets.length > 0) conflictSets.push("updated_at = excluded.updated_at");

  const setClause = conflictSets.length > 0 ? conflictSets.join(", ") : "updated_at = user_settings.updated_at";

  const row = await db
    .prepare(
      `INSERT INTO user_settings (user_id, default_pr_draft, auto_verify_enabled, automatic_reviews_enabled, plan_mode_setting, plan_approval_required, settings_profile, use_codex_subscription, default_model, default_repo, created_at, updated_at)
       SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM users WHERE id = ?
       ON CONFLICT (user_id) DO UPDATE SET ${setClause}
       RETURNING ${USER_SETTINGS_COLUMNS_SQL}`,
    )
    .bind(
      insertDefaultPrDraft,
      insertAutoVerify,
      insertAutomaticReviews,
      insertPlanMode,
      insertPlanApprovalRequired,
      insertSettingsProfile,
      insertUseCodexSubscription,
      insertDefaultModel,
      insertDefaultRepo,
      now,
      now,
      userId,
    )
    .first<UserSettingsRow>();

  // Missing `users` row → INSERT ... SELECT matched nothing and RETURNING is
  // empty. Fail closed (stale cache for a deleted/renumbered user) instead of
  // the old `row!` assertion that would have produced an FK violation upstream.
  if (!row) {
    throw new UserRowMissingError(userId);
  }

  return validateUserSettingsRow(row);
}

/**
 * Batch-fetch user settings and API key status in a single D1 round-trip.
 * Falls back to a second round-trip only on first-ever settings fetch (lazy init).
 */
export async function getSettingsWithKeyStatus(
  db: D1Database,
  userId: number,
): Promise<{ settings: UserSettingsRow; apiKeys: Record<string, ProviderApiKeyState> }> {
  const [settingsResult, keyResult] = await db.batch([
    db.prepare(USER_SETTINGS_SELECT_BY_USER_ID_SQL).bind(userId),
    db
      .prepare(
        `SELECT integration_id, last_validated_at, last_validation_status, last_validation_reason_code
       FROM user_integrations
       WHERE user_id = ? AND integration_id IN (${USER_API_KEY_PROVIDER_SQL_LIST})`,
      )
      .bind(userId),
  ]);

  const settingsRow = (settingsResult.results as UserSettingsRow[])?.[0] ?? null;
  let settings: UserSettingsRow;
  if (settingsRow) {
    settings = validateUserSettingsRow(settingsRow);
  } else {
    // Lazy init uses an idempotent insert because first settings requests can race after login.
    settings = await createUserSettingsIfMissing(db, userId);
  }

  const apiKeys = mapProviderKeyStateRows((keyResult.results ?? []) as ProviderKeyStateRow[]);

  return { settings, apiKeys };
}

export const getProviderKeyStates = getKeyStates;
export const getProviderKeyStatus = getKeyStatus;
export const setProviderApiKey = setKey;
export const clearProviderApiKey = clearKey;
export const getUserApiKey = getApiKey;

export type { PrReviewExpectedBot };

export interface UserPrReviewBotSettingsRow {
  user_id: number;
  repo_owner: string;
  repo_name: string;
  expected_bots_json: string;
  review_timeout_minutes: number;
  merge_conflict_resolution_enabled: number;
  created_at: number;
  updated_at: number;
}

export interface UserPrReviewBotSettingsPayload {
  expectedBots: PrReviewExpectedBot[];
  expectedBotsHash: string;
  mergeConflictResolutionEnabled: boolean;
}

interface ListedUserPrReviewBotSettings {
  repoOwner: string;
  repoName: string;
  expectedBots: PrReviewExpectedBot[];
  expectedBotsHash: string;
  mergeConflictResolutionEnabled: boolean;
}

function normalizeRepoKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeExpectedPrReviewBots(expectedBots: PrReviewExpectedBot[]): PrReviewExpectedBot[] {
  return expectedBots.map(normalizePrReviewExpectedBot);
}

function parseExpectedPrReviewBotsJson(raw: string | null | undefined): PrReviewExpectedBot[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const bots: PrReviewExpectedBot[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (record.type === "known" && typeof record.id === "string") {
        const id = record.id.toLowerCase();
        if (PR_REVIEW_KNOWN_BOT_ID_SET.has(id)) {
          bots.push({ type: "known", id: id as PrReviewKnownBotId });
        }
      } else if (record.type === "custom" && typeof record.login === "string") {
        const login = record.login.trim().toLowerCase();
        if (login) bots.push({ type: "custom", login });
      }
    }
    return bots;
  } catch {
    return [];
  }
}

function canonicalExpectedPrReviewBotsSerialization(expectedBots: PrReviewExpectedBot[]): string {
  return normalizeExpectedPrReviewBots(expectedBots)
    .map((bot) => ({ type: bot.type, value: bot.type === "known" ? bot.id : bot.login }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.value.localeCompare(b.value))
    .map((bot) => `${bot.type}:${bot.value}`)
    .join("\n");
}

export async function computeExpectedPrReviewBotsHash(expectedBots: PrReviewExpectedBot[]): Promise<string> {
  return computeSha256Hex(canonicalExpectedPrReviewBotsSerialization(expectedBots));
}

export async function mapPrReviewBotSettingsRow(
  row: UserPrReviewBotSettingsRow | null,
): Promise<UserPrReviewBotSettingsPayload> {
  const expectedBots = normalizeExpectedPrReviewBots(parseExpectedPrReviewBotsJson(row?.expected_bots_json));
  return {
    expectedBots,
    expectedBotsHash: await computeExpectedPrReviewBotsHash(expectedBots),
    // No row → default: merge-conflict resolution on. This is what unblocks no-bots users.
    mergeConflictResolutionEnabled: row
      ? row.merge_conflict_resolution_enabled === 1
      : MERGE_CONFLICT_RESOLUTION_DEFAULT_ENABLED,
  };
}

export async function getUserPrReviewBotSettings(
  db: D1Database,
  userId: number,
  repoOwner: string,
  repoName: string,
): Promise<UserPrReviewBotSettingsPayload> {
  const owner = normalizeRepoKey(repoOwner);
  const repo = normalizeRepoKey(repoName);
  const row = await db
    .prepare(
      `SELECT user_id, repo_owner, repo_name, expected_bots_json, review_timeout_minutes, merge_conflict_resolution_enabled, created_at, updated_at
       FROM user_pr_review_bot_settings
       WHERE user_id = ? AND repo_owner = ? AND repo_name = ?
       LIMIT 1`,
    )
    .bind(userId, owner, repo)
    .first<UserPrReviewBotSettingsRow>();

  return mapPrReviewBotSettingsRow(row ?? null);
}

export async function getUserPrReviewBotSettingsByUserIds(
  db: D1Database,
  userIds: number[],
  repoOwner: string,
  repoName: string,
): Promise<Map<number, UserPrReviewBotSettingsPayload>> {
  const uniqueUserIds = [...new Set(userIds.filter((userId) => Number.isFinite(userId)))];
  if (uniqueUserIds.length === 0) return new Map();

  const owner = normalizeRepoKey(repoOwner);
  const repo = normalizeRepoKey(repoName);
  const rows: UserPrReviewBotSettingsRow[] = [];
  for (let i = 0; i < uniqueUserIds.length; i += PR_REVIEW_BOT_SETTINGS_BATCH_SELECT_MAX_USER_IDS) {
    const batch = uniqueUserIds.slice(i, i + PR_REVIEW_BOT_SETTINGS_BATCH_SELECT_MAX_USER_IDS);
    const placeholders = batch.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT user_id, repo_owner, repo_name, expected_bots_json, review_timeout_minutes, merge_conflict_resolution_enabled, created_at, updated_at
         FROM user_pr_review_bot_settings
         WHERE repo_owner = ? AND repo_name = ? AND user_id IN (${placeholders})`,
      )
      .bind(owner, repo, ...batch)
      .all<UserPrReviewBotSettingsRow>();
    rows.push(...(result.results ?? []));
  }

  const rowsByUserId = new Map(rows.map((row) => [row.user_id, row]));
  const settings = new Map<number, UserPrReviewBotSettingsPayload>();
  await Promise.all(
    uniqueUserIds.map(async (userId) => {
      settings.set(userId, await mapPrReviewBotSettingsRow(rowsByUserId.get(userId) ?? null));
    }),
  );
  return settings;
}

export async function setUserPrReviewBotSettings(
  db: D1Database,
  userId: number,
  repoOwner: string,
  repoName: string,
  input: {
    expectedBots: PrReviewExpectedBot[];
    mergeConflictResolutionEnabled: boolean;
  },
): Promise<UserPrReviewBotSettingsPayload> {
  const owner = normalizeRepoKey(repoOwner);
  const repo = normalizeRepoKey(repoName);
  const normalized = normalizeExpectedPrReviewBots(input.expectedBots);
  const mergeConflictFlag = input.mergeConflictResolutionEnabled ? 1 : 0;
  const now = Date.now();
  // review_timeout_minutes and ci_response_enabled are orphaned columns (the wait-window
  // and CI opt-outs were removed); left out of the write so their schema DEFAULTs apply
  // and no code reads them.
  await db
    .prepare(
      `INSERT INTO user_pr_review_bot_settings (user_id, repo_owner, repo_name, expected_bots_json, merge_conflict_resolution_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, repo_owner, repo_name) DO UPDATE SET
         expected_bots_json = excluded.expected_bots_json,
         merge_conflict_resolution_enabled = excluded.merge_conflict_resolution_enabled,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, owner, repo, JSON.stringify(normalized), mergeConflictFlag, now, now)
    .run();

  return {
    expectedBots: normalized,
    expectedBotsHash: await computeExpectedPrReviewBotsHash(normalized),
    mergeConflictResolutionEnabled: input.mergeConflictResolutionEnabled,
  };
}

function parsePrReviewBotSettingsCursor(
  cursor: string | null | undefined,
): { repoOwner: string; repoName: string } | null {
  if (!cursor) return null;
  const slashIndex = cursor.indexOf("/");
  if (slashIndex <= 0 || slashIndex === cursor.length - 1) return null;
  return {
    repoOwner: normalizeRepoKey(cursor.slice(0, slashIndex)),
    repoName: normalizeRepoKey(cursor.slice(slashIndex + 1)),
  };
}

export async function listUserPrReviewBotSettings(
  db: D1Database,
  userId: number,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<{ rows: ListedUserPrReviewBotSettings[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 100);
  const queryLimit = limit + 1;
  const cursor = parsePrReviewBotSettingsCursor(options.cursor);
  // ci_response_enabled is intentionally excluded: the opt-out was removed (ARC-1288) and the
  // column is orphaned, so a legacy 0 must not flag a repo as customized.
  const NON_DEFAULT = `(expected_bots_json <> '[]' OR merge_conflict_resolution_enabled <> 1)`;
  const statement = cursor
    ? db
        .prepare(
          `SELECT user_id, repo_owner, repo_name, expected_bots_json, review_timeout_minutes, merge_conflict_resolution_enabled, created_at, updated_at
           FROM user_pr_review_bot_settings
           WHERE user_id = ?
             AND ${NON_DEFAULT}
             AND (repo_owner > ? OR (repo_owner = ? AND repo_name > ?))
           ORDER BY repo_owner ASC, repo_name ASC
           LIMIT ?`,
        )
        .bind(userId, cursor.repoOwner, cursor.repoOwner, cursor.repoName, queryLimit)
    : db
        .prepare(
          `SELECT user_id, repo_owner, repo_name, expected_bots_json, review_timeout_minutes, merge_conflict_resolution_enabled, created_at, updated_at
           FROM user_pr_review_bot_settings
           WHERE user_id = ? AND ${NON_DEFAULT}
           ORDER BY repo_owner ASC, repo_name ASC
           LIMIT ?`,
        )
        .bind(userId, queryLimit);

  const result = await statement.all();
  const rawRows = (result.results ?? []) as unknown as UserPrReviewBotSettingsRow[];
  const pageRows = rawRows.slice(0, limit);
  const rows: ListedUserPrReviewBotSettings[] = [];
  for (const row of pageRows) {
    const mapped = await mapPrReviewBotSettingsRow(row);
    rows.push({
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      expectedBots: mapped.expectedBots,
      expectedBotsHash: mapped.expectedBotsHash,
      mergeConflictResolutionEnabled: mapped.mergeConflictResolutionEnabled,
    });
  }
  const last = pageRows[pageRows.length - 1] ?? null;
  return {
    rows,
    nextCursor: rawRows.length > limit && last ? `${last.repo_owner}/${last.repo_name}` : null,
  };
}
