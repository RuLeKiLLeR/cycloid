import type { PrReviewFinding } from "../github/pr-review-publish";
import { escapeSlackText } from "../slack/internal-alert-session-context";
import { postInternalAlert } from "../slack/internal-alerts";
import { PROJECT_CODE_REVIEW_CHANNEL_ID } from "../slack/internal-channels";
import type { Env } from "../types";

const MAX_RENDERED_FINDINGS = 5;

type ZeusReviewIssuesAlertEnv = Pick<Env, "SLACK_BOT_TOKEN">;

export interface ZeusReviewIssuesAlertInput {
  sessionId: string;
  prUrl: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  verdict: "issues_found";
  findings: PrReviewFinding[];
  inlineCommentCount: number;
  foldedFindingCount: number;
}

function safeText(value: string | number): string {
  return escapeSlackText(String(value).replaceAll("`", "ˋ").replace(/\s+/g, " ").trim());
}

export function buildZeusReviewIssuesAlertText(input: ZeusReviewIssuesAlertInput): string {
  const prLabel = `${safeText(input.repoOwner)}/${safeText(input.repoName)}#${safeText(input.prNumber)}`;
  const renderedFindings = input.findings
    .slice(0, MAX_RENDERED_FINDINGS)
    .map(
      (finding) =>
        `[${safeText(finding.severity)}] ${safeText(finding.title)} - ${safeText(finding.path)}:${safeText(finding.line)}`,
    );
  const remainingFindingCount = input.findings.length - renderedFindings.length;
  const findings = [
    `Findings: ${input.findings.length} (${input.inlineCommentCount} inline, ${input.foldedFindingCount} folded)`,
    ...renderedFindings,
    ...(remainingFindingCount > 0 ? [`… and ${remainingFindingCount} more`] : []),
  ];

  return [`🔎 *Zeus found issues* · <${escapeSlackText(input.prUrl)}|${prLabel}>`, "```", ...findings, "```"].join(
    "\n",
  );
}

export async function notifyZeusReviewIssues(
  env: ZeusReviewIssuesAlertEnv,
  input: ZeusReviewIssuesAlertInput,
): Promise<boolean> {
  const result = await postInternalAlert(
    env,
    PROJECT_CODE_REVIEW_CHANNEL_ID,
    buildZeusReviewIssuesAlertText(input),
    undefined,
    {
      sessionId: input.sessionId,
      prUrl: input.prUrl,
      verdict: input.verdict,
      findingCount: input.findings.length,
    },
  );
  return result?.ok === true;
}
