/**
 * DO-internal SQLite database access layer.
 *
 * All methods accept a SqlStorage instance (this.state.storage.sql) and
 * operate on the tables defined in schema.ts. Conversion between SQL rows
 * and the TypeScript types used by the rest of the codebase happens here.
 *
 * Conventions:
 * - Timestamps: stored as INTEGER (Unix ms) in SQL, converted to ISO strings for TS types.
 * - Booleans: stored as INTEGER (0/1) in SQL.
 * - JSON blobs: stored as TEXT, parsed on read.
 * - Cost: stored as integer micros in prompt_usage, converted to float USD at read boundary.
 */

import {
  type AgentRuntimeBackend,
  CODEX_AGENT_RUNTIME_BACKEND,
  resolveAgentRuntimeBackend,
} from "../../../../shared/agent/agent-runtime-backend.js";
import type {
  AgentConfig,
  AgentRole,
  HarnessKind,
  RuntimeStartupProfile,
  VerificationRuntimeMode,
} from "../../../../shared/agent/schema.js";
import { REPLAY_WINDOW_SIZE } from "../../../../shared/constants/session.js";
import type { EstimatedInputCompositionRecord } from "../../../../shared/events/bridge.js";
import { decodeCycloidEvent, encodeCycloidEvent } from "../../../../shared/events/schema.js";
import type {
  PlatformLlmCallType,
  PlatformLlmCapabilityRecord,
  PlatformLlmFailureCategory,
  PlatformLlmPhase,
} from "../../../../shared/llm/platform-llm-contract.js";
import type { VerificationResult, VerificationState } from "../../../../shared/session/phase.js";
import {
  qaTestingStateFromVerificationState,
  verificationStateFromQaTestingState,
} from "../../../../shared/session/phase.js";
import { normalizeToolName, parseMcpServerName } from "../../../../shared/tools/names.js";
import type {
  PlanContext,
  ReviewLoopPromptSourceKind,
  SandboxRuntimeBackend,
  SandboxRuntimeProvider,
  SandboxRuntimeState,
  VerificationNeedsWorkLabel,
} from "../../../../shared/types/sandbox.js";
import type { SessionPlanStatus } from "../../../../shared/types/session-plan.js";
import type { SessionReplayEvent } from "../../../../shared/types/session-replay.js";
import { isSafeGitRef } from "../../../../shared/utils/git-ref.js";
import { sanitizeResolvedAgents } from "../agent/resolution.js";
import {
  HEARTBEAT_EVENT_TYPE,
  PROMPT_HEARTBEAT_EVENT_TYPE,
  SANDBOX_HEARTBEAT_EVENT_TYPE,
} from "../constants/events.js";
import type { PerPromptUsage, UsageCache } from "../constants/sessions";
import { MAX_VERIFICATION_RUNS_PER_PR } from "../constants/verification";
import { InitiationMode, parseInitiationMode } from "../enums/initiation-mode.js";
import type { SandboxIdlePauseReason } from "../enums/sandbox.js";
import { parseSessionEntrypoint, type SessionEntrypoint } from "../enums/session-entrypoint.js";
import { runtimeBackendOrNull, runtimeProviderOrNull, runtimeStateOrNull } from "../sandbox/runtime-backend";
import { parseSlackQuotedReplySource } from "../slack/blocks";
import type {
  CallbackContext,
  GithubIssueContext,
  LinearContext,
  PromptState,
  ReplayState,
  SessionEvent,
  SessionState,
} from "../types";
import { mergeCallbackContextUpdate } from "./callback-context.js";
import { type DurableEntry, projectStoredCycloidEventToSessionEvent } from "./cycloid-event-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USD_TO_MICROS = 1_000_000;

function isoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function msToIso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function boolToInt(val: boolean | null | undefined): number {
  return val ? 1 : 0;
}

function intToBool(val: unknown): boolean {
  return val === 1 || val === true;
}

function jsonOrNull(val: unknown): string | null {
  if (val == null) return null;
  return JSON.stringify(val);
}

function parseJsonOrNull<T>(val: unknown): T | null {
  if (val == null || val === "") return null;
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as T;
    } catch {
      return null;
    }
  }
  return null;
}

function parseStringArrayOrNull(val: unknown): string[] | null {
  const parsed = parseJsonOrNull<unknown[]>(val);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

export function verificationStateOrNull(value: unknown): VerificationState | null {
  return value === "verification-pending" ||
    value === "verification-in-progress" ||
    value === "verification-done" ||
    value === "verification-skipped" ||
    value === "verification-stopped" ||
    value === "verification-exhausted"
    ? value
    : null;
}

export function verificationResultOrNull(value: unknown): VerificationResult | null {
  return value === "needs-work" || value === "merge-ready" ? value : null;
}

export function verificationNeedsWorkLabelOrNull(value: unknown): VerificationNeedsWorkLabel | null {
  return value === "verification-gap" ? value : null;
}

function nonNegativeIntegerOrZero(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0;
}

// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
function verificationRuntimeModeOrNull(value: unknown): VerificationRuntimeMode | null {
  return value === "none" || value === "app_runtime" ? value : null;
}

function readPersistedVerificationState(row: Record<string, SqlStorageValue>): VerificationState | null {
  return verificationStateFromQaTestingState(row.qa_testing_state);
}

function readPersistedVerificationValue<T>(qaValue: unknown, normalize: (value: unknown) => T): T {
  return normalize(qaValue);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface CreateSessionParams {
  sessionId: string;
  ownerUserId: string;
  businessId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  agentRuntimeBackend?: AgentRuntimeBackend | null;
  repoOwner?: string;
  repoName?: string;
  baseBranch?: string;
  startBranch?: string;
  prUrl?: string | null;
  prNumber?: number | null;
  installationId?: number;
  callbackContext?: CallbackContext;
  linearContext?: LinearContext;
  githubIssueContext?: GithubIssueContext;
  resolvedAgents?: Record<string, AgentConfig>;
  agentRole?: AgentRole;
  agentProfile?: string;
  harnessKind?: HarnessKind;
  runtimeStartupProfile?: RuntimeStartupProfile;
  verificationRuntimeMode?: VerificationRuntimeMode;
  targetPrUrl?: string | null;
  autoVerifyDisabled?: boolean;
  planMode?: boolean;
  planApprovalRequired?: boolean;
  planAutoReason?: string | null;
  adoptedExternalPr?: boolean;
  initiationMode?: InitiationMode;
  entrypoint?: SessionEntrypoint;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
}

export function createSession(sql: SqlStorage, params: CreateSessionParams): SessionState {
  const now = Date.now();
  const businessId = params.businessId ?? null;
  const initiationMode = params.initiationMode ?? InitiationMode.USER;
  sql.exec(
    `INSERT INTO session (
      session_id, owner_user_id, business_id, status, created_at, updated_at,
      model, reasoning_effort, agent_runtime_backend, repo_owner, repo_name, base_branch, start_branch, pr_url, pr_number,
      installation_id, callback_context_json, linear_context_json,
      github_issue_context_json, resolved_agents_json,
      agent_role, agent_profile, harness_kind, runtime_startup_profile, verification_runtime_mode, target_pr_url, auto_verify_disabled, plan_mode, plan_approval_required, plan_auto_reason, adopted_external_pr,
      initiation_mode, entrypoint, scheduled_rule_id, rule_name_snapshot, cron_snapshot
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params.sessionId,
    params.ownerUserId,
    businessId,
    now,
    now,
    params.model ?? null,
    params.reasoningEffort ?? null,
    params.agentRuntimeBackend ?? CODEX_AGENT_RUNTIME_BACKEND,
    params.repoOwner ?? null,
    params.repoName ?? null,
    params.baseBranch ?? null,
    params.startBranch ?? null,
    params.prUrl ?? null,
    params.prNumber ?? null,
    params.installationId ?? null,
    jsonOrNull(params.callbackContext),
    jsonOrNull(params.linearContext),
    jsonOrNull(params.githubIssueContext),
    jsonOrNull(params.resolvedAgents),
    params.agentRole ?? null,
    params.agentProfile ?? null,
    params.harnessKind ?? null,
    params.runtimeStartupProfile ?? null,
    params.verificationRuntimeMode ?? null,
    params.targetPrUrl ?? null,
    boolToInt(params.autoVerifyDisabled ?? false),
    boolToInt(params.planMode ?? false),
    boolToInt(params.planApprovalRequired ?? false),
    params.planAutoReason ?? null,
    boolToInt(params.adoptedExternalPr ?? false),
    initiationMode,
    params.entrypoint ?? null,
    params.scheduledRuleId ?? null,
    params.ruleNameSnapshot ?? null,
    params.cronSnapshot ?? null,
  );

  return {
    sessionId: params.sessionId,
    ownerUserId: params.ownerUserId,
    businessId,
    status: "active",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    closedAt: null,
    lastEventId: null,
    title: null,
    model: params.model ?? null,
    reasoningEffort: params.reasoningEffort ?? null,
    agentRuntimeBackend: params.agentRuntimeBackend ?? CODEX_AGENT_RUNTIME_BACKEND,
    sessionKind: "repo",
    repoOwner: params.repoOwner ?? null,
    repoName: params.repoName ?? null,
    agentRole: params.agentRole ?? null,
    agentProfile: params.agentProfile ?? null,
    harnessKind: params.harnessKind ?? null,
    runtimeStartupProfile: params.runtimeStartupProfile ?? null,
    verificationRuntimeMode: params.verificationRuntimeMode ?? null,
    targetPrUrl: params.targetPrUrl ?? null,
    autoVerifyDisabled: params.autoVerifyDisabled ?? false,
    planMode: params.planMode ?? false,
    planApprovalRequired: params.planApprovalRequired ?? false,
    planAutoReason: params.planAutoReason ?? null,
    adoptedExternalPr: params.adoptedExternalPr ?? false,
    initiationMode,
    entrypoint: params.entrypoint ?? null,
    scheduledRuleId: params.scheduledRuleId ?? null,
    ruleNameSnapshot: params.ruleNameSnapshot ?? null,
    cronSnapshot: params.cronSnapshot ?? null,
  };
}

export function getSession(sql: SqlStorage, sessionId: string): SessionState | null {
  const rows = sql.exec("SELECT * FROM session WHERE session_id = ?", sessionId).toArray();
  if (rows.length === 0) return null;
  return sessionRowToState(rows[0]);
}

/** A SessionDO owns at most one session row; used only during wake rehydration. */
export function getSessionIdForDo(sql: SqlStorage): string | null {
  const row = sql.exec("SELECT session_id FROM session LIMIT 1").toArray()[0];
  return (row?.session_id as string | undefined) ?? null;
}

function agentRoleFromPersistedValue(value: SqlStorageValue): AgentRole | null {
  if (value === "verification") return "verification";
  if (value === "review") return "review";
  if (value === "implementation") return "implementation";
  // Legacy intent-observer rows predate this role removal. Keep them read-only
  // under the surviving verification gates instead of falling through to the
  // implementation defaults.
  if (value === "intent") return "verification";
  return null;
}

function harnessKindFromPersistedValue(value: SqlStorageValue): HarnessKind | null {
  return value === "codex-session" || value === "claude-session" ? value : null;
}

function runtimeStartupProfileFromPersistedValue(value: SqlStorageValue): RuntimeStartupProfile | null {
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  if (value === "verification_ready_runtime") return "verification_ready_runtime";
  if (value === "implementation_default") return "implementation_default";
  return null;
}

function sessionRowToState(row: Record<string, SqlStorageValue>): SessionState {
  return {
    sessionId: row.session_id as string,
    ownerUserId: row.owner_user_id as string,
    businessId: (row.business_id as string | null) ?? null,
    status: row.status as "active" | "archived",
    createdAt: msToIso(row.created_at as number) ?? new Date().toISOString(),
    updatedAt: msToIso(row.updated_at as number) ?? new Date().toISOString(),
    closedAt: msToIso(row.closed_at as number | null),
    lastEventId: null, // Derived from events table
    title: row.title as string | null,
    model: (row.model as string | null) ?? null,
    reasoningEffort: (row.reasoning_effort as string | null) ?? null,
    agentRuntimeBackend: resolveAgentRuntimeBackend(row.agent_runtime_backend as string | null),
    sessionKind: "repo",
    repoOwner: (row.repo_owner as string | null) ?? null,
    repoName: (row.repo_name as string | null) ?? null,
    agentRole: agentRoleFromPersistedValue(row.agent_role),
    agentProfile: row.agent_profile as string | null,
    harnessKind: harnessKindFromPersistedValue(row.harness_kind),
    runtimeStartupProfile: runtimeStartupProfileFromPersistedValue(row.runtime_startup_profile),
    verificationRuntimeMode: verificationRuntimeModeOrNull(row.verification_runtime_mode),
    targetPrUrl: row.target_pr_url as string | null,
    autoVerifyDisabled: intToBool(row.auto_verify_disabled),
    planMode: intToBool(row.plan_mode),
    planApprovalRequired: intToBool(row.plan_approval_required),
    planAutoReason: (row.plan_auto_reason as string | null) ?? null,
    adoptedExternalPr: intToBool(row.adopted_external_pr),
    initiationMode: parseInitiationMode(row.initiation_mode),
    entrypoint: parseSessionEntrypoint(row.entrypoint),
    scheduledRuleId: (row.scheduled_rule_id as string | null) ?? null,
    ruleNameSnapshot: (row.rule_name_snapshot as string | null) ?? null,
    cronSnapshot: (row.cron_snapshot as string | null) ?? null,
  };
}

export function updateSession(
  sql: SqlStorage,
  sessionId: string,
  updates: Partial<{
    title: string | null;
    status: "active" | "archived";
    closedAt: string | null;
    model: string | null;
    reasoningEffort: string | null;
    updatedAt: string;
  }>,
): void {
  const sets: string[] = [];
  const values: SqlStorageValue[] = [];

  if (updates.title !== undefined) {
    sets.push("title = ?");
    values.push(updates.title);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (updates.closedAt !== undefined) {
    sets.push("closed_at = ?");
    values.push(isoToMs(updates.closedAt));
  }
  if (updates.model !== undefined) {
    sets.push("model = ?");
    values.push(updates.model);
  }
  if (updates.reasoningEffort !== undefined) {
    sets.push("reasoning_effort = ?");
    values.push(updates.reasoningEffort);
  }

  sets.push("updated_at = ?");
  values.push(isoToMs(updates.updatedAt) ?? Date.now());

  values.push(sessionId);
  sql.exec(`UPDATE session SET ${sets.join(", ")} WHERE session_id = ?`, ...values);
}

// ---------------------------------------------------------------------------
// Session extended fields (repo, PR, sandbox coordination, etc.)
// ---------------------------------------------------------------------------

export interface SessionExtendedFields {
  sessionKind?: "repo";
  repoOwner?: string | null;
  repoName?: string | null;
  baseBranch?: string | null;
  startBranch?: string | null;
  lastBranch?: string | null;
  lastCommitSha?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prCreating?: boolean;
  prDraft?: boolean | null;
  prManualReviewReason?: string | null;
  prTitleLastApplied?: string | null;
  ticketKey?: string | null;
  publishStatus?: PublishStatus;
  publishStage?: PublishStage | null;
  publishError?: string | null;
  publishedBranch?: string | null;
  publishAttempt?: number;
  publishSequence?: number;
  installationId?: number | null;
  promptCounter?: number;
  repoPrivate?: boolean | null;
  callbackContext?: CallbackContext | null;
  linearContext?: LinearContext | null;
  githubIssueContext?: GithubIssueContext | null;
  resolvedAgents?: Record<string, AgentConfig> | null;
  agentSessionId?: string | null;
  agentSessionAgent?: string | null;
  agentRuntimeBackend?: AgentRuntimeBackend | null;
  agentRole?: AgentRole | null;
  agentProfile?: string | null;
  harnessKind?: HarnessKind | null;
  runtimeStartupProfile?: RuntimeStartupProfile | null;
  verificationRuntimeMode?: VerificationRuntimeMode | null;
  targetPrUrl?: string | null;
  planMode?: boolean;
  planApprovalRequired?: boolean;
  planAutoReason?: string | null;
  adoptedExternalPr?: boolean;
  publishingStartedAt?: number | null;
  spawnDurationMs?: number | null;
  initiationMode?: InitiationMode;
  entrypoint?: SessionEntrypoint | null;
  scheduledRuleId?: string | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
  reviewListeningActive?: boolean;
  reviewListeningPrUrl?: string | null;
  reviewListeningHeadSha?: string | null;
  reviewListeningEnteredAt?: number | null;
  verificationState?: VerificationState | null;
  verificationResult?: VerificationResult | null;
  verificationNeedsWorkLabel?: VerificationNeedsWorkLabel | null;
  verificationAttemptCount?: number;
  verificationMaxAttempts?: number;
  verificationRunBaseline?: number;
  verificationVerdictHeadSha?: string | null;
}

// Patch semantics intentionally merge reactionMessageTimestamps additively.
// Use addReactionMessageTimestamp for one-at-a-time appends; passing
// reactionMessageTimestamps also appends/dedupes rather than replacing.
type SlackCallbackContext = Extract<CallbackContext, { source: "slack" }>;
type CallbackContextPatch = Partial<SlackCallbackContext> & {
  addReactionMessageTimestamp?: string;
};

type SessionExtendedRead = SessionExtendedFields & { title: string | null; createdAt: string };

type SessionExtendedFieldMapping = {
  key: keyof SessionExtendedFields;
  column: string;
  read: (row: Record<string, SqlStorageValue>) => unknown;
  write?: (value: unknown) => SqlStorageValue;
};

function extendedField<Key extends keyof SessionExtendedFields>(
  key: Key,
  column: string,
  read: (row: Record<string, SqlStorageValue>) => SessionExtendedFields[Key],
  write: (value: SessionExtendedFields[Key]) => SqlStorageValue,
): SessionExtendedFieldMapping {
  return { key, column, read, write: (value) => write(value as SessionExtendedFields[Key]) };
}

function readOnlyExtendedField<Key extends keyof SessionExtendedFields>(
  key: Key,
  column: string,
  read: (row: Record<string, SqlStorageValue>) => SessionExtendedFields[Key],
): SessionExtendedFieldMapping {
  return { key, column, read };
}

export const SESSION_EXTENDED_FIELD_MAPPINGS = [
  extendedField(
    "repoOwner",
    "repo_owner",
    (row) => row.repo_owner as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "repoName",
    "repo_name",
    (row) => row.repo_name as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "baseBranch",
    "base_branch",
    (row) => row.base_branch as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "startBranch",
    "start_branch",
    (row) => row.start_branch as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "lastBranch",
    "last_branch",
    (row) => row.last_branch as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "lastCommitSha",
    "last_commit_sha",
    (row) => row.last_commit_sha as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "prUrl",
    "pr_url",
    (row) => row.pr_url as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "prNumber",
    "pr_number",
    (row) => row.pr_number as number | null,
    (v) => (v as number | null) ?? null,
  ),
  extendedField(
    "prCreating",
    "pr_creating",
    (row) => intToBool(row.pr_creating),
    (v) => boolToInt(v as boolean),
  ),
  extendedField(
    "prDraft",
    "pr_draft",
    (row) => (row.pr_draft == null ? null : intToBool(row.pr_draft)),
    (v) => (v == null ? null : boolToInt(v as boolean)),
  ),
  extendedField(
    "prManualReviewReason",
    "pr_manual_review_reason",
    (row) => row.pr_manual_review_reason as string | null,
    (v) => (v as string | null)?.trim() || null,
  ),
  extendedField(
    "prTitleLastApplied",
    "pr_title_last_applied",
    (row) => row.pr_title_last_applied as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "ticketKey",
    "ticket_key",
    (row) => row.ticket_key as string | null,
    (v) => (v as string | null)?.trim() || null,
  ),
  extendedField(
    "publishStatus",
    "publish_status",
    (row) => (row.publish_status as PublishStatus | null) ?? "not_started",
    (v) => (v as PublishStatus) ?? "not_started",
  ),
  extendedField(
    "publishStage",
    "publish_stage",
    (row) => (row.publish_stage as PublishStage | null) ?? null,
    (v) => (v as PublishStage | null) ?? null,
  ),
  extendedField(
    "publishError",
    "publish_error",
    (row) => row.publish_error as string | null,
    (v) => (v as string | null)?.trim() || null,
  ),
  extendedField(
    "publishedBranch",
    "published_branch",
    (row) => row.published_branch as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "publishAttempt",
    "publish_attempt",
    (row) => (row.publish_attempt as number | null) ?? 0,
    (v) => (v as number) ?? 0,
  ),
  extendedField(
    "publishSequence",
    "publish_sequence",
    (row) => (row.publish_sequence as number | null) ?? 0,
    (v) => (v as number) ?? 0,
  ),
  extendedField(
    "installationId",
    "installation_id",
    (row) => row.installation_id as number | null,
    (v) => (v as number | null) ?? null,
  ),
  extendedField(
    "promptCounter",
    "prompt_counter",
    (row) => (row.prompt_counter as number) ?? 0,
    (v) => (v as number) ?? 0,
  ),
  extendedField(
    "repoPrivate",
    "repo_private",
    (row) => (row.repo_private === null ? null : intToBool(row.repo_private)),
    (v) => (v === null ? null : boolToInt(v as boolean)),
  ),
  extendedField(
    "callbackContext",
    "callback_context_json",
    (row) => parseJsonOrNull<CallbackContext>(row.callback_context_json),
    (v) => jsonOrNull(v),
  ),
  extendedField(
    "linearContext",
    "linear_context_json",
    (row) => parseJsonOrNull<LinearContext>(row.linear_context_json),
    (v) => jsonOrNull(v),
  ),
  extendedField(
    "githubIssueContext",
    "github_issue_context_json",
    (row) => parseJsonOrNull<GithubIssueContext>(row.github_issue_context_json),
    (v) => jsonOrNull(v),
  ),
  extendedField(
    "resolvedAgents",
    "resolved_agents_json",
    (row) => sanitizeResolvedAgents(parseJsonOrNull<Record<string, AgentConfig>>(row.resolved_agents_json)),
    (v) => jsonOrNull(v),
  ),
  extendedField(
    "agentSessionId",
    "agent_session_id",
    (row) => row.agent_session_id as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "agentSessionAgent",
    "agent_session_agent",
    (row) => row.agent_session_agent as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "agentRuntimeBackend",
    "agent_runtime_backend",
    (row) => resolveAgentRuntimeBackend(row.agent_runtime_backend as string | null),
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "agentRole",
    "agent_role",
    (row) => agentRoleFromPersistedValue(row.agent_role),
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "agentProfile",
    "agent_profile",
    (row) => row.agent_profile as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "harnessKind",
    "harness_kind",
    (row) => harnessKindFromPersistedValue(row.harness_kind),
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "runtimeStartupProfile",
    "runtime_startup_profile",
    (row) => runtimeStartupProfileFromPersistedValue(row.runtime_startup_profile),
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "verificationRuntimeMode",
    "verification_runtime_mode",
    (row) => verificationRuntimeModeOrNull(row.verification_runtime_mode),
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "targetPrUrl",
    "target_pr_url",
    (row) => row.target_pr_url as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "planMode",
    "plan_mode",
    (row) => intToBool(row.plan_mode),
    (v) => boolToInt(v as boolean),
  ),
  readOnlyExtendedField("planApprovalRequired", "plan_approval_required", (row) =>
    intToBool(row.plan_approval_required),
  ),
  readOnlyExtendedField("planAutoReason", "plan_auto_reason", (row) => row.plan_auto_reason as string | null),
  extendedField(
    "adoptedExternalPr",
    "adopted_external_pr",
    (row) => intToBool(row.adopted_external_pr),
    (v) => boolToInt(v as boolean),
  ),
  extendedField(
    "publishingStartedAt",
    "publishing_started_at",
    (row) => row.publishing_started_at as number | null,
    (v) => (v as number | null) ?? null,
  ),
  extendedField(
    "spawnDurationMs",
    "spawn_duration_ms",
    (row) => row.spawn_duration_ms as number | null,
    (v) => (v as number | null) ?? null,
  ),
  readOnlyExtendedField("initiationMode", "initiation_mode", (row) => parseInitiationMode(row.initiation_mode)),
  readOnlyExtendedField("entrypoint", "entrypoint", (row) => parseSessionEntrypoint(row.entrypoint)),
  readOnlyExtendedField("scheduledRuleId", "scheduled_rule_id", (row) => row.scheduled_rule_id as string | null),
  readOnlyExtendedField("ruleNameSnapshot", "rule_name_snapshot", (row) => row.rule_name_snapshot as string | null),
  readOnlyExtendedField("cronSnapshot", "cron_snapshot", (row) => row.cron_snapshot as string | null),
  extendedField(
    "reviewListeningActive",
    "review_listening_active",
    (row) => intToBool(row.review_listening_active),
    (v) => boolToInt(v as boolean),
  ),
  extendedField(
    "reviewListeningPrUrl",
    "review_listening_pr_url",
    (row) => row.review_listening_pr_url as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "reviewListeningHeadSha",
    "review_listening_head_sha",
    (row) => row.review_listening_head_sha as string | null,
    (v) => (v as string | null) ?? null,
  ),
  extendedField(
    "reviewListeningEnteredAt",
    "review_listening_entered_at",
    (row) => row.review_listening_entered_at as number | null,
    (v) => (v as number | null) ?? null,
  ),
  extendedField(
    "verificationState",
    "qa_testing_state",
    (row) => readPersistedVerificationState(row),
    (v) => qaTestingStateFromVerificationState(verificationStateOrNull(v)),
  ),
  extendedField(
    "verificationResult",
    "qa_testing_result",
    (row) => readPersistedVerificationValue(row.qa_testing_result, verificationResultOrNull),
    (v) => verificationResultOrNull(v),
  ),
  extendedField(
    "verificationNeedsWorkLabel",
    "qa_testing_needs_work_label",
    (row) => readPersistedVerificationValue(row.qa_testing_needs_work_label, verificationNeedsWorkLabelOrNull),
    (v) => verificationNeedsWorkLabelOrNull(v),
  ),
  extendedField(
    "verificationAttemptCount",
    "qa_testing_attempt_count",
    (row) => readPersistedVerificationValue(row.qa_testing_attempt_count, nonNegativeIntegerOrZero),
    (v) => nonNegativeIntegerOrZero(v),
  ),
  extendedField(
    "verificationMaxAttempts",
    "qa_testing_max_attempts",
    (row) =>
      readPersistedVerificationValue(row.qa_testing_max_attempts, nonNegativeIntegerOrZero) ||
      MAX_VERIFICATION_RUNS_PER_PR,
    (v) => nonNegativeIntegerOrZero(v) || MAX_VERIFICATION_RUNS_PER_PR,
  ),
  extendedField(
    "verificationRunBaseline",
    "qa_testing_run_baseline",
    (row) => readPersistedVerificationValue(row.qa_testing_run_baseline, nonNegativeIntegerOrZero),
    (v) => nonNegativeIntegerOrZero(v),
  ),
  extendedField(
    "verificationVerdictHeadSha",
    "qa_testing_verdict_head_sha",
    (row) => (row.qa_testing_verdict_head_sha as string | null) ?? null,
    (v) => (typeof v === "string" && v.length > 0 ? v : null),
  ),
] satisfies readonly SessionExtendedFieldMapping[];

export function getSessionExtended(sql: SqlStorage, sessionId: string): SessionExtendedRead | null {
  const rows = sql.exec("SELECT * FROM session WHERE session_id = ?", sessionId).toArray();
  if (rows.length === 0) return null;
  const row = rows[0];
  const fields: SessionExtendedFields = {};
  for (const mapping of SESSION_EXTENDED_FIELD_MAPPINGS) {
    fields[mapping.key] = mapping.read(row) as never;
  }
  return {
    title: row.title as string | null,
    createdAt: msToIso(row.created_at as number) ?? new Date().toISOString(),
    ...fields,
    sessionKind: "repo",
  };
}

/**
 * Single source of truth for "which prompt is currently running on this
 * session?". Derived from the prompts table; the previous denormalized
 * pointer (`session.active_prompt_id`) was removed in migration 70 because
 * keeping it in sync across every terminal path was the underlying cause
 * of the archive-leak class of bugs (a forgotten clear left the alarm
 * armed on a closed session). The partial unique index
 * `idx_prompts_one_processing` (migration 69) guarantees at most one row.
 */
export function getActiveProcessingPromptId(sql: SqlStorage, sessionId: string): string | null {
  const rows = sql
    .exec(
      "SELECT prompt_id FROM prompts WHERE session_id = ? AND status = 'processing' ORDER BY started_at DESC, created_at DESC, prompt_id DESC LIMIT 1",
      sessionId,
    )
    .toArray();
  if (rows.length === 0) return null;
  return (rows[0].prompt_id as string | null) ?? null;
}

export function updateSessionFields(sql: SqlStorage, sessionId: string, fields: Partial<SessionExtendedFields>): void {
  const sets: string[] = [];
  const values: SqlStorageValue[] = [];

  for (const mapping of SESSION_EXTENDED_FIELD_MAPPINGS) {
    if (mapping.write && mapping.key in fields) {
      sets.push(`${mapping.column} = ?`);
      values.push(mapping.write(fields[mapping.key] as never));
    }
  }

  if (sets.length === 0) return;

  sets.push("updated_at = ?");
  values.push(Date.now());
  values.push(sessionId);

  sql.exec(`UPDATE session SET ${sets.join(", ")} WHERE session_id = ?`, ...values);
}

export function patchSessionCallbackContext(
  sql: SqlStorage,
  sessionId: string,
  patch: CallbackContextPatch,
): CallbackContext | null {
  const existingContext = getSessionExtended(sql, sessionId)?.callbackContext ?? null;
  if (!existingContext || existingContext.source !== "slack") return null;
  const { addReactionMessageTimestamp, ...fieldPatch } = patch;
  const reactionMessageTimestamps = [
    ...(fieldPatch.reactionMessageTimestamps ?? []),
    ...(addReactionMessageTimestamp ? [addReactionMessageTimestamp] : []),
  ];
  const nextPatch = {
    ...fieldPatch,
    ...(reactionMessageTimestamps.length > 0 ? { reactionMessageTimestamps } : {}),
  };
  const nextContext = { ...existingContext, ...nextPatch };

  const mergedContext = mergeCallbackContextUpdate(existingContext, nextContext);
  updateSessionFields(sql, sessionId, { callbackContext: mergedContext });
  return mergedContext;
}

/**
 * Atomically set `ticket_key` only when the session currently has none. Returns
 * true when this call wrote the key, false when a key was already present — so a
 * concurrent writer (e.g. the async title-LLM `ticket_key` write) wins without
 * being clobbered. The `TRIM() = ''` guard mirrors the empty-string
 * normalization in `updateSessionFields`. Precedence beyond "is ticket_key
 * empty" (linearContext identifier, leading prompt key) is decided by the caller
 * via `resolveSessionTicketKey` before invoking this.
 */
export function setTicketKeyIfAbsent(sql: SqlStorage, sessionId: string, ticketKey: string): boolean {
  const cursor = sql.exec(
    "UPDATE session SET ticket_key = ?, updated_at = ? WHERE session_id = ? AND (ticket_key IS NULL OR TRIM(ticket_key) = '')",
    ticketKey,
    Date.now(),
    sessionId,
  );
  return cursor.rowsWritten > 0;
}

/**
 * Persists a sandbox-supplied branch name as lastBranch only when it is a safe
 * git ref. Sandbox frames cross a trust boundary: the stored value later
 * becomes CHECKOUT_BRANCH, a leading positional to git fetch/checkout on
 * respawn, so an unvalidated name like `--upload-pack=<cmd>` is argument
 * injection. Returns false when the branch was rejected; extraFields are
 * persisted either way.
 */
export function updateSessionBranchFromSandbox(
  sql: SqlStorage,
  sessionId: string,
  branchName: string,
  extraFields: Partial<SessionExtendedFields> = {},
): boolean {
  const safe = isSafeGitRef(branchName);
  const fields = safe ? { ...extraFields, lastBranch: branchName } : extraFields;
  if (Object.keys(fields).length > 0) {
    updateSessionFields(sql, sessionId, fields);
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Prompt row serialization
// ---------------------------------------------------------------------------

export const PROMPT_INSERT_COLUMNS = [
  "prompt_id",
  "session_id",
  "prompt_text",
  "reply_to_text",
  "reply_to_quote_source_json",
  "branch_name_hint",
  "actor_user_id",
  "agent",
  "status",
  "created_at",
  "started_at",
  "completed_at",
  "updated_at",
  "error",
  "result_json",
  "queue_position",
  "skills_json",
  "files_json",
  "uploaded_files_json",
  "uploaded_images_json",
  "plan_context_json",
  "review_loop_epoch_id",
  "review_loop_source_kind",
  "disconnect_retry_count",
  "is_plan_prompt",
] as const;

const PROMPT_INSERT_PLACEHOLDERS = PROMPT_INSERT_COLUMNS.map(() => "?").join(", ");

const PROMPT_CONFLICT_SET = PROMPT_INSERT_COLUMNS.filter((c) => c !== "prompt_id")
  .map((c) => `${c} = excluded.${c}`)
  .join(", ");

export function serializePromptRow(prompt: PromptState, sessionId: string, queuePosition: number): SqlStorageValue[] {
  return [
    prompt.promptId,
    sessionId,
    prompt.prompt,
    prompt.replyToText ?? null,
    jsonOrNull(prompt.replyToQuoteSource),
    prompt.branchNameHint ?? null,
    prompt.actorUserId,
    prompt.agent ?? null,
    prompt.status,
    isoToMs(prompt.createdAt) ?? Date.now(),
    isoToMs(prompt.startedAt),
    isoToMs(prompt.completedAt),
    isoToMs(prompt.updatedAt) ?? Date.now(),
    prompt.error,
    jsonOrNull(prompt.result),
    queuePosition,
    jsonOrNull(prompt.skills),
    jsonOrNull(prompt.files),
    jsonOrNull(prompt.uploadedFiles),
    jsonOrNull(prompt.uploadedImages),
    jsonOrNull(prompt.planContext),
    prompt.reviewLoopEpochId ?? null,
    prompt.reviewLoopSourceKind ?? null,
    prompt.disconnectRetryCount ?? 0,
    boolToInt(prompt.isPlanPrompt ?? false),
  ];
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function getPrompts(sql: SqlStorage, sessionId: string): PromptState[] {
  const rows = sql
    .exec(
      "SELECT * FROM prompts WHERE session_id = ? ORDER BY queue_position ASC, created_at ASC, prompt_id ASC",
      sessionId,
    )
    .toArray();
  return rows.map(promptRowToState);
}

export function getPromptCount(sql: SqlStorage, sessionId: string): number {
  const rows = sql.exec("SELECT COUNT(*) AS count FROM prompts WHERE session_id = ?", sessionId).toArray();
  return (rows[0]?.count as number | null) ?? 0;
}

export function getPromptPage(sql: SqlStorage, sessionId: string, offset: number, limit: number): PromptState[] {
  const rows = sql
    .exec(
      `SELECT * FROM prompts
       WHERE session_id = ?
       ORDER BY queue_position ASC, created_at ASC, prompt_id ASC
       LIMIT ? OFFSET ?`,
      sessionId,
      limit,
      offset,
    )
    .toArray();
  return rows.map(promptRowToState);
}

export function getLatestCompletedPrompt(sql: SqlStorage, sessionId: string): PromptState | null {
  const rows = sql
    .exec(
      `SELECT * FROM prompts
       WHERE session_id = ? AND status = 'completed'
       ORDER BY queue_position DESC, created_at DESC, prompt_id DESC
       LIMIT 1`,
      sessionId,
    )
    .toArray();
  return rows.length > 0 ? promptRowToState(rows[0]) : null;
}

export function getQueuedPromptCount(sql: SqlStorage, sessionId: string): number {
  const rows = sql
    .exec("SELECT COUNT(*) AS count FROM prompts WHERE session_id = ? AND status = 'queued'", sessionId)
    .toArray();
  return (rows[0]?.count as number | null) ?? 0;
}

export function getPrompt(sql: SqlStorage, promptId: string): PromptState | null {
  const rows = sql.exec("SELECT * FROM prompts WHERE prompt_id = ?", promptId).toArray();
  if (rows.length === 0) return null;
  return promptRowToState(rows[0]);
}

export function getPromptHasPendingQuestion(sql: SqlStorage, promptId: string): boolean {
  const rows = sql.exec("SELECT has_pending_question FROM prompts WHERE prompt_id = ?", promptId).toArray();
  return rows.length > 0 && rows[0].has_pending_question === 1;
}

export function updatePrompt(
  sql: SqlStorage,
  promptId: string,
  updates: Partial<{
    status: PromptState["status"];
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
    result: unknown;
    hasPendingQuestion: boolean;
  }>,
): void {
  const sets: string[] = [];
  const values: SqlStorageValue[] = [];

  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (updates.startedAt !== undefined) {
    sets.push("started_at = ?");
    values.push(isoToMs(updates.startedAt));
  }
  if (updates.completedAt !== undefined) {
    sets.push("completed_at = ?");
    values.push(isoToMs(updates.completedAt));
  }
  if (updates.error !== undefined) {
    sets.push("error = ?");
    values.push(updates.error);
  }
  if (updates.result !== undefined) {
    sets.push("result_json = ?");
    values.push(jsonOrNull(updates.result));
  }
  if (updates.hasPendingQuestion !== undefined) {
    sets.push("has_pending_question = ?");
    values.push(boolToInt(updates.hasPendingQuestion));
  }

  if (sets.length === 0) return;

  sets.push("updated_at = ?");
  values.push(Date.now());
  values.push(promptId);

  sql.exec(`UPDATE prompts SET ${sets.join(", ")} WHERE prompt_id = ?`, ...values);
}

/**
 * Push outcome reported on the `post_execution` event (ARC-876). Persisted on
 * the prompt row so the shared publish gate (isPromptPublishable) can read it
 * without resubscribing to the original event.
 */
type PromptPushStatus = "succeeded" | "failed" | "unknown";

export interface PromptPushOutcome {
  pushStatus: PromptPushStatus;
  pushError: string | null;
}

type PromptStateWithPushOutcome = PromptState & { pushOutcome: PromptPushOutcome | null };

export function updatePromptPushOutcome(sql: SqlStorage, promptId: string, outcome: PromptPushOutcome): void {
  sql.exec(
    "UPDATE prompts SET push_status = ?, push_error = ?, updated_at = ? WHERE prompt_id = ?",
    outcome.pushStatus,
    outcome.pushError,
    Date.now(),
    promptId,
  );
}

export function getPromptPushOutcome(sql: SqlStorage, promptId: string): PromptPushOutcome | null {
  const rows = sql.exec("SELECT push_status, push_error FROM prompts WHERE prompt_id = ?", promptId).toArray();
  if (rows.length === 0) return null;
  return promptPushOutcomeFromRow(rows[0]);
}

export function getPromptsWithPushOutcomes(sql: SqlStorage, sessionId: string): PromptStateWithPushOutcome[] {
  const rows = sql
    .exec(
      "SELECT * FROM prompts WHERE session_id = ? ORDER BY queue_position ASC, created_at ASC, prompt_id ASC",
      sessionId,
    )
    .toArray();
  return rows.map((row) => ({
    ...promptRowToState(row),
    pushOutcome: promptPushOutcomeFromRow(row),
  }));
}

function promptPushOutcomeFromRow(row: Record<string, SqlStorageValue>): PromptPushOutcome | null {
  const status = row.push_status as string | null;
  if (status !== "succeeded" && status !== "failed" && status !== "unknown") return null;
  return {
    pushStatus: status,
    pushError: (row.push_error as string | null) ?? null,
  };
}

export function bulkUpdatePrompts(sql: SqlStorage, sessionId: string, prompts: PromptState[]): void {
  for (const [index, prompt] of prompts.entries()) {
    sql.exec(
      `INSERT INTO prompts (${PROMPT_INSERT_COLUMNS.join(", ")}) VALUES (${PROMPT_INSERT_PLACEHOLDERS})
      ON CONFLICT(prompt_id) DO UPDATE SET ${PROMPT_CONFLICT_SET}`,
      ...serializePromptRow(prompt, sessionId, index),
    );
  }
}

function promptRowToState(row: Record<string, SqlStorageValue>): PromptState {
  const uploadedFiles = parseJsonOrNull<PromptState["uploadedFiles"]>(row.uploaded_files_json);
  const uploadedImages = parseJsonOrNull<PromptState["uploadedImages"]>(row.uploaded_images_json);
  const files = parseJsonOrNull<string[]>(row.files_json);
  const skills = parseStringArrayOrNull(row.skills_json);
  const planContext = parseJsonOrNull<PlanContext>(row.plan_context_json);
  const reviewLoopSourceKind = row.review_loop_source_kind;

  return {
    promptId: row.prompt_id as string,
    prompt: row.prompt_text as string,
    replyToText: (row.reply_to_text as string | null) ?? null,
    replyToQuoteSource: parseSlackQuotedReplySource(parseJsonOrNull(row.reply_to_quote_source_json)),
    branchNameHint: (row.branch_name_hint as string | null) ?? undefined,
    actorUserId: row.actor_user_id as string | null,
    agent: row.agent == null ? undefined : (row.agent as string),
    status: row.status as PromptState["status"],
    createdAt: msToIso(row.created_at as number) ?? new Date().toISOString(),
    startedAt: msToIso(row.started_at as number | null),
    completedAt: msToIso(row.completed_at as number | null),
    updatedAt: msToIso(row.updated_at as number) ?? new Date().toISOString(),
    error: row.error as string | null,
    result: parseJsonOrNull(row.result_json),
    disconnectRetryCount: (row.disconnect_retry_count as number | null) ?? 0,
    ...(intToBool(row.is_plan_prompt) ? { isPlanPrompt: true } : {}),
    ...(skills?.length ? { skills } : {}),
    ...(files?.length ? { files } : {}),
    ...(uploadedFiles?.length ? { uploadedFiles } : {}),
    ...(uploadedImages?.length ? { uploadedImages } : {}),
    ...(planContext ? { planContext } : {}),
    ...(typeof row.review_loop_epoch_id === "string" && row.review_loop_epoch_id
      ? { reviewLoopEpochId: row.review_loop_epoch_id }
      : {}),
    ...(isReviewLoopPromptSourceKind(reviewLoopSourceKind) ? { reviewLoopSourceKind } : {}),
  };
}

function isReviewLoopPromptSourceKind(value: unknown): value is ReviewLoopPromptSourceKind {
  return value === "bot" || value === "human" || value === "mixed" || value === "merge_conflict";
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function normalizeFinalAnswerText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
}

function hasDurableFinalAnswerText(sql: SqlStorage, sessionId: string, promptId: string, finalText: unknown): boolean {
  const target = normalizeFinalAnswerText(finalText);
  if (!target) return true;

  const textByPartId = new Map<string, string>();
  for (const event of getEvents(sql, sessionId, { promptId })) {
    if (event.type !== "text") continue;
    if (event.data.finalAnswer === true) continue;
    const partId = typeof event.data.id === "string" && event.data.id.length > 0 ? event.data.id : event.id;
    const delta = typeof event.data.text === "string" ? event.data.text : "";
    if (!delta) continue;
    textByPartId.set(partId, `${textByPartId.get(partId) ?? ""}${delta}`);
  }

  for (const text of textByPartId.values()) {
    if (normalizeFinalAnswerText(text) === target) return true;
  }

  const joined = [...textByPartId.values()]
    .map((text) => normalizeFinalAnswerText(text))
    .filter(Boolean)
    .join("\n\n");
  return joined === target;
}

function appendEventsInternal(
  sql: SqlStorage,
  sessionId: string,
  entries: DurableEntry[],
  promptId?: string,
): { newEvents: SessionEvent[]; newReplayEvents: SessionReplayEvent[] } {
  if (entries.length === 0) return { newEvents: [], newReplayEvents: [] };

  // Get current max sequence
  const maxRow = sql.exec("SELECT MAX(sequence) as max_seq FROM events WHERE session_id = ?", sessionId).toArray();
  let sequence = (maxRow[0]?.max_seq as number) ?? 0;

  const newEvents: SessionEvent[] = [];
  const newReplayEvents: SessionReplayEvent[] = [];

  for (const entry of entries) {
    const now = Date.now();
    const explicitEventId = typeof entry.eventId === "string" && entry.eventId.length > 0 ? entry.eventId : null;
    const data = { ...(entry.data || {}) };

    if ("transportEvent" in entry) {
      const transportEvent = entry.transportEvent;
      const dataPromptId = typeof data.promptId === "string" && data.promptId.length > 0 ? data.promptId : null;
      const transportPromptId =
        typeof transportEvent.promptId === "string" && transportEvent.promptId.length > 0
          ? transportEvent.promptId
          : null;
      const eventPromptId = transportPromptId ?? promptId ?? dataPromptId;
      const eventTimestamp = new Date(transportEvent.timestampMs).toISOString();
      if (
        entry.type === "text" &&
        data.finalAnswer === true &&
        eventPromptId &&
        hasDurableFinalAnswerText(sql, sessionId, eventPromptId, data.text)
      ) {
        continue;
      }

      while (true) {
        sequence += 1;
        const eventId = explicitEventId ?? `event-${sequence}`;
        const result = sql.exec(
          `INSERT OR IGNORE INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'cycloid_transport')`,
          sequence,
          eventId,
          sessionId,
          eventPromptId,
          transportEvent.phase,
          transportEvent.timestampMs,
          encodeCycloidEvent(transportEvent),
        );
        if (getRowsWritten(result) === 0) {
          if (explicitEventId) sequence -= 1;
          if (explicitEventId) break;
          continue;
        }

        newEvents.push({
          sequence,
          id: eventId,
          type: entry.type,
          timestamp: eventTimestamp,
          data:
            eventPromptId && (data.promptId === undefined || data.promptId === "")
              ? { ...data, promptId: eventPromptId }
              : data,
        });
        newReplayEvents.push({
          ...transportEvent,
          ...(eventPromptId && !transportPromptId ? { promptId: eventPromptId } : {}),
          sequence,
        });
        break;
      }
      continue;
    }

    const eventPromptId =
      typeof data.promptId === "string" && data.promptId.length > 0 ? data.promptId : (promptId ?? null);
    if (eventPromptId && (data.promptId === undefined || data.promptId === "")) {
      data.promptId = eventPromptId;
    }
    const eventTimestamp = entry.timestamp || new Date(now).toISOString();
    if (
      entry.type === "text" &&
      data.finalAnswer === true &&
      eventPromptId &&
      hasDurableFinalAnswerText(sql, sessionId, eventPromptId, data.text)
    ) {
      continue;
    }

    while (true) {
      sequence += 1;
      const eventId = explicitEventId ?? `event-${sequence}`;
      const result = sql.exec(
        `INSERT OR IGNORE INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
        sequence,
        eventId,
        sessionId,
        eventPromptId,
        entry.type,
        isoToMs(eventTimestamp) ?? now,
        JSON.stringify(data),
      );
      if (getRowsWritten(result) === 0) {
        if (explicitEventId) sequence -= 1;
        if (explicitEventId) break;
        continue;
      }

      newEvents.push({
        sequence,
        id: eventId,
        type: entry.type,
        timestamp: eventTimestamp,
        data,
      });
      newReplayEvents.push({
        sequence,
        type: entry.type,
        data,
      });
      break;
    }
  }

  return { newEvents, newReplayEvents };
}

export function appendEventsWithReplay(
  sql: SqlStorage,
  sessionId: string,
  entries: DurableEntry[],
  promptId?: string,
): { newEvents: SessionEvent[]; newReplayEvents: SessionReplayEvent[] } {
  return appendEventsInternal(sql, sessionId, entries, promptId);
}

function collectReplayEvents(
  sql: SqlStorage,
  query: { where: string; args: SqlStorageValue[]; order: "ASC" | "DESC" },
  limit: number,
  extraReplayEvents = 0,
): { events: SessionReplayEvent[]; hasMore: boolean } {
  if (limit <= 0) {
    return { events: [], hasMore: false };
  }

  const targetCount = limit + Math.max(extraReplayEvents, 0);
  const batchSize = Math.max(targetCount + Math.ceil(targetCount * 0.1) + 50, 50);
  const collected: SessionReplayEvent[] = [];
  let offset = 0;

  while (collected.length < targetCount) {
    const rows = sql
      .exec(
        `SELECT * FROM events WHERE ${query.where} ORDER BY sequence ${query.order} LIMIT ? OFFSET ?`,
        ...query.args,
        batchSize,
        offset,
      )
      .toArray() as Array<Record<string, SqlStorageValue>>;

    if (rows.length === 0) break;
    offset += rows.length;

    for (const row of rows) {
      const event = eventRowToReplayEvent(row);
      if (!event) continue;
      collected.push(event);
      if (collected.length >= targetCount) break;
    }

    if (rows.length < batchSize) break;
  }

  const hasMore = collected.length > limit;
  const events = collected.slice(0, limit);
  return {
    events: query.order === "DESC" ? events.reverse() : events,
    hasMore,
  };
}

const REPLAY_EXCLUDED_EVENT_TYPES = new Set([
  HEARTBEAT_EVENT_TYPE,
  PROMPT_HEARTBEAT_EVENT_TYPE,
  SANDBOX_HEARTBEAT_EVENT_TYPE,
]);

function isReplayExcludedEventType(type: unknown): boolean {
  return typeof type === "string" && REPLAY_EXCLUDED_EVENT_TYPES.has(type);
}

export function getEvents(
  sql: SqlStorage,
  sessionId: string,
  options?: { afterSequence?: number; limit?: number; promptId?: string },
): SessionEvent[] {
  const afterSeq = options?.afterSequence ?? 0;
  const where = options?.promptId
    ? "session_id = ? AND prompt_id = ? AND sequence > ?"
    : "session_id = ? AND sequence > ?";
  const args: SqlStorageValue[] = options?.promptId ? [sessionId, options.promptId, afterSeq] : [sessionId, afterSeq];
  let query = `SELECT * FROM events WHERE ${where} ORDER BY sequence ASC`;

  if (options?.limit != null && options.limit > 0) {
    query += " LIMIT ?";
    args.push(options.limit);
  }

  const rows = sql.exec(query, ...args).toArray();
  return rows.map(eventRowToSessionEvent).filter((event): event is SessionEvent => event !== null);
}

export function getReplayEvents(
  sql: SqlStorage,
  sessionId: string,
  options?: { afterSequence?: number; limit?: number; promptId?: string },
): SessionReplayEvent[] {
  const afterSeq = options?.afterSequence ?? 0;
  const where = options?.promptId
    ? "session_id = ? AND prompt_id = ? AND sequence > ?"
    : "session_id = ? AND sequence > ?";
  const args: SqlStorageValue[] = options?.promptId ? [sessionId, options.promptId, afterSeq] : [sessionId, afterSeq];

  if (options?.limit != null && options.limit > 0) {
    return collectReplayEvents(sql, { where, args, order: "ASC" }, options.limit).events;
  }

  const rows = sql.exec(`SELECT * FROM events WHERE ${where} ORDER BY sequence ASC`, ...args).toArray();
  return rows.map(eventRowToReplayEvent).filter((event): event is SessionReplayEvent => event !== null);
}

export function getReplayEventsTail(
  sql: SqlStorage,
  sessionId: string,
  promptId: string,
  limit: number,
): { events: SessionReplayEvent[]; hasMore: boolean } {
  return collectReplayEvents(
    sql,
    { where: "session_id = ? AND prompt_id = ?", args: [sessionId, promptId], order: "DESC" },
    limit,
  );
}

export function getLatestSessionCloseReason(sql: SqlStorage, sessionId: string): string | null {
  const rows = sql
    .exec(
      "SELECT data_json FROM events WHERE session_id = ? AND type = 'session_closed' ORDER BY sequence DESC LIMIT 1",
      sessionId,
    )
    .toArray();
  if (rows.length === 0) return null;
  const data = parseJsonOrNull<Record<string, unknown>>(rows[0]?.data_json);
  return typeof data?.reason === "string" ? data.reason : null;
}

export function getLastEventSequence(sql: SqlStorage, sessionId: string): number {
  const rows = sql.exec("SELECT MAX(sequence) as max_seq FROM events WHERE session_id = ?", sessionId).toArray();
  return (rows[0]?.max_seq as number) ?? 0;
}

export function getReplayState(sql: SqlStorage, sessionId: string): ReplayState {
  const lastSeq = getLastEventSequence(sql, sessionId);
  const lastRow =
    lastSeq > 0
      ? sql.exec("SELECT created_at FROM events WHERE session_id = ? AND sequence = ?", sessionId, lastSeq).toArray()
      : [];
  const lastTimestamp = lastRow.length > 0 ? msToIso(lastRow[0].created_at as number) : null;

  return {
    sessionId,
    lastEventSequence: lastSeq,
    lastEventTimestamp: lastTimestamp,
    updatedAt: lastTimestamp ?? new Date().toISOString(),
  };
}

export function getReplayWindowEvents(
  sql: SqlStorage,
  sessionId: string,
  afterSequence: number,
  maxEvents = REPLAY_WINDOW_SIZE,
): { afterSequence: number; events: SessionReplayEvent[]; truncated: boolean; droppedCount: number } {
  const normalizedAfterSequence = Number.isFinite(afterSequence) && afterSequence > 0 ? Math.floor(afterSequence) : 0;

  const { events, hasMore } = collectReplayEvents(
    sql,
    {
      where: "session_id = ? AND sequence > ?",
      args: [sessionId, normalizedAfterSequence],
      order: "DESC",
    },
    maxEvents,
    1,
  );

  return {
    afterSequence: normalizedAfterSequence,
    events,
    truncated: hasMore,
    droppedCount: hasMore ? 1 : 0,
  };
}
export function getReplayEventsBeforeSequence(
  sql: SqlStorage,
  sessionId: string,
  beforeSequence: number,
  limit: number,
): { events: SessionReplayEvent[]; hasEvents: boolean; hasMore: boolean } {
  const { events, hasMore } = collectReplayEvents(
    sql,
    {
      where: "session_id = ? AND sequence < ?",
      args: [sessionId, beforeSequence],
      order: "DESC",
    },
    limit,
    1,
  );

  return {
    events,
    hasEvents: events.length > 0,
    hasMore,
  };
}

function eventRowToSessionEvent(row: Record<string, SqlStorageValue>): SessionEvent | null {
  if (row.delivery_class === "cycloid_transport") {
    const encodedEvent = typeof row.data_json === "string" ? row.data_json : null;
    if (!encodedEvent) return null;
    const timestamp = msToIso(row.created_at as number) ?? new Date().toISOString();
    const transportEvent = (() => {
      try {
        return decodeCycloidEvent(encodedEvent);
      } catch {
        return null;
      }
    })();
    if (!transportEvent) return null;
    return projectStoredCycloidEventToSessionEvent(
      {
        sequence: row.sequence as number,
        eventId: row.event_id as string,
        timestamp,
      },
      transportEvent,
    );
  }

  return {
    sequence: row.sequence as number,
    id: row.event_id as string,
    type: row.type as string,
    timestamp: msToIso(row.created_at as number) ?? new Date().toISOString(),
    data: parseJsonOrNull<Record<string, unknown>>(row.data_json) ?? {},
  };
}

function eventRowToReplayEvent(row: Record<string, SqlStorageValue>): SessionReplayEvent | null {
  if (isReplayExcludedEventType(row.type)) {
    return null;
  }
  if (row.delivery_class === "cycloid_transport") {
    const encodedEvent = typeof row.data_json === "string" ? row.data_json : null;
    if (!encodedEvent) return null;
    try {
      const decoded = decodeCycloidEvent(encodedEvent);
      const bridgeEventType =
        typeof decoded.payload === "object" &&
        decoded.payload !== null &&
        !Array.isArray(decoded.payload) &&
        typeof decoded.payload.bridgeEventType === "string"
          ? decoded.payload.bridgeEventType
          : undefined;
      if (decoded.phase === "bridge.connect" || isReplayExcludedEventType(bridgeEventType)) {
        return null;
      }
      const rowPromptId = typeof row.prompt_id === "string" && row.prompt_id.length > 0 ? row.prompt_id : undefined;
      return {
        ...decoded,
        ...(rowPromptId && !decoded.promptId ? { promptId: rowPromptId } : {}),
        sequence: row.sequence as number,
      };
    } catch {
      return null;
    }
  }

  const data = parseJsonOrNull<Record<string, unknown>>(row.data_json) ?? {};
  const rowTimestamp = msToIso(row.created_at as number);
  const hasEmbeddedTimestamp = typeof data.timestamp === "string" && data.timestamp.length > 0;

  return {
    sequence: row.sequence as number,
    type: row.type as string,
    data: rowTimestamp && !hasEmbeddedTimestamp ? { ...data, timestamp: rowTimestamp } : data,
  };
}

// ---------------------------------------------------------------------------
// Platform LLM capabilities
// ---------------------------------------------------------------------------

interface InsertPlatformLlmCapabilityParams {
  idHash: string;
  sessionId: string;
  sandboxId: string;
  promptId: string;
  callType: PlatformLlmCallType;
  phase: PlatformLlmPhase;
  expiresAt: number;
  createdAt: number;
}

export type PlatformLlmPromptStatus = "executing" | "post_execution_pending" | "terminal";

interface PlatformLlmPromptStatusRecord {
  promptId: string;
  sessionId: string;
  status: PlatformLlmPromptStatus;
  updatedAt: number;
  // Wall-clock instant the current `status` was entered. Used by the
  // post-execution watchdog (ARC-876) to identify the exact pending instance:
  // the alarm CAS-checks `started_at` to know whether the slot it armed is
  // still the one in flight, or whether the phase has cleared / re-armed.
  startedAt: number | null;
}

type ConsumePlatformLlmCapabilityResult =
  | { ok: true; record: PlatformLlmCapabilityRecord; budgetUsed: number }
  | { ok: false; category: PlatformLlmFailureCategory };

interface ConsumePlatformLlmCapabilityParams {
  idHash: string;
  sessionId: string;
  sandboxId: string;
  callType: PlatformLlmCallType;
  phase: PlatformLlmPhase;
  now: number;
  perPromptBudget: number;
}

function getRowsWritten(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): number {
  return typeof cursor.rowsWritten === "number" ? cursor.rowsWritten : 0;
}

function platformLlmCapabilityRowToRecord(row: Record<string, SqlStorageValue>): PlatformLlmCapabilityRecord {
  return {
    idHash: row.id_hash as string,
    sessionId: row.session_id as string,
    sandboxId: row.sandbox_id as string,
    promptId: row.prompt_id as string,
    callType: row.call_type as PlatformLlmCallType,
    phase: row.phase as PlatformLlmPhase,
    expiresAt: (row.expires_at as number) ?? 0,
    usedAt: (row.used_at as number | null) ?? null,
    createdAt: (row.created_at as number) ?? 0,
  };
}

export function insertPlatformLlmCapability(sql: SqlStorage, params: InsertPlatformLlmCapabilityParams): void {
  sql.exec(
    `INSERT INTO platform_llm_capabilities (
      id_hash, session_id, sandbox_id, prompt_id, call_type, phase, expires_at, used_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    params.idHash,
    params.sessionId,
    params.sandboxId,
    params.promptId,
    params.callType,
    params.phase,
    params.expiresAt,
    params.createdAt,
  );
}

export function getPlatformLlmCapability(sql: SqlStorage, idHash: string): PlatformLlmCapabilityRecord | null {
  const rows = sql.exec("SELECT * FROM platform_llm_capabilities WHERE id_hash = ?", idHash).toArray();
  return rows.length > 0 ? platformLlmCapabilityRowToRecord(rows[0]) : null;
}

export function getPlatformLlmBudgetUsed(sql: SqlStorage, promptId: string, callType: PlatformLlmCallType): number {
  const rows = sql
    .exec("SELECT used FROM platform_llm_budget WHERE prompt_id = ? AND call_type = ?", promptId, callType)
    .toArray();
  const used = rows[0]?.used;
  return typeof used === "number" && Number.isFinite(used) ? used : 0;
}

function platformLlmPromptStatusRowToRecord(row: Record<string, SqlStorageValue>): PlatformLlmPromptStatusRecord {
  return {
    promptId: row.prompt_id as string,
    sessionId: row.session_id as string,
    status: row.status as PlatformLlmPromptStatus,
    updatedAt: (row.updated_at as number) ?? 0,
    startedAt: (row.started_at as number | null) ?? null,
  };
}

export function upsertPlatformLlmPromptStatus(
  sql: SqlStorage,
  params: {
    promptId: string;
    sessionId: string;
    status: PlatformLlmPromptStatus;
    updatedAt: number;
    startedAt?: number | null;
  },
): void {
  sql.exec(
    `INSERT INTO platform_llm_prompt_status (prompt_id, session_id, status, updated_at, started_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(prompt_id) DO UPDATE SET
       session_id = excluded.session_id,
       status = excluded.status,
       updated_at = excluded.updated_at,
       started_at = excluded.started_at`,
    params.promptId,
    params.sessionId,
    params.status,
    params.updatedAt,
    params.startedAt ?? null,
  );
}

export type CasPlatformLlmPromptStatusResult =
  { accepted: true } | { accepted: false; reason: "stale_prior"; observedStatus: PlatformLlmPromptStatus | null };

/**
 * Compare-and-swap upsert for platform_llm_prompt_status. Reads the current
 * row in the same DO request handler (DO SQLite is single-writer per DO, so
 * the read-compare-write is atomic), refuses the write when the prior status
 * is outside the expected set, and only then writes.
 *
 * `expectedPriorStatuses === "new"` means the row must not exist yet; any
 * existing row is rejected as stale.
 *
 * `allowNewRow` (default false): when the expected prior set is an array but
 * the row does not exist, the write is accepted instead of rejected. Used by
 * skip-executing transitions where a prompt path that did not call
 * attachPlatformLlmCapabilities still needs to land directly in
 * post_execution_pending or terminal.
 *
 * Used by the post-execution alarm path and the canonical mark helper to
 * prevent stale callbacks from clearing `started_at` after the row has
 * already moved to terminal.
 */
export function casUpsertPlatformLlmPromptStatus(
  sql: SqlStorage,
  params: {
    promptId: string;
    sessionId: string;
    status: PlatformLlmPromptStatus;
    updatedAt: number;
    startedAt?: number | null;
    expectedPriorStatuses: PlatformLlmPromptStatus[] | "new";
    allowNewRow?: boolean;
  },
): CasPlatformLlmPromptStatusResult {
  const existing = sql
    .exec("SELECT status FROM platform_llm_prompt_status WHERE prompt_id = ?", params.promptId)
    .toArray();
  const observedStatus = (existing[0]?.status as PlatformLlmPromptStatus | undefined) ?? null;
  if (params.expectedPriorStatuses === "new") {
    if (observedStatus !== null) {
      return { accepted: false, reason: "stale_prior", observedStatus };
    }
  } else if (observedStatus === null) {
    if (!params.allowNewRow) {
      return { accepted: false, reason: "stale_prior", observedStatus };
    }
    // fall through to insert
  } else if (!params.expectedPriorStatuses.includes(observedStatus)) {
    return { accepted: false, reason: "stale_prior", observedStatus };
  }
  upsertPlatformLlmPromptStatus(sql, params);
  return { accepted: true };
}

/**
 * Clears `started_at` for non-terminal rows in a session. The pre-CAS
 * implementation in disarmLifecycleWatchdogs ran `UPDATE ... WHERE
 * started_at IS NOT NULL`, which could race with an alarm callback marking
 * the row terminal — this version excludes terminal rows so a late disarm
 * cannot re-arm a watchdog that fired and completed.
 *
 * Returns the number of rows whose started_at was cleared.
 */
export function casDisarmLifecycleWatchdog(
  sql: SqlStorage,
  params: { sessionId: string; updatedAt: number },
): { clearedCount: number } {
  const result = sql.exec(
    `UPDATE platform_llm_prompt_status
       SET started_at = NULL, updated_at = ?
       WHERE session_id = ?
         AND started_at IS NOT NULL
         AND status != 'terminal'`,
    params.updatedAt,
    params.sessionId,
  );
  return { clearedCount: result.rowsWritten ?? 0 };
}

export function getPlatformLlmPromptStatus(sql: SqlStorage, promptId: string): PlatformLlmPromptStatusRecord | null {
  const rows = sql.exec("SELECT * FROM platform_llm_prompt_status WHERE prompt_id = ?", promptId).toArray();
  return rows.length > 0 ? platformLlmPromptStatusRowToRecord(rows[0]) : null;
}

/**
 * All prompts currently in `post_execution_pending` for this session, with the
 * wall-clock `startedAt` the watchdog was armed with. The alarm scheduler uses
 * this to pick the soonest pending deadline across overlapping prompts.
 */
export function getPlatformLlmPromptStatusesPending(
  sql: SqlStorage,
  sessionId: string,
): PlatformLlmPromptStatusRecord[] {
  const rows = sql
    .exec(
      "SELECT * FROM platform_llm_prompt_status WHERE session_id = ? AND status = ?",
      sessionId,
      "post_execution_pending",
    )
    .toArray();
  return rows.map(platformLlmPromptStatusRowToRecord);
}

export function incrementPlatformLlmBudget(
  sql: SqlStorage,
  promptId: string,
  callType: PlatformLlmCallType,
  increment = 1,
): number {
  sql.exec(
    `INSERT INTO platform_llm_budget (prompt_id, call_type, used)
     VALUES (?, ?, ?)
     ON CONFLICT(prompt_id, call_type) DO UPDATE SET used = used + excluded.used`,
    promptId,
    callType,
    increment,
  );
  return getPlatformLlmBudgetUsed(sql, promptId, callType);
}

/**
 * Must run inside DurableObjectStorage.transactionSync() so the capability
 * update and budget increment commit or roll back together.
 */
export function consumePlatformLlmCapability(
  sql: SqlStorage,
  params: ConsumePlatformLlmCapabilityParams,
): ConsumePlatformLlmCapabilityResult {
  const update = sql.exec(
    `UPDATE platform_llm_capabilities
     SET used_at = ?
     WHERE id_hash = ?
       AND session_id = ?
       AND used_at IS NULL
       AND expires_at > ?
       AND sandbox_id = ?
       AND phase = ?
       AND call_type = ?
       AND COALESCE((
         SELECT used
         FROM platform_llm_budget
         WHERE prompt_id = platform_llm_capabilities.prompt_id
           AND call_type = platform_llm_capabilities.call_type
       ), 0) < ?`,
    params.now,
    params.idHash,
    params.sessionId,
    params.now,
    params.sandboxId,
    params.phase,
    params.callType,
    params.perPromptBudget,
  );

  if (getRowsWritten(update) === 1) {
    const record = getPlatformLlmCapability(sql, params.idHash);
    if (!record) throw new Error("Consumed platform LLM capability row disappeared");
    const budgetUsed = incrementPlatformLlmBudget(sql, record.promptId, record.callType);
    return { ok: true, record, budgetUsed };
  }

  const record = getPlatformLlmCapability(sql, params.idHash);
  if (!record || record.sessionId !== params.sessionId || record.sandboxId !== params.sandboxId) {
    return { ok: false, category: "capability_invalid" };
  }
  if (record.usedAt !== null) {
    return { ok: false, category: "capability_consumed" };
  }
  if (record.expiresAt <= params.now) {
    return { ok: false, category: "capability_expired" };
  }
  if (record.phase !== params.phase) {
    return { ok: false, category: "wrong_phase" };
  }
  if (record.callType !== params.callType) {
    return { ok: false, category: "wrong_call_type" };
  }
  if (getPlatformLlmBudgetUsed(sql, record.promptId, record.callType) >= params.perPromptBudget) {
    return { ok: false, category: "budget_exhausted" };
  }

  return { ok: false, category: "capability_invalid" };
}

export function revokePromptCapabilities(sql: SqlStorage, promptId: string, now: number, sessionId: string): number {
  const cursor = sql.exec(
    `UPDATE platform_llm_capabilities
     SET used_at = ?
     WHERE prompt_id = ? AND session_id = ? AND used_at IS NULL`,
    now,
    promptId,
    sessionId,
  );
  return getRowsWritten(cursor);
}

export function purgeExpiredCapabilities(sql: SqlStorage, now: number): number {
  const cursor = sql.exec("DELETE FROM platform_llm_capabilities WHERE expires_at <= ?", now);
  return getRowsWritten(cursor);
}

// ---------------------------------------------------------------------------
// Sandbox state
// ---------------------------------------------------------------------------

export interface SandboxStateRow {
  sandboxId?: string | null;
  modalObjectId?: string | null;
  status: string;
  lastHeartbeatAt?: number | null;
  lastActivityAt?: number | null;
  disconnectStartedAt?: number | null;
  autoCloseScheduledAt?: number | null;
  snapshotImageId?: string | null;
  snapshotBranch?: string | null;
  snapshotHeadSha?: string | null;
  snapshotCreatedAt?: number | null;
  snapshotCredentialEnvKeys?: string[] | null;
  snapshotCredentialFingerprints?: string[] | null;
  snapshotModalWorkspace?: string | null;
  snapshotModalEnvironment?: string | null;
  snapshotSandboxImageVersion?: string | null;
  snapshotDockerEnabled?: boolean | null;
  lastSnapshotError?: string | null;
  spawnRetryCount: number;
  pendingPromptDispatch: boolean;
  sandboxAuthTokenHash?: string | null;
  /** @deprecated superseded by prevSandboxAuthTokenHashes (N-generation overlap). */
  prevSandboxAuthTokenHash?: string | null;
  /** @deprecated superseded by prevSandboxAuthTokenHashes (N-generation overlap). */
  prevSandboxAuthTokenExpiresAt?: number | null;
  /** JSON array of {hash, expiresAt} prior auth-token generations, newest-first. */
  prevSandboxAuthTokenHashes?: string | null;
  spawnStartedAt?: number | null;
  lastSpawnAttemptId?: string | null;
  promptLastActivityAt?: number | null;
  intentionalPauseReason?: SandboxIdlePauseReason | null;
  bridgeProtocolVersion?: number | null;
  stopReason?: SandboxStopReason | null;
  runtimeProvider?: SandboxRuntimeProvider | null;
  runtimeBackend?: SandboxRuntimeBackend | null;
  runtimeState?: SandboxRuntimeState | null;
  runtimeSandboxId?: string | null;
  runtimeTemplateId?: string | null;
  runtimeStateExpiresAt?: number | null;
  runtimeLiveLeaseExpiresAt?: number | null;
  runtimePreviewUrl?: string | null;
  runtimeCreatedAt?: number | null;
  runtimeLastResumedAt?: number | null;
  runtimeLastPausedAt?: number | null;
  runtimeLastProviderRefreshedAt?: number | null;
  runtimeProviderTtlExpiresAt?: number | null;
}

/**
 * Why the sandbox transitioned to status="stopped".
 *
 * `"user"` blocks auto-resume on the next prompt; everything else (including
 * `null` for legacy rows) is treated as auto-resumable so a follow-up prompt
 * cold-spawns a fresh sandbox.
 */
export type SandboxStopReason = "user" | "reaped" | "spawn_failed";

export function ensureSandboxState(sql: SqlStorage, sessionId: string): void {
  sql.exec(
    `INSERT OR IGNORE INTO sandbox_state (session_id, status, spawn_retry_count, pending_prompt_dispatch)
     VALUES (?, 'idle', 0, 0)`,
    sessionId,
  );
}

export function getSandboxState(sql: SqlStorage, sessionId: string): SandboxStateRow | null {
  const rows = sql.exec("SELECT * FROM sandbox_state WHERE session_id = ?", sessionId).toArray();
  if (rows.length === 0) return null;
  return sandboxRowToState(rows[0]);
}

export function updateSandboxState(sql: SqlStorage, sessionId: string, updates: Partial<SandboxStateRow>): void {
  const sets: string[] = [];
  const values: SqlStorageValue[] = [];

  const mapping: Array<[keyof SandboxStateRow, string, (v: unknown) => SqlStorageValue]> = [
    ["sandboxId", "sandbox_id", (v) => (v as string | null) ?? null],
    ["modalObjectId", "modal_object_id", (v) => (v as string | null) ?? null],
    ["status", "status", (v) => v as string],
    ["lastHeartbeatAt", "last_heartbeat_at", (v) => (v as number | null) ?? null],
    ["lastActivityAt", "last_activity_at", (v) => (v as number | null) ?? null],
    ["disconnectStartedAt", "disconnect_started_at", (v) => (v as number | null) ?? null],
    ["autoCloseScheduledAt", "auto_close_scheduled_at", (v) => (v as number | null) ?? null],
    ["snapshotImageId", "snapshot_image_id", (v) => (v as string | null) ?? null],
    ["snapshotBranch", "snapshot_branch", (v) => (v as string | null) ?? null],
    ["snapshotHeadSha", "snapshot_head_sha", (v) => (v as string | null) ?? null],
    ["snapshotCreatedAt", "snapshot_created_at", (v) => (v as number | null) ?? null],
    ["snapshotCredentialEnvKeys", "snapshot_credential_env_keys_json", (v) => jsonOrNull(v)],
    ["snapshotCredentialFingerprints", "snapshot_credential_fingerprints_json", (v) => jsonOrNull(v)],
    ["snapshotModalWorkspace", "snapshot_modal_workspace", (v) => (v as string | null) ?? null],
    ["snapshotModalEnvironment", "snapshot_modal_environment", (v) => (v as string | null) ?? null],
    ["snapshotSandboxImageVersion", "snapshot_sandbox_image_version", (v) => (v as string | null) ?? null],
    ["snapshotDockerEnabled", "snapshot_docker_enabled", (v) => (v == null ? null : boolToInt(v as boolean))],
    ["lastSnapshotError", "last_snapshot_error", (v) => (v as string | null) ?? null],
    ["spawnRetryCount", "spawn_retry_count", (v) => (v as number) ?? 0],
    ["pendingPromptDispatch", "pending_prompt_dispatch", (v) => boolToInt(v as boolean)],
    ["sandboxAuthTokenHash", "sandbox_auth_token_hash", (v) => (v as string | null) ?? null],
    ["prevSandboxAuthTokenHash", "prev_sandbox_auth_token_hash", (v) => (v as string | null) ?? null],
    ["prevSandboxAuthTokenExpiresAt", "prev_sandbox_auth_token_expires_at", (v) => (v as number | null) ?? null],
    ["prevSandboxAuthTokenHashes", "prev_sandbox_auth_token_hashes", (v) => (v as string | null) ?? null],
    ["spawnStartedAt", "spawn_started_at", (v) => (v as number | null) ?? null],
    ["lastSpawnAttemptId", "last_spawn_attempt_id", (v) => (v as string | null) ?? null],
    ["promptLastActivityAt", "prompt_last_activity_at", (v) => (v as number | null) ?? null],
    ["intentionalPauseReason", "intentional_pause_reason", (v) => (v as string | null) ?? null],
    ["bridgeProtocolVersion", "bridge_protocol_version", (v) => (v as number | null) ?? null],
    ["stopReason", "stop_reason", (v) => (v as string | null) ?? null],
    ["runtimeProvider", "runtime_provider", (v) => runtimeProviderOrNull(v)],
    ["runtimeBackend", "runtime_backend", (v) => runtimeBackendOrNull(v)],
    ["runtimeState", "runtime_state", (v) => runtimeStateOrNull(v)],
    ["runtimeSandboxId", "runtime_sandbox_id", (v) => (v as string | null) ?? null],
    ["runtimeTemplateId", "runtime_template_id", (v) => (v as string | null) ?? null],
    [
      "runtimeStateExpiresAt",
      "runtime_state_expires_at",
      (v) => (runtimeStateOrNull(updates.runtimeState) === "running" ? null : ((v as number | null) ?? null)),
    ],
    ["runtimeLiveLeaseExpiresAt", "runtime_live_lease_expires_at", (v) => (v as number | null) ?? null],
    ["runtimePreviewUrl", "runtime_preview_url", (v) => (v as string | null) ?? null],
    ["runtimeCreatedAt", "runtime_created_at", (v) => (v as number | null) ?? null],
    ["runtimeLastResumedAt", "runtime_last_resumed_at", (v) => (v as number | null) ?? null],
    ["runtimeLastPausedAt", "runtime_last_paused_at", (v) => (v as number | null) ?? null],
    ["runtimeLastProviderRefreshedAt", "runtime_last_provider_refreshed_at", (v) => (v as number | null) ?? null],
    ["runtimeProviderTtlExpiresAt", "runtime_provider_ttl_expires_at", (v) => (v as number | null) ?? null],
  ];

  for (const [key, col, convert] of mapping) {
    if (key in updates) {
      sets.push(`${col} = ?`);
      values.push(convert(updates[key]));
    }
  }

  if (sets.length === 0) return;
  values.push(sessionId);
  sql.exec(`UPDATE sandbox_state SET ${sets.join(", ")} WHERE session_id = ?`, ...values);
}

function sandboxRowToState(row: Record<string, SqlStorageValue>): SandboxStateRow {
  return {
    sandboxId: row.sandbox_id as string | null,
    modalObjectId: row.modal_object_id as string | null,
    status: row.status as string,
    lastHeartbeatAt: row.last_heartbeat_at as number | null,
    lastActivityAt: row.last_activity_at as number | null,
    disconnectStartedAt: row.disconnect_started_at as number | null,
    autoCloseScheduledAt: row.auto_close_scheduled_at as number | null,
    snapshotImageId: row.snapshot_image_id as string | null,
    snapshotBranch: row.snapshot_branch as string | null,
    snapshotHeadSha: row.snapshot_head_sha as string | null,
    snapshotCreatedAt: row.snapshot_created_at as number | null,
    snapshotCredentialEnvKeys: parseStringArrayOrNull(row.snapshot_credential_env_keys_json),
    snapshotCredentialFingerprints: parseStringArrayOrNull(row.snapshot_credential_fingerprints_json),
    snapshotModalWorkspace: row.snapshot_modal_workspace as string | null,
    snapshotModalEnvironment: row.snapshot_modal_environment as string | null,
    snapshotSandboxImageVersion: row.snapshot_sandbox_image_version as string | null,
    snapshotDockerEnabled: row.snapshot_docker_enabled == null ? null : intToBool(row.snapshot_docker_enabled),
    lastSnapshotError: row.last_snapshot_error as string | null,
    spawnRetryCount: (row.spawn_retry_count as number) ?? 0,
    pendingPromptDispatch: intToBool(row.pending_prompt_dispatch),
    sandboxAuthTokenHash: row.sandbox_auth_token_hash as string | null,
    prevSandboxAuthTokenHash: row.prev_sandbox_auth_token_hash as string | null,
    prevSandboxAuthTokenExpiresAt: row.prev_sandbox_auth_token_expires_at as number | null,
    prevSandboxAuthTokenHashes: row.prev_sandbox_auth_token_hashes as string | null,
    spawnStartedAt: row.spawn_started_at as number | null,
    lastSpawnAttemptId: row.last_spawn_attempt_id as string | null,
    promptLastActivityAt: row.prompt_last_activity_at as number | null,
    intentionalPauseReason: (row.intentional_pause_reason as SandboxIdlePauseReason | null) ?? null,
    bridgeProtocolVersion: row.bridge_protocol_version as number | null,
    stopReason: (row.stop_reason as SandboxStopReason | null) ?? null,
    runtimeProvider: runtimeProviderOrNull(row.runtime_provider),
    runtimeBackend: runtimeBackendOrNull(row.runtime_backend),
    runtimeState: runtimeStateOrNull(row.runtime_state),
    runtimeSandboxId: row.runtime_sandbox_id as string | null,
    runtimeTemplateId: row.runtime_template_id as string | null,
    runtimeStateExpiresAt: row.runtime_state_expires_at as number | null,
    runtimeLiveLeaseExpiresAt: row.runtime_live_lease_expires_at as number | null,
    runtimePreviewUrl: row.runtime_preview_url as string | null,
    runtimeCreatedAt: row.runtime_created_at as number | null,
    runtimeLastResumedAt: row.runtime_last_resumed_at as number | null,
    runtimeLastPausedAt: row.runtime_last_paused_at as number | null,
    runtimeLastProviderRefreshedAt: row.runtime_last_provider_refreshed_at as number | null,
    runtimeProviderTtlExpiresAt: row.runtime_provider_ttl_expires_at as number | null,
  };
}

export function clearRuntimeState(
  sql: SqlStorage,
  sessionId: string,
  expectedProvider?: SandboxRuntimeProvider | null,
): void {
  const providerPredicate = expectedProvider ? " AND runtime_provider = ?" : "";
  const params: SqlStorageValue[] = expectedProvider ? [sessionId, expectedProvider] : [sessionId];
  sql.exec(
    `UPDATE sandbox_state
     SET runtime_provider = NULL,
         runtime_state = NULL,
         runtime_sandbox_id = NULL,
         runtime_template_id = NULL,
         runtime_state_expires_at = NULL,
         runtime_live_lease_expires_at = NULL,
         runtime_preview_url = NULL,
         runtime_created_at = NULL,
         runtime_last_resumed_at = NULL,
         runtime_last_paused_at = NULL,
         runtime_last_provider_refreshed_at = NULL,
         runtime_provider_ttl_expires_at = NULL,
         intentional_pause_reason = NULL,
         preview_url = NULL,
         preview_status = NULL,
         preview_error = NULL
     WHERE session_id = ?${providerPredicate}`,
    ...params,
  );
}

// ---------------------------------------------------------------------------
// Session artifacts
// ---------------------------------------------------------------------------

export interface SessionArtifactRow {
  artifactId: string;
  sessionId: string;
  promptId?: string | null;
  type: string;
  url?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: number;
}

export function insertSessionArtifact(sql: SqlStorage, artifact: SessionArtifactRow): void {
  sql.exec(
    `INSERT OR REPLACE INTO artifacts (
      artifact_id, session_id, prompt_id, type, url, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    artifact.artifactId,
    artifact.sessionId,
    artifact.promptId ?? null,
    artifact.type,
    artifact.url ?? null,
    jsonOrNull(artifact.metadata),
    artifact.createdAt,
  );
}

export function listSessionArtifacts(sql: SqlStorage, sessionId: string): SessionArtifactRow[] {
  return sql
    .exec("SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC", sessionId)
    .toArray()
    .map((row) => ({
      artifactId: row.artifact_id as string,
      sessionId: row.session_id as string,
      promptId: row.prompt_id as string | null,
      type: row.type as string,
      url: row.url as string | null,
      metadata: parseJsonOrNull<Record<string, unknown>>(row.metadata_json),
      createdAt: row.created_at as number,
    }));
}

export function getSessionArtifact(sql: SqlStorage, sessionId: string, artifactId: string): SessionArtifactRow | null {
  const row = sql
    .exec("SELECT * FROM artifacts WHERE session_id = ? AND artifact_id = ? LIMIT 1", sessionId, artifactId)
    .toArray()[0] as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    artifactId: row.artifact_id as string,
    sessionId: row.session_id as string,
    promptId: row.prompt_id as string | null,
    type: row.type as string,
    url: row.url as string | null,
    metadata: parseJsonOrNull<Record<string, unknown>>(row.metadata_json),
    createdAt: row.created_at as number,
  };
}

export function revokeSessionArtifact(
  sql: SqlStorage,
  sessionId: string,
  artifactId: string,
  revokedAt: number,
): boolean {
  const artifact = getSessionArtifact(sql, sessionId, artifactId);
  if (!artifact) return false;

  const metadata = artifact.metadata ?? {};
  const rawAccess = metadata.access;
  const access =
    rawAccess && typeof rawAccess === "object" && !Array.isArray(rawAccess)
      ? (rawAccess as Record<string, unknown>)
      : {};

  insertSessionArtifact(sql, {
    ...artifact,
    metadata: {
      ...metadata,
      access: {
        ...access,
        revokedAt,
      },
    },
  });
  return true;
}

export type SessionPlanRecord = {
  sessionId: string;
  planPromptId: string;
  implementationPromptId: string | null;
  markdown: string | null;
  excerpt: string;
  artifactId: string | null;
  valid: boolean;
  missingReason: string | null;
  missingHeadings: string[];
  status: SessionPlanStatus;
  revision: number;
  userEdited: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  source: string | null;
  createdAt: string;
  updatedAt: string;
};

type UpsertSessionPlanRecord = Omit<
  SessionPlanRecord,
  "status" | "revision" | "userEdited" | "approvedBy" | "approvedAt" | "source" | "createdAt" | "updatedAt"
> & {
  status?: SessionPlanStatus;
  revision?: number;
  userEdited?: boolean;
  approvedBy?: string | null;
  approvedAt?: string | null;
  source?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

function sessionPlanRowToRecord(row: Record<string, SqlStorageValue>): SessionPlanRecord {
  return {
    sessionId: row.session_id as string,
    planPromptId: row.plan_prompt_id as string,
    implementationPromptId: (row.implementation_prompt_id as string | null) ?? null,
    markdown: (row.markdown as string | null) ?? null,
    excerpt: row.excerpt as string,
    artifactId: (row.artifact_id as string | null) ?? null,
    valid: intToBool(row.valid),
    missingReason: (row.missing_reason as string | null) ?? null,
    missingHeadings: parseStringArrayOrNull(row.missing_headings_json) ?? [],
    status: row.status as SessionPlanStatus,
    revision: (row.revision as number) ?? 0,
    userEdited: intToBool(row.user_edited),
    approvedBy: (row.approved_by as string | null) ?? null,
    approvedAt: msToIso(row.approved_at as number | null),
    source: (row.source as string | null) ?? null,
    createdAt: msToIso(row.created_at as number) as string,
    updatedAt: msToIso(row.updated_at as number) as string,
  };
}

export function upsertSessionPlan(sql: SqlStorage, record: UpsertSessionPlanRecord): void {
  const now = Date.now();
  const createdAt = isoToMs(record.createdAt) ?? now;
  const updatedAt = isoToMs(record.updatedAt) ?? now;
  sql.exec(
    `INSERT INTO session_plans (
      session_id, plan_prompt_id, implementation_prompt_id, markdown, excerpt, artifact_id,
      valid, missing_reason, missing_headings_json, status, revision, user_edited,
      approved_by, approved_at, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, plan_prompt_id) DO UPDATE SET
      implementation_prompt_id = excluded.implementation_prompt_id,
      markdown = excluded.markdown,
      excerpt = excluded.excerpt,
      artifact_id = excluded.artifact_id,
      valid = excluded.valid,
      missing_reason = excluded.missing_reason,
      missing_headings_json = excluded.missing_headings_json,
      status = excluded.status,
      revision = excluded.revision,
      user_edited = excluded.user_edited,
      approved_by = excluded.approved_by,
      approved_at = excluded.approved_at,
      source = excluded.source,
      updated_at = excluded.updated_at`,
    record.sessionId,
    record.planPromptId,
    record.implementationPromptId,
    record.markdown,
    record.excerpt,
    record.artifactId,
    boolToInt(record.valid),
    record.missingReason,
    jsonOrNull(record.missingHeadings),
    record.status ?? "none",
    record.revision ?? 0,
    boolToInt(record.userEdited),
    record.approvedBy ?? null,
    isoToMs(record.approvedAt),
    record.source ?? null,
    createdAt,
    updatedAt,
  );
}

export function getLatestSessionPlan(sql: SqlStorage, sessionId: string): SessionPlanRecord | null {
  const row = sql
    .exec(
      `SELECT * FROM session_plans
       WHERE session_id = ?
       ORDER BY revision DESC, updated_at DESC
       LIMIT 1`,
      sessionId,
    )
    .toArray()[0];
  return row ? sessionPlanRowToRecord(row) : null;
}

interface UpdateSessionPlanStatusParams {
  sessionId: string;
  planPromptId: string;
  status: SessionPlanStatus;
  approvedBy?: string | null;
  approvedAt?: number | null;
  implementationPromptId?: string | null;
  source?: string | null;
}

export function updateSessionPlanStatus(sql: SqlStorage, params: UpdateSessionPlanStatusParams): boolean {
  const result = sql.exec(
    `UPDATE session_plans
     SET status = ?, approved_by = ?, approved_at = ?, implementation_prompt_id = ?,
         source = COALESCE(?, source), updated_at = ?
     WHERE session_id = ? AND plan_prompt_id = ?`,
    params.status,
    params.approvedBy ?? null,
    params.approvedAt ?? null,
    params.implementationPromptId ?? null,
    params.source ?? null,
    Date.now(),
    params.sessionId,
    params.planPromptId,
  );
  return result.rowsWritten > 0;
}

export function getFirstSessionPlanCreatedAt(sql: SqlStorage, sessionId: string): string | null {
  const row = sql
    .exec("SELECT MIN(created_at) AS created_at FROM session_plans WHERE session_id = ?", sessionId)
    .toArray()[0];
  return msToIso((row?.created_at as number | null) ?? null);
}

interface SaveEditedPlanRevisionParams {
  sessionId: string;
  planPromptId: string;
  markdown: string;
  excerpt: string;
  expectedRevision: number;
}

export function saveEditedPlanRevision(sql: SqlStorage, params: SaveEditedPlanRevisionParams): boolean {
  const result = sql.exec(
    `UPDATE session_plans
     SET markdown = ?, excerpt = ?, artifact_id = NULL, valid = 1,
         missing_reason = NULL, missing_headings_json = '[]', user_edited = 1,
         revision = revision + 1, updated_at = ?
     WHERE session_id = ? AND plan_prompt_id = ? AND status = 'pending' AND revision = ?`,
    params.markdown,
    params.excerpt,
    Date.now(),
    params.sessionId,
    params.planPromptId,
    params.expectedRevision,
  );
  return result.rowsWritten > 0;
}

// ---------------------------------------------------------------------------
// Prompt usage
// ---------------------------------------------------------------------------

export function upsertPromptUsage(sql: SqlStorage, promptId: string, usage: PerPromptUsage): void {
  sql.exec(
    `INSERT OR REPLACE INTO prompt_usage (
      prompt_id, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, total_cost_usd_micros
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    promptId,
    usage.model ?? null,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    Math.round(usage.totalCostUsd * USD_TO_MICROS),
  );
}

export function getPromptUsage(sql: SqlStorage, sessionId: string): Record<string, PerPromptUsage> {
  // Join with prompts to get only usage for this session's prompts
  const rows = sql
    .exec(
      `SELECT pu.* FROM prompt_usage pu
     INNER JOIN prompts p ON pu.prompt_id = p.prompt_id
     WHERE p.session_id = ?`,
      sessionId,
    )
    .toArray();

  const result: Record<string, PerPromptUsage> = {};
  for (const row of rows) {
    const promptId = row.prompt_id as string;
    result[promptId] = {
      promptId,
      model: row.model as string | undefined,
      inputTokens: (row.input_tokens as number) ?? 0,
      outputTokens: (row.output_tokens as number) ?? 0,
      cacheReadTokens: (row.cache_read_tokens as number) ?? 0,
      cacheWriteTokens: (row.cache_write_tokens as number) ?? 0,
      totalCostUsd: ((row.total_cost_usd_micros as number) ?? 0) / USD_TO_MICROS,
    };
  }
  return result;
}

export function computeUsageCache(promptUsage: Record<string, PerPromptUsage>): UsageCache {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalCostUsd = 0;
  const byModel: UsageCache["byModel"] = {};
  const byPrompt: PerPromptUsage[] = [];

  for (const usage of Object.values(promptUsage)) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cacheReadTokens += usage.cacheReadTokens;
    cacheWriteTokens += usage.cacheWriteTokens;
    totalCostUsd += usage.totalCostUsd;
    byPrompt.push(usage);

    const model = usage.model ?? "unknown";
    if (!byModel[model]) {
      byModel[model] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        totalBilledTokens: 0,
        costUsd: 0,
      };
    }
    byModel[model].inputTokens += usage.inputTokens;
    byModel[model].outputTokens += usage.outputTokens;
    byModel[model].cacheReadTokens += usage.cacheReadTokens;
    byModel[model].cacheWriteTokens += usage.cacheWriteTokens;
    byModel[model].totalTokens += usage.inputTokens + usage.outputTokens;
    byModel[model].totalBilledTokens +=
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    byModel[model].costUsd += usage.totalCostUsd;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalCostUsd,
    totalTokens: inputTokens + outputTokens,
    totalBilledTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    promptCount: byPrompt.length,
    byModel,
    byPrompt,
  };
}

// ---------------------------------------------------------------------------
// Prompt token attribution
// ---------------------------------------------------------------------------

export function upsertPromptTokenAttribution(
  sql: SqlStorage,
  promptId: string,
  attribution: EstimatedInputCompositionRecord,
): void {
  sql.exec(
    `INSERT OR REPLACE INTO prompt_token_attribution (prompt_id, attribution_json) VALUES (?, ?)`,
    promptId,
    JSON.stringify(attribution),
  );
}

export function getPromptTokenAttribution(
  sql: SqlStorage,
  sessionId: string,
): Record<string, EstimatedInputCompositionRecord> {
  const rows = sql
    .exec(
      `SELECT pta.* FROM prompt_token_attribution pta
     INNER JOIN prompts p ON pta.prompt_id = p.prompt_id
     WHERE p.session_id = ?
     ORDER BY p.created_at ASC, p.prompt_id ASC`,
      sessionId,
    )
    .toArray();

  const result: Record<string, EstimatedInputCompositionRecord> = {};
  for (const row of rows) {
    const promptId = row.prompt_id as string;
    const attribution = parseJsonOrNull<EstimatedInputCompositionRecord>(row.attribution_json);
    if (attribution?.kind !== "estimated_input_composition" || attribution.version !== 1) continue;
    result[promptId] = attribution;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Prompt telemetry
// ---------------------------------------------------------------------------

interface PromptTelemetryRow {
  ddTraceId?: string | null;
  btSpanId?: string | null;
  errorCode?: string | null;
  toolCallCount: number;
}

export function upsertPromptTelemetry(sql: SqlStorage, promptId: string, telemetry: Partial<PromptTelemetryRow>): void {
  // Try insert first, then update fields that are set
  sql.exec(`INSERT OR IGNORE INTO prompt_telemetry (prompt_id, tool_call_count) VALUES (?, 0)`, promptId);

  const sets: string[] = [];
  const values: SqlStorageValue[] = [];

  if (telemetry.btSpanId !== undefined) {
    sets.push("bt_span_id = ?");
    values.push(telemetry.btSpanId ?? null);
  }
  if (telemetry.errorCode !== undefined) {
    sets.push("error_code = ?");
    values.push(telemetry.errorCode ?? null);
  }
  if (telemetry.toolCallCount !== undefined) {
    sets.push("tool_call_count = ?");
    values.push(telemetry.toolCallCount);
  }

  if (sets.length === 0) return;
  values.push(promptId);
  sql.exec(`UPDATE prompt_telemetry SET ${sets.join(", ")} WHERE prompt_id = ?`, ...values);
}

export function upsertPromptTraceTelemetry(
  sql: SqlStorage,
  promptId: string,
  telemetry: Pick<Partial<PromptTelemetryRow>, "btSpanId">,
): void {
  if (!telemetry.btSpanId) return;
  sql.exec(`INSERT OR IGNORE INTO prompt_telemetry (prompt_id, tool_call_count) VALUES (?, 0)`, promptId);
  sql.exec(
    `UPDATE prompt_telemetry SET bt_span_id = COALESCE(bt_span_id, ?) WHERE prompt_id = ?`,
    telemetry.btSpanId,
    promptId,
  );
}

export function incrementToolCallCount(sql: SqlStorage, promptId: string): void {
  sql.exec(
    `INSERT INTO prompt_telemetry (prompt_id, tool_call_count) VALUES (?, 1)
     ON CONFLICT(prompt_id) DO UPDATE SET tool_call_count = tool_call_count + 1`,
    promptId,
  );
}

interface PromptToolStatsRow {
  promptId: string;
  toolName: string;
  mcpServer: string | null;
  okCount: number;
  errorCount: number;
  totalDurationMs: number;
  durationSampleCount: number;
}

export function incrementPromptToolStats(
  sql: SqlStorage,
  promptId: string,
  update: { tool: string; status: string; durationMs?: number },
): boolean {
  const isError = update.status === "error";
  const isOk = update.status === "completed";
  if (!isOk && !isError) return false;

  const toolName = normalizeToolName(update.tool);
  if (!toolName) return false;

  const hasDuration = typeof update.durationMs === "number" && Number.isFinite(update.durationMs);
  sql.exec(
    `INSERT INTO prompt_tool_stats (
       prompt_id, tool_name, mcp_server, ok_count, error_count, total_duration_ms, duration_sample_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(prompt_id, tool_name) DO UPDATE SET
       ok_count = ok_count + excluded.ok_count,
       error_count = error_count + excluded.error_count,
       total_duration_ms = total_duration_ms + excluded.total_duration_ms,
       duration_sample_count = duration_sample_count + excluded.duration_sample_count`,
    promptId,
    toolName,
    parseMcpServerName(update.tool),
    isOk ? 1 : 0,
    isError ? 1 : 0,
    hasDuration ? Math.max(0, Math.round(update.durationMs!)) : 0,
    hasDuration ? 1 : 0,
  );
  return true;
}

export function getPromptToolStatsForPrompt(sql: SqlStorage, promptId: string): PromptToolStatsRow[] {
  const rows = sql
    .exec(
      `SELECT prompt_id, tool_name, mcp_server, ok_count, error_count, total_duration_ms, duration_sample_count
       FROM prompt_tool_stats
       WHERE prompt_id = ?
       ORDER BY tool_name`,
      promptId,
    )
    .toArray();

  return rows.map((row) => ({
    promptId: row.prompt_id as string,
    toolName: row.tool_name as string,
    mcpServer: (row.mcp_server as string | null) ?? null,
    okCount: (row.ok_count as number) ?? 0,
    errorCount: (row.error_count as number) ?? 0,
    totalDurationMs: (row.total_duration_ms as number) ?? 0,
    durationSampleCount: (row.duration_sample_count as number) ?? 0,
  }));
}

export function getPromptTelemetry(sql: SqlStorage, sessionId: string): Record<string, PromptTelemetryRow> {
  const rows = sql
    .exec(
      `SELECT pt.* FROM prompt_telemetry pt
     INNER JOIN prompts p ON pt.prompt_id = p.prompt_id
     WHERE p.session_id = ?`,
      sessionId,
    )
    .toArray();

  const result: Record<string, PromptTelemetryRow> = {};
  for (const row of rows) {
    result[row.prompt_id as string] = {
      ddTraceId: row.dd_trace_id as string | null,
      btSpanId: row.bt_span_id as string | null,
      errorCode: row.error_code as string | null,
      toolCallCount: (row.tool_call_count as number) ?? 0,
    };
  }
  return result;
}

export function getPromptToolCounts(sql: SqlStorage, sessionId: string): Record<string, number> {
  const rows = sql
    .exec(
      `SELECT pt.prompt_id, pt.tool_call_count FROM prompt_telemetry pt
     INNER JOIN prompts p ON pt.prompt_id = p.prompt_id
     WHERE p.session_id = ?`,
      sessionId,
    )
    .toArray();

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.prompt_id as string] = (row.tool_call_count as number) ?? 0;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

export function clearSnapshotMetadata(sql: SqlStorage, sessionId: string, expectedImageId?: string): void {
  if (expectedImageId) {
    const current = getSandboxState(sql, sessionId);
    if (current?.snapshotImageId && current.snapshotImageId !== expectedImageId) return;
  }
  updateSandboxState(sql, sessionId, {
    snapshotImageId: null,
    snapshotBranch: null,
    snapshotHeadSha: null,
    snapshotCreatedAt: null,
    snapshotCredentialEnvKeys: null,
    snapshotCredentialFingerprints: null,
    snapshotModalWorkspace: null,
    snapshotModalEnvironment: null,
    snapshotSandboxImageVersion: null,
    snapshotDockerEnabled: null,
  });
}
import type { PublishStage, PublishStatus } from "../../../../shared/types/publish.js";
