import { describe, expect, it } from "vitest";

import type { ErrorDetails } from "../../apps/sandbox-bridge/src/utils/llm-errors.ts";
import {
  buildPromptCompleteErrorFacets,
  PROMPT_COMPLETE_ERROR_CLASS_MAX_CHARS,
  PROMPT_COMPLETE_ERROR_MESSAGE_MAX_CHARS,
} from "../../apps/sandbox-bridge/src/utils/llm-errors.ts";

describe("buildPromptCompleteErrorFacets", () => {
  it("emits redacted message + class on error outcomes", () => {
    const details: ErrorDetails = { message: "codex app-server exited unexpectedly", name: "CodexError" };
    expect(buildPromptCompleteErrorFacets("error", details)).toEqual({
      error_message: "codex app-server exited unexpectedly",
      error_class: "CodexError",
    });
  });

  it("omits facets on success outcomes", () => {
    const details: ErrorDetails = { message: "should not appear", name: "Error" };
    expect(buildPromptCompleteErrorFacets("success", details)).toEqual({});
  });

  it("omits facets on aborted outcomes (only @outcome:error feeds the metric)", () => {
    const details: ErrorDetails = { message: "stopped by user", name: "AbortError" };
    expect(buildPromptCompleteErrorFacets("aborted", details)).toEqual({});
  });

  it("returns no facets when errorDetails is missing", () => {
    expect(buildPromptCompleteErrorFacets("error", undefined)).toEqual({});
  });

  it("redacts secrets BEFORE truncation so partial tokens cannot leak", () => {
    // A GitHub PAT embedded in the failure message must be scrubbed by `redact`
    // (SECRET_PATTERNS), not merely whitespace-collapsed by describeError.
    const token = "ghp_abcdefABCDEF0123456789";
    const details: ErrorDetails = { message: `clone failed: token ${token} rejected`, name: "Error" };
    const facets = buildPromptCompleteErrorFacets("error", details);
    expect(facets.error_message).toBe("clone failed: token [REDACTED] rejected");
    expect(facets.error_message).not.toContain(token);
    expect(facets.error_message).not.toContain("ghp_");
  });

  it("bounds the FINAL message (including truncation marker) within maxMessageChars", () => {
    const longMessage = "x".repeat(PROMPT_COMPLETE_ERROR_MESSAGE_MAX_CHARS + 200);
    const facets = buildPromptCompleteErrorFacets("error", { message: longMessage, name: "Error" }, 50);
    // Total length stays <= the cap even after truncate() appends its marker.
    expect((facets.error_message ?? "").length).toBeLessThanOrEqual(50);
    expect(facets.error_message?.startsWith("xxx")).toBe(true);
    expect(facets.error_message).toContain("[truncated");
  });

  it("at the default cap, the final message stays within the documented bound", () => {
    const longMessage = "y".repeat(PROMPT_COMPLETE_ERROR_MESSAGE_MAX_CHARS + 1000);
    const facets = buildPromptCompleteErrorFacets("error", { message: longMessage, name: "Error" });
    expect((facets.error_message ?? "").length).toBeLessThanOrEqual(PROMPT_COMPLETE_ERROR_MESSAGE_MAX_CHARS);
  });

  it("redacts and bounds error_class (it can come from untrusted provider payloads)", () => {
    const token = "ghp_abcdefABCDEF0123456789";
    const facets = buildPromptCompleteErrorFacets("error", { message: "boom", name: `LeakyError ${token}` });
    expect(facets.error_class).toBe("LeakyError [REDACTED]");
    expect(facets.error_class).not.toContain(token);

    const longName = "N".repeat(PROMPT_COMPLETE_ERROR_CLASS_MAX_CHARS + 50);
    const bounded = buildPromptCompleteErrorFacets("error", { message: "boom", name: longName });
    expect((bounded.error_class ?? "").length).toBeLessThanOrEqual(PROMPT_COMPLETE_ERROR_CLASS_MAX_CHARS);
  });

  it("emits message without class when errorDetails has no name", () => {
    const facets = buildPromptCompleteErrorFacets("error", { message: "plain failure" });
    expect(facets).toEqual({ error_message: "plain failure" });
    expect(facets.error_class).toBeUndefined();
  });
});
