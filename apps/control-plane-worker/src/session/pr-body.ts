import { CYCLOID_CO_AUTHOR_TRAILER } from "../../../../shared/constants/git-identity.js";
import {
  classifyDesktopPrEvidencePath,
  desktopEvidenceScenarioLabel,
  type DesktopPrEvidenceDescriptor,
} from "../../../../shared/desktop-evidence.js";
import { BRIDGE_VERIFICATION_RENDERED_MARKER } from "../../../../shared/post-execution.js";
import { derivePromptDisplayText } from "../../../../shared/transcript/prompt-display.js";
import type {
  ExecutionVerification,
  PrReadinessEvidence,
  VerificationArtifact,
} from "../../../../shared/types/sandbox.js";
import { buildVerificationSummary, type VerificationSummaryCommand } from "../../../../shared/verification-summary.js";
import { InitiationMode } from "../enums/initiation-mode.js";
import { escapeRegExp } from "../regex.js";
import type { GithubIssueContext, LinearContext, PromptState } from "../types";
import { type MarkdownFence, nextMarkdownFence } from "./markdown-fence.js";
import { looksLikeVerboseVerificationDetail } from "./pr-body-assembler.js";
import { applyTicketKeyPrefix, normalizeSessionPrTitle } from "./pr-title.js";
import { derivePromptTitleCandidate, isPromptMetadataLine } from "./prompt-text.js";
import { normalizeTicketKey } from "./ticket-key.js";

type ScheduledRunFooterSource = {
  initiationMode?: InitiationMode | null;
  ruleNameSnapshot?: string | null;
  cronSnapshot?: string | null;
};

const SCHEDULED_RUN_FOOTER_PREFIX = "🤖 Scheduled run · ";
const STANDALONE_TICKET_KEY_PATTERN = /\b([A-Z][A-Z0-9]*-\d+)(?!-\d)\b/;
const NON_TICKET_KEY_PREFIXES = new Set([
  "API",
  "BZIP",
  "CSS",
  "CVE",
  "GZIP",
  "HTML",
  "HTTP",
  "ISO",
  "MIME",
  "RFC",
  "SHA",
  "SSL",
  "TCP",
  "TLS",
  "UDP",
  "UTF",
]);

type PrBodySessionContext = {
  linearContext?: LinearContext | null;
  githubIssueContext?: GithubIssueContext | null;
};

export function fallbackPrTitle(prompts: PromptState[]): string {
  for (const prompt of [...prompts].reverse()) {
    // A republish with an empty session title falls here with the full prompt list — which on a
    // republish includes review-loop turns. A review-loop turn's prompt is agent-machinery (epoch
    // marker, worklist `Source:` lines, untrusted notices); titling a PR from it leaks the footer.
    // Derive the clean human summary for those turns instead. Non-review-loop prompts keep using the
    // raw text: `derivePromptTitleCandidate` skips metadata LINES while preserving the wrapped user
    // request, which `derivePromptDisplayText`'s scaffolding stripper would delete wholesale.
    const source = prompt.prompt.trimStart().startsWith("[cycloid:review-loop")
      ? derivePromptDisplayText({ prompt: prompt.prompt, replyToText: prompt.replyToText })
      : prompt.prompt;
    const title = derivePromptTitleCandidate(source);
    if (title) return title;
  }
  return "Changes from Cycloid";
}

/**
 * Resolve the PR title, prefixing it with `ticketKey` (pre-resolved by the
 * caller via `resolveSessionTicketKey`) so a ticket-driven session opens a PR
 * that satisfies ticket-prefix title conventions without an after-the-fact
 * rename. `ticketKey` is already shape-validated; null means no prefix.
 */
export function resolvePrTitle(
  titleOverride: string | undefined,
  sessionTitle: string | null | undefined,
  prompts: PromptState[],
  ticketKey?: string | null,
): string {
  const explicitTitle = titleOverride?.trim();
  const generatedSessionTitle = sessionTitle?.trim();
  const candidate =
    explicitTitle ||
    (generatedSessionTitle && !isPromptMetadataLine(generatedSessionTitle) ? generatedSessionTitle : "") ||
    fallbackPrTitle(prompts);
  const normalizedCandidate = normalizeSessionPrTitle(candidate);
  const resolvedTicketKey = ticketKey ?? extractStandaloneTicketKeyFromTitle(normalizedCandidate);

  return applyTicketKeyPrefix(normalizedCandidate, resolvedTicketKey);
}

function extractStandaloneTicketKeyFromTitle(title: string): string | null {
  const match = title.match(STANDALONE_TICKET_KEY_PATTERN);
  const key = match?.[1] ?? null;
  if (!key) return null;
  const prefix = key.split("-")[0] ?? "";
  if (NON_TICKET_KEY_PREFIXES.has(prefix)) return null;
  return normalizeTicketKey(key);
}

export function fallbackPrBody(diffSummary?: string): string {
  const sections: string[] = [];

  if (diffSummary) {
    sections.push(`## Changes\n${diffSummary}`);
  }

  sections.push("🤖 Generated with [Cycloid](https://trycycloid.com)");
  return sections.join("\n\n");
}

const VISUAL_EVIDENCE_SECTION_HEADING = "Screenshots or Recordings";
const VISUAL_EVIDENCE_START_MARKER = "<!-- cycloid:managed:start visualEvidence -->";
const VISUAL_EVIDENCE_END_MARKER = "<!-- cycloid:managed:end visualEvidence -->";
const STICKY_EVIDENCE_SECTION_HEADINGS = [
  "Walkthrough Video",
  "Screenshots",
  "Videos",
  VISUAL_EVIDENCE_SECTION_HEADING,
] as const;
const PR_BODY_INSERTION_ANCHOR_HEADINGS = [
  "Changes",
  "Summary",
  "Walkthrough Video",
  "Screenshots",
  "Videos",
  "Evidence Bundle",
  "Changed Files",
  "Functional Verification",
  "Verdict",
  "Behavioral Impact",
  "Verification Verdict",
  "Verification",
  "Verification Details",
  "Quality Gates",
  "Skipped Verification",
  "Risk Notes",
  "Follow-ups",
] as const;
const CYCLOID_FOOTER_LINE = "🤖 Generated with [Cycloid](https://trycycloid.com)";
const CYCLOID_MANAGED_VERIFICATION_BLOCK_RE = /<!--\s*cycloid:managed:start\s+verification\s*-->/;
const VERIFICATION_DIAGNOSTIC_COMMENT_NOTE =
  "Full diagnostic details are posted in the Verification Diagnostic Details PR comment.";
const VERIFICATION_DETAIL_MAX_LINES = 12;

export type GithubReleaseVisualEvidenceAsset = {
  type: "screenshot" | "video";
  label: string;
  desktopEvidence?: DesktopPrEvidenceDescriptor | null;
  browserDownloadUrl: string;
};

function headingPattern(heading: string): RegExp {
  return new RegExp(`^#{2,6}\\s+${escapeRegExp(heading)}\\s*$`, "i");
}

function isMarkdownHeading(line: string): boolean {
  return /^#{2,6}\s+\S/.test(line.trim());
}

function findMarkdownBoundaryIndex(lines: string[], isBoundary: (line: string) => boolean, startIndex = 0): number {
  let fence: MarkdownFence | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const nextFence = nextMarkdownFence(fence, lines[index]);
    if (index >= startIndex && !fence && !nextFence && isBoundary(lines[index])) return index;
    fence = nextFence;
  }
  return -1;
}

function isPrBodyFooterLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === CYCLOID_FOOTER_LINE || /^📋 \[Session transcript\]\(/.test(trimmed);
}

function extractMarkdownSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  const start = findMarkdownBoundaryIndex(lines, (line) => headingPattern(heading).test(line.trim()));
  if (start === -1) return null;

  const nextBoundary = findMarkdownBoundaryIndex(
    lines,
    (line) => isMarkdownHeading(line) || isPrBodyFooterLine(line),
    start + 1,
  );
  const end = nextBoundary === -1 ? lines.length : nextBoundary;

  const section = lines.slice(start, end).join("\n").trim();
  return section ? section : null;
}

function hasMarkdownSection(markdown: string, heading: string): boolean {
  return extractMarkdownSection(markdown, heading) !== null;
}

function firstInsertionAnchorIndex(lines: string[]): number {
  const anchorPatterns = PR_BODY_INSERTION_ANCHOR_HEADINGS.map(headingPattern);
  const anchor = findMarkdownBoundaryIndex(
    lines,
    (line) => anchorPatterns.some((pattern) => pattern.test(line.trim())) || isPrBodyFooterLine(line),
  );
  return anchor === -1 ? lines.length : anchor;
}

function insertSections(body: string, sections: string[]): string {
  if (sections.length === 0) return body;

  const lines = body.split("\n");
  const anchorIndex = firstInsertionAnchorIndex(lines);
  const before = lines.slice(0, anchorIndex).join("\n").trimEnd();
  const after = lines.slice(anchorIndex).join("\n").trimStart();
  const inserted = sections.join("\n\n");

  if (!before) return after ? `${inserted}\n\n${after}` : inserted;
  if (!after) return `${before}\n\n${inserted}`;
  return `${before}\n\n${inserted}\n\n${after}`;
}

function insertSectionsAfterHeading(body: string, heading: string, sections: string[]): string {
  if (sections.length === 0) return body;
  const existingSection = extractMarkdownSection(body, heading);
  if (!existingSection) return insertSections(body, sections);

  const lines = body.split("\n");
  const start = findMarkdownBoundaryIndex(lines, (line) => headingPattern(heading).test(line.trim()));
  if (start === -1) return insertSections(body, sections);
  const nextBoundary = findMarkdownBoundaryIndex(
    lines,
    (line) => isMarkdownHeading(line) || isPrBodyFooterLine(line),
    start + 1,
  );
  const end = nextBoundary === -1 ? lines.length : nextBoundary;
  const before = lines.slice(0, end).join("\n").trimEnd();
  const after = lines.slice(end).join("\n").trimStart();
  const inserted = sections.join("\n\n");

  if (!after) return `${before}\n\n${inserted}`;
  return `${before}\n\n${inserted}\n\n${after}`;
}

// The managed `Summary:` block is always the tail of the verdict context: a `## Verdict` /
// `## Verification Verdict` heading (bridge + control-plane bodies) or a `**Verdict:**` line
// inside the PR-template managed verification block. Anchoring the `Summary:` search to that
// context keeps a stray `Summary:` line elsewhere in agent/template free text from being matched.
const VERDICT_CONTEXT_LINE_RE = /^(?:#{2,6}\s+(?:verification\s+)?verdict\s*$|\*\*verdict:\*\*|-\s*verdict:)/i;
// New bridge layout leads with a top-level `## Summary` heading (no `Summary:` label,
// no `## Verdict`). Match it exactly so "## Summary by CodeRabbit" and similar do not.
const SUMMARY_HEADING_LINE_RE = /^#{2,6}\s+summary\s*$/i;

/**
 * Locate the implementation summary as a `[start, end)` line range. Prefers the new bridge
 * `## Summary` heading section (ending before the claim callout / next heading / footer so only
 * the narrative is carried forward). Falls back to a legacy `Summary:` label anchored to a
 * verdict context, or an unanchored `Summary:` for bodies that carry one without a verdict.
 */
function findVerdictSummaryRange(lines: string[]): { start: number; end: number } | null {
  const summaryHeading = findMarkdownBoundaryIndex(lines, (line) => SUMMARY_HEADING_LINE_RE.test(line.trim()));
  if (summaryHeading !== -1) {
    const nextBoundary = findMarkdownBoundaryIndex(
      lines,
      (line) => isMarkdownHeading(line) || isPrBodyFooterLine(line) || line.trim().startsWith(">"),
      summaryHeading + 1,
    );
    return { start: summaryHeading, end: nextBoundary === -1 ? lines.length : nextBoundary };
  }

  const verdictAnchor = findMarkdownBoundaryIndex(lines, (line) => VERDICT_CONTEXT_LINE_RE.test(line.trim()));
  const searchFrom = verdictAnchor === -1 ? 0 : verdictAnchor + 1;

  const start = findMarkdownBoundaryIndex(lines, (line) => line.trim() === "Summary:", searchFrom);
  if (start === -1) return null;

  const nextBoundary = findMarkdownBoundaryIndex(
    lines,
    (line) => isMarkdownHeading(line) || isPrBodyFooterLine(line),
    start + 1,
  );
  return { start, end: nextBoundary === -1 ? lines.length : nextBoundary };
}

function extractVerdictSummaryBlock(markdown: string): string | null {
  const lines = markdown.split("\n");
  const range = findVerdictSummaryRange(lines);
  if (!range) return null;

  const content = lines
    .slice(range.start + 1, range.end)
    .join("\n")
    .trim();
  if (!content) return null;
  return lines.slice(range.start, range.end).join("\n").trim();
}

/**
 * On automated review-loop / CI-fix publishes, keep the implementation `Summary:` block from
 * the previous PR body instead of the freshly-rendered one (which describes the touch-up run).
 * Initial publishes and follow-up user prompts (isAutomatedEpochRun === false) refresh normally.
 */
export function preserveImplementationSummary(
  body: string,
  previousBody: string | null | undefined,
  isAutomatedEpochRun: boolean,
): string {
  if (!isAutomatedEpochRun) return body;

  const previousSummary = previousBody ? extractVerdictSummaryBlock(previousBody) : null;
  if (!previousSummary) return body;

  const lines = body.split("\n");
  const range = findVerdictSummaryRange(lines);
  if (!range) return body;

  const before = lines.slice(0, range.start).join("\n").trimEnd();
  const after = lines.slice(range.end).join("\n").trimStart();
  const head = before ? `${before}\n\n${previousSummary}` : previousSummary;
  return after ? `${head}\n\n${after}` : head;
}

export function preservePrEvidenceSections(body: string, previousBody: string | null | undefined): string {
  if (!previousBody?.trim()) return normalizeScreenshotEvidenceLinks(body);

  const missingSections = STICKY_EVIDENCE_SECTION_HEADINGS.flatMap((heading) => {
    // A generated sticky heading is authoritative, even when intentionally empty.
    if (hasMarkdownSection(body, heading)) return [];
    const previousSection = extractMarkdownSection(previousBody, heading);
    return previousSection ? [previousSection] : [];
  });

  if (hasMarkdownSection(body, "Verification Verdict")) {
    return normalizeScreenshotEvidenceLinks(insertSectionsAfterHeading(body, "Verification Verdict", missingSections));
  }
  if (hasMarkdownSection(body, "Verdict")) {
    return normalizeScreenshotEvidenceLinks(insertSectionsAfterHeading(body, "Verdict", missingSections));
  }

  return normalizeScreenshotEvidenceLinks(insertSections(body, missingSections));
}

export function appendLinearLink(body: string, linearContext?: LinearContext): string {
  if (!linearContext?.identifier || !linearContext?.url) return body;
  // Shape-validate before emitting: an unsanitized stored/internal identifier or URL
  // must not reach the PR body.
  const identifier = normalizeTicketKey(linearContext.identifier);
  if (!identifier) return body;
  let parsed: URL;
  try {
    parsed = new URL(linearContext.url);
  } catch {
    return body;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "linear.app") return body;
  const url = linearContext.url;
  // Emit a Linear-documented magic-word form: a bare URL after `Resolves` (links AND
  // renders as a clickable GitHub autolink). Dedup is idempotent across republish: skip
  // when the body already carries this bare-URL form, the bridge's bare `Resolves ARC-947`,
  // or the legacy markdown-link `Resolves [ARC-947](...)` this helper used to emit (so
  // republishing an already-open PR does not append a duplicate Resolves line).
  if (
    body.includes(`Resolves ${url}`) ||
    body.includes(`Resolves ${identifier}`) ||
    body.includes(`Resolves [${identifier}]`)
  ) {
    return body;
  }
  return `Resolves ${url}\n\n${body}`;
}

export function appendGithubIssueLink(body: string, githubIssueContext?: GithubIssueContext): string {
  if (!githubIssueContext?.owner || !githubIssueContext.repo || !Number.isInteger(githubIssueContext.issueNumber)) {
    return body;
  }
  const link = `Closes ${githubIssueContext.owner}/${githubIssueContext.repo}#${githubIssueContext.issueNumber}`;
  if (body.includes(link)) return body;
  return `${link}\n\n${body}`;
}

function stripScheduledRunFooter(body: string): string {
  const lines = body.split("\n");
  const filtered = lines.filter((line) => !line.trim().startsWith(SCHEDULED_RUN_FOOTER_PREFIX));
  if (filtered.length === lines.length) return body;
  return filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function appendScheduledRunFooter(
  body: string,
  source: ScheduledRunFooterSource | null | undefined,
  firedAtIso: string | null | undefined,
): string {
  const stripped = stripScheduledRunFooter(body);
  if (!source || source.initiationMode !== InitiationMode.AUTOMATION) return stripped;

  const cron = source.cronSnapshot?.trim();
  if (!cron) return stripped;

  const ruleName = source.ruleNameSnapshot?.trim();
  const parts: string[] = [];
  if (ruleName) parts.push(`rule "${ruleName}"`);
  parts.push(`cron \`${cron}\``);
  if (firedAtIso) parts.push(`fired ${firedAtIso}`);

  const footer = `${SCHEDULED_RUN_FOOTER_PREFIX}${parts.join(" · ")}`;
  return stripped ? `${stripped}\n\n${footer}` : footer;
}

const REVIEWER_INACCESSIBLE_URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^\s)\]}>,`]*)?/g;
const MARKDOWN_LOCAL_LINK_RE =
  /\[([^\]]+)\]\((https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/[^)\s]*)?)\)/g;
const HTTP_URL_TOKEN_RE = /\bhttps?:\/\/[^\s)\]}>,`]+/g;
const SCREENSHOT_URL_LINE_RE = /^(\s*(?:[-*]\s+)?)(.+\bscreenshot\b.*):\s+(https?:\/\/\S+)(\s*)$/i;
const SECTION_MARKDOWN_LINK_RE = /^(\s*(?:[-*]\s+)?)(?!\!)\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)(\s*)$/i;
const CYCLOID_ARTIFACT_PATH_RE = /\/api\/sessions\/[^/]+\/artifacts\//;
const IMAGE_URL_PATH_RE = /\.(?:png|jpe?g|webp|gif)$/i;
const GITHUB_ATTACHMENT_HOSTS = new Set([
  "private-user-images.githubusercontent.com",
  "user-images.githubusercontent.com",
]);

function splitTrailingSentencePunctuation(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl;
  let trailing = "";
  while (/[.!?,]$/.test(url)) {
    trailing = `${url.at(-1)}${trailing}`;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

function escapeMarkdownImageAltText(label: string): string {
  return label.replace(/[\r\n]+/g, " ").replace(/([\\[\]])/g, "\\$1");
}

function screenshotAltText(label: string): string {
  const lastSegment = label.split(":").at(-1)?.trim();
  return lastSegment && /\bscreenshot\b/i.test(lastSegment) ? lastSegment : label;
}

function parseHttpUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isLocalhostUrl(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "0.0.0.0";
}

function publicSessionUrl(sessionId: string, frontendUrl: string): string {
  return `${frontendUrl.replace(/\/+$/, "")}/sessions/${encodeURIComponent(sessionId)}`;
}

function isSessionUrlForId(url: URL, sessionId: string): boolean {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[0] !== "sessions") return false;
  try {
    return decodeURIComponent(parts[1]) === sessionId;
  } catch {
    return parts[1] === sessionId;
  }
}

export function normalizeSessionLinks(body: string, sessionId: string, frontendUrl: string): string {
  const sessionUrl = publicSessionUrl(sessionId, frontendUrl);
  return body.replace(HTTP_URL_TOKEN_RE, (rawUrl) => {
    const { url, trailing } = splitTrailingSentencePunctuation(rawUrl);
    const parsed = parseHttpUrl(url);
    if (!parsed || !isSessionUrlForId(parsed, sessionId)) return rawUrl;
    return `${sessionUrl}${trailing}`;
  });
}

export function appendSessionLink(body: string, sessionId: string, frontendUrl: string): string {
  const normalizedBody = normalizeSessionLinks(body, sessionId, frontendUrl);
  const sessionUrl = publicSessionUrl(sessionId, frontendUrl);
  if (normalizedBody.includes(sessionUrl)) return normalizedBody;
  return `${normalizedBody}\n\n📋 [Session transcript](${sessionUrl})`;
}

export function stripCycloidCoAuthorTrailer(body: string): string {
  const linesWithoutTrailer: string[] = [];
  for (const line of body.trimEnd().split("\n")) {
    if (line.trim() === CYCLOID_CO_AUTHOR_TRAILER) {
      while (linesWithoutTrailer.at(-1)?.trim() === "") linesWithoutTrailer.pop();
      continue;
    }
    linesWithoutTrailer.push(line);
  }
  return linesWithoutTrailer.join("\n").trimEnd();
}

function isGithubUserAttachmentUrl(url: URL): boolean {
  return (
    (url.hostname === "github.com" && url.pathname.startsWith("/user-attachments/assets/")) ||
    GITHUB_ATTACHMENT_HOSTS.has(url.hostname)
  );
}

function isEmbeddableScreenshotUrl(rawUrl: string): boolean {
  const url = parseHttpUrl(rawUrl);
  if (!url || isLocalhostUrl(url)) return false;

  const hasArtifactToken = /[?&]artifactToken=/.test(rawUrl);
  if (CYCLOID_ARTIFACT_PATH_RE.test(url.pathname)) return hasArtifactToken;
  if (hasArtifactToken || isGithubUserAttachmentUrl(url)) return true;
  return IMAGE_URL_PATH_RE.test(url.pathname);
}

function markdownHeadingText(line: string): string | null {
  return (
    line
      .trim()
      .match(/^#{2,6}\s+(.+?)\s*$/)?.[1]
      ?.trim()
      .toLowerCase() ?? null
  );
}

function isScreenshotEvidenceSectionHeading(line: string): boolean {
  const heading = markdownHeadingText(line);
  return heading === "screenshots" || heading === "evidence";
}

function normalizePlainScreenshotUrlLine(line: string): string {
  const match = line.match(SCREENSHOT_URL_LINE_RE);
  if (!match) return line;

  const [, prefix, label, rawUrl, whitespace] = match;
  const { url, trailing } = splitTrailingSentencePunctuation(rawUrl);
  if (!isEmbeddableScreenshotUrl(url)) return line;

  const cleanLabel = label.trim();
  const altText = screenshotAltText(cleanLabel);
  return `${prefix}${cleanLabel}: ![${escapeMarkdownImageAltText(altText)}](${url})${trailing}${whitespace}`;
}

function normalizeScreenshotSectionLinkLine(line: string): string {
  const match = line.match(SECTION_MARKDOWN_LINK_RE);
  if (!match) return line;

  const [, prefix, label, rawUrl, whitespace] = match;
  if (!isEmbeddableScreenshotUrl(rawUrl)) return line;
  return `${prefix}![${escapeMarkdownImageAltText(label)}](${rawUrl})${whitespace}`;
}

function normalizeScreenshotEvidenceLinks(body: string): string {
  let fence: MarkdownFence | null = null;
  let inScreenshotEvidenceSection = false;

  return body
    .split("\n")
    .map((line) => {
      const nextFence = nextMarkdownFence(fence, line);
      if (fence || nextFence) {
        fence = nextFence;
        return line;
      }

      if (isMarkdownHeading(line)) {
        inScreenshotEvidenceSection = isScreenshotEvidenceSectionHeading(line);
        return line;
      }

      const normalizedScreenshotLine = normalizePlainScreenshotUrlLine(line);
      if (normalizedScreenshotLine !== line) return normalizedScreenshotLine;

      return inScreenshotEvidenceSection ? normalizeScreenshotSectionLinkLine(line) : line;
    })
    .join("\n");
}

function neutralizeReviewerInaccessibleLinks(body: string): string {
  return body
    .replace(MARKDOWN_LOCAL_LINK_RE, "$1 (`local preview URL`)")
    .replace(REVIEWER_INACCESSIBLE_URL_RE, (rawUrl, offset, input) => {
      let url = rawUrl;
      let trailing = "";
      while (/[.!?]$/.test(url)) {
        trailing = `${url.at(-1)}${trailing}`;
        url = url.slice(0, -1);
      }
      const before = input[offset - 1];
      const after = input[offset + url.length];
      if (before === "`" && after === "`") return `${url}${trailing}`;
      return `\`${url}\`${trailing}`;
    });
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\*_`[\]])/g, "\\$1")
    .trim();
}

function escapeMarkdownLinkUrl(value: string): string {
  return value.replace(/\)/g, "%29").trim();
}

function renderVisualEvidenceBlock(lines: string[]): string {
  return [VISUAL_EVIDENCE_START_MARKER, ...lines, VISUAL_EVIDENCE_END_MARKER].join("\n");
}

type RenderableVisualEvidence = {
  type: "screenshot" | "video";
  label: string;
  url: string;
  desktopEvidence: DesktopPrEvidenceDescriptor | null;
  fallback: boolean;
};

function renderableAsset(asset: GithubReleaseVisualEvidenceAsset): RenderableVisualEvidence {
  return {
    type: asset.type,
    label: asset.label,
    url: asset.browserDownloadUrl,
    desktopEvidence: asset.desktopEvidence ?? classifyDesktopPrEvidencePath(asset.label),
    fallback: false,
  };
}

function renderableFallbackArtifact(artifact: VerificationArtifact): RenderableVisualEvidence | null {
  if (artifact.type !== "screenshot" && artifact.type !== "video") return null;
  return {
    type: artifact.type,
    label: artifact.label,
    url: artifact.url,
    desktopEvidence: classifyDesktopPrEvidencePath(artifact.label),
    fallback: true,
  };
}

function renderMarkdownLink(label: string, url: string): string {
  return `[${escapeMarkdownText(label)}](${escapeMarkdownLinkUrl(url)})`;
}

function renderDesktopEvidenceLines(items: RenderableVisualEvidence[]): string[] {
  const desktopItems = items.filter(
    (item): item is RenderableVisualEvidence & { desktopEvidence: DesktopPrEvidenceDescriptor } =>
      item.desktopEvidence !== null,
  );
  if (desktopItems.length === 0) return [];

  const videos = desktopItems.filter((item) => item.type === "video").slice(0, 1);
  const screenshots = desktopItems
    .filter((item) => item.type === "screenshot")
    .sort((left, right) => {
      const leftIndex = left.desktopEvidence.kind === "proof_screenshot" ? left.desktopEvidence.index : 0;
      const rightIndex = right.desktopEvidence.kind === "proof_screenshot" ? right.desktopEvidence.index : 0;
      return leftIndex - rightIndex;
    })
    .slice(0, 3);
  const scenarioId = desktopItems[0].desktopEvidence.scenarioId;
  const caveats: string[] = [];
  if (videos.length === 0) caveats.push("Recording was omitted; screenshots carry the visual proof.");
  if (desktopItems.some((item) => item.fallback)) {
    caveats.push("GitHub-hosted evidence could not be published; links use Cycloid artifact URLs.");
  }

  const lines = ["### Desktop evidence"];
  if (videos[0]) {
    lines.push(`Desktop walkthrough: ${renderMarkdownLink("Desktop walkthrough video", videos[0].url)}`);
  } else {
    lines.push("Desktop walkthrough: not published");
  }
  if (screenshots.length > 0) {
    const links = screenshots.map((screenshot, index) =>
      renderMarkdownLink(`Proof screenshot ${index + 1}`, screenshot.url),
    );
    lines.push(`Proof screenshots: ${links.join(", ")}`);
  }
  lines.push(`Verified flow: ${desktopEvidenceScenarioLabel(scenarioId)}.`);
  if (caveats.length > 0) lines.push(`Evidence caveat: ${caveats.join(" ")}`);
  return lines;
}

export function renderGithubReleaseVisualEvidenceSection(
  assets: GithubReleaseVisualEvidenceAsset[],
  fallbackArtifacts: VerificationArtifact[] = [],
): string {
  const rendered = [
    ...assets.map(renderableAsset),
    ...fallbackArtifacts.flatMap((artifact) => {
      const item = renderableFallbackArtifact(artifact);
      return item ? [item] : [];
    }),
  ];
  const desktopLines = renderDesktopEvidenceLines(rendered);
  const screenshots = assets.filter((asset) => asset.type === "screenshot" && !renderableAsset(asset).desktopEvidence);
  const videos = assets.filter((asset) => asset.type === "video" && !renderableAsset(asset).desktopEvidence);
  const fallbackScreenshots = fallbackArtifacts.filter(
    (artifact) => artifact.type === "screenshot" && !classifyDesktopPrEvidencePath(artifact.label),
  );
  const fallbackVideos = fallbackArtifacts.filter(
    (artifact) => artifact.type === "video" && !classifyDesktopPrEvidencePath(artifact.label),
  );
  const lines: string[] = [""];

  if (desktopLines.length > 0) lines.push(...desktopLines);

  if (screenshots.length > 0 || fallbackScreenshots.length > 0) {
    if (desktopLines.length > 0) lines.push("");
    lines.push("### Screenshots");
    for (const asset of screenshots) {
      const label = escapeMarkdownText(asset.label) || "Screenshot";
      const alt = escapeHtmlAttribute(`Cycloid screenshot: ${label}`);
      const url = escapeMarkdownLinkUrl(asset.browserDownloadUrl);
      lines.push("");
      lines.push(`[${label}](${url})`);
      lines.push(`<img src="${escapeHtmlAttribute(asset.browserDownloadUrl)}" width="720" alt="${alt}" />`);
    }
    for (const artifact of fallbackScreenshots) {
      const label = escapeMarkdownText(artifact.label) || "Screenshot";
      lines.push(`- [${label}](${escapeMarkdownLinkUrl(artifact.url)})`);
    }
  }

  if (videos.length > 0 || fallbackVideos.length > 0) {
    if (desktopLines.length > 0 || screenshots.length > 0 || fallbackScreenshots.length > 0) lines.push("");
    lines.push("### Recordings");
    for (const asset of videos) {
      const label = escapeMarkdownText(asset.label) || "Recording";
      lines.push(`- [${label}](${escapeMarkdownLinkUrl(asset.browserDownloadUrl)})`);
    }
    for (const artifact of fallbackVideos) {
      const label = escapeMarkdownText(artifact.label) || "Recording";
      lines.push(`- [${label}](${escapeMarkdownLinkUrl(artifact.url)})`);
    }
  }

  if (desktopLines.length === 0 && screenshots.length === 0 && videos.length === 0 && fallbackArtifacts.length === 0) {
    lines.push("No visual evidence artifacts were published.");
  }

  return `## ${VISUAL_EVIDENCE_SECTION_HEADING}\n\n${renderVisualEvidenceBlock(lines)}`;
}

export function renderCycloidVisualEvidenceFallbackSection(artifacts: VerificationArtifact[]): string {
  const rendered = artifacts.flatMap((artifact) => {
    const item = renderableFallbackArtifact(artifact);
    return item ? [item] : [];
  });
  const desktopLines = renderDesktopEvidenceLines(rendered);
  const screenshots = artifacts.filter(
    (artifact) => artifact.type === "screenshot" && !classifyDesktopPrEvidencePath(artifact.label),
  );
  const videos = artifacts.filter(
    (artifact) => artifact.type === "video" && !classifyDesktopPrEvidencePath(artifact.label),
  );
  const lines: string[] = [""];

  if (desktopLines.length > 0) lines.push(...desktopLines);

  if (screenshots.length > 0) {
    if (desktopLines.length > 0) lines.push("");
    lines.push("### Screenshots");
    for (const artifact of screenshots) {
      const label = escapeMarkdownText(artifact.label) || "Screenshot";
      lines.push(`- [${label}](${escapeMarkdownLinkUrl(artifact.url)})`);
    }
  }

  if (videos.length > 0) {
    if (desktopLines.length > 0 || screenshots.length > 0) lines.push("");
    lines.push("### Recordings");
    for (const artifact of videos) {
      const label = escapeMarkdownText(artifact.label) || "Recording";
      lines.push(`- [${label}](${escapeMarkdownLinkUrl(artifact.url)})`);
    }
  }

  if (desktopLines.length === 0 && screenshots.length === 0 && videos.length === 0) {
    lines.push("GitHub-hosted visual evidence could not be published. Use the Cycloid session transcript.");
  }

  return `## ${VISUAL_EVIDENCE_SECTION_HEADING}\n\n${renderVisualEvidenceBlock(lines)}`;
}

function extractVisualEvidenceManagedBlock(section: string): string {
  const start = section.indexOf(VISUAL_EVIDENCE_START_MARKER);
  const end = section.indexOf(VISUAL_EVIDENCE_END_MARKER);
  if (start === -1 || end === -1 || end < start) return section.trim();
  return section.slice(start, end + VISUAL_EVIDENCE_END_MARKER.length).trim();
}

function replaceVisualEvidenceManagedBlock(body: string, block: string): string | null {
  const start = body.indexOf(VISUAL_EVIDENCE_START_MARKER);
  const end = body.indexOf(VISUAL_EVIDENCE_END_MARKER);
  if (start === -1 || end === -1 || end < start) return null;
  const before = body.slice(0, start).trimEnd();
  const after = body.slice(end + VISUAL_EVIDENCE_END_MARKER.length).trimStart();
  if (!before) return after ? `${block}\n\n${after}` : block;
  if (!after) return `${before}\n\n${block}`;
  return `${before}\n\n${block}\n\n${after}`;
}

export function upsertVisualEvidenceSection(body: string, section: string): string {
  const block = extractVisualEvidenceManagedBlock(section);
  const replaced = replaceVisualEvidenceManagedBlock(body, block);
  if (replaced !== null) return replaced.replace(/\n{3,}/g, "\n\n").trim();

  if (hasMarkdownSection(body, "Verification Verdict")) {
    return insertSectionsAfterHeading(body, "Verification Verdict", [section]);
  }
  if (hasMarkdownSection(body, "Verdict")) {
    return insertSectionsAfterHeading(body, "Verdict", [section]);
  }
  if (hasMarkdownSection(body, "Verification Details")) {
    return insertSectionsAfterHeading(body, "Verification Details", [section]);
  }
  return insertSections(body, [section]);
}

function removeMarkdownSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = findMarkdownBoundaryIndex(lines, (line) => headingPattern(heading).test(line.trim()));
  if (start === -1) return markdown;

  const nextBoundary = findMarkdownBoundaryIndex(
    lines,
    (line) => isMarkdownHeading(line) || isPrBodyFooterLine(line),
    start + 1,
  );
  const end = nextBoundary === -1 ? lines.length : nextBoundary;
  return [...lines.slice(0, start), ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactText(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3).trimEnd()}...` : compact;
}

function compactVerificationDetail(text: string): string {
  const trimmed = text.trim();
  if (!looksLikeVerboseVerificationDetail(trimmed)) return trimmed;

  const withoutVerboseParenthetical = trimmed.replace(/\s*\((?:.|\n){160,}\)\.?$/u, "");
  const compact = compactText(withoutVerboseParenthetical || trimmed, 240);
  return `${ensureTerminalPunctuation(compact)} ${VERIFICATION_DIAGNOSTIC_COMMENT_NOTE}`;
}

function ensureTerminalPunctuation(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function evidenceStatus(status: string | undefined): string {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "uploaded") return "captured";
  return status?.trim() || "recorded";
}

function extractShellPayload(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  const shellPayload = normalized.match(/^(?:\/bin\/)?(?:bash|sh|zsh)\s+-[A-Za-z]*c[A-Za-z]*\s+(.+)$/i)?.[1];
  if (!shellPayload) return normalized;
  return shellPayload.replace(/^(['"])(.*)\1$/, "$2").trim();
}

function evidencePurpose(label: string | undefined, command: string | undefined): string {
  const normalizedLabel = label?.toLowerCase() ?? "";
  const payload = command ? extractShellPayload(command) : "";
  const normalizedCommand = payload.toLowerCase();

  if (/\bcurl\b|https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/(?:api|healthz?|health)\b/i.test(payload)) {
    return "API smoke check";
  }
  if (/\bnode\s+-e\b/.test(normalizedCommand)) return "Node verification script";
  if (normalizedLabel.includes("tests")) return "Targeted tests";
  if (/\b(?:playwright|chromium|locator\.|page\.goto|browser\.newcontext)\b/.test(normalizedCommand)) {
    return "Browser UI check";
  }
  if (/\bdocker\s+compose\s+config\b/.test(normalizedCommand)) return "Docker Compose config validation";
  if (/\bdocker\s+compose\s+build\b/.test(normalizedCommand)) return "Docker image build";
  if (/\bdocker\s+(?:compose\s+(?:up|ps)|inspect)\b/.test(normalizedCommand)) return "Container health smoke";
  if (/\b(?:terraform|tofu|opentofu)\b/.test(normalizedCommand)) return "Infrastructure validation";
  if (
    /\b(?:tsc|typecheck|type-check|check:types?)\b/.test(normalizedCommand) ||
    normalizedLabel.includes("typecheck")
  ) {
    return "Typecheck";
  }
  if (/\b(?:eslint|lint|biome|prettier|oxlint|oxfmt)\b/.test(normalizedCommand) || normalizedLabel.includes("lint")) {
    return "Lint";
  }
  if (
    /\b(?:vitest|jest|playwright|pytest|node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test)\b/.test(
      normalizedCommand,
    )
  ) {
    return "Targeted tests";
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b/.test(normalizedCommand)) return "Build";
  return normalizedLabel.includes("command") ? "Verification command" : label?.trim() || "Verification proof";
}

function compactResultValue(summary: string | undefined): string | undefined {
  const compact = summary ? compactText(neutralizeReviewerInaccessibleLinks(summary), 240) : "";
  if (!compact) return undefined;
  const json = compact.match(/\{.*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed as Record<string, unknown>)
          .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
          .slice(0, 3);
        if (entries.length > 0) return entries.map(([key, value]) => `${key}=${String(value)}`).join(", ");
      }
    } catch {
      // Fall back to the original compact text below.
    }
  }
  return compact.replace(/[.!?]$/, "");
}

function extractApiSubject(command: string | undefined): string | undefined {
  if (!command) return undefined;
  const payload = extractShellPayload(command);
  const method = payload.match(/\s-X\s+([A-Z]+)\b/i)?.[1]?.toUpperCase();
  const url =
    payload.match(/https?:\/\/[^\s'"\\)]+/i)?.[0] ??
    payload.match(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\/[^\s'"\\)]+/i)?.[0];
  if (!url) return undefined;
  const normalizedUrl = url.startsWith("http") ? url : `http://${url}`;
  try {
    const parsed = new URL(normalizedUrl);
    const path = `${parsed.pathname}${parsed.search}` || "/";
    return method && method !== "GET" ? `${method} ${path}` : path;
  } catch {
    return method && method !== "GET" ? `${method} ${url}` : url;
  }
}

function extractTestSubjects(command: string | undefined): string[] {
  if (!command) return [];
  const targets: string[] = [];
  const valueOptions = new Set(["-t", "--testNamePattern", "--test-name-pattern"]);
  const targetPattern = /^(?:\.\/)?(?:(?:tests?|spec|__tests__)\/\S+|\S+[.-](?:test|spec)\.[cm]?[jt]sx?)$/i;
  const tokens = extractShellPayload(command).match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (valueOptions.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;

    const normalized = token.replace(/^(['"])(.*)\1$/, "$2").replace(/^\.\//, "");
    if (targetPattern.test(normalized)) targets.push(normalized);
  }
  return Array.from(new Set(targets));
}

function formatTestEvidenceLine(
  subject: string,
  entry: NonNullable<ExecutionVerification["evidence"]>[number],
): string {
  const result = compactResultValue(entry.summary);
  const status = evidenceStatus(entry.status);
  return result ? `${subject} ${status}: ${result}.` : `${subject} ${status}.`;
}

function formatEvidenceSummary(entry: NonNullable<ExecutionVerification["evidence"]>[number]): string {
  const apiSubject = extractApiSubject(entry.command);
  if (apiSubject) {
    const result = compactResultValue(entry.summary);
    if (entry.status === "passed") return result ? `${apiSubject} returned ${result}.` : `${apiSubject} passed.`;
    if (entry.status === "failed") return result ? `${apiSubject} failed: ${result}.` : `${apiSubject} failed.`;
  }

  const testSubject = extractTestSubjects(entry.command)[0];
  if (testSubject) {
    return formatTestEvidenceLine(testSubject, entry);
  }

  const purpose = evidencePurpose(entry.label, entry.command);
  const status = evidenceStatus(entry.status);
  const result = entry.summary ? compactText(neutralizeReviewerInaccessibleLinks(entry.summary), 240) : "";
  if (purpose === "Targeted tests" && result && entry.status === "passed") {
    return ensureTerminalPunctuation(result);
  }
  return result ? `${purpose} ${status}: ${ensureTerminalPunctuation(result)}` : `${purpose} ${status}.`;
}

function formatReferencedEvidenceLine(entry: NonNullable<ExecutionVerification["evidence"]>[number]): string {
  const label = escapeMarkdownText(entry.label.trim() || entry.type);
  const reference = entry.url?.trim()
    ? `[${label}](${escapeMarkdownLinkUrl(entry.url)})`
    : entry.artifactId?.trim()
      ? `${label} (${escapeMarkdownText(entry.artifactId.trim())})`
      : label;
  const summary = entry.summary ? compactVerificationDetail(entry.summary.trim()) : "";
  if (summary) {
    return `${reference}: ${ensureTerminalPunctuation(neutralizeReviewerInaccessibleLinks(summary))}`;
  }
  const status = evidenceStatus(entry.status);
  return `${reference} ${status}.`;
}

function buildReferencedEvidenceLines(evidence: NonNullable<ExecutionVerification["evidence"]>[number][]): string[] {
  const visibleLines = evidence
    .slice(0, VERIFICATION_DETAIL_MAX_LINES)
    .map((entry) => `  - ${formatReferencedEvidenceLine(entry)}`);
  const overflow = evidence.length - VERIFICATION_DETAIL_MAX_LINES;
  if (overflow > 0) {
    visibleLines.push(`  - …and ${overflow} more (full output in the session transcript)`);
  }
  return visibleLines;
}

type TargetedCommandEvidence = {
  target: string;
  targetCount: number;
  entry: NonNullable<ExecutionVerification["evidence"]>[number];
};

function hasResultTally(summary: string | undefined): boolean {
  return Boolean(summary && /\b[1-9]\d*\s+passed\b/i.test(summary));
}

function targetedEvidenceRank(candidate: TargetedCommandEvidence): number {
  const hasTally = hasResultTally(candidate.entry.summary) ? 1 : 0;
  return hasTally * 10_000 + candidate.targetCount;
}

function formatTargetedEvidenceSummary(candidate: TargetedCommandEvidence): string {
  if (candidate.targetCount > 1) {
    const status = evidenceStatus(candidate.entry.status);
    return `${candidate.target} ${status}: ran in a suite of ${candidate.targetCount}.`;
  }
  return formatTestEvidenceLine(candidate.target, candidate.entry);
}

function buildCommandEvidenceLines(
  commandEvidence: NonNullable<ExecutionVerification["evidence"]>[number][],
): string[] {
  const targetEvidence = new Map<string, TargetedCommandEvidence>();
  const untargetedLines = new Set<string>();

  for (const entry of commandEvidence) {
    // Expand only passing targeted commands. For failed multi-file suites, the
    // command-level failure does not prove which target failed; keep the
    // command collapsed so the PR body does not mark every target as failed.
    const targets = entry.status === "passed" ? extractTestSubjects(entry.command) : [];
    if (targets.length === 0) {
      untargetedLines.add(formatEvidenceSummary(entry));
      continue;
    }

    for (const target of targets) {
      const candidate = { target, targetCount: targets.length, entry };
      const current = targetEvidence.get(target);
      if (!current || targetedEvidenceRank(candidate) > targetedEvidenceRank(current)) {
        targetEvidence.set(target, candidate);
      }
    }
  }

  // Render untargeted evidence first so repo-wide signals (lint, typecheck,
  // build, full-suite runs) survive the line cap. Per-target test lines can be
  // numerous; if they came first, a large suite would push the high-value
  // repo-wide checks entirely into the overflow note.
  const lines = [...Array.from(untargetedLines), ...Array.from(targetEvidence.values(), formatTargetedEvidenceSummary)];
  const visibleLines = lines.slice(0, VERIFICATION_DETAIL_MAX_LINES).map((line) => `  - ${line}`);
  const overflow = lines.length - VERIFICATION_DETAIL_MAX_LINES;
  if (overflow > 0) {
    visibleLines.push(`  - …and ${overflow} more (full output in the session transcript)`);
  }
  return visibleLines;
}

function resolveVerificationVerdict(verification: ExecutionVerification): string {
  if (verification.verdict) return verification.verdict;
  if (
    verification.publishMode === "draft" ||
    verification.status === "manual_review_required" ||
    verification.status === "warn"
  ) {
    return "INCONCLUSIVE";
  }
  return verification.verified ? "CONFIRMED" : "INCONCLUSIVE";
}

const VERDICT_COPY: Record<"CONFIRMED" | "REFUTED" | "INCONCLUSIVE", string> = {
  CONFIRMED: "Pass",
  REFUTED: "Needs review",
  INCONCLUSIVE: "Needs review",
};

function verificationPublishLine(verification: ExecutionVerification, verdict: string): string {
  if (verdict === "CONFIRMED") return "Publish: ready for review.";
  return "Publish: manual review.";
}

function buildVerdictSummaryBlock(readiness: PrReadinessEvidence | null | undefined): string | undefined {
  const finalSummary =
    readiness?.evidenceBundle?.agentFinalMessage?.trim() || readiness?.evidenceBundle?.finalSummary?.trim();
  if (!finalSummary) return undefined;
  return ["Summary:", "", neutralizeReviewerInaccessibleLinks(finalSummary)].join("\n");
}

function buildVerdictSection(
  verification: ExecutionVerification | null | undefined,
  readiness: PrReadinessEvidence | null | undefined,
): string | undefined {
  if (!verification) return undefined;

  const verdict = resolveVerificationVerdict(verification);
  const verdictLabel = VERDICT_COPY[verdict as keyof typeof VERDICT_COPY] ?? "Needs review";
  const lines = ["## Verdict", `- Verdict: ${verdictLabel}.`, `- ${verificationPublishLine(verification, verdict)}`];

  if (verification.claim?.trim()) {
    lines.push(`- Claim: ${ensureTerminalPunctuation(neutralizeReviewerInaccessibleLinks(verification.claim.trim()))}`);
  }

  const referencedEvidence = verification.evidence?.filter((entry) => entry.type !== "command") ?? [];
  const commandEvidence = verification.evidence?.filter((entry) => entry.type === "command") ?? [];
  const evidenceLines = [
    ...buildReferencedEvidenceLines(referencedEvidence),
    ...buildCommandEvidenceLines(commandEvidence),
  ];
  if (evidenceLines.length > 0) {
    lines.push("- Evidence:", ...evidenceLines);
  }

  const caveats = (verification.caveats ?? [])
    .map((caveat) => compactVerificationDetail(caveat.trim()))
    .filter(Boolean);
  if (caveats.length > 0) {
    lines.push(
      `- Caveats: ${caveats.map((caveat) => ensureTerminalPunctuation(neutralizeReviewerInaccessibleLinks(caveat))).join(" ")}`,
    );
  } else if (verdict !== "CONFIRMED") {
    lines.push("- Caveats: manual verification required before merge.");
  }

  const notes = (verification.notes ?? []).map((note) => compactVerificationDetail(note.trim())).filter(Boolean);
  if (notes.length > 0) {
    lines.push(
      `- Notes: ${notes.map((note) => ensureTerminalPunctuation(neutralizeReviewerInaccessibleLinks(note))).join(" ")}`,
    );
  }

  if (verification.manualReviewReason?.trim()) {
    lines.push(
      `- Manual review: ${ensureTerminalPunctuation(neutralizeReviewerInaccessibleLinks(verification.manualReviewReason.trim()))}`,
    );
  }
  lines.push(
    verdict === "CONFIRMED"
      ? "- Reviewer action: inspect the evidence and changed files before merge."
      : "- Reviewer action: manually verify before merge.",
  );

  const checksBlock = buildChecksBlock(verification, readiness);
  if (checksBlock.length > 0) lines.push("", ...checksBlock);

  const summaryBlock = buildVerdictSummaryBlock(readiness);
  if (summaryBlock) lines.push("", summaryBlock);

  return lines.join("\n");
}

function formatSummaryCommandLine(command: VerificationSummaryCommand): string {
  const label = `\`${command.command.replace(/`/g, "'")}\``;
  if (command.status === "skipped") {
    const reason = command.skipReason ? ` (${escapeMarkdownText(command.skipReason)})` : "";
    return `- ${label} — skipped${reason}`;
  }
  const exit = command.exitCode !== null ? ` (exit ${command.exitCode})` : "";
  return `- ${label} — ${command.status}${exit}`;
}

/**
 * Structured checks block from the shared {@link VerificationSummary}:
 * pass/fail + exit codes inline, full output via the session transcript link
 * already appended to every PR body.
 */
function buildChecksBlock(
  verification: ExecutionVerification | null | undefined,
  readiness: PrReadinessEvidence | null | undefined,
): string[] {
  const summary = buildVerificationSummary({ verification, readiness });
  // Checks that were skipped without any recorded command (e.g. detected but
  // never run); commands with their own skip lines already cover the rest.
  const coveredChecks = new Set(summary.commands.flatMap((command) => command.checks));
  const skippedWithoutCommands = summary.skippedChecks.filter((entry) => !coveredChecks.has(entry.check));
  if (summary.commands.length === 0 && skippedWithoutCommands.length === 0 && !summary.runtimeEvidence?.required) {
    return [];
  }

  // Bold pseudo-heading on purpose: a real `### Checks` heading inside
  // `## Verdict` would terminate removeMarkdownSection early and leave the
  // old block behind on republish upserts.
  const lines = ["**Checks**", ""];
  for (const command of summary.commands.slice(0, VERIFICATION_DETAIL_MAX_LINES)) {
    lines.push(formatSummaryCommandLine(command));
  }
  const overflow = summary.commands.length - VERIFICATION_DETAIL_MAX_LINES;
  if (overflow > 0) {
    lines.push(`- …and ${overflow} more (full output in the session transcript)`);
  }
  for (const entry of skippedWithoutCommands) {
    lines.push(`- ${entry.check} — skipped (${escapeMarkdownText(entry.reason)})`);
  }
  if (summary.runtimeEvidence?.required) {
    lines.push(`- Runtime evidence: ${summary.runtimeEvidence.satisfied ? "captured" : "not captured"}`);
  }
  return lines;
}

function upsertVerificationVerdictSection(
  body: string,
  verification: ExecutionVerification | null | undefined,
  readiness: PrReadinessEvidence | null | undefined,
): string {
  if (!verification) return body;

  const verdictSection = buildVerdictSection(verification, readiness);
  if (!verdictSection) return body;

  const withoutPreviousVerdict = removeMarkdownSection(removeMarkdownSection(body, "Verification Verdict"), "Verdict");
  return insertSections(withoutPreviousVerdict, [verdictSection]);
}

export function buildPrBody(
  context: PrBodySessionContext | null,
  body: string,
  verification?: ExecutionVerification,
  readiness?: PrReadinessEvidence,
): string {
  const normalizedBody = normalizeScreenshotEvidenceLinks(body);
  const linkedBody = appendGithubIssueLink(
    appendLinearLink(normalizedBody, context?.linearContext ?? undefined),
    context?.githubIssueContext ?? undefined,
  );
  if (
    CYCLOID_MANAGED_VERIFICATION_BLOCK_RE.test(linkedBody) ||
    hasMarkdownSection(linkedBody, "Functional Verification") ||
    linkedBody.includes(BRIDGE_VERIFICATION_RENDERED_MARKER)
  ) {
    return normalizeScreenshotEvidenceLinks(neutralizeReviewerInaccessibleLinks(linkedBody));
  }
  return normalizeScreenshotEvidenceLinks(
    upsertVerificationVerdictSection(neutralizeReviewerInaccessibleLinks(linkedBody), verification, readiness),
  );
}
