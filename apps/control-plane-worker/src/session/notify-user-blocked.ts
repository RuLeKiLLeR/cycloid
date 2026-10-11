import { BLOCKED_DM_COPY, BLOCKED_DM_DEDUP_TTL_SECONDS } from "../constants/blocked-dm";
import { BlockerKind } from "../enums/blocker";
import { createLogger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { DEFAULT_FRONTEND_URL } from "../services/warm";
import {
  getBusinessIdForUser,
  getLinkedSlackTeamIdForUser,
  getSlackExternalIdForUser,
  setLinkedSlackTeamIdForUser,
} from "../slack/link-db";
import { getUserInfo, postDirectMessage } from "../slack/notify";
import { publishPlanApprovalInteractionButton } from "../slack/plan-approval-interactions";
import { getBotTokenForTeam, getSoleActiveWorkspaceInstallForBusiness } from "../slack/workspaces";
import type { CallbackContext, Env } from "../types";

const BLOCKED_DM_DEDUP_TTL_MS = BLOCKED_DM_DEDUP_TTL_SECONDS * 1000;

const log = createLogger({ bindings: { component: "blocked-dm" } });

export type NotifyUserBlockedResult =
  "sent" | "skipped_no_slack" | "skipped_deduped" | "skipped_unconfigured" | "failed";

export type BlockedDmOutcome =
  NotifyUserBlockedResult | "skipped_stale_plan" | "skipped_bad_owner" | "skipped_duplicate_park";

export interface BlockedDmTarget {
  botToken: string;
  slackUserId: string;
  teamId: string;
  teamSource: "slack_context" | "linked" | "sole_business_install";
}

/**
 * Resolve the Slack DM target for a blocked-session notice, failing closed.
 *
 * Slack user ids are workspace-scoped, so the team must be the workspace where
 * the user's `slackUserId` is valid - resolving an arbitrary business workspace
 * could DM the wrong person. Precedence:
 *  1. Slack-origin sessions: the team the mention came from is authoritative.
 *  2. The team where the user bound their Slack identity, from the durable
 *     `user_integrations.external_team_id` (with the prunable link ledger as a
 *     fallback only for links bound before that column existed).
 * With neither, we use the business's sole active install only when exactly one
 * exists. This preserves the fail-closed behavior for ambiguous businesses and
 * lets a successful DM prove the pair is valid before durably recording its team.
 */
export async function resolveBlockedDmTarget(
  env: Env,
  args: { ownerUserId: number; callbackContext?: CallbackContext },
): Promise<BlockedDmTarget | null> {
  const slackUserId = await getSlackExternalIdForUser(env.DB, args.ownerUserId);
  if (!slackUserId) return null;

  let resolvedTeam = await resolveTeamId(env, args);
  if (!resolvedTeam) return null;

  let botToken = await getBotTokenForTeam(env.DB, resolvedTeam.teamId, env.TOKEN_ENCRYPTION_KEY);
  if (!botToken && resolvedTeam.teamSource === "linked") {
    const fallbackTeam = await resolveSoleBusinessInstallTeam(env, args.ownerUserId);
    if (fallbackTeam) {
      resolvedTeam = fallbackTeam;
      botToken = await getBotTokenForTeam(env.DB, resolvedTeam.teamId, env.TOKEN_ENCRYPTION_KEY);
    }
  }
  if (!botToken) return null;

  if (resolvedTeam.teamSource === "sole_business_install") {
    const userInfo = await getUserInfo(botToken, slackUserId).catch(() => null);
    if (userInfo?.id !== slackUserId) return null;
  }

  return { botToken, slackUserId, ...resolvedTeam };
}

type ResolvedTeam = {
  teamId: string;
  teamSource: BlockedDmTarget["teamSource"];
};

async function resolveTeamId(
  env: Env,
  args: { ownerUserId: number; callbackContext?: CallbackContext },
): Promise<ResolvedTeam | null> {
  const { callbackContext, ownerUserId } = args;
  if (callbackContext?.source === "slack" && callbackContext.slackTeamId) {
    return { teamId: callbackContext.slackTeamId, teamSource: "slack_context" };
  }

  const linkedTeamId = await getLinkedSlackTeamIdForUser(env.DB, ownerUserId);
  if (linkedTeamId) return { teamId: linkedTeamId, teamSource: "linked" };

  return resolveSoleBusinessInstallTeam(env, ownerUserId);
}

async function resolveSoleBusinessInstallTeam(env: Env, ownerUserId: number): Promise<ResolvedTeam | null> {
  const businessId = await getBusinessIdForUser(env.DB, ownerUserId);
  if (!businessId) return null;
  const install = await getSoleActiveWorkspaceInstallForBusiness(env.DB, businessId);
  return install ? { teamId: install.teamId, teamSource: "sole_business_install" } : null;
}

function buildBlockedDmText(env: Env, kind: BlockerKind, sessionId: string, prUrl?: string): string {
  const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  const sessionUrl = `${frontendUrl}/sessions/${sessionId}`;
  const copy = BLOCKED_DM_COPY[kind];
  const lines = [copy.headline, "", copy.nextStep, "", `Session: ${sessionUrl}`];
  if (prUrl) lines.push(`PR: ${prUrl}`);
  return lines.join("\n");
}

/**
 * Link-only PlanReady blocks. The later Slack-interaction PR can append its
 * action block after this section; omitting it is the safe fallback when an
 * interaction request cannot be minted.
 */
function buildPlanReadyDmBlocks(sessionUrl: string, additionalBlocks: readonly unknown[] = []): unknown[] {
  const copy = BLOCKED_DM_COPY[BlockerKind.PlanReady];
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${copy.headline}*\n<${sessionUrl}|The plan is attached to this message. Edit or discuss it in Cycloid>.`,
      },
    },
    ...additionalBlocks,
  ];
}

export interface NotifyUserBlockedArgs {
  sessionId: string;
  ownerUserId: number;
  callbackContext?: CallbackContext;
  kind: BlockerKind;
  /** Included only when a PR exists at the call site. */
  prUrl?: string;
  /** Stable per-(session,kind) key: re-entry on the same blocker dedupes; a new
   * head/fingerprint re-notifies. */
  dedupKey: string;
  /** Optional PlanReady-only blocks appended after the link section. Omitted
   * when Slack interaction setup fails, leaving a usable link-only notice. */
  planReadyAdditionalBlocks?: readonly unknown[];
  /** Present only for an approvable PlanReady notice. Omission deliberately
   * preserves the link-only fallback for invalid plans or mint failures. */
  planReadyApproval?: { businessId: string; revision: number };
  /** The DO-held plan markdown for an approvable PlanReady notice, rendered
   * inline into the Approve message so it can be read in Slack. Passed from the
   * DO's `this.sql` to avoid a re-entrant self-fetch; `null`/omitted = link-only. */
  planReadyMarkdown?: string | null;
  /** DO-resident callers pass storage for a replay-stable idempotency flag that
   * survives a crash between send and the KV write. Route-triggered callers omit
   * it and rely on KV alone. */
  storage?: DurableObjectStorage;
  /** Injectable clock for tests; defaults to `Date.now()`. */
  now?: number;
}

/**
 * DM the session owner that their session is blocked on out-of-band action.
 * Additive to today's surfaces and never throws into the caller: any failure
 * returns a non-`sent` result. Copy is a fixed per-kind template - no raw error
 * text reaches Slack.
 *
 * Dedup: KV (`RATE_LIMITS`) is the cross-process spam guard, recorded only after
 * a successful send (~24h TTL). When `storage` is provided (DO-resident sites) a
 * replay-stable DO-storage flag is also checked/set, because KV is eventually
 * consistent and outside DO storage so a crash between send and KV `put` could
 * otherwise double-DM. The DO flag stores the send timestamp and honors the SAME
 * ~24h TTL as KV (DO storage has no native expiry), so a DO-resident site still
 * re-notifies after the window instead of deduping forever.
 */
export async function notifyUserBlocked(env: Env, args: NotifyUserBlockedArgs): Promise<NotifyUserBlockedResult> {
  const { sessionId, kind } = args;
  const dedupId = `blocked-dm:${sessionId}:${kind}:${args.dedupKey}`;
  const nowMs = args.now ?? Date.now();

  // Decrypting a workspace bot token requires the encryption key; without it no
  // DM is possible regardless of who is linked. Distinct from "user has no Slack".
  if (!env.TOKEN_ENCRYPTION_KEY) {
    return logBlockedDmOutcome(env, "skipped_unconfigured", sessionId, kind, args.callbackContext);
  }

  // Never throw into the caller (publish / sweep paths). Any DAO/Slack error
  // resolves to "failed", mirroring `postInternalAlert`.
  try {
    if (args.storage) {
      const seenAt = await args.storage.get<number>(dedupId).catch(() => undefined);
      if (typeof seenAt === "number" && nowMs - seenAt < BLOCKED_DM_DEDUP_TTL_MS) {
        return logBlockedDmOutcome(env, "skipped_deduped", sessionId, kind, args.callbackContext);
      }
    }
    const kv = env.RATE_LIMITS;
    if (kv && (await kv.get(dedupId).catch(() => null))) {
      return logBlockedDmOutcome(env, "skipped_deduped", sessionId, kind, args.callbackContext);
    }

    const target = await resolveBlockedDmTarget(env, {
      ownerUserId: args.ownerUserId,
      callbackContext: args.callbackContext,
    });
    if (!target) {
      return logBlockedDmOutcome(env, "skipped_no_slack", sessionId, kind, args.callbackContext);
    }

    const text = buildBlockedDmText(env, kind, sessionId, args.prUrl);
    const frontendUrl = env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
    const blocks =
      kind === BlockerKind.PlanReady
        ? buildPlanReadyDmBlocks(`${frontendUrl}/sessions/${sessionId}`, args.planReadyAdditionalBlocks)
        : undefined;
    const result = await postDirectMessage(target.botToken, target.slackUserId, text, blocks).catch(() => null);
    if (!result?.ok) {
      return logBlockedDmOutcome(
        env,
        "failed",
        sessionId,
        kind,
        args.callbackContext,
        target.teamId,
        target.teamSource,
      );
    }

    if (target.teamSource === "sole_business_install") {
      await setLinkedSlackTeamIdForUser(env.DB, args.ownerUserId, target.teamId).catch((error) => {
        log.warn(
          { action: "blocked_dm_team_write_back", sessionId, teamId: target.teamId, error: String(error) },
          "Failed to persist Slack team after successful blocked-session DM",
        );
      });
    }

    if (
      kind === BlockerKind.PlanReady &&
      args.planReadyApproval &&
      typeof result.channel === "string" &&
      result.channel.length > 0 &&
      typeof result.ts === "string" &&
      result.ts.length > 0
    ) {
      await publishPlanApprovalInteractionButton(env, {
        businessId: args.planReadyApproval.businessId,
        sessionId,
        revision: args.planReadyApproval.revision,
        slackTeamId: target.teamId,
        slackChannelId: result.channel,
        messageTs: result.ts,
        botToken: target.botToken,
        planMarkdown: args.planReadyMarkdown ?? null,
      }).catch((error) => {
        log.warn(
          {
            action: "plan_ready_approval_button",
            sessionId,
            revision: args.planReadyApproval?.revision,
            error: String(error),
          },
          "PlanReady approval button setup failed; keeping link-only DM",
        );
      });
    }

    // Record only after success so a failed DM does not suppress a retry. Write
    // the DO-storage flag BEFORE the external KV put: DO storage is transactional
    // and local, so a crash during the KV put (network in-flight) is then caught
    // on replay by the already-committed DO flag - the stated crash guarantee.
    // KV-first would leave neither flag set if the crash landed during its put.
    // The DO value is the send timestamp so the read above can honor the TTL.
    if (args.storage) {
      await args.storage.put(dedupId, nowMs).catch(() => undefined);
    }
    if (kv) {
      await kv.put(dedupId, "1", { expirationTtl: BLOCKED_DM_DEDUP_TTL_SECONDS }).catch(() => undefined);
    }
    return logBlockedDmOutcome(env, "sent", sessionId, kind, args.callbackContext, target.teamId, target.teamSource);
  } catch (err) {
    log.warn(
      {
        action: "blocked_dm",
        outcome: "failed",
        sessionId,
        kind,
        origin: blockedDmOrigin(args.callbackContext),
        error: String(err),
      },
      "blocked_dm_error",
    );
    return logBlockedDmOutcome(env, "failed", sessionId, kind, args.callbackContext);
  }
}

export async function logBlockedDmOutcome<T extends BlockedDmOutcome>(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  outcome: T,
  sessionId: string,
  kind: BlockerKind,
  callbackContext?: CallbackContext,
  teamId?: string,
  teamSource: BlockedDmTarget["teamSource"] | "none" = "none",
): Promise<T> {
  // Metadata only: never log DM text, tokens, or raw Slack errors.
  log.info(
    {
      action: "blocked_dm",
      outcome,
      sessionId,
      kind,
      origin: blockedDmOrigin(callbackContext),
      ...(teamId ? { teamId } : {}),
    },
    "blocked_dm",
  );
  const posted = await postStructuredEventToDd(env, {
    event: "blocked_dm",
    outcome,
    session_id: sessionId,
    kind,
    origin: blockedDmOrigin(callbackContext),
    team_source: teamSource,
    team_id: teamId ?? null,
  }).catch((error) => {
    log.warn({ action: "blocked_dm_datadog", outcome, error: String(error) }, "blocked_dm_datadog_error");
    return false;
  });
  if (!posted) {
    log.warn({ action: "blocked_dm_datadog", outcome }, "blocked_dm_datadog_error");
  }
  return outcome;
}

function blockedDmOrigin(callbackContext?: CallbackContext): "slack" | "github_qa_issue_comment" | "none" {
  return callbackContext?.source ?? "none";
}
