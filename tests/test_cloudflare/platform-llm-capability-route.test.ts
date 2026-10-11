import { describe, expect, it } from "vitest";

import { platformLlmCapabilityInternalRoute } from "../../apps/control-plane-worker/src/session/state.js";

// Regression: the broker capability-validation wrapper must route to the
// internal endpoint matching the call's phase. It previously hardcoded
// prompt-preparation, so every post_execution call (e.g. pr_template_fill) was
// validated against the wrong phase and rejected with 400 — silently disabling
// the feature. Caught in QA E2E, not by the executor-level unit tests.
describe("platformLlmCapabilityInternalRoute", () => {
  it("routes post_execution calls to the post-execution internal endpoint", () => {
    expect(platformLlmCapabilityInternalRoute("post_execution").path).toBe("/session/platform-llm/post-execution");
  });

  it("routes prompt_preparation calls to the prompt-preparation internal endpoint", () => {
    expect(platformLlmCapabilityInternalRoute("prompt_preparation").path).toBe(
      "/session/platform-llm/prompt-preparation",
    );
  });
});
