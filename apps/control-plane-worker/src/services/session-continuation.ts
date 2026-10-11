import {
  extractGithubPullRequestUrls,
  normalizeGithubPullRequestUrl,
} from "../../../../shared/agent/verify-directive.js";
import { GPT54_MINI_SIDECAR_REASONING_EFFORT, OpenAIModel } from "../../../../shared/constants/models.js";
import { type StructuredOutputTool } from "../../../../shared/llm/structured-output.js";
import { isSafeGitRef } from "../../../../shared/utils/git-ref.js";
import { fetchVerificationPrContext } from "../github/verification-pr-context";
import type { Logger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import type { RepoContext } from "../session/state";
import type { Env } from "../types";
import { queryPlatformStructuredOutput, type SessionMetadataTelemetryContext } from "./platform-structured-output";

export type ContinuePrMode = "auto" | "update-pr" | "new-pr";

export type AdoptedPrMetadata = {
  prUrl: string;
  prNumber: number;
  prDraft: boolean;
  publishedBranch: string;
  headSha: string;
};

export type ResolvedSessionContinuation = {
  repoContext: RepoContext;
  targetPrUrl: string | null;
  prUrl: string | null;
  prNumber: number | null;
  adoptedPrMetadata: AdoptedPrMetadata | null;
};

export type ResolveSessionContinuationInput = {
  env: Pick<Env, "DB" | "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY" | "REPOS_CACHE" | "ARCANIST_OPENAI_API_KEY">;
  sessionId: string;
  prompt: unknown;
  continuePrUrl?: unknown;
  continueMode?: unknown;
  repoContext: RepoContext;
  installationId: number | null;
  startBranch?: string | undefined;
  allowPromptInference: boolean;
  logger: Logger;
  telemetry?: SessionMetadataTelemetryContext;
};

type ClassifiedContinuationIntent = {
  shouldContinue: boolean;
  selectedPrUrl: string | null;
};

const CONTINUATION_INTENT_TOOL_NAME = "classify_pr_continuation_intent";
const CONTINUATION_INTENT_MODEL = OpenAIModel.GPT54Mini;
const CONTINUATION_INTENT_TIMEOUT_MS = 10_000;
const CONTINUATION_INTENT_MAX_TOKENS = 120;
const CONTINUATION_INTENT_PROMPT_MAX_CHARS = 4_000;

const CONTINUATION_INTENT_SYSTEM_PROMPT = [
  "Classify whether a user is asking Cycloid to continue work from an existing GitHub pull request.",
  "Return shouldContinue=true only when the user wants the coding session to pick up, finish, resume, take over, address feedback on, or otherwise work from a specific PR.",
  "Return shouldContinue=false when the PR is only reference material, an example, a dependency, or something to inspect without continuing its branch.",
  "If multiple PR URLs are present, select the one the user wants to continue. If none is clearly the continuation target, return false.",
].join(" ");

const CONTINUATION_INTENT_SCHEMA = {
  type: "object",
  properties: {
    shouldContinue: {
      type: "boolean",
      description: "Whether the user wants this session to continue from an existing pull request.",
    },
    selectedPrUrl: {
      type: ["string", "null"],
      description: "The exact GitHub pull request URL to continue, or null when shouldContinue is false.",
    },
  },
  required: ["shouldContinue", "selectedPrUrl"],
  additionalProperties: false,
} as const satisfies StructuredOutputTool["input_schema"];

const CONTINUATION_INTENT_TOOL: StructuredOutputTool = {
  name: CONTINUATION_INTENT_TOOL_NAME,
  description: "Classify PR continuation intent from a user task.",
  input_schema: CONTINUATION_INTENT_SCHEMA,
};

export class SessionContinuationError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  readonly reasonCode: string;

  constructor(status: number, publicMessage: string, reasonCode: string) {
    super(publicMessage);
    this.name = "SessionContinuationError";
    this.status = status;
    this.publicMessage = publicMessage;
    this.reasonCode = reasonCode;
  }
}

export function normalizeContinuePrMode(rawMode: unknown): ContinuePrMode | null {
  if (rawMode === undefined || rawMode === null || rawMode === "") return "auto";
  return rawMode === "auto" || rawMode === "update-pr" || rawMode === "new-pr" ? rawMode : null;
}

function hasExplicitContinueMode(rawMode: unknown): boolean {
  // normalizeContinuePrMode treats absence as "auto"; this predicate preserves
  // whether the caller actually supplied a mode so a mode without any PR target
  // remains a request error instead of silently becoming a normal session.
  return rawMode !== undefined && rawMode !== null && rawMode !== "";
}

function normalizePromptText(rawPrompt: unknown): string | null {
  if (typeof rawPrompt !== "string") return null;
  const trimmed = rawPrompt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncatePromptText(text: string): string {
  if (text.length <= CONTINUATION_INTENT_PROMPT_MAX_CHARS) return text;
  return text.slice(0, CONTINUATION_INTENT_PROMPT_MAX_CHARS).trimEnd();
}

function parseContinuationIntentOutput(value: unknown, candidateUrls: readonly string[]): ClassifiedContinuationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { shouldContinue: false, selectedPrUrl: null };
  }
  const candidate = value as { shouldContinue?: unknown; selectedPrUrl?: unknown };
  if (candidate.shouldContinue !== true) return { shouldContinue: false, selectedPrUrl: null };
  if (typeof candidate.selectedPrUrl !== "string") return { shouldContinue: false, selectedPrUrl: null };
  const normalized = normalizeGithubPullRequestUrl(candidate.selectedPrUrl);
  if (!normalized || !candidateUrls.includes(normalized)) return { shouldContinue: false, selectedPrUrl: null };
  return { shouldContinue: true, selectedPrUrl: normalized };
}

async function classifyContinuationIntent(
  input: Pick<
    ResolveSessionContinuationInput,
    "env" | "sessionId" | "prompt" | "repoContext" | "logger" | "telemetry"
  > & { candidateUrls: string[] },
): Promise<ClassifiedContinuationIntent> {
  const promptText = normalizePromptText(input.prompt);
  if (!promptText || input.candidateUrls.length === 0) return { shouldContinue: false, selectedPrUrl: null };

  try {
    const result = await queryPlatformStructuredOutput(
      input.env,
      {
        model: CONTINUATION_INTENT_MODEL,
        reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
        tool: { ...CONTINUATION_INTENT_TOOL, strict: true },
        systemPrompt: CONTINUATION_INTENT_SYSTEM_PROMPT,
        userPrompt: [
          "User task:",
          truncatePromptText(promptText),
          "",
          "Candidate PR URLs:",
          ...input.candidateUrls.map((url, index) => `${index + 1}. ${url}`),
        ].join("\n"),
        maxTokens: CONTINUATION_INTENT_MAX_TOKENS,
        timeoutMs: CONTINUATION_INTENT_TIMEOUT_MS,
        fetchImpl: tracedFetch,
        spanName: "openai.prContinuationIntent",
        strictErrors: true,
      },
      {
        subsystem: "session_create",
        callType: "pr_continuation_intent",
        phase: "session_create",
        sourceId: `pr_continuation_intent:${input.sessionId}`,
        sessionId: input.sessionId,
        repoOwner: input.repoContext.repoOwner ?? null,
        repoName: input.repoContext.repoName ?? null,
        ...input.telemetry,
      },
      { logger: input.logger },
    );
    return parseContinuationIntentOutput(result, input.candidateUrls);
  } catch (error) {
    input.logger.warn(
      { sessionId: input.sessionId, error: String(error) },
      "PR continuation intent classification failed",
    );
    return { shouldContinue: false, selectedPrUrl: null };
  }
}

export async function resolveSessionContinuation(
  input: ResolveSessionContinuationInput,
): Promise<ResolvedSessionContinuation> {
  const continueMode = normalizeContinuePrMode(input.continueMode);
  if (!continueMode) {
    throw new SessionContinuationError(400, "continueMode must be one of: auto, update-pr, new-pr", "invalid_mode");
  }

  const explicitContinuePrUrl = input.continuePrUrl !== undefined && input.continuePrUrl !== null;
  const explicitPrUrl = explicitContinuePrUrl ? normalizeGithubPullRequestUrl(input.continuePrUrl) : null;
  if (explicitContinuePrUrl && !explicitPrUrl) {
    throw new SessionContinuationError(400, "continuePrUrl must be a valid GitHub pull request URL", "invalid_url");
  }

  let continuePrUrl = explicitPrUrl;
  if (!continuePrUrl && input.allowPromptInference) {
    const candidateUrls = extractGithubPullRequestUrls(input.prompt);
    const intent = await classifyContinuationIntent({ ...input, candidateUrls });
    continuePrUrl = intent.shouldContinue ? intent.selectedPrUrl : null;
  }

  if (hasExplicitContinueMode(input.continueMode) && !continuePrUrl) {
    throw new SessionContinuationError(
      400,
      "continueMode requires continuePrUrl or a prompt-inferred continuation PR",
      "mode_without_pr",
    );
  }

  if (!continuePrUrl) {
    return {
      repoContext: input.repoContext,
      targetPrUrl: null,
      prUrl: null,
      prNumber: null,
      adoptedPrMetadata: null,
    };
  }

  let prContext;
  try {
    prContext = await fetchVerificationPrContext(input.env, continuePrUrl, {
      installationId: input.installationId,
      repoOwner: input.repoContext.repoOwner ?? null,
      repoName: input.repoContext.repoName ?? null,
      requireRepoMatch: true,
    });
  } catch (error) {
    input.logger.warn(
      { sessionId: input.sessionId, continuePrUrl, error: String(error) },
      "Failed to resolve continuation PR context",
    );
    throw new SessionContinuationError(400, "Could not resolve continuePrUrl on GitHub", "github_fetch_failed");
  }

  if (prContext.state !== "open") {
    throw new SessionContinuationError(400, "continuePrUrl must reference an open pull request", "closed_pr");
  }
  if (
    prContext.headRepoOwner?.toLowerCase() !== prContext.owner.toLowerCase() ||
    prContext.headRepoName?.toLowerCase() !== prContext.repo.toLowerCase()
  ) {
    throw new SessionContinuationError(400, "Fork pull requests cannot be continued yet", "fork_pr");
  }
  if (!prContext.headRef || !isSafeGitRef(prContext.headRef)) {
    throw new SessionContinuationError(400, "continuePrUrl has an unsafe or missing head branch", "unsafe_head_ref");
  }
  if (input.startBranch !== undefined && input.startBranch !== prContext.headRef) {
    throw new SessionContinuationError(
      400,
      "startBranch must match the continued pull request head branch",
      "start_branch_mismatch",
    );
  }
  if (input.repoContext.baseBranch && input.repoContext.baseBranch !== prContext.baseRef) {
    throw new SessionContinuationError(
      400,
      "baseBranch must match the continued pull request base branch",
      "base_branch_mismatch",
    );
  }

  const repoContext = {
    ...input.repoContext,
    baseBranch: input.repoContext.baseBranch ?? prContext.baseRef,
    startBranch: prContext.headRef,
  };
  const updatesExistingPr = continueMode !== "new-pr";

  return {
    repoContext,
    targetPrUrl: prContext.prUrl,
    prUrl: updatesExistingPr ? prContext.prUrl : null,
    prNumber: updatesExistingPr ? prContext.number : null,
    adoptedPrMetadata: updatesExistingPr
      ? {
          prUrl: prContext.prUrl,
          prNumber: prContext.number,
          prDraft: prContext.draft,
          publishedBranch: prContext.headRef,
          headSha: prContext.headSha,
        }
      : null,
  };
}
