import { describe, expect, it } from "vitest";

import type { Provider, SessionDetail } from "../../apps/ui/src/types";
import { toSubscribedSessionDetail } from "../../apps/ui/src/utils/session-subscribe";

const MOCK_PROVIDERS: Provider[] = [
  {
    id: "openai",
    name: "OpenAI",
    models: [{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", label: "OpenAI / GPT-5.4 Mini" }],
  },
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", label: "OpenAI / GPT-5.3 Codex" },
      { id: "gpt-5.4", name: "GPT-5.4", label: "OpenAI / GPT-5.4" },
    ],
  },
];

describe("toSubscribedSessionDetail", () => {
  it("maps draft/manual-review PR metadata from the subscribed snapshot", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          phase: "idle",
          displayStatus: "stopped",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Manual review",
          model: null,
          prUrl: "https://github.com/acme/repo/pull/42",
          prDraft: true,
          prManualReviewReason: "Broad typecheck was resource-killed.",
        },
        sandbox: {
          status: null,
          sandboxId: null,
          connected: false,
          spawnDurationMs: null,
        },
        queue: {
          queuedCount: 0,
          processingPromptId: null,
        },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session).toMatchObject({
      prUrl: "https://github.com/acme/repo/pull/42",
      prDraft: true,
      prManualReviewReason: "Broad typecheck was resource-killed.",
    });
  });

  it("maps desktop action path availability from the subscribed snapshot", () => {
    const base = {
      type: "subscribed" as const,
      version: 2 as const,
      sandbox: { status: null, sandboxId: null, connected: false, spawnDurationMs: null },
      queue: { queuedCount: 0, processingPromptId: null },
      prompts: [],
      lastDurableSequence: 0,
      replay: {
        afterSequence: 0,
        events: [],
        hasMore: false,
        droppedCount: 0,
        firstSequence: null,
        lastSequence: null,
      },
    };
    const sessionBase = {
      sessionId: "s-1",
      ownerUserId: "u-1",
      phase: "idle" as const,
      displayStatus: "stopped" as const,
      createdAt: "2026-04-02T12:00:00.000Z",
      updatedAt: "2026-04-02T12:00:00.000Z",
      closedAt: null,
      lastEventId: null,
      title: "Desktop",
      model: null,
      planApprovalPending: false,
      planRevision: 0,
      planStatus: "none" as const,
    };

    expect(
      toSubscribedSessionDetail({ ...base, session: { ...sessionBase, desktopActionPathAvailable: true } }, null)
        .desktopActionPathAvailable,
    ).toBe(true);
    expect(
      toSubscribedSessionDetail({ ...base, session: { ...sessionBase, desktopActionPathAvailable: false } }, null)
        .desktopActionPathAvailable,
    ).toBe(false);
    expect(toSubscribedSessionDetail({ ...base, session: sessionBase }, null).desktopActionPathAvailable).toBe(false);
  });

  it("carries reviewLoopDoneState from the subscribed snapshot (live review-loop indicator)", () => {
    const base = {
      type: "subscribed" as const,
      version: 2 as const,
      sandbox: { status: null, sandboxId: null, connected: false, spawnDurationMs: null },
      queue: { queuedCount: 0, processingPromptId: null },
      prompts: [],
      lastDurableSequence: 0,
      replay: {
        afterSequence: 0,
        events: [],
        hasMore: false,
        droppedCount: 0,
        firstSequence: null,
        lastSequence: null,
      },
    };
    const sessionBase = {
      sessionId: "s-1",
      ownerUserId: "u-1",
      planApprovalPending: false,
      planRevision: 0,
      planStatus: "none" as const,
      phase: "review_listening" as const,
      displayStatus: "completed" as const,
      createdAt: "2026-06-08T12:00:00.000Z",
      updatedAt: "2026-06-08T12:00:00.000Z",
      closedAt: null,
      lastEventId: null,
      title: "Caught up",
      model: null,
    };

    // A non-null claim must reach the detail so the badge/dot render live on WS connect/reconnect.
    expect(
      toSubscribedSessionDetail({ ...base, session: { ...sessionBase, reviewLoopDoneState: "done" } }, null)
        .reviewLoopDoneState,
    ).toBe("done");

    // Absent on the snapshot -> null (no claim), never undefined.
    expect(toSubscribedSessionDetail({ ...base, session: sessionBase }, null).reviewLoopDoneState).toBeNull();
  });

  it("carries canonical verification fields from the subscribed snapshot", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          phase: "review_listening",
          displayStatus: "completed",
          createdAt: "2026-06-08T12:00:00.000Z",
          updatedAt: "2026-06-08T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Verified",
          model: null,
          verificationState: "verification-done",
          verificationResult: "merge-ready",
          verificationNeedsWorkLabel: null,
          verificationAttemptCount: 2,
          verificationMaxAttempts: 3,
        },
        sandbox: { status: null, sandboxId: null, connected: false, spawnDurationMs: null },
        queue: { queuedCount: 0, processingPromptId: null },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session).toMatchObject({
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationNeedsWorkLabel: null,
      verificationAttemptCount: 2,
      verificationMaxAttempts: 3,
    });
  });

  it("carries plan-approval park metadata from the subscribed snapshot", () => {
    // Rehydrates the plan-approval park across reload / reconnect so the header
    // "Needs you" chip, watchdog disarm, and Discuss composer survive the bootstrap.
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: true,
          planRevision: 3,
          planStatus: "pending",
          planAutoReason: "The task needs sequencing across files.",
          phase: "waiting_for_input",
          displayStatus: "waiting_for_input",
          createdAt: "2026-07-09T12:00:00.000Z",
          updatedAt: "2026-07-09T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Plan ready",
          model: null,
        },
        sandbox: { status: null, sandboxId: null, connected: false, spawnDurationMs: null },
        queue: { queuedCount: 0, processingPromptId: null },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session).toMatchObject({
      planApprovalPending: true,
      planRevision: 3,
      planStatus: "pending",
      planAutoReason: "The task needs sequencing across files.",
    });
  });

  it("defaults the plan Auto reason to null when the snapshot omits it", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: true,
          planRevision: 3,
          planStatus: "pending",
          phase: "waiting_for_input",
          displayStatus: "waiting_for_input",
          createdAt: "2026-07-09T12:00:00.000Z",
          updatedAt: "2026-07-09T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Plan ready",
          model: null,
        },
        sandbox: { status: null, sandboxId: null, connected: false, spawnDurationMs: null },
        queue: { queuedCount: 0, processingPromptId: null },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session.planAutoReason).toBeNull();
  });

  it("carries lifecycle stage from the subscribed snapshot", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          phase: "completed",
          displayStatus: "completed",
          uiLifecycleStage: "merge_ready",
          createdAt: "2026-06-08T12:00:00.000Z",
          updatedAt: "2026-06-08T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Merge ready",
          model: null,
        },
        sandbox: { status: null, sandboxId: null, connected: false, spawnDurationMs: null },
        queue: { queuedCount: 0, processingPromptId: null },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session.uiLifecycleStage).toBe("merge_ready");
  });

  it("maps parent and child session metadata from the subscribed snapshot", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "child-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          phase: "idle",
          displayStatus: "stopped",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Child",
          model: null,
          parentSessionId: "parent-1",
          parentPromptId: "prompt-1",
          spawnDepth: 1,
          childSessionIds: ["grandchild-1"],
          qaChildSessionId: "grandchild-qa",
        },
        sandbox: { status: null, sandboxId: null, connected: false, spawnDurationMs: null },
        queue: { queuedCount: 0, processingPromptId: null },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session.parentSessionId).toBe("parent-1");
    expect(session.parentPromptId).toBe("prompt-1");
    expect(session.spawnDepth).toBe(1);
    expect(session.childSessionIds).toEqual(["grandchild-1"]);
    expect(session.qaChildSessionId).toBe("grandchild-qa");
  });

  it("maps QA run metadata from the subscribed snapshot", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          phase: "idle",
          displayStatus: "stopped",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Parent",
          model: null,
          qaRun: {
            state: "verification-done",
            verdict: "needs-work",
            childSessionId: "qa-child",
            runId: 9,
            head: "head-sha",
            attemptCount: 2,
            maxAttempts: 3,
            evidenceCount: 5,
            blockers: ["Runtime smoke failed."],
          },
        },
        sandbox: { status: null, sandboxId: null, connected: false, spawnDurationMs: null },
        queue: { queuedCount: 0, processingPromptId: null },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session.qaRun).toEqual({
      state: "verification-done",
      verdict: "needs-work",
      childSessionId: "qa-child",
      runId: 9,
      head: "head-sha",
      attemptCount: 2,
      maxAttempts: 3,
      evidenceCount: 5,
      blockers: ["Runtime smoke failed."],
    });
  });

  it("preserves the existing model when the subscribed snapshot omits it", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          phase: "idle",
          displayStatus: "stopped",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Test",
          model: null,
        },
        sandbox: {
          status: null,
          sandboxId: null,
          connected: false,
          spawnDurationMs: null,
        },
        queue: {
          queuedCount: 0,
          processingPromptId: null,
        },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      {
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
    );

    expect(session.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
    });
  });

  it("maps the subscribed model id back to a ModelSelection", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          phase: "idle",
          displayStatus: "stopped",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Test",
          model: "gpt-5.3-codex",
        },
        sandbox: {
          status: null,
          sandboxId: null,
          connected: false,
          spawnDurationMs: null,
        },
        queue: {
          queuedCount: 2,
          processingPromptId: "p-1",
        },
        prompts: [],
        lastDurableSequence: 5,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
      MOCK_PROVIDERS,
    );

    expect(session.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5.3-codex",
    });
    expect(session.queueLength).toBe(2);
  });

  it("preserves closeReason from the subscribed snapshot", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          phase: "archived",
          displayStatus: "archived",
          closeReason: "pr_merged",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: "2026-04-02T12:05:00.000Z",
          lastEventId: null,
          title: "Test",
          model: null,
          prUrl: "https://github.com/org/repo/pull/42",
        },
        sandbox: {
          status: "stopped",
          sandboxId: null,
          connected: false,
          spawnDurationMs: null,
        },
        queue: {
          queuedCount: 0,
          processingPromptId: null,
        },
        prompts: [],
        lastDurableSequence: 5,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session.closeReason).toBe("pr_merged");
  });

  it("preserves owner profile metadata from the subscribed snapshot", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          ownerLogin: "session-owner",
          ownerAvatarUrl: "https://avatars.example.com/session-owner.png",
          phase: "idle",
          displayStatus: "stopped",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Test",
          model: null,
        },
        sandbox: {
          status: null,
          sandboxId: null,
          connected: false,
          spawnDurationMs: null,
        },
        queue: {
          queuedCount: 0,
          processingPromptId: null,
        },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session.ownerLogin).toBe("session-owner");
    expect(session.ownerAvatarUrl).toBe("https://avatars.example.com/session-owner.png");
  });

  it("preserves explicit null owner profile metadata from the subscribed snapshot", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          ownerLogin: null,
          ownerAvatarUrl: null,
          phase: "idle",
          displayStatus: "stopped",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Test",
          model: null,
        },
        sandbox: {
          status: null,
          sandboxId: null,
          connected: false,
          spawnDurationMs: null,
        },
        queue: {
          queuedCount: 0,
          processingPromptId: null,
        },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session).toHaveProperty("ownerLogin", null);
    expect(session).toHaveProperty("ownerAvatarUrl", null);
  });

  it("preserves existing owner profile metadata when the subscribed snapshot omits it", () => {
    const currentSession = {
      model: { providerID: "openai", modelID: "gpt-5.4" },
      ownerLogin: "session-owner",
      ownerAvatarUrl: "https://avatars.example.com/session-owner.png",
    } satisfies Pick<SessionDetail, "model" | "ownerLogin" | "ownerAvatarUrl">;

    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          phase: "idle",
          displayStatus: "stopped",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Test",
          model: null,
        },
        sandbox: {
          status: null,
          sandboxId: null,
          connected: false,
          spawnDurationMs: null,
        },
        queue: {
          queuedCount: 0,
          processingPromptId: null,
        },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      currentSession,
      MOCK_PROVIDERS,
    );

    expect(session.ownerLogin).toBe("session-owner");
    expect(session.ownerAvatarUrl).toBe("https://avatars.example.com/session-owner.png");
    expect(session.model).toEqual({ providerID: "openai", modelID: "gpt-5.4" });
  });

  it("lets explicit null owner profile metadata clear previously known values", () => {
    const currentSession = {
      model: null,
      ownerLogin: "session-owner",
      ownerAvatarUrl: "https://avatars.example.com/session-owner.png",
    } satisfies Pick<SessionDetail, "model" | "ownerLogin" | "ownerAvatarUrl">;

    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          ownerLogin: null,
          ownerAvatarUrl: null,
          phase: "idle",
          displayStatus: "stopped",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Test",
          model: null,
        },
        sandbox: {
          status: null,
          sandboxId: null,
          connected: false,
          spawnDurationMs: null,
        },
        queue: {
          queuedCount: 0,
          processingPromptId: null,
        },
        prompts: [],
        lastDurableSequence: 0,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      currentSession,
    );

    expect(session).toHaveProperty("ownerLogin", null);
    expect(session).toHaveProperty("ownerAvatarUrl", null);
  });

  it("maps live sandbox state, reasoning effort, and QA verification fields from the subscribed snapshot", () => {
    const base = {
      type: "subscribed" as const,
      version: 2 as const,
      queue: { queuedCount: 0, processingPromptId: null },
      prompts: [],
      lastDurableSequence: 0,
      replay: {
        afterSequence: 0,
        events: [],
        hasMore: false,
        droppedCount: 0,
        firstSequence: null,
        lastSequence: null,
      },
    };
    const sessionBase = {
      sessionId: "s-1",
      ownerUserId: "u-1",
      planApprovalPending: false,
      planRevision: 0,
      planStatus: "none" as const,
      phase: "running" as const,
      displayStatus: "working" as const,
      createdAt: "2026-07-08T12:00:00.000Z",
      updatedAt: "2026-07-08T12:00:00.000Z",
      closedAt: null,
      lastEventId: null,
      title: "Live sandbox",
      model: null,
    };

    const session = toSubscribedSessionDetail(
      {
        ...base,
        session: {
          ...sessionBase,
          reasoningEffort: "high",
          verificationState: "verification-done",
          verificationResult: "merge-ready",
        },
        sandbox: { status: "ready", sandboxId: "sbx_live_1", connected: true, spawnDurationMs: 2100 },
      },
      null,
    );

    expect(session.sandboxId).toBe("sbx_live_1");
    expect(session.sandboxConnected).toBe(true);
    expect(session.reasoningEffort).toBe("high");
    expect(session.verificationState).toBe("verification-done");
    expect(session.verificationResult).toBe("merge-ready");

    // Absent on the snapshot -> null (never undefined), matching the fetch mapper.
    const bare = toSubscribedSessionDetail(
      {
        ...base,
        session: sessionBase,
        sandbox: { status: null, sandboxId: null, connected: false, spawnDurationMs: null },
      },
      null,
    );
    expect(bare.sandboxId).toBeNull();
    expect(bare.sandboxConnected).toBe(false);
    expect(bare.reasoningEffort).toBeNull();
    expect(bare.verificationState).toBeNull();
    expect(bare.verificationResult).toBeNull();
  });

  it("maps preview and verification metadata from the subscribed snapshot", () => {
    const session = toSubscribedSessionDetail(
      {
        type: "subscribed",
        version: 2,
        session: {
          sessionId: "s-1",
          ownerUserId: "u-1",
          planApprovalPending: false,
          planRevision: 0,
          planStatus: "none",
          phase: "idle",
          displayStatus: "stopped",
          createdAt: "2026-04-02T12:00:00.000Z",
          updatedAt: "2026-04-02T12:00:00.000Z",
          closedAt: null,
          lastEventId: null,
          title: "Test",
          model: null,
          prUrl: "https://github.com/org/repo/pull/42",
          verification: {
            verified: true,
            status: "passed",
            mode: "browser",
            explanation: "Verified in browser",
            artifacts: [
              {
                type: "screenshot",
                label: "homepage",
                url: "https://artifacts.example.com/homepage.png",
              },
            ],
          },
          runtimeProvenance: {
            bootMode: "fresh_clone",
            modalEnvironment: "shiv-test",
            sandboxImageVersion: "sandbox-v2",
            repoImagePrimaryBootEnabled: false,
            repoImagePrimaryBootBlockedReason: "missing_sandbox_image_version",
            modalObjectId: "mo-123",
            runtime: {
              modalImageId: "im-123",
              reportedAt: 123,
            },
            updatedAt: 456,
          },
          observabilityReadiness: {
            traceExport: false,
            ddLogs: true,
            tracingState: "disabled",
          },
        },
        sandbox: {
          status: "ready",
          sandboxId: "sandbox-1",
          connected: true,
          spawnDurationMs: 1234,
        },
        queue: {
          queuedCount: 0,
          processingPromptId: null,
        },
        prompts: [],
        lastDurableSequence: 5,
        replay: {
          afterSequence: 0,
          events: [],
          hasMore: false,
          droppedCount: 0,
          firstSequence: null,
          lastSequence: null,
        },
      },
      null,
    );

    expect(session.verification).toMatchObject({
      verified: true,
      status: "passed",
      mode: "browser",
      explanation: "Verified in browser",
    });
    expect(session.verification?.artifacts).toEqual([
      {
        type: "screenshot",
        label: "homepage",
        url: "https://artifacts.example.com/homepage.png",
      },
    ]);
    expect(session.runtimeProvenance).toMatchObject({
      bootMode: "fresh_clone",
      modalEnvironment: "shiv-test",
      sandboxImageVersion: "sandbox-v2",
      repoImagePrimaryBootBlockedReason: "missing_sandbox_image_version",
    });
    expect(session.runtimeProvenance?.runtime).toMatchObject({
      modalImageId: "im-123",
    });
    expect(session.observabilityReadiness).toEqual({
      traceExport: false,
      ddLogs: true,
      tracingState: "disabled",
    });
  });
});
