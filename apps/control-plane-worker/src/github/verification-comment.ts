import { PR_PERSONAS, renderPersonaHeader } from "../../../../shared/agent/pr-personas.js";
import { parseVerifierTerminalResult } from "../../../../shared/agent/verification-result.js";
import type { VerificationArtifact, VerifierCheck, VerifierTerminalResult } from "../../../../shared/types/sandbox.js";
import {
  beginManagedPrCommentUpdate,
  type ManagedPrCommentIdentity,
  type ManagedPrCommentState,
  markManagedPrCommentPublished,
  releaseManagedPrCommentLease,
} from "../session/managed-pr-comments-db";
import type { Env } from "../types";
import { getInstallationByOwner } from "./installations-db";
import { createInstallationToken } from "./octokit";
import {
  type CommitCheckRun,
  type CommitStatusContext,
  createPrIssueComment,
  getCommitCheckRuns,
  getCommitStatusContexts,
  getPrHeadSha,
  isFailingCheckRun,
  listPrIssueComments,
  updateIssueComment,
} from "./pr";
import { containsManagedQaCommentMarker, qaCommentMarker as marker } from "./verification-comment-marker";
import { parseGithubPullRequestUrl } from "./verification-pr-context";

const MAX_COMMENT_BODY_BYTES = 16_000;
const COMMENT_BODY_TRUNCATION_NOTICE = "[truncated to fit GitHub comment size limit]";
// Bound the scorecard so it cannot crowd Blockers/footer out of the comment-body budget.
const MAX_RENDERED_CHECKS = 20;
const MAX_RENDERED_CHECK_DETAIL_CHARS = 200;

function parseVerifierTerminalResultObject(
  result: VerifierTerminalResult,
  fallbackHeadSha: string,
): ReturnType<typeof parseVerifierTerminalResult> {
  return parseVerifierTerminalResult(JSON.stringify(result), fallbackHeadSha);
}

export type ManagedVerificationCommentResult =
  | { ok: true; commentId: number; action: "created" | "updated"; malformed: boolean }
  | { ok: false; reason: "invalid_pr_url" | "missing_installation" | "github_failed" | "lease_busy" };

export type ManagedVerificationPublicationResult = ManagedVerificationCommentResult;

export type VerificationCommentTarget = {
  prUrl: string;
  installationId?: number | null;
  repoOwner?: string | null;
  repoName?: string | null;
  ownerSessionId?: string | null;
  promptId?: string | null;
  headSha?: string | null;
};

function managedCommentIdentity(input: {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  prUrl: string;
}): ManagedPrCommentIdentity {
  return {
    repoOwner: input.owner,
    repoName: input.repo,
    installationId: input.installationId,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    kind: "verification",
  };
}

async function gateManagedVerificationComment(args: {
  env: Env;
  identity: ManagedPrCommentIdentity;
  target: VerificationCommentTarget;
  state: ManagedPrCommentState;
  body: string;
}): Promise<
  | { apply: true; bodyHash: string; leaseOwner: string }
  | { apply: false; reason: "not_owner" | "stale_state" | "lease_busy" }
> {
  if (typeof args.env.DB?.prepare !== "function") return { apply: true, bodyHash: "", leaseOwner: "" };
  return beginManagedPrCommentUpdate(args.env.DB, {
    identity: args.identity,
    ownerSessionId: args.target.ownerSessionId ?? null,
    promptId: args.target.promptId ?? null,
    headSha: args.target.headSha ?? null,
    state: args.state,
    body: args.body,
  });
}

async function markManagedVerificationCommentPublished(args: {
  env: Env;
  identity: ManagedPrCommentIdentity;
  commentId: number;
  bodyHash: string;
  leaseOwner: string;
}): Promise<void> {
  if (typeof args.env.DB?.prepare !== "function" || !args.bodyHash) return;
  await markManagedPrCommentPublished(args.env.DB, args.identity, {
    commentId: args.commentId,
    bodyHash: args.bodyHash,
    leaseOwner: args.leaseOwner,
  });
}

async function releaseManagedVerificationCommentLease(args: {
  env: Env;
  identity: ManagedPrCommentIdentity;
  leaseOwner: string;
}): Promise<void> {
  if (typeof args.env.DB?.prepare !== "function" || !args.leaseOwner) return;
  await releaseManagedPrCommentLease(args.env.DB, args.identity, args.leaseOwner);
}

function renderManagedVerificationSkippedComment(input: {
  owner: string;
  repo: string;
  prNumber: number;
  summary: string;
  reasonCode?: string | null;
}): string {
  const reasonCode = input.reasonCode?.trim();
  const lines = [
    marker(input.owner, input.repo, input.prNumber, "skipped", "none"),
    "",
    renderPersonaHeader(PR_PERSONAS.cycloidQa),
    "",
    `QA testing skipped: ${input.summary.trim() || "routing determined QA evidence is not required."}`,
  ];
  if (reasonCode) lines.push("", `Reason: ${renderSkippedReason(reasonCode)}`);
  return lines.join("\n");
}

function renderSkippedReason(reasonCode: string): string {
  const normalized = reasonCode.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) + "." : "QA evidence was not required.";
}

function bodyByteLength(body: string): number {
  return new TextEncoder().encode(body).length;
}

function truncatePrefixToBytes(value: string, maxBytes: number): string {
  let remaining = Math.max(0, maxBytes);
  let truncated = "";
  for (const char of value) {
    const charBytes = bodyByteLength(char);
    if (charBytes > remaining) break;
    truncated += char;
    remaining -= charBytes;
  }
  return truncated;
}

function htmlBlockClosersForTruncatedComment(value: string): string {
  const stack: string[] = [];
  for (const match of value.matchAll(/<\/?(details|summary|pre|code)\b[^>]*>/gi)) {
    const tag = match[1].toLowerCase();
    if (match[0].startsWith("</")) {
      const index = stack.lastIndexOf(tag);
      if (index !== -1) stack.splice(index, 1);
    } else {
      stack.push(tag);
    }
  }
  return stack
    .reverse()
    .map((tag) => `</${tag}>`)
    .join("\n");
}

function truncatedCommentSuffix(value: string): string {
  const htmlClosers = htmlBlockClosersForTruncatedComment(value);
  return htmlClosers
    ? `\n${htmlClosers}\n\n${COMMENT_BODY_TRUNCATION_NOTICE}`
    : `\n\n${COMMENT_BODY_TRUNCATION_NOTICE}`;
}

function truncateForCommentBody(value: string, maxBytes: number): string {
  if (bodyByteLength(value) <= maxBytes) return value;
  let suffix = `\n\n${COMMENT_BODY_TRUNCATION_NOTICE}`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const truncated = truncatePrefixToBytes(value, maxBytes - bodyByteLength(suffix)).trimEnd();
    const nextSuffix = truncatedCommentSuffix(truncated);
    if (nextSuffix === suffix) break;
    suffix = nextSuffix;
  }
  const truncated = truncatePrefixToBytes(value, maxBytes - bodyByteLength(suffix)).trimEnd();
  if (bodyByteLength(suffix) > maxBytes) return truncatePrefixToBytes(suffix, maxBytes).trimEnd();
  return `${truncated.trimEnd()}${suffix}`;
}

function sectionList(values: string[], empty: string): string {
  if (values.length === 0) return empty;
  return values.map((value) => `- ${value}`).join("\n");
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

// GitHub auto-links bare URLs (`http(s)://`, `www.`) and emails even inside table cells,
// where backslash-escaping control characters does not stop them. Insert a zero-width space
// into each autolink trigger so the text still reads verbatim but yields no clickable target.
const ZERO_WIDTH_SPACE = "​";
function breakAutolinks(value: string): string {
  return value
    .replace(/:\/\//g, `:${ZERO_WIDTH_SPACE}//`)
    .replace(/\b(www)\./gi, `$1${ZERO_WIDTH_SPACE}.`)
    .replace(/(\w)@/g, `$1${ZERO_WIDTH_SPACE}@`);
}

// Agent-controlled text rendered into a public markdown table. Collapse newlines so a
// cell cannot break the table, backslash-escape markdown/HTML control characters
// (including `|`) so links, images, emphasis, code, and raw HTML render as literal text,
// then break bare URL/email autolinks that escaping alone leaves clickable.
function escapeMarkdownTableCell(value: string): string {
  return breakAutolinks(value.replace(/\s+/g, " ").replace(/[\\`*_[\]()<>~#!|]/g, (char) => `\\${char}`)).trim();
}

function renderVerifierChecks(checks: VerifierCheck[] | undefined): string[] {
  if (!checks?.length) return [];
  const rows = checks.slice(0, MAX_RENDERED_CHECKS).map((check) => {
    const name = escapeMarkdownTableCell(check.name) || "check";
    const escapedDetail = check.detail ? escapeMarkdownTableCell(check.detail) : "";
    const detail =
      escapedDetail.length > MAX_RENDERED_CHECK_DETAIL_CHARS
        ? `${escapedDetail.slice(0, MAX_RENDERED_CHECK_DETAIL_CHARS - 1).trimEnd()}…`
        : escapedDetail;
    return `| ${name} | ${check.status} | ${detail} |`;
  });
  return ["### Checks", "", "| Check | Status | Detail |", "| --- | --- | --- |", ...rows, ""];
}

function markdownLinkUrl(value: string): string {
  return value.trim().replace(/[\s<>]/g, (char) => encodeURIComponent(char));
}

function renderVerificationTranscriptFooter(sessionUrl: string | undefined): string | undefined {
  const url = sessionUrl?.trim();
  if (!url) return undefined;
  return ["### QA Transcript", "", `[View QA transcript](<${markdownLinkUrl(url)}>)`].join("\n");
}

function truncateForCommentBodyWithFooter(body: string, footer: string | undefined, maxBytes: number): string {
  if (!footer) return truncateForCommentBody(body, maxBytes);
  const footerBlock = `\n\n${footer}`;
  const footerBytes = bodyByteLength(footerBlock);
  if (footerBytes >= maxBytes) return truncateForCommentBody(footer.trim(), maxBytes);
  return `${truncateForCommentBody(body, maxBytes - footerBytes)}${footerBlock}`;
}

function renderVerificationArtifacts(artifacts: VerificationArtifact[] = []): string[] {
  const screenshots = artifacts.filter((artifact) => artifact.type === "screenshot");
  const videos = artifacts.filter((artifact) => artifact.type === "video");
  const textEvidence = artifacts.filter((artifact) => artifact.type === "log" && artifact.inlineText?.content);
  if (screenshots.length === 0 && videos.length === 0 && textEvidence.length === 0) return [];
  const lines = [""];
  if (screenshots.length > 0) {
    lines.push(
      "### Screenshots",
      "",
      ...screenshots.flatMap((artifact) => {
        const label = artifact.label.replace(/\s+/g, " ").trim() || "screenshot";
        const url = markdownLinkUrl(artifact.url);
        if (artifact.renderMode === "link") {
          return [`- [${escapeMarkdownLinkText(label)}](<${url}>)`];
        }
        return [
          `[${escapeMarkdownLinkText(label)}](<${url}>)`,
          `<img src="${escapeHtmlAttribute(url)}" width="720" alt="Cycloid QA screenshot: ${escapeHtmlAttribute(label)}" />`,
          "",
        ];
      }),
    );
  }
  if (videos.length > 0) {
    lines.push(
      "### Recordings",
      "",
      ...videos.map((artifact) => {
        const label = artifact.label.replace(/\s+/g, " ").trim() || "recording";
        const url = markdownLinkUrl(artifact.url);
        return `[${escapeMarkdownLinkText(label)}](<${url}>)`;
      }),
      "",
    );
  }
  if (textEvidence.length > 0) {
    lines.push(
      "### Evidence Files",
      "",
      ...textEvidence.flatMap((artifact) => {
        const label = artifact.label.replace(/\s+/g, " ").trim() || "evidence file";
        const inlineText = artifact.inlineText!;
        const sizeSuffix = inlineText.truncated
          ? ` (${inlineText.originalBytes} bytes, truncated)`
          : ` (${inlineText.originalBytes} bytes)`;
        return [
          "<details>",
          `<summary>${escapeHtmlText(label)}${escapeHtmlText(sizeSuffix)}</summary>`,
          "",
          `<pre><code>${escapeHtmlText(inlineText.content)}</code></pre>`,
          "</details>",
          "",
        ];
      }),
    );
  }
  return lines;
}

function outdatedHeadVerifierResult(
  result: VerifierTerminalResult,
  currentHeadSha: string | null,
): VerifierTerminalResult {
  const current = currentHeadSha ?? "unknown";
  return {
    ...result,
    verifiedHeadSha: result.verifiedHeadSha,
    summary: `${result.summary}\n\nVerified at \`${result.verifiedHeadSha}\`; current head is \`${current}\`, so newer commits are not yet verified.`,
    evidence: result.evidence,
    blockers: result.blockers,
  };
}
function headValidationFailureVerifierResult(result: VerifierTerminalResult, failure: string): VerifierTerminalResult {
  return {
    verdict: "INCONCLUSIVE",
    verifiedHeadSha: result.verifiedHeadSha,
    ...(result.needsWorkLabel ? { needsWorkLabel: result.needsWorkLabel } : { needsWorkLabel: "verification-gap" }),
    summary: `Verification could not validate the current PR head: ${failure}`,
    evidence: result.evidence,
    blockers: [
      `Could not fetch the current PR head to check whether the ${result.verdict} verdict is still current: ${failure}`,
      "Rerun QA testing after confirming the PR head.",
      ...result.blockers,
    ],
  };
}

function renderVerifierVerdict(result: VerifierTerminalResult): string {
  if (result.verdict === "CONCLUSIVE") return "Pass";
  const blockers = result.blockers ?? [];
  if (blockers.length > 0 && blockers.every(isLivePrGateBlocker)) {
    return blockers.some(isFailedLivePrGateBlocker) ? "Couldn't verify - CI failed" : "Couldn't verify - CI pending";
  }
  if (blockers.length > 0) return "Needs work";
  return "Couldn't verify";
}

function isLivePrGateBlocker(blocker: string): boolean {
  const normalized = blocker.trim();
  return (
    normalized === "PR is draft." ||
    isFailedLivePrGateBlocker(normalized) ||
    normalized.startsWith("Live GitHub check still in progress: ")
  );
}

function isFailedLivePrGateBlocker(blocker: string): boolean {
  return blocker.trim().startsWith("Live GitHub check failed: ");
}

function liveCheckName(name: string | null | undefined): string {
  return name?.trim() || "check";
}

function uniqueBlockers(blockers: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const blocker of blockers) {
    const normalized = blocker.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function latestStatusContexts(statuses: CommitStatusContext[]): CommitStatusContext[] {
  const latestByContext = new Map<string, CommitStatusContext>();
  for (const status of statuses) {
    const context = liveCheckName(status.context);
    const current = latestByContext.get(context);
    if (!current || isNewerStatusContext(status, current)) {
      latestByContext.set(context, status);
    }
  }
  return [...latestByContext.values()];
}

function statusTimestampMs(status: CommitStatusContext): number {
  const updatedAt = Date.parse(status.updatedAt ?? "");
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(status.createdAt ?? "");
  return Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY;
}

function isNewerStatusContext(candidate: CommitStatusContext, current: CommitStatusContext): boolean {
  const candidateTime = statusTimestampMs(candidate);
  const currentTime = statusTimestampMs(current);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return candidate.id > current.id;
}

function buildLivePrGateBlockers(runs: CommitCheckRun[], statuses: CommitStatusContext[]): string[] {
  const blockers: string[] = [];
  for (const run of runs) {
    const name = liveCheckName(run.name);
    if (isFailingCheckRun(run)) {
      blockers.push(`Live GitHub check failed: ${name}.`);
    } else if (run.status !== "completed") {
      blockers.push(`Live GitHub check still in progress: ${name}.`);
    }
  }
  for (const status of latestStatusContexts(statuses)) {
    const name = liveCheckName(status.context);
    if (status.state === "failure" || status.state === "error") {
      blockers.push(`Live GitHub check failed: ${name}.`);
    } else if (status.state === "pending") {
      blockers.push(`Live GitHub check still in progress: ${name}.`);
    }
  }
  return uniqueBlockers(blockers).sort((a, b) => a.localeCompare(b));
}

function liveGateRefreshedSummary(input: {
  original: VerifierTerminalResult;
  staticBlockers: string[];
  liveGateBlockers: string[];
  resolvedGateOnlyInconclusive: boolean;
}): string {
  if (input.resolvedGateOnlyInconclusive) {
    return "Verification evidence remains valid; live PR gate blockers are now resolved.";
  }
  if (input.liveGateBlockers.length > 0) {
    return "Verification evidence remains valid, but live PR gates are still blocking.";
  }
  return input.original.summary;
}

// The verifier's self-reported `ci` row reflects gate state at verification time. This
// only runs during a live-gate refresh, so the live signal is always current: realign
// the `ci` row to it (failing/pending -> failed, otherwise passed) so the scorecard can
// never show a stale ci status next to the recomputed blockers — including when non-CI
// static blockers keep the verdict INCONCLUSIVE after CI goes green. An explicit `skipped`
// row is preserved on the passing path: with no live-gate failure we cannot distinguish
// "all gates passed" from "no gates configured", so claiming a pass would overstate the
// evidence. A live-gate failure still flips it to `failed`, since that proves CI ran.
function reconcileChecksWithLiveGates(
  checks: VerifierCheck[] | undefined,
  hasLiveGateFailure: boolean,
): VerifierCheck[] | undefined {
  if (!checks?.length) return checks;
  return checks.map((check) => {
    if (check.name.trim().toLowerCase() !== "ci") return check;
    if (hasLiveGateFailure) {
      return { name: check.name, status: "failed", detail: "Live GitHub PR gates are failing or still in progress." };
    }
    if (check.status === "skipped") return check;
    return { name: check.name, status: "passed", detail: "Live GitHub PR gates passing." };
  });
}

async function getPrVerificationHeadSha(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string | null> {
  try {
    return await getPrHeadSha(token, owner, repo, prNumber);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace("GitHub PR head lookup failed", "GitHub PR verification-state lookup failed"));
  }
}

function recomputeVerifierResultFromLivePrGates(
  result: VerifierTerminalResult,
  liveGateBlockers: string[],
): VerifierTerminalResult {
  const staticBlockers = result.blockers.filter((blocker) => !isLivePrGateBlocker(blocker));
  const hadOnlyLiveGateBlockers = result.blockers.length > 0 && staticBlockers.length === 0;
  const blockers = uniqueBlockers([...staticBlockers, ...liveGateBlockers]);
  const resolvedGateOnlyInconclusive =
    result.verdict === "INCONCLUSIVE" && hadOnlyLiveGateBlockers && liveGateBlockers.length === 0;
  const verdict =
    blockers.length > 0
      ? "INCONCLUSIVE"
      : result.verdict === "CONCLUSIVE" || resolvedGateOnlyInconclusive
        ? "CONCLUSIVE"
        : result.verdict;
  const reconciledChecks = reconcileChecksWithLiveGates(result.checks, liveGateBlockers.length > 0);

  return {
    ...result,
    verdict,
    summary: liveGateRefreshedSummary({
      original: result,
      staticBlockers,
      liveGateBlockers,
      resolvedGateOnlyInconclusive,
    }),
    blockers,
    ...(reconciledChecks !== undefined ? { checks: reconciledChecks } : {}),
  };
}

async function refreshVerifierResultForLivePrGates(args: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  result: VerifierTerminalResult;
}): Promise<VerifierTerminalResult> {
  const currentHeadSha = await getPrVerificationHeadSha(args.token, args.owner, args.repo, args.prNumber);
  if (currentHeadSha !== args.result.verifiedHeadSha) {
    return args.result;
  }

  const [runs, statuses] = await Promise.all([
    getCommitCheckRuns(args.token, args.owner, args.repo, args.result.verifiedHeadSha),
    getCommitStatusContexts(args.token, args.owner, args.repo, args.result.verifiedHeadSha),
  ]);
  return recomputeVerifierResultFromLivePrGates(args.result, buildLivePrGateBlockers(runs, statuses));
}

export function renderManagedVerificationComment(input: {
  owner: string;
  repo: string;
  prNumber: number;
  result: VerifierTerminalResult;
  artifacts?: VerificationArtifact[];
  sessionUrl?: string;
}): string {
  const { owner, repo, prNumber, result, artifacts } = input;
  const body = [
    // INCONCLUSIVE → app_breaks, CONCLUSIVE → pass — the exact map the FSM verdict vocabulary uses so the
    // intake key derived from the comment matches the recorded verification verdict.
    marker(owner, repo, prNumber, result.verifiedHeadSha, result.verdict === "INCONCLUSIVE" ? "app_breaks" : "pass"),
    "",
    renderPersonaHeader(PR_PERSONAS.cycloidQa),
    "",
    `**Verdict:** ${renderVerifierVerdict(result)}`,
    `**Verified head:** \`${result.verifiedHeadSha || "unknown"}\``,
    "",
    "### Summary",
    "",
    result.summary,
    "",
    ...renderVerifierChecks(result.checks),
    "### Evidence",
    "",
    sectionList(result.evidence, "None provided."),
    ...renderVerificationArtifacts(artifacts),
    "",
    "### Blockers",
    "",
    sectionList(result.blockers, "None."),
  ].join("\n");
  const footer = renderVerificationTranscriptFooter(input.sessionUrl);
  return footer ? `${body}\n\n${footer}` : body;
}

async function upsertParsedManagedVerificationComment(args: {
  env?: Env;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  installationId?: number;
  prUrl?: string;
  target?: VerificationCommentTarget;
  state?: ManagedPrCommentState;
  parsed: { result: VerifierTerminalResult; malformed: boolean };
  artifacts?: VerificationArtifact[];
  sessionUrl?: string;
}): Promise<ManagedVerificationCommentResult> {
  const body = renderManagedVerificationComment({
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    result: args.parsed.result,
    artifacts: args.artifacts,
  });
  const boundedBody = truncateForCommentBodyWithFooter(
    body,
    renderVerificationTranscriptFooter(args.sessionUrl),
    MAX_COMMENT_BODY_BYTES,
  );
  let gatedBodyHash = "";
  let gatedLeaseOwner = "";
  const identity =
    args.env && args.installationId && args.prUrl
      ? managedCommentIdentity({
          owner: args.owner,
          repo: args.repo,
          prNumber: args.prNumber,
          installationId: args.installationId,
          prUrl: args.prUrl,
        })
      : null;
  if (args.env && identity && args.target && args.state) {
    const gate = await gateManagedVerificationComment({
      env: args.env,
      identity,
      target: args.target,
      state: args.state,
      body: boundedBody,
    });
    if (!gate.apply) {
      if (gate.reason === "lease_busy") return { ok: false, reason: "lease_busy" };
      return { ok: true, commentId: 0, action: "updated", malformed: args.parsed.malformed };
    }
    gatedBodyHash = gate.bodyHash;
    gatedLeaseOwner = gate.leaseOwner;
  }

  try {
    const comments = await listPrIssueComments(args.token, args.owner, args.repo, args.prNumber);
    const existing = comments.find((comment) =>
      containsManagedQaCommentMarker(comment.body, { owner: args.owner, repo: args.repo, prNumber: args.prNumber }),
    );
    if (existing) {
      await updateIssueComment(args.token, args.owner, args.repo, existing.id, boundedBody);
      if (args.env && identity) {
        await markManagedVerificationCommentPublished({
          env: args.env,
          identity,
          commentId: existing.id,
          bodyHash: gatedBodyHash,
          leaseOwner: gatedLeaseOwner,
        });
      }
      return { ok: true, commentId: existing.id, action: "updated", malformed: args.parsed.malformed };
    }
    const created = await createPrIssueComment(args.token, args.owner, args.repo, args.prNumber, boundedBody);
    if (args.env && identity) {
      await markManagedVerificationCommentPublished({
        env: args.env,
        identity,
        commentId: created.id,
        bodyHash: gatedBodyHash,
        leaseOwner: gatedLeaseOwner,
      });
    }
    return { ok: true, commentId: created.id, action: "created", malformed: args.parsed.malformed };
  } catch {
    if (args.env && identity && gatedLeaseOwner) {
      await releaseManagedVerificationCommentLease({
        env: args.env,
        identity,
        leaseOwner: gatedLeaseOwner,
      });
    }
    return { ok: false, reason: "github_failed" };
  }
}

async function upsertManagedVerificationCommentBody(args: {
  env?: Env;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  installationId?: number;
  prUrl?: string;
  target?: VerificationCommentTarget;
  state?: ManagedPrCommentState;
  body: string;
}): Promise<ManagedVerificationCommentResult> {
  const boundedBody = truncateForCommentBody(args.body, MAX_COMMENT_BODY_BYTES);
  let gatedBodyHash = "";
  let gatedLeaseOwner = "";
  const identity =
    args.env && args.installationId && args.prUrl
      ? managedCommentIdentity({
          owner: args.owner,
          repo: args.repo,
          prNumber: args.prNumber,
          installationId: args.installationId,
          prUrl: args.prUrl,
        })
      : null;
  if (args.env && identity && args.target && args.state) {
    const gate = await gateManagedVerificationComment({
      env: args.env,
      identity,
      target: args.target,
      state: args.state,
      body: boundedBody,
    });
    if (!gate.apply) {
      if (gate.reason === "lease_busy") return { ok: false, reason: "lease_busy" };
      return { ok: true, commentId: 0, action: "updated", malformed: false };
    }
    gatedBodyHash = gate.bodyHash;
    gatedLeaseOwner = gate.leaseOwner;
  }

  try {
    const comments = await listPrIssueComments(args.token, args.owner, args.repo, args.prNumber);
    const existing = comments.find((comment) =>
      containsManagedQaCommentMarker(comment.body, { owner: args.owner, repo: args.repo, prNumber: args.prNumber }),
    );
    if (existing) {
      await updateIssueComment(args.token, args.owner, args.repo, existing.id, boundedBody);
      if (args.env && identity) {
        await markManagedVerificationCommentPublished({
          env: args.env,
          identity,
          commentId: existing.id,
          bodyHash: gatedBodyHash,
          leaseOwner: gatedLeaseOwner,
        });
      }
      return { ok: true, commentId: existing.id, action: "updated", malformed: false };
    }
    const created = await createPrIssueComment(args.token, args.owner, args.repo, args.prNumber, boundedBody);
    if (args.env && identity) {
      await markManagedVerificationCommentPublished({
        env: args.env,
        identity,
        commentId: created.id,
        bodyHash: gatedBodyHash,
        leaseOwner: gatedLeaseOwner,
      });
    }
    return { ok: true, commentId: created.id, action: "created", malformed: false };
  } catch {
    if (args.env && identity && gatedLeaseOwner) {
      await releaseManagedVerificationCommentLease({
        env: args.env,
        identity,
        leaseOwner: gatedLeaseOwner,
      });
    }
    return { ok: false, reason: "github_failed" };
  }
}

/**
 * Rewrites the managed verification comment when a conclusive verdict is outdated
 * (the PR head moved since the verifier ran) or when the current head cannot be
 * fetched to check freshness. This NEVER changes the PR's draft/ready state:
 * Cycloid must not overwrite a human's PR status.
 *
 * malformed / INCONCLUSIVE verdicts need no rewrite here — the caller already
 * posted their comment, and only conclusive verdicts carry a head to compare.
 */
async function refreshOutdatedHeadVerificationComment(args: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  parsed: { result: VerifierTerminalResult; malformed: boolean };
  artifacts?: VerificationArtifact[];
  sessionUrl?: string;
}): Promise<void> {
  if (args.parsed.malformed || args.parsed.result.verdict === "INCONCLUSIVE") {
    return;
  }

  try {
    const currentHeadSha = await getPrVerificationHeadSha(args.token, args.owner, args.repo, args.prNumber);
    if (currentHeadSha === args.parsed.result.verifiedHeadSha) {
      return;
    }
    await upsertParsedManagedVerificationComment({
      ...args,
      parsed: {
        ...args.parsed,
        malformed: false,
        result: outdatedHeadVerifierResult(args.parsed.result, currentHeadSha),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertParsedManagedVerificationComment({
      ...args,
      parsed: { result: headValidationFailureVerifierResult(args.parsed.result, message), malformed: false },
    });
  }
}

async function resolveInstallationId(env: Env, target: VerificationCommentTarget): Promise<number | null> {
  const parsed = parseGithubPullRequestUrl(target.prUrl);
  if (!parsed) return null;
  const hintMatches =
    target.repoOwner?.toLowerCase() === parsed.owner.toLowerCase() &&
    target.repoName?.toLowerCase() === parsed.repo.toLowerCase();
  if (hintMatches && typeof target.installationId === "number" && target.installationId > 0) {
    return target.installationId;
  }
  const installation = await getInstallationByOwner(env.DB, parsed.owner);
  return installation && installation.suspended_at === null ? installation.installation_id : null;
}

export async function upsertManagedVerificationComment(args: {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  rawVerifierOutput: string;
  fallbackHeadSha: string;
  verifierResult?: VerifierTerminalResult;
  artifacts?: VerificationArtifact[];
  sessionUrl?: string;
}): Promise<ManagedVerificationCommentResult> {
  const parsed =
    args.verifierResult !== undefined
      ? parseVerifierTerminalResultObject(args.verifierResult, args.fallbackHeadSha)
      : parseVerifierTerminalResult(args.rawVerifierOutput, args.fallbackHeadSha);
  return upsertParsedManagedVerificationComment({
    ...args,
    parsed,
    artifacts: args.artifacts,
    sessionUrl: args.sessionUrl,
  });
}

export async function publishVerificationSkippedComment(args: {
  env: Env;
  target: VerificationCommentTarget;
  summary: string;
  reasonCode?: string | null;
}): Promise<ManagedVerificationCommentResult> {
  try {
    const parsedPr = parseGithubPullRequestUrl(args.target.prUrl);
    if (!parsedPr) return { ok: false, reason: "invalid_pr_url" };
    const installationId = await resolveInstallationId(args.env, args.target);
    if (!installationId) return { ok: false, reason: "missing_installation" };
    const token = await createInstallationToken(args.env, installationId);
    return upsertManagedVerificationCommentBody({
      env: args.env,
      token,
      owner: parsedPr.owner,
      repo: parsedPr.repo,
      prNumber: parsedPr.number,
      installationId,
      prUrl: args.target.prUrl,
      target: args.target,
      state: "skipped",
      body: renderManagedVerificationSkippedComment({
        owner: parsedPr.owner,
        repo: parsedPr.repo,
        prNumber: parsedPr.number,
        summary: args.summary,
        reasonCode: args.reasonCode,
      }),
    });
  } catch {
    return { ok: false, reason: "github_failed" };
  }
}

export async function publishManagedVerificationComment(args: {
  env: Env;
  target: VerificationCommentTarget;
  rawVerifierOutput: string;
  fallbackHeadSha: string;
  verifierResult?: VerifierTerminalResult;
  artifacts?: VerificationArtifact[];
  sessionUrl?: string;
  refreshLivePrGates?: boolean;
  managedState?: ManagedPrCommentState;
}): Promise<ManagedVerificationPublicationResult> {
  try {
    const parsedPr = parseGithubPullRequestUrl(args.target.prUrl);
    if (!parsedPr) return { ok: false, reason: "invalid_pr_url" };
    const installationId = await resolveInstallationId(args.env, args.target);
    if (!installationId) return { ok: false, reason: "missing_installation" };
    const token = await createInstallationToken(args.env, installationId);
    const parsedWithoutHead =
      args.verifierResult !== undefined
        ? parseVerifierTerminalResultObject(args.verifierResult, "")
        : parseVerifierTerminalResult(args.rawVerifierOutput, "");
    const needsHeadFallback = !args.fallbackHeadSha && parsedWithoutHead.malformed;
    const fallbackHeadSha =
      args.fallbackHeadSha ||
      (needsHeadFallback ? (await getPrHeadSha(token, parsedPr.owner, parsedPr.repo, parsedPr.number)) || "" : "");
    const parsed =
      args.verifierResult !== undefined
        ? parseVerifierTerminalResultObject(args.verifierResult, fallbackHeadSha)
        : parseVerifierTerminalResult(args.rawVerifierOutput, fallbackHeadSha);
    const refreshedParsed =
      args.refreshLivePrGates && !parsed.malformed
        ? {
            ...parsed,
            result: await refreshVerifierResultForLivePrGates({
              token,
              owner: parsedPr.owner,
              repo: parsedPr.repo,
              prNumber: parsedPr.number,
              result: parsed.result,
            }),
          }
        : parsed;
    const comment = await upsertParsedManagedVerificationComment({
      env: args.env,
      token,
      owner: parsedPr.owner,
      repo: parsedPr.repo,
      prNumber: parsedPr.number,
      installationId,
      prUrl: args.target.prUrl,
      target: args.target,
      state: args.managedState ?? (args.refreshLivePrGates ? "metadata" : "result"),
      parsed: refreshedParsed,
      artifacts: args.artifacts,
      sessionUrl: args.sessionUrl,
    });
    if (!comment.ok) return comment;
    await refreshOutdatedHeadVerificationComment({
      token,
      owner: parsedPr.owner,
      repo: parsedPr.repo,
      prNumber: parsedPr.number,
      parsed: refreshedParsed,
      artifacts: args.artifacts,
      sessionUrl: args.sessionUrl,
    });
    return comment;
  } catch {
    return { ok: false, reason: "github_failed" };
  }
}
