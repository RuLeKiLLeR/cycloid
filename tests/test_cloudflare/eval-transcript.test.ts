import { describe, expect, it } from "vitest";

type TranscriptModule = {
  buildSessionTranscript: (exportData: {
    session: { id: string; status: string; repoUrl: string | null; createdAt: string; closedAt: string | null };
    prompts: Array<{
      id: string;
      prompt: string;
      status: string;
      createdAt: string;
      startedAt: string | null;
      completedAt: string | null;
    }>;
    events: Array<{ type: string; timestamp: string; data: Record<string, unknown> }>;
    tokens: { inputTokens: number; outputTokens: number; totalTokens: number };
    stats: {
      totalPrompts: number;
      successCount: number;
      failCount: number;
      totalToolCalls: number;
      totalDurationMs: number;
    };
  }) => { transcript: string; sizeBytes: number };
};

const baseExport = {
  session: {
    id: "sess-1",
    status: "active",
    repoUrl: "https://github.com/org/repo",
    createdAt: "2024-01-01T00:00:00Z",
    closedAt: null,
  },
  prompts: [
    {
      id: "p1",
      prompt: "Fix the login bug",
      status: "completed",
      createdAt: "2024-01-01T00:00:00Z",
      startedAt: "2024-01-01T00:00:01Z",
      completedAt: "2024-01-01T00:01:00Z",
    },
    {
      id: "p2",
      prompt: "Add tests for the fix",
      status: "completed",
      createdAt: "2024-01-01T00:01:00Z",
      startedAt: "2024-01-01T00:01:01Z",
      completedAt: "2024-01-01T00:02:30Z",
    },
  ],
  events: [
    { type: "tool_call", timestamp: "2024-01-01T00:00:05Z", data: { tool: "Read", summary: "Read src/auth.ts" } },
    { type: "tool_call", timestamp: "2024-01-01T00:00:10Z", data: { tool: "Grep", summary: "Grep redirectUrl" } },
    { type: "tool_call", timestamp: "2024-01-01T00:00:20Z", data: { tool: "Edit", summary: "Edit src/auth.ts" } },
    { type: "tool_call", timestamp: "2024-01-01T00:00:30Z", data: { tool: "Bash", summary: "npm test" } },
    { type: "text", timestamp: "2024-01-01T00:00:35Z", data: { text: "streaming content" } },
    { type: "token", timestamp: "2024-01-01T00:00:40Z", data: { inputTokens: 100, outputTokens: 50 } },
    { type: "prompt_completed", timestamp: "2024-01-01T00:01:00Z", data: { promptId: "p1" } },
    {
      type: "tool_call",
      timestamp: "2024-01-01T00:01:10Z",
      data: { tool: "Write", summary: "Write tests/auth.test.ts" },
    },
    { type: "tool_call", timestamp: "2024-01-01T00:01:20Z", data: { tool: "Bash", summary: "npm test" } },
  ],
  tokens: { inputTokens: 45000, outputTokens: 12000, totalTokens: 57000 },
  stats: { totalPrompts: 2, successCount: 2, failCount: 0, totalToolCalls: 6, totalDurationMs: 150000 },
};

describe("eval/transcript", () => {
  let mod: TranscriptModule;

  it("loads the module", async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/eval/transcript";
    mod = (await import(modulePath)) as unknown as TranscriptModule;
  });

  it("produces readable markdown with all sections", () => {
    const { transcript, sizeBytes } = mod.buildSessionTranscript(baseExport);

    // Header
    expect(transcript).toContain("# Session Transcript");

    // Session info
    expect(transcript).toContain("sess-1");
    expect(transcript).toContain("https://github.com/org/repo");
    expect(transcript).toContain("2m 30s");

    // Prompts
    expect(transcript).toContain("## Prompts");
    expect(transcript).toContain("Fix the login bug");
    expect(transcript).toContain("Add tests for the fix");
    expect(transcript).toContain("completed");

    // Tool usage table
    expect(transcript).toContain("## Tool Usage Summary");
    expect(transcript).toContain("| Read | 1 |");
    expect(transcript).toContain("| Bash | 2 |");
    expect(transcript).toContain("| Edit | 1 |");

    // Token usage
    expect(transcript).toContain("45,000");
    expect(transcript).toContain("12,000");

    // Timeline — includes tool_call and prompt_completed but not text/token
    expect(transcript).toContain("## Event Timeline");
    expect(transcript).toContain("**Read** Read src/auth.ts");
    expect(transcript).toContain("**Edit** Edit src/auth.ts");
    expect(transcript).toContain("**Prompt completed**");
    expect(transcript).not.toContain("streaming content");

    expect(sizeBytes).toBeGreaterThan(0);
  });

  it("handles empty events gracefully", () => {
    const empty = { ...baseExport, events: [], prompts: [] };
    const { transcript } = mod.buildSessionTranscript(empty);
    expect(transcript).toContain("# Session Transcript");
    expect(transcript).toContain("No tool calls recorded");
    expect(transcript).toContain("No events recorded");
  });

  it("includes compact memory retrieval trace summaries for eval review", () => {
    const { transcript } = mod.buildSessionTranscript({
      ...baseExport,
      events: [
        {
          type: "memory_recall_usage",
          timestamp: "2024-01-01T00:00:10Z",
          data: {
            intent: "Patch auth route",
            returnedMemoryIds: [],
            retrievalTrace: {
              retrievalConfigVersion: "repo-memory-denoise-v1-explicit-recall",
              candidateCount: 2,
              selectedCount: 0,
              returnedEmpty: true,
              rejectedCandidates: [
                { memoryId: "mem-a", rejectReason: "llm_omitted" },
                { memoryId: "mem-b", rejectReason: "below_score_threshold" },
              ],
            },
          },
        },
      ],
    });

    expect(transcript).toContain("**Memory recall** (Patch auth route): 0 memories");
    expect(transcript).toContain("config=repo-memory-denoise-v1-explicit-recall");
    expect(transcript).toContain("candidates=2");
    expect(transcript).toContain("selected=0");
    expect(transcript).toContain("rejections=llm_omitted,below_score_threshold");
  });

  it("truncates long prompts", () => {
    const longPrompt = { ...baseExport, prompts: [{ ...baseExport.prompts[0], prompt: "x".repeat(5000) }] };
    const { transcript } = mod.buildSessionTranscript(longPrompt);
    // Prompt text is in a blockquote, should be truncated to 2000
    const promptSection = transcript.split("> ")[1]?.split("\n")[0] || "";
    expect(promptSection.length).toBeLessThanOrEqual(2000);
  });

  it("includes error events in timeline", () => {
    const withErrors = {
      ...baseExport,
      events: [
        { type: "session_error", timestamp: "2024-01-01T00:00:05Z", data: { error: "Something broke" } },
        { type: "question", timestamp: "2024-01-01T00:00:10Z", data: { question: "Should I proceed?" } },
      ],
    };
    const { transcript } = mod.buildSessionTranscript(withErrors);
    expect(transcript).toContain("**Error**: Something broke");
    expect(transcript).toContain("**Question asked**: Should I proceed?");
  });
});
