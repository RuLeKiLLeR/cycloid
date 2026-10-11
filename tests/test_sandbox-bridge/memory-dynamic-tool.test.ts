import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSessionStaticBehavioralGuidance } from "../../apps/sandbox-bridge/src/constants/bridge";
import {
  buildAllDynamicToolSpecs,
  executeFirstPartyDynamicToolCall,
} from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools";
import {
  executeMemoryContextDynamicToolCall,
  executeMemoryRecallDynamicToolCall,
  MEMORY_RECALL_TIMEOUT_MS,
} from "../../apps/sandbox-bridge/src/services/memory-dynamic-tool";

let repoPath: string | null = null;

afterEach(() => {
  if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  repoPath = null;
});

function writeMemory(path: string, id: string, body: string, extra = ""): void {
  const dir = join(path, ".cycloid", "memory", "engineering", "action", "procedures");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    [
      "---",
      `id: ${id}`,
      "vertical: engineering",
      "memory_type: action",
      "action_type: procedure",
      "level: tactical",
      "primitive: procedure",
      "engineering_domains:",
      "  - security",
      "status: active",
      "confidence: high",
      "authority: reviewed",
      "applies_to:",
      "  - apps/control-plane-worker/src/auth/**",
      "context_hint: When touching auth",
      "source_pr_urls: []",
      "source_session_ids: []",
      "evidence: []",
      "enforcement: none",
      "supersedes: []",
      "contradicts: []",
      "created_at: 2026-05-12",
      "updated_at: 2026-05-12",
      extra,
      "---",
      "",
      body,
    ]
      .filter((line) => line !== "")
      .join("\n"),
    "utf-8",
  );
}

describe("cycloid.memory_recall dynamic tool", () => {
  it("uses the memory selector budget for control-plane recall requests", () => {
    expect(MEMORY_RECALL_TIMEOUT_MS).toBe(25_000);
  });

  it("is not advertised or callable without the memory tools capability env", async () => {
    const env = {
      CONTROL_PLANE_URL: "https://cp.example.test",
      SANDBOX_AUTH_TOKEN: "sandbox-token",
      SESSION_ID: "sess-1",
    };

    expect(buildAllDynamicToolSpecs(env).map((tool) => `${tool.namespace}.${tool.name}`)).not.toContain(
      "cycloid.memory_recall",
    );
    expect(buildAllDynamicToolSpecs(env).map((tool) => `${tool.namespace}.${tool.name}`)).not.toContain(
      "cycloid.memory_context",
    );
    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "memory_recall",
        { intent: "Change auth checks", files: ["apps/control-plane-worker/src/auth/routes.ts"] },
        { env },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "not_registered",
      contentItems: [
        {
          text:
            "First-party dynamic tool 'cycloid.memory_recall' is not registered for this session.\n\n" +
            "Recovery: This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
        },
      ],
    });
    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "memory_context",
        { intent: "Change auth checks", files: ["apps/control-plane-worker/src/auth/routes.ts"] },
        { env },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "not_registered",
      contentItems: [
        {
          text:
            "First-party dynamic tool 'cycloid.memory_context' is not registered for this session.\n\n" +
            "Recovery: This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
        },
      ],
    });
    await expect(
      executeFirstPartyDynamicToolCall("cycloid", "company_memory_recall", { intent: "Recall Acme context" }, { env }),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "not_registered",
      contentItems: [
        {
          text:
            "First-party dynamic tool 'cycloid.company_memory_recall' is not registered for this session.\n\n" +
            "Recovery: This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
        },
      ],
    });
  });

  it("is advertised when the memory tools capability env is present", () => {
    const env = {
      CONTROL_PLANE_URL: "https://cp.example.test",
      SANDBOX_AUTH_TOKEN: "sandbox-token",
      SESSION_ID: "sess-1",
      ARCANIST_MEMORY_TOOLS_ENABLED: "1",
    };

    expect(buildAllDynamicToolSpecs(env).map((tool) => `${tool.namespace}.${tool.name}`)).toContain(
      "cycloid.memory_recall",
    );
    expect(buildAllDynamicToolSpecs(env).map((tool) => `${tool.namespace}.${tool.name}`)).toContain(
      "cycloid.memory_context",
    );
  });
});

describe("cycloid.memory_recall dynamic tool implementation while registry-disabled", () => {
  it("uses a small LLM prediction to return bounded matching memories", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-recall-"));
    writeMemory(repoPath, "mem-auth", "Use the auth service boundary.");

    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://cp.example.test/api/sessions/sess-1/sandbox/memory/context");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ mode: "repo", maxMemories: 5 });
      expect(body).not.toHaveProperty("reasoningLevel");
      expect(body.memories[0]).toMatchObject({ id: "mem-auth", candidate_channels: ["path_match"] });
      return new Response(
        JSON.stringify({
          ok: true,
          traceId: "trace-1",
          repoRankings: [{ id: "mem-auth", score: 0.94 }],
          retrievalTrace: {
            retrievalConfigVersion: "repo-memory-denoise-v1-explicit-recall",
            selectedCandidates: [{ memoryId: "mem-auth" }],
            rejectedCandidates: [],
          },
        }),
      );
    });
    const telemetry = vi.fn();

    await expect(
      executeMemoryRecallDynamicToolCall(
        { intent: "Change auth checks", files: ["apps/control-plane-worker/src/auth/routes.ts"] },
        {
          cwd: repoPath,
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          recordTelemetry: telemetry,
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining("mem-auth") }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(
      "memory_recall.returned",
      expect.objectContaining({
        requestedMemoryIds: ["mem-auth"],
        returnedMemoryIds: ["mem-auth"],
        intent: "Change auth checks",
        files: ["apps/control-plane-worker/src/auth/routes.ts"],
        symbols: [],
        tool: null,
        retrievalTrace: expect.objectContaining({
          retrievalConfigVersion: "repo-memory-denoise-v1-explicit-recall",
        }),
      }),
    );
  });

  it("returns the canonical memory_context block with trace id and provenance", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            traceId: "trace-context-1",
            memories: [
              {
                id: "conclusion-acme",
                kind: "derived_conclusion",
                content: "Acme requires SOC2 evidence.",
                level: "deductive",
                whyReturned: "selected_by_company_memory_context",
                confidence: "high",
                enforcement: "none",
                provenance: [
                  { sourceKind: "memory_conclusion", sourceId: "conclusion-acme", excerpt: "slack://T/C/1" },
                ],
              },
            ],
            repoRankings: [],
          }),
        ),
    );

    await expect(
      executeMemoryContextDynamicToolCall(
        { intent: "Acme onboarding", maxMemories: 3 },
        {
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [
        {
          text: expect.stringMatching(
            /<cycloid_memory_context trace_id="trace-context-1">[\s\S]*<memory id="conclusion-acme" kind="derived_conclusion" confidence="high" enforcement="none" level="deductive">[\s\S]*<source kind="memory_conclusion" id="conclusion-acme">slack:\/\/T\/C\/1<\/source>/,
          ),
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cp.example.test/api/sessions/sess-1/sandbox/memory/context",
      expect.objectContaining({
        body: expect.stringContaining('"mode":"all"'),
      }),
    );
  });

  it("attributes company facts/takes to company_recall usage instead of repo recall", async () => {
    const telemetry = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            traceId: "trace-split-1",
            memories: [
              {
                id: "repo-rule-1",
                kind: "repo_rule",
                content: "Routes call services before DAO functions.",
                whyReturned: "selected",
                confidence: "high",
                enforcement: "none",
                provenance: [{ sourceKind: "repo_memory", sourceId: "repo-rule-1", excerpt: null }],
              },
              {
                id: "company-fact-1",
                kind: "company_fact",
                content: "Acme is on the enterprise plan.",
                whyReturned: "selected",
                confidence: "high",
                enforcement: "none",
                provenance: [{ sourceKind: "company_fact", sourceId: "company-fact-1", excerpt: null }],
              },
              {
                id: "company-take-1",
                kind: "company_take",
                content: "Prefer async escalation for Acme.",
                whyReturned: "selected",
                confidence: "medium",
                enforcement: "none",
                provenance: [{ sourceKind: "company_take", sourceId: "company-take-1", excerpt: null }],
              },
            ],
            repoRankings: [],
          }),
        ),
    );

    await executeMemoryContextDynamicToolCall(
      { intent: "Acme onboarding", maxMemories: 5 },
      {
        env: {
          CONTROL_PLANE_URL: "https://cp.example.test",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
          SESSION_ID: "sess-1",
        },
        fetchImpl: fetchImpl as never,
        recordTelemetry: telemetry,
      },
    );

    const returnedEvents = telemetry.mock.calls.filter(([name]) => name === "memory_context.returned");
    expect(returnedEvents).toHaveLength(2);
    const repoEvent = returnedEvents.find(
      ([, fields]) => (fields as { usageSource: string }).usageSource === "recall",
    )?.[1] as Record<string, unknown>;
    const companyEvent = returnedEvents.find(
      ([, fields]) => (fields as { usageSource: string }).usageSource === "company_recall",
    )?.[1] as Record<string, unknown>;
    expect(repoEvent).toBeDefined();
    expect(companyEvent).toBeDefined();
    expect(repoEvent.returnedMemoryIds).toEqual(["repo-rule-1"]);
    expect(companyEvent.returnedMemoryIds).toEqual(["company-fact-1", "company-take-1"]);
    // Ranks are preserved from the combined selection order.
    expect(companyEvent.returnedMemories).toEqual([
      expect.objectContaining({ id: "company-fact-1", selectionRank: 2 }),
      expect.objectContaining({ id: "company-take-1", selectionRank: 3 }),
    ]);
    // The combined decision trace stays on the primary event only.
    expect(repoEvent.decisionTrace).toMatchObject({
      returnedIds: ["repo-rule-1", "company-fact-1", "company-take-1"],
    });
    expect(companyEvent.decisionTrace).toBeUndefined();
  });

  it("escapes quotes in memory_context attribute values to prevent XML attribute injection", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            traceId: "trace-quote-1",
            memories: [
              {
                id: 'mem"inject',
                kind: "repo_rule",
                content: "Escape everything.",
                whyReturned: "selected",
                confidence: "high",
                enforcement: "none",
                provenance: [{ sourceKind: 'slack"kind', sourceId: 'id"1', excerpt: null }],
              },
            ],
            repoRankings: [],
          }),
        ),
    );

    const result = await executeMemoryContextDynamicToolCall(
      { intent: "Injection check", maxMemories: 3 },
      {
        env: {
          CONTROL_PLANE_URL: "https://cp.example.test",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
          SESSION_ID: "sess-1",
        },
        fetchImpl: fetchImpl as never,
      },
    );
    const text = result.contentItems[0]?.text ?? "";
    expect(text).toContain('id="mem&quot;inject"');
    expect(text).toContain('kind="slack&quot;kind" id="id&quot;1"');
    // No raw quote breaks out of an attribute value.
    expect(text).not.toContain('id="mem"inject"');
  });

  it("keeps a genuine empty result distinct from an outage", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, traceId: "trace-real-empty", memories: [], repoRankings: [] })),
    );
    const result = await executeMemoryContextDynamicToolCall(
      { intent: "Nothing relevant", maxMemories: 3 },
      {
        env: {
          CONTROL_PLANE_URL: "https://cp.example.test",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
          SESSION_ID: "sess-1",
        },
        fetchImpl: fetchImpl as never,
      },
    );
    const text = result.contentItems[0]?.text ?? "";
    expect(text).toContain("<empty>No memory was selected for this request.</empty>");
    expect(text).not.toContain("temporarily unavailable");
  });

  it("does not treat 'expr 123' as a source PR reference but does treat 'pr 123'", async () => {
    const memory = {
      id: "mem-pr-123",
      status: "active",
      memory_type: "action",
      type: "action",
      confidence: "high",
      enforcement: "none",
      context_hint: "Source PR 123 memory.",
      content: "Source PR 123 memory.",
      applies_to: [],
      sourcePrNumber: 123,
    } as never;

    async function channelsFor(intent: string): Promise<string[]> {
      let captured: string[] = [];
      const fetchImpl = vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        captured = body.memories[0]?.candidate_channels ?? [];
        return new Response(JSON.stringify({ ok: true, traceId: "t", repoRankings: [] }));
      });
      await executeMemoryRecallDynamicToolCall(
        { intent },
        {
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          repoMemories: [memory],
          fetchImpl: fetchImpl as never,
        },
      );
      return captured;
    }

    expect(await channelsFor("Refactor the expr 123 helper")).not.toContain("source_pr_match");
    expect(await channelsFor("Verify pr 123 after review")).toContain("source_pr_match");
  });

  it("does not match a same-number memory from a different repository URL", async () => {
    const memory = {
      id: "mem-pr-123-cross-repo",
      status: "active",
      memory_type: "action",
      type: "action",
      confidence: "high",
      enforcement: "none",
      context_hint: "Source PR 123 memory.",
      content: "Source PR 123 memory.",
      applies_to: [],
      sourcePrNumber: 123,
    } as never;
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.memories[0].candidate_channels).not.toContain("source_pr_match");
      return new Response(JSON.stringify({ ok: true, traceId: "t", repoRankings: [] }));
    });

    await executeMemoryRecallDynamicToolCall(
      { intent: "Review https://github.com/other/repo/pull/123 and compare it with PR #123." },
      {
        env: {
          CONTROL_PLANE_URL: "https://cp.example.test",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
          SESSION_ID: "sess-1",
          REPO_OWNER: "trycycloid",
          REPO_NAME: "cycloid",
        },
        repoMemories: [memory],
        fetchImpl: fetchImpl as never,
      },
    );
  });

  it("keeps the path-specificity bonus for applies_to globs ending in /*", async () => {
    let orderedIds: string[] = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      orderedIds = body.memories.map((memory: { id: string }) => memory.id);
      return new Response(JSON.stringify({ ok: true, traceId: "t", repoRankings: [] }));
    });
    const specific = {
      id: "mem-specific",
      status: "active",
      memory_type: "action",
      type: "action",
      confidence: "high",
      enforcement: "none",
      context_hint: "Specific glob.",
      content: "Specific glob.",
      applies_to: ["apps/foo/*"],
    } as never;
    const broad = {
      id: "mem-broad",
      status: "active",
      memory_type: "action",
      type: "action",
      confidence: "high",
      enforcement: "none",
      context_hint: "Broad glob.",
      content: "Broad glob.",
      applies_to: ["apps/**"],
    } as never;

    await executeMemoryRecallDynamicToolCall(
      { intent: "Edit apps/foo/bar.ts", files: ["apps/foo/bar.ts"] },
      {
        env: {
          CONTROL_PLANE_URL: "https://cp.example.test",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
          SESSION_ID: "sess-1",
        },
        repoMemories: [broad, specific],
        fetchImpl: fetchImpl as never,
      },
    );
    // The more specific `apps/foo/*` glob must outrank the broad `apps/**`.
    expect(orderedIds.indexOf("mem-specific")).toBeLessThan(orderedIds.indexOf("mem-broad"));
  });

  it("returns an auditable empty memory_context result when the control plane is unavailable", async () => {
    const telemetry = vi.fn();

    await expect(
      executeMemoryContextDynamicToolCall(
        {
          intent: "Verify and fix PR 4762 after the review loop",
          maxMemories: 3,
        },
        {
          env: {},
          repoMemories: [
            {
              id: "mem-pr-4762",
              status: "active",
              memory_type: "action",
              type: "action",
              level: "tactical",
              confidence: "high",
              enforcement: "none",
              context_hint: "Review-loop verification must wait for the PR state refresh.",
              content: "Refresh PR state before deciding whether review-loop verification is complete.",
              applies_to: ["apps/control-plane-worker/src/session/**"],
              sourcePrNumber: 4762,
            } as never,
            {
              id: "mem-unrelated",
              status: "active",
              memory_type: "action",
              type: "action",
              level: "tactical",
              confidence: "high",
              enforcement: "none",
              context_hint: "Unrelated memory.",
              content: "Unrelated memory.",
              applies_to: ["apps/ui/**"],
              sourcePrNumber: 1111,
            } as never,
          ],
          recordTelemetry: telemetry,
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [
        {
          text: expect.stringContaining('<cycloid_memory_context trace_id="unavailable">'),
        },
      ],
    });
    // The outage path must be distinguishable from a genuine empty result.
    const outageResult = await executeMemoryContextDynamicToolCall(
      { intent: "Verify and fix PR 4762 after the review loop", maxMemories: 3 },
      { env: {}, repoMemories: [], recordTelemetry: vi.fn() },
    );
    expect(outageResult.contentItems[0]?.text).toContain("<empty>Memory context is temporarily unavailable.</empty>");
    expect(outageResult.contentItems[0]?.text).not.toContain("No memory was selected");

    expect(telemetry).toHaveBeenCalledWith(
      "memory_context.returned",
      expect.objectContaining({
        requestedMemoryIds: ["mem-pr-4762"],
        returnedMemoryIds: [],
        retrievalTrace: expect.objectContaining({
          retrievalConfigVersion: "memory-context-compat-v1",
          vectorUnavailableReason: "control_plane_unavailable",
          candidates: [expect.objectContaining({ id: "mem-pr-4762" })],
          selectorStatus: "not_run",
        }),
        decisionTrace: expect.objectContaining({
          toolName: "cycloid.memory_context",
          traceId: "unavailable",
          candidateIds: ["mem-pr-4762"],
          returnedIds: [],
        }),
      }),
    );
  });

  it("does not call the legacy repo recall endpoint when memory_context fails", async () => {
    const telemetry = vi.fn();
    const fetchImpl = vi.fn(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/sandbox/memory/context")) {
        return new Response(JSON.stringify({ ok: false, error: "selector timed out" }), { status: 504 });
      }
      throw new Error(`Unexpected URL ${requestUrl}`);
    });

    await expect(
      executeMemoryContextDynamicToolCall(
        {
          intent: "Fix Datadog bridge log status misclassification",
          files: ["apps/sandbox-bridge/src/services/dd-logs.ts"],
          maxMemories: 3,
        },
        {
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          recordTelemetry: telemetry,
          repoMemories: [
            {
              id: "mem-pr-4862",
              status: "active",
              memory_type: "action",
              type: "action",
              confidence: "high",
              enforcement: "none",
              context_hint: "Datadog bridge log status mapping.",
              content: "Preserve explicit Datadog bridge log statuses when classifying delivery outcomes.",
              applies_to: ["apps/sandbox-bridge/src/services/dd-logs.ts"],
              sourcePrNumber: 4862,
            } as never,
            {
              id: "mem-pr-4817",
              status: "active",
              memory_type: "action",
              type: "action",
              confidence: "high",
              enforcement: "none",
              context_hint: "Different Datadog bridge change.",
              content: "Use the Datadog delivery helper for unrelated bridge logging paths.",
              applies_to: ["apps/sandbox-bridge/src/services/dd-logs.ts"],
              sourcePrNumber: 4817,
            } as never,
          ],
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining('<cycloid_memory_context trace_id="unavailable">') }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalledWith(
      expect.stringContaining("/sandbox/repo-memory/recall"),
      expect.anything(),
    );
    expect(telemetry).toHaveBeenCalledWith(
      "memory_context.returned",
      expect.objectContaining({
        requestedMemoryIds: ["mem-pr-4817", "mem-pr-4862"],
        returnedMemoryIds: [],
        retrievalTrace: expect.objectContaining({
          vectorUnavailableReason: "control_plane_unavailable",
          selectorStatus: "not_run",
        }),
        decisionTrace: expect.objectContaining({
          traceId: "unavailable",
          candidateIds: ["mem-pr-4817", "mem-pr-4862"],
          returnedIds: [],
        }),
      }),
    );
  });

  it("caps scored repo candidates sent to memory_context after evidence filtering", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, repoRankings: [], memories: [] })));
    const repoMemories = Array.from({ length: 45 }, (_, index) => ({
      id: `mem-local-${index}`,
      status: "active",
      memory_type: "action",
      type: "action",
      confidence: "high",
      enforcement: "none",
      context_hint: `Auth memory ${index}`,
      content: `Auth memory ${index}`,
      applies_to: ["apps/control-plane-worker/src/auth/**"],
      scope: "repo",
      referenced_files: null,
    }));
    repoMemories.push({
      id: "mem-d1-relevant",
      status: "active",
      memory_type: "action",
      type: "action",
      confidence: "high",
      enforcement: "none",
      context_hint: "D1 auth memory",
      content: "D1 auth memory",
      applies_to: ["apps/control-plane-worker/src/auth/**"],
      scope: "repo",
      referenced_files: null,
    });

    await expect(
      executeMemoryContextDynamicToolCall(
        {
          intent: "Change auth checks",
          files: ["apps/control-plane-worker/src/auth/routes.ts"],
          maxMemories: 3,
        },
        {
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          repoMemories: repoMemories as never,
          memoryRefById: new Map([["mem-d1-relevant", { id: "mem-d1-relevant", path: "d1:mem-d1-relevant" }]]),
        },
      ),
    ).resolves.toMatchObject({ success: true });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as { memories: Array<{ id: string }> };
    expect(body.memories).toHaveLength(40);
    expect(body.memories.map((memory) => memory.id)).toContain("mem-d1-relevant");
    expect(body.memories.map((memory) => memory.id)).not.toContain("mem-local-44");
  });

  it("does not give unscoped memories path-match credit in the recall candidate cap", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, repoRankings: [], memories: [] })));
    const unscoped = Array.from({ length: 45 }, (_, index) => ({
      id: `mem-unscoped-${index}`,
      status: "active",
      memory_type: "action",
      type: "action",
      confidence: "high",
      enforcement: "none",
      context_hint: `Broad rule ${index}`,
      content: `Broad rule ${index}`,
      applies_to: [],
      scope: "repo",
      referenced_files: null,
    }));
    const scoped = {
      ...unscoped[0],
      id: "mem-scoped",
      applies_to: ["apps/control-plane-worker/src/auth/**"],
    };

    await executeMemoryContextDynamicToolCall(
      { intent: "Change auth checks", files: ["apps/control-plane-worker/src/auth/routes.ts"], maxMemories: 3 },
      {
        env: {
          CONTROL_PLANE_URL: "https://cp.example.test",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
          SESSION_ID: "sess-1",
        },
        fetchImpl: fetchImpl as never,
        repoMemories: [...unscoped, scoped] as never,
      },
    );

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as {
      memories: Array<{ id: string; candidate_channels: string[] }>;
    };
    expect(body.memories).toEqual([expect.objectContaining({ id: "mem-scoped", candidate_channels: ["path_match"] })]);
  });

  it("keeps recall telemetry best-effort", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-recall-"));
    writeMemory(repoPath, "mem-auth", "Use the auth service boundary.");

    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, repoRankings: [{ id: "mem-auth", score: 0.94 }] })),
    );

    await expect(
      executeMemoryRecallDynamicToolCall(
        { intent: "Change auth checks", files: ["apps/control-plane-worker/src/auth/routes.ts"] },
        {
          cwd: repoPath,
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          recordTelemetry: () => {
            throw new Error("telemetry failed");
          },
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining("mem-auth") }],
    });
  });

  it("extracts concrete file paths from recall intent", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-recall-paths-"));
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.files).toEqual(["apps/control-plane-worker/src/session/prompt-queue.ts"]);
      expect(body.memories[0]).toMatchObject({
        id: "mem-prompt-queue",
        candidate_channels: expect.arrayContaining(["path_match"]),
      });
      return new Response(JSON.stringify({ ok: true, repoRankings: [{ id: "mem-prompt-queue", score: 0.91 }] }));
    });

    await expect(
      executeMemoryRecallDynamicToolCall(
        {
          intent: "Update apps/control-plane-worker/src/session/prompt-queue.ts so queued prompts preserve order.",
        },
        {
          cwd: repoPath,
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          repoMemories: [
            {
              id: "mem-prompt-queue",
              type: "procedure",
              memory_type: "action",
              action_type: "procedure",
              level: "tactical",
              primitive: "procedure",
              authority: "accepted",
              enforcement: "none",
              context_hint: "When changing queued prompt handling",
              applies_to: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
              content: "Prompt queue changes must preserve FIFO ordering across reconnects.",
            },
          ],
          memoryRefById: new Map([["mem-prompt-queue", { id: "mem-prompt-queue", path: "d1:mem-prompt-queue" }]]),
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining("mem-prompt-queue") }],
    });
  });

  it("recalls D1-backed memories from the bridge context when no memory files exist", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-recall-empty-"));
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.memories[0].id).toBe("mem-live-queue");
      expect(body.memories[0].candidate_channels).toEqual(expect.arrayContaining(["path_match", "symbol_match"]));
      return new Response(JSON.stringify({ ok: true, repoRankings: [{ id: "mem-live-queue", score: 0.92 }] }));
    });
    const telemetry = vi.fn();
    const fileBackedMemories = Array.from({ length: 45 }, (_, index) => ({
      id: `mem-file-${index}`,
      type: "procedure",
      memory_type: "action",
      action_type: "procedure",
      level: "tactical",
      primitive: "procedure",
      authority: "reviewed",
      enforcement: "none",
      context_hint: `File memory ${index}`,
      applies_to: [".cycloid/memory/**"],
      content: `File-backed memory ${index}`,
    }));

    await expect(
      executeMemoryRecallDynamicToolCall(
        { intent: "Plan a Cloudflare queue consumer", files: ["wrangler.toml"], symbols: ["queue"] },
        {
          cwd: repoPath,
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          recordTelemetry: telemetry,
          repoMemories: [
            ...fileBackedMemories,
            {
              id: "mem-live-queue",
              type: "procedure",
              memory_type: "action",
              action_type: "procedure",
              level: "tactical",
              primitive: "procedure",
              authority: "accepted",
              enforcement: "none",
              context_hint: "When adding Cloudflare queue consumers",
              applies_to: ["wrangler.toml", "apps/control-plane-worker/src/**"],
              content:
                "Add queue consumers through the shared queue dispatcher path and keep QA/prod bindings aligned.",
            },
          ],
          memoryRefById: new Map([
            [
              "mem-live-queue",
              {
                id: "mem-live-queue",
                path: "d1:mem-live-queue",
                title: "When adding Cloudflare queue consumers",
              },
            ],
          ]),
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining("mem-live-queue") }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(telemetry).toHaveBeenCalledWith(
      "memory_recall.returned",
      expect.objectContaining({
        requestedMemoryIds: expect.arrayContaining(["mem-live-queue"]),
        returnedMemoryIds: ["mem-live-queue"],
      }),
    );
  });

  it("orders D1-backed recall candidates by query evidence before applying the request cap", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-recall-order-"));
    let requestBody: {
      memories: Array<{ id: string; candidate_channels?: string[] }>;
    } | null = null;
    const fetchImpl = vi.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, repoRankings: [{ id: "mem-relevant-older", score: 0.94 }] }));
    });
    const noisyMemories = Array.from({ length: 45 }, (_, index) => ({
      id: `mem-noisy-${index}`,
      type: "procedure",
      memory_type: "action",
      action_type: "procedure",
      level: "tactical",
      primitive: "procedure",
      authority: "reviewed",
      enforcement: "none",
      context_hint: `Prompt queue noisy memory ${index}`,
      applies_to: ["apps/control-plane-worker/src/services"],
      content: "Prompt queue ordering update path keeps this as a broad text match.",
    }));

    await expect(
      executeMemoryRecallDynamicToolCall(
        {
          intent:
            "Fix prompt queue ordering in apps/control-plane-worker/src/session/prompt-queue.ts by updating enqueuePrompt.",
          files: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
          symbols: ["enqueuePrompt"],
        },
        {
          cwd: repoPath,
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          repoMemories: [
            ...noisyMemories,
            {
              id: "mem-relevant-older",
              type: "procedure",
              memory_type: "action",
              action_type: "procedure",
              level: "tactical",
              primitive: "procedure",
              authority: "accepted",
              enforcement: "none",
              context_hint: "Prompt queue ordering for enqueuePrompt",
              applies_to: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
              symbols: ["enqueuePrompt"],
              content: "When fixing prompt queue ordering, update enqueuePrompt and preserve FIFO ordering.",
            },
          ],
          memoryRefById: new Map([
            ["mem-relevant-older", { id: "mem-relevant-older", path: "d1:mem-relevant-older" }],
            ...noisyMemories.map((memory) => [memory.id, { id: memory.id, path: `d1:${memory.id}` }] as const),
          ]),
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining("mem-relevant-older") }],
    });
    expect(requestBody?.memories).toHaveLength(40);
    expect(requestBody?.memories[0]).toMatchObject({
      id: "mem-relevant-older",
      candidate_channels: ["path_match", "symbol_match", "text_retrieval"],
    });
    expect(requestBody?.memories.map((memory) => memory.id)).toContain("mem-relevant-older");
    expect(requestBody?.memories.map((memory) => memory.id)).not.toContain("mem-noisy-44");
  });

  it("routes live repo memory ranking through the control plane when sandbox auth is available", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-recall-proxy-"));
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe("https://cp.example.test/api/sessions/sess-1/sandbox/memory/context");
      return new Response(
        JSON.stringify({
          ok: true,
          repoRankings: [{ id: "mem-live-queue", score: 0.93, reason: "direct queue memory" }],
        }),
      );
    });

    await expect(
      executeMemoryRecallDynamicToolCall(
        { intent: "Plan a Cloudflare queue consumer", files: ["wrangler.toml"], symbols: ["queue"] },
        {
          cwd: repoPath,
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          repoMemories: [
            {
              id: "mem-live-queue",
              type: "procedure",
              memory_type: "action",
              action_type: "procedure",
              level: "tactical",
              primitive: "procedure",
              authority: "accepted",
              enforcement: "none",
              context_hint: "When adding Cloudflare queue consumers",
              applies_to: ["wrangler.toml"],
              content: "Queue consumers should use the shared dispatcher.",
            },
          ],
          memoryRefById: new Map([["mem-live-queue", { id: "mem-live-queue", path: "d1:mem-live-queue" }]]),
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining("mem-live-queue") }],
    });
  });

  it("includes memory triggers in the control-plane ranking payload", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-recall-triggers-"));
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.memories[0]).toMatchObject({
        id: "mem-tool-trigger",
        candidate_channels: expect.arrayContaining(["tool_trigger_match"]),
        triggers: {
          tools: ["braintrust.query_sql"],
          mcp_tools: ["braintrust.query_sql"],
        },
      });
      return new Response(JSON.stringify({ ok: true, repoRankings: [{ id: "mem-tool-trigger", score: 0.93 }] }));
    });

    await expect(
      executeMemoryRecallDynamicToolCall(
        { intent: "Inspect the failed run.", tool: "braintrust.query_sql" },
        {
          cwd: repoPath,
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          repoMemories: [
            {
              id: "mem-tool-trigger",
              type: "procedure",
              memory_type: "action",
              action_type: "procedure",
              level: "tactical",
              primitive: "procedure",
              authority: "accepted",
              enforcement: "none",
              context_hint: "When inspecting failed runs",
              triggers: {
                tools: ["braintrust.query_sql"],
                path_globs: [],
                command_patterns: [],
                forbidden_patterns: [],
                mcp_tools: ["braintrust.query_sql"],
              },
              content: "Use the saved Braintrust query pattern first.",
            },
          ],
          memoryRefById: new Map([["mem-tool-trigger", { id: "mem-tool-trigger", path: "d1:mem-tool-trigger" }]]),
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining("mem-tool-trigger") }],
    });
  });

  it("does not fall back to local keyword scoring when control-plane ranking is unavailable", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-recall-local-"));
    const fetchImpl = vi.fn();

    await expect(
      executeMemoryRecallDynamicToolCall(
        {
          intent: "Add a Cloudflare queue consumer in wrangler.toml",
          files: ["wrangler.toml"],
          symbols: ["queue consumer"],
        },
        {
          cwd: repoPath,
          env: {},
          fetchImpl: fetchImpl as never,
          repoMemories: [
            {
              id: "mem-live-queue",
              type: "procedure",
              memory_type: "action",
              action_type: "procedure",
              level: "tactical",
              primitive: "procedure",
              authority: "accepted",
              enforcement: "none",
              context_hint: "Queue consumer wiring in Cloudflare config",
              applies_to: ["wrangler.toml", "apps/control-plane-worker/src/**"],
              content: "Cloudflare queue consumers should use the shared control-plane queue entrypoint.",
            },
          ],
          memoryRefById: new Map([["mem-live-queue", { id: "mem-live-queue", path: "d1:mem-live-queue" }]]),
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: "No active repo memories met the relevance threshold for this request." }],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the small LLM judge for verifier intent without file or symbol hints", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-recall-verifier-"));
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            repoRankings: [
              { id: "mem-live-verifier-result-field-tactical", score: 0.93 },
              { id: "mem-live-verifier-readonly-strategic", score: 0.88 },
            ],
          }),
        ),
    );

    await expect(
      executeMemoryRecallDynamicToolCall(
        {
          intent:
            "Plan changing the QA verifier so its reconciled comment output preserves a new structured result field while keeping the verifier read-only.",
        },
        {
          cwd: repoPath,
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          repoMemories: [
            {
              id: "mem-live-verifier-result-field-tactical",
              type: "procedure",
              memory_type: "action",
              action_type: "procedure",
              level: "tactical",
              primitive: "procedure",
              authority: "accepted",
              enforcement: "none",
              context_hint:
                "Relevant whenever QA Tester outputs gain a new structured field that must remain visible after reconciliation or comment regeneration",
              applies_to: ["apps/control-plane-worker/src/session", "apps/sandbox-bridge/src/services"],
              content:
                "When adding a new verifier result field, thread it through parsing, head-freshness/draft reconciliation, post-execution rewrites, and managed verification comments in the same change.",
            },
            {
              id: "mem-live-verifier-readonly-strategic",
              type: "claim",
              memory_type: "factual",
              level: "strategic",
              primitive: "claim",
              authority: "accepted",
              enforcement: "none",
              context_hint: "When enforcing QA-only verifier behavior",
              applies_to: ["apps/sandbox-bridge/src/services"],
              content:
                "QA-only verifier policies must be enforced in code, not just in prompts, and verification runs that detect repo mutation should be downgraded to inconclusive no-change results.",
            },
          ],
          memoryRefById: new Map([
            [
              "mem-live-verifier-result-field-tactical",
              { id: "mem-live-verifier-result-field-tactical", path: "d1:mem-live-verifier-result-field-tactical" },
            ],
            [
              "mem-live-verifier-readonly-strategic",
              { id: "mem-live-verifier-readonly-strategic", path: "d1:mem-live-verifier-readonly-strategic" },
            ],
          ]),
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [
        {
          text: expect.stringContaining("mem-live-verifier-result-field-tactical"),
        },
      ],
    });
  });

  it("uses the small LLM judge to pick the specific Slack summary memory over adjacent comment memories", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-recall-slack-"));
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.intent).toBe(
        "Plan updating Slack session completion summaries after PR creation and comment regeneration, including mrkdwn links.",
      );
      expect(body.memories.map((memory: { id: string }) => memory.id)).toEqual([
        "mem-live-slack-summary-tactical",
        "mem-live-verifier-result-field-tactical",
      ]);
      return new Response(
        JSON.stringify({
          ok: true,
          repoRankings: [{ id: "mem-live-slack-summary-tactical", score: 0.94 }],
        }),
      );
    });

    const result = await executeMemoryRecallDynamicToolCall(
      {
        intent:
          "Plan updating Slack session completion summaries after PR creation and comment regeneration, including mrkdwn links.",
        files: [
          "apps/control-plane-worker/src/services/slack-summary.ts",
          "apps/control-plane-worker/src/session/verification.ts",
        ],
      },
      {
        cwd: repoPath,
        env: {
          CONTROL_PLANE_URL: "https://cp.example.test",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
          SESSION_ID: "sess-1",
        },
        fetchImpl: fetchImpl as never,
        repoMemories: [
          {
            id: "mem-live-slack-summary-tactical",
            type: "procedure",
            memory_type: "action",
            action_type: "procedure",
            level: "tactical",
            primitive: "procedure",
            authority: "accepted",
            enforcement: "none",
            context_hint: "Any pipeline that turns untrusted PR text or LLM output into Slack mrkdwn or Block Kit",
            applies_to: ["apps/control-plane-worker/src/services"],
            content:
              "When rendering model-generated Slack summaries, escape Slack control characters before any mrkdwn conversion, and only emit links built from guard-validated PR numbers.",
          },
          {
            id: "mem-live-verifier-result-field-tactical",
            type: "procedure",
            memory_type: "action",
            action_type: "procedure",
            level: "tactical",
            primitive: "procedure",
            authority: "accepted",
            enforcement: "none",
            context_hint:
              "Relevant whenever QA Tester outputs gain a new structured field that must remain visible after reconciliation or comment regeneration",
            applies_to: ["apps/control-plane-worker/src/session", "apps/sandbox-bridge/src/services"],
            content:
              "When adding a new verifier result field, thread it through parsing, head-freshness/draft reconciliation, post-execution rewrites, and managed verification comments in the same change.",
          },
        ],
        memoryRefById: new Map([
          [
            "mem-live-slack-summary-tactical",
            { id: "mem-live-slack-summary-tactical", path: "d1:mem-live-slack-summary-tactical" },
          ],
          [
            "mem-live-verifier-result-field-tactical",
            { id: "mem-live-verifier-result-field-tactical", path: "d1:mem-live-verifier-result-field-tactical" },
          ],
        ]),
      },
    );

    expect(result).toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining("mem-live-slack-summary-tactical") }],
    });
    expect(result.contentItems[0]?.text).not.toContain("mem-live-verifier-result-field-tactical");
  });
});

describe("cycloid company memory dynamic tools", () => {
  const env = {
    CONTROL_PLANE_URL: "https://control-plane.test/",
    SESSION_ID: "session-123",
    SANDBOX_AUTH_TOKEN: "sandbox-token",
    BUSINESS_ID: "biz-arcanist",
    ARCANIST_MEMORY_TOOLS_ENABLED: "1",
  };

  it("exposes company-memory tools only when the memory capability env is present", () => {
    expect(buildAllDynamicToolSpecs({}).map((tool) => `${tool.namespace}.${tool.name}`)).not.toContain(
      "cycloid.company_memory_recall",
    );
    expect(
      buildAllDynamicToolSpecs({
        CONTROL_PLANE_URL: "https://control-plane.test/",
        SESSION_ID: "session-123",
        SANDBOX_AUTH_TOKEN: "sandbox-token",
        BUSINESS_ID: "biz-customer",
      }).map((tool) => `${tool.namespace}.${tool.name}`),
    ).not.toContain("cycloid.company_memory_recall");
    expect(
      buildAllDynamicToolSpecs({
        CONTROL_PLANE_URL: "https://control-plane.test/",
        SESSION_ID: "session-123",
        SANDBOX_AUTH_TOKEN: "sandbox-token",
        BUSINESS_ID: "biz-customer",
        ARCANIST_MEMORY_TOOLS_ENABLED: "1",
      }).map((tool) => `${tool.namespace}.${tool.name}`),
    ).toContain("cycloid.company_memory_recall");

    expect(buildAllDynamicToolSpecs(env).map((tool) => `${tool.namespace}.${tool.name}`)).toEqual(
      expect.arrayContaining([
        "cycloid.memory_context",
        "cycloid.company_memory_recall",
        "cycloid.company_memory_reasoning_chain",
      ]),
    );
  });

  it("tells Codex to call an explicitly named available dynamic tool before answering", () => {
    const guidance = buildSessionStaticBehavioralGuidance({
      agentRole: "implementation",
      dynamicToolNames: new Set(["cycloid.company_memory_recall"]),
    });

    expect(guidance).toContain("Available first-party dynamic tools:");
    expect(guidance).toContain("`cycloid.company_memory_recall`");
    expect(guidance).toContain("must call that tool before answering");
    expect(guidance).toContain("do not answer from already-injected context alone");
  });

  it("routes company memory recall through the session-scoped control-plane endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            block: "<cycloid:company_memory readonly>\nAcme SOC2\n</cycloid:company_memory>",
            memories: [{ id: "fact-acme", claim: "Acme requires SOC2 evidence", score: 0.93 }],
            retrievalTrace: {
              retrievalConfigVersion: "company-memory-denoise-v2-final-gate",
              candidates: [{ id: "fact-acme" }, { id: "fact-rejected" }],
              selector: {
                selected: [{ memoryId: "fact-acme", score: 0.93 }],
                rejected: [{ memoryId: "fact-rejected", rejectReason: "weak_match" }],
              },
            },
          }),
        ),
    );
    const recordTelemetry = vi.fn();

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "company_memory_recall",
        { intent: "Acme onboarding", topK: 3 },
        { env, fetchImpl: fetchImpl as never, recordTelemetry },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining("Acme SOC2") }],
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://control-plane.test/api/sessions/session-123/sandbox/memory/context",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer sandbox-token",
          "content-type": "application/json; charset=utf-8",
        }),
        body: JSON.stringify({ intent: "Acme onboarding", mode: "company", maxMemories: 3 }),
      }),
    );
    expect(recordTelemetry).toHaveBeenCalledWith(
      "memory_recall.returned",
      expect.objectContaining({
        requestedMemoryIds: ["fact-acme", "fact-rejected"],
        returnedMemoryIds: ["fact-acme"],
        usageSource: "company_recall",
        intent: "Acme onboarding",
        files: [],
        retrievalTrace: expect.objectContaining({
          retrievalConfigVersion: "company-memory-denoise-v2-final-gate",
        }),
        decisionTrace: expect.objectContaining({
          candidateIds: ["fact-acme", "fact-rejected"],
          returnedIds: ["fact-acme"],
          selector: expect.objectContaining({
            rejected: [expect.objectContaining({ memoryId: "fact-rejected", rejectReason: "weak_match" })],
          }),
        }),
      }),
    );
  });

  it("routes company memory reasoning-chain lookups and preserves take provenance", async () => {
    const response = {
      ok: true,
      memory: { id: "take-acme", source: "take", kind: "take", claim: "Acme requires SOC2 evidence", confidence: 0.95 },
      sources: [{ source_uri: "slack://T/C/1", source_type: "slack.intake" }],
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response)));

    const result = await executeFirstPartyDynamicToolCall(
      "cycloid",
      "company_memory_reasoning_chain",
      { memoryId: "take-acme" },
      { env, fetchImpl: fetchImpl as never },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      memory: response.memory,
      sources: response.sources,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://control-plane.test/api/sessions/session-123/sandbox/company-memory/reasoning-chain",
      expect.objectContaining({ body: JSON.stringify({ memoryId: "take-acme" }) }),
    );
  });

  it("records memory_context decision traces for empty selector results", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            traceId: "trace-empty",
            memories: [],
            repoRankings: [],
            retrievalTrace: {
              retrievalConfigVersion: "memory-context-candidate-v1",
              traceId: "trace-empty",
              query: '"newline" OR "sanitization"',
              vectorAvailable: false,
              vectorUnavailableReason: "query_embedding_unavailable",
              fusionMode: "deterministic",
              laneCounts: { repo_fts: 1 },
              candidates: [{ id: "mem-prior", lanes: ["repo_fts"], scores: { repo_fts: 0.4 } }],
              selectorStatus: "empty",
              selectorLatencyMs: 42,
              selector: {
                selected: [],
                rejected: [
                  {
                    memoryId: "mem-prior",
                    rejectReason: "weak_match",
                    rationale: "topical overlap without task-changing applicability",
                  },
                ],
                emptyReason: "no applicable memory",
                confidence: 0.1,
              },
              repo: {
                candidateCount: 1,
                selectedCount: 0,
                returnedEmpty: true,
                timedOut: false,
                selectedCandidates: [],
                rejectedCandidates: [
                  {
                    memoryId: "mem-prior",
                    finalScore: 0.4,
                    decision: "rejected",
                    rejectReason: "below_score_threshold",
                    matchedTerms: { text: ["newline"] },
                  },
                ],
              },
            },
          }),
        ),
    );
    const telemetry = vi.fn();

    await expect(
      executeMemoryContextDynamicToolCall(
        { intent: "Fix newline sanitization", maxMemories: 3 },
        {
          env: {
            CONTROL_PLANE_URL: "https://cp.example.test",
            SANDBOX_AUTH_TOKEN: "sandbox-token",
            SESSION_ID: "sess-1",
          },
          fetchImpl: fetchImpl as never,
          recordTelemetry: telemetry,
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      contentItems: [{ text: expect.stringContaining("<empty>No memory was selected") }],
    });

    expect(telemetry).toHaveBeenCalledWith(
      "memory_context.returned",
      expect.objectContaining({
        requestedMemoryIds: ["mem-prior"],
        returnedMemoryIds: [],
        decisionTrace: expect.objectContaining({
          toolName: "cycloid.memory_context",
          traceId: "trace-empty",
          query: '"newline" OR "sanitization"',
          selectorStatus: "empty",
          candidateIds: ["mem-prior"],
          returnedIds: [],
          selector: expect.objectContaining({
            rejected: [expect.objectContaining({ memoryId: "mem-prior", rejectReason: "weak_match" })],
            emptyReason: "no applicable memory",
          }),
          repo: expect.objectContaining({
            rejected: [expect.objectContaining({ memoryId: "mem-prior", rejectReason: "below_score_threshold" })],
          }),
        }),
      }),
    );
  });

  it("fails closed when company-memory routing is not configured", async () => {
    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "company_memory_recall",
        { intent: "Acme onboarding" },
        { env: { ARCANIST_MEMORY_TOOLS_ENABLED: "1" }, fetchImpl: vi.fn() as never },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "not_connected",
      contentItems: [
        {
          text:
            "Company memory routing is not configured for this session.\n\n" +
            "Recovery: This integration is not connected for this session. Report that to the user; do not hand-roll raw API calls or ask for credentials.",
        },
      ],
    });
  });

  it("returns a stable unavailable message for non-JSON company-memory failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("worker crashed", { status: 500 }));

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "company_memory_recall",
        { intent: "Acme onboarding" },
        { env, fetchImpl: fetchImpl as never },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "upstream_error",
      contentItems: [{ text: "Company memory unavailable for this turn." }],
    });
  });

  it("returns a stable unavailable message for thrown company-memory failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET from control plane");
    });

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "company_memory_recall",
        { intent: "Acme onboarding" },
        { env, fetchImpl: fetchImpl as never },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "upstream_error",
      contentItems: [{ text: "Company memory unavailable for this turn." }],
    });
  });

  it("treats an AbortSignal.timeout TimeoutError as a cancelled company-memory request", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    await expect(
      executeFirstPartyDynamicToolCall(
        "cycloid",
        "company_memory_recall",
        { intent: "Acme onboarding" },
        { env, fetchImpl: fetchImpl as never },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "cancelled",
      contentItems: [{ text: "Company memory request was cancelled." }],
    });
  });
});
