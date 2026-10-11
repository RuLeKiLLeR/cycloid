import { describe, expect, it } from "vitest";

import {
  toPublicEnqueueDispatch,
  toPublicEnqueuedPrompt,
} from "../../apps/control-plane-worker/src/session/prompt-response";
import type { DispatchContract } from "../../apps/control-plane-worker/src/types";
import type { ClientPrompt } from "../../shared/types/session-websocket";
import { wrapUserContent } from "../../shared/utils/prompt-safety";

function makePrompt(overrides: Partial<ClientPrompt> = {}): ClientPrompt {
  return {
    promptId: "p-1",
    session_id: "s-1",
    prompt: "fix the login bug",
    replyToText: null,
    result: null,
    status: "processing",
    createdAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}

// Authentic wrapped Linear bootstrap prompt: a Repository prefix line, unwrapped
// orchestration lines that `stripPromptScaffolding` does NOT recognize
// (`Linear Issue:`, `Issue URL:`, `Premise check...`), and a real <user_content>
// block (whose inner user text is removed by stripping). Stripping leaves only
// internal scaffolding, so nothing display-safe is recoverable.
function wrappedBootstrapPrompt(inner: string): string {
  return [
    "Repository: https://github.com/acme/widgets",
    "Linear Issue: ARC-99",
    "Issue URL: https://linear.app/acme/issue/ARC-99",
    "Premise check before implementation:",
    wrapUserContent(inner, "linear_issue_description", "linear_user"),
  ].join("\n\n");
}

describe("toPublicEnqueuedPrompt", () => {
  it("returns a plain prompt as displayPrompt when there is no scaffolding", () => {
    const result = toPublicEnqueuedPrompt(makePrompt({ prompt: "fix the login bug" }));
    expect(result.displayPrompt).toBe("fix the login bug");
  });

  it("prefers a clean replyToText over a wrapped raw prompt", () => {
    const result = toPublicEnqueuedPrompt(
      makePrompt({
        prompt: wrappedBootstrapPrompt("what the user actually typed"),
        replyToText: "what the user actually typed",
      }),
    );
    expect(result.displayPrompt).toBe("what the user actually typed");
  });

  it("fails closed to null when both prompt and replyToText are fully wrapped", () => {
    const wrapped = wrappedBootstrapPrompt("secret internal scaffolding the caller must not see");
    const result = toPublicEnqueuedPrompt(makePrompt({ prompt: wrapped, replyToText: wrapped }));
    expect(result.displayPrompt).toBeNull();
  });

  it("does not echo unwrapped orchestration lines that stripping leaves behind", () => {
    // Linear/GitHub bootstrap: replyToText defaults to the wrapped prompt, and the
    // raw prompt's only "recoverable" text after stripping is internal scaffolding
    // (Linear Issue:, Issue URL:, Premise check:). It must not surface as displayPrompt.
    const wrapped = wrappedBootstrapPrompt("real user issue description");
    const result = toPublicEnqueuedPrompt(makePrompt({ prompt: wrapped, replyToText: wrapped }));
    expect(result.displayPrompt).toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Linear Issue:");
    expect(serialized).not.toContain("Premise check");
    expect(serialized).not.toContain("Issue URL:");
  });

  it("returns the clean summary for a review-loop prompt", () => {
    const result = toPublicEnqueuedPrompt(
      makePrompt({
        prompt: "[cycloid:review-loop epoch=e]\nHead SHA: abc\n…footer…",
        replyToText: 'Addressing review feedback on this PR:\n- @a · f.ts:1 — "x"',
      }),
    );
    expect(result.displayPrompt).toBe('Addressing review feedback on this PR:\n- @a · f.ts:1 — "x"');
  });

  it("fails closed for a legacy review-loop prompt with no summary", () => {
    const wrapped = "[cycloid:review-loop epoch=e]\nx";
    const result = toPublicEnqueuedPrompt(makePrompt({ prompt: wrapped, replyToText: wrapped }));
    expect(result.displayPrompt).toBeNull();
  });

  it("does not treat a user prompt that merely contains 'IMPORTANT:' as scaffolding", () => {
    const result = toPublicEnqueuedPrompt(makePrompt({ prompt: "IMPORTANT: fix the login bug before the demo" }));
    expect(result.displayPrompt).toBe("IMPORTANT: fix the login bug before the demo");
  });

  it("does not throw and returns null displayPrompt for a missing/non-string prompt", () => {
    const result = toPublicEnqueuedPrompt(
      makePrompt({ prompt: undefined as unknown as string, replyToText: undefined }),
    );
    expect(result.displayPrompt).toBeNull();
  });

  it("emits only the allowlisted fields (no raw prompt, replyToText, result, errorDetails, uploads)", () => {
    const result = toPublicEnqueuedPrompt(
      makePrompt({
        prompt: "do the thing",
        replyToText: "do the thing",
        result: { summary: "leaky" },
        errorDetails: { kind: "x" } as unknown as ClientPrompt["errorDetails"],
        uploadedImages: [{ name: "a.png", mediaType: "image/png", data: "base64-bytes" }],
        agent: "claude",
        skills: ["investigate-incident"],
        model: "gpt-5.4",
        reasoningEffort: "high",
      }),
    );
    expect(new Set(Object.keys(result))).toEqual(
      new Set([
        "promptId",
        "session_id",
        "status",
        "createdAt",
        "agent",
        "skills",
        "model",
        "reasoningEffort",
        "displayPrompt",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("base64-bytes");
    expect(JSON.stringify(result)).not.toContain("leaky");
  });
});

describe("toPublicEnqueueDispatch", () => {
  const dispatch: DispatchContract = {
    sessionId: "s-1",
    promptId: "p-1",
    prompt: "raw wrapped <user_content> prompt text",
    model: "gpt-5.4",
    callback: {
      method: "POST",
      path: "/internal/sandbox/sessions/s-1/prompts/p-1/callback",
      auth: "Bearer secret-token",
    },
  };

  it("omits prompt and callback auth, keeps sessionId/promptId/model", () => {
    const result = toPublicEnqueueDispatch(dispatch);
    expect(result).toEqual({ sessionId: "s-1", promptId: "p-1", model: "gpt-5.4" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("user_content");
  });

  it("returns null for a null dispatch", () => {
    expect(toPublicEnqueueDispatch(null)).toBeNull();
  });
});
