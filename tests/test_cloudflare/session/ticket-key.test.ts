import { describe, expect, it } from "vitest";

import { extractLeadingTicketKey } from "../../../apps/control-plane-worker/src/session/prompt-text";
import { normalizeTicketKey, resolveSessionTicketKey } from "../../../apps/control-plane-worker/src/session/ticket-key";
import type { PromptState } from "../../../apps/control-plane-worker/src/types";

function prompts(...texts: string[]): PromptState[] {
  return texts.map((prompt) => ({ prompt }) as PromptState);
}

describe("normalizeTicketKey", () => {
  it("accepts and trims a well-formed uppercase key", () => {
    expect(normalizeTicketKey("ENG-9001")).toBe("ENG-9001");
    expect(normalizeTicketKey("  DATA-12  ")).toBe("DATA-12");
  });

  it("rejects lowercase, malformed, blank, and nullish input", () => {
    expect(normalizeTicketKey("eng-9001")).toBeNull();
    expect(normalizeTicketKey("not a key")).toBeNull();
    expect(normalizeTicketKey("ENG-")).toBeNull();
    expect(normalizeTicketKey("  ")).toBeNull();
    expect(normalizeTicketKey(null)).toBeNull();
    expect(normalizeTicketKey(undefined)).toBeNull();
  });
});

describe("extractLeadingTicketKey (thin deterministic fallback)", () => {
  it("extracts a key that leads the first content line", () => {
    expect(extractLeadingTicketKey("ENG-9001: Fix the dashboard")).toBe("ENG-9001");
    expect(extractLeadingTicketKey("DATA-12 Implement analytics model")).toBe("DATA-12");
  });

  it("extracts alphanumeric project-key prefixes (mirrors TICKET_KEY_SHAPE)", () => {
    // The leading-key class matches TICKET_KEY_SHAPE so branch/title prefixing works
    // for alphanumeric keys typed without a Linear URL, consistent with LINEAR_URL_RE.
    expect(extractLeadingTicketKey("A1-123: fix checkout")).toBe("A1-123");
    expect(extractLeadingTicketKey("X9-42 Implement thing")).toBe("X9-42");
  });

  it("skips metadata lines and reads the first real content line", () => {
    expect(
      extractLeadingTicketKey(
        [
          "verify=true",
          "Repository: trycycloid/x",
          "Head SHA: abc123",
          "Base Branch: main",
          "[cycloid:review-loop attempt=2]",
          "Review-loop worklist:",
          "Review-loop action items:",
          "ENG-9001 Fix docs",
        ].join("\n"),
      ),
    ).toBe("ENG-9001");
  });

  it("does NOT hunt mid-sentence keys (that is the LLM's job)", () => {
    expect(extractLeadingTicketKey("hey cycloid work on ENG-9001")).toBeNull();
    expect(extractLeadingTicketKey("Please fix ENG-9001 in the dashboard")).toBeNull();
  });

  it("returns null for no key, or a lowercase token", () => {
    expect(extractLeadingTicketKey("Fix the dashboard")).toBeNull();
    expect(extractLeadingTicketKey("eng-9001 fix the dashboard")).toBeNull();
  });

  it("skips a leading fenced code block and reads the key from the first prose line (ARC-1539)", () => {
    expect(
      extractLeadingTicketKey(["```typescript", "ENG-1: not a real leading key", "```", "ENG-9001: fix it"].join("\n")),
    ).toBe("ENG-9001");
  });

  it("returns null when a leading fence has no ticket key after it", () => {
    expect(extractLeadingTicketKey(["```", "some code", "```", "Fix the dashboard"].join("\n"))).toBeNull();
  });
});

describe("resolveSessionTicketKey", () => {
  it("prefers the LLM-extracted key over all deterministic sources", () => {
    expect(
      resolveSessionTicketKey({ llmTicketKey: "ENG-1", linearIdentifier: "ARC-2", prompts: prompts("ENG-3: do it") }),
    ).toBe("ENG-1");
  });

  it("falls back to the Linear identifier when the LLM gives none", () => {
    expect(
      resolveSessionTicketKey({ llmTicketKey: null, linearIdentifier: "ARC-778", prompts: prompts("Do the thing") }),
    ).toBe("ARC-778");
  });

  it("falls back to a leading bare key in P0 when LLM and Linear are absent", () => {
    expect(resolveSessionTicketKey({ prompts: prompts("ENG-9001: fix x") })).toBe("ENG-9001");
  });

  it("returns null when the only key is mid-sentence and the LLM gave nothing (outage degradation)", () => {
    expect(resolveSessionTicketKey({ prompts: prompts("hey cycloid work on ENG-9001") })).toBeNull();
  });

  it("ignores a malformed/lowercase LLM or Linear value and continues down the chain", () => {
    expect(
      resolveSessionTicketKey({ llmTicketKey: "not a key", linearIdentifier: "ARC-2", prompts: prompts("x") }),
    ).toBe("ARC-2");
    expect(resolveSessionTicketKey({ linearIdentifier: "eng-2", prompts: prompts("ENG-9001: fix") })).toBe("ENG-9001");
  });

  it("returns null when there is no key anywhere", () => {
    expect(resolveSessionTicketKey({ prompts: prompts("Fix the dashboard") })).toBeNull();
    expect(resolveSessionTicketKey({ prompts: [] })).toBeNull();
  });
});
