import { GPT54_MINI_SIDECAR_REASONING_EFFORT, OpenAIModel } from "../../../../shared/constants/models.js";
import type { StructuredOutputFetch, StructuredOutputTool } from "../../../../shared/llm/structured-output.js";
import type { Env } from "../types.js";
import { queryPlatformStructuredOutput, type SessionMetadataTelemetryContext } from "./platform-structured-output.js";

const PLAN_NECESSITY_REQUEST_TIMEOUT_MS = 4_500;
const PLAN_NECESSITY_MAX_PROMPT_CHARS = 12_000;

export const PLAN_NECESSITY_TOOL_NAME = "assess_plan_necessity";
export const PLAN_NECESSITY_MODEL = OpenAIModel.GPT54Nano;
export const PLAN_NECESSITY_SYSTEM_PROMPT = [
  "You decide whether a coding-agent task prompt warrants an explicit upfront plan before implementation.",
  "A plan is warranted when the task is non-trivial and requires multiple actions over a long horizon, has logical phases or dependencies where sequencing matters, has ambiguity that benefits from outlining high-level goals, or explicitly asks for a plan or TODOs.",
  "Do not mark a task as needing a plan merely because the prompt has two or more small requests; this exception is only for localized, mechanical, or immediately answerable work.",
  "A compound task that asks to audit, review, investigate, compare, or find issues and then fix or document the results is plan-worthy unless the prompt narrows it to one obvious local edit.",
  "A plan is NOT warranted for simple tasks the agent can just do or answer immediately, such as small bug fixes, typo corrections, localized cleanup, single-file edits, direct questions, or a command followed by a short report.",
  'Example: Fix the typo in the README and run the formatter. -> {"plan_needed":false,"reason":"This is a small mechanical cleanup plus verification."}',
  'Example: What command runs the changed-file verifier? -> {"plan_needed":false,"reason":"This is a direct question that can be answered immediately."}',
  'Example: Audit the docs for session creation, fix stale references, and add missing examples. -> {"plan_needed":true,"reason":"This combines audit, remediation, and documentation work across multiple docs."}',
  'Example: Migrate session status to the FSM projection, preserve compatibility while callers move over, and remove the old writer after the deploy drains. -> {"plan_needed":true,"reason":"This has ordered migration phases and compatibility risk."}',
  'Example: Add a Slack notification flow that stores install state, posts updates, retries failed deliveries, and exposes failures in the UI. -> {"plan_needed":true,"reason":"This is a multi-phase feature across persistence, delivery, and UI surfaces."}',
  "Judge only from the prompt text. Return JSON with plan_needed and a one-sentence reason.",
].join(" ");

export const PLAN_NECESSITY_SCHEMA = {
  type: "object",
  properties: {
    plan_needed: {
      type: "boolean",
      description: "True when the prompt warrants an explicit upfront plan before implementation.",
    },
    reason: {
      type: "string",
      description: "One-sentence justification for the decision.",
    },
  },
  required: ["plan_needed", "reason"],
  additionalProperties: false,
} as const satisfies StructuredOutputTool["input_schema"];

const PLAN_NECESSITY_TOOL: StructuredOutputTool = {
  name: PLAN_NECESSITY_TOOL_NAME,
  description: "Decide whether a task prompt warrants an explicit upfront plan.",
  input_schema: PLAN_NECESSITY_SCHEMA,
};

export type PlanNecessityAssessment = {
  planNeeded: boolean;
  reason: string;
};

type AssessPlanNecessityDependencies = {
  fetchImpl?: StructuredOutputFetch;
};

function hasPlatformOpenAiKey(env: Pick<Env, "ARCANIST_OPENAI_API_KEY">): boolean {
  const key = env.ARCANIST_OPENAI_API_KEY?.trim();
  return Boolean(key && key !== "CHANGE_ME");
}

function parsePlanNecessityResponse(value: unknown): PlanNecessityAssessment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const planNeeded = (value as { plan_needed?: unknown }).plan_needed;
  const reason = (value as { reason?: unknown }).reason;
  if (typeof planNeeded !== "boolean" || typeof reason !== "string") return null;
  const trimmedReason = reason.trim();
  return trimmedReason ? { planNeeded, reason: trimmedReason } : null;
}

/**
 * Classifies whether a task prompt warrants an explicit upfront plan.
 * Returns null when the platform key is missing or the provider call fails,
 * so callers choose their own default (typically: no plan).
 */
export async function assessPlanNecessity(
  env: Pick<Env, "ARCANIST_OPENAI_API_KEY">,
  prompt: string,
  telemetryContext: SessionMetadataTelemetryContext = {},
  deps: AssessPlanNecessityDependencies = {},
): Promise<PlanNecessityAssessment | null> {
  if (!hasPlatformOpenAiKey(env)) return null;
  const trimmed = prompt.trim();
  if (!trimmed) return null;
  const userPrompt = trimmed.slice(0, PLAN_NECESSITY_MAX_PROMPT_CHARS);

  try {
    const result = await queryPlatformStructuredOutput(
      env,
      {
        model: PLAN_NECESSITY_MODEL,
        reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
        tool: { ...PLAN_NECESSITY_TOOL, strict: true },
        systemPrompt: PLAN_NECESSITY_SYSTEM_PROMPT,
        userPrompt: `Task prompt:\n${userPrompt}`,
        maxTokens: 200,
        timeoutMs: PLAN_NECESSITY_REQUEST_TIMEOUT_MS,
        strictErrors: true,
      },
      {
        subsystem: "session_metadata",
        callType: "plan_necessity",
        phase: "prompt_preparation",
        sourceId: `plan_necessity:${telemetryContext.sessionId ?? "unknown"}:${telemetryContext.promptId ?? "no_prompt"}`,
        ...telemetryContext,
      },
      { fetchImpl: deps.fetchImpl },
    );
    return parsePlanNecessityResponse(result);
  } catch {
    return null;
  }
}
