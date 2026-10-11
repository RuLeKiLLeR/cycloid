import { execFileSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

import { isPlatformLlmCallType, PLATFORM_LLM_CALL_TYPES } from "../../shared/llm/platform-llm-contract";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("platform LLM contract", () => {
  it("exposes the supported platform LLM call types", () => {
    expect(PLATFORM_LLM_CALL_TYPES).toEqual(["pr_template_fill", "review_loop_triage", "slack_progress_narration"]);
  });

  it("rejects removed post-execution call types", () => {
    expect(isPlatformLlmCallType("memory_ranking")).toBe(false);
    expect(isPlatformLlmCallType("focused_command_planning")).toBe(false);
    expect(isPlatformLlmCallType("commit_message")).toBe(false);
    expect(isPlatformLlmCallType("pr_summary")).toBe(false);
    expect(isPlatformLlmCallType("intent_summary")).toBe(false);
  });

  it("retains no focused-command planner references in shipped source", () => {
    // The focused-command planner was deleted (no LLM-invented auto-run verification command).
    // Guard against reintroduction in shipped source. Tests legitimately reference the removed
    // call type to assert it is now rejected, so only apps/ and shared/ are scanned.
    let matches = "";
    try {
      matches = execFileSync(
        "grep",
        [
          "-rIl",
          "--exclude-dir=node_modules",
          "--exclude-dir=.wrangler",
          "--exclude-dir=dist",
          "-e",
          "focused_command_planning",
          "-e",
          "FocusedCommandPlan",
          "-e",
          "planFocusedCommand",
          "apps",
          "shared",
        ],
        { cwd: REPO_ROOT, encoding: "utf-8" },
      );
    } catch (error) {
      // grep exits 1 (no output) when there are no matches; anything else is a real failure.
      if ((error as { status?: number }).status !== 1) throw error;
    }
    expect(matches.trim()).toBe("");
  });
});
