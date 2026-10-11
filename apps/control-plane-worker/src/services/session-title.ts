import { GPT54_MINI_SIDECAR_REASONING_EFFORT, OpenAIModel } from "../../../../shared/constants/models.js";
import { StructuredOutputError, type StructuredOutputTool } from "../../../../shared/llm/structured-output.js";
import { SESSION_TITLE_MAX_LENGTH } from "../constants/sessions";
import type { Logger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import { normalizeTicketKey } from "../session/ticket-key";
import type { Env } from "../types";
import { queryPlatformStructuredOutput, type SessionMetadataTelemetryContext } from "./platform-structured-output";

const SESSION_TITLE_REQUEST_TIMEOUT_MS = 4_500;
const SESSION_TITLE_MAX_ATTEMPTS = 1;
const SESSION_TITLE_PROMPT_MAX_LENGTH = 4_000;
export const SESSION_TITLE_TOOL_NAME = "generate_session_title";
// Title generation has one attempt and a 4.5s request timeout on the session
// creation path. GPT-5.4 Nano is enough for short structured summarization and
// avoids spending the user's selected coding model on metadata.
export const SESSION_TITLE_MODEL = OpenAIModel.GPT54Nano;
export const SESSION_TITLE_SYSTEM_PROMPT =
  'Generate a concise title for a coding session request. Return JSON with a short, specific title in sentence case: capitalize only the first word plus proper nouns and acronyms, and avoid title case. Do not copy a long prompt verbatim. For investigation or alert prompts, title the concrete outcome or likely work item, not the act of investigating. Avoid titles beginning with "Investigate", "Triage", or "Look into" when a more specific subject is present. Also return ticketKey: the uppercase Linear/Jira issue key (e.g. ENG-1234, DATA-12) that this task is FOR. Set it only when the request is clearly the work for that ticket; return null if no key is given, or if a key is only referenced in passing (e.g. \'like we did in ENG-42\') or is a non-ticket token (e.g. UTF-8, CVE-2021-1).';
const SESSION_TITLE_CANONICAL_TERMS = new Map<string, string>([
  ["api", "API"],
  ["cycloid", "Cycloid"],
  ["aws", "AWS"],
  ["braintrust", "Braintrust"],
  ["ci", "CI"],
  ["cli", "CLI"],
  ["cloudflare", "Cloudflare"],
  ["d1", "D1"],
  ["datadog", "Datadog"],
  ["db", "DB"],
  ["do", "DO"],
  ["e2e", "E2E"],
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
  ["id", "ID"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["launchdarkly", "LaunchDarkly"],
  ["linear", "Linear"],
  ["llm", "LLM"],
  ["mcp", "MCP"],
  ["modal", "Modal"],
  ["oauth", "OAuth"],
  ["openai", "OpenAI"],
  ["codex", "Codex"],
  ["pr", "PR"],
  ["react", "React"],
  ["saml", "SAML"],
  ["slack", "Slack"],
  ["sql", "SQL"],
  ["sse", "SSE"],
  ["terraform", "Terraform"],
  ["typescript", "TypeScript"],
  ["ui", "UI"],
  ["url", "URL"],
  ["ux", "UX"],
  ["vite", "Vite"],
  ["vitest", "Vitest"],
  ["wrangler", "Wrangler"],
]);

export const SESSION_TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Short, specific title for the coding session.",
    },
    ticketKey: {
      type: ["string", "null"],
      description:
        "Uppercase Linear/Jira issue key (e.g. ENG-1234) the task is FOR, or null if none / only referenced in passing.",
    },
  },
  required: ["title", "ticketKey"],
  additionalProperties: false,
} as const satisfies StructuredOutputTool["input_schema"];

const SESSION_TITLE_TOOL: StructuredOutputTool = {
  name: SESSION_TITLE_TOOL_NAME,
  description: "Create a concise coding-session title.",
  input_schema: SESSION_TITLE_SCHEMA,
};

interface SessionTitleResponse {
  title: string;
  ticketKey: string | null;
}

export interface GeneratedSessionTitle {
  title: string;
  ticketKey: string | null;
  provider: "openai";
  model: string;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateAtWordBoundary(text: string, maxLength: number): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxLength) return normalized;

  const sliced = normalized.slice(0, maxLength).trimEnd();
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace >= Math.max(0, maxLength - 18)) {
    return sliced.slice(0, lastSpace).trimEnd();
  }

  return sliced;
}

function formatSentenceCaseWord(word: string, isFirstWord: boolean): string {
  const canonicalTerm = SESSION_TITLE_CANONICAL_TERMS.get(word.toLowerCase());
  if (canonicalTerm) return canonicalTerm;

  const hasInternalUppercase = /[A-Z]/.test(word.slice(1));
  const isAllCapsLike = /^[A-Z0-9./_-]+$/.test(word) && /[A-Z]/.test(word);
  if (isAllCapsLike && /\d/.test(word)) return word;
  if (/[./_-]/.test(word)) {
    let segmentCount = 0;
    return word.replace(/[A-Za-z][A-Za-z0-9]*/g, (segment) => {
      const formatted = formatSentenceCaseWord(segment, isFirstWord && segmentCount === 0);
      segmentCount += 1;
      return formatted;
    });
  }
  if (hasInternalUppercase && !isAllCapsLike) return word;

  const lower = word.toLowerCase();
  if (!isFirstWord) return lower;

  return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
}

function toSentenceCaseTitle(text: string): string {
  let wordCount = 0;
  return text.replace(/[A-Za-z][A-Za-z0-9]*(?:[./_-][A-Za-z0-9]+)*/g, (word) => {
    const formatted = formatSentenceCaseWord(word, wordCount === 0);
    wordCount += 1;
    return formatted;
  });
}

export function formatGeneratedSessionTitle(
  response: SessionTitleResponse,
  maxLength = SESSION_TITLE_MAX_LENGTH,
): Pick<GeneratedSessionTitle, "title" | "ticketKey"> | null {
  const normalizedTitle = normalizeWhitespace(response.title);
  const title = truncateAtWordBoundary(toSentenceCaseTitle(normalizedTitle), maxLength);
  if (!title) return null;

  // Shape-validate the model's ticket key so a hallucinated/malformed value
  // never reaches the PR title; non-matching output collapses to null.
  return { title, ticketKey: normalizeTicketKey(response.ticketKey) };
}

function parseSessionTitleResponse(value: unknown): SessionTitleResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { title?: unknown; ticketKey?: unknown };
  if (typeof candidate.title !== "string") return null;
  const ticketKey = typeof candidate.ticketKey === "string" ? candidate.ticketKey : null;
  return { title: candidate.title, ticketKey };
}

function getErrorName(error: unknown): string | null {
  if (error instanceof Error) return error.name;
  if (!error || typeof error !== "object" || !("name" in error)) return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function isTimeoutLike(error: unknown): boolean {
  const name = getErrorName(error);
  return name === "TimeoutError" || name === "AbortError";
}

type SessionTitleFailureCategory =
  "timeout" | "rate_limited" | "provider_5xx" | "provider_4xx" | "provider" | "output_shape" | "transport" | "unknown";

function sessionTitleFailureCategory(error: unknown): SessionTitleFailureCategory {
  if (error instanceof StructuredOutputError) {
    if (isTimeoutLike(error.cause) || error.status === 408) return "timeout";
    if (error.status === 429) return "rate_limited";
    if (typeof error.status === "number" && error.status >= 500) return "provider_5xx";
    if (typeof error.status === "number" && error.status >= 400) return "provider_4xx";
    return error.failureKind;
  }
  if (isTimeoutLike(error)) return "timeout";
  return "unknown";
}

async function generateOpenAITitle(
  env: Pick<Env, "ARCANIST_OPENAI_API_KEY">,
  promptText: string,
  log: Logger,
  startedAt: number,
  telemetryContext: SessionMetadataTelemetryContext = {},
): Promise<SessionTitleResponse | null> {
  const result = await queryPlatformStructuredOutput(
    env,
    {
      model: SESSION_TITLE_MODEL,
      reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
      tool: { ...SESSION_TITLE_TOOL, strict: true },
      systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
      userPrompt: `Request:\n${promptText}`,
      maxTokens: 160,
      timeoutMs: SESSION_TITLE_REQUEST_TIMEOUT_MS,
      fetchImpl: tracedFetch,
      spanName: "openai.sessionTitle",
      strictErrors: true,
    },
    {
      subsystem: "session_metadata",
      callType: "session_title",
      phase: "session_create",
      sourceId: `session_title:${startedAt}`,
      ...telemetryContext,
    },
    { logger: log },
  );
  return parseSessionTitleResponse(result);
}

function getTitleGenerationConfig(env: Pick<Env, "ARCANIST_OPENAI_API_KEY">): {
  provider: "openai";
  model: string;
  apiKey: string;
} {
  return { provider: "openai", model: SESSION_TITLE_MODEL, apiKey: env.ARCANIST_OPENAI_API_KEY };
}

function buildSessionTitleCompletionFields(params: {
  config: { provider: "openai"; model: string };
  outcome: "success" | "failure";
  durationMs: number;
  failureCategory?: SessionTitleFailureCategory;
  failureKind?: string;
  status?: number;
  error?: string;
}) {
  return {
    event: "llm_call.completed",
    callType: "session_title",
    outcome: params.outcome,
    provider: params.config.provider,
    model: params.config.model,
    toolName: SESSION_TITLE_TOOL_NAME,
    attempts: SESSION_TITLE_MAX_ATTEMPTS,
    maxAttempts: SESSION_TITLE_MAX_ATTEMPTS,
    timeoutMs: SESSION_TITLE_REQUEST_TIMEOUT_MS,
    durationMs: params.durationMs,
    ...(params.failureCategory ? { failureCategory: params.failureCategory } : {}),
    ...(params.failureKind ? { failureKind: params.failureKind } : {}),
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

export async function generateSessionTitle(
  promptText: string,
  _originalModel: string | null | undefined,
  env: Pick<Env, "ARCANIST_OPENAI_API_KEY">,
  log: Logger,
  telemetryContext: SessionMetadataTelemetryContext = {},
): Promise<GeneratedSessionTitle | null> {
  const config = getTitleGenerationConfig(env);
  const callStartedAt = Date.now();

  try {
    const titlePromptText = truncateAtWordBoundary(promptText, SESSION_TITLE_PROMPT_MAX_LENGTH);
    const response = await generateOpenAITitle(env, titlePromptText, log, callStartedAt, telemetryContext);
    const durationMs = Date.now() - callStartedAt;
    if (!response) {
      log.warn(
        buildSessionTitleCompletionFields({
          config,
          outcome: "failure",
          durationMs,
          failureCategory: "output_shape",
          failureKind: "output_shape",
        }),
        "Session title generation returned invalid structured output",
      );
      return null;
    }

    const formatted = formatGeneratedSessionTitle(response);
    if (!formatted) {
      log.warn(
        buildSessionTitleCompletionFields({
          config,
          outcome: "failure",
          durationMs,
          failureCategory: "output_shape",
          failureKind: "output_shape",
        }),
        "Session title generation returned empty title",
      );
      return null;
    }

    log.info(
      buildSessionTitleCompletionFields({
        config,
        outcome: "success",
        durationMs,
      }),
      "Session title LLM call completed",
    );
    log.info({ provider: config.provider, model: config.model }, "Session title generation completed");
    return { ...formatted, provider: config.provider, model: config.model };
  } catch (error) {
    const structuredError = error instanceof StructuredOutputError ? error : null;
    log.warn(
      {
        ...buildSessionTitleCompletionFields({
          config,
          outcome: "failure",
          durationMs: structuredError?.durationMs ?? Date.now() - callStartedAt,
          failureCategory: sessionTitleFailureCategory(error),
          failureKind: structuredError?.failureKind,
          status: structuredError?.status,
          error: String(error),
        }),
        attempts: structuredError?.attempts ?? SESSION_TITLE_MAX_ATTEMPTS,
        maxAttempts: structuredError?.maxAttempts ?? SESSION_TITLE_MAX_ATTEMPTS,
      },
      "Session title generation failed",
    );
    return null;
  }
}
