import { GPT54_MINI_SIDECAR_REASONING_EFFORT, OpenAIModel } from "../../../../shared/constants/models.js";
import type { StructuredOutputTool } from "../../../../shared/llm/structured-output.js";
import { MAX_PR_TITLE_LENGTH, normalizeSessionPrTitle } from "../session/pr-title.js";
import type { Env } from "../types.js";
import { queryPlatformStructuredOutput, type SessionMetadataTelemetryContext } from "./platform-structured-output.js";

const PUBLISH_PR_TITLE_REQUEST_TIMEOUT_MS = 4_500;
export const PUBLISH_PR_TITLE_MAX_CONTEXT_CHARS = 8_000;
const PUBLISH_PR_TITLE_MAX_CHANGED_FILES = 30;

export const PUBLISH_PR_TITLE_TOOL_NAME = "generate_publish_pr_title";
export const PUBLISH_PR_TITLE_MODEL = OpenAIModel.GPT54Nano;
export const PUBLISH_PR_TITLE_SYSTEM_PROMPT =
  "Generate a concise GitHub pull request title from publish-time change evidence. Return JSON with one short, specific title. Follow any title style evident in the repository or provided change evidence. Name the concrete changed behavior, symbol, or subsystem when the evidence supports it. Do not mention that this was generated, verified, investigated, reviewed, or published. Do not include a ticket key prefix.";

export const PUBLISH_PR_TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Short, specific pull request title without a ticket key prefix.",
    },
  },
  required: ["title"],
  additionalProperties: false,
} as const satisfies StructuredOutputTool["input_schema"];

const PUBLISH_PR_TITLE_TOOL: StructuredOutputTool = {
  name: PUBLISH_PR_TITLE_TOOL_NAME,
  description: "Create a concise PR title from publish-time change evidence.",
  input_schema: PUBLISH_PR_TITLE_SCHEMA,
};

export type PublishPrTitleEvidence = {
  currentTitle: string;
  diffSummary?: string | null;
  commitSha?: string | null;
  changedFiles?: string[] | null;
  diffStats?: {
    raw?: string;
    filesChanged?: number;
    insertions?: number;
    deletions?: number;
  } | null;
};

function hasPlatformOpenAiKey(env: Pick<Env, "ARCANIST_OPENAI_API_KEY">): boolean {
  const key = env.ARCANIST_OPENAI_API_KEY?.trim();
  return Boolean(key && key !== "CHANGE_ME");
}

function hasUsableDiffEvidence(evidence: PublishPrTitleEvidence): boolean {
  const diffSummary = evidence.diffSummary?.trim();
  const changedFiles = evidence.changedFiles?.map((file) => file.trim()).filter(Boolean) ?? [];
  const stats = evidence.diffStats;
  const changedLines = Math.max(0, stats?.insertions ?? 0) + Math.max(0, stats?.deletions ?? 0);
  return Boolean(diffSummary || changedFiles.length > 0 || changedLines > 0);
}

function parsePublishPrTitleResponse(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title = (value as { title?: unknown }).title;
  if (typeof title !== "string") return null;
  const normalized = normalizeSessionPrTitle(title);
  if (!normalized) return null;
  return normalized.length > MAX_PR_TITLE_LENGTH ? normalized.slice(0, MAX_PR_TITLE_LENGTH).trimEnd() : normalized;
}

function topLevelDirectory(file: string): string {
  const first = file.split("/").find(Boolean);
  return first ?? file;
}

function selectDiverseChangedFiles(files: string[]): string[] {
  const selected: string[] = [];
  const selectedSet = new Set<string>();
  const seenDirectories = new Set<string>();

  for (const file of files) {
    const directory = topLevelDirectory(file);
    if (seenDirectories.has(directory)) continue;
    selected.push(file);
    selectedSet.add(file);
    seenDirectories.add(directory);
    if (selected.length >= PUBLISH_PR_TITLE_MAX_CHANGED_FILES) return selected;
  }

  for (const file of files) {
    if (selectedSet.has(file)) continue;
    selected.push(file);
    if (selected.length >= PUBLISH_PR_TITLE_MAX_CHANGED_FILES) return selected;
  }

  return selected;
}

function truncateToLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "";
  return value.slice(0, maxLength - 1).trimEnd();
}

export function buildPublishPrTitlePrompt(evidence: PublishPrTitleEvidence): string {
  const sections: string[] = [`Current title:\n${evidence.currentTitle}`];

  const diffSummary = evidence.diffSummary?.trim();
  if (diffSummary) sections.push(`Change summary:\n${diffSummary}`);

  const changedFiles = evidence.changedFiles?.map((file) => file.trim()).filter(Boolean) ?? [];
  if (changedFiles.length > 0) sections.push(`Changed files:\n${changedFiles.join("\n")}`);

  const stats = evidence.diffStats;
  if (stats) {
    const statLines = [
      typeof stats.raw === "string" && stats.raw.trim() ? stats.raw.trim() : null,
      Number.isFinite(stats.filesChanged) ? `Files changed: ${stats.filesChanged}` : null,
      Number.isFinite(stats.insertions) ? `Insertions: ${stats.insertions}` : null,
      Number.isFinite(stats.deletions) ? `Deletions: ${stats.deletions}` : null,
    ].filter(Boolean);
    if (statLines.length > 0) sections.push(`Diff stats:\n${statLines.join("\n")}`);
  }

  const commitSha = evidence.commitSha?.trim();
  if (commitSha) sections.push(`Commit SHA:\n${commitSha}`);

  return sections.join("\n\n");
}

export function normalizePublishPrTitleEvidenceForPrompt(
  evidence: PublishPrTitleEvidence,
): PublishPrTitleEvidence | null {
  if (!hasUsableDiffEvidence(evidence)) return null;

  const normalized: PublishPrTitleEvidence = {
    currentTitle: normalizeSessionPrTitle(evidence.currentTitle),
    diffSummary: evidence.diffSummary?.trim() || null,
    commitSha: evidence.commitSha?.trim() || null,
    changedFiles: selectDiverseChangedFiles(evidence.changedFiles?.map((file) => file.trim()).filter(Boolean) ?? []),
    diffStats: evidence.diffStats
      ? {
          raw: evidence.diffStats.raw?.trim() || undefined,
          filesChanged: evidence.diffStats.filesChanged,
          insertions: evidence.diffStats.insertions,
          deletions: evidence.diffStats.deletions,
        }
      : null,
  };

  let currentPromptLength = buildPublishPrTitlePrompt(normalized).length;
  while (currentPromptLength > PUBLISH_PR_TITLE_MAX_CONTEXT_CHARS) {
    const overflow = currentPromptLength - PUBLISH_PR_TITLE_MAX_CONTEXT_CHARS;
    const summary = normalized.diffSummary?.trim();
    if (summary) {
      const nextSummary = truncateToLength(summary, Math.max(0, summary.length - overflow - 1));
      normalized.diffSummary = nextSummary || null;
      currentPromptLength = buildPublishPrTitlePrompt(normalized).length;
      continue;
    }

    if (normalized.diffStats?.raw) {
      normalized.diffStats = { ...normalized.diffStats, raw: undefined };
      currentPromptLength = buildPublishPrTitlePrompt(normalized).length;
      continue;
    }

    if ((normalized.changedFiles?.length ?? 0) > 0) {
      normalized.changedFiles = normalized.changedFiles!.slice(0, -1);
      currentPromptLength = buildPublishPrTitlePrompt(normalized).length;
      continue;
    }

    if (normalized.commitSha) {
      normalized.commitSha = null;
      currentPromptLength = buildPublishPrTitlePrompt(normalized).length;
      continue;
    }

    if (normalized.diffStats) {
      normalized.diffStats = null;
      currentPromptLength = buildPublishPrTitlePrompt(normalized).length;
      continue;
    }

    return null;
  }

  return hasUsableDiffEvidence(normalized) ? normalized : null;
}

export async function generatePublishPrTitle(
  env: Pick<Env, "ARCANIST_OPENAI_API_KEY">,
  evidence: PublishPrTitleEvidence,
  telemetryContext: SessionMetadataTelemetryContext,
): Promise<string | null> {
  if (!hasPlatformOpenAiKey(env)) return null;
  const normalizedEvidence = normalizePublishPrTitleEvidenceForPrompt(evidence);
  if (!normalizedEvidence) return null;
  const userPrompt = buildPublishPrTitlePrompt(normalizedEvidence);

  const result = await queryPlatformStructuredOutput(
    env,
    {
      model: PUBLISH_PR_TITLE_MODEL,
      reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
      tool: { ...PUBLISH_PR_TITLE_TOOL, strict: true },
      systemPrompt: PUBLISH_PR_TITLE_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 120,
      timeoutMs: PUBLISH_PR_TITLE_REQUEST_TIMEOUT_MS,
      strictErrors: true,
    },
    {
      subsystem: "session_metadata",
      callType: "publish_pr_title",
      phase: "post_execution",
      sourceId: `publish_pr_title:${telemetryContext.sessionId ?? "unknown"}:${telemetryContext.promptId ?? "no_prompt"}`,
      ...telemetryContext,
    },
  );

  return parsePublishPrTitleResponse(result);
}
