import { describe, expect, it } from "vitest";

import { formatQaRuntimeMemorySection } from "../../apps/sandbox-bridge/src/constants/bridge";
import { QA_RUNTIME_MEMORY_INJECTION_LIMIT } from "../../shared/constants/qa-runtime-memory";

function memory(index: number): { id: string; context_hint: string; content: string } {
  return {
    id: `mem_qa_pr_1_prompt_${index}`,
    context_hint: `QA runtime: hint ${index}`,
    content: `detail ${index}`,
  };
}

describe("formatQaRuntimeMemorySection", () => {
  it("renders id, context hint, and content per memory with the apply-first instruction", () => {
    const section = formatQaRuntimeMemorySection([memory(1), memory(2)]);
    expect(section).toContain("Apply them before rediscovering app setup");
    expect(section).toContain("supersedesMemoryIds");
    expect(section).toContain("## mem_qa_pr_1_prompt_1");
    expect(section).toContain("QA runtime: hint 2");
    expect(section).toContain("detail 2");
  });

  it("caps rendered entries at the injection limit, keeping the most recent first", () => {
    const memories = Array.from({ length: QA_RUNTIME_MEMORY_INJECTION_LIMIT + 5 }, (_, index) => memory(index));
    const section = formatQaRuntimeMemorySection(memories);
    expect(section).toContain(`## ${memory(0).id}`);
    expect(section).toContain(`## ${memory(QA_RUNTIME_MEMORY_INJECTION_LIMIT - 1).id}`);
    expect(section).not.toContain(`## ${memory(QA_RUNTIME_MEMORY_INJECTION_LIMIT).id}`);
  });
});
