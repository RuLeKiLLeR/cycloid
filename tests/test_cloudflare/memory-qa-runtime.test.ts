import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

const { mockQueryPlatformStructuredOutput } = vi.hoisted(() => ({
  mockQueryPlatformStructuredOutput: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/services/platform-structured-output", () => ({
  queryPlatformStructuredOutput: mockQueryPlatformStructuredOutput,
}));

import type { Logger } from "../../apps/control-plane-worker/src/logger";
import { captureQaRuntimeLearningsFromPhaseNote } from "../../apps/control-plane-worker/src/memory/qa-runtime";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { QA_RUNTIME_LEARNINGS_FENCE, QA_RUNTIME_MEMORY_TAG } from "../../shared/constants/qa-runtime-memory";
import { parseMemoryFile, serializeMemoryFile } from "../../shared/memory/parser";

class QueryCapture {
  queries: { sql: string; binds: unknown[] }[] = [];
  nextAllResults: unknown[] = [];

  prepare(sql: string) {
    const self = this;
    const binds: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        binds.push(...args);
        return this;
      },
      async first<T>(): Promise<T | null> {
        self.queries.push({ sql, binds });
        return null;
      },
      async run() {
        self.queries.push({ sql, binds });
        return { meta: { changes: 1 } };
      },
      async all<T>() {
        self.queries.push({ sql, binds });
        return { results: self.nextAllResults as T[] };
      },
    };
  }

  async batch(stmts: unknown[]) {
    const results = [];
    for (const stmt of stmts) {
      const s = stmt as { run: () => Promise<unknown> };
      results.push(await s.run());
    }
    return results;
  }
}

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function fencedNote(entries: unknown[]): string {
  return [
    "Launcher note: app booted after fixing the ready path.",
    "```" + QA_RUNTIME_LEARNINGS_FENCE,
    JSON.stringify(entries),
    "```",
    "## Handoff",
    "Route impact: none",
  ].join("\n");
}

const LEARNING = {
  kind: "gotcha",
  claim: "Ready check must hit /healthz, not /",
  detail: "Root route 302s to /login before the DB pool warms.",
  evidence: "curl -sf 127.0.0.1:3000/healthz succeeded at 41s",
};

function existingMemoryRow(id: string, tags: string[]): { memoryJson: string } {
  return {
    memoryJson: JSON.stringify({
      id,
      vertical: "engineering",
      memory_type: "action",
      action_type: "procedure",
      level: "gotcha",
      primitive: "gotcha",
      engineering_domains: ["runtime_behavior"],
      subjects: [],
      symbols: [],
      tags,
      status: "active",
      confidence: "medium",
      authority: "inferred",
      owner: "cycloid",
      applies_to: [],
      context_hint: `hint for ${id}`,
      source_pr_urls: [],
      source_session_ids: [],
      evidence: [],
      enforcement: "none",
      triggers: null,
      supersedes: [],
      contradicts: [],
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      content: `content for ${id}`,
    }),
  };
}

function baseParams(noteOutput: string) {
  return {
    repoOwner: "trycycloid",
    repoName: "dummy-app",
    targetPrUrl: "https://github.com/trycycloid/dummy-app/pull/7",
    qaSessionId: "qa-session-1",
    promptId: "prompt-abc-123",
    phase: "verification-launcher",
    noteOutput,
    log: createLogger(),
  };
}

function envWith(overrides: Partial<Record<string, unknown>> = {}): Env {
  return {
    DB: new QueryCapture() as unknown as D1Database,
    MEMORY_REPO_SINK: "d1",
    ARCANIST_OPENAI_API_KEY: "sk-test",
    ...overrides,
  } as unknown as Env;
}

describe("captureQaRuntimeLearningsFromPhaseNote", () => {
  beforeEach(() => {
    mockQueryPlatformStructuredOutput.mockReset();
  });

  it("stores a judged learning as a QA-tagged repo memory plus judgment row", async () => {
    const db = new QueryCapture();
    const env = envWith({ DB: db as unknown as D1Database });
    mockQueryPlatformStructuredOutput.mockResolvedValue({
      verdict: "store",
      confidence: 0.7,
      rationale: "Concrete runtime gotcha.",
      issues: [],
    });

    const result = await captureQaRuntimeLearningsFromPhaseNote(env, baseParams(fencedNote([LEARNING])));

    expect(result).toEqual({ parsedCount: 1, storedCount: 1, rejectedCount: 0, supersededCount: 0 });
    const memoryInsert = db.queries.find((query) => query.sql.includes("INSERT INTO repo_memories"));
    const judgmentInsert = db.queries.find((query) => query.sql.includes("INSERT INTO repo_memory_judgments"));
    expect(memoryInsert).toBeDefined();
    expect(judgmentInsert).toBeDefined();

    expect(memoryInsert?.binds[3]).toBe("mem_qa_pr_7_prompt-a_launcher_1");
    expect(memoryInsert?.binds[4]).toBe("active");
    expect(memoryInsert?.binds[5]).toBe("action");
    expect(memoryInsert?.binds[8]).toBe("gotcha");
    expect(memoryInsert?.binds[10]).toBe("inferred");
    expect(memoryInsert?.binds[11]).toBe("none");
    expect(memoryInsert?.binds[12]).toBe(`QA runtime: ${LEARNING.claim}`);

    const memoryJson = JSON.parse(memoryInsert?.binds[18] as string) as {
      tags: string[];
      engineering_domains: string[];
      content: string;
    };
    expect(memoryJson.tags).toEqual([QA_RUNTIME_MEMORY_TAG, "gotcha"]);
    expect(memoryJson.engineering_domains).toEqual(["runtime_behavior"]);
    expect(memoryJson.content).toContain(LEARNING.detail);
    expect(memoryJson.content).toContain(LEARNING.evidence);

    // Built memory must round-trip through the canonical MemoryFile serializer.
    const roundTripped = parseMemoryFile(serializeMemoryFile(JSON.parse(memoryInsert?.binds[18] as string)));
    expect(roundTripped?.id).toBe("mem_qa_pr_7_prompt-a_launcher_1");
    expect(roundTripped?.tags).toContain(QA_RUNTIME_MEMORY_TAG);

    expect(judgmentInsert?.binds[9]).toBe("store");
  });

  it("keeps launcher and operator learnings from the same prompt on distinct memory ids", async () => {
    const db = new QueryCapture();
    const env = envWith({ DB: db as unknown as D1Database });
    mockQueryPlatformStructuredOutput.mockResolvedValue({
      verdict: "store",
      confidence: 0.7,
      rationale: "Concrete runtime gotcha.",
      issues: [],
    });

    await captureQaRuntimeLearningsFromPhaseNote(env, baseParams(fencedNote([LEARNING])));
    await captureQaRuntimeLearningsFromPhaseNote(env, {
      ...baseParams(fencedNote([LEARNING])),
      phase: "verification-operator",
    });

    const memoryIds = db.queries
      .filter((query) => query.sql.includes("INSERT INTO repo_memories"))
      .map((query) => query.binds[3]);
    expect(memoryIds).toEqual(["mem_qa_pr_7_prompt-a_launcher_1", "mem_qa_pr_7_prompt-a_operator_1"]);
  });

  it("records only a judgment row when the judge rejects", async () => {
    const db = new QueryCapture();
    const env = envWith({ DB: db as unknown as D1Database });
    mockQueryPlatformStructuredOutput.mockResolvedValue({
      verdict: "reject",
      confidence: 0.3,
      rationale: "Too PR-specific.",
      issues: ["not durable"],
    });

    const result = await captureQaRuntimeLearningsFromPhaseNote(env, baseParams(fencedNote([LEARNING])));

    expect(result).toEqual({ parsedCount: 1, storedCount: 0, rejectedCount: 1, supersededCount: 0 });
    expect(db.queries.some((query) => query.sql.includes("INSERT INTO repo_memories"))).toBe(false);
    const judgmentInsert = db.queries.find((query) => query.sql.includes("INSERT INTO repo_memory_judgments"));
    expect(judgmentInsert?.binds[9]).toBe("reject");
  });

  it("records a below-floor store judgment without writing a QA runtime memory", async () => {
    const db = new QueryCapture();
    const env = envWith({ DB: db as unknown as D1Database });
    mockQueryPlatformStructuredOutput.mockResolvedValue({
      verdict: "store",
      confidence: 0.3,
      rationale: "Plausible but uncertain.",
      issues: [],
    });

    const result = await captureQaRuntimeLearningsFromPhaseNote(env, baseParams(fencedNote([LEARNING])));

    expect(result).toEqual({ parsedCount: 1, storedCount: 0, rejectedCount: 1, supersededCount: 0 });
    expect(db.queries.some((query) => query.sql.includes("INSERT INTO repo_memories"))).toBe(false);
    const judgmentInsert = db.queries.find((query) => query.sql.includes("INSERT INTO repo_memory_judgments"));
    expect(judgmentInsert?.binds[9]).toBe("reject");
    expect(judgmentInsert?.binds[11]).toBe("store_below_confidence_floor: Plausible but uncertain.");
  });

  it("supersedes only QA-tagged memories cited in supersedesMemoryIds", async () => {
    const db = new QueryCapture();
    db.nextAllResults = [
      existingMemoryRow("mem_qa_pr_6_old_1", [QA_RUNTIME_MEMORY_TAG, "gotcha"]),
      existingMemoryRow("mem_pr_5_add_1", ["gotcha"]),
    ];
    const env = envWith({ DB: db as unknown as D1Database });
    mockQueryPlatformStructuredOutput.mockResolvedValue({
      verdict: "store",
      confidence: 0.7,
      rationale: "Supersedes the stale ready-path memory.",
      issues: [],
    });

    const result = await captureQaRuntimeLearningsFromPhaseNote(
      env,
      baseParams(fencedNote([{ ...LEARNING, supersedesMemoryIds: ["mem_qa_pr_6_old_1", "mem_pr_5_add_1", "ghost"] }])),
    );

    expect(result.supersededCount).toBe(1);
    const memoryInserts = db.queries.filter((query) => query.sql.includes("INSERT INTO repo_memories"));
    expect(memoryInserts).toHaveLength(2);
    const supersededInsert = memoryInserts.find((query) => query.binds[3] === "mem_qa_pr_6_old_1");
    expect(supersededInsert?.binds[4]).toBe("superseded");
    expect(memoryInserts.some((query) => query.binds[3] === "mem_pr_5_add_1")).toBe(false);
  });

  it("no-ops without D1 sink, without a parseable note, or without a PR number", async () => {
    for (const [env, note] of [
      [envWith({ MEMORY_REPO_SINK: undefined }), fencedNote([LEARNING])],
      [envWith(), "Launcher note with no fenced block."],
      [envWith(), "```" + QA_RUNTIME_LEARNINGS_FENCE + "\n{broken\n```"],
    ] as const) {
      const db = (env as unknown as { DB: QueryCapture }).DB;
      const result = await captureQaRuntimeLearningsFromPhaseNote(env, baseParams(note));
      expect(result).toEqual({ parsedCount: 0, storedCount: 0, rejectedCount: 0, supersededCount: 0 });
      expect(db.queries).toHaveLength(0);
    }

    const badUrl = await captureQaRuntimeLearningsFromPhaseNote(envWith(), {
      ...baseParams(fencedNote([LEARNING])),
      targetPrUrl: "https://example.com/not-a-pr",
    });
    expect(badUrl).toEqual({ parsedCount: 0, storedCount: 0, rejectedCount: 0, supersededCount: 0 });
    expect(mockQueryPlatformStructuredOutput).not.toHaveBeenCalled();
  });
});
