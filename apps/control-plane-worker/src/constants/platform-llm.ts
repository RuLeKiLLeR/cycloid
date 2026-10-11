import { GPT54_MINI_SIDECAR_REASONING_EFFORT, OpenAIModel } from "../../../../shared/constants/models.js";
import { OpenAIServiceTier } from "../../../../shared/enums/openai-service-tier.js";
import {
  PLATFORM_LLM_DEFAULT_MAX_ATTEMPTS,
  type PlatformLlmCallPlan,
  type PlatformLlmCallType,
  type PlatformLlmPhase,
} from "../../../../shared/llm/platform-llm-contract.js";
import { REVIEW_LOOP_TRIAGE_MAX_ITEMS } from "../../../../shared/llm/prompt-preparation.js";

export const PLATFORM_LLM_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1000;
export const PLATFORM_LLM_SESSION_QPS = 20;
export const PLATFORM_LLM_RATE_LIMIT_WINDOW_MS = 1000;
const PLATFORM_LLM_MAX_OUTPUT_BYTES = 256 * 1024;

type PlatformLlmCallConfig = Pick<
  PlatformLlmCallPlan,
  | "provider"
  | "model"
  | "reasoningEffort"
  | "serviceTier"
  | "maxTokens"
  | "timeoutMs"
  | "maxAttempts"
  | "toolName"
  | "maxOutputBytes"
> & {
  phase: PlatformLlmPhase;
  maxInputBytes: number;
  maxItems: number | null;
  perPromptBudget: number;
};

const DEFAULT_PROVIDER_CONFIG = {
  provider: "openai",
  model: OpenAIModel.GPT54Mini,
  reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
  // Latency-tolerant background broker defaults. Interactive call types that reuse this shape must
  // override the service tier and retry budget below.
  serviceTier: OpenAIServiceTier.Flex,
  timeoutMs: 30_000,
  maxAttempts: PLATFORM_LLM_DEFAULT_MAX_ATTEMPTS,
  maxOutputBytes: PLATFORM_LLM_MAX_OUTPUT_BYTES,
} as const;

export const PLATFORM_LLM_CALL_CONFIG = {
  pr_template_fill: {
    ...DEFAULT_PROVIDER_CONFIG,
    phase: "post_execution",
    maxInputBytes: 256 * 1024,
    maxItems: null,
    perPromptBudget: 2,
    maxTokens: 2048,
    toolName: "platform_llm_pr_template_fill",
  },
  // Review-loop worklist triage (RLA v2): executed control-plane-side from the sweep via
  // executePlatformLlmCall — never minted as a sandbox capability (see the explicit call-type
  // list in the session DO's capability minting).
  review_loop_triage: {
    ...DEFAULT_PROVIDER_CONFIG,
    // Interactive review-turn path: fail open quickly to the deterministic worklist instead of
    // waiting on Flex queueing.
    serviceTier: OpenAIServiceTier.Auto,
    timeoutMs: 8_000,
    maxAttempts: 2,
    phase: "prompt_preparation",
    maxInputBytes: 256 * 1024,
    maxItems: REVIEW_LOOP_TRIAGE_MAX_ITEMS,
    perPromptBudget: 2,
    maxTokens: 2048,
    toolName: "platform_llm_review_loop_triage",
  },
  // Slack status-card progress narration. Unlike the two broker call types above, this is executed
  // control-plane-side directly from the session DO (see slack/progress-narration.ts) — it is NEVER
  // minted as a sandbox capability nor routed through buildToolRequest, so this entry exists only to
  // satisfy the exhaustive Record<PlatformLlmCallType> contract and keep telemetry config in one
  // place. Like review_loop_triage, it opts out of the Flex service tier, but with an even tighter
  // latency budget (the live card): 4s timeout, 1 attempt. See constants/slack-progress-narration.ts. The
  // phase axis only has prompt_preparation|post_execution; post_execution is the closest fit for a
  // non-prompt-prep background call.
  slack_progress_narration: {
    provider: "openai",
    model: OpenAIModel.GPT54Nano,
    reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
    // Latency-sensitive: standard tier ("auto"), not the Flex batch rate the broker types use.
    serviceTier: OpenAIServiceTier.Auto,
    phase: "post_execution",
    maxInputBytes: 16 * 1024,
    maxItems: null,
    perPromptBudget: 0,
    maxTokens: 256,
    timeoutMs: 4_000,
    maxAttempts: 1,
    maxOutputBytes: 4 * 1024,
    toolName: "platform_llm_slack_progress_narration",
  },
} as const satisfies Record<PlatformLlmCallType, PlatformLlmCallConfig>;

export const PLATFORM_LLM_MAX_REQUEST_BYTES = Math.max(
  ...Object.values(PLATFORM_LLM_CALL_CONFIG).map((config) => config.maxInputBytes),
);
