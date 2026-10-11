import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";

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

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: vi.fn(),
  tracedEnv: (env: unknown) => env,
}));

vi.mock("../../apps/control-plane-worker/src/observability/context", () => ({
  injectTraceparent: () => null,
}));

const mockPrompts = [
  {
    promptId: "p-1",
    session_id: "sess-1",
    prompt: "Fix the login bug",
    status: "completed",
    result: { status: "completed", hasChanges: true },
    actorUserId: "42",
    createdAt: "2026-04-07T10:00:00Z",
  },
  {
    promptId: "p-2",
    session_id: "sess-1",
    prompt: "Add tests",
    agent: "review",
    status: "processing",
    result: null,
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
    files: ["src/auth.ts"],
    actorUserId: "99",
    createdAt: "2026-04-07T10:05:00Z",
  },
];

import { assembleSessionView } from "../../apps/control-plane-worker/src/services/session-view";
import type { SessionDOResponse, SessionViewPayload } from "../../apps/control-plane-worker/src/types";

function makeSession(overrides?: Partial<SessionDOResponse>): SessionDOResponse {
  return {
    sessionId: "sess-1",
    ownerUserId: "42",
    phase: "running",
    sandboxStatus: null,
    desktopActionPathAvailable: false,
    createdAt: "2026-04-07T09:00:00.000Z",
    updatedAt: "2026-04-07T10:05:00.000Z",
    closedAt: null,
    lastEventId: "evt-99",
    title: "Fix login bug",
    model: "openai:gpt-5.4-mini",
    reasoningEffort: "medium",
    repoUrl: "https://github.com/acme/widgets",
    repoOwner: "acme",
    repoName: "widgets",
    baseBranch: "main",
    lastBranch: "fix/login-bug",
    prUrl: null,
    spawnDurationMs: 3200,
    ...overrides,
  };
}

function makeAuth(overrides?: Record<string, unknown>) {
  return {
    userId: "42",
    canAccessAllSessions: false,
    ...overrides,
  };
}

function makePromptState(overrides?: Partial<Pick<SessionViewPayload, "prompts" | "queue" | "outcomePrompts">>) {
  return {
    prompts: mockPrompts as never,
    queue: { queuedCount: 0, processingPromptId: null },
    ...overrides,
  };
}

function makeNoUserReadDb() {
  const queries: string[] = [];
  const db = {
    prepare: vi.fn((query: string) => {
      queries.push(query);
      if (query.includes("users")) {
        throw new Error("worker should not read users for actor profiles");
      }
      return {
        bind: vi.fn(() => ({
          first: vi.fn(async () => null),
          all: vi.fn(async () => ({ results: [] })),
        })),
      };
    }),
  } as unknown as D1Database;
  return { db, queries };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assembleSessionView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns complete session view on success", async () => {
    const result = await assembleSessionView(makeSession(), makePromptState(), makeAuth());

    // Session fields
    expect(result.session.sessionId).toBe("sess-1");
    expect(result.session.phase).toBe("running");
    expect(result.session.title).toBe("Fix login bug");
    expect(result.session.repoUrl).toBe("https://github.com/acme/widgets");
    expect(result.session.baseBranch).toBe("main");
    expect(result.session.lastBranch).toBe("fix/login-bug");
    expect(result.session.prUrl).toBeNull();
    expect(result.session.queueLength).toBe(0);
    expect(result.session.spawnDurationMs).toBe(3200);

    // Prompts
    expect(result.prompts.total).toBe(2);
    expect(result.prompts.items).toHaveLength(2);
    expect(result.prompts.nextCursor).toBeNull();

    // Actions
    expect(result.actions).toBeDefined();
  });

  it("maps session-level reasoning effort and live sandbox state onto the view model", async () => {
    const result = await assembleSessionView(
      makeSession({ sandboxId: "sbx_live_1", sandboxConnected: true }),
      makePromptState(),
      makeAuth(),
    );

    // reasoningEffort comes from the DO session record (same source as the WS snapshot).
    expect(result.session.reasoningEffort).toBe("medium");
    expect(result.session.sandboxId).toBe("sbx_live_1");
    expect(result.session.sandboxConnected).toBe(true);
  });

  it("surfaces plan Auto reason only to the owner", async () => {
    const session = makeSession({ planAutoReason: "The task needs sequencing across files." });

    const owner = await assembleSessionView(session, makePromptState(), makeAuth());
    const shared = await assembleSessionView(session, makePromptState(), makeAuth({ userId: "99" }));
    const admin = await assembleSessionView(
      session,
      makePromptState(),
      makeAuth({ userId: "admin", canAccessAllSessions: true }),
    );

    expect(owner.session.planAutoReason).toBe("The task needs sequencing across files.");
    expect(shared.session).not.toHaveProperty("planAutoReason");
    expect(admin.session).not.toHaveProperty("planAutoReason");
  });

  it("falls back to null/false when the DO response carries no reasoning or sandbox state", async () => {
    const result = await assembleSessionView(
      makeSession({ reasoningEffort: undefined, sandboxId: undefined, sandboxConnected: undefined }),
      makePromptState(),
      makeAuth(),
    );

    expect(result.session.reasoningEffort).toBeNull();
    expect(result.session.sandboxId).toBeNull();
    // Matches the WS snapshot's Boolean(...) derivation: unknown resolves to false.
    expect(result.session.sandboxConnected).toBe(false);
  });

  it("surfaces related child sessions and the dedicated QA child id", async () => {
    const result = await assembleSessionView(makeSession(), makePromptState(), makeAuth(), {
      parentMetadata: {
        childSessionIds: ["child-ordinary", "child-qa"],
        qaChildSessionId: "child-qa",
      },
    });

    expect(result.session.childSessionIds).toEqual(["child-ordinary", "child-qa"]);
    expect(result.session.qaChildSessionId).toBe("child-qa");
  });

  it("carries the live-idle userStopped flag from the DO response into the view model", async () => {
    // The DO-served response supplies the in-memory flag; the HTTP view must
    // surface it so the ~30s resilience poll keeps the "Stopped" badge.
    const stopped = await assembleSessionView(
      makeSession({ phase: "idle", userStopped: true }),
      makePromptState(),
      makeAuth(),
    );
    expect(stopped.session.userStopped).toBe(true);

    const cleared = await assembleSessionView(
      makeSession({ phase: "idle", userStopped: false }),
      makePromptState(),
      makeAuth(),
    );
    expect(cleared.session.userStopped).toBe(false);

    // Omitted on the response -> omitted on the view (no clobber to a bogus value).
    const absent = await assembleSessionView(makeSession(), makePromptState(), makeAuth());
    expect(absent.session.userStopped).toBeUndefined();
  });

  it("gates the desktop action path by Cycloid business membership, not model image feedback", async () => {
    const codexAvailable = await assembleSessionView(
      makeSession({ businessId: SEEDED_BUSINESS_IDS.cycloid, model: "gpt-5.4", agentRuntimeBackend: "codex" }),
      makePromptState(),
      makeAuth(),
    );
    expect(codexAvailable.session.desktopActionPathAvailable).toBe(true);

    const claudeAvailable = await assembleSessionView(
      makeSession({
        businessId: SEEDED_BUSINESS_IDS.cycloidQa,
        model: "claude-opus-4-8",
        agentRuntimeBackend: "claude_code",
      }),
      makePromptState(),
      makeAuth(),
    );
    expect(claudeAvailable.session.desktopActionPathAvailable).toBe(true);

    const wrongBackend = await assembleSessionView(
      makeSession({ model: "kimi-k2.7-code", agentRuntimeBackend: "codex" }),
      makePromptState(),
      makeAuth(),
    );
    expect(wrongBackend.session.desktopActionPathAvailable).toBe(false);

    const available = await assembleSessionView(
      makeSession({
        businessId: SEEDED_BUSINESS_IDS.cycloidQa,
        model: "kimi-k2.7-code",
        agentRuntimeBackend: "opencode",
      }),
      makePromptState(),
      makeAuth(),
    );
    expect(available.session.desktopActionPathAvailable).toBe(true);

    const unapprovedOpencodeModel = await assembleSessionView(
      makeSession({ model: "glm-4.7", agentRuntimeBackend: "opencode" }),
      makePromptState(),
      makeAuth(),
    );
    expect(unapprovedOpencodeModel.session.desktopActionPathAvailable).toBe(false);
  });

  it("preserves continuesPlan through the view projection (plan-mode implementation turn)", async () => {
    const result = await assembleSessionView(
      makeSession(),
      makePromptState({
        prompts: [
          { promptId: "p-1", session_id: "sess-1", prompt: "plan", status: "completed", result: "ok" },
          {
            promptId: "p-2",
            session_id: "sess-1",
            prompt: "implement",
            status: "processing",
            result: null,
            continuesPlan: true,
          },
        ] as never,
      }),
      makeAuth(),
    );

    expect(result.prompts.items.find((p) => p.promptId === "p-2")?.continuesPlan).toBe(true);
    expect(result.prompts.items.find((p) => p.promptId === "p-1")?.continuesPlan).toBeUndefined();
  });

  it("carries the review-loop replyToText summary through the view projection", async () => {
    const result = await assembleSessionView(
      makeSession(),
      makePromptState({
        prompts: [
          {
            promptId: "p-1",
            session_id: "sess-1",
            prompt: "[cycloid:review-loop epoch=e1]\nHead SHA: abc\n…footer…",
            replyToText: "Addressing review feedback on this PR:",
            status: "completed",
            result: "ok",
          },
          { promptId: "p-2", session_id: "sess-1", prompt: "plain turn", status: "completed", result: "ok" },
        ] as never,
      }),
      makeAuth(),
    );

    expect(result.prompts.items.find((p) => p.promptId === "p-1")?.replyToText).toBe(
      "Addressing review feedback on this PR:",
    );
    // A turn with no replyToText stays absent (optional-field spread), not null.
    expect(result.prompts.items.find((p) => p.promptId === "p-2")?.replyToText).toBeUndefined();
  });

  it("clamps promptLimit=0 so pagination advances instead of looping forever", async () => {
    // promptLimit=0 used to slice an empty page whose nextCursor equalled the
    // incoming cursor, so a client paging on it never terminated. Clamp to >= 1.
    const first = await assembleSessionView(makeSession(), makePromptState(), makeAuth(), { promptLimit: 0 });
    expect(first.prompts.items).toHaveLength(1);
    expect(first.prompts.nextCursor).toBe("1");

    const second = await assembleSessionView(makeSession(), makePromptState(), makeAuth(), {
      promptLimit: 0,
      promptCursor: first.prompts.nextCursor ?? undefined,
    });
    expect(second.prompts.items).toHaveLength(1);
    expect(second.prompts.nextCursor).toBeNull();
  });

  it("derives draft/manual-review PR metadata from verification in the session view", async () => {
    const result = await assembleSessionView(
      makeSession({
        prUrl: "https://github.com/acme/widgets/pull/42",
        verification: {
          verified: true,
          status: "manual_review_required",
          publishMode: "draft",
          manualReviewReason: "Broad typecheck was resource-killed.",
          explanation: "Broad typecheck was resource-killed.",
        },
      }),
      makePromptState(),
      makeAuth(),
    );

    expect(result.session).toMatchObject({
      prUrl: "https://github.com/acme/widgets/pull/42",
      prDraft: true,
      prManualReviewReason: "Broad typecheck was resource-killed.",
    });
  });

  it("surfaces the verifier verdict over an outdated draft snapshot once verification is done", async () => {
    const result = await assembleSessionView(
      makeSession({
        prUrl: "https://github.com/acme/widgets/pull/42",
        // Frozen manual-review snapshot from storage.
        verification: {
          verified: true,
          status: "manual_review_required",
          publishMode: "draft",
          manualReviewReason: "Manual review required.",
        },
        // Authoritative columns: verifier concluded merge-ready and the PR is no longer a draft.
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        prDraft: false,
        prManualReviewReason: null,
      }),
      makePromptState(),
      makeAuth(),
    );

    expect(result.session.prDraft).toBe(false);
    expect(result.session.prManualReviewReason).toBeNull();
    expect(result.session.verification).toMatchObject({
      verified: true,
      status: "passed",
      publishMode: "normal",
    });
    expect(result.session.verification?.manualReviewReason).toBeUndefined();
  });

  it("honors the gate: an outdated snapshot still governs while verification is in progress", async () => {
    const result = await assembleSessionView(
      makeSession({
        prUrl: "https://github.com/acme/widgets/pull/42",
        verification: {
          verified: true,
          status: "manual_review_required",
          publishMode: "draft",
          manualReviewReason: "Manual review required.",
        },
        // Verification not concluded: result must not be projected.
        verificationState: "verification-in-progress",
        verificationResult: null,
        prDraft: true,
        prManualReviewReason: null,
      }),
      makePromptState(),
      makeAuth(),
    );

    expect(result.session.prDraft).toBe(true);
    expect(result.session.verification).toMatchObject({
      status: "manual_review_required",
      publishMode: "draft",
    });
    expect(result.session.prManualReviewReason).toBe("Manual review required.");
  });

  it("preserves QA run metadata projected by the SessionDO", async () => {
    const result = await assembleSessionView(
      makeSession({
        prUrl: "https://github.com/acme/widgets/pull/42",
        verificationState: "verification-in-progress",
        verificationResult: null,
        verificationAttemptCount: 2,
        verificationMaxAttempts: 3,
        qaRun: {
          state: "verification-in-progress",
          verdict: null,
          childSessionId: "qa-active-child",
          runId: 7,
          head: "active-run-head-sha",
          attemptCount: 2,
          maxAttempts: 3,
          evidenceCount: 4,
          blockers: ["Runtime smoke failed."],
        },
      }),
      makePromptState(),
      makeAuth(),
    );

    expect(result.session.qaRun).toEqual({
      state: "verification-in-progress",
      verdict: null,
      childSessionId: "qa-active-child",
      runId: 7,
      head: "active-run-head-sha",
      attemptCount: 2,
      maxAttempts: 3,
      evidenceCount: 4,
      blockers: ["Runtime smoke failed."],
    });
  });

  it("marks final verification as pending before publish starts", async () => {
    const result = await assembleSessionView(
      makeSession({
        phase: "finalizing",
        publishStatus: "not_started",
      }),
      makePromptState(),
      makeAuth(),
    );

    expect(result.session.outcome).toEqual({
      state: "final_verification_pending",
      tone: "info",
      title: "Local work complete. Final verification pending.",
      detail: null,
    });
  });

  const noChangePrompt = (reason: string | undefined) => [
    {
      promptId: "p-nc",
      session_id: "sess-1",
      prompt: "Check the config",
      status: "completed",
      result: reason === undefined ? { noChanges: true } : { noChanges: true, noChangeReason: reason },
      actorUserId: "42",
      createdAt: "2026-04-07T10:00:00Z",
    },
  ];

  it("suppresses the benign no-change outcome for a completed no_diff session with no PR", async () => {
    const result = await assembleSessionView(
      makeSession({ phase: "completed", prUrl: null, lastBranch: "main" }),
      makePromptState({ prompts: noChangePrompt("no_diff") as never }),
      makeAuth(),
    );

    // Clean no-op is already conveyed by the Completed badge; the box is clutter.
    expect(result.session.outcome).toBeNull();
  });

  it("suppresses the benign no-change outcome for a completed no_staged_files session", async () => {
    const result = await assembleSessionView(
      makeSession({ phase: "completed", prUrl: null }),
      makePromptState({ prompts: noChangePrompt("no_staged_files") as never }),
      makeAuth(),
    );

    expect(result.session.outcome).toBeNull();
  });

  it("surfaces abnormal error copy for a completed prep_failed session", async () => {
    const result = await assembleSessionView(
      makeSession({ phase: "completed", prUrl: null }),
      makePromptState({ prompts: noChangePrompt("prep_failed") as never }),
      makeAuth(),
    );

    expect(result.session.outcome).toEqual({
      state: "no_change_abnormal",
      tone: "error",
      title: "Finalization failed before changes could be prepared.",
      detail: null,
    });
  });

  it("routes an unknown no-change reason to the abnormal path", async () => {
    const result = await assembleSessionView(
      makeSession({ phase: "completed", prUrl: null }),
      makePromptState({ prompts: noChangePrompt("some_future_reason") as never }),
      makeAuth(),
    );

    expect(result.session.outcome?.state).toBe("no_change_abnormal");
    expect(result.session.outcome?.tone).toBe("error");
  });

  it("routes a missing no-change reason to the abnormal path", async () => {
    const result = await assembleSessionView(
      makeSession({ phase: "completed", prUrl: null }),
      makePromptState({ prompts: noChangePrompt(undefined) as never }),
      makeAuth(),
    );

    expect(result.session.outcome?.state).toBe("no_change_abnormal");
  });

  it("keeps final-verification-pending over a no-change prompt while finalizing", async () => {
    const result = await assembleSessionView(
      makeSession({ phase: "finalizing", publishStatus: "not_started", prUrl: null }),
      makePromptState({ prompts: noChangePrompt("no_diff") as never }),
      makeAuth(),
    );

    expect(result.session.outcome?.state).toBe("final_verification_pending");
  });

  it("does not show no-change copy when a later completed prompt produced changes", async () => {
    const prompts = [
      {
        promptId: "p-1",
        session_id: "sess-1",
        prompt: "first",
        status: "completed",
        result: { noChanges: true, noChangeReason: "no_diff" },
        actorUserId: "42",
        createdAt: "2026-04-07T10:00:00Z",
      },
      {
        promptId: "p-2",
        session_id: "sess-1",
        prompt: "second",
        status: "completed",
        result: { diffSummary: "Changes detected" },
        actorUserId: "42",
        createdAt: "2026-04-07T10:05:00Z",
      },
    ];
    const result = await assembleSessionView(
      makeSession({ phase: "completed", prUrl: null }),
      makePromptState({ prompts: prompts as never }),
      makeAuth(),
    );

    expect(result.session.outcome).toBeNull();
  });

  it("uses latest completed outcome prompt when the visible prompt page is partial", async () => {
    const firstPagePrompts = [
      {
        promptId: "p-1",
        session_id: "sess-1",
        prompt: "first",
        status: "completed",
        result: { diffSummary: "Changes detected" },
        actorUserId: "42",
        createdAt: "2026-04-07T10:00:00Z",
      },
    ];
    const latestCompletedPrompt = [
      {
        promptId: "p-101",
        session_id: "sess-1",
        prompt: "latest",
        status: "completed",
        result: { noChanges: true, noChangeReason: "prep_failed" },
        actorUserId: "42",
        createdAt: "2026-04-07T11:00:00Z",
      },
    ];

    const result = await assembleSessionView(
      makeSession({ phase: "completed", prUrl: null }),
      makePromptState({
        prompts: firstPagePrompts as never,
        outcomePrompts: latestCompletedPrompt as never,
      }),
      makeAuth(),
      { promptPage: { nextCursor: "100", total: 101 } },
    );

    expect(result.prompts.items.map((prompt) => prompt.promptId)).toEqual(["p-1"]);
    expect(result.session.outcome?.state).toBe("no_change_abnormal");
  });

  it("does not show no-change copy when a PR exists", async () => {
    const result = await assembleSessionView(
      makeSession({ phase: "completed", prUrl: "https://github.com/acme/widgets/pull/7" }),
      makePromptState({ prompts: noChangePrompt("no_diff") as never }),
      makeAuth(),
    );

    expect(result.session.outcome).toBeNull();
  });

  it("omits legacy preview state for E2B sessions", async () => {
    const session = makeSession({
      runtimeProvenance: {
        runtime: {
          provider: "e2b",
          sandboxId: "e2b-sandbox-1",
          templateId: "cycloid-sandbox-test",
          state: "running",
          reportedAt: 1_777_246_000_000,
        },
        updatedAt: 1_777_246_000_000,
      },
    });

    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect("previewUrl" in result.session).toBe(false);
    expect("previewStatus" in result.session).toBe(false);
    expect("previewError" in result.session).toBe(false);
  });

  it("resolves model label and contextWindow server-side", async () => {
    const result = await assembleSessionView(makeSession(), makePromptState(), makeAuth());

    expect(result.session.model).not.toBeNull();
    expect(result.session.model!.providerID).toBe("openai");
    expect(result.session.model!.modelID).toBe("gpt-5.4-mini");
    expect(typeof result.session.model!.label).toBe("string");
    expect(result.session.model!.label.length).toBeGreaterThan(0);
    // Context window should be present for known models (if registered)
    if (result.session.model!.contextWindow != null) {
      expect(result.session.model!.contextWindow).toBeGreaterThan(0);
    }
  });

  it("returns null model when session has no model", async () => {
    const session = makeSession({ model: null });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.session.model).toBeNull();
  });

  it("falls back to model ID as label for unknown models", async () => {
    const session = makeSession({ model: "openai:unknown-model-2099" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.session.model).not.toBeNull();
    expect(result.session.model!.modelID).toBe("unknown-model-2099");
    expect(result.session.model!.label).toBe("unknown-model-2099");
    expect(result.session.model!.contextWindow).toBeUndefined();
  });

  it("paginates prompts with cursor", async () => {
    // Create 5 prompts
    const manyPrompts = Array.from({ length: 5 }, (_, i) => ({
      promptId: `p-${i}`,
      session_id: "sess-1",
      prompt: `Prompt ${i}`,
      status: "completed",
      result: null,
    }));
    // First page: limit 2
    const page1 = await assembleSessionView(
      makeSession(),
      makePromptState({ prompts: manyPrompts as never }),
      makeAuth(),
      { promptLimit: 2 },
    );
    expect(page1.prompts.items).toHaveLength(2);
    expect(page1.prompts.total).toBe(5);
    expect(page1.prompts.nextCursor).toBe("2");
    expect(page1.prompts.items[0].promptId).toBe("p-0");

    // Second page: cursor=2, limit=2
    const page2 = await assembleSessionView(
      makeSession(),
      makePromptState({ prompts: manyPrompts as never }),
      makeAuth(),
      { promptCursor: "2", promptLimit: 2 },
    );
    expect(page2.prompts.items).toHaveLength(2);
    expect(page2.prompts.nextCursor).toBe("4");
    expect(page2.prompts.items[0].promptId).toBe("p-2");

    // Third page: cursor=4, limit=2
    const page3 = await assembleSessionView(
      makeSession(),
      makePromptState({ prompts: manyPrompts as never }),
      makeAuth(),
      { promptCursor: "4", promptLimit: 2 },
    );
    expect(page3.prompts.items).toHaveLength(1);
    expect(page3.prompts.nextCursor).toBeNull();
    expect(page3.prompts.items[0].promptId).toBe("p-4");
  });

  it("caps prompt limit at 100", async () => {
    const manyPrompts = Array.from({ length: 150 }, (_, i) => ({
      promptId: `p-${i}`,
      session_id: "sess-1",
      prompt: `Prompt ${i}`,
      status: "completed",
      result: null,
    }));
    const result = await assembleSessionView(
      makeSession(),
      makePromptState({ prompts: manyPrompts as never }),
      makeAuth(),
      { promptLimit: 200 },
    );
    expect(result.prompts.items).toHaveLength(100);
    expect(result.prompts.nextCursor).toBe("100");
    expect(result.prompts.total).toBe(150);
  });

  it("computes action availability for idle sessions", async () => {
    const session = makeSession({ phase: "idle" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.actions).toEqual({
      canSendPrompt: true,
      canStop: false,
      canResume: false,
      canWarm: true,
      canRespond: false,
      canRetry: true,
      canArchive: true,
    });
  });

  it("computes action availability for running sessions", async () => {
    const session = makeSession({ phase: "running" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.actions).toEqual({
      canSendPrompt: true,
      canStop: true,
      canResume: false,
      canWarm: false,
      canRespond: false,
      canRetry: true,
      canArchive: true,
    });
  });

  it("computes action availability for stopped sessions", async () => {
    const session = makeSession({ phase: "stopped", stopMode: "user" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.actions).toEqual({
      canSendPrompt: false,
      canStop: false,
      canResume: true,
      canWarm: true,
      canRespond: false,
      canRetry: true,
      canArchive: true,
    });
  });

  it("computes action availability for archived sessions", async () => {
    const session = makeSession({ phase: "archived", closedAt: "2026-04-07T12:00:00Z" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.actions).toEqual({
      canSendPrompt: false,
      canStop: false,
      canResume: false,
      canWarm: false,
      canRespond: false,
      canRetry: false,
      canArchive: false,
    });
  });

  it("computes action availability for waiting_for_input sessions", async () => {
    // waiting_for_input is still an active prompt (the user can stop it or
    // answer the question), so canStop is true.
    const session = makeSession({ phase: "waiting_for_input" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.actions).toEqual({
      canSendPrompt: true,
      canStop: true,
      canResume: false,
      canWarm: false,
      canRespond: true,
      canRetry: true,
      canArchive: true,
    });
  });

  it("computes action availability for finalizing sessions", async () => {
    const session = makeSession({ phase: "finalizing" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.actions).toEqual({
      canSendPrompt: false,
      canStop: false,
      canResume: false,
      canWarm: false,
      canRespond: false,
      canRetry: false,
      canArchive: true,
    });
  });

  it("computes action availability for completed sessions", async () => {
    // Completed remains terminal for watch/polling/replay, but follow-up
    // prompts are intentionally accepted — see shared/session/eligibility.ts.
    const session = makeSession({ phase: "completed" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.actions).toEqual({
      canSendPrompt: true,
      canStop: false,
      canResume: false,
      canWarm: true,
      canRespond: false,
      canRetry: true,
      canArchive: true,
    });
  });

  it("computes action availability for blocked sessions", async () => {
    const session = makeSession({ phase: "blocked" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.actions).toEqual({
      canSendPrompt: false,
      canStop: false,
      canResume: false,
      canWarm: false,
      canRespond: false,
      canRetry: true,
      canArchive: true,
    });
  });

  it("computes action availability for failed sessions", async () => {
    const session = makeSession({ phase: "failed" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.actions).toEqual({
      canSendPrompt: false,
      canStop: false,
      canResume: false,
      canWarm: true,
      canRespond: false,
      canRetry: true,
      canArchive: true,
    });
  });

  it("computes action availability for stopped_resumable sessions", async () => {
    const session = makeSession({ phase: "stopped", stopMode: "resumable" });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.actions).toEqual({
      canSendPrompt: true,
      canStop: false,
      canResume: true,
      canWarm: true,
      canRespond: false,
      canRetry: true,
      canArchive: true,
    });
  });

  it("includes owner profile for shared sessions when DO supplies it", async () => {
    // The DO resolves and caches the owner profile; it arrives pre-populated in SessionDOResponse.
    const session = makeSession({
      ownerUserId: "99",
      ownerLogin: "alice",
      ownerAvatarUrl: "https://github.com/alice.png",
    });
    const result = await assembleSessionView(session, makePromptState(), makeAuth({ userId: "42" }));

    expect(result.session.ownerLogin).toBe("alice");
    expect(result.session.ownerAvatarUrl).toBe("https://github.com/alice.png");
  });

  it("excludes owner profile for own sessions", async () => {
    const result = await assembleSessionView(
      makeSession({ ownerUserId: "42", ownerLogin: "alice", ownerAvatarUrl: "https://github.com/alice.png" }),
      makePromptState(),
      makeAuth({ userId: "42" }),
    );

    expect(result.session.ownerLogin).toBeUndefined();
    expect(result.session.ownerAvatarUrl).toBeUndefined();
  });

  it("uses the DO-supplied UI lifecycle stage without a worker pr_coordination read", async () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error("worker should not read pr_coordination for uiLifecycleStage");
      }),
    } as unknown as D1Database;

    const withStage = await assembleSessionView(
      makeSession({ uiLifecycleStage: "merge_ready" }),
      makePromptState(),
      makeAuth(),
      { db },
    );
    const withoutStage = await assembleSessionView(makeSession(), makePromptState(), makeAuth(), { db });

    expect(withStage.session.uiLifecycleStage).toBe("merge_ready");
    expect(withoutStage.session.uiLifecycleStage).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("prompt items exclude session_id and preserve actorUserId", async () => {
    const result = await assembleSessionView(makeSession(), makePromptState(), makeAuth());

    expect(result.prompts.items.map((prompt) => prompt.actorUserId)).toEqual(["42", "99"]);
    for (const prompt of result.prompts.items) {
      const keys = Object.keys(prompt);
      expect(keys).not.toContain("session_id");
    }
  });

  it("uses DO-baked prompt actor profiles", async () => {
    const result = await assembleSessionView(
      makeSession(),
      makePromptState({
        prompts: [
          {
            ...mockPrompts[0],
            actorLogin: "owner-user",
            actorAvatarUrl: "https://avatars.example.com/owner.png",
          },
          {
            ...mockPrompts[1],
            actorLogin: "collab-user",
            actorAvatarUrl: "https://avatars.example.com/collab.png",
          },
        ] as never,
      }),
      makeAuth(),
    );

    expect(result.prompts.items[0]).toMatchObject({
      actorUserId: "42",
      actorLogin: "owner-user",
      actorAvatarUrl: "https://avatars.example.com/owner.png",
    });
    expect(result.prompts.items[1]).toMatchObject({
      actorUserId: "99",
      actorLogin: "collab-user",
      actorAvatarUrl: "https://avatars.example.com/collab.png",
    });
  });

  it("records worker actor profile count as unique non-null actor ids", async () => {
    const { db, queries } = makeNoUserReadDb();
    const timings: Record<string, unknown>[] = [];

    await assembleSessionView(
      makeSession(),
      makePromptState({
        prompts: [
          mockPrompts[0],
          { ...mockPrompts[0], promptId: "p-duplicate" },
          { ...mockPrompts[1], promptId: "p-no-actor", actorUserId: null },
        ] as never,
      }),
      makeAuth(),
      {
        db,
        timingRecorder: (segment, timing) => {
          if (segment === "worker_actor_profiles") timings.push(timing);
        },
      },
    );

    expect(timings).toContainEqual(expect.objectContaining({ requestedCount: 1, outcome: "success" }));
    expect(queries.some((query) => query.includes("users"))).toBe(false);
  });

  it("does not issue a worker users read for actor profiles", async () => {
    const { db, queries } = makeNoUserReadDb();

    await assembleSessionView(makeSession({ uiLifecycleStage: "verifying" }), makePromptState(), makeAuth(), {
      db,
      promptCursor: "1",
      promptLimit: 1,
    });

    expect(queries.some((query) => query.includes("users"))).toBe(false);
  });

  it("keeps prompt actor ids when DO-baked actor fields are missing", async () => {
    const { db, queries } = makeNoUserReadDb();

    const result = await assembleSessionView(
      makeSession({ uiLifecycleStage: "verifying" }),
      makePromptState(),
      makeAuth(),
      {
        db,
      },
    );

    expect(result.prompts.items[0].actorUserId).toBe("42");
    expect(result.prompts.items[0].actorLogin).toBeUndefined();
    expect(result.prompts.items[0].actorAvatarUrl).toBeUndefined();
    expect(queries.some((query) => query.includes("users"))).toBe(false);
  });

  it("uses embedded prompt actor metadata without a worker D1 lookup", async () => {
    const prompts = [
      {
        promptId: "p-embedded",
        session_id: "sess-1",
        prompt: "From websocket state",
        status: "completed",
        result: null,
        actorUserId: " 99 ",
        actorLogin: "embedded-user",
        actorAvatarUrl: "https://avatars.example.com/embedded.png",
      },
    ];

    const result = await assembleSessionView(makeSession(), makePromptState({ prompts: prompts as never }), makeAuth());

    expect(result.prompts.items[0]).toMatchObject({
      actorUserId: "99",
      actorLogin: "embedded-user",
      actorAvatarUrl: "https://avatars.example.com/embedded.png",
    });
  });

  it("prompt items preserve optional fields only when present", async () => {
    const result = await assembleSessionView(
      makeSession(),
      makePromptState({
        prompts: [
          mockPrompts[0],
          {
            ...mockPrompts[1],
            uploadedFiles: [{ name: "notes.txt" }],
            uploadedImages: [{ name: "diagram.png", mediaType: "image/png", data: "aW1hZ2U=" }],
          },
        ] as never,
      }),
      makeAuth(),
    );

    // First prompt has no agent/model/files
    const p1 = result.prompts.items[0];
    expect(p1.promptId).toBe("p-1");
    expect(p1.agent).toBeUndefined();
    expect(p1.model).toBeUndefined();
    expect(p1.files).toBeUndefined();
    expect(p1.uploadedFiles).toBeUndefined();
    expect(p1.uploadedImages).toBeUndefined();

    // Second prompt has agent, model, files, and uploaded attachment summaries.
    const p2 = result.prompts.items[1];
    expect(p2.agent).toBe("review");
    expect(p2.model).toBe("gpt-5.4-mini");
    expect(p2.reasoningEffort).toBe("high");
    expect(p2.files).toEqual(["src/auth.ts"]);
    expect(p2.uploadedFiles).toEqual([{ name: "notes.txt" }]);
    expect(p2.uploadedImages).toEqual([{ name: "diagram.png", mediaType: "image/png", data: "aW1hZ2U=" }]);
  });

  it("handles session with no repo context", async () => {
    const session = makeSession({
      repoUrl: undefined,
      repoOwner: undefined,
      repoName: undefined,
      baseBranch: undefined,
      lastBranch: undefined,
    });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.session.repoUrl).toBeNull();
    expect(result.session.baseBranch).toBeNull();
    expect(result.session.lastBranch).toBeNull();
  });

  it("includes closeReason when session is closed", async () => {
    const session = makeSession({
      phase: "archived",
      closedAt: "2026-04-07T12:00:00Z",
      closeReason: "user_requested",
    });
    const result = await assembleSessionView(session, makePromptState(), makeAuth());

    expect(result.session.closeReason).toBe("user_requested");
  });

  it("includes queueLength from DO queue state", async () => {
    const result = await assembleSessionView(
      makeSession(),
      makePromptState({ queue: { queuedCount: 3, processingPromptId: "p-2" } }),
      makeAuth(),
    );
    expect(result.session.queueLength).toBe(3);
  });

  it("collapses unknown or missing sessionKind to repo", async () => {
    const withoutKind = await assembleSessionView(makeSession(), makePromptState(), makeAuth());
    expect(withoutKind.session.sessionKind).toBe("repo");

    const unknownKind = await assembleSessionView(
      makeSession({ sessionKind: "something_else" as never }),
      makePromptState(),
      makeAuth(),
    );
    expect(unknownKind.session.sessionKind).toBe("repo");
  });

  it("uses prompt data passed from the caller", async () => {
    const prompts = [
      {
        promptId: "p-external",
        prompt: "Loaded from combined DO view",
        status: "completed",
        result: null,
      },
    ];

    const result = await assembleSessionView(makeSession(), makePromptState({ prompts: prompts as never }), makeAuth());

    expect(result.prompts.total).toBe(1);
    expect(result.prompts.items[0].promptId).toBe("p-external");
    expect(result.prompts.items[0].prompt).toBe("Loaded from combined DO view");
  });

  it("copies reviewLoopDoneState from the DO session into the view model", async () => {
    const view = await assembleSessionView(makeSession({ reviewLoopDoneState: "done" }), makePromptState(), makeAuth());
    expect(view.session.reviewLoopDoneState).toBe("done");

    const noClaim = await assembleSessionView(makeSession(), makePromptState(), makeAuth());
    expect(noClaim.session.reviewLoopDoneState).toBeNull();
  });
});
