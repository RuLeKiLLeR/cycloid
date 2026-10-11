import {
  buildPostExecutionStructuredOutputRequest,
  parsePostExecutionStructuredOutput,
  type PrTemplateFillLlmInput,
  type PrTemplateFillLlmOutput,
  validatePrTemplateFillOutput,
} from "../../../../shared/llm/post-execution.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { PLATFORM_LLM_CALL_CONFIG } from "../constants/platform-llm";
import type { Logger } from "../logger";
import type { Env } from "../types";
import { queryPlatformStructuredOutput, type SessionMetadataTelemetryContext } from "./platform-structured-output";

export async function generatePrTemplateFill(
  env: Pick<Env, "ARCANIST_OPENAI_API_KEY" | "ARCANIST_BASETEN_API_KEY" | "ARCANIST_ANTHROPIC_API_KEY">,
  input: PrTemplateFillLlmInput,
  telemetryContext: SessionMetadataTelemetryContext,
  log: Logger,
): Promise<PrTemplateFillLlmOutput | null> {
  const request = buildPostExecutionStructuredOutputRequest("pr_template_fill", input);
  if (!request) return null;
  const config = PLATFORM_LLM_CALL_CONFIG.pr_template_fill;

  try {
    const raw = await queryPlatformStructuredOutput(
      env,
      {
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        serviceTier: config.serviceTier,
        tool: request.tool,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
        strictErrors: true,
        retry: { maxAttempts: config.maxAttempts },
      },
      {
        subsystem: "post_execution",
        callType: "pr_template_fill",
        phase: "post_execution",
        sourceId: `pr_template_fill:${telemetryContext.sessionId ?? "unknown"}:${telemetryContext.promptId ?? "no_prompt"}`,
        ...telemetryContext,
      },
    );
    const parsed = parsePostExecutionStructuredOutput("pr_template_fill", raw);
    if (!parsed) {
      log.warn(
        {
          event: "pr_template_fill.invalid_output",
          reason: "parse_failed",
          sessionId: telemetryContext.sessionId,
          promptId: telemetryContext.promptId,
          repoOwner: telemetryContext.repoOwner,
          repoName: telemetryContext.repoName,
        },
        "PR template fill returned invalid structured output; leaving deterministic PR body unchanged",
      );
      return null;
    }
    const validation = validatePrTemplateFillOutput(input, parsed);
    if (!validation.ok) {
      log.warn(
        {
          event: "pr_template_fill.invalid_output",
          reason: validation.reason,
          sessionId: telemetryContext.sessionId,
          promptId: telemetryContext.promptId,
          repoOwner: telemetryContext.repoOwner,
          repoName: telemetryContext.repoName,
          sectionCount: validation.sectionCount,
          heading: validation.heading?.slice(0, 120) ?? null,
        },
        "PR template fill failed output validation; leaving deterministic PR body unchanged",
      );
      return null;
    }
    return parsed;
  } catch (error) {
    log.warn(
      {
        event: "pr_template_fill.skipped",
        reason: "control_plane_generation_failed",
        sessionId: telemetryContext.sessionId,
        promptId: telemetryContext.promptId,
        error: stringifyError(error),
      },
      "PR template fill failed; leaving deterministic PR body unchanged",
    );
    return null;
  }
}
