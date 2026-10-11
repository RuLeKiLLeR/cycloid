import { isRelevantCheckCommand } from "../../../../shared/command-classification.js";
import type { PrTemplateFillLlmOutput } from "../../../../shared/llm/post-execution.js";
import { BRIDGE_VERIFICATION_RENDERED_MARKER, DEFAULT_PR_TEMPLATE } from "../../../../shared/post-execution.js";
import type {
  ExecutionVerification,
  PrReadinessCheck,
  PrReadinessCommand,
  PrReadinessEvidence,
} from "../../../../shared/types/sandbox.js";
import { neutralizeReviewerInaccessibleLinks } from "../utils/pr-body-links.js";
import { stripAnsiEscapeCodes } from "./ansi.js";
import { isRecoveredFailedCommand, verificationTargetKeys, verificationTargetsFullyCovered } from "./pr-readiness.js";
import {
  assembleSectionFilledBody,
  type CompactPrTemplateContent,
  containsCycloidPlaceholders,
  type PrTemplateCandidate,
  renderPrBodyFromTemplate,
  type ResolvedPrTemplate,
} from "./pr-template.js";

export type RenderPrBodyFromReadinessInput = {
  evidence: PrReadinessEvidence;
  generatedBody?: string;
  verification?: ExecutionVerification;
  footer?: string;
  prTemplate?: ResolvedPrTemplate;
  prTemplateFill?: PrTemplateFillLlmOutput;
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fencedTextBlock(value: string): string {
  const longestFence = Math.max(2, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return `${fence}text\n${value}\n${fence}`;
}

function stripGeneratedFooter(generatedBody: string): string {
  const footer = DEFAULT_PR_TEMPLATE.footer.trim();
  if (!footer) return generatedBody;
  return generatedBody
    .split("\n")
    .filter((line) => line.trim() !== footer)
    .join("\n")
    .trim();
}

function withPrReadinessDefaults(evidence: PrReadinessEvidence): PrReadinessEvidence {
  const partial = evidence as Partial<PrReadinessEvidence>;
  const diffStats = partial.diffStats ?? {
    filesChanged: partial.changedFiles?.length ?? 0,
    insertions: 0,
    deletions: 0,
  };

  return {
    ...evidence,
    changedFiles: partial.changedFiles ?? [],
    diffStats: {
      filesChanged: diffStats.filesChanged ?? partial.changedFiles?.length ?? 0,
      insertions: diffStats.insertions ?? 0,
      deletions: diffStats.deletions ?? 0,
      ...(diffStats.raw ? { raw: diffStats.raw } : {}),
    },
    commandsRun: partial.commandsRun ?? [],
    checksDetected: partial.checksDetected ?? { tests: false, lint: false, typecheck: false },
    skippedChecks: partial.skippedChecks ?? [],
    filesMentionedInFinalAnswer: partial.filesMentionedInFinalAnswer ?? [],
  };
}

function buildFailedVerifyTestDetailsSection(evidence: PrReadinessEvidence): string | undefined {
  const failedCommands = unrecoveredFailedCheckCommands(
    evidence.commandsRun.filter((command) => command.source === "post_execution"),
  ).filter((command) => commandCoversCheck(command, "tests"));
  if (failedCommands.length === 0) return undefined;

  const details = failedCommands
    .map((command) => {
      const output = stripAnsiEscapeCodes(
        command.failureOutput?.trim() || command.summary?.trim() || "No stdout/stderr was captured.",
      );
      return [
        "<details>",
        `<summary><code>${escapeHtml(command.command)}</code> failed</summary>`,
        "",
        fencedTextBlock(output),
        "",
        "</details>",
      ].join("\n");
    })
    .join("\n\n");

  return ["## Failed", details].join("\n");
}

function resolveFinalSummary(evidence: PrReadinessEvidence): string | undefined {
  return evidence.evidenceBundle?.agentFinalMessage?.trim() || evidence.evidenceBundle?.finalSummary?.trim();
}

// The agent appends its claim as a trailing "Verified: <claim>" line (optionally
// followed by a "Verification target:" line) to its final message. Strip that
// trailing block from the ## Summary narrative so the summary stays focused on
// the agent's change description.
// Anchored to the LAST "Verified:" line (the negative lookahead rejects a match
// that still has a later "Verified:" line), so an earlier intermediate
// "Verified:" line and any narrative after it are preserved.
const TRAILING_VERIFIED_CLAIM_RE = /(?:\r?\n)+[ \t]*Verified:\s(?:(?!\r?\n[ \t]*Verified:)[\s\S])*$/i;

export function cleanNarrativeText(message: string): string {
  const narrative = stripAnsiEscapeCodes(message).replace(TRAILING_VERIFIED_CLAIM_RE, "").trimEnd();
  return narrative ? neutralizeReviewerInaccessibleLinks(narrative) : "";
}

export function appendCappedNarrative(list: string[], narrative: string, max: number): void {
  const trimmed = narrative.trim();
  if (!trimmed) return;
  list.push(trimmed);
  while (list.length > max) list.shift();
}

export function buildCleanNarrative(evidence: PrReadinessEvidence): string {
  const current = cleanNarrativeText(resolveFinalSummary(evidence) ?? "");
  const prior = evidence.evidenceBundle?.priorNarratives ?? [];
  return [...prior, current]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
}

function extractAgentSummary(evidence: PrReadinessEvidence, generatedBody: string | undefined): string {
  const raw =
    buildCleanNarrative(evidence) ||
    stripAnsiEscapeCodes(generatedBody?.trim() || "") ||
    "No summary was captured from the agent.";
  const withoutFooter = stripGeneratedFooter(raw).replace(TRAILING_VERIFIED_CLAIM_RE, "").trimEnd();
  const withoutHeading = withoutFooter.replace(/^##\s+Summary\s*/i, "").trim();
  return neutralizeReviewerInaccessibleLinks(withoutHeading || "No summary was captured from the agent.");
}

function buildMinimalVerificationContent(evidence: PrReadinessEvidence): string | undefined {
  const failedSection = buildFailedVerifyTestDetailsSection(evidence);
  return failedSection;
}

function buildSummarySection(
  evidence: PrReadinessEvidence,
  generatedBody: string | undefined,
  heading = "## Summary",
): string {
  return [heading, extractAgentSummary(evidence, generatedBody)].join("\n\n");
}

function renderMinimalPrBody(input: { evidence: PrReadinessEvidence; generatedBody?: string }): string {
  return [buildMinimalVerificationContent(input.evidence), buildSummarySection(input.evidence, input.generatedBody)]
    .filter(Boolean)
    .join("\n\n");
}

function commandCoversCheck(command: PrReadinessCommand, check: PrReadinessCheck): boolean {
  return command.check === check || command.checks?.includes(check) === true;
}

function unrecoveredFailedCheckCommands(commands: PrReadinessCommand[]): PrReadinessCommand[] {
  return commands.filter((command, index) => {
    if (isRecoveredFailedCommand(commands, index)) return false;
    if (command.source !== "post_execution") return false;
    if (command.status !== "error" || !command.check) return false;
    return !isFailedEvidenceCoveredByPassedTarget(command, commands.slice(index + 1));
  });
}

function isFailedEvidenceCoveredByPassedTarget(
  failedCommand: PrReadinessCommand,
  laterCommands: PrReadinessCommand[],
): boolean {
  const sameCheckPassedCommands = laterCommands.filter(
    (laterCommand) =>
      laterCommand.source === "post_execution" &&
      laterCommand.status === "completed" &&
      commandCoversCheck(laterCommand, failedCommand.check!),
  );
  if (sameCheckPassedCommands.length === 0) return false;

  const failedTargets = verificationTargetKeys(failedCommand);
  if (failedTargets.length === 0) return true;

  const passedTargets = sameCheckPassedCommands.flatMap((laterCommand) => verificationTargetKeys(laterCommand));
  return verificationTargetsFullyCovered(failedTargets, passedTargets);
}

function buildCompactTemplateContent(input: {
  evidence: PrReadinessEvidence;
  verification?: ExecutionVerification;
  generatedBody?: string;
}): CompactPrTemplateContent {
  const agentSummary = extractAgentSummary(input.evidence, input.generatedBody);
  return {
    narrative: agentSummary,
    summary: agentSummary,
    verification: buildVerificationFactContent(input.evidence),
    visualEvidence: buildVisualEvidenceFactContent(input.evidence, input.verification),
    risk: "",
    followUps: "",
    checkedCheckboxes: [],
  };
}

function buildVerificationFactContent(evidence: PrReadinessEvidence): string {
  const commands = evidence.commandsRun
    .filter(
      (command) =>
        command.source === "post_execution" &&
        (command.status === "completed" || command.status === "error") &&
        (isRelevantCheckCommand(command.command) || command.check !== undefined || (command.checks?.length ?? 0) > 0),
    )
    .slice(0, 12);
  if (commands.length === 0) return "";
  return [
    "Commands run:",
    ...commands.map((command) => {
      const status =
        command.status === "completed" && (command.exitCode === 0 || command.exitCode == null) ? "passed" : "failed";
      const label = command.check ?? "command";
      return `- \`${neutralizeReviewerInaccessibleLinks(command.command)}\` (${label}) — ${status}.`;
    }),
  ].join("\n");
}

type ReadinessVisualEvidence = PrReadinessEvidence & {
  verifierResult?: {
    publishableEvidence?: Array<{ path: string; label: string }>;
    evidenceRefs?: Array<{ type: string; label: string; url?: string }>;
  };
};

type VerificationWithPublishableEvidence = ExecutionVerification & {
  publishableEvidence?: Array<{ path: string; label: string }>;
};

function buildVisualEvidenceFactContent(
  evidence: PrReadinessEvidence,
  verification: ExecutionVerification | undefined,
): string {
  const visualEvidence = evidence as ReadinessVisualEvidence;
  const verificationEvidence = verification as VerificationWithPublishableEvidence | undefined;
  const refs = [
    ...(verificationEvidence?.publishableEvidence ?? []).map((ref) => ({
      label: ref.label,
      url: ref.path,
      type: "artifact",
    })),
    ...(verificationEvidence?.evidence ?? [])
      .filter((ref) => (ref.type === "screenshot" || ref.type === "video") && ref.url)
      .map((ref) => ({ label: ref.label, url: ref.url!, type: ref.type })),
    ...(visualEvidence.verifierResult?.publishableEvidence ?? []).map((ref) => ({
      label: ref.label,
      url: ref.path,
      type: "artifact",
    })),
    ...(visualEvidence.verifierResult?.evidenceRefs ?? [])
      .filter((ref) => (ref.type === "screenshot" || ref.type === "video") && ref.url)
      .map((ref) => ({ label: ref.label, url: ref.url!, type: ref.type })),
  ];
  const seen = new Set<string>();
  const links = refs
    .filter((ref) => {
      if (seen.has(ref.url)) return false;
      seen.add(ref.url);
      return true;
    })
    .slice(0, 10)
    .map((ref) => `- [${ref.label || ref.type}](${ref.url})`);
  return links.join("\n");
}

const ANY_MANAGED_BLOCK_START_RE = /<!--\s*cycloid:managed:start\s+\w+\s*-->/;
const NARRATIVE_MANAGED_BLOCK_START_RE = /<!--\s*cycloid:managed:start\s+narrative\s*-->/;

export const DEFAULT_PR_SUMMARY_FILL_TEMPLATE: PrTemplateCandidate = {
  path: "cycloid://default-pr-summary-template",
  source: "org_default",
  content: "## Summary\n",
};

function assembleTemplatedBody(input: {
  template: PrTemplateCandidate;
  prTemplateFill: PrTemplateFillLlmOutput | undefined;
  content: CompactPrTemplateContent;
}): string {
  // Placeholder templates must go through the deterministic renderer: the
  // section fill targets headings and would leave {{CYCLOID_*}} tokens literal.
  if (input.prTemplateFill && !containsCycloidPlaceholders(input.template.content)) {
    const assembled = assembleSectionFilledBody({
      templateContent: input.template.content,
      fill: input.prTemplateFill,
      deterministic: {
        verificationBlock: input.content.verification,
        visualEvidence: input.content.visualEvidence,
        checkedCheckboxes: input.content.checkedCheckboxes,
      },
    });
    if (ANY_MANAGED_BLOCK_START_RE.test(assembled) && NARRATIVE_MANAGED_BLOCK_START_RE.test(assembled)) {
      return assembled;
    }
  }
  return renderPrBodyFromTemplate({ template: input.template, content: input.content });
}

export function renderPrEvidenceCommentFromReadiness(input: RenderPrBodyFromReadinessInput): string {
  const evidence = withPrReadinessDefaults(input.evidence);
  if (input.prTemplate?.status === "found") {
    const templatedBody = assembleTemplatedBody({
      template: input.prTemplate.candidate,
      prTemplateFill: input.prTemplateFill,
      content: buildCompactTemplateContent({
        evidence,
        verification: input.verification,
        generatedBody: input.generatedBody,
      }),
    });
    return [buildMinimalVerificationContent(evidence), templatedBody, BRIDGE_VERIFICATION_RENDERED_MARKER]
      .filter(Boolean)
      .join("\n\n");
  }
  if (input.prTemplateFill) {
    const templatedBody = assembleTemplatedBody({
      template: DEFAULT_PR_SUMMARY_FILL_TEMPLATE,
      prTemplateFill: input.prTemplateFill,
      content: buildCompactTemplateContent({
        evidence,
        verification: input.verification,
        generatedBody: input.generatedBody,
      }),
    });
    return [buildMinimalVerificationContent(evidence), templatedBody, BRIDGE_VERIFICATION_RENDERED_MARKER]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    renderMinimalPrBody({ evidence, generatedBody: input.generatedBody }),
    BRIDGE_VERIFICATION_RENDERED_MARKER,
  ].join("\n\n");
}
