import type { Phase, VerificationResult, VerificationState } from "../../../../shared/session/phase.js";
import {
  filterEventsForPrompt,
  flattenSessionEvents,
  resolveAuthoritativePromptEvents,
} from "../../../../shared/transcript/projector.js";
import { errorCodeHint, errorCodeLabel, isErrorCode } from "../../../../shared/types/error-codes.js";
import type { ErrorCode, PrReadinessEvidence } from "../../../../shared/types/sandbox.js";
import {
  SLACK_BLOCK_KIT_MAX_BLOCKS,
  SLACK_BLOCK_SECTION_TEXT_LIMIT,
  SLACK_INTERACTION_ACTION_PREFIX,
  SLACK_MESSAGE_TEXT_LIMIT,
  SLACK_REPLY_QUOTE_TEXT_LIMIT,
  SLACK_SMART_TRUNCATION_THRESHOLD,
} from "../constants/slack";
import { SLACK_RESUME_CONTROL_STAGES, SLACK_RETRY_CONTROL_STAGES } from "../constants/slack-card-controls";
import { SlackInteractionKind } from "../enums/slack-interaction";
import type { SessionEvent } from "../types";

/**
 * Summary payload used to render a Slack completion message.
 */
interface ExtractedResponse {
  /** Short final message from the agent (already truncated before render). */
  text: string;
  /** Pull request URL produced by the prompt, if any. */
  prUrl?: string;
  /** Branch name produced by the prompt, if any. */
  branchName?: string;
}

export function extractResponseFromEvents(events: SessionEvent[], promptId: string): ExtractedResponse {
  const promptEvents = filterEventsForPrompt(events, promptId);
  const projectedEvents = flattenSessionEvents(resolveAuthoritativePromptEvents(promptEvents));

  // Match the canonical transcript path while preserving split text segments.
  let lastToolIndex = -1;
  for (let i = projectedEvents.length - 1; i >= 0; i--) {
    if (projectedEvents[i].type === "tool_call") {
      lastToolIndex = i;
      break;
    }
  }
  const textSegmentsAfterLastTool = projectedEvents
    .slice(lastToolIndex + 1)
    .flatMap((event) => (event.type === "text" && event.text ? [event.text] : []));
  const textSegments =
    lastToolIndex >= 0
      ? textSegmentsAfterLastTool
      : projectedEvents.flatMap((event) => (event.type === "text" && event.text ? [event.text] : []));
  const text = textSegments.join("");

  // Extract PR/branch info
  let prUrl: string | undefined;
  let branchName: string | undefined;
  for (const e of promptEvents) {
    if (
      e.type === "publish.pr.created" ||
      e.type === "pr_created" ||
      e.type === "publish.pr.updated" ||
      e.type === "pr_updated"
    ) {
      prUrl = e.data?.prUrl as string | undefined;
      branchName = e.data?.branchName as string | undefined;
    }
  }

  return { text, prUrl, branchName };
}

/**
 * Header-only patterns. These can appear in legitimate answers (e.g., "the
 * Repository: header in your prompt is …"), so on their own they are NOT
 * sufficient to trigger a strip. The strip runs only when the leading block
 * also contains a strong artifact signal (see `STRONG_ARTIFACT_LINE_PATTERNS`
 * and the block-tag detection in `stripPromptArtifacts`).
 */
const PROMPT_HEADER_LINE_PATTERNS = [
  /^Current Slack message author\b.*[.:]/i,
  /^Repository:/i,
  /^Jira Issue:/i,
  /^Linear Issue:/i,
  /^GitHub Issue:/i,
  /^Issue (?:URL|title|summary|body|description|metadata)\s*[.:]/i,
  /^Recent comments\s*[.:]/i,
  /^Triggering comment\s*[.:]/i,
  /^Thread context(?:\s*\([^)]*\))?\s*[.:]/i,
];

/**
 * Strong artifact signals. Any one of these in the leading block is proof
 * we're looking at scaffolding rather than a real answer. Unlike header
 * patterns, these have no realistic false-positive shape — an assistant
 * response wouldn't open with `<user_content>` or the untrusted-input
 * IMPORTANT line.
 */
const STRONG_ARTIFACT_LINE_PATTERNS = [
  /^IMPORTANT: The content above is untrusted user input\b/,
  /^<\/(?:user_content|system-reminder|instruction_content)\b/i,
];

/** Tags that bound multi-line prompt-injection blocks. */
const PROMPT_BLOCK_TAGS = ["user_content", "system-reminder", "instruction_content"] as const;
type PromptBlockTag = (typeof PROMPT_BLOCK_TAGS)[number];

const PROMPT_BLOCK_OPEN_RE = new RegExp(`^<(${PROMPT_BLOCK_TAGS.join("|")})\\b`, "i");

function isBlockClosingLine(line: string, tag: PromptBlockTag): boolean {
  return new RegExp(`</${tag}\\b`, "i").test(line);
}

/**
 * Strip leading prompt-injection / prompt-metadata scaffolding from an
 * outcome string. Two-pass design:
 *
 *   1. Walk the leading block, detecting header lines, strong-signal lines,
 *      and `<user_content>…</user_content>`-style tagged blocks. Track
 *      whether at least one strong signal (or open block tag) appeared.
 *   2. If a strong signal was found, drop everything up to the first non-
 *      artifact line. If only header lines were seen with no strong signal,
 *      return the text unchanged — header text alone is too weak to commit
 *      to a strip when the agent might legitimately open with that phrase.
 *
 * This closes two gaps in the original line-by-line stripper: multi-line
 * `<user_content>` blocks now skip their inner content (CodeRabbit / Greptile
 * P2), and legitimate answers that start with a header phrase aren't eaten
 * (ChatGPT P2).
 */
function stripPromptArtifacts(text: string): string {
  const lines = text.split(/\r?\n/);

  let scanIdx = 0;
  let hasStrongSignal = false;
  let openBlockTag: PromptBlockTag | null = null;

  while (scanIdx < lines.length) {
    const trimmed = lines[scanIdx]!.trim();

    if (openBlockTag) {
      if (isBlockClosingLine(trimmed, openBlockTag)) openBlockTag = null;
      scanIdx++;
      continue;
    }

    if (!trimmed) {
      scanIdx++;
      continue;
    }

    const blockTagMatch = trimmed.match(PROMPT_BLOCK_OPEN_RE);
    if (blockTagMatch) {
      const tag = blockTagMatch[1]!.toLowerCase() as PromptBlockTag;
      hasStrongSignal = true;
      // Same-line close (`<user_content>…</user_content>`) is consumed in one
      // pass; otherwise we enter the block and skip until the matching close.
      if (!isBlockClosingLine(trimmed, tag)) openBlockTag = tag;
      scanIdx++;
      continue;
    }

    if (STRONG_ARTIFACT_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      hasStrongSignal = true;
      scanIdx++;
      continue;
    }

    if (PROMPT_HEADER_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      scanIdx++;
      continue;
    }

    break;
  }

  if (!hasStrongSignal) return text.trim();
  return lines.slice(scanIdx).join("\n").trim();
}

const VERIFICATION_HEADING_RE = /^#{2,6}\s*Verification\b/i;
const CHECKS_PARAGRAPH_RE = /^Checks(?: run)?\s*:\s*$/i;
const LIST_ITEM_RE = /^\s*(?:[-*+] |\d+[.)] )/;
const COMMIT_REFERENCE_RE = /^Committed as\s+`?[0-9a-f]{7,40}`?(?:\s*\([^)]*\))?\s*$/i;

/**
 * Omit trailing implementation verification detail from Slack while leaving
 * the model's outcome untouched. The heading is the explicit bridge contract;
 * the paragraph fallbacks preserve readable replies from older/non-compliant
 * backends. If a cut would empty the reply, retain the source text instead.
 */
function stripVerificationSection(text: string): string {
  const lines = text.split(/\r?\n/);
  let inCodeFence = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (!inCodeFence && VERIFICATION_HEADING_RE.test(line)) {
      const outcome = lines.slice(0, index).join("\n").trim();
      return outcome || text.trim();
    }
  }

  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const original = paragraphs.join("\n\n");

  const trailingCommit = paragraphs.at(-1);
  const removedCommitReference = trailingCommit !== undefined && COMMIT_REFERENCE_RE.test(trailingCommit);
  if (removedCommitReference) paragraphs.pop();

  const trailing = paragraphs.at(-1);
  if (removedCommitReference && trailing) {
    const lines = trailing.split(/\r?\n/);
    const firstLine = lines[0]!.trim();
    const isChecksList =
      CHECKS_PARAGRAPH_RE.test(firstLine) &&
      lines.length > 1 &&
      lines.slice(1).every((line) => LIST_ITEM_RE.test(line));
    if (isChecksList) paragraphs.pop();
  }

  const outcome = paragraphs.join("\n\n").trim();
  return outcome || original;
}

const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

function transformOutsideInlineCode(line: string, transform: (text: string) => string): string {
  return line
    .split(/(`+[^`]*`+)/g)
    .map((part) => (part.startsWith("`") ? part : transform(part)))
    .join("");
}

function normalizeMarkdownInlineForSlack(text: string): string {
  return text.replace(MARKDOWN_LINK_RE, "<$2|$1>").replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
}

function normalizeMarkdownHeadingForSlack(text: string): string {
  const normalized = transformOutsideInlineCode(text, normalizeMarkdownInlineForSlack);
  return transformOutsideInlineCode(normalized, (part) => part.replace(/\*([^*\n]+)\*/g, "$1"));
}

function normalizeAssistantMarkdownForSlack(text: string): string {
  let inCodeFence = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const codeFenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (codeFenceMatch) {
        const wasInCodeFence = inCodeFence;
        if (!wasInCodeFence && line.slice(codeFenceMatch[0].length).includes(codeFenceMatch[1]!)) return line;
        inCodeFence = !inCodeFence;
        return wasInCodeFence ? line : codeFenceMatch[0];
      }
      if (inCodeFence) return line;

      const headingMatch = line.match(/^(\s*)#{1,6}\s+(.+?)\s*#*\s*$/);
      if (headingMatch) {
        const indent = headingMatch[1] ?? "";
        const heading = normalizeMarkdownHeadingForSlack(headingMatch[2]!.trim());
        return `${indent}*${heading}*`;
      }

      return transformOutsideInlineCode(line, normalizeMarkdownInlineForSlack);
    })
    .join("\n");
}

function slackOutcomeText(text: string): string {
  if (!text) return "";
  const stripped = stripPromptArtifacts(text);
  if (!stripped) return "";
  const outcome = stripVerificationSection(stripped);
  // Escape Slack control sequences on the untrusted model text BEFORE markdown
  // normalization (normalization itself produces the intended <url|label> links
  // from [text](url), which a later escape would break). This blocks
  // <!channel>/<@user>/<url|label> injection from any model output — including
  // automated digests posted to shared channels like #changelog.
  return normalizeAssistantMarkdownForSlack(escapeSlackMrkdwnText(outcome));
}

const SLACK_PARAGRAPH_TRUNCATION_SUFFIX = " ...truncated for Slack";
const SLACK_OMITTED_SUFFIX = "_Additional reply content omitted in Slack; open the session for the full answer._";

/**
 * Split a full reply into paragraphs for Slack sections. Single newlines
 * inside a paragraph are preserved so lists and indented code survive. This
 * stays full-fidelity by default, but enforces Slack's hard block and section
 * limits so delivery does not fail on very long answers.
 */
function paragraphsForOutcome(text: string, maxParagraphs = SLACK_BLOCK_KIT_MAX_BLOCKS): string[] {
  const stripped = slackOutcomeText(text);
  if (!stripped) return [];

  const paragraphs = stripped
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/[ \t]+\n/g, "\n").trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => truncateParagraphForSlack(paragraph));

  if (paragraphs.length <= maxParagraphs) return paragraphs;
  if (maxParagraphs <= 0) return [];
  if (maxParagraphs === 1) return [SLACK_OMITTED_SUFFIX];
  return [...paragraphs.slice(0, maxParagraphs - 1), SLACK_OMITTED_SUFFIX];
}

function truncateParagraphForSlack(paragraph: string): string {
  if (paragraph.length <= SLACK_BLOCK_SECTION_TEXT_LIMIT) return paragraph;

  const available = SLACK_BLOCK_SECTION_TEXT_LIMIT - SLACK_PARAGRAPH_TRUNCATION_SUFFIX.length;
  if (available <= 0) return SLACK_PARAGRAPH_TRUNCATION_SUFFIX.trim();
  return paragraph.slice(0, available).trimEnd() + SLACK_PARAGRAPH_TRUNCATION_SUFFIX;
}

const EMPTY_OUTCOME_PLACEHOLDER = "_No reply produced — open the session for details._";
/** Plain-text version of the placeholder for fallback strings (no Slack mrkdwn). */
const EMPTY_OUTCOME_PLACEHOLDER_PLAIN = "No reply produced — open the session for details.";

/**
 * Chrome-free blocks for a scheduled-automation digest (e.g. the daily
 * changelog). The whole final message IS the digest, delivered as a single
 * plain top-level Slack post — no status headline, no action buttons. Text is
 * routed through the same escape-before-normalize + truncation pipeline as the
 * status card (`paragraphsForOutcome`), so `<!channel>` / `<@user>` /
 * `<url|label>` injection stays neutralized and the block/length caps apply. An
 * empty outcome renders the placeholder so the delivery is still visible and the
 * delivered/empty metric stays honest.
 */
export function buildPlainDigestBlocks(text: string): unknown[] {
  const paragraphs = paragraphsForOutcome(text);
  if (paragraphs.length === 0) {
    return [{ type: "section", text: { type: "mrkdwn", text: EMPTY_OUTCOME_PLACEHOLDER } }];
  }
  return paragraphs.map((paragraph) => ({ type: "section", text: { type: "mrkdwn", text: paragraph } }));
}

/** Plain-text notification fallback for {@link buildPlainDigestBlocks}. */
export function buildPlainDigestFallbackText(text: string): string {
  const outcome = slackOutcomeText(text);
  if (!outcome) return EMPTY_OUTCOME_PLACEHOLDER_PLAIN;
  const firstLine = outcome.split("\n").find((line) => line.trim().length > 0);
  return (firstLine ?? outcome).slice(0, 200);
}

/** Plain-text version of the omitted-content marker for fallback strings (no Slack mrkdwn). */
const SLACK_OMITTED_SUFFIX_PLAIN = "Additional reply content omitted in Slack; open the session for the full answer.";

/**
 * Build the outcome string for fallback text from the same capped paragraphs
 * the blocks render, then hard-cap the joined result at Slack's 40k message
 * `text` limit (50 section-sized paragraphs can exceed it) so Slack never
 * silently truncates the fallback.
 */
function fallbackOutcome(summaryText?: string, maxParagraphs = SLACK_BLOCK_KIT_MAX_BLOCKS): string {
  if (!summaryText) return "";
  const joined = paragraphsForOutcome(summaryText, maxParagraphs).join("\n\n");
  if (joined.length <= SLACK_MESSAGE_TEXT_LIMIT) return joined;

  const available = SLACK_MESSAGE_TEXT_LIMIT - SLACK_OMITTED_SUFFIX_PLAIN.length - 2;
  return `${joined.slice(0, available).trimEnd()}\n\n${SLACK_OMITTED_SUFFIX_PLAIN}`;
}

function failureLabel(errorCode?: ErrorCode | null): string | null {
  return errorCode && isErrorCode(errorCode) ? errorCodeLabel(errorCode) : null;
}

function failureHint(errorCode?: ErrorCode | null): string | null {
  return errorCode && isErrorCode(errorCode) ? errorCodeHint(errorCode) : null;
}

/**
 * Card lifecycle stage: the `Phase` union projected onto the status card, plus
 * the pre-session `starting` value (posted before the DO has any phase) and
 * `done` (the terminal render of the `completed` phase). Keep this in lockstep
 * with `slackStatusStageForPhase` below — that map is `tsc`-total over `Phase`.
 */
export type SlackStatusStage =
  | "starting"
  | "running"
  | "waiting_for_input"
  | "finalizing"
  | "review_listening"
  | "done"
  | "failed"
  | "blocked"
  | "stopped"
  | "superseded"
  | "archived";

/**
 * Total Phase → card-stage projection. `idle` renders as the starting card
 * (session exists, nothing running yet); `completed` renders as `done`.
 */
const SLACK_STATUS_STAGE_FOR_PHASE = {
  idle: "starting",
  running: "running",
  waiting_for_input: "waiting_for_input",
  finalizing: "finalizing",
  review_listening: "review_listening",
  completed: "done",
  superseded: "superseded",
  blocked: "blocked",
  failed: "failed",
  stopped: "stopped",
  archived: "archived",
} as const satisfies Record<Phase, SlackStatusStage>;

export function slackStatusStageForPhase(phase: Phase): SlackStatusStage {
  return SLACK_STATUS_STAGE_FOR_PHASE[phase];
}

/** `cycloid:<kind>:<requestId>` — the interactions-webhook dispatch namespace. */
export function slackInteractionActionId(kind: SlackInteractionKind, requestId: string): string {
  return `${SLACK_INTERACTION_ACTION_PREFIX}:${kind}:${requestId}`;
}

export interface SlackStatusBlocksInput {
  stage: SlackStatusStage;
  sessionId: string;
  frontendUrl: string;
  repoFullName?: string;
  repoHint?: "default" | "inferred" | null;
  summaryText?: string;
  prUrl?: string;
  prNumber?: number;
  /**
   * Branch name produced by the prompt, if any. Distinguishes a coding-flow
   * completion that pushed a branch but didn't open a PR (still a coding
   * outcome — show "Done on repo") from a Q&A reply that produced no code
   * artifacts at all (show "Reply").
   */
  branchName?: string;
  errorCode?: ErrorCode | null;
  /**
   * Render only lifecycle status, not the prompt answer. Used for the durable
   * Slack status card when prompt answers are posted as separate replies.
   */
  statusOnly?: boolean;
  /**
   * Deterministic live-activity line ("Working on: …", "Running tests").
   * Rendered as a context line under the headline, only while running.
   */
  narrationLine?: string;
  /**
   * Verification/QA lifecycle for the session's PR (legacy status source —
   * `getSessionExtended`, NOT the FSM projection; see docs/fsm.md cutover
   * rules). Absent when the caller has no session row (e.g. the pre-session
   * starting card) — renders as "not verified" on terminal cards.
   */
  verificationState?: VerificationState | null;
  verificationResult?: VerificationResult | null;
  /**
   * Pending `slack_interaction_requests` row ids backing the Resume/Retry
   * buttons. A button renders ONLY when its id is present AND the stage is in
   * the control-affordance set — callers mint/reuse rows via
   * `syncCardControlRequests` so re-renders never explode rows.
   */
  resumeRequestId?: string;
  retryRequestId?: string;
}

type SlackPrChecksState = "pending" | "passed" | "failed";

type SlackPrDiffStats = Pick<PrReadinessEvidence["diffStats"], "filesChanged" | "insertions" | "deletions">;

export interface SlackMessageRender {
  text: string;
  blocks: unknown[];
  attachments?: unknown[];
}

export interface SlackPrOpenedCardInput {
  sessionId: string;
  frontendUrl: string;
  prUrl: string;
  prNumber?: number;
  prTitle?: string | null;
  repoFullName?: string;
  branchName?: string | null;
  diffStats?: SlackPrDiffStats | null;
  checksState: SlackPrChecksState;
  reviewersText?: string | null;
}

function statusEmoji(stage: SlackStatusStage): string {
  switch (stage) {
    case "starting":
      return ":hourglass_flowing_sand:";
    case "running":
      return ":runner:";
    case "waiting_for_input":
      return ":speech_balloon:";
    case "finalizing":
      return ":package:";
    case "review_listening":
      return ":eyes:";
    case "done":
      return ":white_check_mark:";
    case "failed":
      return ":warning:";
    case "blocked":
      return ":no_entry:";
    case "stopped":
      return ":octagonal_sign:";
    case "superseded":
      return ":fast_forward:";
    case "archived":
      return ":file_cabinet:";
  }
}

function statusLabel(stage: SlackStatusStage, errorCode?: ErrorCode | null, isQaReply = false): string {
  switch (stage) {
    case "failed": {
      const label = failureLabel(errorCode);
      return label ? `Failed: ${label}` : "Failed";
    }
    case "done":
      return isQaReply ? "Reply" : "Done";
    case "running":
      return "Running";
    case "waiting_for_input":
      return "Waiting for your answer";
    case "finalizing":
      return "Publishing…";
    case "review_listening":
      return "Watching PR review";
    case "blocked":
      return "Blocked";
    case "stopped":
      return "Stopped";
    case "superseded":
      return "Superseded";
    case "archived":
      return "Archived";
    case "starting":
      return "Starting";
  }
}

/**
 * Calibrated verification outcome for the card (copy principle: honest,
 * non-mechanical). `null`/absent verification data means no verification ever
 * applied or ran — stated as "not verified", never silently omitted.
 */
export function verificationOutcomeLabel(
  state: VerificationState | null | undefined,
  result: VerificationResult | null | undefined,
): string {
  switch (state ?? null) {
    case null:
      return "not verified";
    case "verification-pending":
      return "verification pending";
    case "verification-in-progress":
      return "verification running";
    case "verification-done":
      return result === "merge-ready"
        ? "verification passed"
        : result === "needs-work"
          ? "verification found issues"
          : "verification inconclusive";
    case "verification-skipped":
      return "verification skipped";
    case "verification-stopped":
      return "verification stopped";
    case "verification-exhausted":
      return "verification exhausted";
  }
}

/**
 * Calibrated done/failed: terminal cards always state the verification
 * outcome — never a bare "Done". Q&A replies (no PR, no branch) are exempt:
 * verification is meaningless for a conversational answer.
 */
function terminalStatusWithVerification(input: SlackStatusBlocksInput, status: string, qaReply: boolean): string {
  if (qaReply || (input.stage !== "done" && input.stage !== "failed")) return status;
  return `${status} — ${verificationOutcomeLabel(input.verificationState, input.verificationResult)}`;
}

/**
 * Verification/QA substage detail line for live post-publish cards. Rendered
 * only on `review_listening` (the phase FSM VERIFYING projects onto) when
 * verification data exists; terminal cards fold the outcome into the headline
 * instead.
 */
function verificationDetailLine(input: SlackStatusBlocksInput): string | null {
  if (input.stage !== "review_listening" || !input.verificationState) return null;
  const label = verificationOutcomeLabel(input.verificationState, input.verificationResult);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * A "Q&A reply" is a successful prompt that produced no code artifacts at
 * all — no PR and no branch. A coding session that pushed a branch but
 * didn't open a PR (e.g., repo config skips auto-PR) still gets the
 * coding-flow "Done on repo" treatment because there's a branch to point
 * at, even without a PR link.
 */
function isQaReply(stage: SlackStatusStage, prUrl?: string, branchName?: string): boolean {
  if (stage !== "done") return false;
  return !prUrl && !branchName;
}

function repoHintText(repoHint?: "default" | "inferred" | null): string {
  if (repoHint === "default") return " (your default repo)";
  if (repoHint === "inferred") return " (inferred from Slack context)";
  return "";
}

function prLabel(prUrl: string, prNumber?: number): string {
  return prNumber ? `<${prUrl}|PR #${prNumber}>` : `<${prUrl}|PR>`;
}

export function buildStatusBlocks(input: SlackStatusBlocksInput): unknown[] {
  const {
    stage,
    sessionId,
    frontendUrl,
    repoFullName,
    repoHint,
    summaryText,
    prUrl,
    prNumber,
    branchName,
    errorCode,
    statusOnly,
    narrationLine,
    resumeRequestId,
    retryRequestId,
  } = input;
  const qaReply = !statusOnly && isQaReply(stage, prUrl, branchName);
  const status = terminalStatusWithVerification(input, statusLabel(stage, errorCode, qaReply), qaReply);
  const hint = stage === "failed" ? failureHint(errorCode) : null;
  // Q&A replies hide the repo context — repo is irrelevant when the agent
  // just answered a question and produced no PR.
  const repoText = !qaReply && repoFullName ? ` on \`${repoFullName}\`${repoHintText(repoHint)}` : "";
  const headlineParts = [`${statusEmoji(stage)} *${status}*${repoText}`];
  if (prUrl) headlineParts.push(`- ${prLabel(prUrl, prNumber)}`);

  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: headlineParts.join(" ") },
    },
  ];

  // Narration is live-activity copy; it only makes sense while running. It's the
  // card's most alive element, so render it as a prominent section (not a muted
  // context line).
  if (stage === "running" && narrationLine) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: escapeSlackMrkdwnText(narrationLine) },
    });
  }

  // Verification/QA substage detail line. FSM VERIFYING projects onto the
  // review_listening phase (no "verifying" Phase exists), so the QA run is
  // narrated as a detail line under "Watching PR review".
  const verificationDetail = verificationDetailLine(input);
  if (verificationDetail) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: verificationDetail }],
    });
  }

  if (hint) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: hint },
    });
  }

  const narrationBlockCount = (stage === "running" && narrationLine ? 1 : 0) + (verificationDetail ? 1 : 0);
  if (statusOnly) {
    // The durable status card should stay a compact lifecycle indicator. The
    // prompt answer is posted as its own Slack reply.
  } else {
    const fixedBlockCount = 1 + narrationBlockCount + (hint ? 1 : 0) + 1;
    const maxParagraphs = Math.max(0, SLACK_BLOCK_KIT_MAX_BLOCKS - fixedBlockCount);
    const paragraphs = summaryText ? paragraphsForOutcome(summaryText, maxParagraphs) : [];
    if (paragraphs.length === 0) {
      // Q&A replies have no PR/branch headline to stand on, so an empty
      // outcome gets a placeholder; coding outcomes already show the PR link.
      if (qaReply) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: EMPTY_OUTCOME_PLACEHOLDER },
        });
      }
    } else {
      for (const paragraph of paragraphs) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: paragraph },
        });
      }
    }
  }

  const sessionUrl = `${frontendUrl}/sessions/${sessionId}`;
  const actionElements: unknown[] = [];
  if (prUrl) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "View PR" },
      url: prUrl,
      action_id: "view_pr",
    });
  }
  // Stop applies while a prompt is live (running or waiting on a question) —
  // mirrors `isStopAvailable`'s phase floor.
  if (stage === "running" || stage === "waiting_for_input") {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Stop" },
      style: "danger",
      value: sessionId,
      action_id: "stop_session",
    });
  }
  // Resume/Retry bind to a pending slack_interaction_requests row (single
  // consume, server-side re-authz in the dispatcher). Rendered only when the
  // stage is in the control-affordance set AND the caller minted/reused a row.
  if (SLACK_RESUME_CONTROL_STAGES.has(stage) && resumeRequestId) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Resume" },
      style: "primary",
      value: sessionId,
      action_id: slackInteractionActionId(SlackInteractionKind.ResumeSession, resumeRequestId),
    });
  }
  if (SLACK_RETRY_CONTROL_STAGES.has(stage) && retryRequestId) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Retry" },
      style: "primary",
      value: sessionId,
      action_id: slackInteractionActionId(SlackInteractionKind.RetrySession, retryRequestId),
    });
  }
  actionElements.push({
    type: "button",
    text: { type: "plain_text", text: "View Session" },
    url: sessionUrl,
    action_id: "view_session",
  });
  blocks.push({
    type: "actions",
    elements: actionElements,
  });

  return blocks;
}

export function buildStatusFallbackText(input: SlackStatusBlocksInput): string {
  const {
    stage,
    frontendUrl,
    sessionId,
    repoFullName,
    repoHint,
    summaryText,
    prUrl,
    prNumber,
    branchName,
    errorCode,
    statusOnly,
    narrationLine,
  } = input;
  const qaReply = !statusOnly && isQaReply(stage, prUrl, branchName);
  const status = terminalStatusWithVerification(input, statusLabel(stage, errorCode, qaReply), qaReply);
  const hint = stage === "failed" ? failureHint(errorCode) : null;
  const repoText = !qaReply && repoFullName ? ` on ${repoFullName}${repoHintText(repoHint)}` : "";
  const narrationText = stage === "running" && narrationLine ? narrationLine : null;
  const verificationDetail = verificationDetailLine(input);
  // Mirror buildStatusBlocks' paragraph cap (headline + optional narration +
  // optional verification detail + optional hint + actions) so the fallback
  // never carries paragraphs the blocks omit.
  const fixedBlockCount = 1 + (narrationText ? 1 : 0) + (verificationDetail ? 1 : 0) + (hint ? 1 : 0) + 1;
  const maxParagraphs = Math.max(0, SLACK_BLOCK_KIT_MAX_BLOCKS - fixedBlockCount);
  const outcome = statusOnly
    ? ""
    : fallbackOutcome(summaryText, maxParagraphs) || (qaReply ? EMPTY_OUTCOME_PLACEHOLDER_PLAIN : "");
  const details = [narrationText, verificationDetail, hint, outcome].filter((value): value is string => Boolean(value));
  const prText = prUrl ? ` | PR: ${prNumber ? `#${prNumber} ` : ""}${prUrl}` : "";
  const sessionText = ` | Session: ${frontendUrl}/sessions/${sessionId}`;
  return `${status}${repoText}${details.length > 0 ? ` - ${details.join(" | ")}` : ""}${prText}${sessionText}`;
}

type SlackPromptReplyStage = Extract<SlackStatusStage, "done" | "failed">;

interface SlackPromptReplyBlocksInput {
  stage: SlackPromptReplyStage;
  replyToText?: string | null;
  quoteContext?: SlackQuotedReplyContext | null;
  summaryText?: string;
}

type SlackMrkdwnSectionBlock = {
  type: "section";
  text: { type: "mrkdwn"; text: string };
};

export type SlackRichTextInlineElement =
  | { type: "text"; text: string }
  | { type: "user"; user_id: string }
  | { type: "channel"; channel_id: string }
  | { type: "link"; url: string; text?: string }
  | { type: "broadcast"; range: "here" | "channel" | "everyone" };

export type SlackRichTextBlock = {
  type: "rich_text";
  elements: Array<{
    type: "rich_text_quote";
    elements: SlackRichTextInlineElement[];
  }>;
};

export interface SlackQuotedReplySource {
  lines: SlackRichTextInlineElement[][];
}

const SLACK_REPLY_QUOTE_TRUNCATION_SUFFIX = " ...truncated";

export function escapeSlackMrkdwnText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function normalizeSlackMrkdwnText(text: string): string {
  return text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function truncateSlackQuoteText(text: string): string {
  if (text.length <= SLACK_REPLY_QUOTE_TEXT_LIMIT) return text;

  const searchLimit = SLACK_REPLY_QUOTE_TEXT_LIMIT - SLACK_REPLY_QUOTE_TRUNCATION_SUFFIX.length - 2;
  const threshold = Math.floor(SLACK_REPLY_QUOTE_TEXT_LIMIT * SLACK_SMART_TRUNCATION_THRESHOLD);
  const lastNewline = text.lastIndexOf("\n", searchLimit);
  const lastPeriod = text.lastIndexOf(".", searchLimit);
  const breakPoint = Math.max(lastNewline, lastPeriod);
  const safeCut = breakPoint > threshold ? breakPoint + 1 : searchLimit;

  return text.slice(0, safeCut).trimEnd() + SLACK_REPLY_QUOTE_TRUNCATION_SUFFIX;
}

export interface SlackQuotedReplyContext {
  block: SlackRichTextBlock | SlackMrkdwnSectionBlock;
  fallback: string;
}

function isSlackQuotedReplyTextElement(value: unknown): value is Extract<SlackRichTextInlineElement, { type: "text" }> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function isSlackQuotedReplyUserElement(value: unknown): value is Extract<SlackRichTextInlineElement, { type: "user" }> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "user" &&
    typeof (value as { user_id?: unknown }).user_id === "string"
  );
}

function isSlackQuotedReplyChannelElement(
  value: unknown,
): value is Extract<SlackRichTextInlineElement, { type: "channel" }> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "channel" &&
    typeof (value as { channel_id?: unknown }).channel_id === "string"
  );
}

function isSlackQuotedReplyLinkElement(value: unknown): value is Extract<SlackRichTextInlineElement, { type: "link" }> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "link" &&
    typeof (value as { url?: unknown }).url === "string" &&
    ((value as { text?: unknown }).text === undefined || typeof (value as { text?: unknown }).text === "string")
  );
}

function isSlackQuotedReplyBroadcastElement(
  value: unknown,
): value is Extract<SlackRichTextInlineElement, { type: "broadcast" }> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "broadcast" &&
    ((value as { range?: unknown }).range === "here" ||
      (value as { range?: unknown }).range === "channel" ||
      (value as { range?: unknown }).range === "everyone")
  );
}

function isSlackQuotedReplyInlineElement(value: unknown): value is SlackRichTextInlineElement {
  return (
    isSlackQuotedReplyTextElement(value) ||
    isSlackQuotedReplyUserElement(value) ||
    isSlackQuotedReplyChannelElement(value) ||
    isSlackQuotedReplyLinkElement(value) ||
    isSlackQuotedReplyBroadcastElement(value)
  );
}

export function parseSlackQuotedReplySource(raw: unknown): SlackQuotedReplySource | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { lines?: unknown }).lines)) return null;
  const lines: SlackRichTextInlineElement[][] = [];
  for (const line of (raw as { lines: unknown[] }).lines) {
    if (!Array.isArray(line) || !line.every((element) => isSlackQuotedReplyInlineElement(element))) return null;
    lines.push([...line]);
  }
  return { lines };
}

const SLACK_ANY_TOKEN_RE = /<([^>\n]+)>/g;

function slackRichTextElementForToken(token: string): SlackRichTextInlineElement | null {
  const userMatch = token.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/);
  if (userMatch?.[1]) {
    return { type: "user", user_id: userMatch[1] };
  }

  const channelMatch = token.match(/^<#([A-Z0-9]+)(?:\|[^>]+)?>$/);
  if (channelMatch?.[1]) {
    return { type: "channel", channel_id: channelMatch[1] };
  }

  const linkMatch = token.match(/^<(https?:\/\/[^>|]+)(?:\|([^>]+))?>$/);
  if (linkMatch?.[1]) {
    return {
      type: "link",
      url: linkMatch[1],
      ...(linkMatch[2] ? { text: linkMatch[2] } : {}),
    };
  }

  const broadcastMatch = token.match(/^<!((?:here)|(?:channel)|(?:everyone))>$/);
  if (broadcastMatch?.[1] === "here" || broadcastMatch?.[1] === "channel" || broadcastMatch?.[1] === "everyone") {
    return { type: "broadcast", range: broadcastMatch[1] };
  }

  return null;
}

function slackRichTextElementsForQuoteLine(line: string): SlackRichTextInlineElement[] | null {
  const normalized = normalizeSlackMrkdwnText(line);
  const elements: SlackRichTextInlineElement[] = [];
  let cursor = 0;

  for (const match of normalized.matchAll(SLACK_ANY_TOKEN_RE)) {
    const token = match[0];
    const start = match.index;
    if (!token || start === undefined) continue;
    if (start > cursor) {
      elements.push({ type: "text", text: normalized.slice(cursor, start) });
    }

    const richTextElement = slackRichTextElementForToken(token);
    if (!richTextElement) return null;

    elements.push(richTextElement);
    cursor = start + token.length;
  }

  if (cursor < normalized.length) {
    elements.push({ type: "text", text: normalized.slice(cursor) });
  }

  return elements.length > 0 ? elements : [{ type: "text", text: normalized }];
}

function slackQuotedReplyTokenText(element: SlackRichTextInlineElement): string {
  switch (element.type) {
    case "text":
      return element.text;
    case "user":
      return `<@${element.user_id}>`;
    case "channel":
      return `<#${element.channel_id}>`;
    case "link":
      return element.text ? `${element.text} (${element.url})` : element.url;
    case "broadcast":
      return `@${element.range}`;
  }
}

function truncateSlackQuotedReplySourceLines(lines: SlackRichTextInlineElement[][]): SlackRichTextInlineElement[][] {
  const fullText = renderSlackQuotedReplySourceLines(lines);
  if (fullText.length <= SLACK_REPLY_QUOTE_TEXT_LIMIT) return lines;

  let remaining = Math.max(0, SLACK_REPLY_QUOTE_TEXT_LIMIT - SLACK_REPLY_QUOTE_TRUNCATION_SUFFIX.length);
  const truncated: SlackRichTextInlineElement[][] = [];

  for (let lineIndex = 0; lineIndex < lines.length && remaining >= 0; lineIndex++) {
    if (lineIndex > 0) {
      if (remaining <= 0) break;
      remaining -= 1;
    }
    const nextLine: SlackRichTextInlineElement[] = [];
    for (const element of lines[lineIndex] ?? []) {
      const elementText = slackQuotedReplyTokenText(element);
      if (elementText.length <= remaining) {
        nextLine.push(element);
        remaining -= elementText.length;
        continue;
      }

      if (remaining > 0 && element.type === "text") {
        nextLine.push({ type: "text", text: elementText.slice(0, remaining) });
        remaining = 0;
      }
      break;
    }
    truncated.push(nextLine);
  }

  if (truncated.length === 0) truncated.push([]);
  truncated[truncated.length - 1]!.push({ type: "text", text: SLACK_REPLY_QUOTE_TRUNCATION_SUFFIX });
  return truncated;
}

function renderSlackQuotedReplySourceLines(lines: SlackRichTextInlineElement[][]): string {
  return lines.map((line) => line.map((element) => slackQuotedReplyTokenText(element)).join("")).join("\n");
}

export function renderSlackQuotedReplySourceText(source?: SlackQuotedReplySource | null): string | null {
  if (!source?.lines?.length) return null;
  const rendered = renderSlackQuotedReplySourceLines(source.lines);
  return rendered.length > 0 ? rendered : null;
}

function flattenSlackQuotedReplySourceLines(lines: SlackRichTextInlineElement[][]): SlackRichTextInlineElement[] {
  const elements: SlackRichTextInlineElement[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) elements.push({ type: "text", text: "\n" });
    if (lines[index]?.length) {
      elements.push(...lines[index]!);
    } else {
      elements.push({ type: "text", text: " " });
    }
  }
  return elements;
}

export function buildQuotedReplyContextFromSource(
  source?: SlackQuotedReplySource | null,
): SlackQuotedReplyContext | null {
  if (!source?.lines?.length) return null;
  const truncatedLines = truncateSlackQuotedReplySourceLines(source.lines);
  const rendered = renderSlackQuotedReplySourceLines(truncatedLines);
  if (!rendered.trim()) return null;

  return {
    block: {
      type: "rich_text",
      elements: [{ type: "rich_text_quote", elements: flattenSlackQuotedReplySourceLines(truncatedLines) }],
    },
    fallback: rendered
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n"),
  };
}

export function buildQuotedReplyContext(replyToText?: string | null): SlackQuotedReplyContext | null {
  const trimmed = replyToText?.trim();
  if (!trimmed) return null;

  const truncated = truncateSlackQuoteText(trimmed);
  const rawLines = truncated.split(/\r?\n/);
  const normalizedLines = rawLines.map((line) => normalizeSlackMrkdwnText(line.length > 0 ? line : " "));
  const quoted = normalizedLines.map((line) => `> ${line}`).join("\n");
  const quoteElements: SlackRichTextInlineElement[] = [];
  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index]!;
    const richTextElements = slackRichTextElementsForQuoteLine(line.length > 0 ? line : " ");
    if (!richTextElements) {
      return {
        block: slackMrkdwnSection(
          normalizedLines.map((quotedLine) => `> ${escapeSlackMrkdwnText(quotedLine)}`).join("\n"),
        ),
        fallback: quoted,
      };
    }
    if (index > 0) {
      quoteElements.push({ type: "text", text: "\n" });
    }
    quoteElements.push(...richTextElements);
  }

  return {
    block: {
      type: "rich_text",
      elements: [{ type: "rich_text_quote", elements: quoteElements }],
    },
    fallback: quoted,
  };
}

function slackMrkdwnSection(text: string): SlackMrkdwnSectionBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function buildPromptReplyBlocks(input: SlackPromptReplyBlocksInput): unknown[] {
  const { stage, replyToText, quoteContext, summaryText } = input;
  const quote = quoteContext ?? buildQuotedReplyContext(replyToText);
  const fixedBlockCount = quote ? 1 : 0;
  const maxParagraphs = Math.max(0, SLACK_BLOCK_KIT_MAX_BLOCKS - fixedBlockCount);
  const paragraphs = summaryText ? paragraphsForOutcome(summaryText, maxParagraphs) : [];

  if (paragraphs.length === 0) {
    // A failed prompt with no reply text posts no appended reply; the failure
    // status card already conveys the failure.
    if (stage !== "done") return [];
    return [...(quote ? [quote.block] : []), slackMrkdwnSection(EMPTY_OUTCOME_PLACEHOLDER)];
  }

  return [...(quote ? [quote.block] : []), ...paragraphs.map((paragraph) => slackMrkdwnSection(paragraph))];
}

export function buildPromptReplyFallbackText(input: SlackPromptReplyBlocksInput): string {
  const { stage, replyToText, quoteContext, summaryText } = input;
  const quote = quoteContext ?? buildQuotedReplyContext(replyToText);
  const fixedBlockCount = quote ? 1 : 0;
  const maxParagraphs = Math.max(0, SLACK_BLOCK_KIT_MAX_BLOCKS - fixedBlockCount);
  const outcome =
    fallbackOutcome(summaryText, maxParagraphs) || (stage === "done" ? EMPTY_OUTCOME_PLACEHOLDER_PLAIN : "");
  if (!outcome) return "";
  return quote ? `${quote.fallback}\n\n${outcome}` : outcome;
}

export const SLACK_REPO_DISAMBIGUATION_ACTION_ID = "repo_disambiguation_select";

// Slack static_select supports at most 100 options.
export const SLACK_REPO_DISAMBIGUATION_MAX_CANDIDATES = 100;

// Slack plain_text option labels are capped at 75 chars.
const SLACK_OPTION_TEXT_MAX_CHARS = 75;

interface RepoDisambiguationCandidateBlock {
  repoOwner: string;
  repoName: string;
}

export function buildRepoDisambiguationFallbackText(): string {
  return "I found more than one possible repo from this Slack context. Include `repo=owner/repo` in a new request to specify which repo to use.";
}

function slackOptionText(value: string): string {
  if (value.length <= SLACK_OPTION_TEXT_MAX_CHARS) return value;
  return `${value.slice(0, SLACK_OPTION_TEXT_MAX_CHARS - 3)}...`;
}

export function buildRepoDisambiguationBlocks(
  disambiguationId: string,
  candidates: readonly RepoDisambiguationCandidateBlock[],
): unknown[] {
  const options = candidates.map((candidate, index) => {
    const fullName = `${candidate.repoOwner}/${candidate.repoName}`;
    return {
      text: { type: "plain_text", text: slackOptionText(fullName) },
      value: `${disambiguationId}:${index}`,
    };
  });
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "I found more than one possible repo from this Slack context. Select a repo from the menu below, or include `repo=owner/repo` in a new request to use a different repo.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "static_select",
          placeholder: { type: "plain_text", text: "Select a repository" },
          action_id: `${SLACK_REPO_DISAMBIGUATION_ACTION_ID}:${disambiguationId}`,
          options,
        },
      ],
    },
  ];
}

// Checks state is conveyed by an emoji glyph and a text label; the PR-opened
// card renders inline (no attachment), so there is no accent-bar color helper.
function prChecksEmoji(state: SlackPrChecksState): string {
  switch (state) {
    case "passed":
      return ":white_check_mark:";
    case "failed":
      return ":x:";
    case "pending":
      return ":large_yellow_circle:";
  }
}

function prChecksLabel(state: SlackPrChecksState): string {
  switch (state) {
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "pending":
      return "Pending";
  }
}

function formatPrTitleLink(prUrl: string, prTitle?: string | null, prNumber?: number): string {
  const trimmedTitle = prTitle?.trim();
  if (trimmedTitle) {
    const safeTitle = escapeSlackMrkdwnText(trimmedTitle.replaceAll("|", "¦").replace(/\s+/g, " "));
    return `<${prUrl}|${safeTitle}>`;
  }
  if (prNumber) return `<${prUrl}|PR #${prNumber}>`;
  return `<${prUrl}|Open PR>`;
}

function formatPrBranchValue(branchName?: string | null): string {
  const trimmedBranch = branchName?.trim();
  return trimmedBranch ? `\`${escapeSlackMrkdwnText(trimmedBranch)}\`` : "Snapshot unavailable";
}

function formatPrDiffValue(diffStats?: SlackPrDiffStats | null): string {
  if (!diffStats) return "Snapshot unavailable";
  return `+${diffStats.insertions} -${diffStats.deletions}`;
}

function formatPrFilesChangedValue(diffStats?: SlackPrDiffStats | null): string {
  if (!diffStats) return "Snapshot unavailable";
  return `${diffStats.filesChanged} ${diffStats.filesChanged === 1 ? "file" : "files"}`;
}

function buildPrCardField(label: string, value: string): { type: "mrkdwn"; text: string } {
  return { type: "mrkdwn", text: `*${escapeSlackMrkdwnText(label)}*\n${value}` };
}

export function buildPrOpenedCard(input: SlackPrOpenedCardInput): SlackMessageRender {
  const sessionUrl = `${input.frontendUrl}/sessions/${input.sessionId}`;
  const reviewersText = input.reviewersText?.trim() || "Snapshot unavailable";
  const checksLabel = prChecksLabel(input.checksState);
  const cardBlocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: ":white_check_mark: *PR opened*" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${prChecksEmoji(input.checksState)} *${input.prNumber ? `PR #${input.prNumber}` : "PR"}*`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: formatPrTitleLink(input.prUrl, input.prTitle, input.prNumber) },
    },
    {
      type: "section",
      fields: [
        buildPrCardField("Branch", formatPrBranchValue(input.branchName)),
        buildPrCardField("Diff", formatPrDiffValue(input.diffStats)),
        buildPrCardField("Checks", checksLabel),
        buildPrCardField("Reviewers", escapeSlackMrkdwnText(reviewersText)),
        buildPrCardField("Files Changed", formatPrFilesChangedValue(input.diffStats)),
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: [
            input.repoFullName ? `\`${escapeSlackMrkdwnText(input.repoFullName)}\`` : null,
            "Snapshot at PR open",
            `<${sessionUrl}|Open session>`,
          ]
            .filter((part): part is string => !!part)
            .join(" • "),
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View PR" },
          url: input.prUrl,
          action_id: "view_pr",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "View Session" },
          url: sessionUrl,
          action_id: "view_session_pr_opened",
        },
      ],
    },
  ];

  // Render as top-level blocks, not a legacy attachment. An attachment would
  // buy a colored accent bar, but Slack wraps app-posted attachments in its own
  // chrome — a `Show more` truncation toggle and an `Added by Cycloid` footer —
  // which reads as junk. The checks state is already carried by the header glyph
  // and the `Checks` field, so the bar is not worth that chrome. With non-empty
  // `blocks`, the top-level `text` is now purely Slack's notification/
  // accessibility fallback and no longer doubles as a body line above the card.
  const prLabelText = input.prNumber ? `PR #${input.prNumber}` : "PR";
  const titleText = input.prTitle?.trim();
  const fallbackText = titleText ? `${prLabelText} opened: ${titleText}` : `${prLabelText} opened`;

  return {
    text: fallbackText,
    blocks: cardBlocks,
  };
}

/** Build Block Kit blocks for a "PR merged" Slack thread reply. */
/**
 * Notice posted when a PR is closed WITHOUT merging and that close archives the
 * session mid-thread. Names who closed it so a live Slack conversation is not
 * silently hard-terminated by a third party. `closedBy` is a GitHub login (not a
 * display name — the webhook sender carries only the login); null renders as
 * "someone". No action buttons: the archived summary card posted alongside this
 * notice already carries the View PR / View Session buttons.
 */
export function buildPrClosedBlocks(prUrl: string, closedBy: string | null): unknown[] {
  const who = closedBy ? `\`${closedBy}\`` : "someone";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `😔 Archiving this session - <${prUrl}|Associated PR> was closed by ${who}.`,
      },
    },
  ];
}

/**
 * "🚀 PR merged." thread notice. No action buttons: the archived summary card
 * repainted alongside this notice already carries the View PR / View Session
 * buttons, so repeating them here is pure duplication.
 */
export function buildPrMergedBlocks(): unknown[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: ":rocket: PR merged." },
    },
  ];
}
