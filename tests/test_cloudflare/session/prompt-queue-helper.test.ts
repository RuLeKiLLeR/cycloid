import { beforeEach, describe, expect, it, vi } from "vitest";

import { E2E_TESTED_LABEL } from "../../../apps/control-plane-worker/src/constants/pr-labels";
import {
  PENDING_ANSWER_STORAGE_KEY,
  type PendingAnswerRecord,
  PROMPT_STOPPED_BY_STORAGE_KEY,
} from "../../../apps/control-plane-worker/src/constants/sessions";

const mockFetchVerificationPrContext = vi.hoisted(() => vi.fn());
const mockPublishManagedVerificationComment = vi.hoisted(() => vi.fn());
const mockPublishVerificationSkippedComment = vi.hoisted(() => vi.fn());
const mockPublishArtifactsForVerificationComment = vi.hoisted(() => vi.fn());
const mockCreateInstallationToken = vi.hoisted(() => vi.fn());
const mockReconcilePrDraftStateForPr = vi.hoisted(() => vi.fn());
const mockSyncVerificationResultForPr = vi.hoisted(() => vi.fn());
const mockSyncVerificationStateForPr = vi.hoisted(() => vi.fn());
const mockGetSessionState = vi.hoisted(() => vi.fn());
const mockShadowEmitVerifierTerminalVerdict = vi.hoisted(() => vi.fn());
const mockPostIssueCommentReaction = vi.hoisted(() => vi.fn());
const mockEnsureRepoLabel = vi.hoisted(() => vi.fn());
const mockAddLabels = vi.hoisted(() => vi.fn());
const mockGetInstallationByOwner = vi.hoisted(() => vi.fn());

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const mockPostStructuredEventToDd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", async () => {
  const actual = await vi.importActual<
    typeof import("../../../apps/control-plane-worker/src/observability/events-exporter")
  >("../../../apps/control-plane-worker/src/observability/events-exporter");
  return {
    ...actual,
    postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/github/verification-pr-context", () => ({
  fetchVerificationPrContext: mockFetchVerificationPrContext,
  parseGithubPullRequestUrl: (value: string) => {
    const match = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
    return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null;
  },
}));

vi.mock("../../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: mockCreateInstallationToken,
  createScopedInstallationToken: mockCreateInstallationToken,
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
}));

vi.mock("../../../apps/control-plane-worker/src/github/issues", () => ({
  GITHUB_QA_FINISHED_REACTION: "+1",
  postIssueCommentReaction: (...args: unknown[]) => mockPostIssueCommentReaction(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/github/pr", async () => {
  const actual = await vi.importActual<typeof import("../../../apps/control-plane-worker/src/github/pr")>(
    "../../../apps/control-plane-worker/src/github/pr",
  );
  return {
    ...actual,
    ensureRepoLabel: (...args: unknown[]) => mockEnsureRepoLabel(...args),
    addLabels: (...args: unknown[]) => mockAddLabels(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/github/installations-db", async () => {
  const actual = await vi.importActual<typeof import("../../../apps/control-plane-worker/src/github/installations-db")>(
    "../../../apps/control-plane-worker/src/github/installations-db",
  );
  return {
    ...actual,
    getInstallationByOwner: (...args: unknown[]) => mockGetInstallationByOwner(...args),
  };
});

vi.mock("../../../apps/control-plane-worker/src/github/verification-comment", () => ({
  publishManagedVerificationComment: (...args: unknown[]) => mockPublishManagedVerificationComment(...args),
  publishVerificationSkippedComment: (...args: unknown[]) => mockPublishVerificationSkippedComment(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/github-release-evidence", () => ({
  GithubReleaseEvidenceService: vi.fn().mockImplementation(function () {
    return {
      publishArtifactsForVerificationComment: mockPublishArtifactsForVerificationComment,
    };
  }),
}));

vi.mock("../../../apps/control-plane-worker/src/session/pr-draft-reconciliation", () => ({
  reconcilePrDraftStateForPr: (...args: unknown[]) => mockReconcilePrDraftStateForPr(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/verification-state", () => ({
  syncVerificationResultForPr: (...args: unknown[]) => mockSyncVerificationResultForPr(...args),
  syncVerificationStateForPr: (...args: unknown[]) => mockSyncVerificationStateForPr(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/session/fsm/verification-producer", async () => {
  const actual = await vi.importActual<
    typeof import("../../../apps/control-plane-worker/src/session/fsm/verification-producer")
  >("../../../apps/control-plane-worker/src/session/fsm/verification-producer");
  return {
    ...actual,
    shadowEmitVerifierTerminalVerdict: (...args: unknown[]) => mockShadowEmitVerifierTerminalVerdict(...args),
  };
});

// Spy on the per-PR verification lock release/refresh so tests can assert the
// lock is freed on terminal stop paths without wiring a real D1 lock store
// (env.DB is an empty stub here). Preserve every other gate export.
vi.mock("../../../apps/control-plane-worker/src/session/verification-gate", async () => {
  const actual = await vi.importActual<
    typeof import("../../../apps/control-plane-worker/src/session/verification-gate")
  >("../../../apps/control-plane-worker/src/session/verification-gate");
  return { ...actual };
});

import * as Sentry from "@sentry/cloudflare";

import type { Logger } from "../../../apps/control-plane-worker/src/logger";
import * as observabilityContext from "../../../apps/control-plane-worker/src/observability/context";
import {
  appendEventsWithReplay,
  bulkUpdatePrompts,
  ensureSandboxState,
  getLatestSessionPlan,
  getPrompts,
  getSessionExtended,
  updatePromptPushOutcome,
  updateSessionFields,
  upsertPromptTelemetry,
  upsertSessionPlan,
} from "../../../apps/control-plane-worker/src/session/do-db.ts";
import {
  buildPromptCommand,
  buildSandboxCallbackContract,
  clonePromptForRetry,
  createSessionPromptQueue,
  derivePromptBranchNameHint,
  getQueueState,
  hasCompletionProgressContext,
  NON_EXECUTION_TRACE_ERROR_CODES,
  PREPARED_SESSION_TITLE_ENQUEUE_TIMEOUT_MS,
  resolvePromptAgentRoleForBridge,
  toClientPrompt,
  toClientPromptWithActorProfile,
  validatePromptEnqueueResumeState,
} from "../../../apps/control-plane-worker/src/session/prompt-queue";
import type { PromptState, SessionState } from "../../../apps/control-plane-worker/src/types";
import { turnModeForAgentProfile } from "../../../shared/agent/constants";
import type { BridgeEvent as SandboxEvent } from "../../../shared/events/bridge";
import { isPromptSendDisabled, PROMPT_SEND_BLOCKED_ERROR } from "../../../shared/session/eligibility";
import type { Phase, SandboxSubstate, StopMode } from "../../../shared/session/phase";
import type { PublishStatus } from "../../../shared/types/publish";
import type { ClientPrompt } from "../../../shared/types/session-websocket";
import { FakeStorage } from "./helpers.ts";

class MemoryStorage extends FakeStorage {}

beforeEach(() => {
  mockPostStructuredEventToDd.mockClear();
  mockFetchVerificationPrContext.mockReset();
  mockPublishManagedVerificationComment.mockReset().mockResolvedValue({
    ok: true,
    commentId: 123,
    action: "updated",
    malformed: false,
  });
  mockPublishVerificationSkippedComment.mockReset().mockResolvedValue({
    ok: true,
    commentId: 124,
    action: "updated",
    malformed: false,
  });
  mockPublishArtifactsForVerificationComment.mockReset().mockResolvedValue([]);
  mockCreateInstallationToken.mockReset().mockResolvedValue("ghs_release_token");
  mockReconcilePrDraftStateForPr.mockReset().mockResolvedValue({ sessionCount: 1, updated: 1, skipped: 0, failed: 0 });
  mockSyncVerificationResultForPr.mockReset().mockResolvedValue(undefined);
  mockSyncVerificationStateForPr.mockReset().mockResolvedValue(undefined);
  mockGetSessionState.mockReset().mockResolvedValue(null);
  mockShadowEmitVerifierTerminalVerdict.mockReset().mockResolvedValue(undefined);
  mockPostIssueCommentReaction.mockReset().mockResolvedValue(undefined);
  mockEnsureRepoLabel.mockReset().mockResolvedValue({ ok: true, created: false });
  mockAddLabels.mockReset().mockResolvedValue(undefined);
  mockGetInstallationByOwner.mockReset().mockResolvedValue({ installation_id: 456, suspended_at: null });
});

function makePrompt(overrides: Partial<PromptState> = {}): PromptState {
  return {
    promptId: "prompt-1",
    prompt: "Fix the queue extraction",
    actorUserId: "user-1",
    status: "processing",
    createdAt: "2026-04-01T12:00:00.000Z",
    startedAt: "2026-04-01T12:00:01.000Z",
    completedAt: null,
    updatedAt: "2026-04-01T12:00:01.000Z",
    result: null,
    error: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "session-1",
    ownerUserId: "user-1",
    status: "active",
    createdAt: "2026-04-01T12:00:00.000Z",
    updatedAt: "2026-04-01T12:00:00.000Z",
    closedAt: null,
    lastEventId: null,
    title: null,
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    ...overrides,
  };
}

function makeValidPlanMarkdown(): string {
  return [
    "# Plan",
    "## Intent Restatement",
    "Fix the queue extraction.",
    "## Scope In/Out",
    "In: prompt queue. Out: UI.",
    "## Approach",
    "Read the queue code and patch the narrow path.",
    "## Ordered Steps",
    "1. Inspect queue helpers.",
    "2. Patch dispatch.",
    "## Files To Touch",
    "- apps/control-plane-worker/src/session/prompt-queue.ts",
    "## Verification Plan",
    "- Run focused queue tests.",
    "## Risks",
    "- Dispatch ordering regression.",
    "## Breadth",
    "S because this is a narrow queue change.",
    "## Open Assumptions",
    "- Existing queue ordering is authoritative.",
  ].join("\n\n");
}

function createHost(storage: MemoryStorage, envOverrides: Record<string, unknown> = {}) {
  const sentCommands: Array<Record<string, unknown>> = [];
  const listSessionPrompts = vi.fn(async (): Promise<ClientPrompt[]> => []);
  let sandboxSocket: WebSocket | null = { readyState: 1 } as WebSocket;
  let terminalSideEffectsQueue: Promise<void> = Promise.resolve();
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;

  const host = {
    get state() {
      return { storage } as DurableObjectState;
    },
    get env() {
      return { DD_API_KEY: "test-dd-key", WORKER_ENV: "test", ...envOverrides };
    },
    get log() {
      return logger;
    },
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      void promise;
    }),
    fetchInternal: vi.fn(async () => new Response("not found", { status: 404 })),
    capturePromptFinalizeContext: vi.fn((_sessionId: string) => ({
      repo: "acme/repo",
      sandboxId: "sandbox-1",
      modalObjectId: "modal-1",
      codexSessionId: "codex-1",
      promptDispatchedToAgent: null,
    })),
    enqueueTerminalSideEffects: vi.fn((task: () => Promise<void>) => {
      const queuedTask = terminalSideEffectsQueue.catch(() => undefined).then(task);
      terminalSideEffectsQueue = queuedTask.catch(() => undefined);
    }),
    getSandboxSocket: () => sandboxSocket,
    getSandboxHeartbeatFreshness: vi.fn(async () => ({ lastHeartbeatAt: Date.now(), ageMs: 0, fresh: true })),
    // Mirrors the DO implementation's observable effects: the transport is
    // finalized as stopped/reaped in D1 and the socket is gone afterward.
    discardStaleSandboxTransport: vi.fn(async (sessionId: string, _reason: string) => {
      storage.sql.exec(
        "UPDATE sandbox_state SET status = 'stopped', stop_reason = 'reaped' WHERE session_id = ?",
        sessionId,
      );
      sandboxSocket = null;
    }),
    sendToSandbox: vi.fn((command: Record<string, unknown>) => {
      sentCommands.push(command);
    }),
    uploadPlanMarkdownArtifact: vi.fn(async () => "artifact-plan-1"),
    notePromptTransition: vi.fn(async (_sessionId: string, promptId: string | null) => {
      await storage.put("activePromptId", promptId);
    }),
    putSandboxStatus: vi.fn(async () => {}),
    getReplayState: vi.fn(async () => ({
      sessionId: "session-1",
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    })),
    setHasPendingQuestion: vi.fn(async () => {}),
    setPendingPromptDispatch: vi.fn(async (value: boolean) => {
      await storage.put("pending_prompt_dispatch", value);
    }),
    isCurrentSpawnAttempt: vi.fn(async () => true),
    clearSpawnAttemptState: vi.fn(async () => {}),
    stopIdleSessionAtDurabilityBoundary: vi.fn(async () => {}),
    stopSessionKeepAlive: vi.fn(async () => {}),
    isUserStopped: vi.fn(() => false),
    startSpawnAttempt: vi.fn(async () => "attempt-1"),
    checkSessionResumeRateLimit: vi.fn(async () => ({ limited: false })),
    schedulePromptExecutionAlarm: vi.fn(async () => {}),
    rescheduleSessionAlarm: vi.fn(async () => {}),
    onPlanApprovalParked: vi.fn(async () => {}),
    onPlanApprovalDiscussion: vi.fn(async () => {}),
    onPlanApprovalApproved: vi.fn(async () => {}),
    onPlanApprovalStopped: vi.fn(async () => {}),
    cancelPlanParkPause: vi.fn(async () => {}),
    finalizePromptRun: vi.fn(),
    runMemoryReviewBot: vi.fn(async () => {}),
    writeUsageToD1: vi.fn(),
    writeCompletionToD1: vi.fn(),
    appendAndMirrorEvents: vi.fn(async () => ({
      events: [],
      replay: {
        sessionId: "session-1",
        lastEventSequence: 0,
        lastEventTimestamp: null,
        updatedAt: null,
      },
    })),
    notifySlackThread: vi.fn(async () => {}),
    triggerPrCreation: vi.fn(async () => {}),
    triggerPrUpdate: vi.fn(async () => {}),
    failPublishOnPushOutcome: vi.fn(async () => {}),
    listSessionPrompts,
    prepareSessionTitle: vi.fn(async () => null),
    generateSessionTitle: vi.fn(async () => {}),
    generatePromptCallbackAuth: vi.fn(async () => "Bearer test-callback-token"),
    markReviewLoopEpochProcessing: vi.fn(async () => {}),
    resolveReviewLoopEpochForTerminalPrompt: vi.fn(async () => {}),
    blockReviewLoopEpochForUnrecoverablePrompt: vi.fn(async () => {}),
    resolvePromptActorProfile: vi.fn(async () => null),
    armPlatformLlmPostExecutionWindow: vi.fn(async () => "terminalize" as const),
    markPlatformLlmPromptTerminal: vi.fn(),
    broadcast: vi.fn(),
  };

  return {
    host,
    sentCommands,
    setSandboxSocket: (ws: WebSocket | null) => {
      sandboxSocket = ws;
    },
    flushTerminalSideEffects: async () => {
      await terminalSideEffectsQueue;
    },
  };
}

function createChildLookupDb(row: Record<string, unknown>): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => row),
      })),
    })),
  } as unknown as D1Database;
}

function structuredEventPayloads(event: string): Record<string, unknown>[] {
  return mockPostStructuredEventToDd.mock.calls.flatMap(([, payload]) =>
    (payload as { event?: unknown })?.event === event ? [payload as Record<string, unknown>] : [],
  );
}

function latestStructuredEventPayload(event: string): Record<string, unknown> | undefined {
  return structuredEventPayloads(event).at(-1);
}

describe("prompt-queue helper", () => {
  it("builds default implementation prompt metadata without forcing an explicit agent", () => {
    expect(buildPromptCommand(makePrompt(), makeSession())).toMatchObject({
      type: "prompt",
      messageId: "prompt-1",
      agent: undefined,
      agentRole: "implementation",
      agentProfile: "build",
      harnessKind: "codex-session",
      runtimeStartupProfile: "implementation_default",
    });
  });

  it("routes the first plan-mode prompt through the internal plan profile", () => {
    expect(buildPromptCommand(makePrompt({ promptId: "p-1" }), makeSession({ planMode: true }))).toMatchObject({
      type: "prompt",
      messageId: "p-1",
      agent: "plan",
      agentRole: "implementation",
      agentProfile: "plan",
      runtimeStartupProfile: "implementation_default",
    });
  });

  it("does not reuse the plan profile for implementation handoff prompts", () => {
    expect(buildPromptCommand(makePrompt({ promptId: "p-2" }), makeSession({ planMode: true }))).toMatchObject({
      type: "prompt",
      messageId: "p-2",
      agent: undefined,
      agentRole: "implementation",
      agentProfile: "build",
    });
  });

  it("keeps a retried plan turn in the plan profile via the isPlanPrompt marker", () => {
    // A mid-turn disconnect/spawn-timeout retry clones p-1 to a fresh id but
    // stamps isPlanPrompt, so it must still dispatch read-only (not build).
    expect(
      buildPromptCommand(makePrompt({ promptId: "p-2", isPlanPrompt: true }), makeSession({ planMode: true })),
    ).toMatchObject({
      type: "prompt",
      messageId: "p-2",
      agent: "plan",
      agentProfile: "plan",
    });
  });

  it("propagates the isPlanPrompt marker across a retry clone", () => {
    const retry = clonePromptForRetry(
      makePrompt({ promptId: "p-1", isPlanPrompt: true, status: "failed" }),
      "p-2",
      "2026-04-01T12:06:00.000Z",
      "processing",
    );
    expect(retry.isPlanPrompt).toBe(true);
    // A non-plan prompt does not gain the marker.
    expect(
      clonePromptForRetry(makePrompt({ promptId: "p-1" }), "p-2", "2026-04-01T12:06:00.000Z", "processing")
        .isPlanPrompt,
    ).toBeUndefined();
  });

  it("preserves plan context across implementation retry clones", () => {
    const planContext = {
      planPromptId: "p-1",
      valid: true,
      excerpt: "# Plan\n\n## Files To Touch\n- shared/plan-mode.ts",
      artifactId: null,
      missingReason: null,
    };

    const retry = clonePromptForRetry(
      makePrompt({ promptId: "p-2", planContext, status: "failed" }),
      "p-3",
      "2026-04-01T12:06:00.000Z",
      "processing",
    );

    expect(retry.planContext).toEqual(planContext);
    expect(
      clonePromptForRetry(makePrompt({ promptId: "p-2" }), "p-3", "2026-04-01T12:06:00.000Z", "processing"),
    ).not.toHaveProperty("planContext");
  });

  it("builds verification prompt metadata from the session role", () => {
    expect(
      buildPromptCommand(
        makePrompt(),
        makeSession({
          agentRole: "verification",
          agentProfile: "verify",
          harnessKind: "codex-session",
          runtimeStartupProfile: "verification_ready_runtime",
          targetPrUrl: "https://github.com/org/repo/pull/123",
        }),
      ),
    ).toMatchObject({
      type: "prompt",
      messageId: "prompt-1",
      agent: "verify",
      agentRole: "verification",
      agentProfile: "verify",
      harnessKind: "codex-session",
      runtimeStartupProfile: "verification_ready_runtime",
      verificationRuntimeMode: "none",
      targetPrUrl: "https://github.com/org/repo/pull/123",
    });
  });

  it("normalizes explicit verify agent to verification role metadata", () => {
    expect(buildPromptCommand(makePrompt({ agent: "verify" }), makeSession())).toMatchObject({
      type: "prompt",
      messageId: "prompt-1",
      agent: "verify",
      agentRole: "verification",
      agentProfile: "verify",
      harnessKind: "codex-session",
      runtimeStartupProfile: "verification_ready_runtime",
      verificationRuntimeMode: "none",
    });
  });

  it("derives verification startup profile when only the role is present", () => {
    expect(buildPromptCommand(makePrompt(), makeSession({ agentRole: "verification" }))).toMatchObject({
      type: "prompt",
      agent: "verify",
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      verificationRuntimeMode: "none",
    });
  });

  it("keeps code review prompts on their independent role and implementation-default runtime", () => {
    expect(
      buildPromptCommand(makePrompt(), makeSession({ agentRole: "review", agentProfile: "review" })),
    ).toMatchObject({
      type: "prompt",
      agent: "review",
      agentRole: "review",
      agentProfile: "review",
      runtimeStartupProfile: "implementation_default",
      verificationRuntimeMode: "none",
    });
  });

  it("upgrades legacy verification-role reviewer sessions to the independent review role", () => {
    expect(
      buildPromptCommand(makePrompt(), makeSession({ agentRole: "verification", agentProfile: "review" })),
    ).toMatchObject({
      agent: "review",
      agentRole: "review",
      agentProfile: "review",
      runtimeStartupProfile: "implementation_default",
    });
  });

  it("downgrades only reviewer prompts for pre-v2 bridge compatibility", () => {
    expect(resolvePromptAgentRoleForBridge("review", null)).toBe("review");
    expect(resolvePromptAgentRoleForBridge("review", 1)).toBe("verification");
    expect(resolvePromptAgentRoleForBridge("review", 2)).toBe("review");
    expect(resolvePromptAgentRoleForBridge("verification", 1)).toBe("verification");
    expect(resolvePromptAgentRoleForBridge("implementation", 1)).toBe("implementation");
  });

  it("pins the onboard profile against per-prompt agent overrides", () => {
    // A follow-up prompt with agent:"build" must not strip the onboarding
    // playbook from an onboarding session.
    expect(
      buildPromptCommand(
        makePrompt({ agent: "build" }),
        makeSession({ agentRole: "implementation", agentProfile: "onboard" }),
      ),
    ).toMatchObject({
      type: "prompt",
      agentRole: "implementation",
      agentProfile: "onboard",
      runtimeStartupProfile: "implementation_default",
    });
  });

  it("threads the onboard profile to the bridge for onboarding sessions", () => {
    expect(
      buildPromptCommand(makePrompt(), makeSession({ agentRole: "implementation", agentProfile: "onboard" })),
    ).toMatchObject({
      type: "prompt",
      agent: "onboard",
      agentRole: "implementation",
      agentProfile: "onboard",
    });
  });

  it("reports completion progress context from edit and prompt counts", () => {
    expect(hasCompletionProgressContext(0, 2)).toBe(true);
    expect(hasCompletionProgressContext(undefined, 2)).toBe(false);
  });

  it("reports queue state from prompt status and active prompt id", () => {
    const queue = getQueueState(
      [
        makePrompt({ promptId: "prompt-1", status: "processing" }),
        makePrompt({ promptId: "prompt-2", status: "queued" }),
        makePrompt({ promptId: "prompt-3", status: "queued" }),
      ],
      "prompt-1",
    );

    expect(queue).toEqual({ queuedCount: 2, processingPromptId: "prompt-1" });
  });

  it("returns the structured send-blocked envelope for every canonical disabled send phase", async () => {
    const disabledCases: Array<{
      reason: Phase;
      stopMode: StopMode;
      sandboxSubstate: SandboxSubstate;
      sessionStatus?: SessionState["status"];
      publishStatus?: string;
      sandboxStatus?: string;
      stopReason?: string;
    }> = [
      { reason: "archived", stopMode: "none", sandboxSubstate: "none", sessionStatus: "archived" },
      { reason: "failed", stopMode: "none", sandboxSubstate: "none", publishStatus: "failed" },
      { reason: "finalizing", stopMode: "none", sandboxSubstate: "none", publishStatus: "publishing" },
      {
        reason: "stopped",
        stopMode: "user",
        sandboxSubstate: "none",
        sandboxStatus: "stopped",
        stopReason: "user",
      },
    ];

    for (const testCase of disabledCases) {
      expect(isPromptSendDisabled(testCase.reason, testCase.stopMode, testCase.sandboxSubstate, false)).toBe(true);

      const storage = new MemoryStorage();
      const { host } = createHost(storage);
      await storage.put("session", makeSession({ status: testCase.sessionStatus ?? "active" }));
      ensureSandboxState(storage.sql as unknown as SqlStorage, "session-1");
      if (testCase.sandboxStatus) {
        storage.sql.exec(
          "UPDATE sandbox_state SET status = ?, stop_reason = ? WHERE session_id = ?",
          testCase.sandboxStatus,
          testCase.stopReason ?? null,
          "session-1",
        );
      }
      if (testCase.publishStatus) {
        storage.sql.exec(
          "UPDATE session SET publish_status = ? WHERE session_id = ?",
          testCase.publishStatus,
          "session-1",
        );
      }

      const queue = createSessionPromptQueue(host);
      const response = await queue.handlePromptEnqueueRequest(
        new Request("https://example.com/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: `blocked ${testCase.reason}` }),
        }),
      );

      expect(response.status, testCase.reason).toBe(409);
      await expect(response.json(), testCase.reason).resolves.toEqual({
        error: PROMPT_SEND_BLOCKED_ERROR,
        reason: testCase.reason,
      });
    }
  });

  it("builds callback contracts with attachments and model", () => {
    const prompt = makePrompt({
      status: "queued",
      files: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
      uploadedFiles: [{ name: "notes.txt", content: "internal" }],
      uploadedImages: [{ name: "diagram.png", mediaType: "image/png", data: "raw" }],
    });

    expect(buildSandboxCallbackContract("session-1", prompt, "Bearer test-token", "gpt-5.4-mini")).toEqual({
      sessionId: "session-1",
      promptId: "prompt-1",
      prompt: "Fix the queue extraction",
      model: "gpt-5.4-mini",
      files: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
      uploadedFiles: [{ name: "notes.txt", content: "internal" }],
      uploadedImages: [{ name: "diagram.png", mediaType: "image/png", data: "raw" }],
      callback: {
        method: "POST",
        path: "/internal/sandbox/sessions/session-1/prompts/prompt-1/callback",
        auth: "Bearer test-token",
      },
    });
  });

  it("clones retry prompts with terminal state cleared", () => {
    const retryPrompt = clonePromptForRetry(
      makePrompt({
        branchNameHint: "fix-queue-extraction",
        reviewLoopEpochId: "epoch-1",
        status: "failed",
        completedAt: "2026-04-01T12:05:00.000Z",
        error: "Sandbox disconnected while processing",
        files: ["README.md"],
        uploadedFiles: [{ name: "notes.txt", content: "keep me" }],
      }),
      "prompt-2",
      "2026-04-01T12:06:00.000Z",
      "queued",
    );

    expect(retryPrompt).toMatchObject({
      promptId: "prompt-2",
      prompt: "Fix the queue extraction",
      branchNameHint: "fix-queue-extraction",
      reviewLoopEpochId: "epoch-1",
      status: "queued",
      startedAt: null,
      completedAt: null,
      error: null,
      result: null,
      files: ["README.md"],
      uploadedFiles: [{ name: "notes.txt", content: "keep me" }],
    });
  });

  it("builds client prompts with attachment summaries and omits null optionals", () => {
    const clientPrompt = toClientPrompt(
      makePrompt({
        uploadedFiles: [{ name: "notes.txt", content: "keep secret" }],
        uploadedImages: [{ name: "diagram.png", mediaType: "image/png", data: "base64" }],
      }),
      "session-1",
      null,
      null,
      { includeUploadedImageData: true },
    );

    expect(clientPrompt.model).toBeUndefined();
    expect(clientPrompt.reasoningEffort).toBeUndefined();
    expect(clientPrompt.uploadedFiles).toEqual([{ name: "notes.txt" }]);
    expect(clientPrompt.uploadedImages).toEqual([{ name: "diagram.png", mediaType: "image/png", data: "base64" }]);
  });

  it("includes resolved actor profile fields in client prompts", () => {
    const clientPrompt = toClientPrompt(makePrompt(), "session-1", null, null, {
      actorProfile: {
        login: "teammate",
        avatarUrl: "https://avatars.example.com/teammate.png",
      },
    });

    expect(clientPrompt.actorLogin).toBe("teammate");
    expect(clientPrompt.actorAvatarUrl).toBe("https://avatars.example.com/teammate.png");
  });

  it("keeps client prompt serialization fail-open when actor profile resolution fails", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    host.resolvePromptActorProfile.mockRejectedValueOnce(new Error("D1 unavailable"));

    const clientPrompt = await toClientPromptWithActorProfile(host, makePrompt(), "session-1", null, null);

    expect(clientPrompt.promptId).toBe("prompt-1");
    expect(clientPrompt.actorLogin).toBeUndefined();
    expect(clientPrompt.actorAvatarUrl).toBeUndefined();
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        promptId: "prompt-1",
        actorUserId: "user-1",
        error: "Error: D1 unavailable",
      }),
      "Failed to resolve prompt actor profile",
    );
  });

  it("strips internal-only error detail fields from client prompts", () => {
    const clientPrompt = toClientPrompt(
      makePrompt({
        error: "Prompt failed",
        errorDetails: {
          message: "fetch failed",
          name: "TypeError",
          code: "ECONNRESET",
          stack: "TypeError: fetch failed\n    at sandbox",
          responseBodyPreview: '{"error":"secret"}',
          raw: '{"secret":"value"}',
          cause: {
            message: "connect ECONNRESET 127.0.0.1:12345",
            code: "ECONNRESET",
            stack: "Error: connect ECONNRESET",
          },
        },
      }),
      "session-1",
      null,
      null,
    );

    expect(clientPrompt.errorDetails).toEqual({
      message: "fetch failed",
      name: "TypeError",
      code: "ECONNRESET",
      cause: {
        message: "connect ECONNRESET 127.0.0.1:12345",
        code: "ECONNRESET",
      },
    });
  });

  it("preserves review-loop source kind through legacy prompt storage writes", async () => {
    const storage = new MemoryStorage();
    await storage.put("session", makeSession());
    await storage.put("prompts", [
      makePrompt({
        reviewLoopEpochId: "ep-human-1",
        reviewLoopSourceKind: "human",
      }),
    ]);

    const prompts = getPrompts(storage.sql as unknown as SqlStorage, "session-1");

    expect(prompts[0]?.reviewLoopEpochId).toBe("ep-human-1");
    expect(prompts[0]?.reviewLoopSourceKind).toBe("human");
  });

  it("includes sourceKind in bridge command when reviewLoopEpochId is set", () => {
    const prompt = makePrompt({
      reviewLoopEpochId: "ep-human-1",
      reviewLoopSourceKind: "human",
    });
    const command = buildPromptCommand(prompt, makeSession());

    expect(command.reviewLoopMode).toBe(true);
    expect(command.epochId).toBe("ep-human-1");
    expect(command.sourceKind).toBe("human");
  });

  it("includes sourceKind=bot in bridge command for bot-source epochs", () => {
    const prompt = makePrompt({
      reviewLoopEpochId: "ep-bot-1",
      reviewLoopSourceKind: "bot",
    });
    const command = buildPromptCommand(prompt, makeSession());

    expect(command.reviewLoopMode).toBe(true);
    expect(command.epochId).toBe("ep-bot-1");
    expect(command.sourceKind).toBe("bot");
  });

  it("omits sourceKind from bridge command when reviewLoopEpochId is absent", () => {
    const command = buildPromptCommand(makePrompt(), makeSession());

    expect(command.reviewLoopMode).toBeUndefined();
    expect(command.epochId).toBeUndefined();
    expect(command.sourceKind).toBeUndefined();
  });

  it("builds prompt commands with attachment fields passed through as-is", () => {
    const prompt = makePrompt({
      branchNameHint: "fix-queue-extraction",
      skills: ["review-spec"],
      files: ["src/session/prompt-queue.ts"],
      uploadedFiles: [{ name: "notes.txt", content: "raw content" }],
      uploadedImages: [{ name: "flow.png", mediaType: "image/png", data: "base64data" }],
    });
    const session = makeSession({ model: "gpt-5.4", reasoningEffort: null });

    const command = buildPromptCommand(prompt, session);

    expect(command.type).toBe("prompt");
    expect(command.actorUserId).toBe("user-1");
    expect(command.branchNameHint).toBe("fix-queue-extraction");
    expect(command.model).toBe("gpt-5.4");
    expect(command.reasoningEffort).toBeUndefined();
    expect(command.skills).toEqual(["review-spec"]);
    expect(command.files).toEqual(["src/session/prompt-queue.ts"]);
    expect(command.uploadedFiles).toEqual([{ name: "notes.txt", content: "raw content" }]);
    expect(command.uploadedImages).toEqual([{ name: "flow.png", mediaType: "image/png", data: "base64data" }]);
  });

  it("serializes prompt correlation from the active worker trace context", () => {
    vi.spyOn(observabilityContext, "injectTraceparent").mockReturnValueOnce(
      `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    );

    const command = buildPromptCommand(makePrompt(), makeSession());

    expect(command.correlation).toEqual({
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      sessionId: "session-1",
      promptId: "prompt-1",
    });
  });

  it("derives branch hints from the first non-metadata prompt line", () => {
    const prompt = [
      "Repository: trycycloid/cycloid",
      "Linear Issue: ARC-999",
      "",
      "Fix publish branch names for Slack-triggered sessions",
      "Use the existing control-plane path.",
    ].join("\n");

    // Slugs are normalized and capped to the shared branch-hint length limit.
    expect(derivePromptBranchNameHint(prompt)).toBe("fix-publish-branch-names-for-slack-triggered");
  });

  it("ignores bullet-prefixed metadata lines when deriving branch hints", () => {
    const prompt = [
      "- Repository: trycycloid/cycloid",
      "[x] Issue body: investigate the queue path",
      "",
      "Fix prompt branch names",
    ].join("\n");

    expect(derivePromptBranchNameHint(prompt)).toBe("fix-prompt-branch-names");
  });

  it("strips ticket-intake boilerplate when deriving deterministic branch hints", () => {
    expect(derivePromptBranchNameHint("Implement Linear ticket ARC-1529 - SEC-30 button polish")).toBe(
      "arc-1529-sec-30-button-polish",
    );
    expect(derivePromptBranchNameHint("Implement ticket ARC-1529 - SEC-30 button polish")).toBe(
      "arc-1529-sec-30-button-polish",
    );
  });

  it("returns undefined when a prompt only contains metadata lines", () => {
    const prompt = ["Repository: trycycloid/cycloid", "Linear Issue: ARC-999", "Thread context: internal"].join("\n");

    expect(derivePromptBranchNameHint(prompt)).toBeUndefined();
  });

  it("drops sensitive prompt text instead of using it in branch hints", () => {
    expect(derivePromptBranchNameHint("Rotate production token abc1234567890abcdef")).toBeUndefined();
  });

  it("derives the generated branch hint from the prepared session title for the first prompt", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    host.prepareSessionTitle = vi.fn(async () => ({ title: "LLM readable branch", ticketKey: null }));
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    const queue = createSessionPromptQueue(host);

    await queue.handlePromptEnqueueRequest(
      new Request("https://example.com/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Fix publish branch names" }),
      }),
    );

    expect(host.prepareSessionTitle).toHaveBeenCalledWith("Fix publish branch names", {
      businessId: null,
      ownerUserId: "user-1",
      promptId: "p-1",
      repoName: null,
      repoOwner: null,
      sessionId: "session-1",
    });
    expect(sentCommands[0]?.branchNameHint).toBe("llm-readable-branch");
  });

  it("prepends the ticket key from a Linear URL in the prompt to the branch hint", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    const queue = createSessionPromptQueue(host);

    await queue.handlePromptEnqueueRequest(
      new Request("https://example.com/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Improve the dashboard layout https://linear.app/cycloid2/issue/ARC-290/dashboard",
        }),
      }),
    );

    // B2 guard: the URL is parsed from the current prompt (no pre-existing
    // linearContext), and the resolved key must reach the branch hint.
    expect(sentCommands[0]?.branchNameHint).toBe("arc-290-improve-the-dashboard-layout");
  });

  it("prepends the leading ticket key from the prompt without double-prefixing", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    const queue = createSessionPromptQueue(host);

    await queue.handlePromptEnqueueRequest(
      new Request("https://example.com/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "ARC-746: Stop nulling intent summaries" }),
      }),
    );

    // The deterministic hint already leads with `arc-746`; the prefix must not be
    // duplicated into `arc-746-arc-746-...`.
    expect(sentCommands[0]?.branchNameHint).toBe("arc-746-stop-nulling-intent-summaries");
  });

  it("prepends the ticket key to the LLM-generated branch hint", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    host.prepareSessionTitle = vi.fn(async () => ({ title: "LLM readable branch", ticketKey: "ARC-999" }));
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    const queue = createSessionPromptQueue(host);

    await queue.handlePromptEnqueueRequest(
      new Request("https://example.com/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Improve things https://linear.app/cycloid2/issue/ARC-290/improve",
        }),
      }),
    );

    expect(sentCommands[0]?.branchNameHint).toBe("arc-290-llm-readable-branch");
  });

  it("leaves the branch hint unprefixed when no ticket key is present", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    const queue = createSessionPromptQueue(host);

    await queue.handlePromptEnqueueRequest(
      new Request("https://example.com/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Fix publish branch names" }),
      }),
    );

    expect(sentCommands[0]?.branchNameHint).toBe("fix-publish-branch-names");
  });

  it("falls back to a filler-stripped deterministic branch hint when prepared title is null", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    host.prepareSessionTitle = vi.fn(async () => null);
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    const queue = createSessionPromptQueue(host);

    await queue.handlePromptEnqueueRequest(
      new Request("https://example.com/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "please make the images on this 4:3 aspect ratio" }),
      }),
    );

    expect(host.prepareSessionTitle).toHaveBeenCalledOnce();
    expect(sentCommands[0]?.branchNameHint).toBe("images-on-this-4-3-aspect-ratio");
  });

  it("keeps first prompt enqueue on a short budget when prepared title generation is slow", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const { host, sentCommands } = createHost(storage);
      host.prepareSessionTitle = vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ title: "Slow LLM branch", ticketKey: null }),
              PREPARED_SESSION_TITLE_ENQUEUE_TIMEOUT_MS + 100,
            );
          }),
      );
      ensureSandboxState(storage.sql, "session-1", { status: "running" });
      storage.sql.exec(
        `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
         VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
      );
      const queue = createSessionPromptQueue(host);

      const responsePromise = queue.handlePromptEnqueueRequest(
        new Request("https://example.com/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Fix publish branch names" }),
        }),
      );

      await vi.advanceTimersByTimeAsync(PREPARED_SESSION_TITLE_ENQUEUE_TIMEOUT_MS);
      const response = await responsePromise;

      expect(response.status).toBe(200);
      expect(host.prepareSessionTitle).toHaveBeenCalledOnce();
      expect(sentCommands[0]?.branchNameHint).toBe("fix-publish-branch-names");

      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses deterministic branch hints for later prompts without waiting on the LLM path", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    host.prepareSessionTitle = vi.fn(async () => ({ title: "Should not run", ticketKey: null }));
    const queue = createSessionPromptQueue(host);

    await queue.handlePromptEnqueueRequest(
      new Request("https://example.com/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Existing prompt" }),
      }),
    );
    await queue.completeActivePrompt("session-1", { success: true });
    sentCommands.length = 0;
    vi.mocked(host.prepareSessionTitle).mockClear();

    await queue.handlePromptEnqueueRequest(
      new Request("https://example.com/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Fix later prompt branch names" }),
      }),
    );

    expect(host.prepareSessionTitle).not.toHaveBeenCalled();
    expect(sentCommands[0]?.branchNameHint).toBe("fix-later-prompt-branch-names");
  });

  it("falls back to the deterministic branch hint when prepared title lookup throws", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    host.prepareSessionTitle = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://example.com/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Fix publish branch names" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(host.prepareSessionTitle).toHaveBeenCalledWith("Fix publish branch names", {
      businessId: null,
      ownerUserId: "user-1",
      promptId: "p-1",
      repoName: null,
      repoOwner: null,
      sessionId: "session-1",
    });
    expect(sentCommands[0]?.branchNameHint).toBe("fix-publish-branch-names");
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "Error: provider unavailable",
        promptCounter: 0,
        sessionId: "session-1",
      }),
      "Prepared title generation failed; using deterministic branch fallback",
    );
    expect(vi.mocked(host.log.warn).mock.calls[0]?.[0]).not.toHaveProperty("error");
  });

  it("omits attachment fields when arrays are empty or absent", () => {
    const promptNoAttachments = makePrompt({ files: [], uploadedFiles: [], uploadedImages: [] });

    const command = buildPromptCommand(promptNoAttachments, makeSession());
    expect(command.files).toBeUndefined();
    expect(command.uploadedFiles).toBeUndefined();
    expect(command.uploadedImages).toBeUndefined();

    const contract = buildSandboxCallbackContract("session-1", promptNoAttachments, "Bearer test-token", null);
    expect(contract.files).toBeUndefined();
    expect(contract.uploadedFiles).toBeUndefined();
    expect(contract.uploadedImages).toBeUndefined();

    const retry = clonePromptForRetry(promptNoAttachments, "prompt-2", "2026-04-01T12:00:00.000Z", "queued");
    expect(retry.files).toBeUndefined();
    expect(retry.uploadedFiles).toBeUndefined();
    expect(retry.uploadedImages).toBeUndefined();

    const client = toClientPrompt(promptNoAttachments, "session-1", null, null);
    expect(client.files).toBeUndefined();
    expect(client.uploadedFiles).toBeUndefined();
    expect(client.uploadedImages).toBeUndefined();
  });

  it("passes files through unchanged in toClientPrompt without summarising them", () => {
    const client = toClientPrompt(makePrompt({ files: ["src/foo.ts", "src/bar.ts"] }), "session-1", null, null);

    expect(client.files).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(client.uploadedFiles).toBeUndefined();
    expect(client.uploadedImages).toBeUndefined();
  });

  it("forwards attachments from enqueue request body to the sandbox prompt command", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Refactor the queue helper",
          skills: [" review-spec ", "review-spec", "   "],
          files: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
          uploadedFiles: [{ name: "spec.txt", content: "do this" }],
          uploadedImages: [{ name: "diagram.png", mediaType: "image/png", data: "YWJjMTIz" }],
        }),
      }),
    );

    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      type: "prompt",
      skills: ["review-spec"],
      files: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
      uploadedFiles: [{ name: "spec.txt", content: "do this" }],
      uploadedImages: [{ name: "diagram.png", mediaType: "image/png", data: "YWJjMTIz" }],
    });
  });

  it("rejects prompt uploads that exceed Durable Object SQL value limits before persisting events", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Inspect the screenshot",
          uploadedImages: [{ name: "large.png", mediaType: "image/png", data: "A".repeat(2_400_000) }],
        }),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Uploaded prompt attachments are too large"),
    });
    expect(host.appendAndMirrorEvents).not.toHaveBeenCalled();
    expect(sentCommands).toHaveLength(0);
    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toEqual([]);
  });

  it("rejects large prompt text combined with near-limit uploads before Durable Object enqueue persistence", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "x".repeat(20_000),
          uploadedImages: [{ name: "large.png", mediaType: "image/png", data: "A".repeat(1_790_000) }],
        }),
      }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Prompt and attachments are too large"),
    });
    expect(host.appendAndMirrorEvents).not.toHaveBeenCalled();
    expect(sentCommands).toHaveLength(0);
    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toEqual([]);
  });

  it("rejects invalid prompt uploads before Durable Object enqueue persistence", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Inspect the screenshot",
          uploadedImages: [{ name: "diagram.bmp", mediaType: "image/bmp", data: "AAAA" }],
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Unsupported image type: image/bmp. Supported: image/png, image/jpeg, image/gif, image/webp",
    });
    expect(host.appendAndMirrorEvents).not.toHaveBeenCalled();
    expect(sentCommands).toHaveLength(0);
    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toEqual([]);
  });

  it("rejects invalid actor user IDs before Durable Object enqueue persistence", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Inspect the screenshot",
          actorUserId: "202\n<user_content>",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Invalid actorUserId",
    });
    expect(host.appendAndMirrorEvents).not.toHaveBeenCalled();
    expect(sentCommands).toHaveLength(0);
    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toEqual([]);
  });

  it("rejects invalid enqueue source attribution before Durable Object persistence", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });
    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Revise the plan", source: "automation" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "Invalid prompt source" });
    expect(host.appendAndMirrorEvents).not.toHaveBeenCalled();
    expect(sentCommands).toHaveLength(0);
    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toEqual([]);
  });

  it("rejects invalid reply quote source payloads before Durable Object enqueue persistence", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Inspect the Slack quote",
          replyToQuoteSource: { lines: [[{ type: "user", user_id: 123 }]] },
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Invalid replyToQuoteSource",
    });
    expect(host.appendAndMirrorEvents).not.toHaveBeenCalled();
    expect(sentCommands).toHaveLength(0);
    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toEqual([]);
  });

  it("accepts explicit null reply quote source payloads", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Inspect the Slack quote",
          replyToQuoteSource: null,
        }),
      }),
    );

    expect(response.status).toBe(200);
    const prompts = (await storage.get<Array<PromptState>>("prompts")) ?? [];
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.replyToQuoteSource).toBeNull();
  });

  it("dispatches pending prompts directly from helper state", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-1",
      prompts: [makePrompt()],
      pending_prompt_dispatch: true,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await expect(queue.sendPendingPromptToSandbox("session-1")).resolves.toBe(true);

    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      type: "prompt",
      messageId: "prompt-1",
      agent: undefined,
    });
    expect(sentCommands[0].content).toBe("Fix the queue extraction");
    expect(await storage.get("pending_prompt_dispatch")).toBe(false);
  });

  it("purges scoped company memory bootstrap storage without injecting or emitting usage", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-1",
      prompts: [makePrompt()],
      pending_prompt_dispatch: true,
      company_memory_context:
        "<cycloid:company_memory readonly>\n[fact fact-acme] Acme needs SOC2.\n</cycloid:company_memory>",
      company_memory_target_prompt: "prompt-1",
      company_memory_usage: {
        activeMemoryIds: ["fact-acme"],
        scopeType: "repo",
        scopeId: "acme/widgets",
        activeMemories: [{ id: "fact-acme", title: "Acme needs SOC2.", selectionRank: 1, selectionScore: 1.2 }],
      },
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await expect(queue.sendPendingPromptToSandbox("session-1")).resolves.toBe(true);

    expect(host.appendAndMirrorEvents).not.toHaveBeenCalledWith(
      "session-1",
      [expect.objectContaining({ type: "memory_usage" })],
      "prompt-1",
    );
    expect(sentCommands[0].content).toBe("Fix the queue extraction");
    expect(await storage.get("company_memory_context")).toBeUndefined();
    expect(await storage.get("company_memory_target_prompt")).toBeUndefined();
    expect(await storage.get("company_memory_usage")).toBeUndefined();
  });

  it("purges stale company memory storage without explicit scope metadata before dispatch", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-1",
      prompts: [makePrompt()],
      pending_prompt_dispatch: true,
      company_memory_context:
        "<cycloid:company_memory readonly>\n[fact fact-acme] Acme needs SOC2.\n</cycloid:company_memory>",
      company_memory_target_prompt: "prompt-1",
      company_memory_usage: {
        activeMemoryIds: ["fact-acme"],
        activeMemories: [{ id: "fact-acme", title: "Acme needs SOC2.", selectionRank: 1, selectionScore: 1.2 }],
      },
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await expect(queue.sendPendingPromptToSandbox("session-1")).resolves.toBe(true);

    expect(host.appendAndMirrorEvents).not.toHaveBeenCalledWith(
      "session-1",
      [expect.objectContaining({ type: "memory_usage" })],
      "prompt-1",
    );
    expect(sentCommands[0].content).toBe("Fix the queue extraction");
    expect(await storage.get("company_memory_context")).toBeUndefined();
    expect(await storage.get("company_memory_target_prompt")).toBeUndefined();
    expect(await storage.get("company_memory_usage")).toBeUndefined();
  });

  it("discards scoped company memory bootstrap storage before dispatch when bootstrap is disabled", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-1",
      prompts: [makePrompt()],
      pending_prompt_dispatch: true,
      company_memory_context:
        "<cycloid:company_memory readonly>\n[fact fact-acme] Acme needs SOC2.\n</cycloid:company_memory>",
      company_memory_target_prompt: "prompt-1",
      company_memory_usage: {
        activeMemoryIds: ["fact-acme"],
        scopeType: "repo",
        scopeId: "acme/widgets",
        activeMemories: [{ id: "fact-acme", title: "Acme needs SOC2.", selectionRank: 1, selectionScore: 1.2 }],
      },
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await expect(queue.sendPendingPromptToSandbox("session-1")).resolves.toBe(true);

    expect(host.appendAndMirrorEvents).not.toHaveBeenCalledWith(
      "session-1",
      [expect.objectContaining({ type: "memory_usage" })],
      "prompt-1",
    );
    expect(sentCommands[0].content).toBe("Fix the queue extraction");
    expect(await storage.get("company_memory_context")).toBeUndefined();
    expect(await storage.get("company_memory_target_prompt")).toBeUndefined();
    expect(await storage.get("company_memory_usage")).toBeUndefined();
  });

  it("purges stale company memory storage even when it targeted a different prompt", async () => {
    const storage = new MemoryStorage();
    const companyMemoryContext =
      "<cycloid:company_memory readonly>\n[fact fact-acme] Acme needs SOC2.\n</cycloid:company_memory>";
    const companyMemoryUsage = {
      activeMemoryIds: ["fact-acme"],
      scopeType: "repo",
      scopeId: "acme/widgets",
      activeMemories: [{ id: "fact-acme", title: "Acme needs SOC2.", selectionRank: 1, selectionScore: 1.2 }],
    };
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-1",
      prompts: [makePrompt()],
      pending_prompt_dispatch: true,
      company_memory_context: companyMemoryContext,
      company_memory_target_prompt: "prompt-2",
      company_memory_usage: companyMemoryUsage,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await expect(queue.sendPendingPromptToSandbox("session-1")).resolves.toBe(true);

    expect(host.appendAndMirrorEvents).not.toHaveBeenCalledWith(
      "session-1",
      [expect.objectContaining({ type: "memory_usage" })],
      "prompt-1",
    );
    expect(sentCommands[0].content).toBe("Fix the queue extraction");
    await expect(storage.get("company_memory_context")).resolves.toBeUndefined();
    await expect(storage.get("company_memory_target_prompt")).resolves.toBeUndefined();
    await expect(storage.get("company_memory_usage")).resolves.toBeUndefined();
  });

  it("adds a verifier setup warning when PR context cannot be fetched", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/123",
      }),
      activePromptId: "prompt-1",
      prompts: [makePrompt()],
      pending_prompt_dispatch: true,
      sandbox_status: "ready",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/123",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await expect(queue.sendPendingPromptToSandbox("session-1")).resolves.toBe(true);

    expect(sentCommands[0]).toMatchObject({
      type: "prompt",
      agentRole: "verification",
      targetPrUrl: "https://github.com/acme/widgets/pull/123",
      verificationSetupWarnings: [
        "Control-plane GitHub PR context fetch was skipped because required GitHub environment bindings are unavailable.",
      ],
    });
    expect(sentCommands[0]).not.toHaveProperty("verificationPrContext");
  });

  it("dispatches verifier prompts with a setup warning when GitHub PR lookup fails", async () => {
    mockFetchVerificationPrContext.mockRejectedValueOnce(new Error("GitHub PR lookup failed (404): missing"));
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/123",
      }),
      activePromptId: "prompt-1",
      prompts: [makePrompt()],
      pending_prompt_dispatch: true,
      sandbox_status: "ready",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/123",
      installationId: 12345,
      repoOwner: "acme",
      repoName: "widgets",
    });

    const { host, sentCommands } = createHost(storage, {
      DB: {} as D1Database,
      REPOS_CACHE: {} as KVNamespace,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "key",
    });
    const queue = createSessionPromptQueue(host);

    await expect(queue.sendPendingPromptToSandbox("session-1")).resolves.toBe(true);

    expect(mockFetchVerificationPrContext).toHaveBeenCalledWith(
      expect.objectContaining({ GITHUB_APP_ID: "1" }),
      "https://github.com/acme/widgets/pull/123",
      expect.objectContaining({
        installationId: 12345,
        repoOwner: "acme",
        repoName: "widgets",
        requireRepoMatch: true,
      }),
    );
    expect(sentCommands[0]).toMatchObject({
      type: "prompt",
      agentRole: "verification",
      verificationSetupWarnings: [
        "Control-plane GitHub PR context fetch failed for https://github.com/acme/widgets/pull/123: Error: GitHub PR lookup failed (404): missing",
      ],
    });
    expect(sentCommands[0]).not.toHaveProperty("verificationPrContext");
  });

  it("dispatches verifier prompts with the parent session prompt array", async () => {
    const longPrompt = "x".repeat(4005);
    mockFetchVerificationPrContext.mockResolvedValueOnce({
      prUrl: "https://github.com/acme/widgets/pull/123",
      owner: "acme",
      repo: "widgets",
      number: 123,
      title: "Fix widget auth",
      body: null,
      state: "open",
      draft: false,
      headRef: "feature/auth",
      headSha: "abc123",
      baseRef: "main",
      authorLogin: "octocat",
      files: [],
      commits: [],
      mergeable: null,
      mergeStateStatus: null,
      labels: [],
      checksSummary: null,
      vercelDeployPreview: null,
      recentDiscussion: [],
      fetchWarnings: [],
    });
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/123",
      }),
      activePromptId: "prompt-1",
      prompts: [makePrompt()],
      pending_prompt_dispatch: true,
      sandbox_status: "ready",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/123",
      installationId: 12345,
      repoOwner: "acme",
      repoName: "widgets",
    });

    const { host, sentCommands } = createHost(storage, {
      DB: createChildLookupDb({
        session_id: "session-1",
        business_id: "biz-1",
        parent_session_id: "parent-session",
        parent_prompt_id: "parent-prompt",
        spawned_by_user_id: 1001,
        spawn_depth: 1,
        title: null,
        status: "active",
        rich_status: "running",
        publish_status: null,
        publish_error: null,
        created_at: "2026-04-01T12:00:00.000Z",
        closed_at: null,
      }),
      REPOS_CACHE: {} as KVNamespace,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "key",
    });
    host.listSessionPrompts.mockResolvedValueOnce([
      {
        promptId: "parent-prompt",
        session_id: "parent-session",
        prompt: longPrompt,
        replyToText: "previous reply context",
        agent: "codex",
        skills: ["review-spec"],
        files: ["secret.env"],
        uploadedFiles: [{ name: "widget-auth-plan.md" }],
        uploadedImages: [{ name: "auth-flow.png", mediaType: "image/png" }],
        actorUserId: "1001",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium",
        result: "done",
        error: null,
        status: "completed",
        createdAt: "2026-04-01T12:00:00.000Z",
      },
      {
        promptId: "parent-followup",
        session_id: "parent-session",
        prompt: "Also cover expired tokens",
        actorUserId: "1001",
        result: null,
        error: null,
        status: "queued",
        createdAt: "2026-04-01T12:01:00.000Z",
      },
    ]);
    const queue = createSessionPromptQueue(host);

    await expect(queue.sendPendingPromptToSandbox("session-1")).resolves.toBe(true);

    expect(host.listSessionPrompts).toHaveBeenCalledWith("parent-session");
    expect(sentCommands[0]).toMatchObject({
      type: "prompt",
      agentRole: "verification",
      verificationParentPrompts: [
        {
          promptId: "parent-prompt",
          prompt: `${"x".repeat(4000)}\n[truncated]`,
          status: "completed",
          createdAt: "2026-04-01T12:00:00.000Z",
        },
        {
          promptId: "parent-followup",
          prompt: "Also cover expired tokens",
          status: "queued",
          createdAt: "2026-04-01T12:01:00.000Z",
        },
      ],
    });
    const serializedParentPrompts = JSON.stringify(sentCommands[0]?.verificationParentPrompts);
    expect(serializedParentPrompts).not.toContain("done");
    expect(serializedParentPrompts).not.toContain("previous reply context");
    expect(serializedParentPrompts).not.toContain("review-spec");
    expect(serializedParentPrompts).not.toContain("1001");
    expect(serializedParentPrompts).not.toContain("gpt-5.4-mini");
    expect(serializedParentPrompts).not.toContain("medium");
    expect(serializedParentPrompts).not.toContain("secret.env");
    expect(serializedParentPrompts).not.toContain("widget-auth-plan.md");
    expect(serializedParentPrompts).not.toContain("auth-flow.png");
  });

  it("does not attach verifier PR context fields to implementation dispatches", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ targetPrUrl: "https://github.com/acme/widgets/pull/123" }),
      activePromptId: "prompt-1",
      prompts: [makePrompt()],
      pending_prompt_dispatch: true,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await expect(queue.sendPendingPromptToSandbox("session-1")).resolves.toBe(true);

    expect(sentCommands[0]).toMatchObject({ agentRole: "implementation" });
    expect(sentCommands[0]).not.toHaveProperty("verificationPrContext");
    expect(sentCommands[0]).not.toHaveProperty("verificationSetupWarnings");
  });

  it("keeps pending dispatch marked until verifier PR context is fetched", async () => {
    mockFetchVerificationPrContext.mockResolvedValueOnce({
      prUrl: "https://github.com/acme/widgets/pull/123",
      owner: "acme",
      repo: "widgets",
      number: 123,
      title: "Fix widget auth",
      body: null,
      state: "open",
      draft: false,
      headRef: "feature/auth",
      headSha: "abc123",
      baseRef: "main",
      authorLogin: "octocat",
      files: [{ path: "src/auth.ts", status: "modified", additions: 1, deletions: 0 }],
      commits: [],
      mergeable: null,
      mergeStateStatus: null,
      labels: [],
      checksSummary: null,
      vercelDeployPreview: null,
      recentDiscussion: [],
      fetchWarnings: [],
    });
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/123",
      }),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/123",
      installationId: 12345,
      repoOwner: "acme",
      repoName: "widgets",
    });

    const { host, sentCommands } = createHost(storage, {
      DB: {} as D1Database,
      REPOS_CACHE: {} as KVNamespace,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "key",
    });
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Verify this PR" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockFetchVerificationPrContext).toHaveBeenCalled();
    expect(host.setPendingPromptDispatch).toHaveBeenCalledWith(false);
    expect(mockFetchVerificationPrContext.mock.invocationCallOrder[0]).toBeLessThan(
      host.setPendingPromptDispatch.mock.invocationCallOrder[0],
    );
    expect(host.setPendingPromptDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      host.sendToSandbox.mock.invocationCallOrder[0],
    );
    expect(sentCommands[0]).toMatchObject({
      agentRole: "verification",
      verificationPrContext: { headSha: "abc123", files: [{ path: "src/auth.ts" }] },
    });
  });

  it("persists prompt_processing before dispatching a newly enqueued prompt", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Ship phase 3" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(host.appendAndMirrorEvents).toHaveBeenCalledTimes(1);
    expect(host.sendToSandbox).toHaveBeenCalledTimes(1);
    // Three detached tasks: generateSessionTitle, the ARC-1196
    // prompt_admit_decision Datadog direct post, and ARC-1583
    // prompt.queue_wait telemetry on the live dispatch path.
    expect(host.waitUntil).toHaveBeenCalledTimes(3);
    expect(host.generateSessionTitle).toHaveBeenCalledWith("session-1", "Ship phase 3", "p-1");
    expect(host.appendAndMirrorEvents.mock.invocationCallOrder[0]).toBeLessThan(
      host.sendToSandbox.mock.invocationCallOrder[0],
    );
    expect(await storage.get("activePromptId")).toBe("p-1");
    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toMatchObject([
      { promptId: "p-1", status: "processing" },
    ]);
    expect(sentCommands[0]).toMatchObject({ type: "prompt", messageId: "p-1", content: "Ship phase 3" });
    expect((await storage.get<SessionState>("session"))?.title).toBe("Ship phase 3");
  });

  it("starts the initial sandbox spawn without company memory bootstrap retrieval", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "idle",
    });

    const { host } = createHost(storage);
    host.getSandboxSocket = vi.fn(() => null);
    host.startSpawnAttempt = vi.fn(async () => "attempt-1");
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Set up Acme demo" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(host.startSpawnAttempt).toHaveBeenCalledWith("session-1", "spawnSandbox.prompt");
  });

  it("marks review-loop epochs processing when a review-loop prompt starts", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Respond to review bots", reviewLoopEpochId: "epoch-1" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(host.markReviewLoopEpochProcessing).toHaveBeenCalledWith("session-1", "p-1", "epoch-1");
    expect(host.waitUntil).toHaveBeenCalled();
  });

  it("ignores unknown enqueue metadata fields", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [],
      activePromptId: null,
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Ship phase 3", slackTaskKind: "code" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await storage.get("activePromptId")).toBe("p-1");
    expect(sentCommands[0]).toMatchObject({ type: "prompt", messageId: "p-1", content: "Ship phase 3" });
    expect(await storage.get("slack_task_kind:p-1")).toBeUndefined();
  });

  it("persists prompt completion and next prompt processing before dispatching the follow-up prompt", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-1",
      prompts: [
        makePrompt({ promptId: "prompt-1", status: "processing", result: null, error: null }),
        makePrompt({
          promptId: "prompt-2",
          prompt: "Run the follow-up",
          status: "queued",
          startedAt: null,
          completedAt: null,
          updatedAt: "2026-04-01T12:00:02.000Z",
        }),
      ],
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "prompt-1",
        success: true,
        idleObserved: false,
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    expect(host.appendAndMirrorEvents).toHaveBeenCalledTimes(1);
    expect(host.sendToSandbox).toHaveBeenCalledTimes(1);
    expect(host.appendAndMirrorEvents.mock.invocationCallOrder[0]).toBeLessThan(
      host.sendToSandbox.mock.invocationCallOrder[0],
    );
    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toMatchObject([
      { promptId: "prompt-1", status: "completed" },
      { promptId: "prompt-2", status: "processing" },
    ]);
    expect(await storage.get("activePromptId")).toBe("prompt-2");
    expect(sentCommands[0]).toMatchObject({ type: "prompt", messageId: "prompt-2", content: "Run the follow-up" });
  });

  it("drains queued prompts without waiting for terminal side effects", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-1",
      prompts: [
        makePrompt({ promptId: "prompt-1", status: "processing", result: null, error: null }),
        makePrompt({
          promptId: "prompt-2",
          prompt: "Run the follow-up",
          status: "queued",
          startedAt: null,
          completedAt: null,
          updatedAt: "2026-04-01T12:00:02.000Z",
        }),
      ],
      sandbox_status: "ready",
    });

    const { host, sentCommands, flushTerminalSideEffects } = createHost(storage);
    let releaseUsageWrite: (() => void) | null = null;
    const delayedUsageWrite = new Promise<void>((resolve) => {
      releaseUsageWrite = resolve;
    });
    vi.mocked(host.writeUsageToD1).mockImplementation(() => delayedUsageWrite);

    const queue = createSessionPromptQueue(host);
    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "prompt-1",
        success: true,
        idleObserved: false,
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toMatchObject([
      { promptId: "prompt-1", status: "completed" },
      { promptId: "prompt-2", status: "processing" },
    ]);
    expect(await storage.get("activePromptId")).toBe("prompt-2");
    expect(sentCommands[0]).toMatchObject({ type: "prompt", messageId: "prompt-2", content: "Run the follow-up" });
    expect(host.writeUsageToD1).toHaveBeenCalledWith("session-1", "user-1", "prompt-1");
    expect(host.finalizePromptRun).not.toHaveBeenCalled();

    releaseUsageWrite?.();
    await flushTerminalSideEffects();

    expect(host.finalizePromptRun).toHaveBeenCalledTimes(1);
  });

  it("does not auto-retry a fresh first prompt after a retryable provider failure", async () => {
    const initialPrompt = makePrompt({
      promptId: "initial-provider-failure",
      status: "processing",
      result: null,
      error: null,
    });
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: initialPrompt.promptId,
      promptCounter: 1,
      prompts: [initialPrompt],
      sandbox_status: "ready",
    });

    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: initialPrompt.promptId,
        success: false,
        error: "Session error: Codex app-server error",
        errorCode: "api_error",
        idleObserved: false,
        sessionEditCount: 0,
        sessionPromptCount: 1,
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toMatchObject([
      { promptId: initialPrompt.promptId, status: "failed", error: "Session error: Codex app-server error" },
    ]);
    expect(await storage.get("activePromptId")).toBeNull();
    expect(host.appendAndMirrorEvents).toHaveBeenCalledWith(
      "session-1",
      expect.not.arrayContaining([expect.objectContaining({ type: "retry_status" })]),
    );
    expect(sentCommands).toHaveLength(0);
  });

  it("writes the assistant's final text into slack_summary when the prompt completes without a follow-up", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-1",
      prompts: [makePrompt({ promptId: "prompt-1", status: "processing", result: null, error: null })],
      sandbox_status: "ready",
    });

    // Pre-seed events directly in SQL: bridge events would have been appended
    // before execution_complete arrives. Slack summary extraction reads from
    // SQL (not from appendAndMirrorEvents' return value, which is empty).
    appendEventsWithReplay(
      storage.sql as unknown as Parameters<typeof appendEventsWithReplay>[0],
      "session-1",
      [
        { type: "prompt_processing", data: { promptId: "prompt-1" } },
        { type: "text", data: { id: "part-1", text: "The root cause is X because Y." } },
      ],
      "prompt-1",
    );

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "prompt-1",
        success: true,
        idleObserved: true,
        sessionEditCount: 0,
        sessionPromptCount: 1,
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    const slackSummary = await storage.get<{ text: string; prUrl?: string; branchName?: string }>(
      "slack_summary:prompt-1",
    );
    expect(slackSummary).toEqual({
      text: "The root cause is X because Y.",
      prUrl: undefined,
      branchName: undefined,
    });
  });

  it("writes Slack summary without classifier metadata when the prompt completes", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-1",
      prompts: [makePrompt({ promptId: "prompt-1", status: "processing", result: null, error: null })],
      sandbox_status: "ready",
    });
    appendEventsWithReplay(
      storage.sql as unknown as Parameters<typeof appendEventsWithReplay>[0],
      "session-1",
      [
        { type: "prompt_processing", data: { promptId: "prompt-1" } },
        { type: "text", data: { id: "part-1", text: "No code changes were needed." } },
      ],
      "prompt-1",
    );
    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "prompt-1",
        success: true,
        idleObserved: true,
        sessionEditCount: 0,
        sessionPromptCount: 1,
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    const slackSummary = await storage.get<{ text: string; prUrl?: string; branchName?: string }>(
      "slack_summary:prompt-1",
    );
    expect(slackSummary).toMatchObject({
      text: "No code changes were needed.",
    });
  });

  it("retries a completed prompt without copying classifier metadata", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: null,
      prompts: [
        makePrompt({
          promptId: "prompt-1",
          status: "completed",
          completedAt: "2026-04-01T12:05:00.000Z",
          result: { success: true },
        }),
      ],
      sandbox_status: "ready",
    });
    await storage.put("promptCounter", 1);
    await storage.put("slack_summary:prompt-1", {
      text: "No changes were needed.",
    });

    const { sentCommands, host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handleRetryRequest();

    expect(response.status).toBe(202);
    expect(await storage.get("slack_task_kind:p-2")).toBeUndefined();
    await expect(storage.get<Array<PromptState>>("prompts")).resolves.toMatchObject([
      { promptId: "prompt-1", status: "completed" },
      { promptId: "p-2", status: "processing" },
    ]);
    expect(sentCommands[0]).toMatchObject({ type: "prompt", messageId: "p-2" });
  });

  it("skips verification writes and PR creation for non-completed prompts", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "failed", completedAt: "2026-04-01T12:05:00.000Z", error: "sandbox failed" })],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      promptCounter: 1,
    });

    const { host } = createHost(storage);
    // ARC-876: pushed is now bundled on the event payload; see event.pushed below
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "phase1b-prompt-queue-helper",
      commitSha: "abc123",
      diffSummary: "Changed prompt queue behavior",
      prTitle: "Queue fix",
      prBody: "Body",
      verification: { verified: false, explanation: "Mismatch" },
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    expect(await storage.get("verification")).toBeUndefined();
    expect(host.writeCompletionToD1).not.toHaveBeenCalled();
    expect(host.triggerPrCreation).not.toHaveBeenCalled();
    expect(host.triggerPrUpdate).not.toHaveBeenCalled();
  });

  it("persists post_execution verification with preview contract evidence", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ title: "Preview test" }),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    ensureSandboxState(storage.sql, "session-1");

    const { host } = createHost(storage);
    // ARC-876: pushed is now bundled on the event payload; see event.pushed below
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/preview-proof",
      commitSha: "abc123",
      diffSummary: "Added verification preview plumbing",
      prTitle: "Add verification preview plumbing",
      prBody: "Body",
      verification: {
        verified: true,
        status: "passed",
        explanation: "Verified with replay contract",
        previewContract: {
          cwd: "/workspace/repo",
          kind: "web",
          runner: "docker",
          entry: {
            type: "compose",
            files: ["docker-compose.yml"],
            service: "web",
          },
          url: {
            hostPort: 5173,
            path: "/ui",
          },
          ready: {
            path: "/ready",
          },
          open: {
            path: "/ui",
          },
        },
      },
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    await expect(storage.get("verification")).resolves.toEqual(event.verification);
    await expect(storage.get("pr_readiness")).resolves.toBeUndefined();
  });

  it("stores readiness evidence from post_execution for later manual PR creation", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/ready-for-manual-pr",
      commitSha: "abc123",
      diffSummary: "Added publish readiness storage",
      prTitle: "Store readiness for manual PR creation",
      prBody: "Body",
      prReadiness: {
        changedFiles: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
        diffStats: { raw: "1 file changed, 3 insertions(+)", filesChanged: 1, insertions: 3, deletions: 0 },
        commandsRun: [],
        checksDetected: { tests: false, lint: false, typecheck: false },
        skippedChecks: [],
        filesMentionedInFinalAnswer: [],
        agentTimeline: [],
      },
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    await expect(storage.get("pr_readiness")).resolves.toEqual({
      changedFiles: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
      diffStats: { raw: "1 file changed, 3 insertions(+)", filesChanged: 1, insertions: 3, deletions: 0 },
      commandsRun: [],
      checksDetected: { tests: false, lint: false, typecheck: false },
      skippedChecks: [],
      filesMentionedInFinalAnswer: [],
      agentTimeline: [],
    });
  });

  it("normalizes incomplete readiness evidence from post_execution before storing it", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/ready-for-manual-pr",
      commitSha: "abc123",
      diffSummary: "Added publish readiness storage",
      prTitle: "Store readiness for manual PR creation",
      prBody: "Body",
      prReadiness: {
        diffStats: { filesChanged: 1, insertions: 3, deletions: 0 },
      } as Extract<SandboxEvent, { type: "post_execution" }>["prReadiness"],
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    await expect(storage.get("pr_readiness")).resolves.toEqual({
      changedFiles: [],
      diffStats: { filesChanged: 1, insertions: 3, deletions: 0 },
      commandsRun: [],
      checksDetected: { tests: false, lint: false, typecheck: false },
      skippedChecks: [],
      filesMentionedInFinalAnswer: [],
    });
  });

  it("drops removed readiness fields from old stored payloads", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/ready-for-manual-pr",
      commitSha: "abc123",
      diffSummary: "Added publish readiness storage",
      prTitle: "Store readiness for manual PR creation",
      prBody: "Body",
      prReadiness: {
        changedFiles: ["src/app.ts"],
        diffStats: { filesChanged: 1, insertions: 3, deletions: 0 },
        commandsRun: [],
        checksDetected: { tests: false, lint: false, typecheck: true },
        skippedChecks: [],
        riskyAreasTouched: [{ area: "auth", files: ["src/app.ts"] }],
        filesMentionedInFinalAnswer: [],
        claims: [{ type: "tests_pass", text: "Tests passed." }],
        missingEvidence: ["Agent claimed tests passed, but no completed tests command was recorded."],
      } as Extract<SandboxEvent, { type: "post_execution" }>["prReadiness"],
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    await expect(storage.get("pr_readiness")).resolves.toEqual({
      changedFiles: ["src/app.ts"],
      diffStats: { filesChanged: 1, insertions: 3, deletions: 0 },
      commandsRun: [],
      checksDetected: { tests: false, lint: false, typecheck: true },
      skippedChecks: [],
      filesMentionedInFinalAnswer: [],
    });
  });

  it("filters invalid agentTimeline entries from post_execution readiness evidence", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/ready-for-manual-pr",
      commitSha: "abc123",
      diffSummary: "Added publish readiness storage",
      prTitle: "Store readiness for manual PR creation",
      prBody: "Body",
      prReadiness: {
        changedFiles: [],
        diffStats: { filesChanged: 0, insertions: 0, deletions: 0 },
        commandsRun: [],
        checksDetected: { tests: false, lint: false, typecheck: false },
        skippedChecks: [],
        filesMentionedInFinalAnswer: [],
        agentTimeline: [
          null,
          "bad-entry",
          { eventType: "publish.typecheck", source: "observed", summary: "Typecheck passed." },
        ],
      } as Extract<SandboxEvent, { type: "post_execution" }>["prReadiness"],
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    await expect(storage.get("pr_readiness")).resolves.toEqual({
      changedFiles: [],
      diffStats: { filesChanged: 0, insertions: 0, deletions: 0 },
      commandsRun: [],
      checksDetected: { tests: false, lint: false, typecheck: false },
      skippedChecks: [],
      filesMentionedInFinalAnswer: [],
      agentTimeline: [{ eventType: "publish.typecheck", source: "observed", summary: "Typecheck passed." }],
    });
  });

  it("clears outdated verification when post_execution has no verification payload", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
      verification: {
        verified: false,
        status: "failed",
        explanation: "Runtime evidence was missing.",
      },
    });

    const { host } = createHost(storage);
    // ARC-876: pushed is now bundled on the event payload; see event.pushed below
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/backend-only-fix",
      commitSha: "abc123",
      diffSummary: "Changed backend behavior",
      prTitle: "Fix backend behavior",
      prBody: "Body",
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    await expect(storage.get("verification")).resolves.toBeUndefined();
    await expect(storage.get("pr_readiness")).resolves.toBeUndefined();
    expect(host.broadcast).toHaveBeenCalledWith({
      type: "verification_updated",
      verification: null,
      verificationSummary: null,
    });
    expect(host.triggerPrCreation).toHaveBeenCalledWith(
      "session-1",
      "feature/backend-only-fix",
      "Changed backend behavior",
      "Fix backend behavior",
      "Body",
      undefined,
      undefined,
      "prompt-1",
      "abc123",
      undefined,
      undefined,
    );
    expect(host.appendAndMirrorEvents).not.toHaveBeenCalled();
  });

  it("broadcasts a verification summary built from verification and readiness evidence", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/summary-broadcast",
      commitSha: "abc123",
      diffSummary: "Changed behavior",
      prTitle: "Title",
      prBody: "Body",
      verification: {
        verified: false,
        status: "failed",
        publishMode: "draft",
        manualReviewReason: "Tests failed in post-execution.",
      },
      prReadiness: {
        changedFiles: ["src/index.ts"],
        diffStats: { raw: "1 file changed", filesChanged: 1, insertions: 1, deletions: 0 },
        commandsRun: [
          {
            command: "npm test",
            status: "error",
            exitCode: 1,
            source: "post_execution",
            checks: ["tests"],
            failureOutput: "1 test failed",
          },
        ],
        checksDetected: { tests: true, lint: false, typecheck: false },
        skippedChecks: [],
        filesMentionedInFinalAnswer: [],
        agentTimeline: [],
      } as Extract<SandboxEvent, { type: "post_execution" }>["prReadiness"],
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    expect(host.broadcast).toHaveBeenCalledWith({
      type: "verification_updated",
      verification: event.verification,
      verificationSummary: expect.objectContaining({
        outcome: "draft",
        draftReason: "Tests failed in post-execution.",
        commands: [
          expect.objectContaining({
            command: "npm test",
            status: "failed",
            exitCode: 1,
            failureOutput: "1 test failed",
          }),
        ],
      }),
    });
  });

  it("forwards diff summary and git metadata into completion writes on post_execution", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "intent-summary-branch",
      commitSha: "abc123",
      diffSummary: "Changed prompt queue behavior",
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    expect(host.writeCompletionToD1).toHaveBeenCalledWith("session-1", "user-1", "prompt-1", {
      diffSummary: "Changed prompt queue behavior",
      branch: "intent-summary-branch",
      commitSha: "abc123",
      success: true,
    });
  });

  it("verification post_execution finalizes verification-done and schedules the managed QA comment", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      harnessKind: "codex-session",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      callbackContext: {
        source: "github_qa_issue_comment",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
        issueNumber: 12,
        commentId: 987,
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      },
      promptCounter: 1,
    });
    const sourceLogArtifact = {
      type: "log" as const,
      label: "qa.log",
      url: "https://cdn.example.com/qa.log",
      inlineText: { content: "verified checkout", truncated: false, originalBytes: 17 },
    };
    const publishedScreenshotArtifact = {
      type: "screenshot" as const,
      label: "checkout.png",
      url: "https://github.com/acme/widgets/releases/download/cycloid-evidence/checkout.png",
    };
    mockPublishArtifactsForVerificationComment.mockResolvedValueOnce([publishedScreenshotArtifact]);
    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/pr-head",
      commitSha: "fix123",
      diffSummary: "Verifier fix",
      verifierResult: {
        verdict: "CONCLUSIVE",
        verifiedHeadSha: "fix123",
        summary: "Verified.",
        evidence: ["npm test passed"],
        blockers: [],
      },
      verification: {
        verified: false,
        artifacts: [
          {
            type: "screenshot",
            label: "checkout.png",
            url: "https://cdn.example.com/checkout.png",
          },
          sourceLogArtifact,
        ],
      },
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");
    await Promise.all(host.waitUntil.mock.calls.map((call) => call[0]));

    // The verifier post_execution must NOT open/update a PR, but it should publish the restored
    // informational QA comment after the state sync so comment failures cannot wedge verification state.
    expect(host.triggerPrCreation).not.toHaveBeenCalled();
    expect(host.triggerPrUpdate).not.toHaveBeenCalled();
    expect(host.failPublishOnPushOutcome).not.toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prUrl: "https://github.com/acme/widgets/pull/12",
        state: "verification-done",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
      }),
    );
    expect(mockPostIssueCommentReaction).toHaveBeenCalledWith(
      expect.objectContaining({ DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" }),
      456,
      "acme",
      "widgets",
      987,
      "+1",
    );
    expect(mockEnsureRepoLabel).toHaveBeenCalledWith(
      "ghs_release_token",
      "acme",
      "widgets",
      E2E_TESTED_LABEL,
      "0e8a16",
      "End-to-end tested",
      { updateOnDrift: false },
    );
    expect(mockAddLabels).toHaveBeenCalledWith("ghs_release_token", "acme", "widgets", 12, [E2E_TESTED_LABEL]);
    expect(mockPublishArtifactsForVerificationComment).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        prNumber: 12,
        auth: expect.objectContaining({
          token: "ghs_release_token",
          installationId: 456,
          repoOwner: "acme",
          repoName: "widgets",
        }),
      }),
    );
    expect(mockPublishManagedVerificationComment).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          prUrl: "https://github.com/acme/widgets/pull/12",
          installationId: 456,
          repoOwner: "acme",
          repoName: "widgets",
          ownerSessionId: "session-1",
          promptId: "prompt-1",
          headSha: "fix123",
        }),
        fallbackHeadSha: "fix123",
        verifierResult: event.verifierResult,
        artifacts: [publishedScreenshotArtifact, sourceLogArtifact],
        sessionUrl: expect.stringContaining("/sessions/session-1"),
      }),
    );
  });

  it("does not publish a QA comment for non-terminal verification post_execution", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      harnessKind: "codex-session",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      callbackContext: {
        source: "github_qa_issue_comment",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
        issueNumber: 12,
        commentId: 987,
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      },
      promptCounter: 1,
    });

    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/verification-handoff",
      commitSha: "fix123",
      diffSummary: "Intermediate verification handoff",
      verification: {
        verified: false,
        status: "failed",
        explanation: "Phase handoff is still collecting evidence.",
      },
      prReadiness: {
        changedFiles: ["apps/control-plane-worker/src/session/prompt-queue.ts"],
        diffStats: { raw: "1 file changed, 3 insertions(+)", filesChanged: 1, insertions: 3, deletions: 0 },
        commandsRun: [],
        checksDetected: { tests: false, lint: false, typecheck: false },
        skippedChecks: [],
        filesMentionedInFinalAnswer: [],
        agentTimeline: [],
      },
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");
    await Promise.all(host.waitUntil.mock.calls.map((call) => call[0]));

    await expect(storage.get("verification")).resolves.toEqual(event.verification);
    await expect(storage.get("pr_readiness")).resolves.toEqual(event.prReadiness);
    expect(mockPublishManagedVerificationComment).not.toHaveBeenCalled();
    expect(mockPublishVerificationSkippedComment).not.toHaveBeenCalled();
    expect(mockSyncVerificationResultForPr).not.toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).not.toHaveBeenCalled();
    expect(mockPostIssueCommentReaction).not.toHaveBeenCalled();
    expect(mockEnsureRepoLabel).not.toHaveBeenCalled();
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(host.log.info).toHaveBeenCalledWith(
      { event: "verification_comment.skipped", sessionId: "session-1", promptId: "prompt-1" },
      "Verification session change-producing post_execution did not include a terminal verifier result; skipped managed GitHub comment",
    );
  });

  it("publishes terminal inconclusive verification when verifierResult is missing", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      harnessKind: "codex-session",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      callbackContext: {
        source: "github_qa_issue_comment",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
        issueNumber: 12,
        commentId: 987,
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      },
      promptCounter: 1,
    });

    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      messageId: "prompt-1",
      hasChanges: false,
      noChangeReason: "no_diff",
      verification: {
        verified: false,
        verdict: "INCONCLUSIVE",
        explanation: "Verifier output did not contain a parseable terminal result.",
      },
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");
    await Promise.all(host.waitUntil.mock.calls.map((call) => call[0]));

    expect(mockSyncVerificationResultForPr).not.toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prUrl: "https://github.com/acme/widgets/pull/12",
        state: "verification-done",
      }),
    );
    expect(mockPostIssueCommentReaction).toHaveBeenCalledWith(expect.anything(), 456, "acme", "widgets", 987, "+1");
    expect(mockPublishManagedVerificationComment).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          prUrl: "https://github.com/acme/widgets/pull/12",
          ownerSessionId: "session-1",
          promptId: "prompt-1",
        }),
        verifierResult: undefined,
        artifacts: [],
      }),
    );
  });

  it("applies the QA pass label once per prompt and allows a later prompt to apply it again", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [
        makePrompt({ promptId: "prompt-1", status: "completed", completedAt: "2026-04-01T12:05:00.000Z" }),
        makePrompt({ promptId: "prompt-2", status: "completed", completedAt: "2026-04-01T12:10:00.000Z" }),
      ],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      promptCounter: 2,
    });

    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    const eventFor = (messageId: string): Extract<SandboxEvent, { type: "post_execution" }> => ({
      type: "post_execution",
      messageId,
      hasChanges: false,
      noChangeReason: "no_diff",
      verifierResult: {
        verdict: "CONCLUSIVE",
        verifiedHeadSha: `${messageId}-head`,
        summary: "Verified.",
        evidence: ["npm test passed"],
        blockers: [],
      },
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    });

    await queue.handlePostExecution(eventFor("prompt-1"), "session-1");
    await queue.handlePostExecution(eventFor("prompt-1"), "session-1");
    await queue.handlePostExecution(eventFor("prompt-2"), "session-1");
    await Promise.all(host.waitUntil.mock.calls.map((call) => call[0]));

    expect(mockAddLabels).toHaveBeenCalledTimes(2);
    expect(await storage.get("qa_label_applied:prompt-1")).toBe(true);
    expect(await storage.get("qa_label_applied:prompt-2")).toBe(true);
  });

  it("does not reconcile session PR draft state after inconclusive verification", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      promptCounter: 1,
    });
    mockPublishManagedVerificationComment.mockResolvedValueOnce({
      ok: true,
      commentId: 123,
      action: "updated",
      malformed: false,
    });

    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    await queue.handlePostExecution(
      {
        type: "post_execution",
        messageId: "prompt-1",
        hasChanges: false,
        noChangeReason: "no_diff",
        verifierResult: {
          verdict: "INCONCLUSIVE",
          verifiedHeadSha: "fix123",
          summary: "Preview failed.",
          evidence: [],
          blockers: ["Runtime setup failed."],
        },
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    // Verification never converts a PR to draft, so it must never mirror a draft
    // state into the owning session either.
    expect(mockReconcilePrDraftStateForPr).not.toHaveBeenCalled();
    expect(mockAddLabels).not.toHaveBeenCalled();
  });

  it("finalizes verification-stopped and publishes a stopped QA comment before post-execution", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "processing" })],
      activePromptId: "prompt-1",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      promptCounter: 1,
    });

    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "prompt-1",
        success: false,
        error: "Stopped by user",
        errorCode: "aborted",
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
      { errorCode: "aborted" },
    );

    // The stopped state is finalized directly; the restored comment is informational and must not gate it.
    expect(mockSyncVerificationResultForPr).not.toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prUrl: "https://github.com/acme/widgets/pull/12",
        state: "verification-stopped",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
      }),
    );
    expect(mockPublishManagedVerificationComment).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          prUrl: "https://github.com/acme/widgets/pull/12",
          installationId: 456,
          repoOwner: "acme",
          repoName: "widgets",
          ownerSessionId: "session-1",
          promptId: "prompt-1",
        }),
        verifierResult: expect.objectContaining({
          verdict: "INCONCLUSIVE",
          summary: expect.stringContaining("stopped"),
        }),
        sessionUrl: expect.stringContaining("/sessions/session-1"),
      }),
    );
    expect(mockAddLabels).not.toHaveBeenCalled();
  });

  it("A3: an aborted verifier failure finalizes verification-stopped (no rerun under non-blocking QA)", async () => {
    const storage = new MemoryStorage();
    const childRow = {
      session_id: "session-1",
      business_id: null,
      parent_session_id: "parent-1",
      parent_prompt_id: "parent-prompt-1",
      spawned_by_user_id: 1,
      spawn_depth: 1,
      title: null,
      status: "active",
      rich_status: "running",
      publish_status: "not_started",
      publish_error: null,
      created_at: "2026-04-01T12:00:00.000Z",
      closed_at: null,
    };
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "processing" })],
      activePromptId: "prompt-1",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      promptCounter: 1,
    });

    const { host } = createHost(storage, {
      DB: createChildLookupDb(childRow),
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "test-key",
    });
    mockGetSessionState.mockResolvedValue(
      makeSession({
        sessionId: "parent-1",
        agentRole: "implementation",
        repoOwner: "acme",
        repoName: "widgets",
        installationId: 456,
        reviewListeningPrUrl: "https://github.com/acme/widgets/pull/12",
        reviewListeningHeadSha: "head-sha-1",
      }),
    );
    const queue = createSessionPromptQueue(host);

    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "prompt-1",
        success: false,
        error: "bridge aborted before prompt startup",
        errorCode: "aborted",
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
      { errorCode: "aborted" },
    );

    // A3: the abnormal stop is no longer re-spawned — it finalizes the verification-stopped state.
    // #6939: the restored managed QA comment is published (informational; it does not gate the state).
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "verification-stopped" }),
    );
    expect(mockPublishManagedVerificationComment).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ prUrl: "https://github.com/acme/widgets/pull/12" }),
        verifierResult: expect.objectContaining({
          verdict: "INCONCLUSIVE",
          summary: expect.stringContaining("stopped"),
        }),
      }),
    );
  });

  it("does not replace a completed verification verdict with a stopped comment", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "processing" })],
      activePromptId: "prompt-1",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      promptCounter: 1,
    });

    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "prompt-1",
        success: false,
        error: "Stopped by user",
        errorCode: "aborted",
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
      { errorCode: "aborted" },
    );

    expect(mockPublishManagedVerificationComment).not.toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "verification-stopped" }),
    );
  });

  it("returns stopped without waiting for the stopped verification comment publish", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      verificationState: "verification-in-progress",
      promptCounter: 0,
    });
    mockPublishManagedVerificationComment.mockReturnValueOnce(new Promise(() => {}));

    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    const response = await queue.handleStopRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, sessionId: "session-1", status: "stopped" });
    expect(host.waitUntil).toHaveBeenCalled();
  });

  it("marks the verification comment stopped when stopping an active prompt", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "processing" })],
      activePromptId: "prompt-1",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      callbackContext: {
        source: "github_qa_issue_comment",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
        issueNumber: 12,
        commentId: 987,
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      },
      verificationState: "verification-in-progress",
      promptCounter: 1,
    });

    const { host, sentCommands } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    const response = await queue.handleStopRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, sessionId: "session-1", status: "stopping" });
    expect(sentCommands).toContainEqual(expect.objectContaining({ type: "stop", messageId: "prompt-1" }));

    // The stopped-comment publish is scheduled via waitUntil so the stop response
    // is not blocked on GitHub; await the scheduled work to assert it runs.
    await Promise.all(host.waitUntil.mock.calls.map((call) => call[0]));
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prUrl: "https://github.com/acme/widgets/pull/12",
        state: "verification-stopped",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
      }),
    );
  });

  it("frees the per-PR verification lock when a user stops an active verification prompt", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "processing" })],
      activePromptId: "prompt-1",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      callbackContext: {
        source: "github_qa_issue_comment",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
        issueNumber: 12,
        commentId: 987,
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      },
      verificationState: "verification-in-progress",
      promptCounter: 1,
    });

    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    await queue.handleStopRequest();

    // The stopped-terminal shadow spine emit is scheduled via waitUntil so the stop
    // response is not blocked; await it.
    await Promise.all(host.waitUntil.mock.calls.map((call) => call[0]));
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "verification-stopped" }),
    );
    expect(mockPostIssueCommentReaction).toHaveBeenCalledWith(
      expect.objectContaining({ DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" }),
      456,
      "acme",
      "widgets",
      987,
      "+1",
    );
  });

  it("finalizes verification-stopped when a verification prompt finalizes on a timeout", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "processing" })],
      activePromptId: "prompt-1",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      verificationState: "verification-in-progress",
      promptCounter: 1,
    });

    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "prompt-1",
        success: false,
        error: "Prompt timed out",
        errorCode: "timeout",
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
      { errorCode: "timeout" },
    );

    // ARC-1330 W11 D-51: the per-PR verification lock is gone; the timeout terminal is proven by
    // the verification-stopped finalize (the FSM anchor + VERIFYING deadline govern re-verification).
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "verification-stopped" }),
    );
  });

  // A3: the "finalizes verification-stopped on stop when a verifier rerun is enqueued" test was deleted —
  // the rerun-after-fix key is no longer read; an abnormal stop always finalizes verification-stopped and
  // emits the spine `stopped` verdict (covered by the manual-stop + aborted-finalize tests).

  it("finalizes verification-skipped on a planner skip and schedules the managed QA comment", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ promptId: "p-2", status: "completed", completedAt: "2026-04-01T12:06:00.000Z" })],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      agentProfile: "verify",
      runtimeStartupProfile: "verification_ready_runtime",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      repoOwner: "acme",
      repoName: "widgets",
      installationId: 456,
      promptCounter: 2,
    });

    const { host } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    await queue.handlePostExecution(
      {
        type: "post_execution",
        messageId: "p-2",
        hasChanges: false,
        noChangeReason: "no_diff",
        verificationSkipped: {
          reason: "Planner determined the PR is docs-only.",
          evidence: ["docs/readme.md only"],
          headSha: "docs123",
        },
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    // Planner skip still finalizes state directly; the restored comment is an informational side effect.
    expect(mockSyncVerificationResultForPr).not.toHaveBeenCalled();
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prUrl: "https://github.com/acme/widgets/pull/12",
        state: "verification-skipped",
        installationId: 456,
        repoOwner: "acme",
        repoName: "widgets",
      }),
    );
    expect(mockPublishVerificationSkippedComment).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          prUrl: "https://github.com/acme/widgets/pull/12",
          installationId: 456,
          repoOwner: "acme",
          repoName: "widgets",
          ownerSessionId: "session-1",
          promptId: "p-2",
        }),
        summary: "Planner determined the PR is docs-only.",
        reasonCode: "verification-phase-skip",
      }),
    );
    expect(mockAddLabels).not.toHaveBeenCalled();
  });

  it("does not enqueue a verifier rerun when verifier fix push failed", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        agentRole: "verification",
        agentProfile: "verify",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/acme/widgets/pull/12",
      }),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host, sentCommands } = createHost(storage, { DB: {}, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" });
    const queue = createSessionPromptQueue(host);
    await queue.handlePostExecution(
      {
        type: "post_execution",
        pushed: false,
        messageId: "prompt-1",
        hasChanges: true,
        branch: "feature/pr-head",
        commitSha: "local123",
        diffSummary: "Verifier fix",
        verifierResult: {
          verdict: "INCONCLUSIVE",
          verifiedHeadSha: "local123",
          summary: "Could not push verifier fix.",
          evidence: [],
          blockers: ["permission denied", "No replacement pull request was opened."],
        },
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    expect(sentCommands).toEqual([]);
    expect(host.triggerPrCreation).not.toHaveBeenCalled();
    expect(host.triggerPrUpdate).not.toHaveBeenCalled();
  });

  it("fails publish as push_status_unknown when post_execution omits pushed", async () => {
    // The deploy-skew fallback to a persisted push_complete outcome was removed:
    // a current bridge always bundles `pushed` (and reconstructs it on crash
    // recovery), so an event that omits it gates fail-closed rather than
    // recovering from the prompt row. Seed a persisted "succeeded" outcome to
    // prove it is no longer consulted.
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });
    updatePromptPushOutcome(storage.sql as unknown as SqlStorage, "prompt-1", {
      pushStatus: "succeeded",
      pushError: null,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/pushed-before-post-exec",
      commitSha: "abc123",
      diffSummary: "Changed public UI",
      prTitle: "Update public UI",
      prBody: "Body",
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    expect(host.triggerPrCreation).not.toHaveBeenCalled();
    expect(host.failPublishOnPushOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        cause: "push_status_unknown",
        promptId: "prompt-1",
      }),
    );
    expect(host.failPublishOnPushOutcome.mock.invocationCallOrder[0]).toBeLessThan(
      mockPostStructuredEventToDd.mock.invocationCallOrder[0],
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "test-dd-key", WORKER_ENV: "test" }),
      expect.objectContaining({
        event: "auto_publish.decision",
        session_id: "session-1",
        prompt_id: "prompt-1",
        source: "post_execution",
        decision: "skip",
        reason: "push_status_unknown",
        branch: "feature/pushed-before-post-exec",
        commit_sha: "abc123",
        has_changes: true,
        pushed: null,
        publish_status: "not_started",
      }),
    );
  });

  it("continues PR creation without queue-owned PR timeline persistence", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host } = createHost(storage);
    // ARC-876: pushed is now bundled on the event payload; see event.pushed below
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/backend-only-fix",
      commitSha: "abc123",
      diffSummary: "Changed backend behavior",
      prTitle: "Fix backend behavior",
      prBody: "Body",
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    expect(host.appendAndMirrorEvents).not.toHaveBeenCalled();
    expect(host.triggerPrCreation).toHaveBeenCalledWith(
      "session-1",
      "feature/backend-only-fix",
      "Changed backend behavior",
      "Fix backend behavior",
      "Body",
      undefined,
      undefined,
      "prompt-1",
      "abc123",
      undefined,
      undefined,
    );
  });

  // ARC-960: a pushed post_execution must register the publish follow-up with
  // host.waitUntil so the DO cannot go idle before the publish promise settles.
  function pushedPostExecutionEvent(
    overrides: Partial<Extract<SandboxEvent, { type: "post_execution" }>> = {},
  ): Extract<SandboxEvent, { type: "post_execution" }> {
    return {
      type: "post_execution",
      pushed: true,
      messageId: "prompt-1",
      hasChanges: true,
      branch: "feature/arc-960",
      commitSha: "abc123",
      diffSummary: "Tracked publish follow-up",
      prTitle: "Track publish follow-up",
      prBody: "Body",
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it("registers the post_execution PR creation follow-up with host.waitUntil", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handlePostExecution(pushedPostExecutionEvent(), "session-1");

    expect(host.triggerPrCreation).toHaveBeenCalledTimes(1);
    expect(host.triggerPrCreation).toHaveBeenCalledWith(
      "session-1",
      "feature/arc-960",
      "Tracked publish follow-up",
      "Track publish follow-up",
      "Body",
      undefined,
      undefined,
      "prompt-1",
      "abc123",
      undefined,
      undefined,
    );
    expect(host.triggerPrUpdate).not.toHaveBeenCalled();
    expect(host.waitUntil).toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "test-dd-key", WORKER_ENV: "test" }),
      expect.objectContaining({
        event: "auto_publish.decision",
        session_id: "session-1",
        prompt_id: "prompt-1",
        owner_user_id: "user-1",
        source: "post_execution",
        decision: "trigger_create",
        reason: "auto_create_enabled",
        branch: "feature/arc-960",
        commit_sha: "abc123",
        has_changes: true,
        pushed: true,
        active_prompt_id: null,
        existing_pr_url: null,
        publish_status: "not_started",
      }),
    );
  });

  it("completes the active prompt before publishing when post_execution overtakes session_idle", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "processing", result: null, completedAt: null })],
      activePromptId: "prompt-1",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handlePostExecution(pushedPostExecutionEvent(), "session-1");

    const prompts = (await storage.get("prompts")) as PromptState[];
    expect(prompts[0]).toMatchObject({
      promptId: "prompt-1",
      status: "completed",
      result: {
        branch: "feature/arc-960",
        diffSummary: "Tracked publish follow-up",
      },
    });
    expect(await storage.get("activePromptId")).toBeNull();
    expect(host.triggerPrCreation).toHaveBeenCalledTimes(1);
    expect(host.armPlatformLlmPostExecutionWindow).not.toHaveBeenCalled();
    expect(host.markPlatformLlmPromptTerminal).toHaveBeenCalledWith("session-1", "prompt-1");
  });

  it("holds platform LLM capabilities open when session_idle arms post-execution", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "processing", result: null, completedAt: null })],
      activePromptId: "prompt-1",
    });

    const { host } = createHost(storage);
    vi.mocked(host.armPlatformLlmPostExecutionWindow).mockResolvedValue("held");
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: true }, "prompt-1", "session_idle");

    expect(host.armPlatformLlmPostExecutionWindow).toHaveBeenCalledWith("session-1", "prompt-1");
    expect(host.markPlatformLlmPromptTerminal).not.toHaveBeenCalled();
  });

  it("rejects a forged unsafe branch name from post_execution but keeps the commit sha", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "processing", result: null, completedAt: null })],
      activePromptId: "prompt-1",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handlePostExecution(
      pushedPostExecutionEvent({ branch: "--upload-pack=touch /tmp/pwned" }),
      "session-1",
    );

    const ext = getSessionExtended(storage.sql as unknown as SqlStorage, "session-1");
    expect(ext?.lastBranch).toBeNull();
    expect(ext?.lastCommitSha).toBe("abc123");
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: "--upload-pack=touch /tmp/pwned" }),
      "Rejected unsafe sandbox-supplied branch name from post_execution",
    );
  });

  it("persists a valid branch name from post_execution", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "processing", result: null, completedAt: null })],
      activePromptId: "prompt-1",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handlePostExecution(pushedPostExecutionEvent(), "session-1");

    const ext = getSessionExtended(storage.sql as unknown as SqlStorage, "session-1");
    expect(ext?.lastBranch).toBe("feature/arc-960");
    expect(ext?.lastCommitSha).toBe("abc123");
  });

  it("registers the post_execution PR update follow-up with host.waitUntil when a PR already exists", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handlePostExecution(pushedPostExecutionEvent(), "session-1");

    expect(host.triggerPrUpdate).toHaveBeenCalledTimes(1);
    expect(host.triggerPrUpdate).toHaveBeenCalledWith(
      "session-1",
      "feature/arc-960",
      "Tracked publish follow-up",
      "Track publish follow-up",
      "Body",
      undefined,
      undefined,
      "prompt-1",
      "abc123",
      undefined,
      undefined,
    );
    expect(host.triggerPrCreation).not.toHaveBeenCalled();
    expect(host.waitUntil).toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "test-dd-key", WORKER_ENV: "test" }),
      expect.objectContaining({
        event: "auto_publish.decision",
        session_id: "session-1",
        prompt_id: "prompt-1",
        source: "post_execution",
        decision: "trigger_update",
        reason: "existing_pr",
        branch: "feature/arc-960",
        existing_pr_url: "https://github.com/acme/repo/pull/7",
        pushed: true,
      }),
    );
  });

  it("updates an existing PR instead of opening a new one on post-execution", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handlePostExecution(pushedPostExecutionEvent(), "session-1");

    expect(host.triggerPrUpdate).toHaveBeenCalledTimes(1);
    expect(host.triggerPrCreation).not.toHaveBeenCalled();
  });

  it("logs and captures Sentry when the tracked PR creation follow-up rejects", async () => {
    vi.mocked(Sentry.captureException).mockClear();
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host } = createHost(storage);
    const creationError = new Error("create boom");
    host.triggerPrCreation.mockRejectedValueOnce(creationError);
    const queue = createSessionPromptQueue(host);

    await queue.handlePostExecution(pushedPostExecutionEvent(), "session-1");
    // The mock waitUntil discards the promise, so await every tracked promise to
    // settle the runWithSentryTag catch before asserting (not just mock wiring).
    await Promise.all(host.waitUntil.mock.calls.map((call) => call[0]));

    expect(host.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", branch: "feature/arc-960", operation: "triggerPrCreation" }),
      "PR creation failed",
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(creationError, {
      tags: { operation: "triggerPrCreation", sessionId: "session-1" },
    });
  });

  it("logs and captures Sentry when the tracked PR update follow-up rejects", async () => {
    vi.mocked(Sentry.captureException).mockClear();
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      prUrl: "https://github.com/acme/repo/pull/7",
      prNumber: 7,
    });

    const { host } = createHost(storage);
    const updateError = new Error("update boom");
    host.triggerPrUpdate.mockRejectedValueOnce(updateError);
    const queue = createSessionPromptQueue(host);

    await queue.handlePostExecution(pushedPostExecutionEvent(), "session-1");
    await Promise.all(host.waitUntil.mock.calls.map((call) => call[0]));

    expect(host.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", branch: "feature/arc-960", operation: "triggerPrUpdate" }),
      "PR update failed",
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(updateError, {
      tags: { operation: "triggerPrUpdate", sessionId: "session-1" },
    });
  });

  it("does not start publish work while a prompt is still actively processing", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [
        makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" }),
        makePrompt({ promptId: "prompt-2", status: "processing", completedAt: null }),
      ],
      // A follow-up prompt is still processing → getActiveProcessingPromptId is
      // truthy → the !currentActiveId guard must suppress the publish trigger.
      activePromptId: "prompt-2",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handlePostExecution(pushedPostExecutionEvent(), "session-1");

    expect(host.triggerPrCreation).not.toHaveBeenCalled();
    expect(host.triggerPrUpdate).not.toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "test-dd-key", WORKER_ENV: "test" }),
      expect.objectContaining({
        event: "auto_publish.decision",
        session_id: "session-1",
        prompt_id: "prompt-1",
        source: "post_execution",
        decision: "skip",
        reason: "active_prompt",
        branch: "feature/arc-960",
        active_prompt_id: "prompt-2",
        pushed: true,
      }),
    );
  });

  it("retries a pushed branch after the active prompt reaches a terminal state", async () => {
    // Keep this regression anchored to the prompt-settlement boundary.
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [
        makePrompt({
          status: "completed",
          completedAt: "2026-04-01T12:05:00.000Z",
          result: {
            branch: "feature/arc-960",
            commitSha: "abc123",
            diffSummary: "Updated the feature",
          },
        }),
        makePrompt({ promptId: "prompt-2", status: "processing", completedAt: null }),
      ],
      activePromptId: "prompt-2",
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      baseBranch: "main",
      lastBranch: "feature/arc-960",
      lastCommitSha: "abc123",
      publishStatus: "not_started",
    });
    updatePromptPushOutcome(storage.sql as unknown as SqlStorage, "prompt-1", {
      pushStatus: "succeeded",
      pushError: null,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handleSessionIdle(
      {
        type: "session_idle",
        messageId: "prompt-2",
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    expect(host.triggerPrCreation).toHaveBeenCalledWith(
      "session-1",
      "feature/arc-960",
      "Updated the feature",
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt-1",
      "abc123",
      undefined,
      undefined,
    );
  });

  it.each(["not_started", "failed"] as const)(
    "creates a PR for a previously pushed branch after a no-change follow-up drains the queue when publishStatus is %s",
    async (publishStatus) => {
      const storage = new MemoryStorage();
      await storage.put({
        session: makeSession(),
        prompts: [
          makePrompt({
            status: "completed",
            completedAt: "2026-04-01T12:05:00.000Z",
            result: {
              branch: "feature/mobile-chart-fix",
              commitSha: "abc123",
              diffSummary: "Updated mobile chart layout",
            },
          }),
          makePrompt({
            promptId: "prompt-2",
            prompt: "Are these mobile only changes?",
            status: "completed",
            completedAt: "2026-04-01T12:06:00.000Z",
          }),
        ],
        activePromptId: null,
      });
      updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
        baseBranch: "main",
        lastBranch: "feature/mobile-chart-fix",
        lastCommitSha: "abc123",
        publishStatus,
      });
      updatePromptPushOutcome(storage.sql as unknown as SqlStorage, "prompt-1", {
        pushStatus: "succeeded",
        pushError: null,
      });
      const deferredVerification = {
        verified: false,
        status: "manual_review_required",
        verdict: "INCONCLUSIVE",
        publishMode: "draft",
        explanation: "Typecheck failed.",
      };
      const deferredPrReadiness = {
        changedFiles: ["public/app.js"],
        diffStats: { raw: "1 file changed", filesChanged: 1, insertions: 1, deletions: 0 },
      };
      const deferredPrTemplateFill = {
        template: {
          source: "repo_local",
          path: ".github/pull_request_template.md",
          content: "## Description\n",
        },
        input: {
          headings: ["Description"],
          narrative: "Updated mobile chart layout",
          taskPrompt: "",
          diffSummary: "Updated mobile chart layout",
          diffSizeBand: "small",
          instructions: null,
          factPlacement: "body",
          commands: [],
        },
        generatedBody: "Updated mobile chart layout",
      } satisfies Extract<SandboxEvent, { type: "post_execution" }>["prTemplateFill"];
      await storage.put("verification", deferredVerification);
      await storage.put("pr_readiness", deferredPrReadiness);
      await storage.put("pr_template_fill", deferredPrTemplateFill);

      const { host } = createHost(storage);
      host.triggerPrCreation.mockImplementationOnce(async () => {
        expect(getSessionExtended(storage.sql as unknown as SqlStorage, "session-1")?.publishStatus).toBe(
          "not_started",
        );
      });
      const queue = createSessionPromptQueue(host);
      const event: Extract<SandboxEvent, { type: "post_execution" }> = {
        type: "post_execution",
        messageId: "prompt-2",
        hasChanges: false,
        noChangeReason: "no_diff",
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      };

      await queue.handlePostExecution(event, "session-1");

      expect(host.triggerPrCreation).toHaveBeenCalledWith(
        "session-1",
        "feature/mobile-chart-fix",
        "Updated mobile chart layout",
        undefined,
        undefined,
        deferredVerification,
        deferredPrReadiness,
        "prompt-1",
        "abc123",
        undefined,
        deferredPrTemplateFill,
      );
      expect(host.triggerPrUpdate).not.toHaveBeenCalled();
      expect(host.waitUntil).toHaveBeenCalled();
      expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
        expect.objectContaining({ DD_API_KEY: "test-dd-key", WORKER_ENV: "test" }),
        expect.objectContaining({
          event: "auto_publish.decision",
          session_id: "session-1",
          prompt_id: "prompt-1",
          owner_user_id: "user-1",
          source: "deferred",
          decision: "trigger_create",
          reason: "auto_create_enabled",
          branch: "feature/mobile-chart-fix",
          commit_sha: "abc123",
          publish_status: "not_started",
          pushed: true,
        }),
      );
    },
  );

  it.each(["publishing", "skipped"] as const satisfies PublishStatus[])(
    "does not create a deferred PR when publishStatus is %s",
    async (publishStatus) => {
      const storage = new MemoryStorage();
      await storage.put({
        session: makeSession(),
        prompts: [
          makePrompt({
            status: "completed",
            completedAt: "2026-04-01T12:05:00.000Z",
            result: {
              branch: "feature/mobile-chart-fix",
              commitSha: "abc123",
              diffSummary: "Updated mobile chart layout",
            },
          }),
          makePrompt({
            promptId: "prompt-2",
            prompt: "Are these mobile only changes?",
            status: "completed",
            completedAt: "2026-04-01T12:06:00.000Z",
          }),
        ],
        activePromptId: null,
      });
      updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
        baseBranch: "main",
        lastBranch: "feature/mobile-chart-fix",
        lastCommitSha: "abc123",
        publishStatus,
      });
      updatePromptPushOutcome(storage.sql as unknown as SqlStorage, "prompt-1", {
        pushStatus: "succeeded",
        pushError: null,
      });

      const { host } = createHost(storage);
      const queue = createSessionPromptQueue(host);
      const event: Extract<SandboxEvent, { type: "post_execution" }> = {
        type: "post_execution",
        messageId: "prompt-2",
        hasChanges: false,
        noChangeReason: "no_diff",
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      };

      await queue.handlePostExecution(event, "session-1");

      expect(host.triggerPrCreation).not.toHaveBeenCalled();
      expect(host.triggerPrUpdate).not.toHaveBeenCalled();
      expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
        expect.objectContaining({ DD_API_KEY: "test-dd-key", WORKER_ENV: "test" }),
        expect.objectContaining({
          event: "auto_publish.decision",
          session_id: "session-1",
          owner_user_id: "user-1",
          source: "deferred",
          decision: "skip",
          reason: "publish_status_ineligible",
          branch: "feature/mobile-chart-fix",
          commit_sha: "abc123",
          publish_status: publishStatus,
        }),
      );
    },
  );

  it.each([
    {
      name: "an existing PR is attached",
      sessionFields: {
        baseBranch: "main",
        lastBranch: "feature/mobile-chart-fix",
        lastCommitSha: "abc123",
        prUrl: "https://github.com/acme/repo/pull/7",
        prNumber: 7,
        publishStatus: "not_started",
      },
      prompts: [
        makePrompt({
          status: "completed",
          completedAt: "2026-04-01T12:05:00.000Z",
          result: {
            branch: "feature/mobile-chart-fix",
            commitSha: "abc123",
            diffSummary: "Updated mobile chart layout",
          },
        }),
        makePrompt({ promptId: "prompt-2", status: "completed", completedAt: "2026-04-01T12:06:00.000Z" }),
      ],
      expected: {
        reason: "existing_pr_attached",
        branch: "feature/mobile-chart-fix",
        existing_pr_url: "https://github.com/acme/repo/pull/7",
      },
    },
    {
      name: "the branch is missing",
      sessionFields: {
        baseBranch: "main",
        lastBranch: null,
        lastCommitSha: "abc123",
        publishStatus: "not_started",
      },
      prompts: [makePrompt({ promptId: "prompt-2", status: "completed", completedAt: "2026-04-01T12:06:00.000Z" })],
      expected: {
        reason: "branch_missing",
        branch: null,
        commit_sha: "abc123",
      },
    },
    {
      name: "the branch is the base branch",
      sessionFields: {
        baseBranch: "main",
        lastBranch: "main",
        lastCommitSha: "abc123",
        publishStatus: "not_started",
      },
      prompts: [makePrompt({ promptId: "prompt-2", status: "completed", completedAt: "2026-04-01T12:06:00.000Z" })],
      expected: {
        reason: "branch_is_base",
        branch: "main",
        commit_sha: "abc123",
      },
    },
    {
      name: "the source prompt is missing",
      sessionFields: {
        baseBranch: "main",
        lastBranch: "feature/mobile-chart-fix",
        lastCommitSha: "abc123",
        publishStatus: "not_started",
      },
      prompts: [makePrompt({ promptId: "prompt-2", status: "completed", completedAt: "2026-04-01T12:06:00.000Z" })],
      expected: {
        reason: "source_prompt_missing",
        branch: "feature/mobile-chart-fix",
        commit_sha: "abc123",
      },
    },
    {
      name: "the push outcome is missing",
      sessionFields: {
        baseBranch: "main",
        lastBranch: "feature/mobile-chart-fix",
        lastCommitSha: "abc123",
        publishStatus: "not_started",
      },
      prompts: [
        makePrompt({
          status: "completed",
          completedAt: "2026-04-01T12:05:00.000Z",
          result: {
            branch: "feature/mobile-chart-fix",
            commitSha: "abc123",
            diffSummary: "Updated mobile chart layout",
          },
        }),
        makePrompt({ promptId: "prompt-2", status: "completed", completedAt: "2026-04-01T12:06:00.000Z" }),
      ],
      expected: {
        reason: "push_outcome_missing",
        branch: "feature/mobile-chart-fix",
        commit_sha: "abc123",
      },
    },
  ])("emits deferred skip telemetry when $name", async ({ sessionFields, prompts, expected }) => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts,
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", sessionFields);

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      messageId: "prompt-2",
      hasChanges: false,
      noChangeReason: "no_diff",
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    expect(host.triggerPrCreation).not.toHaveBeenCalled();
    expect(host.triggerPrUpdate).not.toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "test-dd-key", WORKER_ENV: "test" }),
      expect.objectContaining({
        event: "auto_publish.decision",
        session_id: "session-1",
        owner_user_id: "user-1",
        source: "deferred",
        decision: "skip",
        publish_status: "not_started",
        ...expected,
      }),
    );
  });

  it("does not create a deferred PR when the source branch push did not succeed", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [
        makePrompt({
          status: "completed",
          completedAt: "2026-04-01T12:05:00.000Z",
          result: {
            branch: "feature/mobile-chart-fix",
            commitSha: "abc123",
            diffSummary: "Updated mobile chart layout",
          },
        }),
        makePrompt({
          promptId: "prompt-2",
          prompt: "Are these mobile only changes?",
          status: "completed",
          completedAt: "2026-04-01T12:06:00.000Z",
        }),
      ],
      activePromptId: null,
    });
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      baseBranch: "main",
      lastBranch: "feature/mobile-chart-fix",
      lastCommitSha: "abc123",
      publishStatus: "not_started",
    });
    updatePromptPushOutcome(storage.sql as unknown as SqlStorage, "prompt-1", {
      pushStatus: "unknown",
      pushError: null,
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      messageId: "prompt-2",
      hasChanges: false,
      noChangeReason: "no_diff",
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    expect(host.triggerPrCreation).not.toHaveBeenCalled();
    expect(host.triggerPrUpdate).not.toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "test-dd-key", WORKER_ENV: "test" }),
      expect.objectContaining({
        event: "auto_publish.decision",
        session_id: "session-1",
        prompt_id: "prompt-1",
        source: "deferred",
        decision: "skip",
        reason: "push_not_succeeded",
        branch: "feature/mobile-chart-fix",
        commit_sha: "abc123",
        publish_status: "not_started",
        pushed: null,
      }),
    );
  });

  it("queues callback usage/completion writes and snapshots finalize context", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "processing", completedAt: null, result: null, error: null })],
      activePromptId: "prompt-1",
      sandbox_status: "ready",
    });

    const { host, flushTerminalSideEffects } = createHost(storage);
    vi.mocked(host.capturePromptFinalizeContext).mockReturnValue({
      repo: "acme/repo",
      sandboxId: "sandbox-callback",
      modalObjectId: "modal-callback",
      codexSessionId: "codex-callback",
      promptDispatchedToAgent: null,
    });

    const queue = createSessionPromptQueue(host);
    const response = await queue.handlePromptCallbackRequest(
      new Request("https://internal/session/prompts/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId: "prompt-1", result: { ok: true } }),
      }),
    );

    expect(response.status).toBe(200);
    expect(host.writeUsageToD1).not.toHaveBeenCalled();
    expect(host.writeCompletionToD1).not.toHaveBeenCalled();
    expect(host.finalizePromptRun).not.toHaveBeenCalled();

    await flushTerminalSideEffects();

    expect(host.writeUsageToD1).toHaveBeenCalledWith("session-1", "user-1", "prompt-1");
    expect(host.writeCompletionToD1).toHaveBeenCalledWith("session-1", "user-1", "prompt-1", {
      success: true,
    });
    expect(host.finalizePromptRun).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ promptId: "prompt-1", status: "completed" }),
      expect.objectContaining({ sessionId: "session-1" }),
      undefined,
      {
        repo: "acme/repo",
        sandboxId: "sandbox-callback",
        modalObjectId: "modal-callback",
        codexSessionId: "codex-callback",
        promptDispatchedToAgent: null,
      },
    );
  });

  it("captures a completed plan prompt and dispatches the implementation handoff", async () => {
    const storage = new MemoryStorage();
    const planMarkdown = makeValidPlanMarkdown();
    await storage.put({
      session: makeSession({ planMode: true }),
      prompts: [makePrompt({ promptId: "p-1", status: "processing", completedAt: null, result: null, error: null })],
      activePromptId: "p-1",
      sandbox_status: "ready",
    });
    appendEventsWithReplay(
      storage.sql as unknown as Parameters<typeof appendEventsWithReplay>[0],
      "session-1",
      [{ type: "text", data: { id: "plan-part", text: planMarkdown } }],
      "p-1",
    );

    const { host, sentCommands, flushTerminalSideEffects } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const response = await queue.handlePromptCallbackRequest(
      new Request("https://internal/session/prompts/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId: "p-1", result: { ok: true } }),
      }),
    );

    expect(response.status).toBe(200);
    await flushTerminalSideEffects();

    const prompts = getPrompts(storage.sql, "session-1");
    expect(prompts.map((prompt) => [prompt.promptId, prompt.status])).toEqual([
      ["p-1", "completed"],
      ["p-2", "processing"],
    ]);
    expect(prompts[1].planContext).toMatchObject({
      planPromptId: "p-1",
      valid: true,
      artifactId: "artifact-plan-1",
      missingReason: null,
    });
    expect(prompts[1].planContext?.excerpt).toContain("## Verification Plan");
    expect(sentCommands[0]).toMatchObject({
      type: "prompt",
      messageId: "p-2",
      agentProfile: "build",
      planContext: expect.objectContaining({
        planPromptId: "p-1",
        valid: true,
      }),
    });
    expect(host.uploadPlanMarkdownArtifact).toHaveBeenCalledWith("session-1", "p-1", expect.stringContaining("# Plan"));
    // Plan turns still record usage + finalize telemetry (billing / trace
    // completeness); only the user-facing memory-review bot is suppressed.
    expect(host.writeUsageToD1).toHaveBeenCalledWith("session-1", "user-1", "p-1");
    expect(host.finalizePromptRun).toHaveBeenCalled();
    expect(host.runMemoryReviewBot).not.toHaveBeenCalled();
    expect(host.appendAndMirrorEvents).toHaveBeenCalledWith(
      "session-1",
      expect.arrayContaining([
        expect.objectContaining({
          type: "prompt_enqueued",
          data: expect.objectContaining({ promptId: "p-2" }),
        }),
        expect.objectContaining({
          type: "prompt_processing",
          data: expect.objectContaining({ promptId: "p-2" }),
        }),
      ]),
    );
  });

  it("keeps the dormant ungated splice ordering and plan-mode metrics unchanged", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true, planApprovalRequired: false }),
      prompts: [
        makePrompt({ promptId: "p-1", status: "processing", completedAt: null, result: null, error: null }),
        makePrompt({ promptId: "p-2", prompt: "Queued follow-up", status: "queued", startedAt: null }),
      ],
      activePromptId: "p-1",
      sandbox_status: "ready",
    });
    appendEventsWithReplay(
      storage.sql as unknown as Parameters<typeof appendEventsWithReplay>[0],
      "session-1",
      [{ type: "text", data: { id: "plan-part", text: makeValidPlanMarkdown() } }],
      "p-1",
    );
    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: true });

    expect(getPrompts(storage.sql, "session-1").map((prompt) => [prompt.promptId, prompt.status])).toEqual([
      ["p-1", "completed"],
      ["p-3", "processing"],
      ["p-2", "queued"],
    ]);
    expect(getPrompts(storage.sql, "session-1")[1]?.planContext).not.toHaveProperty("revision");
    expect(
      mockPostStructuredEventToDd.mock.calls
        .map(([, event]) => (event as { event?: string }).event)
        .filter((event) => event?.startsWith("arcanist.plan_mode.")),
    ).toEqual(["arcanist.plan_mode.turn_ran", "arcanist.plan_mode.captured", "arcanist.plan_mode.handoff"]);
    expect(host.onPlanApprovalParked).not.toHaveBeenCalled();
  });

  it("parks a gated plan without allocating or promoting implementation or queued follow-ups", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true, planApprovalRequired: true }),
      prompts: [
        makePrompt({ promptId: "p-1", status: "processing", completedAt: null, result: null, error: null }),
        makePrompt({ promptId: "p-2", prompt: "Held follow-up", status: "queued", startedAt: null }),
      ],
      activePromptId: "p-1",
      sandbox_status: "ready",
    });
    appendEventsWithReplay(
      storage.sql as unknown as Parameters<typeof appendEventsWithReplay>[0],
      "session-1",
      [{ type: "text", data: { id: "plan-part", text: makeValidPlanMarkdown() } }],
      "p-1",
    );

    const { host, sentCommands, flushTerminalSideEffects } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const response = await queue.handlePromptCallbackRequest(
      new Request("https://internal/session/prompts/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId: "p-1", result: { ok: true } }),
      }),
    );

    expect(response.status).toBe(200);
    await flushTerminalSideEffects();

    expect(getPrompts(storage.sql, "session-1").map((prompt) => [prompt.promptId, prompt.status])).toEqual([
      ["p-1", "completed"],
      ["p-2", "queued"],
    ]);
    expect(getLatestSessionPlan(storage.sql, "session-1")).toMatchObject({
      planPromptId: "p-1",
      implementationPromptId: null,
      status: "pending",
      revision: 1,
      valid: true,
    });
    expect(sentCommands).toHaveLength(0);
    expect(host.onPlanApprovalParked).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", planPromptId: "p-1", revision: 1, valid: true }),
    );
    expect(host.runMemoryReviewBot).not.toHaveBeenCalled();
    expect(host.notifySlackThread).not.toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "arcanist.plan_mode.parked", sessionId: "session-1", promptId: "p-1" }),
    );
  });

  it("does not re-arm the gate when a late plan turn completes after approval", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true, planApprovalRequired: true }),
      prompts: [
        makePrompt({
          promptId: "p-1",
          isPlanPrompt: true,
          status: "processing",
          completedAt: null,
          result: null,
          error: null,
        }),
        makePrompt({ promptId: "p-2", prompt: "Held follow-up", status: "queued", startedAt: null }),
      ],
      activePromptId: "p-1",
      sandbox_status: "ready",
    });
    upsertSessionPlan(storage.sql, {
      sessionId: "session-1",
      planPromptId: "p-approved-plan",
      implementationPromptId: "p-approved-implementation",
      markdown: makeValidPlanMarkdown(),
      excerpt: makeValidPlanMarkdown(),
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "approved",
      revision: 7,
      approvedBy: "user-1",
      approvedAt: new Date().toISOString(),
    });
    appendEventsWithReplay(
      storage.sql as unknown as Parameters<typeof appendEventsWithReplay>[0],
      "session-1",
      [{ type: "text", data: { id: "late-plan-part", text: makeValidPlanMarkdown() } }],
      "p-1",
    );
    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: true });

    expect(getLatestSessionPlan(storage.sql, "session-1")).toMatchObject({
      status: "approved",
      revision: 7,
      implementationPromptId: "p-approved-implementation",
    });
    expect(host.onPlanApprovalParked).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing final response",
      success: true,
      markdown: null,
      captureFails: false,
      missingReason: "missing_final_response",
    },
    {
      name: "failed plan prompt",
      success: false,
      markdown: null,
      captureFails: false,
      missingReason: "plan_prompt_failed",
    },
    {
      name: "invalid plan",
      success: true,
      markdown: "# Plan\n\nIncomplete",
      captureFails: false,
      missingReason: "invalid_plan",
    },
    {
      name: "plan capture failure",
      success: true,
      markdown: null,
      captureFails: true,
      missingReason: "plan_capture_failed",
    },
  ])("parks gated $name instead of failing open", async ({ success, markdown, captureFails, missingReason }) => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true, planApprovalRequired: true }),
      prompts: [makePrompt({ promptId: "p-1", status: "processing", completedAt: null, result: null, error: null })],
      activePromptId: "p-1",
      sandbox_status: "ready",
    });
    if (markdown) {
      appendEventsWithReplay(
        storage.sql as unknown as Parameters<typeof appendEventsWithReplay>[0],
        "session-1",
        [{ type: "text", data: { id: "plan-part", text: markdown } }],
        "p-1",
      );
    }
    if (captureFails) {
      const exec = storage.sql.exec.bind(storage.sql);
      vi.spyOn(storage.sql, "exec").mockImplementation(((query: string, ...args: SqlStorageValue[]) => {
        if (query.startsWith("SELECT * FROM events")) throw new Error("capture read failed");
        return exec(query, ...args);
      }) as typeof storage.sql.exec);
    }
    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success, ...(success ? {} : { error: "failed" }) });

    expect(getPrompts(storage.sql, "session-1")).toHaveLength(1);
    expect(getLatestSessionPlan(storage.sql, "session-1")).toMatchObject({
      status: "pending",
      revision: 1,
      valid: false,
      missingReason,
    });
    expect(host.onPlanApprovalParked).toHaveBeenCalledWith(expect.objectContaining({ valid: false, missingReason }));
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "arcanist.plan_mode.parked", missingReason }),
    );
  });

  it("parks a failed gated execution_complete and keeps the queued follow-up frozen", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true, planApprovalRequired: true }),
      prompts: [
        makePrompt({ promptId: "p-1", status: "processing", completedAt: null, result: null, error: null }),
        makePrompt({ promptId: "p-2", status: "queued", startedAt: null }),
      ],
      activePromptId: "p-1",
      sandbox_status: "ready",
    });
    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "p-1",
        success: false,
        error: "plan failed",
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    expect(getPrompts(storage.sql, "session-1").map((prompt) => [prompt.promptId, prompt.status])).toEqual([
      ["p-1", "failed"],
      ["p-2", "queued"],
    ]);
    expect(getLatestSessionPlan(storage.sql, "session-1")).toMatchObject({
      status: "pending",
      missingReason: "plan_prompt_failed",
    });
    expect(host.onPlanApprovalParked).toHaveBeenCalled();
  });

  it("classifies a parked enqueue as Discuss, supersedes authority, and carries durable revision context", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true, planApprovalRequired: true }),
      prompts: [
        makePrompt({
          promptId: "p-1",
          prompt: "Add a build-status badge to the README",
          replyToText: "Add a build-status badge to the README",
          branchNameHint: "add-build-status-badge",
          skills: ["readme-maintainer"],
          files: ["README.md"],
          uploadedFiles: [{ name: "badge-notes.txt", content: "Use the CI workflow status." }],
          uploadedImages: [{ name: "badge.png", mediaType: "image/png", data: "aW1hZ2U=" }],
          status: "completed",
        }),
      ],
      activePromptId: null,
      sandbox_status: "ready",
    });
    storage.sql.exec(
      "UPDATE prompts SET reply_to_text = ?, branch_name_hint = ? WHERE session_id = ? AND prompt_id = ?",
      "Add a build-status badge to the README",
      "add-build-status-badge",
      "session-1",
      "p-1",
    );
    updateSessionFields(storage.sql, "session-1", { promptCounter: 1 });
    upsertSessionPlan(storage.sql, {
      sessionId: "session-1",
      planPromptId: "p-1",
      implementationPromptId: null,
      markdown: makeValidPlanMarkdown(),
      excerpt: makeValidPlanMarkdown(),
      artifactId: "artifact-plan-1",
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 4,
      userEdited: true,
    });
    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Use shields.io in step two",
          actorUserId: "reviewer-2",
          source: "web",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(getLatestSessionPlan(storage.sql, "session-1")?.status).toBe("superseded");
    const discuss = getPrompts(storage.sql, "session-1").find((prompt) => prompt.promptId === "p-2");
    expect(discuss).toMatchObject({
      status: "processing",
      isPlanPrompt: true,
      replyToText: "Use shields.io in step two",
      branchNameHint: "add-build-status-badge",
      actorUserId: "reviewer-2",
      skills: ["readme-maintainer"],
      files: ["README.md"],
      uploadedFiles: [{ name: "badge-notes.txt", content: "Use the CI workflow status." }],
      uploadedImages: [{ name: "badge.png", mediaType: "image/png", data: "aW1hZ2U=" }],
      planContext: expect.objectContaining({ planPromptId: "p-1", revision: 4, userEdited: true }),
    });
    expect(sentCommands[0]).toMatchObject({
      type: "prompt",
      messageId: "p-2",
      agentProfile: "plan",
      branchNameHint: "add-build-status-badge",
      actorUserId: "reviewer-2",
      skills: ["readme-maintainer"],
      files: ["README.md"],
      planContext: expect.objectContaining({ revision: 4, userEdited: true }),
    });
    expect(sentCommands[0]?.content).toContain("Add a build-status badge to the README");
    expect(sentCommands[0]?.content).toContain("Use shields.io in step two");
    expect(turnModeForAgentProfile(String(sentCommands[0]?.agentProfile))).toBe("plan");
    expect(host.onPlanApprovalDiscussion).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", planPromptId: "p-1", revision: 4, promptId: "p-2" }),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "arcanist.plan_mode.discussed", revision: 4 }),
    );
  });

  it("durably commits the Discuss prompt with authoritative supersession before event mirroring", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true, planApprovalRequired: true }),
      prompts: [makePrompt({ promptId: "p-1", prompt: "Original task", status: "completed" })],
      activePromptId: null,
      sandbox_status: "ready",
    });
    updateSessionFields(storage.sql, "session-1", { promptCounter: 1 });
    upsertSessionPlan(storage.sql, {
      sessionId: "session-1",
      planPromptId: "p-1",
      implementationPromptId: null,
      markdown: makeValidPlanMarkdown(),
      excerpt: makeValidPlanMarkdown(),
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 2,
    });
    const { host } = createHost(storage);
    host.appendAndMirrorEvents.mockRejectedValueOnce(new Error("injected mirror failure"));
    const queue = createSessionPromptQueue(host);

    await expect(
      queue.handlePromptEnqueueRequest(
        new Request("https://internal/session/prompts/enqueue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Revise the verification step", actorUserId: "user-1" }),
        }),
      ),
    ).rejects.toThrow("injected mirror failure");

    expect(getLatestSessionPlan(storage.sql, "session-1")?.status).toBe("superseded");
    expect(getPrompts(storage.sql, "session-1")).toEqual(
      expect.arrayContaining([expect.objectContaining({ promptId: "p-2", status: "processing", isPlanPrompt: true })]),
    );
    expect(host.onPlanApprovalDiscussion).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", planPromptId: "p-1", promptId: "p-2" }),
    );
  });

  it("classifies a Slack thread reply through the same parked Discuss chokepoint", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({
        planMode: true,
        planApprovalRequired: true,
        callbackContext: { source: "slack", channel: "C1", threadTs: "1.1", slackTeamId: "T1" },
      }),
      prompts: [makePrompt({ promptId: "p-1", prompt: "Original Slack task", status: "completed" })],
      activePromptId: null,
      sandbox_status: "ready",
    });
    updateSessionFields(storage.sql, "session-1", {
      callbackContext: { source: "slack", channel: "C1", threadTs: "1.1", slackTeamId: "T1" },
    });
    updateSessionFields(storage.sql, "session-1", { promptCounter: 1 });
    upsertSessionPlan(storage.sql, {
      sessionId: "session-1",
      planPromptId: "p-1",
      implementationPromptId: null,
      markdown: makeValidPlanMarkdown(),
      excerpt: makeValidPlanMarkdown(),
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 1,
    });
    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Keep the rollout section shorter",
          source: "slack",
          replyToText: "Keep the rollout section shorter",
          replyToQuoteSource: { lines: [[{ type: "text", text: "Keep the rollout section shorter" }]] },
          actorUserId: "user-1",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(getPrompts(storage.sql, "session-1").at(-1)).toMatchObject({
      isPlanPrompt: true,
      planContext: expect.objectContaining({ revision: 1, userEdited: false }),
    });
    expect(sentCommands[0]).toMatchObject({ agent: "plan", agentProfile: "plan" });
    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "plan_mode.discuss_attempt", source: "slack", outcome: "accepted" }),
      "Plan discussion enqueued",
    );
  });

  it("re-parks a completed Discuss turn with the next pending revision while held follow-ups stay frozen", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true, planApprovalRequired: true }),
      prompts: [
        makePrompt({ promptId: "p-1", prompt: "Original task", status: "completed" }),
        makePrompt({ promptId: "p-2", prompt: "Held follow-up", status: "queued", startedAt: null }),
      ],
      activePromptId: null,
      sandbox_status: "ready",
    });
    updateSessionFields(storage.sql, "session-1", { promptCounter: 2 });
    upsertSessionPlan(storage.sql, {
      sessionId: "session-1",
      planPromptId: "p-1",
      implementationPromptId: null,
      markdown: makeValidPlanMarkdown(),
      excerpt: makeValidPlanMarkdown(),
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 4,
      userEdited: true,
    });
    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Revise the plan", actorUserId: "user-1" }),
      }),
    );
    appendEventsWithReplay(
      storage.sql as unknown as Parameters<typeof appendEventsWithReplay>[0],
      "session-1",
      [{ type: "text", data: { id: "revised-plan", text: makeValidPlanMarkdown() } }],
      "p-3",
    );

    await queue.completeActivePrompt("session-1", { success: true });

    expect(getLatestSessionPlan(storage.sql, "session-1")).toMatchObject({
      planPromptId: "p-3",
      status: "pending",
      revision: 5,
    });
    expect(getPrompts(storage.sql, "session-1").find((prompt) => prompt.promptId === "p-2")?.status).toBe("queued");
    expect(host.onPlanApprovalParked).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", planPromptId: "p-3", revision: 5 }),
    );

    await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Tighten the risks section", actorUserId: "user-1", source: "web" }),
      }),
    );
    expect(sentCommands[1]?.content).toContain("Original task");
    expect(sentCommands[1]?.content).toContain("Tighten the risks section");
    expect(sentCommands[1]?.content).not.toContain("Revise the plan");
  });

  it("keeps non-parked follow-up enqueue behavior dormant", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true, planApprovalRequired: true }),
      prompts: [makePrompt({ promptId: "p-1", status: "completed" })],
      activePromptId: null,
      sandbox_status: "ready",
    });
    updateSessionFields(storage.sql, "session-1", { promptCounter: 1 });
    const { host, sentCommands } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Ordinary follow-up", actorUserId: "user-1" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(getPrompts(storage.sql, "session-1").at(-1)).not.toHaveProperty("isPlanPrompt");
    expect(sentCommands[0]).toMatchObject({ agentProfile: "build" });
    expect(host.onPlanApprovalDiscussion).not.toHaveBeenCalled();
  });

  it("cancels the dedicated park-pause deadline on Stop while leaving plan authority pending", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true, planApprovalRequired: true }),
      prompts: [makePrompt({ promptId: "p-1", status: "completed" })],
      activePromptId: null,
      sandbox_status: "ready",
    });
    upsertSessionPlan(storage.sql, {
      sessionId: "session-1",
      planPromptId: "p-1",
      implementationPromptId: null,
      markdown: makeValidPlanMarkdown(),
      excerpt: makeValidPlanMarkdown(),
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 1,
    });
    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handleStopRequest();

    expect(response.status).toBe(200);
    expect(host.cancelPlanParkPause).toHaveBeenCalledTimes(1);
    expect(host.onPlanApprovalStopped).toHaveBeenCalledWith("session-1");
    expect(getLatestSessionPlan(storage.sql, "session-1")?.status).toBe("pending");
  });

  it("keeps a valid plan context when artifact upload fails", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ planMode: true }),
      prompts: [makePrompt({ promptId: "p-1", status: "processing", completedAt: null, result: null, error: null })],
      activePromptId: "p-1",
      sandbox_status: "ready",
    });
    appendEventsWithReplay(
      storage.sql as unknown as Parameters<typeof appendEventsWithReplay>[0],
      "session-1",
      [{ type: "text", data: { id: "plan-part", text: makeValidPlanMarkdown() } }],
      "p-1",
    );

    const { host, flushTerminalSideEffects } = createHost(storage);
    host.uploadPlanMarkdownArtifact.mockRejectedValueOnce(new Error("artifact store unavailable"));
    const queue = createSessionPromptQueue(host);
    const response = await queue.handlePromptCallbackRequest(
      new Request("https://internal/session/prompts/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId: "p-1", result: { ok: true } }),
      }),
    );

    expect(response.status).toBe(200);
    await flushTerminalSideEffects();

    const prompts = getPrompts(storage.sql, "session-1");
    expect(prompts[1].planContext).toMatchObject({
      planPromptId: "p-1",
      valid: true,
      artifactId: null,
      missingReason: null,
    });
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "plan_mode_artifact_upload_failed",
        sessionId: "session-1",
        promptId: "p-1",
      }),
      "Plan mode artifact upload failed; continuing with captured plan context",
    );
  });

  it("hands off a failed plan callback with partial notes as invalid plan context", async () => {
    const storage = new MemoryStorage();
    const partialPlanMarkdown = [
      "# Plan",
      "## Intent Restatement",
      "Fix ARC-1440.",
      "## Ordered Steps",
      "1. Partial streamed note before the failure.",
    ].join("\n\n");
    await storage.put({
      session: makeSession({ planMode: true }),
      prompts: [makePrompt({ promptId: "p-1", status: "processing", completedAt: null, result: null, error: null })],
      activePromptId: "p-1",
      sandbox_status: "ready",
    });
    appendEventsWithReplay(
      storage.sql as unknown as Parameters<typeof appendEventsWithReplay>[0],
      "session-1",
      [{ type: "text", data: { id: "plan-part", text: partialPlanMarkdown } }],
      "p-1",
    );

    const { host, sentCommands, flushTerminalSideEffects } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const response = await queue.handlePromptCallbackRequest(
      new Request("https://internal/session/prompts/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId: "p-1", success: false, error: "plan prompt failed" }),
      }),
    );

    expect(response.status).toBe(200);
    await flushTerminalSideEffects();

    const prompts = getPrompts(storage.sql, "session-1");
    expect(prompts.map((prompt) => [prompt.promptId, prompt.status])).toEqual([
      ["p-1", "failed"],
      ["p-2", "processing"],
    ]);
    expect(prompts[1].planContext).toMatchObject({
      planPromptId: "p-1",
      valid: false,
      artifactId: "artifact-plan-1",
      missingReason: "plan_prompt_failed",
    });
    expect(prompts[1].planContext?.excerpt).toContain("Partial streamed note before the failure.");
    expect(sentCommands[0]).toMatchObject({
      type: "prompt",
      messageId: "p-2",
      agentProfile: "build",
      planContext: expect.objectContaining({
        planPromptId: "p-1",
        valid: false,
        missingReason: "plan_prompt_failed",
      }),
    });
  });

  it("marks failed callback finalization as trace-expected", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "processing", completedAt: null, result: null, error: null })],
      activePromptId: "prompt-1",
      sandbox_status: "ready",
    });

    const { host, flushTerminalSideEffects } = createHost(storage);
    vi.mocked(host.capturePromptFinalizeContext).mockReturnValue({
      repo: "acme/repo",
      sandboxId: "sandbox-callback",
      modalObjectId: "modal-callback",
      codexSessionId: "codex-callback",
      promptDispatchedToAgent: null,
    });

    const queue = createSessionPromptQueue(host);
    const response = await queue.handlePromptCallbackRequest(
      new Request("https://internal/session/prompts/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId: "prompt-1", success: false, error: "Sandbox execution failed" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(host.finalizePromptRun).not.toHaveBeenCalled();

    await flushTerminalSideEffects();

    expect(host.writeUsageToD1).toHaveBeenCalledWith("session-1", "user-1", "prompt-1");
    expect(host.writeCompletionToD1).toHaveBeenCalledWith("session-1", "user-1", "prompt-1", {
      success: false,
    });
    expect(host.finalizePromptRun).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ promptId: "prompt-1", status: "failed" }),
      expect.objectContaining({ sessionId: "session-1" }),
      {
        errorCode: "sandbox_callback",
        traceExpected: true,
      },
      {
        repo: "acme/repo",
        sandboxId: "sandbox-callback",
        modalObjectId: "modal-callback",
        codexSessionId: "codex-callback",
        promptDispatchedToAgent: null,
      },
    );
  });

  it("does not mark any non-execution lifecycle terminal as trace-expected", async () => {
    // Loop the real set rather than a hand-picked subset (covers the top noise
    // sources spawn_deadline_*/sandbox_disconnected AND the semantically ambiguous
    // codex_transport_closed/codex_unrecoverable). A newly added code is thus
    // automatically asserted to finalize without forcing trace_expected at the
    // source; finalizePromptRun's evidence-based re-derivation is the only thing
    // that may promote these back to true (tokens/tool calls/bt_span_id present),
    // and there is none here.
    for (const errorCode of NON_EXECUTION_TRACE_ERROR_CODES) {
      const storage = new MemoryStorage();
      await storage.put({
        session: makeSession(),
        prompts: [makePrompt({ status: "processing", completedAt: null, result: null, error: null })],
        activePromptId: "prompt-1",
        sandbox_status: "ready",
      });

      const { host, flushTerminalSideEffects } = createHost(storage);
      const queue = createSessionPromptQueue(host);
      await queue.completeActivePrompt(
        "session-1",
        { success: false, error: `terminal: ${errorCode}`, errorCode },
        "prompt-1",
        "execution_complete",
      );

      await flushTerminalSideEffects();

      const telemetry = vi.mocked(host.finalizePromptRun).mock.calls.at(-1)?.[3];
      expect(telemetry, `errorCode=${errorCode}`).toEqual({ errorCode });
    }
  });

  it("forces stale recovery finalization to stay trace-expected", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [
        makePrompt({
          status: "failed",
          completedAt: "2026-04-01T12:05:00.000Z",
          error: "Prompt running inactivity elapsed",
        }),
      ],
      activePromptId: null,
      sandbox_status: "ready",
    });
    upsertPromptTelemetry(storage.sql as unknown as SqlStorage, "prompt-1", { errorCode: "stale_prompt" });

    const { host, flushTerminalSideEffects } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "prompt-1",
        success: true,
        idleObserved: false,
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
      { traceExpected: false },
    );

    await flushTerminalSideEffects();

    const telemetry = vi.mocked(host.finalizePromptRun).mock.calls.at(-1)?.[3];
    expect(telemetry).toMatchObject({
      traceExpected: true,
      recoverStalePrompt: true,
    });
  });

  it("uses the host replay state for already-completed callback responses", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      prompts: [makePrompt({ status: "completed", completedAt: "2026-04-01T12:05:00.000Z" })],
      activePromptId: null,
    });

    const { host } = createHost(storage);
    const replay = {
      sessionId: "session-1",
      lastEventSequence: 4,
      lastEventTimestamp: "2026-04-01T12:05:00.000Z",
      updatedAt: "2026-04-01T12:05:00.000Z",
    };
    vi.mocked(host.getReplayState).mockResolvedValue(replay);

    const queue = createSessionPromptQueue(host);
    const response = await queue.handlePromptCallbackRequest(
      new Request("https://internal/session/prompts/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId: "prompt-1" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      replay,
      completedPrompt: { promptId: "prompt-1", status: "completed" },
    });
    expect(host.getReplayState).toHaveBeenCalledWith("session-1");
  });

  it("does not mirror SUCCESSFUL review-loop follow-up prompts to Slack on finalization", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-rl-1",
      prompts: [
        makePrompt({
          promptId: "prompt-rl-1",
          status: "processing",
          reviewLoopEpochId: "epoch-1",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: true });

    expect(host.notifySlackThread).not.toHaveBeenCalled();
  });

  it("persists completed prompt state before pending-question projection failures", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-1",
      prompts: [makePrompt({ promptId: "prompt-1", status: "processing", completedAt: null, error: null })],
      sandbox_status: "ready",
    });
    storage.sql.exec("UPDATE prompts SET has_pending_question = 1 WHERE prompt_id = ?", "prompt-1");

    const { host } = createHost(storage);
    host.setHasPendingQuestion.mockRejectedValueOnce(new Error("projection failed"));
    const queue = createSessionPromptQueue(host);

    await expect(queue.completeActivePrompt("session-1", { success: true })).rejects.toThrow("projection failed");

    const prompts = (await storage.get<Array<PromptState>>("prompts")) ?? [];
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      promptId: "prompt-1",
      status: "completed",
      error: null,
    });
    expect(prompts[0]?.completedAt).not.toBeNull();
    expect(
      storage.sql.exec("SELECT has_pending_question FROM prompts WHERE prompt_id = ?", "prompt-1").toArray()[0]
        ?.has_pending_question,
    ).toBe(0);
  });

  it("persists disconnected prompt failure before pending-question projection failures", async () => {
    const storage = new MemoryStorage();
    const session = makeSession();
    await storage.put({
      session,
      activePromptId: "prompt-1",
      prompts: [makePrompt({ promptId: "prompt-1", status: "processing", completedAt: null, error: null })],
      sandbox_status: "ready",
    });
    storage.sql.exec("UPDATE prompts SET has_pending_question = 1 WHERE prompt_id = ?", "prompt-1");
    // At the disconnect-retry cap the disconnect fails terminally (no re-run),
    // which is the crash-safety path under test here.
    storage.sql.exec("UPDATE prompts SET disconnect_retry_count = 2 WHERE prompt_id = ?", "prompt-1");

    const { host } = createHost(storage);
    host.setHasPendingQuestion.mockRejectedValueOnce(new Error("projection failed"));
    const queue = createSessionPromptQueue(host);

    await expect(queue.failActivePromptOnDisconnect(session, "prompt-1")).rejects.toThrow("projection failed");

    const prompts = (await storage.get<Array<PromptState>>("prompts")) ?? [];
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      promptId: "prompt-1",
      status: "failed",
      error: "Sandbox kept disconnecting after 3 attempts",
    });
    expect(prompts[0]?.completedAt).not.toBeNull();
    expect(
      storage.sql.exec("SELECT has_pending_question FROM prompts WHERE prompt_id = ?", "prompt-1").toArray()[0]
        ?.has_pending_question,
    ).toBe(0);
  });

  it("does not mirror a FAILED review-loop follow-up prompt to Slack either (full suppression)", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-rl-fail",
      prompts: [
        makePrompt({
          promptId: "prompt-rl-fail",
          status: "processing",
          reviewLoopEpochId: "epoch-1",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: false, error: "boom" });

    expect(host.notifySlackThread).not.toHaveBeenCalled();
  });

  it("leaves an ordinary failed review-loop prompt for the sweep to re-drive", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-rl-fail",
      prompts: [
        makePrompt({
          promptId: "prompt-rl-fail",
          status: "processing",
          reviewLoopEpochId: "epoch-1",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: false, error: "boom" });

    // A failed turn must leave the epoch in-flight (lease still set) so reconcileStuckReviewLoopEpochs
    // reclaims and re-drives it — completing it here would silently treat the review feedback as done.
    expect(host.resolveReviewLoopEpochForTerminalPrompt).not.toHaveBeenCalled();
  });

  it("blocks the owning review-loop epoch once when callback finalization reports codex_unrecoverable", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-rl-unrecoverable",
      prompts: [
        makePrompt({
          promptId: "prompt-rl-unrecoverable",
          status: "processing",
          reviewLoopEpochId: "epoch-1",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt(
      "session-1",
      { success: false, error: "rollout cannot be resumed", errorCode: "codex_unrecoverable" },
      "prompt-rl-unrecoverable",
      "execution_complete",
    );
    await queue.completeActivePrompt(
      "session-1",
      { success: false, error: "rollout cannot be resumed", errorCode: "codex_unrecoverable" },
      "prompt-rl-unrecoverable",
      "execution_complete",
    );

    expect(host.blockReviewLoopEpochForUnrecoverablePrompt).toHaveBeenCalledTimes(1);
    expect(host.blockReviewLoopEpochForUnrecoverablePrompt).toHaveBeenCalledWith(
      "session-1",
      "prompt-rl-unrecoverable",
      "epoch-1",
    );
  });

  it("blocks the owning review-loop epoch when execution_complete fails inline with codex_unrecoverable", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-rl-unrecoverable",
      prompts: [
        makePrompt({
          promptId: "prompt-rl-unrecoverable",
          status: "processing",
          reviewLoopEpochId: "epoch-1",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.handleExecutionComplete(
      {
        type: "execution_complete",
        messageId: "prompt-rl-unrecoverable",
        success: false,
        error: "rollout cannot be resumed",
        errorCode: "codex_unrecoverable",
        sandboxId: "sandbox-1",
        timestamp: Date.now(),
      },
      "session-1",
    );

    expect(host.blockReviewLoopEpochForUnrecoverablePrompt).toHaveBeenCalledWith(
      "session-1",
      "prompt-rl-unrecoverable",
      "epoch-1",
    );
  });

  it("keeps transport failures on the existing lease-reclaim path", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-rl-transport",
      prompts: [
        makePrompt({
          promptId: "prompt-rl-transport",
          status: "processing",
          reviewLoopEpochId: "epoch-1",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt(
      "session-1",
      { success: false, error: "transport closed", errorCode: "codex_transport_closed" },
      "prompt-rl-transport",
      "execution_complete",
    );

    expect(host.blockReviewLoopEpochForUnrecoverablePrompt).not.toHaveBeenCalled();
  });

  it("does not block an epoch when a verification prompt fails with codex_unrecoverable", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession({ agentRole: "verification" }),
      activePromptId: "prompt-verification-unrecoverable",
      prompts: [
        makePrompt({
          promptId: "prompt-verification-unrecoverable",
          status: "processing",
          reviewLoopEpochId: "epoch-1",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });
    storage.sql.exec("UPDATE session SET agent_role = 'verification' WHERE session_id = ?", "session-1");

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt(
      "session-1",
      { success: false, error: "rollout cannot be resumed", errorCode: "codex_unrecoverable" },
      "prompt-verification-unrecoverable",
      "execution_complete",
    );

    expect(host.blockReviewLoopEpochForUnrecoverablePrompt).not.toHaveBeenCalled();
  });

  it("completes the review-loop epoch on a SUCCESSFUL no-changes (reply-only/no-op) post_execution turn", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: null,
      prompts: [
        makePrompt({
          promptId: "prompt-rl-noop",
          status: "completed",
          completedAt: "2026-04-01T12:05:00.000Z",
          reviewLoopEpochId: "epoch-1",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: false,
      messageId: "prompt-rl-noop",
      hasChanges: false,
      noChangeReason: "reply_only",
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    // A successful reply-only/no-op turn never publishes, so this is the one path that completes the
    // epoch (so it does not sit in-flight forever).
    expect(host.resolveReviewLoopEpochForTerminalPrompt).toHaveBeenCalledWith("session-1", "prompt-rl-noop", "epoch-1");
  });

  it("resolves a successful review_loop_reply through the epoch resolver", async () => {
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: null,
      prompts: [
        makePrompt({
          promptId: "prompt-rl-reply",
          status: "completed",
          completedAt: "2026-04-01T12:05:00.000Z",
          reviewLoopEpochId: "epoch-1",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });
    storage.sql.exec(
      `INSERT INTO prompt_tool_stats (
         prompt_id, tool_name, mcp_server, ok_count, error_count, total_duration_ms, duration_sample_count
       ) VALUES (?, ?, NULL, 1, 0, 0, 0)`,
      "prompt-rl-reply",
      "cycloid.review_loop_reply",
    );

    const { host } = createHost(storage);
    const queue = createSessionPromptQueue(host);
    const event: Extract<SandboxEvent, { type: "post_execution" }> = {
      type: "post_execution",
      pushed: false,
      messageId: "prompt-rl-reply",
      hasChanges: false,
      noChangeReason: "reply_only",
      sandboxId: "sandbox-1",
      timestamp: Date.now(),
    };

    await queue.handlePostExecution(event, "session-1");

    expect(host.resolveReviewLoopEpochForTerminalPrompt).toHaveBeenCalledWith(
      "session-1",
      "prompt-rl-reply",
      "epoch-1",
    );
  });

  it("still mirrors normal prompts to Slack on finalization", async () => {
    const storage = new MemoryStorage();
    const slackPostStatements: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            slackPostStatements.push({ query, values });
            return this;
          },
          async run() {
            return { meta: { changes: 1 } };
          },
        };
      },
    };
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-normal-1",
      prompts: [
        makePrompt({
          promptId: "prompt-normal-1",
          status: "processing",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });
    updateSessionFields(storage.sql, "session-1", {
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "100.000",
        slackTeamId: "T1",
      },
    });

    const { host } = createHost(storage, { DB: db });
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: true });
    await Promise.all(host.waitUntil.mock.calls.map((call) => call[0]));

    expect(host.notifySlackThread).toHaveBeenCalledWith("session-1", "prompt-normal-1", true);
    expect(host.waitUntil).toHaveBeenCalled();
    expect(slackPostStatements[0].query).toContain("INSERT OR IGNORE INTO slack_posts");
    expect(slackPostStatements[0].values).toEqual(
      expect.arrayContaining(["session-1", "prompt-normal-1", "completed"]),
    );
    expect(host.rescheduleSessionAlarm).toHaveBeenCalled();
  });

  it("does not arm Slack retry rows for non-Slack prompt finalization", async () => {
    const storage = new MemoryStorage();
    const slackPostStatements: Array<{ query: string; values: unknown[] }> = [];
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            slackPostStatements.push({ query, values });
            return this;
          },
          async run() {
            return { meta: { changes: 1 } };
          },
        };
      },
    };
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-normal-1",
      prompts: [
        makePrompt({
          promptId: "prompt-normal-1",
          status: "processing",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });

    const { host } = createHost(storage, { DB: db });
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: true });

    expect(host.waitUntil).toHaveBeenCalled();
    expect(host.notifySlackThread).not.toHaveBeenCalled();
    expect(slackPostStatements).toEqual([]);
  });

  it("logs and captures Sentry when the tracked Slack notification rejects", async () => {
    vi.mocked(Sentry.captureException).mockClear();
    const storage = new MemoryStorage();
    await storage.put({
      session: makeSession(),
      activePromptId: "prompt-normal-1",
      prompts: [
        makePrompt({
          promptId: "prompt-normal-1",
          status: "processing",
          result: null,
          error: null,
        }),
      ],
      sandbox_status: "ready",
    });
    updateSessionFields(storage.sql, "session-1", {
      callbackContext: {
        source: "slack",
        channel: "C123",
        threadTs: "100.000",
        slackTeamId: "T1",
      },
    });

    const { host } = createHost(storage);
    const slackError = new Error("slack boom");
    host.notifySlackThread.mockRejectedValueOnce(slackError);
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: true });
    await Promise.all(host.waitUntil.mock.calls.map((call) => call[0]));

    expect(host.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1", operation: "notifySlackThread" }),
      "Slack thread notification error",
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(slackError, {
      tags: { operation: "notifySlackThread", sessionId: "session-1" },
    });
  });
});

describe("validatePromptEnqueueResumeState", () => {
  const stoppedNonResumable = { stopped: true, paused: false, expired: false, resumable: false };

  it("rejects a stopped non-resumable sandbox for a normal enqueue", () => {
    expect(validatePromptEnqueueResumeState(null, stoppedNonResumable, false)).toEqual({
      ok: false,
      reason: "stopped",
    });
  });

  it("cold-resumes a stopped non-resumable sandbox for a review-loop enqueue", () => {
    expect(validatePromptEnqueueResumeState(null, stoppedNonResumable, true)).toEqual({
      ok: true,
      isResumableSend: true,
    });
  });

  it("never marks a resumable send when a prompt is already active, even for a review-loop enqueue", () => {
    expect(validatePromptEnqueueResumeState("p-1", stoppedNonResumable, true)).toEqual({
      ok: true,
      isResumableSend: false,
    });
  });

  it("preserves the normal resumable-stopped cold-resume path", () => {
    const resumable = { stopped: true, paused: false, expired: false, resumable: true };
    expect(validatePromptEnqueueResumeState(null, resumable, false)).toEqual({
      ok: true,
      isResumableSend: true,
    });
  });

  it("treats a live (non-stopped) sandbox as a normal send", () => {
    const live = { stopped: false, paused: false, expired: false, resumable: false };
    expect(validatePromptEnqueueResumeState(null, live, false)).toEqual({
      ok: true,
      isResumableSend: false,
    });
  });
});

describe("ARC-1196 zombie-socket dispatch gate", () => {
  function setupActiveSession(storage: MemoryStorage) {
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
  }

  function enqueueRequest(body: Record<string, unknown> = { prompt: "Fix the bug" }) {
    return new Request("https://example.com/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const staleHeartbeat = { lastHeartbeatAt: Date.now() - 200_000, ageMs: 200_000, fresh: false };

  it("discards a stale transport and takes the cold-resume spawn path instead of sending", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    setupActiveSession(storage);
    host.getSandboxHeartbeatFreshness.mockResolvedValue(staleHeartbeat);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(enqueueRequest());

    expect(response.status).toBe(200);
    expect(host.discardStaleSandboxTransport).toHaveBeenCalledWith("session-1", "stale heartbeat at prompt dispatch");
    expect(sentCommands.filter((command) => command.type === "prompt")).toHaveLength(0);
    expect(host.startSpawnAttempt).toHaveBeenCalledWith("session-1", "spawnSandbox.resume.cold");
    const appendedTypes = vi
      .mocked(host.appendAndMirrorEvents)
      .mock.calls.flatMap(([, entries]) => (entries as Array<{ type: string }>).map((entry) => entry.type));
    expect(appendedTypes).toContain("session_resumed_cold");
    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "prompt_admit_decision",
        decision: "start_spawn",
        socketFresh: false,
        socketHeartbeatAgeMs: 200_000,
        sandboxStatus: "stopped",
        resumeStopped: true,
      }),
      "prompt_admit_decision",
    );
  });

  it("cold-resumes a review-loop enqueue against a stale socket instead of failing", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    setupActiveSession(storage);
    host.getSandboxHeartbeatFreshness.mockResolvedValue(staleHeartbeat);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(
      enqueueRequest({ prompt: "Address review feedback", reviewLoopEpochId: "epoch-1" }),
    );

    expect(response.status).toBe(200);
    expect(host.discardStaleSandboxTransport).toHaveBeenCalled();
    expect(sentCommands.filter((command) => command.type === "prompt")).toHaveLength(0);
    expect(host.startSpawnAttempt).toHaveBeenCalledWith("session-1", "spawnSandbox.resume.cold");
  });

  it("sends immediately over a fresh socket without discarding the transport", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    setupActiveSession(storage);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(enqueueRequest());

    expect(response.status).toBe(200);
    expect(host.discardStaleSandboxTransport).not.toHaveBeenCalled();
    expect(host.startSpawnAttempt).not.toHaveBeenCalled();
    expect(sentCommands.some((command) => command.type === "prompt")).toBe(true);
    expect(host.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "prompt_admit_decision", decision: "send_now", socketFresh: true }),
      "prompt_admit_decision",
    );
  });

  it("fails closed when no heartbeat was ever recorded for the open socket", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    setupActiveSession(storage);
    host.getSandboxHeartbeatFreshness.mockResolvedValue({ lastHeartbeatAt: null, ageMs: null, fresh: false });
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(enqueueRequest());

    expect(response.status).toBe(200);
    expect(host.discardStaleSandboxTransport).toHaveBeenCalled();
    expect(sentCommands.filter((command) => command.type === "prompt")).toHaveLength(0);
    expect(host.startSpawnAttempt).toHaveBeenCalledWith("session-1", "spawnSandbox.resume.cold");
  });

  it("leaves an actively processing prompt's transport alone when a second prompt queues", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    setupActiveSession(storage);
    await storage.put("prompts", [makePrompt({ promptId: "p-1", status: "processing" })]);
    await storage.put("activePromptId", "p-1");
    host.getSandboxHeartbeatFreshness.mockResolvedValue(staleHeartbeat);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handlePromptEnqueueRequest(enqueueRequest({ prompt: "Queued follow-up" }));

    expect(response.status).toBe(200);
    expect(host.discardStaleSandboxTransport).not.toHaveBeenCalled();
  });

  it("retries via the spawn path when the socket heartbeat is stale", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    setupActiveSession(storage);
    await storage.put("prompts", [makePrompt({ promptId: "p-1", status: "completed" })]);
    updateSessionFields(storage.sql, "session-1", { promptCounter: 1 });
    host.getSandboxHeartbeatFreshness.mockResolvedValue(staleHeartbeat);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handleRetryRequest();

    expect(response.status).toBe(202);
    expect(host.discardStaleSandboxTransport).toHaveBeenCalledWith(
      "session-1",
      "stale heartbeat at prompt retry dispatch",
    );
    expect(sentCommands.filter((command) => command.type === "prompt")).toHaveLength(0);
    expect(host.startSpawnAttempt).toHaveBeenCalledWith("session-1", "spawnSandbox.retry");
  });

  it("retries over the socket when the heartbeat is fresh", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    setupActiveSession(storage);
    await storage.put("prompts", [makePrompt({ promptId: "p-1", status: "completed" })]);
    updateSessionFields(storage.sql, "session-1", { promptCounter: 1 });
    const queue = createSessionPromptQueue(host);

    const response = await queue.handleRetryRequest();

    expect(response.status).toBe(202);
    expect(host.discardStaleSandboxTransport).not.toHaveBeenCalled();
    expect(sentCommands.some((command) => command.type === "prompt")).toBe(true);
  });
});

describe("ARC-1196 idle liveness watchdog survives prompt completion", () => {
  it("reschedules instead of deleting the alarm when a prompt completes with no queued next prompt", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    await storage.put("prompts", [makePrompt({ promptId: "p-1", status: "processing" })]);
    await storage.put("activePromptId", "p-1");
    const deleteAlarmSpy = vi.spyOn(storage, "deleteAlarm");
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: true });

    expect(host.rescheduleSessionAlarm).toHaveBeenCalled();
    expect(deleteAlarmSpy).not.toHaveBeenCalled();
  });

  it("dispatches the queued next prompt instead of touching the alarm candidates", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    await storage.put("prompts", [
      makePrompt({ promptId: "p-1", status: "processing" }),
      makePrompt({ promptId: "p-2", status: "queued", startedAt: null }),
    ]);
    await storage.put("activePromptId", "p-1");
    const deleteAlarmSpy = vi.spyOn(storage, "deleteAlarm");
    const queue = createSessionPromptQueue(host);

    await queue.completeActivePrompt("session-1", { success: true });

    expect(deleteAlarmSpy).not.toHaveBeenCalled();
    expect(host.rescheduleSessionAlarm).not.toHaveBeenCalled();
    expect(sentCommands.some((command) => command.type === "prompt" && command.messageId === "p-2")).toBe(true);
  });
});

describe("ARC-1196 admit-decision Datadog direct post", () => {
  it("direct-posts prompt_admit_decision metadata on enqueue, detached via waitUntil", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
    );
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    storage.sql.exec(
      "UPDATE sandbox_state SET runtime_provider = ?, runtime_backend = ? WHERE session_id = ?",
      "freestyle",
      "freestyle",
      "session-1",
    );
    const queue = createSessionPromptQueue(host);

    await queue.handlePromptEnqueueRequest(
      new Request("https://example.com/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Fix the bug" }),
      }),
    );

    expect(host.waitUntil).toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "test-dd-key" }),
      expect.objectContaining({
        event: "prompt_admit_decision",
        decision: "send_now",
        provider: "freestyle",
        socketFresh: true,
        sessionId: "session-1",
      }),
    );
    const payload = latestStructuredEventPayload("prompt_admit_decision");
    // Metadata only: the prompt text must never reach the exporter payload.
    expect(JSON.stringify(payload)).not.toContain("Fix the bug");
  });
});

describe("ARC-1583 prompt queue wait telemetry", () => {
  it("direct-posts prompt.queue_wait on an immediate live dispatch", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
      const storage = new MemoryStorage();
      const { host } = createHost(storage);
      storage.sql.exec(
        `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
         VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
      );
      storage.sql.exec("UPDATE session SET agent_runtime_backend = ? WHERE session_id = ?", "codex", "session-1");
      ensureSandboxState(storage.sql, "session-1", { status: "running" });
      const queue = createSessionPromptQueue(host);

      await queue.handlePromptEnqueueRequest(
        new Request("https://example.com/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Fix the bug" }),
        }),
      );

      const payload = latestStructuredEventPayload("prompt.queue_wait");
      expect(payload).toMatchObject({
        event: "prompt.queue_wait",
        sessionId: "session-1",
        dispatch_path: "live",
        agent_runtime_backend: "codex",
      });
      expect(payload?.queue_wait_ms).toBe(0);
      expect(JSON.stringify(payload)).not.toContain("Fix the bug");
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures queued wait before draining the next prompt over the live bridge", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-01T12:00:10.000Z"));
      const storage = new MemoryStorage();
      const { host, sentCommands } = createHost(storage);
      storage.sql.exec(
        `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
         VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
      );
      storage.sql.exec("UPDATE session SET agent_runtime_backend = ? WHERE session_id = ?", "opencode", "session-1");
      ensureSandboxState(storage.sql, "session-1", { status: "running" });
      await storage.put("prompts", [
        makePrompt({ promptId: "p-1", status: "processing" }),
        makePrompt({
          promptId: "p-2",
          prompt: "Run the follow-up",
          status: "queued",
          createdAt: "2026-04-01T12:00:00.000Z",
          startedAt: null,
          completedAt: null,
          updatedAt: "2026-04-01T12:00:00.000Z",
        }),
      ]);
      await storage.put("activePromptId", "p-1");
      const queue = createSessionPromptQueue(host);

      await queue.completeActivePrompt("session-1", { success: true });

      const payload = structuredEventPayloads("prompt.queue_wait").find((event) => event.promptId === "p-2");
      expect(payload).toMatchObject({
        event: "prompt.queue_wait",
        promptId: "p-2",
        dispatch_path: "live",
        agent_runtime_backend: "opencode",
      });
      expect(payload?.queue_wait_ms).toBe(10_000);
      expect(sentCommands.some((command) => command.type === "prompt" && command.messageId === "p-2")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits to emit prompt.queue_wait until a pending cold dispatch actually sends", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
      const storage = new MemoryStorage();
      const { host, sentCommands, setSandboxSocket } = createHost(storage);
      setSandboxSocket(null);
      storage.sql.exec(
        `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at)
         VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z')`,
      );
      storage.sql.exec("UPDATE session SET agent_runtime_backend = ? WHERE session_id = ?", "claude_code", "session-1");
      ensureSandboxState(storage.sql, "session-1", { status: "stopped" });
      const queue = createSessionPromptQueue(host);

      await queue.handlePromptEnqueueRequest(
        new Request("https://example.com/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Cold resume this" }),
        }),
      );

      expect(structuredEventPayloads("prompt.queue_wait")).toHaveLength(0);

      vi.setSystemTime(new Date("2026-04-01T12:00:30.000Z"));
      setSandboxSocket({ readyState: 1 } as WebSocket);

      await expect(queue.sendPendingPromptToSandbox("session-1")).resolves.toBe(true);

      const payload = latestStructuredEventPayload("prompt.queue_wait");
      expect(payload).toMatchObject({
        event: "prompt.queue_wait",
        dispatch_path: "cold",
        agent_runtime_backend: "claude_code",
      });
      expect(payload?.queue_wait_ms).toBe(30_000);
      expect(sentCommands.some((command) => command.type === "prompt" && command.messageId === "p-1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("failActivePromptOnDisconnect recovery", () => {
  function seedSession(storage: MemoryStorage, promptCounter: number, status = "active"): void {
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at, prompt_counter)
       VALUES ('session-1', 'user-1', ?, '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z', ?)`,
      status,
      promptCounter,
    );
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
  }

  function seedProcessingPrompt(
    storage: MemoryStorage,
    opts: { promptId: string; disconnectRetryCount?: number; reviewLoopEpochId?: string },
  ): void {
    storage.sql.exec(
      `INSERT INTO prompts (prompt_id, session_id, prompt_text, status, created_at, started_at, updated_at, disconnect_retry_count, review_loop_epoch_id)
       VALUES (?, 'session-1', 'Do the thing', 'processing', 1000, 1000, 1000, ?, ?)`,
      opts.promptId,
      opts.disconnectRetryCount ?? 0,
      opts.reviewLoopEpochId ?? null,
    );
  }

  function appendedEventsOfType(
    host: ReturnType<typeof createHost>["host"],
    type: string,
  ): Array<Record<string, unknown>> {
    const calls = vi.mocked(host.appendAndMirrorEvents).mock.calls as Array<
      [string, Array<{ type: string; data: Record<string, unknown> }>]
    >;
    return calls
      .flatMap(([, entries]) => entries)
      .filter((e) => e.type === type)
      .map((e) => e.data);
  }

  it("re-runs the dropped prompt on a fresh sandbox under cap (clone + prompt_retrying, no failure)", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    seedSession(storage, 1);
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 0 });
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(makeSession(), "p-1");

    const prompts = getPrompts(storage.sql, "session-1");
    const original = prompts.find((p) => p.promptId === "p-1");
    const clone = prompts.find((p) => p.promptId === "p-2");
    expect(original?.status).toBe("failed");
    expect(clone?.status).toBe("processing");
    expect(clone?.disconnectRetryCount).toBe(1);
    // Exactly one processing prompt (idx_prompts_one_processing holds).
    expect(prompts.filter((p) => p.status === "processing")).toHaveLength(1);
    // Fresh started_at so the prompt max-duration alarm restarts.
    expect(clone?.startedAt).not.toBe(original?.startedAt);

    const retrying = appendedEventsOfType(host, "prompt_retrying");
    expect(retrying).toHaveLength(1);
    expect(retrying[0]).toMatchObject({ promptId: "p-1", retryPromptId: "p-2", attempt: 1, cap: 2 });
    // Soft recovery: no hard prompt_failed event for the dropped run.
    expect(appendedEventsOfType(host, "prompt_failed")).toHaveLength(0);

    expect(host.startSpawnAttempt).toHaveBeenCalledWith("session-1", "spawnSandbox.sandboxDisconnect");
    expect(host.setPendingPromptDispatch).toHaveBeenLastCalledWith(true);
    expect(await storage.get("pending_prompt_dispatch")).toBe(true);

    // Direct-posted to Datadog so disconnect recovery is queryable.
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "prompt_disconnect_retry",
        sessionId: "session-1",
        promptId: "p-1",
        retryPromptId: "p-2",
        attempt: 1,
        cap: 2,
      }),
    );
  });

  it("honors a user Stop on a mid-stop disconnect: terminal abort, never a retry clone", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    seedSession(storage, 1);
    // Under cap and a live session: without the marker this would clone+retry
    // (see the first test in this block). The user Stop must override that.
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 0 });
    // handleStopRequest wrote this marker but left the prompt `processing` while
    // the sandbox acked the stop; then the VM died inside the stop window.
    await storage.put(PROMPT_STOPPED_BY_STORAGE_KEY, { "p-1": "user" });
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(makeSession(), "p-1");

    const prompts = getPrompts(storage.sql, "session-1");
    // No clone: the user-killed prompt is not resurrected on a fresh sandbox.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.status).toBe("failed");
    expect(prompts[0]?.error).toBe("Stopped by user");
    expect(host.startSpawnAttempt).not.toHaveBeenCalled();
    expect(appendedEventsOfType(host, "prompt_retrying")).toHaveLength(0);
    expect(appendedEventsOfType(host, "prompt_failed")).toMatchObject([{ promptId: "p-1", errorCode: "aborted" }]);
    expect(appendedEventsOfType(host, "session_error")).toMatchObject([{ promptId: "p-1", code: "aborted" }]);
    // The stop marker is consumed so it cannot leak onto a future prompt.
    expect(await storage.get(PROMPT_STOPPED_BY_STORAGE_KEY)).toBeUndefined();
  });

  it("fails terminally once the disconnect retry cap is reached", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    seedSession(storage, 1);
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 2 });
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(makeSession(), "p-1");

    const prompts = getPrompts(storage.sql, "session-1");
    expect(prompts.find((p) => p.promptId === "p-1")?.status).toBe("failed");
    // No clone is created at the cap.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.error).toBe("Sandbox kept disconnecting after 3 attempts");

    expect(appendedEventsOfType(host, "prompt_retrying")).toHaveLength(0);
    expect(appendedEventsOfType(host, "prompt_failed")).toHaveLength(1);
    expect(host.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "prompt_disconnect_retry_exhausted", attempts: 3, cap: 2 }),
      expect.any(String),
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "prompt_disconnect_retry_exhausted",
        sessionId: "session-1",
        promptId: "p-1",
        attempts: 3,
        cap: 2,
      }),
    );
  });

  it("hands off to an implementation prompt when a plan prompt exhausts disconnect retries (ARC-1424)", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    seedSession(storage, 1);
    // Plan turn (p-1) at the disconnect cap on a live session: the terminal
    // branch must fail open to a plan-less implementation prompt.
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 2 });
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(makeSession({ planMode: true }), "p-1");

    const prompts = getPrompts(storage.sql, "session-1");
    expect(prompts.find((p) => p.promptId === "p-1")?.status).toBe("failed");

    // The handoff enqueued an implementation prompt, and the existing queued-prompt
    // promotion picked it up and spawned it.
    const impl = prompts.find((p) => p.planContext?.planPromptId === "p-1");
    expect(impl?.promptId).toBe("p-2");
    expect(impl?.status).toBe("processing");
    // No plan was captured across the disconnects, so it fails open plan-less.
    expect(impl?.planContext).toMatchObject({
      planPromptId: "p-1",
      valid: false,
      missingReason: "plan_prompt_failed",
      artifactId: null,
    });
    expect(prompts.filter((p) => p.status === "processing")).toHaveLength(1);

    const enqueued = appendedEventsOfType(host, "prompt_enqueued");
    expect(enqueued).toMatchObject([{ promptId: "p-2", status: "queued" }]);
    expect(appendedEventsOfType(host, "prompt_processing")).toMatchObject([{ promptId: "p-2" }]);
    expect(host.startSpawnAttempt).toHaveBeenCalledWith("session-1", "spawnSandbox.sandboxDisconnect");
    // The plan prompt still fails, but the session is continuing to implementation,
    // so the hard session_error is suppressed (mirrors handleSpawnTimeout).
    expect(appendedEventsOfType(host, "prompt_failed")).toMatchObject([{ promptId: "p-1" }]);
    expect(appendedEventsOfType(host, "session_error")).toHaveLength(0);
  });

  it("parks when a gated plan prompt exhausts disconnect retries", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    seedSession(storage, 1);
    storage.sql.exec("UPDATE session SET plan_mode = 1, plan_approval_required = 1 WHERE session_id = 'session-1'");
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 2 });
    bulkUpdatePrompts(storage.sql, "session-1", [
      ...getPrompts(storage.sql, "session-1"),
      makePrompt({ promptId: "p-2", status: "queued", startedAt: null }),
    ]);
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(makeSession({ planMode: true, planApprovalRequired: true }), "p-1");

    expect(getPrompts(storage.sql, "session-1").map((prompt) => [prompt.promptId, prompt.status])).toEqual([
      ["p-1", "failed"],
      ["p-2", "queued"],
    ]);
    expect(getLatestSessionPlan(storage.sql, "session-1")).toMatchObject({
      status: "pending",
      valid: false,
      missingReason: "plan_prompt_failed",
    });
    expect(host.startSpawnAttempt).not.toHaveBeenCalled();
    expect(host.onPlanApprovalParked).toHaveBeenCalled();
  });

  it("parks when a gated plan prompt reaches the spawn-timeout cap", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    seedSession(storage, 1);
    storage.sql.exec("UPDATE session SET plan_mode = 1, plan_approval_required = 1 WHERE session_id = 'session-1'");
    seedProcessingPrompt(storage, { promptId: "p-1" });
    bulkUpdatePrompts(storage.sql, "session-1", [
      ...getPrompts(storage.sql, "session-1"),
      makePrompt({ promptId: "p-2", status: "queued", startedAt: null }),
    ]);
    storage.sql.exec("UPDATE sandbox_state SET spawn_retry_count = 2 WHERE session_id = 'session-1'");
    const queue = createSessionPromptQueue(host);
    const session = makeSession({ planMode: true, planApprovalRequired: true });
    const prompts = getPrompts(storage.sql, "session-1");

    await queue.handleSpawnTimeout("session-1", session, prompts, prompts[0], "Sandbox spawn timed out", "deadline");

    expect(getPrompts(storage.sql, "session-1").map((prompt) => [prompt.promptId, prompt.status])).toEqual([
      ["p-1", "failed"],
      ["p-2", "queued"],
    ]);
    expect(getLatestSessionPlan(storage.sql, "session-1")).toMatchObject({
      status: "pending",
      valid: false,
      missingReason: "plan_prompt_failed",
    });
    expect(host.onPlanApprovalParked).toHaveBeenCalled();
    expect(host.rescheduleSessionAlarm).toHaveBeenCalled();
  });

  it("does NOT hand off when a user-stopped plan prompt disconnects (honors the Stop)", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    seedSession(storage, 1);
    // Under cap: without the Stop this would clone+retry the plan turn. The user
    // Stop must take the terminal branch AND must not resurrect the killed turn
    // as an implementation prompt.
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 0 });
    await storage.put(PROMPT_STOPPED_BY_STORAGE_KEY, { "p-1": "user" });
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(makeSession({ planMode: true }), "p-1");

    const prompts = getPrompts(storage.sql, "session-1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.status).toBe("failed");
    expect(prompts[0]?.error).toBe("Stopped by user");
    // No plan→implement handoff on a user Stop.
    expect(prompts.filter((p) => p.planContext?.planPromptId === "p-1")).toHaveLength(0);
    expect(appendedEventsOfType(host, "prompt_enqueued")).toHaveLength(0);
    expect(host.startSpawnAttempt).not.toHaveBeenCalled();
    // Non-handoff terminal keeps the session_error.
    expect(appendedEventsOfType(host, "session_error")).toMatchObject([{ promptId: "p-1", code: "aborted" }]);
  });

  it("does NOT hand off when a plan prompt disconnects on an archived session", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    // Archived sessions are being torn down and never spawn fresh work.
    seedSession(storage, 1, "archived");
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 0 });
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(makeSession({ planMode: true }), "p-1");

    const prompts = getPrompts(storage.sql, "session-1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.status).toBe("failed");
    expect(prompts.filter((p) => p.planContext?.planPromptId === "p-1")).toHaveLength(0);
    expect(appendedEventsOfType(host, "prompt_enqueued")).toHaveLength(0);
    expect(host.startSpawnAttempt).not.toHaveBeenCalled();
  });

  it("direct-posts prompt_failed_sandbox_disconnect for an under-cap archived terminal", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    // Archived session never retries, so an under-cap disconnect terminalizes
    // as a plain sandbox-disconnect failure (no attempts/cap fields).
    seedSession(storage, 1, "archived");
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 0 });
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(makeSession(), "p-1");

    expect(getPrompts(storage.sql, "session-1").find((p) => p.promptId === "p-1")?.status).toBe("failed");
    // No clone: archived sessions must not spawn fresh work.
    expect(getPrompts(storage.sql, "session-1")).toHaveLength(1);

    const payload = mockPostStructuredEventToDd.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: "prompt_failed_sandbox_disconnect",
      sessionId: "session-1",
      promptId: "p-1",
    });
    expect(payload).not.toHaveProperty("attempts");
    expect(payload).not.toHaveProperty("cap");
  });

  it("A3: finalizes verification-stopped after disconnect exhaustion (no rerun under non-blocking QA)", async () => {
    const storage = new MemoryStorage();
    const childRow = {
      session_id: "session-1",
      business_id: null,
      parent_session_id: "parent-1",
      parent_prompt_id: "parent-prompt-1",
      spawned_by_user_id: 1,
      spawn_depth: 1,
      title: null,
      status: "active",
      rich_status: "running",
      publish_status: "not_started",
      publish_error: null,
      created_at: "2026-04-01T12:00:00.000Z",
      closed_at: null,
    };
    const { host } = createHost(storage, {
      DB: createChildLookupDb(childRow),
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "test-key",
    });
    seedSession(storage, 1);
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      targetPrUrl: "https://github.com/acme/repo/pull/42",
      repoOwner: "acme",
      repoName: "repo",
      installationId: 123,
    });
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 2 });
    mockGetSessionState.mockResolvedValue(
      makeSession({
        sessionId: "parent-1",
        agentRole: "implementation",
        repoOwner: "acme",
        repoName: "repo",
        installationId: 123,
        reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
        reviewListeningHeadSha: "head-sha-1",
      }),
    );
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(
      makeSession({
        agentRole: "verification",
        targetPrUrl: "https://github.com/acme/repo/pull/42",
      }),
      "p-1",
    );

    // A3: disconnect exhaustion no longer re-spawns the verifier — it finalizes verification-stopped.
    // #6939: the restored managed QA comment is published (informational; it does not gate the state).
    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "verification-stopped" }),
    );
    expect(mockPublishManagedVerificationComment).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({ prUrl: "https://github.com/acme/repo/pull/42" }),
        verifierResult: expect.objectContaining({
          verdict: "INCONCLUSIVE",
          summary: expect.stringContaining("stopped"),
        }),
      }),
    );
  });

  it("finalizes verification-stopped for a manual verifier stop", async () => {
    const storage = new MemoryStorage();
    const childRow = {
      session_id: "session-1",
      business_id: null,
      parent_session_id: "parent-1",
      parent_prompt_id: "parent-prompt-1",
      spawned_by_user_id: 1,
      spawn_depth: 1,
      title: null,
      status: "active",
      rich_status: "running",
      publish_status: "not_started",
      publish_error: null,
      created_at: "2026-04-01T12:00:00.000Z",
      closed_at: null,
    };
    const { host } = createHost(storage, {
      DB: createChildLookupDb(childRow),
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "test-key",
    });
    seedSession(storage, 1);
    updateSessionFields(storage.sql as unknown as SqlStorage, "session-1", {
      agentRole: "verification",
      targetPrUrl: "https://github.com/acme/repo/pull/42",
      repoOwner: "acme",
      repoName: "repo",
      installationId: 123,
      lastCommitSha: "head-sha-1",
    });
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 0 });
    await storage.put(PROMPT_STOPPED_BY_STORAGE_KEY, { "p-1": "user" });
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(
      makeSession({
        agentRole: "verification",
        targetPrUrl: "https://github.com/acme/repo/pull/42",
      }),
      "p-1",
    );

    expect(mockSyncVerificationStateForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prUrl: "https://github.com/acme/repo/pull/42", state: "verification-stopped" }),
    );
  });

  it("counts a reconnect-then-redie toward the cap (counter rides the retry chain)", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    seedSession(storage, 1);
    // First retry already consumed: the dropped prompt carries count 1.
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 1 });
    const queue = createSessionPromptQueue(host);

    // Second disconnect -> clone p-2 with count 2 (still under cap).
    await queue.failActivePromptOnDisconnect(makeSession(), "p-1");
    let prompts = getPrompts(storage.sql, "session-1");
    expect(prompts.find((p) => p.promptId === "p-2")?.disconnectRetryCount).toBe(2);
    expect(appendedEventsOfType(host, "prompt_retrying").at(-1)).toMatchObject({ attempt: 2 });

    // Third disconnect (of the clone, count 2) -> cap reached, terminal fail.
    await queue.failActivePromptOnDisconnect(makeSession(), "p-2");
    prompts = getPrompts(storage.sql, "session-1");
    expect(prompts.find((p) => p.promptId === "p-2")?.status).toBe("failed");
    expect(prompts.some((p) => p.promptId === "p-3")).toBe(false);
    expect(appendedEventsOfType(host, "prompt_failed")).toHaveLength(1);
  });

  it("re-points the review-loop epoch from the dropped prompt to the clone", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    const repoint = vi.fn(async () => {});
    (host as { repointReviewLoopEpochPrompt?: typeof repoint }).repointReviewLoopEpochPrompt = repoint;
    seedSession(storage, 1);
    seedProcessingPrompt(storage, { promptId: "p-1", reviewLoopEpochId: "epoch-1" });
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(makeSession(), "p-1");

    expect(repoint).toHaveBeenCalledWith("session-1", "epoch-1", "p-1", "p-2");
  });

  it("ignores a prompt that is no longer processing", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    seedSession(storage, 1);
    storage.sql.exec(
      `INSERT INTO prompts (prompt_id, session_id, prompt_text, status, created_at, updated_at)
       VALUES ('p-1', 'session-1', 'Do the thing', 'completed', 1000, 1000)`,
    );
    const queue = createSessionPromptQueue(host);

    await queue.failActivePromptOnDisconnect(makeSession(), "p-1");

    expect(host.appendAndMirrorEvents).not.toHaveBeenCalled();
    expect(host.startSpawnAttempt).not.toHaveBeenCalled();
  });

  it("round-trips disconnect_retry_count through serialization and bulk upsert", () => {
    const storage = new MemoryStorage();
    seedSession(storage, 1);
    seedProcessingPrompt(storage, { promptId: "p-1", disconnectRetryCount: 0 });

    const loaded = getPrompts(storage.sql, "session-1");
    const prompt = loaded.find((p) => p.promptId === "p-1")!;
    prompt.disconnectRetryCount = 2;
    // bulkUpdatePrompts uses serializePromptRow + ON CONFLICT; the counter must survive.
    bulkUpdatePrompts(storage.sql, "session-1", loaded);

    const reloaded = getPrompts(storage.sql, "session-1");
    expect(reloaded.find((p) => p.promptId === "p-1")?.disconnectRetryCount).toBe(2);
  });
});

describe("durable answer redelivery (9.3)", () => {
  function seed(storage: MemoryStorage, opts: { promptStatus?: string; hasPendingQuestion?: boolean } = {}): void {
    storage.sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at, prompt_counter)
       VALUES ('session-1', 'user-1', 'active', '2026-04-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z', 1)`,
    );
    ensureSandboxState(storage.sql, "session-1", { status: "running" });
    storage.sql.exec(
      `INSERT INTO prompts (prompt_id, session_id, prompt_text, status, created_at, started_at, updated_at, has_pending_question)
       VALUES ('p-1', 'session-1', 'Do the thing', ?, 1000, 1000, 1000, ?)`,
      opts.promptStatus ?? "processing",
      opts.hasPendingQuestion === false ? 0 : 1,
    );
  }

  it("handleRespondRequest dispatches the answer and persists it for redelivery", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    seed(storage);
    const queue = createSessionPromptQueue(host);

    const res = await queue.handleRespondRequest(
      new Request("https://internal/session/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes, proceed", questionId: "q-1" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(sentCommands).toContainEqual(
      expect.objectContaining({ type: "respond", answer: "yes, proceed", requestId: "q-1" }),
    );
    const pending = (await storage.get(PENDING_ANSWER_STORAGE_KEY)) as PendingAnswerRecord | undefined;
    expect(pending).toMatchObject({ promptId: "p-1", questionId: "q-1", answer: "yes, proceed" });
  });

  it("redelivers the persisted answer while the owning prompt is still processing", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    // hasPendingQuestion=false models the post-answer state: the question was
    // cleared, so without redelivery the bridge would be stranded awaiting it.
    seed(storage, { hasPendingQuestion: false });
    await storage.put(PENDING_ANSWER_STORAGE_KEY, {
      promptId: "p-1",
      questionId: "q-1",
      answer: "yes, proceed",
    } satisfies PendingAnswerRecord);
    const queue = createSessionPromptQueue(host);

    await queue.sendPendingAnswerToSandbox("session-1");

    expect(sentCommands).toContainEqual(
      expect.objectContaining({ type: "respond", answer: "yes, proceed", requestId: "q-1" }),
    );
    // Kept until the owning prompt is terminal; the bridge dedupes a re-send.
    expect(await storage.get(PENDING_ANSWER_STORAGE_KEY)).toBeTruthy();
  });

  it("drops a stale answer instead of redelivering once the owning prompt is terminal", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    seed(storage, { promptStatus: "completed", hasPendingQuestion: false });
    await storage.put(PENDING_ANSWER_STORAGE_KEY, {
      promptId: "p-1",
      questionId: "q-1",
      answer: "stale",
    } satisfies PendingAnswerRecord);
    const queue = createSessionPromptQueue(host);

    await queue.sendPendingAnswerToSandbox("session-1");

    expect(sentCommands).toHaveLength(0);
    expect(await storage.get(PENDING_ANSWER_STORAGE_KEY)).toBeUndefined();
  });

  it("no-ops when there is no persisted answer", async () => {
    const storage = new MemoryStorage();
    const { host, sentCommands } = createHost(storage);
    seed(storage);
    const queue = createSessionPromptQueue(host);

    await queue.sendPendingAnswerToSandbox("session-1");

    expect(sentCommands).toHaveLength(0);
  });
});

describe("handleRetryRequest idempotency (PR 1.4)", () => {
  async function seedRetryableSession(storage: MemoryStorage): Promise<void> {
    await storage.put("session", makeSession());
    ensureSandboxState(storage.sql as unknown as SqlStorage, "session-1");
    storage.sql.exec(
      "UPDATE sandbox_state SET status = 'stopped', stop_reason = 'reaped' WHERE session_id = ?",
      "session-1",
    );
    bulkUpdatePrompts(storage.sql as unknown as SqlStorage, "session-1", [
      makePrompt({ promptId: "p-1", status: "failed", completedAt: "2026-04-01T12:05:00.000Z", error: "boom" }),
    ]);
    // Keep the clone-id counter ahead of the seeded prompt ids, as the live
    // enqueue path would have.
    storage.sql.exec("UPDATE session SET prompt_counter = 1 WHERE session_id = ?", "session-1");
  }

  it("clones exactly one prompt; a double retry gets a 409 instead of a second clone", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    await seedRetryableSession(storage);
    const queue = createSessionPromptQueue(host);

    const first = await queue.handleRetryRequest();
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { ok: boolean; prompt: { promptId: string; status: string } };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.prompt.status).toBe("processing");

    // The clone is now the active prompt — a replayed/raced retry must not
    // mint a second clone.
    const second = await queue.handleRetryRequest();
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toEqual({
      ok: false,
      error: "session_not_retryable",
      reason: "retry_in_progress",
    });

    const prompts = getPrompts(storage.sql as unknown as SqlStorage, "session-1");
    expect(prompts).toHaveLength(2); // original + exactly one clone
    expect(prompts.filter((prompt) => prompt.status === "processing")).toHaveLength(1);
  });

  it("also refuses retry while a prompt is queued (no clone behind the queue)", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    await seedRetryableSession(storage);
    bulkUpdatePrompts(storage.sql as unknown as SqlStorage, "session-1", [
      makePrompt({ promptId: "p-1", status: "failed", completedAt: "2026-04-01T12:05:00.000Z", error: "boom" }),
      makePrompt({ promptId: "p-2", status: "queued", startedAt: null }),
    ]);
    const queue = createSessionPromptQueue(host);

    const response = await queue.handleRetryRequest();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "session_not_retryable",
      reason: "retry_in_progress",
    });
    expect(getPrompts(storage.sql as unknown as SqlStorage, "session-1")).toHaveLength(2);
  });

  it("still 400s when there is no terminal prompt to clone", async () => {
    const storage = new MemoryStorage();
    const { host } = createHost(storage);
    await storage.put("session", makeSession());
    ensureSandboxState(storage.sql as unknown as SqlStorage, "session-1");
    storage.sql.exec(
      "UPDATE sandbox_state SET status = 'stopped', stop_reason = 'reaped' WHERE session_id = ?",
      "session-1",
    );
    const queue = createSessionPromptQueue(host);

    const response = await queue.handleRetryRequest();
    expect(response.status).toBe(400);
  });
});
