import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockSessionContinuationError extends Error {
    readonly status: number;
    readonly publicMessage: string;
    readonly reasonCode: string;

    constructor(status: number, publicMessage: string, reasonCode: string) {
      super(publicMessage);
      this.status = status;
      this.publicMessage = publicMessage;
      this.reasonCode = reasonCode;
    }
  }

  return {
    MockSessionContinuationError,
    getTrackingSessionIdForPrUrl: vi.fn(),
    listSessionIdsByWebhookRef: vi.fn(),
    getSessionIndexAgentRoleBusinessRows: vi.fn(),
    getActorRepoPermissionLevel: vi.fn(),
    actorCanWriteToRepo: vi.fn(),
    claimMentionBootstrap: vi.fn(),
    releaseMentionBootstrap: vi.fn(),
    admitSessionCreate: vi.fn(),
    resolveSessionContinuation: vi.fn(),
    createSessionState: vi.fn(),
    persistInitialSessionProjection: vi.fn(),
    insertGenesisRecord: vi.fn(),
    applyEvent: vi.fn(),
    liveFsmSinks: vi.fn(),
    emitMentionBootstrapOutcomeMetric: vi.fn().mockResolvedValue(undefined),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
  }),
}));

vi.mock("../../apps/control-plane-worker/src/session/pr-coordination-db", () => ({
  getTrackingSessionIdForPrUrl: mocks.getTrackingSessionIdForPrUrl,
}));

vi.mock("../../apps/control-plane-worker/src/session/db", () => ({
  getSessionIndexAgentRoleBusinessRows: mocks.getSessionIndexAgentRoleBusinessRows,
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  listSessionIdsByWebhookRef: mocks.listSessionIdsByWebhookRef,
}));

vi.mock("../../apps/control-plane-worker/src/github/repo-permission", () => ({
  getActorRepoPermissionLevel: mocks.getActorRepoPermissionLevel,
  actorCanWriteToRepo: mocks.actorCanWriteToRepo,
}));

vi.mock("../../apps/control-plane-worker/src/session/mention-bootstrap-claims-db", () => ({
  claimMentionBootstrap: mocks.claimMentionBootstrap,
  releaseMentionBootstrap: mocks.releaseMentionBootstrap,
}));

vi.mock("../../apps/control-plane-worker/src/services/session-admission", () => ({
  admitSessionCreate: mocks.admitSessionCreate,
}));

vi.mock("../../apps/control-plane-worker/src/services/session-continuation", () => ({
  SessionContinuationError: mocks.MockSessionContinuationError,
  resolveSessionContinuation: mocks.resolveSessionContinuation,
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  createSessionState: mocks.createSessionState,
}));

vi.mock("../../apps/control-plane-worker/src/services/session-create", () => ({
  persistInitialSessionProjection: mocks.persistInitialSessionProjection,
}));

vi.mock("../../apps/control-plane-worker/src/session/fsm/apply-event", () => ({
  applyEvent: mocks.applyEvent,
}));

vi.mock("../../apps/control-plane-worker/src/session/fsm/genesis", () => ({
  insertGenesisRecord: mocks.insertGenesisRecord,
}));

vi.mock("../../apps/control-plane-worker/src/session/fsm/live-side-effects", () => ({
  liveFsmSinks: mocks.liveFsmSinks,
}));

vi.mock("../../apps/control-plane-worker/src/observability/mention-bootstrap-metrics", () => ({
  emitMentionBootstrapOutcomeMetric: mocks.emitMentionBootstrapOutcomeMetric,
}));

import { SessionEntrypoint } from "../../apps/control-plane-worker/src/enums/session-entrypoint";
import { bootstrapMentionSession } from "../../apps/control-plane-worker/src/services/github-mention-bootstrap";
import type { Env } from "../../apps/control-plane-worker/src/types";

const PR_URL = "https://github.com/trycycloid/cycloid/pull/1515";
const BUSINESS_ID = "business-actor";
const SESSION_ID = "existing-session";
const HEAD_SHA = "abc123";
const DB = {} as D1Database;
const env = {
  DB,
  SESSION_RESUME_RATE_LIMITER: {},
} as Env;
const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
const args = {
  actorUserId: "42",
  actorLogin: "maya",
  actorBusinessId: BUSINESS_ID,
  installationId: 99,
  repoOwner: "trycycloid",
  repoName: "cycloid",
  prUrl: PR_URL,
  directiveText: "fix the failing test",
  waitUntil,
};

const continuation = {
  repoContext: {
    repoOwner: "trycycloid",
    repoName: "cycloid",
    baseBranch: "main",
    startBranch: "feature/adopt-me",
  },
  targetPrUrl: PR_URL,
  prUrl: PR_URL,
  prNumber: 1515,
  adoptedPrMetadata: {
    prUrl: PR_URL,
    prNumber: 1515,
    prDraft: false,
    publishedBranch: "feature/adopt-me",
    headSha: HEAD_SHA,
  },
};

function sameBusinessRow(sessionId: string) {
  return { sessionId, agentRole: "implementation", businessId: BUSINESS_ID };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTrackingSessionIdForPrUrl.mockResolvedValue(null);
  mocks.listSessionIdsByWebhookRef.mockResolvedValue([]);
  mocks.getSessionIndexAgentRoleBusinessRows.mockResolvedValue([]);
  mocks.getActorRepoPermissionLevel.mockResolvedValue("write");
  mocks.actorCanWriteToRepo.mockImplementation(
    (level) => level === "admin" || level === "maintain" || level === "write",
  );
  mocks.claimMentionBootstrap.mockResolvedValue({ won: true });
  mocks.releaseMentionBootstrap.mockResolvedValue(undefined);
  mocks.admitSessionCreate.mockResolvedValue({ ok: true });
  mocks.resolveSessionContinuation.mockResolvedValue(continuation);
  mocks.createSessionState.mockResolvedValue({
    session: { sessionId: "created-session", ownerUserId: args.actorUserId },
    replay: { cursor: 0 },
  });
  mocks.persistInitialSessionProjection.mockResolvedValue(undefined);
  mocks.insertGenesisRecord.mockResolvedValue("inserted");
  mocks.applyEvent.mockResolvedValue({ outcome: "handled", from: "CREATED", to: "REVIEW", version: 1 });
  mocks.liveFsmSinks.mockReturnValue({
    sideEffects: { dispatch: vi.fn() },
    worklist: { commit: vi.fn() },
    waitUntil,
  });
});

describe("bootstrapMentionSession", () => {
  it("hands off when an eligible implementation session already exists", async () => {
    mocks.getTrackingSessionIdForPrUrl.mockResolvedValue(SESSION_ID);
    mocks.getSessionIndexAgentRoleBusinessRows.mockResolvedValue([sameBusinessRow(SESSION_ID)]);

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({
      kind: "handed_off",
      sessionId: SESSION_ID,
    });
    expect(mocks.getActorRepoPermissionLevel).not.toHaveBeenCalled();
    expect(mocks.claimMentionBootstrap).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "handed_off");
  });

  it("rejects when another business already owns the PR", async () => {
    mocks.getTrackingSessionIdForPrUrl.mockResolvedValue(SESSION_ID);
    mocks.getSessionIndexAgentRoleBusinessRows.mockResolvedValue([
      { sessionId: SESSION_ID, agentRole: "implementation", businessId: "business-other" },
    ]);

    await expect(bootstrapMentionSession(env, args)).resolves.toMatchObject({
      kind: "rejected",
      reason: "other_business",
    });
    expect(mocks.getActorRepoPermissionLevel).not.toHaveBeenCalled();
    expect(mocks.claimMentionBootstrap).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "other_business");
  });

  it("skips an ambiguous same-business binding", async () => {
    mocks.listSessionIdsByWebhookRef.mockResolvedValue(["session-1", "session-2"]);
    mocks.getSessionIndexAgentRoleBusinessRows.mockResolvedValue([
      sameBusinessRow("session-1"),
      sameBusinessRow("session-2"),
    ]);

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({ kind: "skip", reason: "ambiguous" });
    expect(mocks.getActorRepoPermissionLevel).not.toHaveBeenCalled();
    expect(mocks.claimMentionBootstrap).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "skip_ambiguous");
  });

  it("retries an indeterminate write permission without claiming or rejecting", async () => {
    mocks.getActorRepoPermissionLevel.mockResolvedValue(null);
    mocks.actorCanWriteToRepo.mockReturnValue(false);

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({
      kind: "retry",
      reason: "permission_indeterminate",
    });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "github_mention_bootstrap_permission_indeterminate",
        outcome: "retry",
        reason: "permission_indeterminate",
      }),
      expect.any(String),
    );
    expect(mocks.actorCanWriteToRepo).not.toHaveBeenCalled();
    expect(mocks.claimMentionBootstrap).not.toHaveBeenCalled();
    expect(mocks.releaseMentionBootstrap).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "retry_permission_indeterminate");
  });

  it("still rejects a definitive non-write permission", async () => {
    mocks.getActorRepoPermissionLevel.mockResolvedValue("read");
    mocks.actorCanWriteToRepo.mockReturnValue(false);

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({
      kind: "rejected",
      reason: "no_write_permission",
      publicMessage: "You need write access to this repository for Cycloid to update the pull request.",
    });
    expect(mocks.claimMentionBootstrap).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "no_write_permission");
  });

  it("emits an outcome even when waitUntil is absent", async () => {
    mocks.getTrackingSessionIdForPrUrl.mockResolvedValue(SESSION_ID);
    mocks.getSessionIndexAgentRoleBusinessRows.mockResolvedValue([sameBusinessRow(SESSION_ID)]);

    await expect(bootstrapMentionSession(env, { ...args, waitUntil: undefined })).resolves.toEqual({
      kind: "handed_off",
      sessionId: SESSION_ID,
    });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "handed_off");
  });

  it("hands off when a claim loser observes the winner's session", async () => {
    mocks.claimMentionBootstrap.mockResolvedValue({ won: false });
    mocks.getTrackingSessionIdForPrUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(SESSION_ID);
    mocks.getSessionIndexAgentRoleBusinessRows.mockResolvedValue([sameBusinessRow(SESSION_ID)]);

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({
      kind: "handed_off",
      sessionId: SESSION_ID,
    });
    expect(mocks.admitSessionCreate).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "handed_off");
  });

  it("retries when a lost claim still has no durable owner", async () => {
    mocks.claimMentionBootstrap.mockResolvedValue({ won: false });

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({
      kind: "retry",
      reason: "claim_contended",
    });
    expect(mocks.admitSessionCreate).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "retry_claim_contended");
  });

  it("hands off when a claim winner observes a newly bound session on re-check", async () => {
    mocks.getTrackingSessionIdForPrUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(SESSION_ID);
    mocks.getSessionIndexAgentRoleBusinessRows.mockResolvedValue([sameBusinessRow(SESSION_ID)]);

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({
      kind: "handed_off",
      sessionId: SESSION_ID,
    });
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.admitSessionCreate).not.toHaveBeenCalled();
    expect(mocks.createSessionState).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "handed_off");
  });

  it("retries the release when the first attempt fails", async () => {
    const releaseError = new Error("release failed");
    mocks.getTrackingSessionIdForPrUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(SESSION_ID);
    mocks.getSessionIndexAgentRoleBusinessRows.mockResolvedValue([sameBusinessRow(SESSION_ID)]);
    mocks.releaseMentionBootstrap.mockRejectedValueOnce(releaseError).mockResolvedValueOnce(undefined);

    await expect(bootstrapMentionSession(env, args)).rejects.toBe(releaseError);
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledTimes(2);
    expect(mocks.admitSessionCreate).not.toHaveBeenCalled();
    expect(mocks.createSessionState).not.toHaveBeenCalled();
  });

  it("rejects and releases the claim when a winner observes another business on re-check", async () => {
    mocks.getTrackingSessionIdForPrUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(SESSION_ID);
    mocks.getSessionIndexAgentRoleBusinessRows.mockResolvedValue([
      { sessionId: SESSION_ID, agentRole: "implementation", businessId: "business-other" },
    ]);

    await expect(bootstrapMentionSession(env, args)).resolves.toMatchObject({
      kind: "rejected",
      reason: "other_business",
    });
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.admitSessionCreate).not.toHaveBeenCalled();
    expect(mocks.createSessionState).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "other_business");
  });

  it("skips and releases the claim when a winner observes an ambiguous binding on re-check", async () => {
    mocks.listSessionIdsByWebhookRef.mockResolvedValueOnce([]).mockResolvedValueOnce(["session-1", "session-2"]);
    mocks.getSessionIndexAgentRoleBusinessRows.mockResolvedValue([
      sameBusinessRow("session-1"),
      sameBusinessRow("session-2"),
    ]);

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({ kind: "skip", reason: "ambiguous" });
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.admitSessionCreate).not.toHaveBeenCalled();
    expect(mocks.createSessionState).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "skip_ambiguous");
  });

  it("releases the claim when admission rejects the create", async () => {
    mocks.admitSessionCreate.mockResolvedValue({
      ok: false,
      status: 429,
      code: "active_session_limit_exceeded",
      message: "Active session limit reached.",
    });

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({
      kind: "rejected",
      reason: "admission_rejected",
      publicMessage: "Active session limit reached.",
    });
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledWith(DB, {
      businessId: BUSINESS_ID,
      prUrl: PR_URL,
    });
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSessionContinuation).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "admission_rejected");
  });

  it.each([
    ["fork_pr", "fork"],
    ["closed_pr", "closed"],
    ["unsafe_head_ref", "unsafe_head_ref"],
  ] as const)("releases the claim and rejects continuation reason %s", async (reasonCode, expectedReason) => {
    mocks.resolveSessionContinuation.mockRejectedValue(
      new mocks.MockSessionContinuationError(400, `Rejected: ${reasonCode}`, reasonCode),
    );

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({
      kind: "rejected",
      reason: expectedReason,
      publicMessage: `Rejected: ${reasonCode}`,
    });
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.createSessionState).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, expectedReason);
  });

  it.each([
    new mocks.MockSessionContinuationError(503, "GitHub unavailable", "github_fetch_failed"),
    new Error("unexpected continuation failure"),
  ])("releases the claim and retries a transient continuation failure", async (error) => {
    mocks.resolveSessionContinuation.mockRejectedValue(error);

    await expect(bootstrapMentionSession(env, args)).resolves.toEqual({
      kind: "retry",
      reason: "github_fetch_failed",
    });
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.createSessionState).not.toHaveBeenCalled();
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "retry_github_fetch_failed");
  });

  it("releases the claim and rethrows when session creation fails", async () => {
    const error = new Error("session creation failed");
    mocks.createSessionState.mockRejectedValue(error);

    await expect(bootstrapMentionSession(env, args)).rejects.toBe(error);
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.persistInitialSessionProjection).not.toHaveBeenCalled();
    expect(mocks.insertGenesisRecord).not.toHaveBeenCalled();
    expect(mocks.applyEvent).not.toHaveBeenCalled();
  });

  it("ensures genesis, releases the claim, and rethrows when FSM adoption is unhandled", async () => {
    mocks.applyEvent.mockResolvedValue({ outcome: "no_record" });

    await expect(bootstrapMentionSession(env, args)).rejects.toThrow(
      /GitHub mention bootstrap FSM adoption failed.*no_record/,
    );
    expect(mocks.insertGenesisRecord).toHaveBeenCalledWith({ db: DB, now: Date.now }, expect.any(String));
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledTimes(1);

    const genesisOrder = mocks.insertGenesisRecord.mock.invocationCallOrder[0];
    const applyOrder = mocks.applyEvent.mock.invocationCallOrder[0];
    expect(genesisOrder).toBeLessThan(applyOrder);
  });

  it("creates, binds, FSM-adopts, then releases the bootstrap claim", async () => {
    const result = await bootstrapMentionSession(env, args);
    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error(`Expected created, received ${result.kind}`);

    expect(mocks.resolveSessionContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: result.sessionId,
        prompt: args.directiveText,
        continuePrUrl: PR_URL,
        continueMode: "update-pr",
        allowPromptInference: false,
        repoContext: { repoOwner: args.repoOwner, repoName: args.repoName },
        installationId: args.installationId,
      }),
    );
    expect(mocks.createSessionState).toHaveBeenCalledWith(env, result.sessionId, args.actorUserId, {
      entrypoint: SessionEntrypoint.GITHUB,
      sessionKind: "repo",
      repoContext: continuation.repoContext,
      prUrl: PR_URL,
      prNumber: 1515,
      installationId: args.installationId,
      autoVerify: false,
      adoptedExternalPr: true,
      businessId: BUSINESS_ID,
      waitUntil,
    });
    expect(mocks.createSessionState.mock.calls[0]?.[3]).not.toHaveProperty("prompt");
    expect(mocks.persistInitialSessionProjection).toHaveBeenCalledWith(env, {
      session: { sessionId: "created-session", ownerUserId: args.actorUserId },
      replay: { cursor: 0 },
      sessionKind: "repo",
      projectionSource: "webhooks.github.mention_bootstrap",
      projectionUserId: args.actorUserId,
      webhookRef: { source: "github_pr_url", externalRef: PR_URL },
      adoptedPrMetadata: continuation.adoptedPrMetadata,
    });
    expect(mocks.insertGenesisRecord).toHaveBeenCalledWith({ db: DB, now: Date.now }, result.sessionId);
    expect(mocks.applyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        db: DB,
        businessId: BUSINESS_ID,
        resolver: expect.any(Object),
      }),
      {
        sessionId: result.sessionId,
        event: { type: "publish.pr_opened", prHead: HEAD_SHA },
        metadata: { type: "publish.pr_opened" },
        actor: "transport",
      },
    );
    const resolver = mocks.applyEvent.mock.calls[0]?.[0].resolver;
    expect(resolver.guards({ verificationChildId: null }, { type: "publish.pr_opened", prHead: HEAD_SHA })).toEqual(
      expect.objectContaining({ prUrl: PR_URL }),
    );
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledWith(DB, {
      businessId: BUSINESS_ID,
      prUrl: PR_URL,
    });
    expect(mocks.releaseMentionBootstrap).toHaveBeenCalledTimes(1);

    const createOrder = mocks.createSessionState.mock.invocationCallOrder[0];
    const persistOrder = mocks.persistInitialSessionProjection.mock.invocationCallOrder[0];
    const genesisOrder = mocks.insertGenesisRecord.mock.invocationCallOrder[0];
    const applyOrder = mocks.applyEvent.mock.invocationCallOrder[0];
    const releaseOrder = mocks.releaseMentionBootstrap.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(persistOrder);
    expect(persistOrder).toBeLessThan(genesisOrder);
    expect(genesisOrder).toBeLessThan(applyOrder);
    expect(applyOrder).toBeLessThan(releaseOrder);
    expect(mocks.emitMentionBootstrapOutcomeMetric).toHaveBeenCalledWith(env, "created");
  });
});
