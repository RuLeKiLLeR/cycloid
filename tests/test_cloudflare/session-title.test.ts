import { describe, expect, it } from "vitest";

import { deriveFirstLineTitle, getAutoCloseGraceMs } from "../../apps/control-plane-worker/src/constants/sessions";
import { derivePromptTitleCandidate } from "../../apps/control-plane-worker/src/session/prompt-text";

describe("deriveFirstLineTitle", () => {
  it("extracts the first line of normal text", () => {
    expect(deriveFirstLineTitle("Fix the login bug")).toBe("Fix the login bug");
  });

  it("strips markdown header prefixes", () => {
    expect(deriveFirstLineTitle("# Fix the login bug")).toBe("Fix the login bug");
    expect(deriveFirstLineTitle("## Refactor auth module")).toBe("Refactor auth module");
    expect(deriveFirstLineTitle("### Deep heading")).toBe("Deep heading");
  });

  it("returns only the first line of multi-line text", () => {
    expect(deriveFirstLineTitle("First line\nSecond line\nThird")).toBe("First line");
  });

  it("truncates long text to SESSION_TITLE_MAX_LENGTH (72)", () => {
    const long = "A".repeat(100);
    const result = deriveFirstLineTitle(long);
    expect(result).toHaveLength(72);
    expect(result).toBe("A".repeat(72));
  });

  it("returns null for empty string", () => {
    expect(deriveFirstLineTitle("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(deriveFirstLineTitle("   ")).toBeNull();
  });

  it("returns null for header-only string", () => {
    expect(deriveFirstLineTitle("# ")).toBeNull();
    expect(deriveFirstLineTitle("##  ")).toBeNull();
  });

  it("trims leading/trailing whitespace", () => {
    expect(deriveFirstLineTitle("  Hello world  ")).toBe("Hello world");
  });
});

describe("derivePromptTitleCandidate (fence-aware, ARC-1539)", () => {
  it("returns the first meaningful line when there is no fence", () => {
    expect(derivePromptTitleCandidate("Fix the login bug\nmore detail")).toBe("Fix the login bug");
  });

  it("skips a leading ```lang fenced code block and titles from the following prose", () => {
    const prompt = ["```typescript", "const x = 1;", "```", "Fix the flaky title derivation"].join("\n");
    expect(derivePromptTitleCandidate(prompt)).toBe("Fix the flaky title derivation");
  });

  it("skips a leading ~~~ fenced block", () => {
    const prompt = ["~~~", "error: boom", "~~~", "Investigate the crash"].join("\n");
    expect(derivePromptTitleCandidate(prompt)).toBe("Investigate the crash");
  });

  it("does not let a ~~~ line prematurely close a backtick fence", () => {
    // The `~~~` inside the ``` block must NOT re-open a title candidate from `still code`.
    const prompt = ["```", "~~~", "still code", "```", "Real task here"].join("\n");
    expect(derivePromptTitleCandidate(prompt)).toBe("Real task here");
  });

  it("does not let a triple-backtick line close a four-backtick fence", () => {
    const prompt = ["````", "```", "nested code", "````", "Outer task"].join("\n");
    expect(derivePromptTitleCandidate(prompt)).toBe("Outer task");
  });

  it("does not let an inner info-string fence line prematurely close the block", () => {
    // An open ``` block whose next line is ```ts (an info-string line). Per CommonMark that
    // line cannot close the fence, so the `const x = 1;` inside stays fenced and is never a
    // title candidate; only the bare ``` closes the block and the real prose after it wins.
    const prompt = ["```", "```ts", "const x = 1;", "```", "Fix the nested-fence title bug"].join("\n");
    expect(derivePromptTitleCandidate(prompt)).toBe("Fix the nested-fence title bug");
  });

  it("tolerates an indented fence", () => {
    const prompt = ["   ```", "code", "   ```", "Handle indentation"].join("\n");
    expect(derivePromptTitleCandidate(prompt)).toBe("Handle indentation");
  });

  it("returns null for an unterminated / code-only prompt", () => {
    expect(derivePromptTitleCandidate(["```ts", "const x = 1;"].join("\n"))).toBeNull();
    expect(derivePromptTitleCandidate("```typescript")).toBeNull();
  });

  it("skips a metadata line that follows the fenced block", () => {
    const prompt = ["```", "code", "```", "Repository: trycycloid/cycloid", "Actual task title"].join("\n");
    expect(derivePromptTitleCandidate(prompt)).toBe("Actual task title");
  });
});

describe("getAutoCloseGraceMs", () => {
  it("falls back to the default for fractional values", () => {
    expect(getAutoCloseGraceMs({ SESSION_AUTO_CLOSE_GRACE_MS: "0.5" })).toBe(24 * 60 * 60 * 1000);
  });

  it("returns a valid positive integer unchanged", () => {
    expect(getAutoCloseGraceMs({ SESSION_AUTO_CLOSE_GRACE_MS: "1234" })).toBe(1234);
  });

  it("accepts scientific-notation integers", () => {
    expect(getAutoCloseGraceMs({ SESSION_AUTO_CLOSE_GRACE_MS: "1e9" })).toBe(1_000_000_000);
  });
});
