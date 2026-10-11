// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import { resolveCanUseToolDecision } from "../../apps/sandbox-bridge/src/services/claude-tool-safety.js";
import { checkToolSafety } from "../../apps/sandbox-bridge/src/utils/protection.js";

describe("resolveCanUseToolDecision (fail-closed canUseTool gate)", () => {
  it("allows a normal source-file edit", () => {
    expect(resolveCanUseToolDecision("Write", { file_path: "/repo/src/app.ts" })).toEqual({ behavior: "allow" });
  });

  it("denies a write to a protected path and surfaces the violation message", () => {
    const d = resolveCanUseToolDecision("Write", { file_path: "/repo/.env" });
    expect(d.behavior).toBe("deny");
    expect(d.message).toContain("protected path");
  });

  it("denies a bash command that touches a protected path", () => {
    expect(resolveCanUseToolDecision("Bash", { command: "cat .env.production" }).behavior).toBe("deny");
  });

  it("denies bash commands outside the worktree in review-loop mode", () => {
    const d = resolveCanUseToolDecision(
      "Bash",
      { command: "printf hacked > ../other-repo/leak.txt" },
      { reviewLoopMode: true, worktreeRoot: "/workspace/repo" },
    );

    expect(d.behavior).toBe("deny");
    expect(d.message).toContain("review-loop access outside worktree");
  });

  it("reuses the shared checkToolSafety rules (parity with Codex)", () => {
    const tool = "Bash";
    const input = { command: "git push origin main --force" };
    const expectedViolation = checkToolSafety(tool, input);
    const d = resolveCanUseToolDecision(tool, input);

    if (expectedViolation) {
      expect(d).toEqual({ behavior: "deny", message: expectedViolation.message });
    } else {
      expect(d).toEqual({ behavior: "allow" });
    }
  });

  it("fails closed (deny) when the tool name is missing, empty, or not a string", () => {
    expect(resolveCanUseToolDecision(undefined, { file_path: "/repo/.env" }).behavior).toBe("deny");
    expect(resolveCanUseToolDecision("", {}).behavior).toBe("deny");
    expect(resolveCanUseToolDecision(123, {}).behavior).toBe("deny");
  });

  it("fails closed (deny) when input is not a plain object", () => {
    expect(resolveCanUseToolDecision("Write", null).behavior).toBe("deny");
    expect(resolveCanUseToolDecision("Write", undefined).behavior).toBe("deny");
    expect(resolveCanUseToolDecision("Write", "nope").behavior).toBe("deny");
    expect(resolveCanUseToolDecision("Write", []).behavior).toBe("deny");
    expect(resolveCanUseToolDecision("Write", new Date()).behavior).toBe("deny");
    expect(resolveCanUseToolDecision("Write", new Map()).behavior).toBe("deny");
  });

  it("fails closed (deny) when the safety check throws", () => {
    const exploding = {
      get file_path() {
        throw new Error("boom");
      },
    };
    const d = resolveCanUseToolDecision("Write", exploding);
    expect(d.behavior).toBe("deny");
    // checkToolSafety now catches internal errors itself and returns a
    // blocked_tool violation (centralizing fail-closed for the Codex/opencode
    // paths, which have no outer catch), so the deny surfaces via the violation
    // message rather than resolveCanUseToolDecision's own "evaluation error"
    // fallback. Either way the underlying cause is surfaced and the call denies.
    expect(d.message).toContain("tool safety check failed internally");
    expect(d.message).toContain("boom");
  });
});
