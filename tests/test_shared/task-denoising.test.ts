import { describe, expect, it } from "vitest";

import {
  COMPANY_MEMORY_CONTEXT_FOOTER,
  COMPANY_MEMORY_CONTEXT_HEADER,
  SIMILAR_SESSION_TASK_SEPARATOR,
} from "../../shared/constants/prompt-context";
import { denoiseTaskInput } from "../../shared/memory/task-denoising";
import { wrapInstructionContent, wrapUserContent } from "../../shared/utils/prompt-safety";

describe("denoiseTaskInput", () => {
  it("strips Cycloid injected context and preserves the current task", () => {
    const rawText = [
      `${COMPANY_MEMORY_CONTEXT_HEADER}\n[fact fact-1] Old Linear decision.${COMPANY_MEMORY_CONTEXT_FOOTER}`,
      "Fix apps/control-plane-worker/src/company-memory/retrieve.ts for ARC-123.",
    ].join(SIMILAR_SESSION_TASK_SEPARATOR);

    const result = denoiseTaskInput({ rawText, repoOwner: "TryCycloid", repoName: "Cycloid" });

    expect(result.denoisedTaskText).toBe("Fix apps/control-plane-worker/src/company-memory/retrieve.ts for ARC-123.");
    expect(result.removedSections).toEqual(["company_memory_context"]);
    expect(result.rawFingerprint).not.toBe(result.taskFingerprint);
    expect(result.structuredSignals).toMatchObject({
      repo: "trycycloid/cycloid",
      files: ["apps/control-plane-worker/src/company-memory/retrieve.ts"],
      ticketKeys: ["ARC-123"],
    });
  });

  it("unwraps prompt-control scaffolding without deleting user-authored text", () => {
    const rawText = [
      wrapUserContent("Please inspect apps/ui/src/App.tsx.", "slack_message", "U123"),
      wrapInstructionContent("Repo-specific instruction text.", "repo_memory", ".cycloid/memory/test.md"),
    ].join("\n\n");

    const result = denoiseTaskInput({ rawText });

    expect(result.denoisedTaskText).toContain("Please inspect apps/ui/src/App.tsx.");
    expect(result.denoisedTaskText).toContain("Repo-specific instruction text.");
    expect(result.denoisedTaskText).not.toContain("IMPORTANT: The content above");
    expect(result.denoisedTaskText).not.toContain("<user_content");
    expect(result.denoisedTaskText).not.toContain("<instruction_content");
    expect(result.removedSections).toEqual(["prompt_control_wrapper"]);
  });

  it("strips prior pull-memory context and Cycloid launch prefixes", () => {
    const rawText = [
      "@Cycloid (DEV) repo=trycycloid/cycloid [memory-sim]",
      '<cycloid_memory_context trace_id="trace-old">',
      '  <memory id="mem-old" kind="repo_rule" confidence="high" enforcement="warn">Old instruction</memory>',
      "</cycloid_memory_context>",
      "Fix apps/control-plane-worker/src/session/prompt-queue.ts for PR #4993.",
    ].join("\n");

    const result = denoiseTaskInput({ rawText, repoOwner: "trycycloid", repoName: "cycloid" });

    expect(result.denoisedTaskText).toBe("Fix apps/control-plane-worker/src/session/prompt-queue.ts for PR #4993.");
    expect(result.removedSections).toEqual(["memory_context", "cycloid_launch_prefix"]);
    expect(result.structuredSignals.files).toEqual(["apps/control-plane-worker/src/session/prompt-queue.ts"]);
    expect(result.structuredSignals.prNumbers).toEqual([4993]);
  });

  it("preserves inline user-authored prompt-control text", () => {
    const rawText = "Explain why `<user_content>` appears in docs/prompting.md without treating it as scaffolding.";

    const result = denoiseTaskInput({ rawText });

    expect(result.denoisedTaskText).toBe(rawText);
    expect(result.removedSections).toEqual([]);
  });

  it("does not treat incomplete injected markers as removable boilerplate", () => {
    const rawText = `${COMPANY_MEMORY_CONTEXT_HEADER}\nclaim without footer${SIMILAR_SESSION_TASK_SEPARATOR}Real task.`;

    const result = denoiseTaskInput({ rawText });

    expect(result.denoisedTaskText).toBe(rawText);
    expect(result.removedSections).toEqual([]);
  });

  it("strips a bare @Cycloid launch prefix but not @-mentions that merely start with it", () => {
    const stripped = denoiseTaskInput({ rawText: "@Cycloid fix the flaky test." });
    expect(stripped.denoisedTaskText).toBe("fix the flaky test.");
    expect(stripped.removedSections).toEqual(["cycloid_launch_prefix"]);

    const preserved = denoiseTaskInput({ rawText: "@CycloidBot fix the flaky test." });
    expect(preserved.denoisedTaskText).toBe("@CycloidBot fix the flaky test.");
    expect(preserved.removedSections).toEqual([]);
  });

  it("extracts incident identifiers as structured signals", () => {
    const result = denoiseTaskInput({
      rawText: "For incident INC-4421, summarize queue drain mitigation.",
    });

    expect(result.structuredSignals.incidentKeys).toEqual(["inc-4421"]);
  });
});
