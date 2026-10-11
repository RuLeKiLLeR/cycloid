import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  associate: vi.fn(),
  complete: vi.fn(),
  release: vi.fn(),
  admission: vi.fn(),
  create: vi.fn(),
  persist: vi.fn(),
  enqueue: vi.fn(),
  close: vi.fn(),
  canResolveProviderKey: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../../../apps/control-plane-worker/src/session/pr-review-claims-db", () => ({
  claimPrReviewTrigger: mocks.claim,
  associatePrReviewTriggerSession: mocks.associate,
  completePrReviewTrigger: mocks.complete,
  releasePrReviewTrigger: mocks.release,
}));
vi.mock("../../../apps/control-plane-worker/src/services/session-admission", () => ({
  admitSessionCreate: mocks.admission,
}));
vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  createSessionState: mocks.create,
  enqueueSessionPrompt: mocks.enqueue,
  closeSessionState: mocks.close,
}));
vi.mock("../../../apps/control-plane-worker/src/services/session-create", () => ({
  persistInitialSessionProjection: mocks.persist,
}));
vi.mock("../../../apps/control-plane-worker/src/integrations/runtime", () => ({
  canResolveProviderKeyForSpawn: mocks.canResolveProviderKey,
}));
vi.mock("../../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({ info: mocks.logInfo, warn: vi.fn(), error: vi.fn() }),
}));

import { spawnPrReviewTrigger } from "../../../apps/control-plane-worker/src/services/pr-review-trigger-spawn";

const input = {
  env: { DB: {}, SESSION_RESUME_RATE_LIMITER: {} } as never,
  ownerUserId: "42",
  businessId: "295d2abc-d10b-4662-b84d-7bfa66242882",
  prUrl: "https://github.com/acme/repo/pull/123",
  prNumber: 123,
  repoOwner: "acme",
  repoName: "repo",
  installationId: 1234,
  claimToken: "attempt-1",
  triggerCommentId: 77,
  triggerSource: "webhook" as const,
  authorization: { mode: "webhook_actor" as const, actorLogin: "alice" },
  focus: null,
};

describe("PR review trigger spawn service", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.create.mockImplementation(async (_env: unknown, sessionId: string) => ({
      session: { sessionId },
      replay: {},
    }));
    mocks.canResolveProviderKey.mockResolvedValue(false);
  });

  it("projects, associates, enqueues, and completes the claim", async () => {
    mocks.claim.mockResolvedValue({ won: true });
    mocks.admission.mockResolvedValue({ ok: true });
    mocks.persist.mockResolvedValue(undefined);
    mocks.associate.mockResolvedValue({ updated: true });
    mocks.enqueue.mockResolvedValue({ ok: true });
    mocks.complete.mockResolvedValue({ updated: true });

    const result = await spawnPrReviewTrigger(input);
    const sessionId = mocks.create.mock.calls[0]?.[1];
    expect(result).toEqual({ ok: true, sessionId });
    expect(mocks.create.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ agentRole: "review", agentProfile: "review" }),
    );
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      sessionId,
      "Review pull request https://github.com/acme/repo/pull/123 at its current head.",
      "42",
      expect.objectContaining({ auth: expect.any(Object) }),
    );
    expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), {
      prUrl: input.prUrl,
      claimToken: input.claimToken,
    });
    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: "pr_review_trigger", outcome: "created", model_pairing: "unknown" }),
      "Created PR review",
    );
  });

  it("routes a Codex author to Claude when an Anthropic key is available", async () => {
    mocks.claim.mockResolvedValue({ won: true });
    mocks.admission.mockResolvedValue({ ok: true });
    mocks.persist.mockResolvedValue(undefined);
    mocks.associate.mockResolvedValue({ updated: true });
    mocks.enqueue.mockResolvedValue({ ok: true });
    mocks.complete.mockResolvedValue({ updated: true });
    mocks.canResolveProviderKey.mockResolvedValue(true);

    await spawnPrReviewTrigger({
      ...input,
      authorModel: "gpt-5.4",
      authorAgentRuntimeBackend: "codex",
      waitUntil: (promise) => void promise,
    });

    expect(mocks.create.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        model: "claude-opus-4-8",
        reasoningEffort: "high",
      }),
    );
    expect(mocks.canResolveProviderKey).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "anthropic",
      }),
    );
    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "pr_review_trigger",
        outcome: "created",
        model_pairing: "cross_backend",
        reviewer_model: "claude-opus-4-8",
        author_backend: "codex",
      }),
      "Created PR review",
    );
  });

  it("keeps the Codex fallback on its registry reasoning default", async () => {
    mocks.claim.mockResolvedValue({ won: true });
    mocks.admission.mockResolvedValue({ ok: true });
    mocks.persist.mockResolvedValue(undefined);
    mocks.associate.mockResolvedValue({ updated: true });
    mocks.enqueue.mockResolvedValue({ ok: true });
    mocks.complete.mockResolvedValue({ updated: true });

    await spawnPrReviewTrigger(input);

    expect(mocks.create.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ model: "gpt-5.4", reasoningEffort: "medium" }),
    );
  });

  it("returns contention as a successful skip", async () => {
    mocks.claim.mockResolvedValue({ won: false });
    await expect(spawnPrReviewTrigger(input)).resolves.toEqual({
      ok: false,
      kind: "skip",
      reason: "claim_contended",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("releases the claim and compensates when enqueue fails", async () => {
    mocks.claim.mockResolvedValue({ won: true });
    mocks.admission.mockResolvedValue({ ok: true });
    mocks.persist.mockResolvedValue(undefined);
    mocks.associate.mockResolvedValue({ updated: true });
    mocks.enqueue.mockResolvedValue({ ok: false, status: 503 });
    mocks.close.mockResolvedValue(null);

    await expect(spawnPrReviewTrigger(input)).resolves.toEqual({
      ok: false,
      kind: "retryable",
      reason: "spawn_failed",
    });
    expect(mocks.close).toHaveBeenCalledWith(expect.anything(), expect.any(String), undefined, expect.any(Object));
    expect(mocks.release).toHaveBeenCalledWith(expect.anything(), {
      prUrl: input.prUrl,
      claimToken: input.claimToken,
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("keeps an already-enqueued review alive when completion loses ownership", async () => {
    mocks.claim.mockResolvedValue({ won: true });
    mocks.admission.mockResolvedValue({ ok: true });
    mocks.persist.mockResolvedValue(undefined);
    mocks.associate.mockResolvedValue({ updated: true });
    mocks.enqueue.mockResolvedValue({ ok: true });
    mocks.complete.mockResolvedValue({ updated: false });

    const result = await spawnPrReviewTrigger(input);

    expect(result.ok).toBe(true);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
