import { describe, expect, it } from "vitest";

import {
  QA_RUNTIME_LEARNINGS_FENCE,
  QA_RUNTIME_LEARNINGS_MAX_ENTRIES,
  QA_RUNTIME_MEMORY_TAG,
} from "../../shared/constants/qa-runtime-memory";
import {
  isQaRuntimeMemory,
  parseQaRuntimeLearnings,
  visibleRepoMemoriesForSession,
} from "../../shared/verification/qa-runtime-learnings";

function fenced(json: string): string {
  return ["```" + QA_RUNTIME_LEARNINGS_FENCE, json, "```"].join("\n");
}

const VALID_LEARNING = {
  kind: "gotcha",
  claim: "Ready check must hit /healthz, not /",
  detail: "Root route 302s to /login before the DB pool warms.",
  evidence: "curl -sf 127.0.0.1:3000/healthz succeeded at 41s",
};

describe("parseQaRuntimeLearnings", () => {
  it("extracts a valid block amid free-form prose", () => {
    const note = [
      "Launcher note: app booted after seeding.",
      fenced(JSON.stringify([VALID_LEARNING])),
      "## Handoff",
      "Route impact: none",
    ].join("\n");
    const learnings = parseQaRuntimeLearnings(note);
    expect(learnings).toHaveLength(1);
    expect(learnings?.[0]).toEqual({
      kind: "gotcha",
      claim: VALID_LEARNING.claim,
      detail: VALID_LEARNING.detail,
      evidence: VALID_LEARNING.evidence,
      supersedesMemoryIds: [],
    });
  });

  it("returns null when no block is present", () => {
    expect(parseQaRuntimeLearnings("Launcher note: nothing new.")).toBeNull();
  });

  it("returns null for malformed JSON, empty fences, and non-array payloads", () => {
    expect(parseQaRuntimeLearnings(fenced("{not json"))).toBeNull();
    expect(parseQaRuntimeLearnings(fenced(""))).toBeNull();
    expect(parseQaRuntimeLearnings(fenced(JSON.stringify({ kind: "gotcha" })))).toBeNull();
  });

  it("uses the last parseable fence when several are present", () => {
    const note = [
      fenced(JSON.stringify([{ ...VALID_LEARNING, claim: "first" }])),
      fenced(JSON.stringify([{ ...VALID_LEARNING, claim: "second" }])),
    ].join("\n");
    expect(parseQaRuntimeLearnings(note)?.[0]?.claim).toBe("second");
  });

  it("caps entries, bounds field lengths, and caps supersedes ids", () => {
    const entries = Array.from({ length: QA_RUNTIME_LEARNINGS_MAX_ENTRIES + 2 }, (_, index) => ({
      ...VALID_LEARNING,
      claim: `claim ${index} ${"x".repeat(500)}`,
      detail: "y".repeat(3_000),
      evidence: "z".repeat(1_000),
      supersedesMemoryIds: ["a", "b", "c", "d", "e", "f", "g"],
    }));
    const learnings = parseQaRuntimeLearnings(fenced(JSON.stringify(entries)));
    expect(learnings).toHaveLength(QA_RUNTIME_LEARNINGS_MAX_ENTRIES);
    expect(learnings?.[0]?.claim.length).toBe(200);
    expect(learnings?.[0]?.detail.length).toBe(1_500);
    expect(learnings?.[0]?.evidence.length).toBe(500);
    expect(learnings?.[0]?.supersedesMemoryIds).toHaveLength(5);
  });

  it("drops entries with invalid kind or missing claim/detail and unknown fields", () => {
    const learnings = parseQaRuntimeLearnings(
      fenced(
        JSON.stringify([
          { ...VALID_LEARNING, extraField: "dropped" },
          { ...VALID_LEARNING, kind: "opinion" },
          { ...VALID_LEARNING, supersedesMemoryIds: [42, "", "  mem_1  "] },
        ]),
      ),
    );
    expect(learnings).toHaveLength(2);
    expect(learnings?.[0]).not.toHaveProperty("extraField");
    expect(learnings?.[1]?.supersedesMemoryIds).toEqual(["mem_1"]);
  });

  it("returns null when every entry is invalid", () => {
    expect(parseQaRuntimeLearnings(fenced(JSON.stringify([{ kind: "gotcha" }])))).toBeNull();
  });
});

describe("isQaRuntimeMemory", () => {
  it("matches only memories tagged with the QA runtime tag", () => {
    expect(isQaRuntimeMemory({ tags: [QA_RUNTIME_MEMORY_TAG, "gotcha"] })).toBe(true);
    expect(isQaRuntimeMemory({ tags: ["gotcha"] })).toBe(false);
    expect(isQaRuntimeMemory({ tags: [] })).toBe(false);
    expect(isQaRuntimeMemory({})).toBe(false);
    expect(isQaRuntimeMemory({ tags: null })).toBe(false);
  });
});

describe("visibleRepoMemoriesForSession", () => {
  const pool = [
    { id: "regular", tags: ["gotcha"] },
    { id: "qa", tags: [QA_RUNTIME_MEMORY_TAG, "procedure"] },
    { id: "untagged", tags: undefined },
  ];

  it("keeps the full pool for QA sessions", () => {
    expect(visibleRepoMemoriesForSession(pool, { qaSession: true }).map((memory) => memory.id)).toEqual([
      "regular",
      "qa",
      "untagged",
    ]);
  });

  it("filters QA runtime memories for non-QA sessions", () => {
    expect(visibleRepoMemoriesForSession(pool, { qaSession: false }).map((memory) => memory.id)).toEqual([
      "regular",
      "untagged",
    ]);
  });
});
