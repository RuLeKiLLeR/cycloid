import { describe, expect, it } from "vitest";

import { formatMemorySection, type Memory } from "../../apps/sandbox-bridge/src/services/memory-ranking";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    content: "Always check auth before accessing protected routes",
    context_hint: "When working with auth or routing",
    type: "action",
    memory_type: "action",
    action_type: "procedure",
    level: "tactical",
    primitive: "procedure",
    status: "active",
    confidence: "medium",
    authority: "reviewed",
    applies_to: ["src/router.ts"],
    scope: "repo",
    referenced_files: '["src/router.ts"]',
    ...overrides,
  };
}

describe("formatMemorySection", () => {
  it("returns empty string for no memories", () => {
    expect(formatMemorySection([])).toBe("");
  });

  it("formats explicit recall memories with spec-shaped metadata blocks", () => {
    const result = formatMemorySection([makeMemory()]);
    expect(result).toBe(
      [
        "# Engineering Memories",
        "",
        "These are learned patterns from past work. Apply when relevant. Retrieval used structured relevance scoring.",
        "## mem-1",
        "Type: action/procedure",
        "Level: tactical",
        "Confidence: medium",
        "Authority: reviewed",
        "Applies to: `src/router.ts`",
        "",
        "Always check auth before accessing protected routes",
      ].join("\n"),
    );
  });

  it("handles null referenced_files gracefully", () => {
    const result = formatMemorySection([makeMemory({ applies_to: [], referenced_files: null })]);
    expect(result).not.toContain("Applies to:");
  });

  it("returns empty string when no memory block fits the recall output budget", () => {
    const referencedFiles = Array.from({ length: 500 }, (_, index) => `src/file-${index}.ts`);
    const result = formatMemorySection([
      makeMemory({
        content: "short memory",
        applies_to: referencedFiles,
        referenced_files: JSON.stringify(referencedFiles),
      }),
    ]);

    expect(result).toBe("");
  });

  it("truncates memory body text inside the recall output budget", () => {
    const result = formatMemorySection([makeMemory({ content: "x".repeat(30_000) })]);

    expect(result).toContain("## mem-1");
    expect(result).toContain("...[truncated memory]");
    expect(result.length).toBeLessThanOrEqual(4_000);
  });
});
