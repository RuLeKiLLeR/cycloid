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

const mockAnalyzeSessionForMemories = vi.fn();
const mockRecordSessionCompleteMemoryIngestion = vi.fn();
const mockAddLabels = vi.fn();
const mockCreateInstallationToken = vi.fn();
const mockCreatePullRequest = vi.fn();
const mockEnsureRepoLabel = vi.fn();
const mockListLabels = vi.fn();
const mockRemoveLabel = vi.fn();
const mockGetDefaultBranch = vi.fn();
const mockGetPrDiff = vi.fn();
const mockGetPrReviewComments = vi.fn();
const mockGetSessionState = vi.fn();
const mockListSessionPrompts = vi.fn();
const mockGetSessionEventHistory = vi.fn();
const mockPostMessage = vi.fn();
const mockUpsertMemoryPrTracking = vi.fn();
const mockUpsertMemorySuggestionTracking = vi.fn();
const mockUpsertRepoMemoryWithJudgment = vi.fn();
const mockInsertRepoMemoryJudgment = vi.fn();
const mockListActiveRepoMemoriesForRepo = vi.fn();
const mockClaimMemoryAnalysisJob = vi.fn();
const mockCompleteMemoryAnalysisJob = vi.fn();
const mockFailMemoryAnalysisJob = vi.fn();
const mockGetMemoryAnalysisJob = vi.fn();
const mockCreateCommit = vi.fn();
const mockCreateOrUpdateFile = vi.fn();
const mockCreateRef = vi.fn();
const mockCreateTree = vi.fn();
const mockDeleteFile = vi.fn();
const mockGetCommitTreeSha = vi.fn();
const mockGetFileContent = vi.fn();
const mockGetFileSha = vi.fn();
const mockGetRefSha = vi.fn();
const mockListDirectoryContents = vi.fn();
const mockUpdateRef = vi.fn();
const mockJudgeRepoMemorySuggestion = vi.fn();

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  createScopedInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  addLabels: (...args: unknown[]) => mockAddLabels(...args),
  createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  ensureRepoLabel: (...args: unknown[]) => mockEnsureRepoLabel(...args),
  listLabels: (...args: unknown[]) => mockListLabels(...args),
  removeLabel: (...args: unknown[]) => mockRemoveLabel(...args),
  getDefaultBranch: (...args: unknown[]) => mockGetDefaultBranch(...args),
  getPrDiff: (...args: unknown[]) => mockGetPrDiff(...args),
  getPrReviewComments: (...args: unknown[]) => mockGetPrReviewComments(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  listSessionPrompts: (...args: unknown[]) => mockListSessionPrompts(...args),
  getSessionEventHistory: (...args: unknown[]) => mockGetSessionEventHistory(...args),
}));

vi.mock("../../apps/control-plane-worker/src/slack/notify", () => ({
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
}));

vi.mock("../../apps/control-plane-worker/src/memory/analyzer", async (importActual) => {
  const actual = await importActual<typeof import("../../apps/control-plane-worker/src/memory/analyzer")>();
  return {
    ...actual,
    analyzeSessionForMemories: (...args: unknown[]) => mockAnalyzeSessionForMemories(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/company-memory/service", async (importActual) => {
  const actual = await importActual<typeof import("../../apps/control-plane-worker/src/company-memory/service")>();
  return {
    ...actual,
    recordSessionCompleteMemoryIngestion: (...args: unknown[]) => mockRecordSessionCompleteMemoryIngestion(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/memory/db", () => ({
  upsertMemoryPrTracking: (...args: unknown[]) => mockUpsertMemoryPrTracking(...args),
  upsertMemorySuggestionTracking: (...args: unknown[]) => mockUpsertMemorySuggestionTracking(...args),
  upsertRepoMemoryWithJudgment: (...args: unknown[]) => mockUpsertRepoMemoryWithJudgment(...args),
  insertRepoMemoryJudgment: (...args: unknown[]) => mockInsertRepoMemoryJudgment(...args),
  listActiveRepoMemoriesForRepo: (...args: unknown[]) => mockListActiveRepoMemoriesForRepo(...args),
  claimMemoryAnalysisJob: (...args: unknown[]) => mockClaimMemoryAnalysisJob(...args),
  completeMemoryAnalysisJob: (...args: unknown[]) => mockCompleteMemoryAnalysisJob(...args),
  failMemoryAnalysisJob: (...args: unknown[]) => mockFailMemoryAnalysisJob(...args),
  getMemoryAnalysisJob: (...args: unknown[]) => mockGetMemoryAnalysisJob(...args),
}));

vi.mock("../../apps/control-plane-worker/src/memory/judge", () => ({
  judgeRepoMemorySuggestion: (...args: unknown[]) => mockJudgeRepoMemorySuggestion(...args),
  REPO_MEMORY_JUDGE_MODEL: "gpt-5.4-mini",
}));

vi.mock("../../apps/control-plane-worker/src/memory/github", () => ({
  createCommit: (...args: unknown[]) => mockCreateCommit(...args),
  createOrUpdateFile: (...args: unknown[]) => mockCreateOrUpdateFile(...args),
  createOrResetRef: (...args: unknown[]) => mockCreateRef(...args),
  createTree: (...args: unknown[]) => mockCreateTree(...args),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
  deleteRef: vi.fn().mockResolvedValue(undefined),
  getCommitTreeSha: (...args: unknown[]) => mockGetCommitTreeSha(...args),
  getFileContent: (...args: unknown[]) => mockGetFileContent(...args),
  getFileSha: (...args: unknown[]) => mockGetFileSha(...args),
  getRefSha: (...args: unknown[]) => mockGetRefSha(...args),
  listDirectoryContents: (...args: unknown[]) => mockListDirectoryContents(...args),
  updateRef: (...args: unknown[]) => mockUpdateRef(...args),
}));

import { CYCLOID_MEMORY_LABEL, CYCLOID_PR_LABEL } from "../../apps/control-plane-worker/src/constants/pr-labels";

type MemoryServiceModule = typeof import("../../apps/control-plane-worker/src/memory/service");

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function baseReviewFeedback() {
  return {
    reviewBody: "Please handle the null case in the router.",
    comments: [{ path: "src/router.ts", line: 42, body: "Null check missing here.", author: "reviewer" }],
    reviewAuthor: "reviewer",
    reviewState: "changes_requested",
  };
}

function baseParams() {
  return {
    sessionIds: ["sess-1"],
    prUrl: "https://github.com/trycycloid/cycloid/pull/123",
    prNumber: 123,
    repoOwner: "trycycloid",
    repoName: "cycloid",
    installationId: 77,
    reviewFeedback: baseReviewFeedback(),
  };
}

describe("memory/service", () => {
  let mod: MemoryServiceModule;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockCreateInstallationToken.mockResolvedValue("ghs_install");
    mockAddLabels.mockResolvedValue(undefined);
    mockEnsureRepoLabel.mockResolvedValue({ ok: true, created: false });
    mockListLabels.mockResolvedValue([]);
    mockRemoveLabel.mockResolvedValue(undefined);
    mockGetPrDiff.mockResolvedValue("diff --git a/src/example.ts b/src/example.ts\n");
    mockGetPrReviewComments.mockResolvedValue([
      { path: "src/router.ts", line: 42, body: "Null check missing here.", author: "reviewer" },
    ]);
    mockGetSessionState.mockResolvedValue({ sessionId: "sess-1" });
    mockListSessionPrompts.mockResolvedValue({
      ok: true,
      payload: { prompts: [], queue: { queuedCount: 0, processingPromptId: null } },
    });
    mockGetSessionEventHistory.mockResolvedValue({ ok: true, events: [] });
    mockRecordSessionCompleteMemoryIngestion.mockResolvedValue({ created: true, id: "ingest-1" });
    mockGetDefaultBranch.mockResolvedValue("main");
    mockListDirectoryContents.mockResolvedValue([]);
    mockGetFileContent.mockResolvedValue("# Heading\n");
    mockAnalyzeSessionForMemories.mockResolvedValue({
      completed: true,
      suggestions: {
        add: [
          {
            type: "gotcha",
            memory_type: "action",
            action_type: "procedure",
            level: "gotcha",
            primitive: "gotcha",
            engineering_domains: ["developer_workflow"],
            subjects: ["example workflow"],
            symbols: ["exampleWorkflow"],
            tags: ["gotcha", "workflow"],
            confidence: "high",
            authority: "reviewed",
            enforcement: "none",
            triggers: null,
            supersedes: [],
            contradicts: [],
            context_hint: "When changing the example workflow",
            referenced_files: ["src/example.ts"],
            rationale: "New pattern discovered",
            content: "Prefer the new example workflow path.",
          },
        ],
        update: [],
        remove: [],
        convention_updates: [],
        candidate_audit: [
          {
            lane: "strategic",
            lesson: "No strategic lesson.",
            evidence: "This touched a workflow implementation.",
            selected: false,
            rejection_reason: "No architecture boundary changed.",
          },
          {
            lane: "tactical",
            lesson: "Prefer the new example workflow path.",
            evidence: "The merged PR established a reusable implementation pattern.",
            selected: true,
            rejection_reason: null,
          },
          {
            lane: "gotcha",
            lesson: "The old workflow path is easy to choose accidentally.",
            evidence: "Reviewer correction mentioned it.",
            selected: false,
            rejection_reason: "The tactical procedure is broader.",
          },
          {
            lane: "no_memory",
            lesson: "A memory may be unnecessary.",
            evidence: "The diff is small.",
            selected: false,
            rejection_reason: "The pattern is reusable.",
          },
        ],
      },
      toolErrorCount: 0,
      toolCallCount: 3,
    });
    mockGetRefSha.mockResolvedValue("sha-main");
    mockGetCommitTreeSha.mockResolvedValue("tree-main");
    mockCreateTree.mockResolvedValue("tree-memory");
    mockCreateCommit.mockResolvedValue("commit-memory");
    mockUpdateRef.mockResolvedValue(undefined);
    mockCreateRef.mockResolvedValue(undefined);
    mockCreateOrUpdateFile.mockResolvedValue(undefined);
    mockDeleteFile.mockResolvedValue(undefined);
    mockGetFileSha.mockResolvedValue("old-memory-sha");
    mockCreatePullRequest.mockResolvedValue({
      prUrl: "https://github.com/acme/repo/pull/55",
      prNumber: 55,
      branchName: "memory/update-from-pr-123-review-9001",
      created: true,
    });
    mockUpsertMemoryPrTracking.mockResolvedValue(undefined);
    mockUpsertRepoMemoryWithJudgment.mockResolvedValue(undefined);
    mockUpsertMemorySuggestionTracking.mockResolvedValue(undefined);
    mockInsertRepoMemoryJudgment.mockResolvedValue(undefined);
    mockListActiveRepoMemoriesForRepo.mockResolvedValue([]);
    mockJudgeRepoMemorySuggestion.mockResolvedValue({
      verdict: "store",
      confidence: 0.87,
      rationale: "Grounded and reusable.",
      issues: [],
    });
    mockPostMessage.mockResolvedValue({ ok: true, ts: "123.456", channel: "C123" });
    mockClaimMemoryAnalysisJob.mockResolvedValue(1);
    mockCompleteMemoryAnalysisJob.mockResolvedValue(undefined);
    mockFailMemoryAnalysisJob.mockResolvedValue(undefined);
    mockGetMemoryAnalysisJob.mockResolvedValue({
      id: "job-1",
      status: "queued",
      attempt_count: 0,
      params_json: JSON.stringify({
        sessionIds: ["sess-1"],
        prUrl: "https://github.com/trycycloid/cycloid/pull/123",
        prNumber: 123,
        repoOwner: "trycycloid",
        repoName: "cycloid",
        installationId: 77,
      }),
    });

    mod = await import("../../apps/control-plane-worker/src/memory/service");
  });

  it("synthetically processes a queued memory job and creates a memory PR from valid suggestions", async () => {
    const ack = vi.fn();
    const retry = vi.fn();

    await mod.handleMemoryAnalysisQueue(
      {
        messages: [
          {
            body: { jobId: "job-1" },
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch<
        import("../../apps/control-plane-worker/src/memory/service").MemoryAnalysisQueueMessage
      >,
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        SLACK_BOT_TOKEN: "xoxb-test",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
    );

    expect(mockGetMemoryAnalysisJob).toHaveBeenCalledWith({}, "job-1");
    expect(mockClaimMemoryAnalysisJob).toHaveBeenCalledWith({}, "job-1", expect.any(Number), expect.any(Number));
    expect(mockGetPrReviewComments).toHaveBeenCalledWith("ghs_install", "trycycloid", "cycloid", 123);
    expect(mockCreateInstallationToken).toHaveBeenCalledTimes(1);
    expect(mockAnalyzeSessionForMemories).toHaveBeenCalledWith(
      "sk-openai",
      {
        reviewBody: null,
        comments: [{ path: "src/router.ts", line: 42, body: "Null check missing here.", author: "reviewer" }],
        reviewAuthor: "",
        reviewState: "merged",
      },
      expect.objectContaining({
        repoOwner: "trycycloid",
        repoName: "cycloid",
        prNumber: 123,
        sessionIds: ["sess-1"],
      }),
      expect.anything(),
    );
    expect(mockCreateRef).toHaveBeenCalledWith(
      "ghs_install",
      "trycycloid",
      "cycloid",
      "refs/heads/memory/update-from-pr-123",
      "sha-main",
    );
    expect(mockGetCommitTreeSha).toHaveBeenCalledWith("ghs_install", "trycycloid", "cycloid", "sha-main");
    expect(mockCreateTree).toHaveBeenCalledWith(
      "ghs_install",
      "trycycloid",
      "cycloid",
      expect.objectContaining({
        baseTree: "tree-main",
        tree: [
          expect.objectContaining({
            content: expect.stringContaining("Prefer the new example workflow path."),
            path: expect.stringMatching(/^\.cycloid\/memory\/engineering\/gotchas\/.+\.md$/),
          }),
        ],
      }),
    );
    expect(mockCreateCommit).toHaveBeenCalledWith("ghs_install", "trycycloid", "cycloid", {
      message: "Update repo memories",
      parents: ["sha-main"],
      tree: "tree-memory",
    });
    expect(mockUpdateRef).toHaveBeenCalledWith(
      "ghs_install",
      "trycycloid",
      "cycloid",
      "heads/memory/update-from-pr-123",
      {
        force: false,
        sha: "commit-memory",
      },
    );
    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "ghs_install",
        owner: "trycycloid",
        repo: "cycloid",
        head: "memory/update-from-pr-123",
        base: "main",
        title: "Memory update from review of PR #123",
      }),
    );
    expect(mockUpsertMemoryPrTracking).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        repoOwner: "trycycloid",
        repoName: "cycloid",
        sourcePrNumber: 123,
        sourceSessionId: "sess-1",
        memoryPrNumber: 55,
        memoriesAdded: 1,
        memoriesUpdated: 0,
        memoriesRemoved: 0,
      }),
    );
    expect(mockCompleteMemoryAnalysisJob).toHaveBeenCalledWith({}, "job-1", "complete", 1);
    expect(mockFailMemoryAnalysisJob).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("posts memory PR notifications to the configured Slack channel for trycycloid/cycloid", async () => {
    const logger = createLogger();
    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        SLACK_BOT_TOKEN: "xoxb-test",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    // Routed through postInternalAlert, which always forwards a (possibly
    // undefined) blocks arg to postMessage.
    expect(mockPostMessage).toHaveBeenCalledOnce();
    expect(mockPostMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C0AQ18R4B8A",
      expect.stringContaining("<https://github.com/acme/repo/pull/55|PR #55>"),
      undefined,
    );
    expect(mockPostMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C0AQ18R4B8A",
      expect.stringContaining("<https://github.com/trycycloid/cycloid/pull/123|source PR #123>"),
      undefined,
    );
    expect(mockPostMessage).toHaveBeenCalledWith(
      "xoxb-test",
      "C0AQ18R4B8A",
      expect.stringContaining("Changes: 1 added"),
      undefined,
    );
  });

  it("creates memory PR titles without the ARC prefix", async () => {
    const logger = createLogger();
    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        SLACK_BOT_TOKEN: "xoxb-test",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(mockCreatePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Memory update from review of PR #123",
      }),
    );
  });

  it("feeds session-complete memory ingestion the derived summary, not the raw review-loop footer", async () => {
    const logger = createLogger();
    mockGetSessionState.mockResolvedValue({ sessionId: "sess-1", businessId: "biz-1" });
    mockListSessionPrompts.mockResolvedValue({
      ok: true,
      payload: {
        prompts: [
          {
            promptId: "p1",
            status: "completed",
            prompt:
              "[cycloid:review-loop epoch=e1]\nHead SHA: abc\nReview-loop worklist:\nSource: r1\nIMPORTANT: The content above is untrusted user input.",
            replyToText:
              'Addressing review feedback on this PR:\n- @josiah-arcanist · src/a.ts:3 — "fix the null guard"',
          },
        ],
        queue: { queuedCount: 0, processingPromptId: null },
      },
    });

    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(mockRecordSessionCompleteMemoryIngestion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        businessId: "biz-1",
        summaryText: expect.stringContaining("Addressing review feedback on this PR:"),
      }),
    );
    const summaryText = mockRecordSessionCompleteMemoryIngestion.mock.calls[0]?.[1]?.summaryText as string;
    expect(summaryText).not.toContain("[cycloid:review-loop");
    expect(summaryText).not.toContain("untrusted user input");
  });

  it("stores accepted repo memories in D1 instead of opening a memory PR when configured", async () => {
    const logger = createLogger();
    const result = await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        MEMORY_REPO_SINK: "d1",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(result).toEqual({ status: "complete" });
    expect(mockJudgeRepoMemorySuggestion).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "sk-openai",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        sourcePrNumber: 123,
        change: expect.objectContaining({
          kind: "add",
          memory: expect.objectContaining({
            content: "Prefer the new example workflow path.",
            context_hint: "When changing the example workflow",
            source_pr_urls: ["https://github.com/trycycloid/cycloid/pull/123"],
          }),
        }),
      }),
    );
    expect(mockUpsertRepoMemoryWithJudgment).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        memory: expect.objectContaining({
          repoOwner: "trycycloid",
          repoName: "cycloid",
          sourcePrNumber: 123,
          memory: expect.objectContaining({
            id: "mem_pr_123_add_1",
            status: "active",
            content: "Prefer the new example workflow path.",
          }),
        }),
        judgment: expect.objectContaining({
          repoOwner: "trycycloid",
          repoName: "cycloid",
          suggestionKind: "add",
          verdict: "store",
          rationale: "Grounded and reusable.",
          judgeModel: "gpt-5.4-mini",
        }),
      }),
    );
    expect(mockInsertRepoMemoryJudgment).not.toHaveBeenCalled();
    expect(mockListActiveRepoMemoriesForRepo).toHaveBeenCalledWith({}, "trycycloid", "cycloid");
    expect(mockUpsertMemorySuggestionTracking).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        sourcePrNumber: 123,
        memoryPrUrl: null,
        memoryPrNumber: null,
        memoriesAdded: 1,
        memoriesUpdated: 0,
        memoriesRemoved: 0,
        suggestionsJson: expect.stringContaining("candidate_audit"),
      }),
    );
    expect(mockCreateRef).not.toHaveBeenCalled();
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockUpsertMemoryPrTracking).not.toHaveBeenCalled();
  });

  it("keeps rejected D1 memory candidates as judgment audits without storing memory rows", async () => {
    mockJudgeRepoMemorySuggestion.mockResolvedValueOnce({
      verdict: "reject",
      confidence: 0.76,
      rationale: "Too local to one implementation.",
      issues: ["too_local"],
    });

    const logger = createLogger();
    const result = await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        MEMORY_REPO_SINK: "d1",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(result).toEqual({ status: "complete" });
    expect(mockUpsertRepoMemoryWithJudgment).not.toHaveBeenCalled();
    expect(mockInsertRepoMemoryJudgment).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        suggestionKind: "add",
        verdict: "reject",
        confidence: 0.76,
        rationale: "Too local to one implementation.",
        issues: ["too_local"],
      }),
    );
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it("records below-floor store judgments as rejects without writing durable memory", async () => {
    mockJudgeRepoMemorySuggestion.mockResolvedValueOnce({
      verdict: "store",
      confidence: 0.3,
      rationale: "Useful but insufficiently certain.",
      issues: [],
      belowConfidenceFloor: true,
    });

    const result = await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        MEMORY_REPO_SINK: "d1",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      createLogger() as never,
    );

    expect(result).toEqual({ status: "complete" });
    expect(mockUpsertRepoMemoryWithJudgment).not.toHaveBeenCalled();
    expect(mockInsertRepoMemoryJudgment).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        verdict: "reject",
        rationale: "store_below_confidence_floor: Useful but insufficiently certain.",
      }),
    );
  });

  it("includes existing D1 memories in D1 sink update/remove reconciliation and judge context", async () => {
    mockAnalyzeSessionForMemories.mockResolvedValueOnce({
      completed: true,
      suggestions: {
        add: [],
        update: [
          {
            id: "mem_existing_d1",
            content: "Use the updated D1-backed repo memory.",
            context_hint: "When updating D1-backed memories",
            referenced_files: ["src/example.ts"],
            rationale: "The existing D1 memory needs refinement.",
          },
        ],
        remove: [],
        convention_updates: [],
        candidate_audit: [],
      },
      toolErrorCount: 0,
      toolCallCount: 3,
    });
    mockListActiveRepoMemoriesForRepo.mockResolvedValueOnce([
      {
        id: "mem_existing_d1",
        vertical: "engineering",
        memory_type: "action",
        action_type: "procedure",
        level: "tactical",
        primitive: "procedure",
        engineering_domains: ["developer_workflow"],
        subjects: ["memory"],
        symbols: [],
        tags: ["process"],
        status: "active",
        confidence: "high",
        authority: "reviewed",
        owner: "cycloid",
        applies_to: ["src/example.ts"],
        context_hint: "When updating D1-backed memories",
        source_pr_urls: [],
        source_session_ids: [],
        evidence: [],
        enforcement: "none",
        triggers: null,
        supersedes: [],
        contradicts: [],
        created_at: "2026-06-12",
        updated_at: "2026-06-12",
        content: "Use the old D1-backed repo memory.",
      },
    ]);

    const logger = createLogger();
    const result = await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        MEMORY_REPO_SINK: "d1",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(result).toEqual({ status: "complete" });
    expect(mockJudgeRepoMemorySuggestion).toHaveBeenCalledWith(
      expect.objectContaining({
        existingMemories: expect.arrayContaining([
          expect.objectContaining({
            id: "mem_existing_d1",
            content: "Use the old D1-backed repo memory.",
          }),
        ]),
        change: expect.objectContaining({
          kind: "update",
          targetMemoryId: "mem_existing_d1",
          memory: expect.objectContaining({
            id: "mem_existing_d1",
            content: "Use the updated D1-backed repo memory.",
          }),
        }),
      }),
    );
    expect(mockUpsertRepoMemoryWithJudgment).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        memory: expect.objectContaining({
          memory: expect.objectContaining({
            id: "mem_existing_d1",
            content: "Use the updated D1-backed repo memory.",
          }),
        }),
      }),
    );
  });

  it("applies the memory cycloid label to memory PRs", async () => {
    const logger = createLogger();
    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        SLACK_BOT_TOKEN: "xoxb-test",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(mockEnsureRepoLabel).toHaveBeenCalledWith(
      "ghs_install",
      "trycycloid",
      "cycloid",
      CYCLOID_MEMORY_LABEL,
      "5319e7",
      "Created by Cycloid (memory update)",
    );
    expect(mockListLabels).toHaveBeenCalledWith("ghs_install", "trycycloid", "cycloid", 55);
    expect(mockAddLabels).toHaveBeenCalledWith("ghs_install", "trycycloid", "cycloid", 55, [CYCLOID_MEMORY_LABEL]);
    expect(mockRemoveLabel).not.toHaveBeenCalled();
  });

  it("removes stale provenance labels from reused memory PRs", async () => {
    mockListLabels.mockResolvedValueOnce([CYCLOID_PR_LABEL, CYCLOID_MEMORY_LABEL, "verification-done"]);
    const logger = createLogger();

    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        SLACK_BOT_TOKEN: "xoxb-test",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(mockAddLabels).not.toHaveBeenCalledWith("ghs_install", "trycycloid", "cycloid", 55, [CYCLOID_MEMORY_LABEL]);
    expect(mockRemoveLabel).toHaveBeenCalledWith("ghs_install", "trycycloid", "cycloid", 55, CYCLOID_PR_LABEL);
    expect(mockRemoveLabel).not.toHaveBeenCalledWith("ghs_install", "trycycloid", "cycloid", 55, "verification-done");
  });

  it("does not fail memory PR processing when the memory cycloid label is unavailable", async () => {
    mockEnsureRepoLabel.mockResolvedValueOnce({
      ok: false,
      reason: "permission_denied",
      status: 403,
      detail: "forbidden",
    });
    const logger = createLogger();

    const result = await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        SLACK_BOT_TOKEN: "xoxb-test",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(result).toEqual({ status: "complete" });
    expect(mockListLabels).not.toHaveBeenCalled();
    expect(mockAddLabels).not.toHaveBeenCalledWith("ghs_install", "trycycloid", "cycloid", 55, [CYCLOID_MEMORY_LABEL]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cycloid_label_unavailable",
        repo: "trycycloid/cycloid",
        prNumber: 55,
        reason: "permission_denied",
        status: 403,
      }),
      "Could not apply cycloid:memory label to memory PR",
    );
  });

  it("skips Slack notification for repos other than trycycloid/cycloid", async () => {
    const logger = createLogger();
    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        SLACK_BOT_TOKEN: "xoxb-test",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      {
        ...baseParams(),
        prUrl: "https://github.com/acme/repo/pull/123",
        repoOwner: "acme",
        repoName: "repo",
      },
      logger as never,
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("skips Slack notification when SLACK_BOT_TOKEN is unset (e.g. QA)", async () => {
    const logger = createLogger();
    // Channel id is now hardcoded, so the bot token is the only delivery gate.
    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("skips Slack notification when the memory PR already exists", async () => {
    mockCreatePullRequest.mockResolvedValue({
      prUrl: "https://github.com/acme/repo/pull/55",
      prNumber: 55,
      branchName: "memory/update-from-pr-123-review-9001",
      created: false,
    });

    const logger = createLogger();
    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        SLACK_BOT_TOKEN: "xoxb-test",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      {
        ...baseParams(),
        prUrl: "https://github.com/acme/repo/pull/123",
        repoOwner: "acme",
        repoName: "repo",
      },
      logger as never,
    );

    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("passes reviewFeedback and AnalyzerContext to the analyzer", async () => {
    const logger = createLogger();
    const feedback = {
      reviewBody: "Avoid raw DB queries in route handlers.",
      comments: [
        { path: "src/routes/sessions.ts", line: 88, body: "Call service layer, not DAO directly.", author: "reviewer" },
      ],
      reviewAuthor: "reviewer",
      reviewState: "changes_requested",
    };

    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      { ...baseParams(), reviewFeedback: feedback },
      logger as never,
    );

    expect(mockAnalyzeSessionForMemories).toHaveBeenCalledOnce();
    // New signature: (apiKey, reviewFeedback, context, log)
    const [apiKey, passedFeedback, context] = mockAnalyzeSessionForMemories.mock.calls[0] as [
      string,
      unknown,
      Record<string, unknown>,
    ];
    expect(apiKey).toBe("sk-openai");
    expect(passedFeedback).toEqual(feedback);
    // Context should have the expected closure functions
    expect(typeof context.getSessionPrompts).toBe("function");
    expect(typeof context.getSessionEvents).toBe("function");
    expect(typeof context.getPrDiff).toBe("function");
    expect(typeof context.getFileContent).toBe("function");
    expect(typeof context.getExistingMemories).toBe("function");
    expect(typeof context.getConventionDocSection).toBe("function");
    expect(context.repoOwner).toBe("trycycloid");
    expect(context.repoName).toBe("cycloid");
    expect(context.prNumber).toBe(123);
    expect(context.sessionIds).toEqual(["sess-1"]);
  });

  it("getSessionPrompts feeds the analyzer the review-loop summary, not the raw agent-machinery footer", async () => {
    const logger = createLogger();
    const reviewLoopFooter = [
      "[cycloid:review-loop epoch=ep-1]",
      "Head SHA: abc123",
      "Review-loop worklist:",
      "Source: review-comment:42",
      "Author: @reviewer (User)",
      "Scope discipline:",
      "- Make the minimal change that resolves the worklist.",
    ].join("\n\n");
    const summary = 'Addressing review feedback on this PR:\n- @reviewer · src/a.ts:42 — "fix the null guard"';
    mockListSessionPrompts.mockResolvedValue({
      ok: true,
      payload: {
        prompts: [
          {
            promptId: "p-2",
            prompt: reviewLoopFooter,
            replyToText: summary,
            status: "completed",
            error: null,
            createdAt: "2026-07-07T00:00:00Z",
            actorUserId: null,
            agent: "claude_code",
          },
        ],
        queue: { queuedCount: 0, processingPromptId: null },
      },
    });

    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    const [, , context] = mockAnalyzeSessionForMemories.mock.calls[0] as [
      string,
      unknown,
      { getSessionPrompts: (sessionId: string) => Promise<Array<{ prompt: string }>> },
    ];
    const prompts = await context.getSessionPrompts("sess-1");
    expect(prompts[0]!.prompt).toBe(summary);
    expect(prompts[0]!.prompt).not.toContain("[cycloid:review-loop");
    expect(prompts[0]!.prompt).not.toContain("Scope discipline");
  });

  it("includes PR number in the branch name", async () => {
    const logger = createLogger();
    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      { ...baseParams(), prNumber: 77 },
      logger as never,
    );

    expect(mockCreateRef).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      "refs/heads/memory/update-from-pr-77",
      expect.any(String),
    );
  });

  it("writes new memory files under the semantic Memory 2.0 tree", async () => {
    const logger = createLogger();
    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(mockListDirectoryContents).toHaveBeenCalledWith(
      expect.any(String),
      "trycycloid",
      "cycloid",
      ".cycloid/memory",
      "main",
    );
    expect(mockCreateTree).toHaveBeenCalledWith(
      expect.any(String),
      "trycycloid",
      "cycloid",
      expect.objectContaining({
        tree: [
          expect.objectContaining({
            content: expect.stringContaining("memory_type: action"),
            path: expect.stringMatching(/^\.cycloid\/memory\/engineering\/gotchas\/.+\.md$/),
          }),
        ],
      }),
    );
    const treeEntry = mockCreateTree.mock.calls[0][3].tree[0] as { content: string };
    expect(treeEntry.content).toContain("primitive: gotcha");
    expect(treeEntry.content).toContain("confidence: high");
    expect(treeEntry.content).toContain("exampleWorkflow");
  });

  it("deletes the old memory file when an update moves to a new semantic path", async () => {
    const existingPath = ".cycloid/memory/engineering/action/procedures/existing.md";
    mockListDirectoryContents.mockResolvedValueOnce([
      { name: "existing.md", path: existingPath, sha: "old-memory-sha", type: "file" },
    ]);
    mockGetFileContent.mockResolvedValue(`---
id: mem_existing
vertical: engineering
memory_type: action
action_type: procedure
level: tactical
primitive: procedure
engineering_domains:
  - developer_workflow
subjects: []
symbols: []
tags: []
status: active
confidence: medium
authority: reviewed
owner: cycloid
applies_to:
  - src/example.ts
context_hint: Existing memory
source_pr_urls: []
source_session_ids: []
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-05-12
updated_at: 2026-05-12
---

# Existing Memory

Use the existing workflow.
`);
    mockAnalyzeSessionForMemories.mockResolvedValueOnce({
      completed: true,
      suggestions: {
        add: [],
        update: [
          {
            id: "mem_existing",
            memory_type: "action",
            action_type: "procedure",
            level: "gotcha",
            primitive: "gotcha",
            engineering_domains: ["developer_workflow"],
            subjects: [],
            symbols: [],
            tags: ["gotcha"],
            confidence: "high",
            authority: "reviewed",
            enforcement: "none",
            triggers: null,
            supersedes: [],
            contradicts: [],
            context_hint: "When changing the example workflow",
            referenced_files: ["src/example.ts"],
            rationale: "Reclassified as a gotcha",
            content: "# Updated Gotcha\n\nUse the updated workflow.",
          },
        ],
        remove: [],
        convention_updates: [],
      },
      toolErrorCount: 0,
      toolCallCount: 3,
    });

    const logger = createLogger();
    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(mockCreateTree).toHaveBeenCalledWith(
      expect.any(String),
      "trycycloid",
      "cycloid",
      expect.objectContaining({
        tree: [
          expect.objectContaining({
            content: expect.stringContaining("# Updated Gotcha"),
            path: expect.stringMatching(/^\.cycloid\/memory\/engineering\/gotchas\/existing-/),
          }),
          {
            path: existingPath,
            mode: "100644",
            type: "blob",
            sha: null,
          },
        ],
      }),
    );
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it("fails closed when a renamed memory file changed after it was loaded", async () => {
    const existingPath = ".cycloid/memory/engineering/action/procedures/existing.md";
    mockListDirectoryContents.mockResolvedValueOnce([
      { name: "existing.md", path: existingPath, sha: "old-memory-sha", type: "file" },
    ]);
    mockGetFileContent.mockResolvedValue(`---
id: mem_existing
vertical: engineering
memory_type: action
action_type: procedure
level: tactical
primitive: procedure
engineering_domains:
  - developer_workflow
subjects: []
symbols: []
tags: []
status: active
confidence: medium
authority: reviewed
owner: cycloid
applies_to:
  - src/example.ts
context_hint: Existing memory
source_pr_urls: []
source_session_ids: []
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-05-12
updated_at: 2026-05-12
---

# Existing Memory

Use the existing workflow.
`);
    mockGetFileSha.mockResolvedValueOnce("new-memory-sha");
    mockAnalyzeSessionForMemories.mockResolvedValueOnce({
      completed: true,
      suggestions: {
        add: [],
        update: [
          {
            id: "mem_existing",
            memory_type: "action",
            action_type: "procedure",
            level: "gotcha",
            primitive: "gotcha",
            engineering_domains: ["developer_workflow"],
            subjects: [],
            symbols: [],
            tags: ["gotcha"],
            confidence: "high",
            authority: "reviewed",
            enforcement: "none",
            triggers: null,
            supersedes: [],
            contradicts: [],
            context_hint: "When changing the example workflow",
            referenced_files: ["src/example.ts"],
            rationale: "Reclassified as a gotcha",
            content: "# Updated Gotcha\n\nUse the updated workflow.",
          },
        ],
        remove: [],
        convention_updates: [],
      },
      toolErrorCount: 0,
      toolCallCount: 3,
    });

    const logger = createLogger();
    const result = await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(result).toEqual({
      status: "error",
      error: expect.stringContaining(`Memory file changed before rename delete: ${existingPath}`),
      retryable: true,
    });
    expect(mockCreateTree).not.toHaveBeenCalled();
  });

  it("treats all failed analyzer context fetches as retryable", async () => {
    mockAnalyzeSessionForMemories.mockResolvedValueOnce({
      completed: true,
      suggestions: {
        add: [],
        update: [],
        remove: [],
        convention_updates: [],
      },
      toolErrorCount: 3,
      toolCallCount: 3,
    });

    const logger = createLogger();
    const result = await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(result).toEqual({ status: "error", error: "all 3 tool calls failed", retryable: true });
    expect(mockCreateRef).not.toHaveBeenCalled();
  });

  it("treats analyzer provider failures as retryable instead of no suggestions", async () => {
    mockAnalyzeSessionForMemories.mockResolvedValueOnce({
      completed: true,
      suggestions: {
        add: [],
        update: [],
        remove: [],
        convention_updates: [],
      },
      analysisError: "StructuredOutputError status=400 kind=provider",
      toolErrorCount: 0,
      toolCallCount: 3,
    });

    const logger = createLogger();
    const result = await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    expect(result).toEqual({
      status: "error",
      error: "StructuredOutputError status=400 kind=provider",
      retryable: true,
    });
    expect(mockCreateRef).not.toHaveBeenCalled();
  });

  it("PR body contains structured memory content and rationale", async () => {
    const logger = createLogger();

    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    const createPrCall = mockCreatePullRequest.mock.calls[0][0] as Record<string, string>;
    expect(createPrCall.body).toContain("Memory updates from");
    expect(createPrCall.body).toContain("**Memory:**");
    expect(createPrCall.body).toContain("**Rationale:**");
    expect(createPrCall.body).toContain("### Candidate audit");
    expect(createPrCall.body).toContain("**tactical** (selected): Prefer the new example workflow path.");
    expect(createPrCall.body).toContain("**gotcha** (rejected: The tactical procedure is broader.)");
    expect(createPrCall.body).toContain("Merge to apply");
  });

  it("does not pre-fetch PR diff or transcript — agent pulls on demand", async () => {
    const logger = createLogger();
    await mod.triggerMemoryAnalysis(
      {
        ARCANIST_OPENAI_API_KEY: "sk-openai",
        DB: {},
      } as unknown as import("../../apps/control-plane-worker/src/types").Env,
      baseParams(),
      logger as never,
    );

    // getPrDiff should NOT be called by the service itself
    // (it would only be called if the agent's context closure invoked it)
    expect(mockGetPrDiff).not.toHaveBeenCalled();
  });
});
