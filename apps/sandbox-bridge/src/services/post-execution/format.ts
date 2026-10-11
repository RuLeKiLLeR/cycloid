import { redact, truncate } from "../../../../../shared/observability/redact.js";
import type { PrReadinessEvidence } from "../../../../../shared/types/sandbox.js";
import { extractCurrentTaskText, formatSessionUrl } from "../../utils/prompt-parsing.js";

export function buildPostExecutionEvidenceBundle(input: {
  promptContent: string;
  finalSummary: string;
  agentFinalMessage: string;
  controlPlaneUrl: string;
  publicAppUrl?: string;
  sessionId: string;
  // Cumulative session context (ARC-1143). When the session has prior prompts,
  // `sessionOriginalTask` is the first prompt's task and `priorNarratives` are the
  // earlier turns' cleaned narratives, so the PR body describes the whole PR.
  sessionOriginalTask?: string;
  priorNarratives?: string[];
}): NonNullable<PrReadinessEvidence["evidenceBundle"]> {
  const taskText = input.sessionOriginalTask?.trim() || extractCurrentTaskText(input.promptContent);
  const issueUrl = extractIssueUrl(taskText);
  const priorNarratives = (input.priorNarratives ?? []).map((n) => n.trim()).filter(Boolean);
  return {
    originalPrompt: taskText,
    finalSummary: input.finalSummary,
    agentFinalMessage: input.agentFinalMessage,
    ...(priorNarratives.length ? { priorNarratives } : {}),
    sessionUrl: formatSessionUrl(input.publicAppUrl ?? input.controlPlaneUrl, input.sessionId),
    ...(issueUrl ? { issueUrl } : {}),
  };
}

export function extractIssueUrl(content: string): string | undefined {
  const explicit = /^Issue URL:\s*(https?:\/\/\S+)/im.exec(content)?.[1];
  if (explicit) return explicit.replace(/[),.;]+$/, "");
  const fallback = /\bhttps?:\/\/(?:linear\.app\/\S+\/issue\/\S+|github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+)\b/i.exec(
    content,
  )?.[0];
  return fallback?.replace(/[),.;]+$/, "");
}

export function compactCommandOutputForReview(output: string): string {
  const excerpt = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  return truncate(redact(excerpt || "no output"), 240);
}
