import type { PrReviewExpectedBot, PrReviewKnownBotId } from "../../../../shared/constants/pr-review-bots.js";
import { normalizeGithubLogin } from "../../../../shared/constants/pr-review-bots.js";
import type { ManagedQaVerdict } from "./verification-comment-marker";
import { containsManagedQaCommentMarker } from "./verification-comment-marker";

export type PrReviewBotTerminalSignal = "review_submission" | "check_run" | "commit_status" | "issue_comment_final";
export type PrReviewBotTelemetryLabel = PrReviewKnownBotId | "custom" | "unknown";

/**
 * Signal a review-loop bot match is being made for. The four terminal signals narrow KNOWN bots to
 * those whose capability declares that signal; `"activity"` is the non-narrowing worklist/backfill
 * signal that applies the authorType gate but does NOT narrow by terminal-signal capability (so a
 * known bot's comments are never dropped from a worklist just because the bot is not terminal on
 * that signal). Custom bots are matched only on the review-ish signals (review_submission/activity).
 */
export type PrReviewBotMatchSignal = PrReviewBotTerminalSignal | "activity";

export type MatchedReviewLoopBot = { key: string; normalizedLogin: string };

export interface PrReviewBotCapability {
  id: PrReviewKnownBotId;
  actorAliases: readonly string[];
  reviewCapable: boolean;
  terminalSignals: readonly PrReviewBotTerminalSignal[];
}

export const PR_REVIEW_BOT_CAPABILITIES: Record<PrReviewKnownBotId, PrReviewBotCapability> = {
  greptile: {
    id: "greptile",
    actorAliases: ["greptile-apps[bot]", "greptile-apps-staging[bot]"],
    reviewCapable: true,
    terminalSignals: ["review_submission", "check_run", "issue_comment_final"],
  },
  coderabbit: {
    id: "coderabbit",
    actorAliases: ["coderabbitai[bot]"],
    reviewCapable: true,
    terminalSignals: ["review_submission", "commit_status"],
  },
  "cursor-bugbot": {
    id: "cursor-bugbot",
    actorAliases: ["cursor[bot]"],
    reviewCapable: true,
    terminalSignals: ["review_submission", "check_run"],
  },
  "chatgpt-codex": {
    id: "chatgpt-codex",
    actorAliases: ["chatgpt-codex-connector", "chatgpt-codex-connector[bot]"],
    reviewCapable: true,
    terminalSignals: ["review_submission"],
  },
  strix: {
    id: "strix",
    actorAliases: ["strix[bot]", "strix-ai[bot]", "usestrix[bot]", "strix-security[bot]"],
    reviewCapable: true,
    terminalSignals: ["review_submission", "check_run"],
  },
  copilot: {
    id: "copilot",
    actorAliases: ["copilot-pull-request-reviewer[bot]"],
    reviewCapable: true,
    terminalSignals: ["review_submission"],
  },
};

export const ARCANIST_OWNED_GITHUB_ACTOR_LOGINS = [
  "cycloid[bot]",
  "cycloid-dev[bot]",
  "cycloid-staging[bot]",
  // QA GitHub App ("Cycloid QA"). Its QTA comments are authored as `cycloid-qa`; without this the
  // marker-gated QTA-comment admission (getPrReviewLoopWorklist) drops every QA verification comment,
  // so the RLA v2 needs-work intake dispatches an empty worklist on QA. normalizeGitHubActorLogin
  // strips the `[bot]` suffix, so this matches the `cycloid-qa` author login too.
  "cycloid-qa[bot]",
] as const;

export function normalizeGitHubActorLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/i, "");
}

const PR_REVIEW_BOT_ALIAS_ENTRIES = Object.values(PR_REVIEW_BOT_CAPABILITIES).flatMap((capability) =>
  capability.actorAliases.map((alias) => [normalizeGitHubActorLogin(alias), capability.id] as const),
);

export const PR_REVIEW_BOT_ACTOR_ALIAS_LOGINS: ReadonlySet<string> = new Set(
  PR_REVIEW_BOT_ALIAS_ENTRIES.map(([alias]) => alias),
);

export const ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET: ReadonlySet<string> = new Set(
  ARCANIST_OWNED_GITHUB_ACTOR_LOGINS.map((login) => normalizeGitHubActorLogin(login)),
);

/**
 * The QA verifier's ingest key. Its managed PR comment is Cycloid-authored (`cycloid-qa[bot]`), so it is
 * normally dropped by the Cycloid-owned fence; `resolveIngestBotKey` carves a single exception when the
 * comment carries the managed QA marker. `known:` (not `custom:`) so it shares the known-bot key space with
 * the D4 noise gate + telemetry; `cycloid-qa` is NOT in the user-configurable PR_REVIEW_BOT_IDS union — it
 * is never a selectable expected bot and never a no-show-latch terminal (always `configured:false`).
 */
export const CYCLOID_QA_BOT_KEY = "known:cycloid-qa";

// The QA verifier's author login (normalized). Narrower than ARCANIST_OWNED_…: a review from cycloid[bot]
// or cycloid-dev[bot] must never be admitted, only the QA app's marked verdict comment.
const CYCLOID_QA_ACTOR_LOGIN_SET: ReadonlySet<string> = new Set([normalizeGitHubActorLogin("cycloid-qa[bot]")]);

/** Actionable iff the QA verdict is app_breaks (needs work); a clean/none/absent verdict re-opens nothing. */
export function qaCommentVerdictActionable(verdict: ManagedQaVerdict | null): boolean {
  return verdict === "app_breaks";
}

const PR_REVIEW_BOT_TELEMETRY_LABEL_BY_LOGIN: ReadonlyMap<string, PrReviewKnownBotId> = new Map(
  PR_REVIEW_BOT_ALIAS_ENTRIES,
);

/**
 * The known review bot id whose registry alias matches this actor login, or null. Lets ingest admit an
 * unconfigured-but-known reviewer under its `known:<id>` key (respond-only) so the D4 noise gate — which
 * only fires on `known:` keys — can still gate that reviewer's no-findings output. Shares the registry
 * reverse-index with the ingest telemetry labeller.
 */
export function knownReviewBotIdForActorLogin(login: string | null | undefined): PrReviewKnownBotId | null {
  if (!login) return null;
  return PR_REVIEW_BOT_TELEMETRY_LABEL_BY_LOGIN.get(normalizeGitHubActorLogin(login)) ?? null;
}

/** Stable identity key for an expected review bot (`known:<id>` or `custom:<login>`). */
export function expectedBotKey(bot: PrReviewExpectedBot): string {
  return bot.type === "known" ? `known:${bot.id}` : `custom:${normalizeGithubLogin(bot.login)}`;
}

/** Whether a GitHub author/actor type is a bot or app account (the only authors review bots use). */
export function isBotOrAppAuthor(authorType: string | null | undefined): boolean {
  return authorType === "Bot" || authorType === "App";
}

/** Bounded bot label for ingest telemetry: known registry id, generic custom, or unknown. */
export function classifyPrReviewBotForTelemetry(params: {
  actorLogin: string | null | undefined;
  actorType: string | null | undefined;
}): PrReviewBotTelemetryLabel {
  if (!params.actorLogin || !isBotOrAppAuthor(params.actorType)) return "unknown";
  const normalizedActor = normalizeGitHubActorLogin(params.actorLogin);
  if (ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizedActor)) return "unknown";
  return PR_REVIEW_BOT_TELEMETRY_LABEL_BY_LOGIN.get(normalizedActor) ?? "custom";
}

/**
 * The single review-loop bot matcher. Both the worklist/backfill builder and the live webhook ingest
 * route through it so they agree on which actors are configured review bots — previously two
 * near-duplicate matchers had diverged (the worklist matcher gated only custom bots on authorType,
 * so a `User`-type account whose login matched a known alias was folded into a worklist).
 *
 * authorType is gated up front for BOTH known and custom branches: every PR_REVIEW_BOT_CAPABILITIES
 * bot posts review feedback from a Bot/App account (verified — e.g. chatgpt-codex-connector posts as
 * `chatgpt-codex-connector[bot]`, type Bot), so a non-bot impostor is always rejected. KNOWN bots are
 * narrowed by terminal-signal capability only for the four terminal signals — never for the
 * `"activity"` worklist signal (else a known bot's comments would be dropped). Custom bots match only
 * on the review-ish signals.
 */
export function matchReviewLoopBot(params: {
  expectedBots: PrReviewExpectedBot[];
  actorLogin: string | null | undefined;
  actorType: string | null | undefined;
  signal: PrReviewBotMatchSignal;
}): MatchedReviewLoopBot | null {
  if (!params.actorLogin || !isBotOrAppAuthor(params.actorType)) return null;
  const normalizedActor = normalizeGitHubActorLogin(params.actorLogin);
  if (ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizedActor)) return null;

  for (const expected of params.expectedBots) {
    if (expected.type === "known") {
      const capability = PR_REVIEW_BOT_CAPABILITIES[expected.id];
      if (params.signal !== "activity" && !capability.terminalSignals.includes(params.signal)) continue;
      const aliases = capability.actorAliases.map((alias) => normalizeGitHubActorLogin(alias));
      if (aliases.includes(normalizedActor)) return { key: expectedBotKey(expected), normalizedLogin: normalizedActor };
      continue;
    }
    if (params.signal === "issue_comment_final" || params.signal === "check_run" || params.signal === "commit_status") {
      continue;
    }
    if (normalizeGitHubActorLogin(expected.login) === normalizedActor) {
      return { key: expectedBotKey(expected), normalizedLogin: normalizedActor };
    }
  }

  return null;
}

// Content-carrying signals for which an unconfigured-but-known review bot is still ingested. Terminal
// signals (`check_run`/`commit_status`) carry no review text and stay allowlist-only — a drive-by
// reviewer's check-run must not mint a spurious empty epoch.
const UNLISTED_INGEST_SIGNALS: ReadonlySet<PrReviewBotMatchSignal> = new Set([
  "review_submission",
  "activity",
  "issue_comment_final",
]);

/**
 * Allow-list ingest key resolver. A CONFIGURED bot resolves via `matchReviewLoopBot` (the allowlist). An
 * UNCONFIGURED author is ingested ONLY if it is a known-registry review bot — respond-only, under a
 * stable `known:<id>` key — and only for content-carrying signals, never terminal signals. Every other
 * unconfigured bot (linear[bot] linkbacks, CI/deploy/status bots) is dropped. Cycloid-owned actors are
 * never ingested (else the loop feeds on its own reviews). The `configured` flag lets callers keep
 * configured bots' terminal-signal behavior while treating drive-by known reviewers as respond-only.
 */
export function resolveIngestBotKey(params: {
  expectedBots: PrReviewExpectedBot[];
  actorLogin: string | null | undefined;
  actorType: string | null | undefined;
  signal: PrReviewBotMatchSignal;
  // The comment body + PR target — supplied ONLY by the issue-comment/review ingest seams that can carry
  // the managed QA marker. Absent → the QA carve-out is inert (back-compat with terminal-signal callers).
  body?: string | null;
  qaMarkerTarget?: { owner: string; repo: string; prNumber: number };
}): { key: string; configured: boolean } | null {
  // QA managed-comment carve-out (runs BEFORE matchReviewLoopBot, which would drop the owned author). Admit
  // a cycloid-qa comment IFF it carries the managed QA marker for this PR — respond-only, keyed
  // known:cycloid-qa. Content signals only (never a check_run/commit_status terminal): a verdict is text.
  if (
    UNLISTED_INGEST_SIGNALS.has(params.signal) &&
    params.body &&
    params.qaMarkerTarget &&
    params.actorLogin &&
    isBotOrAppAuthor(params.actorType) &&
    CYCLOID_QA_ACTOR_LOGIN_SET.has(normalizeGitHubActorLogin(params.actorLogin)) &&
    containsManagedQaCommentMarker(params.body, params.qaMarkerTarget)
  ) {
    return { key: CYCLOID_QA_BOT_KEY, configured: false };
  }
  const matched = matchReviewLoopBot(params);
  if (matched) return { key: matched.key, configured: true };
  // Allow-list posture (fixes #6558's admit-any-bot regression): an UNCONFIGURED author is ingested ONLY
  // if it is a known-registry review bot — respond-only (configured:false, never a no-show-latch terminal).
  // Keyed known:<id> (not custom:<login>) so the D4 noise gate, which only fires on known: keys, still gates
  // a known reviewer's no-findings output. Every non-registry bot (linear[bot] linkbacks, github-actions,
  // codecov, vercel/netlify deploy previews, graphite-app, changeset-bot, ...) is NOT a reviewer and is
  // dropped as actor_not_configured_bot. QA/verifier verdicts do NOT arrive here — they flow via the FSM
  // verification.* spine. See docs/review-loop.md + docs/debugging-runbook.md.
  if (!UNLISTED_INGEST_SIGNALS.has(params.signal)) return null;
  if (!params.actorLogin || !isBotOrAppAuthor(params.actorType)) return null;
  const normalizedActor = normalizeGitHubActorLogin(params.actorLogin);
  if (ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizedActor)) return null;
  const knownId = knownReviewBotIdForActorLogin(normalizedActor);
  if (!knownId) return null;
  return { key: `known:${knownId}`, configured: false };
}
