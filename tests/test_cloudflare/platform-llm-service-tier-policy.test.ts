import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PLATFORM_LLM_CALL_CONFIG } from "../../apps/control-plane-worker/src/constants/platform-llm";
import {
  PROGRESS_NARRATION_MODEL,
  PROGRESS_NARRATION_REASONING_EFFORT,
} from "../../apps/control-plane-worker/src/constants/slack-progress-narration";
import { OpenAIServiceTier } from "../../shared/enums/openai-service-tier";

// Guards the service-tier routing policy: latency-tolerant background calls run on flex (Batch
// rates), while user-blocking / hard-deadline calls stay on standard. A flex caller must also be
// able to absorb a flex 429 via retry (maxAttempts >= 2), or the call regresses to a hard failure.
const REPO_ROOT = join(__dirname, "..", "..");
const SRC = join(REPO_ROOT, "apps", "control-plane-worker", "src");

function read(relPath: string): string {
  return readFileSync(join(SRC, relPath), "utf8");
}

// Background, non-blocking, retry-tolerant direct callers that must request flex.
const FLEX_SITES = [
  "memory/analyzer.ts",
  "memory/judge.ts",
  "company-memory/adjudicate.ts",
  "company-memory/refine.ts",
  "memory-review-bot/reviewer.ts",
];

// User-blocking or hard webhook-deadline callers that must NOT flex.
const STANDARD_SITES = ["services/session-title.ts", "services/repo-resolver.ts", "incident-analyzer/intent.ts"];

describe("platform LLM service-tier routing policy", () => {
  it.each(FLEX_SITES)("requests flex at the background call site %s", (relPath) => {
    const source = read(relPath);
    expect(source).toContain("serviceTier: OpenAIServiceTier.Flex");
    // Every flex caller retries so a flex 429 (resource_unavailable) is absorbed, not dropped.
    expect(source).toMatch(/maxAttempts:\s*(?:[2-9]|\d{2,}|[A-Z_]*MAX_ATTEMPTS)/);
  });

  it.each(STANDARD_SITES)("keeps the user-blocking call site %s on standard", (relPath) => {
    expect(read(relPath)).not.toContain("serviceTier: OpenAIServiceTier.Flex");
  });

  it("keeps PR template fill on flex with enough retries to absorb a flex 429", () => {
    const config = PLATFORM_LLM_CALL_CONFIG.pr_template_fill;
    expect(config.serviceTier).toBe(OpenAIServiceTier.Flex);
    expect(config.maxAttempts).toBeGreaterThanOrEqual(2);
  });

  it("keeps review-loop triage on standard tier with an interactive retry budget", () => {
    const config = PLATFORM_LLM_CALL_CONFIG.review_loop_triage;
    expect(config.serviceTier).toBe(OpenAIServiceTier.Auto);
    expect(config.timeoutMs).toBe(8_000);
    expect(config.maxAttempts).toBe(2);
  });

  it("keeps the latency-sensitive slack_progress_narration call off flex", () => {
    // The live Slack status card cannot tolerate Batch-rate latency; it runs on
    // standard tier with a single attempt behind a short hard timeout.
    expect(PLATFORM_LLM_CALL_CONFIG.slack_progress_narration.serviceTier).not.toBe(OpenAIServiceTier.Flex);
  });

  it("keeps slack progress narration config in sync with the live caller constants", () => {
    expect(PLATFORM_LLM_CALL_CONFIG.slack_progress_narration.model).toBe(PROGRESS_NARRATION_MODEL);
    expect(PLATFORM_LLM_CALL_CONFIG.slack_progress_narration.reasoningEffort).toBe(PROGRESS_NARRATION_REASONING_EFFORT);
  });
});
