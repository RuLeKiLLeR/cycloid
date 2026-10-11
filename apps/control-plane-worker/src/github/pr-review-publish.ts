import { PR_REVIEW_MIN_CONFIDENCE, REVIEW_AGENT_DISPLAY_NAME } from "../../../../shared/agent/constants.js";
import { PR_PERSONAS, renderPersonaHeader } from "../../../../shared/agent/pr-personas.js";
import { CYCLOID_REVIEW_COMMENT_MARKER, PR_REVIEW_MAX_INLINE_BODY_CHARS } from "../constants/pr-review-trigger";
import type { Logger } from "../logger";
import {
  createPrIssueComment,
  createPullRequestReview,
  getPrDiff,
  getPrReviewComments,
  listPrIssueComments,
  updateIssueComment,
  updatePrReviewComment,
} from "./pr";
import { fetchRepoTextFileAtCommit } from "./repo-source";

export interface PrReviewFinding {
  path: string;
  line: number;
  side: "RIGHT";
  severity: "P1" | "P2";
  title: string;
  confidence?: number;
  bodyMarkdown: string;
  security?: boolean;
  suggestion?: string;
  citations?: string[];
}

export interface PrReviewPublication {
  summaryMarkdown?: string;
  verdict: "clear" | "issues_found" | "inconclusive";
  checks: Array<{
    command: string;
    reason: string;
    status: "passed" | "failed" | "skipped";
    exitCode: number | null;
    detail: string;
  }>;
  scopeNotVerified: string[];
  confidenceScore: number;
  importantFiles: Array<{ path: string; reason: string }>;
  findings: PrReviewFinding[];
  headSha: string;
}

export interface PublishPrReviewArgs {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  currentHeadSha: string;
  publication: PrReviewPublication;
  sessionId: string;
  prUrl: string;
  logger: Pick<Logger, "info">;
}

export interface PublishPrReviewResult {
  outcome: "published" | "publish_partial" | "stale_head";
  summaryCommentId: number;
  inlineCommentCount: number;
  foldedFindingCount: number;
}

const GITHUB_COMMENT_BODY_SOFT_LIMIT = 60_000;
const TRUNCATION_NOTICE = "\n\n[Truncated to fit GitHub comment limits.]";

async function validateFindingCitations(
  findings: PrReviewFinding[],
  token: string,
  owner: string,
  repo: string,
  headSha: string,
): Promise<PrReviewFinding[]> {
  return Promise.all(
    findings.map(async (finding) => {
      const citations = finding.citations?.filter(isSafeCitation);
      if (!citations?.length) return { ...finding, citations: undefined };
      const verified = await Promise.all(
        citations.map(async (citation) => {
          try {
            await fetchRepoTextFileAtCommit(token, owner, repo, citation, headSha);
            return citation;
          } catch {
            return null;
          }
        }),
      );
      return { ...finding, citations: verified.filter((citation): citation is string => citation !== null) };
    }),
  );
}

export function changedRightSideLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  let path: string | null = null;
  let rightLine = 0;

  for (const line of diff.split("\n")) {
    const fileMatch = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (fileMatch) {
      path = fileMatch[2];
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      rightLine = Number(hunkMatch[1]);
      continue;
    }
    if (!path || line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      const lines = changed.get(path) ?? new Set<number>();
      lines.add(rightLine);
      changed.set(path, lines);
      rightLine += 1;
    } else if (!line.startsWith("-")) {
      rightLine += 1;
    }
  }

  return changed;
}

function findingBody(finding: PrReviewFinding): string {
  const badge = finding.severity === "P1" ? "🔴" : "🟠";
  const security = finding.security ? " · 🔐 security" : "";
  const suggestion =
    finding.suggestion && !finding.suggestion.includes("`") && !/[\r\n]/.test(finding.suggestion)
      ? `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``
      : "";
  const citations = finding.citations?.filter(isSafeCitation).length
    ? `\n\n**Context Used:** ${finding.citations
        .filter(isSafeCitation)
        .map((citation) => `\`${escapeInlineText(citation)}\``)
        .join(", ")}`
    : "";
  return `${prReviewFindingMarker(finding)}\n${badge} **[${finding.severity}${security}] ${escapeInlineText(finding.title)}**\n\n${finding.bodyMarkdown}${suggestion}${citations}`;
}

export function prReviewFindingMarker(finding: PrReviewFinding): string {
  // The title identifies the issue; evidence wording is mutable across re-reviews.
  // Keeping mutable body text out of the marker lets an updated explanation patch
  // the existing thread instead of creating a duplicate.
  const input = `${finding.path}\n${finding.title.trim().toLocaleLowerCase()}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `<!-- cycloid-zeus-finding: ${finding.path}:${(hash >>> 0).toString(16)} -->`;
}

function severityFromExistingBody(body: string): PrReviewFinding["severity"] | null {
  const match = /\*\*\[(P[12])(?: · 🔐 security)?\]/.exec(body);
  return match?.[1] === "P1" || match?.[1] === "P2" ? match[1] : null;
}

function normalizeFindingTitle(title: string): string {
  return title.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function matchesLegacyFindingComment(
  comment: { path: string; line: number | null; body: string },
  finding: PrReviewFinding,
): boolean {
  if (comment.path !== finding.path || (comment.line !== null && comment.line !== finding.line)) return false;
  const title = /\*\*\[P[12](?: · 🔐 security)?\]\s+(.+?)\*\*/.exec(comment.body)?.[1];
  return title ? normalizeFindingTitle(title) === normalizeFindingTitle(finding.title) : false;
}

function isSafeCitation(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..");
}

function escapeInlineText(value: string): string {
  return value.replaceAll("`", "\\`").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderedFindingContent(finding: PrReviewFinding): string {
  return findingBody(finding).replace(/^<!-- cycloid-zeus-finding: [^>]+ -->\n/, "");
}

function fitGitHubCommentBody(body: string): string {
  if (body.length <= GITHUB_COMMENT_BODY_SOFT_LIMIT) return body;
  return `${body.slice(0, GITHUB_COMMENT_BODY_SOFT_LIMIT - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`;
}

function renderSummary(args: {
  publication: PrReviewPublication;
  owner: string;
  repo: string;
  prNumber: number;
  folded: PrReviewFinding[];
  staleHead: string | null;
  inlineFailure: boolean;
}): string {
  const escapeTableCell = (value: string): string => value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
  const { publication } = args;
  const verdictCopy = {
    clear: "Clear — no actionable Zeus finding was identified and applicable checks passed or were correctly skipped.",
    issues_found: "Issues found — Zeus identified one or more actionable P1/P2 findings below.",
    inconclusive: "Inconclusive — Zeus could not establish complete applicable evidence.",
  }[publication.verdict];
  const checks = publication.checks.length
    ? publication.checks
        .map(({ command, status, reason }) => `- **${status}**${command ? ` \`${command}\`` : ""} — ${reason}`)
        .join("\n")
    : "No repository-configured targeted checks.";
  const scope = publication.scopeNotVerified.length
    ? publication.scopeNotVerified.map((item) => `- ${item}`).join("\n")
    : "No additional scope limits reported.";
  const files = publication.importantFiles.length
    ? [
        "| File | Why it matters |",
        "| --- | --- |",
        ...publication.importantFiles.map(
          ({ path, reason }) => `| \`${escapeTableCell(path)}\` | ${escapeTableCell(reason)} |`,
        ),
      ].join("\n")
    : "No important files identified.";
  const foldedFindings = args.folded;
  const stale = args.staleHead
    ? `\n\n> Reviewed \`${publication.headSha.slice(0, 7)}\`, but the PR head moved to \`${args.staleHead.slice(0, 7)}\`. Inline comments were skipped.`
    : "";
  const inlineFailure = args.inlineFailure
    ? "\n\n> Inline comments could not be posted; the findings remain in this summary."
    : "";

  const findingIndex = publication.findings.length
    ? [...publication.findings]
        .sort((left, right) => left.severity.localeCompare(right.severity) || left.line - right.line)
        .map(
          (finding) =>
            `- [\`${finding.path}:${finding.line}\`](https://github.com/${args.owner}/${args.repo}/blob/${publication.headSha}/${finding.path}#L${finding.line}) **[${finding.severity}] ${escapeTableCell(finding.title)}**`,
        )
        .join("\n")
    : "No actionable findings.";

  return fitGitHubCommentBody(`${CYCLOID_REVIEW_COMMENT_MARKER}

${renderPersonaHeader(PR_PERSONAS.zeus)}

### Verdict
${verdictCopy}

Reviewed SHA: [\`${publication.headSha.slice(0, 7)}\`](https://github.com/${args.owner}/${args.repo}/pull/${args.prNumber}/commits/${publication.headSha})

### Findings
${foldedFindings.length ? foldedFindings.map((finding) => `- [\`${finding.path}:${finding.line}\`](https://github.com/${args.owner}/${args.repo}/blob/${publication.headSha}/${finding.path}#L${finding.line}) ${renderedFindingContent(finding)}`).join("\n") : "No actionable findings."}${stale}${inlineFailure}

### Finding index
${findingIndex}

### Checks run
${checks}

### Scope not verified
${scope}

### Important files
${files}

---
Reviews: last reviewed commit [\`${publication.headSha.slice(0, 7)}\`](https://github.com/${args.owner}/${args.repo}/pull/${args.prNumber}/commits/${publication.headSha})`);
}

async function upsertSummary(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<number> {
  const comments = await listPrIssueComments(token, owner, repo, prNumber);
  const existing = comments.find((comment) => comment.body.includes(CYCLOID_REVIEW_COMMENT_MARKER));
  if (existing) {
    await updateIssueComment(token, owner, repo, existing.id, body);
    return existing.id;
  }
  const created = await createPrIssueComment(token, owner, repo, prNumber, body);
  return created.id;
}

export function filterPrReviewFindingsByConfidence(findings: PrReviewFinding[]): PrReviewFinding[] {
  return findings.filter(
    (finding) => finding.confidence === undefined || finding.confidence >= PR_REVIEW_MIN_CONFIDENCE,
  );
}

export async function publishPrReview(args: PublishPrReviewArgs): Promise<PublishPrReviewResult> {
  const keptFindings = filterPrReviewFindingsByConfidence(args.publication.findings);
  args.logger.info(
    {
      sessionId: args.sessionId,
      prUrl: args.prUrl,
      droppedCount: args.publication.findings.length - keptFindings.length,
      keptCount: keptFindings.length,
    },
    "Filtered PR review findings by confidence",
  );

  const publication = {
    ...args.publication,
    findings: await validateFindingCitations(keptFindings, args.token, args.owner, args.repo, args.publication.headSha),
  };
  const staleHead = args.currentHeadSha === publication.headSha ? null : args.currentHeadSha;
  let valid: PrReviewFinding[] = [];
  let folded = publication.findings;

  if (!staleHead) {
    const changed = changedRightSideLines(await getPrDiff(args.token, args.owner, args.repo, args.prNumber));
    valid = publication.findings.filter((finding) => changed.get(finding.path)?.has(finding.line));
    const validSet = new Set(valid);
    folded = publication.findings.filter((finding) => !validSet.has(finding));
    let inlineBudget = 0;
    const withinBudget: PrReviewFinding[] = [];
    for (const finding of valid) {
      const bodyLength = findingBody(finding).length;
      if (inlineBudget + bodyLength > PR_REVIEW_MAX_INLINE_BODY_CHARS) continue;
      inlineBudget += bodyLength;
      withinBudget.push(finding);
    }
    valid = withinBudget;
    const inlineSet = new Set(valid);
    folded = publication.findings.filter((finding) => !inlineSet.has(finding));
  }

  let summaryBody = renderSummary({
    publication,
    owner: args.owner,
    repo: args.repo,
    prNumber: args.prNumber,
    folded,
    staleHead,
    inlineFailure: false,
  });
  let summaryCommentId = await upsertSummary(args.token, args.owner, args.repo, args.prNumber, summaryBody);

  if (staleHead) {
    return { outcome: "stale_head", summaryCommentId, inlineCommentCount: 0, foldedFindingCount: folded.length };
  }
  if (valid.length === 0) {
    return { outcome: "published", summaryCommentId, inlineCommentCount: 0, foldedFindingCount: folded.length };
  }

  try {
    const existingComments = await getPrReviewComments(args.token, args.owner, args.repo, args.prNumber);
    const existingByMarker = new Map(
      existingComments.flatMap((comment) => {
        const marker = comment.body.match(/<!-- cycloid-zeus-finding: [^>]+ -->/)?.[0];
        return marker && comment.id !== null ? [[marker, comment] as const] : [];
      }),
    );
    const newFindings: PrReviewFinding[] = [];
    let updatedCount = 0;
    for (const finding of valid) {
      const existing =
        existingByMarker.get(prReviewFindingMarker(finding)) ??
        existingComments.find((comment) => matchesLegacyFindingComment(comment, finding));
      if (!existing || existing.id === null || existing.path !== finding.path) {
        newFindings.push(finding);
        continue;
      }
      await updatePrReviewComment(
        args.token,
        args.owner,
        args.repo,
        existing.id,
        findingBody({ ...finding, severity: severityFromExistingBody(existing.body) ?? finding.severity }),
      );
      updatedCount += 1;
    }
    if (newFindings.length > 0) {
      await createPullRequestReview(args.token, args.owner, args.repo, args.prNumber, {
        commitId: publication.headSha,
        body: `${REVIEW_AGENT_DISPLAY_NAME} — Review summary: https://github.com/${args.owner}/${args.repo}/pull/${args.prNumber}#issuecomment-${summaryCommentId}`,
        event: "COMMENT",
        comments: newFindings.map((finding) => ({
          path: finding.path,
          line: finding.line,
          side: finding.side,
          body: findingBody(finding),
        })),
      });
    }
    return {
      outcome: "published",
      summaryCommentId,
      inlineCommentCount: updatedCount + newFindings.length,
      foldedFindingCount: folded.length,
    };
  } catch (error) {
    args.logger.info(
      {
        sessionId: args.sessionId,
        prUrl: args.prUrl,
        findingCount: valid.length,
        operation: "createPullRequestReview",
        error: error instanceof Error ? error.message : String(error),
      },
      "Inline PR review publication failed; falling back to summary",
    );
    folded = publication.findings;
    summaryBody = renderSummary({
      publication,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      folded,
      staleHead: null,
      inlineFailure: true,
    });
    summaryCommentId = await upsertSummary(args.token, args.owner, args.repo, args.prNumber, summaryBody);
    return {
      outcome: "publish_partial",
      summaryCommentId,
      inlineCommentCount: 0,
      foldedFindingCount: folded.length,
    };
  }
}
