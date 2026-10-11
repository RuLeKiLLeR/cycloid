import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalyzerContext, ReviewFeedback } from "../../apps/control-plane-worker/src/memory/analyzer";

const mockQueryOpenAIStructuredOutput = vi.fn();

vi.mock("../../shared/llm/structured-output.js", () => ({
  StructuredOutputError: class StructuredOutputError extends Error {},
  queryOpenAIStructuredOutput: mockQueryOpenAIStructuredOutput,
}));

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function baseReviewFeedback(): ReviewFeedback {
  return {
    reviewBody: "Missing null check in the router handler.",
    comments: [
      { path: "src/router.ts", line: 42, body: "Handle the case where user is undefined.", author: "reviewer" },
    ],
    reviewAuthor: "reviewer",
    reviewState: "changes_requested",
  };
}

function baseContext(overrides?: Partial<AnalyzerContext>): AnalyzerContext {
  return {
    getSessionPrompts: vi.fn().mockResolvedValue([
      {
        promptId: "p1",
        prompt: "Fix the router null handling",
        status: "completed",
        error: null,
        createdAt: "2026-01-01T00:00:00Z",
        actorUserId: null,
      },
    ]),
    getSessionEvents: vi.fn().mockResolvedValue([]),
    getPrDiff: vi.fn().mockResolvedValue("diff --git a/src/router.ts b/src/router.ts\n+fixed null\n"),
    getFileContent: vi.fn().mockResolvedValue("export function handleRoute(user?: User) {\n  return user.name;\n}"),
    getExistingMemories: vi.fn().mockResolvedValue([]),
    getConventionDocSection: vi.fn().mockResolvedValue("## Mock Patterns\n\nSome existing conventions."),
    repoOwner: "trycycloid",
    repoName: "cycloid",
    sessionIds: ["sess-1"],
    prNumber: 123,
    prUrl: "https://github.com/trycycloid/cycloid/pull/123",
    ...overrides,
  };
}

const baseEpisodeSummary = {
  source_pr: "https://github.com/trycycloid/cycloid/pull/123",
  title: "Fix router null handling",
  change_summary: "Updated router null handling.",
  prompt_summary: "User asked to fix router null handling.",
  review_summary: "Reviewer flagged missing null checks.",
  touched_subsystems: ["src (1 file)"],
  existing_memory_summary: "No existing memory covered this.",
  durable_lesson: "Route handlers need reusable null handling guidance.",
};

function mockAnalyzerStructuredOutput(finalOutput: Record<string, unknown>) {
  const candidateAudit = Array.isArray(finalOutput.candidate_audit)
    ? finalOutput.candidate_audit
    : defaultCandidateAuditForOutput(finalOutput);
  mockQueryOpenAIStructuredOutput.mockResolvedValueOnce(baseEpisodeSummary).mockResolvedValueOnce({
    episode_summary: baseEpisodeSummary,
    candidate_audit: candidateAudit,
    memory_review: [],
    ...finalOutput,
  });
}

function defaultCandidateAuditForOutput(finalOutput: Record<string, unknown>) {
  const add = Array.isArray(finalOutput.add) ? finalOutput.add : [];
  const selectedLevels = new Set(
    add.flatMap((entry) =>
      entry && typeof entry === "object" && "level" in entry && typeof entry.level === "string" ? [entry.level] : [],
    ),
  );
  const hasSelectedMemory = selectedLevels.size > 0;
  return [
    {
      lane: "strategic",
      lesson: "No strategic lesson.",
      evidence: "The change is implementation-local.",
      selected: selectedLevels.has("strategic"),
      rejection_reason: selectedLevels.has("strategic") ? null : "Too narrow for strategic memory.",
    },
    {
      lane: "tactical",
      lesson: "Route handlers should share null handling patterns.",
      evidence: "Reviewer found the same route-handler risk.",
      selected: selectedLevels.has("tactical"),
      rejection_reason: selectedLevels.has("tactical") ? null : "A different lane was selected.",
    },
    {
      lane: "gotcha",
      lesson: "Optional route users can be undefined.",
      evidence: "Reviewer flagged missing null check.",
      selected: selectedLevels.has("gotcha"),
      rejection_reason: selectedLevels.has("gotcha") ? null : "A different lane was selected.",
    },
    {
      lane: "no_memory",
      lesson: "A memory may be unnecessary if code is self-documenting.",
      evidence: "The diff shows the guard.",
      selected: !hasSelectedMemory,
      rejection_reason: hasSelectedMemory ? "Reviewer feedback makes this reusable." : null,
    },
  ];
}

type JsonSchemaObject = {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaObject;
  anyOf?: JsonSchemaObject[];
};

function collectStrictSchemaViolations(schema: JsonSchemaObject, path = "$"): string[] {
  const violations: string[] = [];
  if (schema.type === "object" && schema.properties) {
    const propertyNames = Object.keys(schema.properties);
    const required = schema.required ?? [];
    const missing = propertyNames.filter((propertyName) => !required.includes(propertyName));
    if (missing.length > 0) {
      violations.push(`${path} missing required properties: ${missing.join(", ")}`);
    }
    if (schema.additionalProperties !== false) {
      violations.push(`${path} must set additionalProperties=false`);
    }
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      violations.push(...collectStrictSchemaViolations(propertySchema, `${path}.${propertyName}`));
    }
  }
  if (schema.items) {
    violations.push(...collectStrictSchemaViolations(schema.items, `${path}[]`));
  }
  for (const [index, variant] of (schema.anyOf ?? []).entries()) {
    violations.push(...collectStrictSchemaViolations(variant, `${path}.anyOf[${index}]`));
  }
  return violations;
}

describe("memory/analyzer structured output", () => {
  beforeEach(() => {
    vi.resetModules();
    mockQueryOpenAIStructuredOutput.mockReset();
  });

  it("completes when structured output returns valid suggestions", async () => {
    mockAnalyzerStructuredOutput({
      add: [
        {
          type: "gotcha",
          memory_type: "action",
          action_type: "procedure",
          level: "gotcha",
          primitive: "gotcha",
          engineering_domains: ["external_interface", "security"],
          subjects: ["routes"],
          symbols: ["handleRoute"],
          tags: ["gotcha", "routes"],
          confidence: "high",
          authority: "reviewed",
          enforcement: "none",
          triggers: null,
          supersedes: [],
          contradicts: [],
          content: "When routing handlers receive optional user params, always null-check before accessing properties.",
          context_hint: "When writing route handlers with optional user parameters",
          referenced_files: ["src/router.ts"],
          rationale: "Reviewer caught missing null check; pattern applies across all route handlers",
        },
      ],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const ctx = baseContext();
    const log = createLogger();

    const result = await analyzeSessionForMemories("sk-openai", baseReviewFeedback(), ctx, log as never);

    expect(result.suggestions.add).toHaveLength(1);
    expect(result.suggestions.add[0].type).toBe("gotcha");
    expect(result.suggestions.add[0]).toMatchObject({
      memory_type: "action",
      action_type: "procedure",
      level: "gotcha",
      primitive: "gotcha",
      engineering_domains: ["external_interface", "security"],
      confidence: "high",
      authority: "reviewed",
    });
    expect(result.suggestions.add[0].content).toContain("null-check");
    expect(result.suggestions.update).toHaveLength(0);
    expect(result.suggestions.remove).toHaveLength(0);
    expect(result.suggestions.convention_updates).toHaveLength(0);

    expect(ctx.getSessionPrompts).toHaveBeenCalledWith("sess-1");
    expect(ctx.getExistingMemories).toHaveBeenCalled();
    expect(ctx.getPrDiff).toHaveBeenCalled();
    expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-openai",
        reasoningEffort: "low",
        spanName: "memory.analysis",
        retry: { maxAttempts: 3 },
        strictErrors: true,
      }),
    );
    expect(mockQueryOpenAIStructuredOutput.mock.calls[0][0]).toMatchObject({
      spanName: "memory.episode_summary",
      retry: { maxAttempts: 3 },
    });
    expect(mockQueryOpenAIStructuredOutput.mock.calls[1][0]).toMatchObject({
      spanName: "memory.analysis",
      retry: { maxAttempts: 3 },
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallCount: 3, toolErrorCount: 0 }),
      "Memory analysis structured output completed",
    );
  });

  it("builds an OpenAI strict-compatible structured output schema", async () => {
    mockAnalyzerStructuredOutput({
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    await analyzeSessionForMemories("sk-openai", baseReviewFeedback(), baseContext(), createLogger() as never);

    const callArgs = mockQueryOpenAIStructuredOutput.mock.calls[1][0] as {
      tool: {
        input_schema: JsonSchemaObject;
      };
    };

    const strictSchema = {
      ...callArgs.tool.input_schema,
      additionalProperties: false,
    };
    expect(collectStrictSchemaViolations(strictSchema)).toEqual([]);
  });

  it("calibrates the prompt to preserve quality gotchas", async () => {
    mockAnalyzerStructuredOutput({
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    await analyzeSessionForMemories("sk-openai", baseReviewFeedback(), baseContext(), createLogger() as never);

    const callArgs = mockQueryOpenAIStructuredOutput.mock.calls[1][0] as { systemPrompt: string };

    expect(callArgs.systemPrompt).toContain(
      "Prefer both: the broader memory for planning and the gotcha for concrete risk",
    );
    expect(callArgs.systemPrompt).toContain("Do not collapse a good gotcha into a broader strategic/tactical memory");
    expect(callArgs.systemPrompt).toContain("races/order-sensitive lifecycle transitions");
    expect(callArgs.systemPrompt).toContain("credential/auth fail-closed edges");
    expect(callArgs.systemPrompt).toContain("parser/classifier precedence traps");
    expect(callArgs.systemPrompt).toContain("DB/API/provider limits");
    expect(callArgs.systemPrompt).toContain("sanitizer/redaction holes");
  });

  it("states the soft per-PR memory cap and subsumed_by dedup convention", async () => {
    mockAnalyzerStructuredOutput({
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    await analyzeSessionForMemories("sk-openai", baseReviewFeedback(), baseContext(), createLogger() as never);

    const callArgs = mockQueryOpenAIStructuredOutput.mock.calls[1][0] as { systemPrompt: string };

    expect(callArgs.systemPrompt).not.toContain("Select every lane whose candidate passes");
    expect(callArgs.systemPrompt).toContain("Target at most ONE memory per PR in the common case");
    expect(callArgs.systemPrompt).toContain("soft cap, not a hard limit");
    expect(callArgs.systemPrompt).toContain("subsumed_by_<lane>");
  });

  it("accepts a candidate audit that uses a subsumed_by rejection reason (schema shape holds)", async () => {
    // Three lanes pass; the overlapping ones are deduped via subsumed_by on the free-form
    // rejection_reason string. This is a soft cap, so the parser must still accept the shape.
    mockQueryOpenAIStructuredOutput.mockResolvedValueOnce(baseEpisodeSummary).mockResolvedValueOnce({
      episode_summary: baseEpisodeSummary,
      candidate_audit: [
        {
          lane: "strategic",
          lesson: "Router ownership boundary.",
          evidence: "Reviewer steered toward shared handling.",
          selected: false,
          rejection_reason: "subsumed_by_tactical",
        },
        {
          lane: "tactical",
          lesson: "Route handlers should share null handling.",
          evidence: "Reviewer flagged the reusable pattern.",
          selected: true,
          rejection_reason: null,
        },
        {
          lane: "gotcha",
          lesson: "Optional route users can be undefined.",
          evidence: "Reviewer flagged the missing guard.",
          selected: false,
          rejection_reason: "subsumed_by_tactical",
        },
        {
          lane: "no_memory",
          lesson: "Not self-documenting.",
          evidence: "Reviewer feedback makes this reusable.",
          selected: false,
          rejection_reason: "A memory was selected.",
        },
      ],
      memory_review: [],
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const result = await analyzeSessionForMemories(
      "sk-openai",
      baseReviewFeedback(),
      baseContext(),
      createLogger() as never,
    );

    const subsumed = result.suggestions.candidate_audit.filter((entry) =>
      (entry.rejection_reason ?? "").startsWith("subsumed_by_"),
    );
    expect(subsumed.map((entry) => entry.lane)).toEqual(["strategic", "gotcha"]);
    expect(subsumed.every((entry) => entry.selected === false)).toBe(true);
  });

  it("returns empty result when structured output has empty arrays", async () => {
    mockAnalyzerStructuredOutput({
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const result = await analyzeSessionForMemories(
      "sk-openai",
      baseReviewFeedback(),
      baseContext(),
      createLogger() as never,
    );

    expect(result.suggestions.add).toHaveLength(0);
    expect(result.suggestions.update).toHaveLength(0);
    expect(result.suggestions.remove).toHaveLength(0);
    expect(result.suggestions.convention_updates).toHaveLength(0);
    expect(result.suggestions.episode_summary).toMatchObject({ source_pr: baseEpisodeSummary.source_pr });
    expect(result.suggestions.candidate_audit.map((entry) => entry.lane)).toEqual([
      "strategic",
      "tactical",
      "gotcha",
      "no_memory",
    ]);
  });

  it("preserves candidate audit when no memory is selected", async () => {
    mockQueryOpenAIStructuredOutput.mockResolvedValueOnce(baseEpisodeSummary).mockResolvedValueOnce({
      episode_summary: baseEpisodeSummary,
      candidate_audit: [
        {
          lane: "strategic",
          lesson: "No durable repo direction emerged.",
          evidence: "The PR only adjusted a local helper.",
          selected: false,
          rejection_reason: "No source-of-truth or boundary lesson.",
        },
        {
          lane: "tactical",
          lesson: "No reusable procedure emerged.",
          evidence: "The implementation was local.",
          selected: false,
          rejection_reason: "Too narrow.",
        },
        {
          lane: "gotcha",
          lesson: "No surprising failure mode emerged.",
          evidence: "The bug was visible from the code.",
          selected: false,
          rejection_reason: "Not surprising.",
        },
        {
          lane: "no_memory",
          lesson: "Do not create memory for self-documenting local fixes.",
          evidence: "The diff shows the full behavior.",
          selected: true,
          rejection_reason: null,
        },
      ],
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
      memory_review: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const result = await analyzeSessionForMemories(
      "sk-openai",
      baseReviewFeedback(),
      baseContext(),
      createLogger() as never,
    );

    expect(result.suggestions.add).toEqual([]);
    expect(result.suggestions.candidate_audit).toContainEqual(
      expect.objectContaining({ lane: "no_memory", selected: true }),
    );
  });

  it("does not synthesize memories from selected audit lanes without real outputs", async () => {
    mockQueryOpenAIStructuredOutput.mockResolvedValueOnce(baseEpisodeSummary).mockResolvedValueOnce({
      episode_summary: baseEpisodeSummary,
      candidate_audit: [
        {
          lane: "strategic",
          lesson: "Route ownership belongs in the control-plane service layer.",
          evidence: "The PR touched route and service boundaries.",
          selected: true,
          rejection_reason: null,
        },
      ],
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
      memory_review: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const result = await analyzeSessionForMemories(
      "sk-openai",
      baseReviewFeedback(),
      baseContext(),
      createLogger() as never,
    );

    expect(result.suggestions.candidate_audit).toContainEqual(
      expect.objectContaining({ lane: "strategic", selected: true }),
    );
    expect(result.suggestions.add).toEqual([]);
    expect(result.suggestions.update).toEqual([]);
    expect(result.suggestions.remove).toEqual([]);
  });

  it("preserves update metadata when semantic_update is null", async () => {
    mockAnalyzerStructuredOutput({
      add: [],
      update: [
        {
          id: "mem_existing",
          semantic_update: null,
          content: "Use the updated workflow.",
          context_hint: "When changing the workflow",
          referenced_files: ["src/workflow.ts"],
          rationale: "Tighten the existing guidance without changing classification.",
        },
      ],
      remove: [],
      convention_updates: [],
      memory_review: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const result = await analyzeSessionForMemories(
      "sk-openai",
      baseReviewFeedback(),
      baseContext({
        getExistingMemories: async () => [
          {
            id: "mem_existing",
            type: "action",
            content: "Use the workflow.",
            context_hint: "When changing the workflow",
            referenced_files: JSON.stringify(["src/workflow.ts"]),
          },
        ],
      }),
      createLogger() as never,
    );

    expect(result.suggestions.update).toEqual([
      {
        id: "mem_existing",
        content: "Use the updated workflow.",
        context_hint: "When changing the workflow",
        referenced_files: ["src/workflow.ts"],
        rationale: "Tighten the existing guidance without changing classification.",
      },
    ]);
  });

  it("surfaces API errors instead of treating them as no suggestions", async () => {
    mockQueryOpenAIStructuredOutput.mockRejectedValueOnce(new Error("Internal server error"));

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const log = createLogger();
    const result = await analyzeSessionForMemories("sk-openai", baseReviewFeedback(), baseContext(), log as never);

    expect(result.suggestions.add).toHaveLength(0);
    expect(result.analysisError).toBe("Error: Internal server error");
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Error: Internal server error" }),
      "Memory analysis failed",
    );
  });

  it("continues when context prefetch fails", async () => {
    mockAnalyzerStructuredOutput({
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const ctx = baseContext({
      getPrDiff: vi.fn().mockRejectedValue(new Error("GitHub API error")),
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const log = createLogger();
    const result = await analyzeSessionForMemories("sk-openai", baseReviewFeedback(), ctx, log as never);

    expect(result.toolErrorCount).toBe(1);
    expect(result.toolCallCount).toBe(3);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Error: GitHub API error" }),
      "Failed to load PR diff for memory analysis",
    );
  });

  it("counts failed context fetches as tool calls", async () => {
    mockAnalyzerStructuredOutput({
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const ctx = baseContext({
      getSessionPrompts: vi.fn().mockRejectedValue(new Error("prompts unavailable")),
      getExistingMemories: vi.fn().mockRejectedValue(new Error("memories unavailable")),
      getPrDiff: vi.fn().mockRejectedValue(new Error("diff unavailable")),
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const result = await analyzeSessionForMemories("sk-openai", baseReviewFeedback(), ctx, createLogger() as never);

    expect(result.toolCallCount).toBe(3);
    expect(result.toolErrorCount).toBe(3);
  });

  it("filters invalid suggestions from structured output", async () => {
    mockAnalyzerStructuredOutput({
      add: [
        {
          type: "gotcha",
          memory_type: "action",
          action_type: "procedure",
          level: "gotcha",
          primitive: "gotcha",
          engineering_domains: ["code_structure"],
          subjects: [],
          symbols: [],
          tags: ["gotcha"],
          confidence: "medium",
          authority: "reviewed",
          enforcement: "none",
          triggers: null,
          supersedes: [],
          contradicts: [],
          content: "Valid memory content",
          context_hint: "When doing X",
          referenced_files: ["src/foo.ts"],
          rationale: "Good reason",
        },
        {
          type: "gotcha",
          context_hint: "When doing Y",
          referenced_files: [],
          rationale: "Missing content",
        },
      ],
      update: [],
      remove: [],
      convention_updates: [
        {
          target_file: "docs/conventions.md",
          section_heading: "Existing Section",
          content: "New rule.",
          rationale: "Good reason",
        },
        {
          target_file: "docs/nonexistent.md",
          section_heading: "Fake Section",
          content: "Rule.",
          rationale: "Bad file",
        },
      ],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const result = await analyzeSessionForMemories(
      "sk-openai",
      baseReviewFeedback(),
      baseContext(),
      createLogger() as never,
    );

    expect(result.suggestions.add).toHaveLength(1);
    expect(result.suggestions.add[0].content).toBe("Valid memory content");
    expect(result.suggestions.convention_updates).toHaveLength(1);
    expect(result.suggestions.convention_updates[0].target_file).toBe("docs/conventions.md");
  });

  it("rejects malformed Memory 2.0 metadata instead of falling back to legacy defaults", async () => {
    mockAnalyzerStructuredOutput({
      add: [
        {
          type: "gotcha",
          memory_type: "factual",
          action_type: null,
          level: "gotcha",
          primitive: "gotcha",
          engineering_domains: ["code_structure"],
          subjects: [],
          symbols: [],
          tags: ["gotcha"],
          confidence: "medium",
          authority: "reviewed",
          enforcement: "none",
          triggers: null,
          supersedes: [],
          contradicts: [],
          content: "This should be rejected because factual memories cannot use the gotcha primitive.",
          context_hint: "When checking invalid generated memory metadata",
          referenced_files: ["src/foo.ts"],
          rationale: "Invalid primitive combination",
        },
        {
          type: "process",
          memory_type: "action",
          action_type: "trigger",
          level: "tactical",
          primitive: "trigger",
          engineering_domains: ["developer_workflow"],
          subjects: ["workflow"],
          symbols: [],
          tags: ["trigger"],
          confidence: "high",
          authority: "reviewed",
          enforcement: "warn",
          triggers: {
            tools: [],
            path_globs: ["apps/**/*.ts"],
            command_patterns: [],
            forbidden_patterns: [],
            mcp_tools: [],
          },
          supersedes: [],
          contradicts: [],
          content: "Valid trigger memory content",
          context_hint: "When a workflow trigger applies",
          referenced_files: ["apps/control-plane-worker/src/foo.ts"],
          rationale: "Valid action trigger metadata",
        },
      ],
      update: [],
      remove: [],
      convention_updates: [],
      candidate_audit: [
        {
          lane: "strategic",
          lesson: "No strategic lesson.",
          evidence: "Invalid generated metadata.",
          selected: false,
          rejection_reason: "No strategic memory selected.",
        },
        {
          lane: "tactical",
          lesson: "Valid workflow trigger memory.",
          evidence: "The valid generated memory uses action/trigger metadata.",
          selected: true,
          rejection_reason: null,
        },
        {
          lane: "gotcha",
          lesson: "Invalid gotcha metadata was rejected.",
          evidence: "Factual memories cannot use gotcha primitive.",
          selected: false,
          rejection_reason: "Generated metadata was invalid.",
        },
        {
          lane: "no_memory",
          lesson: "A memory is not needed.",
          evidence: "A valid tactical memory was selected.",
          selected: false,
          rejection_reason: "A tactical memory was selected.",
        },
      ],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const result = await analyzeSessionForMemories(
      "sk-openai",
      baseReviewFeedback(),
      baseContext(),
      createLogger() as never,
    );

    expect(result.suggestions.add).toHaveLength(1);
    expect(result.suggestions.add[0]).toMatchObject({
      memory_type: "action",
      action_type: "trigger",
      primitive: "trigger",
      enforcement: "warn",
      content: "Valid trigger memory content",
    });
  });

  it("derives legacy display type from Memory 2.0 metadata", async () => {
    mockAnalyzerStructuredOutput({
      add: [
        {
          type: "gotcha",
          memory_type: "factual",
          action_type: null,
          level: "strategic",
          primitive: "claim",
          engineering_domains: ["code_structure"],
          subjects: ["memory"],
          symbols: [],
          tags: ["strategy"],
          confidence: "medium",
          authority: "reviewed",
          enforcement: "none",
          triggers: null,
          supersedes: [],
          contradicts: [],
          content: "Use the repo memory source of truth for memory generation pipeline decisions.",
          context_hint: "When changing repo memory generation",
          referenced_files: ["apps/control-plane-worker/src/memory/analyzer.ts"],
          rationale: "The Memory 2.0 level should override the stale legacy bucket.",
        },
      ],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const result = await analyzeSessionForMemories(
      "sk-openai",
      baseReviewFeedback(),
      baseContext(),
      createLogger() as never,
    );

    expect(result.suggestions.add[0]).toMatchObject({
      type: "architecture",
      memory_type: "factual",
      level: "strategic",
    });
  });

  it("passes review feedback and session context in the user prompt", async () => {
    mockAnalyzerStructuredOutput({
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    await analyzeSessionForMemories("sk-openai", baseReviewFeedback(), baseContext(), createLogger() as never);

    expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledTimes(2);
    const callArgs = mockQueryOpenAIStructuredOutput.mock.calls[1][0] as { userPrompt: string };

    expect(callArgs.userPrompt).toContain("@reviewer");
    expect(callArgs.userPrompt).toContain("Handle the case where user is undefined");
    expect(callArgs.userPrompt).toContain("sess-1");
    expect(callArgs.userPrompt).toContain("src/router.ts:42");
    expect(callArgs.userPrompt).toContain("Return empty arrays");
  });

  it("handles merge-triggered analysis with empty reviewer and no comments", async () => {
    mockAnalyzerStructuredOutput({
      add: [],
      update: [],
      remove: [],
      convention_updates: [],
    });

    const mergeFeedback: ReviewFeedback = {
      reviewBody: null,
      comments: [],
      reviewAuthor: "",
      reviewState: "merged",
    };

    const { analyzeSessionForMemories } = await import("../../apps/control-plane-worker/src/memory/analyzer");
    const result = await analyzeSessionForMemories("sk-openai", mergeFeedback, baseContext(), createLogger() as never);

    const callArgs = mockQueryOpenAIStructuredOutput.mock.calls[1][0] as { userPrompt: string };

    expect(callArgs.userPrompt).not.toContain("@");
    expect(callArgs.userPrompt).not.toContain("Review Comments on PR");
    expect(callArgs.userPrompt).toContain("sess-1");
    expect(callArgs.userPrompt).toContain("#123");
    expect(callArgs.userPrompt).toContain("just merged");
  });
});
