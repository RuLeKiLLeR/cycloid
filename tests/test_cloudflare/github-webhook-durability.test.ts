import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGithubCheckRunPayload,
  buildGithubCommitStatusPayload,
  buildGithubIssueCommentPayload,
  buildGithubPullRequestPayload,
  buildGithubPullRequestReviewPayload,
  makeSignedGithubRequest,
} from "./github-webhook-fixtures";

// ---------------------------------------------------------------------------
// PR4 webhook-durability tests: pull_request `synchronize` head reconciliation
// (FIX #10) and per-(delivery, PR) idempotency isolation on the multi-PR
// check_run loop (FIX #11). These drive the real handleGithubWebhook end-to-end
// with the review-loop services mocked so we can observe head reconciliation
// and per-PR claim/release behavior.
// ---------------------------------------------------------------------------

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
  instrumentDurableObjectWithSentry: (_o: unknown, D: unknown) => D,
  withSentry: (_o: unknown, h: unknown) => h,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

const mockGetSessionState = vi.fn();
const mockUpdateSessionReviewListeningHead = vi.fn();
const mockSetSessionVerificationResult = vi.fn();
const mockSetSessionVerificationState = vi.fn();
const mockCloseSessionForWebhook = vi.fn();
const mockNotifySessionPrMerged = vi.fn();
const mockScheduleVerificationForPr = vi.fn();
const mockClearVerificationVerdictForHeadChange = vi.fn();
const mockStampVerificationVerdictHeadForHeadChange = vi.fn();
const mockShadowEmitHeadChange = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  updateSessionReviewListeningHead: (...args: unknown[]) => mockUpdateSessionReviewListeningHead(...args),
  setSessionVerificationResult: (...args: unknown[]) => mockSetSessionVerificationResult(...args),
  setSessionVerificationState: (...args: unknown[]) => mockSetSessionVerificationState(...args),
  closeSessionForWebhook: (...args: unknown[]) => mockCloseSessionForWebhook(...args),
  notifySessionPrMerged: (...args: unknown[]) => mockNotifySessionPrMerged(...args),
  createSessionState: vi.fn(),
  enqueueSessionPrompt: vi.fn(),
}));

const mockSyncVerificationResultForPr = vi.fn();
const mockSyncVerificationStateForPr = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/verification-state", async (importActual) => ({
  ...(await importActual<typeof import("../../apps/control-plane-worker/src/session/verification-state")>()),
  syncVerificationResultForPr: (...args: unknown[]) => mockSyncVerificationResultForPr(...args),
  syncVerificationStateForPr: (...args: unknown[]) => mockSyncVerificationStateForPr(...args),
}));

const mockMarkReviewLoopEpochsStaleForHeadChange = vi.fn();
const mockGetPrCoordination = vi.fn();
const mockCarryForwardReviewLoopEpochsToNewHead = vi.fn();
const mockCarryForwardTruncatedTailEpochsToNewHead = vi.fn();
const mockIngestCheckRun = vi.fn();
const mockIngestCommitStatus = vi.fn();
const mockIngestPrIssueComment = vi.fn();
const mockIngestReviewComment = vi.fn();
const mockIngestReview = vi.fn();
const mockEmitTruncatedTailMetric = vi.fn();

vi.mock("../../apps/control-plane-worker/src/observability/pr-metrics", async (importActual) => ({
  ...(await importActual<typeof import("../../apps/control-plane-worker/src/observability/pr-metrics")>()),
  emitReviewLoopTruncatedTailRekeyedMetric: (...args: unknown[]) => mockEmitTruncatedTailMetric(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/pr-coordination-db", async (importActual) => ({
  ...(await importActual<typeof import("../../apps/control-plane-worker/src/session/pr-coordination-db")>()),
  getPrCoordination: (...args: unknown[]) => mockGetPrCoordination(...args),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-epochs", () => ({
  markReviewLoopEpochsStaleForHeadChange: (...args: unknown[]) => mockMarkReviewLoopEpochsStaleForHeadChange(...args),
  carryForwardReviewLoopEpochsToNewHead: (...args: unknown[]) => mockCarryForwardReviewLoopEpochsToNewHead(...args),
  carryForwardTruncatedTailEpochsToNewHead: (...args: unknown[]) =>
    mockCarryForwardTruncatedTailEpochsToNewHead(...args),
  ingestReviewLoopCheckRunWebhook: (...args: unknown[]) => mockIngestCheckRun(...args),
  ingestReviewLoopCiFailureWebhook: vi.fn().mockResolvedValue({ status: "ignored", reason: "noop" }),
  ingestReviewLoopCommitStatusWebhook: (...args: unknown[]) => mockIngestCommitStatus(...args),
  ingestReviewLoopPrIssueCommentWebhook: (...args: unknown[]) => mockIngestPrIssueComment(...args),
  ingestReviewLoopPullRequestReviewCommentWebhook: (...args: unknown[]) => mockIngestReviewComment(...args),
  ingestReviewLoopPullRequestReviewWebhook: (...args: unknown[]) => mockIngestReview(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/verification-spawn", () => ({
  scheduleVerificationForPr: (...args: unknown[]) => mockScheduleVerificationForPr(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/fsm/head-producer", async (importActual) => ({
  ...(await importActual<typeof import("../../apps/control-plane-worker/src/session/fsm/head-producer")>()),
  shadowEmitHeadChange: (...args: unknown[]) => mockShadowEmitHeadChange(...args),
}));

// Preserve the real module (the webhook also imports isImplementationSessionForPr /
// syncVerificationStateForPr from it) and override only the head-change verdict clear so we can
// observe it without driving the DO RPC fan-out.
vi.mock("../../apps/control-plane-worker/src/session/verification-state", async (importActual) => ({
  ...(await importActual<typeof import("../../apps/control-plane-worker/src/session/verification-state")>()),
  clearVerificationVerdictForHeadChange: (...args: unknown[]) => mockClearVerificationVerdictForHeadChange(...args),
  stampVerificationVerdictHeadForHeadChange: (...args: unknown[]) =>
    mockStampVerificationVerdictHeadForHeadChange(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

// ARC-1330 (W11-P2): the canonical FSM label writer the head-change teardown delegates to under live.
const mockSyncFsmLabelsForPr = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/fsm-label-sync", () => ({
  syncFsmLabelsForPr: (...args: unknown[]) => mockSyncFsmLabelsForPr(...args),
}));

// Real module preserved except getPullRequestsForCommit, so a transient commit→PR lookup failure on the
// status path can be exercised (ARC-1224 site 1271, pre-loop throw before the per-PR loop).
const mockGetPullRequestsForCommit = vi.fn();
const mockRemoveLabel = vi.fn();
// Override isNoOpHeadTreeChange so the head-change verdict-clear gate is observable without live
// commit fetches. Defaults to false (real content change) in beforeEach; the no-op test sets it true.
const mockIsNoOpHeadTreeChange = vi.fn();
vi.mock("../../apps/control-plane-worker/src/github/pr", async (importActual) => ({
  ...(await importActual<typeof import("../../apps/control-plane-worker/src/github/pr")>()),
  getPullRequestsForCommit: (...args: unknown[]) => mockGetPullRequestsForCommit(...args),
  removeLabel: (...args: unknown[]) => mockRemoveLabel(...args),
  isNoOpHeadTreeChange: (...args: unknown[]) => mockIsNoOpHeadTreeChange(...args),
}));

// Real module preserved except reconcilePrDraftStateForPr, so a transient reconcile throw on the
// pull_request draft-state path can be exercised (ARC-1224 site 2702).
const mockReconcilePrDraftStateForPr = vi.fn();
vi.mock("../../apps/control-plane-worker/src/session/pr-draft-reconciliation", async (importActual) => ({
  ...(await importActual<typeof import("../../apps/control-plane-worker/src/session/pr-draft-reconciliation")>()),
  reconcilePrDraftStateForPr: (...args: unknown[]) => mockReconcilePrDraftStateForPr(...args),
}));

const WEBHOOK_SECRET = "test-webhook-secret";

// FakeD1 backing webhook_idempotency claims + session_webhook_refs lookups.
class FakeD1Statement {
  private boundValues: unknown[] = [];
  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}
  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    if (this.query.includes("INTO webhook_idempotency")) {
      const [key] = this.boundValues as [string];
      // Allow tests to simulate a transient DB failure on a specific claim INSERT (e.g. a per-PR
      // claim that sits outside the protected try) so the handler's claim-time throw path can be
      // exercised without the whole-delivery claim leaking.
      if (this.db.failClaimForKeys.some((suffix) => key.endsWith(suffix))) {
        throw new Error(`Simulated transient DB failure claiming ${key}`);
      }
      if (this.db.idempotency.has(key)) return { success: true, meta: { changes: 0 } };
      this.db.idempotency.add(key);
      return { success: true, meta: { changes: 1 } };
    }
    if (this.query.includes("DELETE FROM webhook_idempotency")) {
      const [, key] = this.boundValues as [string, string];
      // Allow tests to simulate a transient DB failure on a specific per-PR release: the throw must
      // not be able to abort the catch flow that records the failed PR + releases the whole claim.
      if (this.db.failReleaseForKeys.some((suffix) => key.endsWith(suffix))) {
        throw new Error(`Simulated transient DB failure releasing claim ${key}`);
      }
      this.db.idempotency.delete(key);
      this.db.released.push(key);
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
  async first(): Promise<Record<string, unknown> | null> {
    return null;
  }
  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (this.query.includes("FROM session_webhook_refs")) {
      // Allow tests to simulate a transient DB failure on the session-ref lookup that runs after a
      // claim is committed (ARC-1224 sites 2883 pr-closed pre-reconcile lookup).
      if (this.db.failSessionRefsLookup) {
        throw new Error("Simulated transient DB failure reading session_webhook_refs");
      }
      return { results: this.db.sessionRefs.map((id) => ({ session_id: id, external_ref: this.db.prUrl })) };
    }
    return { results: [] };
  }
}

class FakeD1 {
  readonly idempotency = new Set<string>();
  readonly released: string[] = [];
  failReleaseForKeys: string[] = [];
  failClaimForKeys: string[] = [];
  failSessionRefsLookup = false;
  sessionRefs: string[] = [];
  prUrl = "https://github.com/acme/repo/pull/42";
  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
  async batch(statements: FakeD1Statement[]): Promise<unknown[]> {
    return Promise.all(statements.map((s) => s.run()));
  }
}

type GithubWebhookModule = {
  handleGithubWebhook: (request: Request, env: unknown, ctx?: unknown) => Promise<Response>;
};

let githubMod: GithubWebhookModule;
let fakeDb: FakeD1;

beforeEach(async () => {
  mockGetSessionState.mockReset();
  mockUpdateSessionReviewListeningHead
    .mockReset()
    .mockResolvedValue({ ok: true, status: 200, payload: { updated: true } });
  mockSetSessionVerificationResult.mockReset().mockResolvedValue({ ok: true, status: 200, payload: {} });
  mockSetSessionVerificationState.mockReset().mockResolvedValue({ ok: true, status: 200, payload: {} });
  mockCloseSessionForWebhook.mockReset().mockResolvedValue({ closed: true });
  mockNotifySessionPrMerged.mockReset().mockResolvedValue({ ok: true, status: 200, payload: { notified: true } });
  mockMarkReviewLoopEpochsStaleForHeadChange.mockReset().mockResolvedValue(1);
  // Default: no spine queued marker → the head-change reconcile stale-blocks (the foreign-push path).
  // The carry-forward test overrides this with a queued marker on the previous head (ARC-1245).
  mockGetPrCoordination.mockReset().mockResolvedValue(null);
  mockCarryForwardReviewLoopEpochsToNewHead.mockReset().mockResolvedValue(0);
  mockCarryForwardTruncatedTailEpochsToNewHead.mockReset().mockResolvedValue(0);
  mockEmitTruncatedTailMetric.mockReset().mockResolvedValue(undefined);
  mockStampVerificationVerdictHeadForHeadChange.mockReset().mockResolvedValue(undefined);
  // Default: a real content change (clears the verdict as before). The no-op-tree test overrides this.
  mockIsNoOpHeadTreeChange.mockReset().mockResolvedValue(false);
  mockSyncVerificationResultForPr.mockReset().mockResolvedValue(undefined);
  mockSyncVerificationStateForPr.mockReset().mockResolvedValue(undefined);
  mockRemoveLabel.mockReset().mockResolvedValue(undefined);
  mockIngestCheckRun.mockReset();
  mockIngestCommitStatus.mockReset().mockResolvedValue({ status: "ignored", reason: "noop" });
  mockIngestPrIssueComment.mockReset();
  mockIngestReviewComment.mockReset();
  mockIngestReview.mockReset();
  mockGetPullRequestsForCommit.mockReset();
  mockReconcilePrDraftStateForPr.mockReset();
  mockScheduleVerificationForPr.mockReset().mockResolvedValue({
    scheduled: true,
    sessionId: "verification-session",
  });
  mockClearVerificationVerdictForHeadChange.mockReset().mockResolvedValue(undefined);
  mockShadowEmitHeadChange.mockReset().mockResolvedValue(undefined);
  mockSyncFsmLabelsForPr.mockReset().mockResolvedValue({ added: [], removed: [] });
  fakeDb = new FakeD1();
  githubMod = (await import("../../apps/control-plane-worker/src/webhooks/github")) as unknown as GithubWebhookModule;
});

function envFor(): unknown {
  return { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };
}

describe("pull_request synchronize head reconciliation (FIX #10)", () => {
  it("marks prior epochs stale and advances the review-listening head on a head-SHA change", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: {
          html_url: "https://github.com/acme/repo/pull/42",
          number: 42,
          head: { sha: "new-head" },
          base: { repo: { owner: { login: "acme" }, name: "repo" } },
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.synchronize).toBe(true);
    expect(json.headChanged).toBe(1);
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        sessionId: "sess-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        previousHeadSha: "old-head",
        currentHeadSha: "new-head",
      }),
    );
    expect(mockUpdateSessionReviewListeningHead).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      expect.objectContaining({ prUrl: "https://github.com/acme/repo/pull/42", currentHeadSha: "new-head" }),
    );
  });

  it("threads the webhook ExecutionContext waitUntil into head-change shadow emits", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: {
          html_url: "https://github.com/acme/repo/pull/42",
          number: 42,
          head: { sha: "new-head" },
          base: { repo: { owner: { login: "acme" }, name: "repo" } },
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });
    const waitUntil = vi.fn();

    const response = await githubMod.handleGithubWebhook(request, envFor(), { waitUntil });
    const waitUntilArg = mockShadowEmitHeadChange.mock.calls.at(-1)?.[4];

    expect(response.status).toBe(200);
    expect(mockShadowEmitHeadChange).toHaveBeenCalledWith(
      expect.anything(),
      "sess-1",
      expect.objectContaining({ kind: "head.changed", headSha: "new-head" }),
      expect.anything(),
      expect.any(Function),
    );
    expect(typeof waitUntilArg).toBe("function");
    const deferred = Promise.resolve();
    (waitUntilArg as (promise: Promise<unknown>) => void)(deferred);
    expect(waitUntil).toHaveBeenCalledWith(deferred);
  });

  it("clears outdated done and verification verdict state after advancing the head", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
      reviewLoopDoneState: "done",
      verificationState: "verification-done",
      verificationResult: "needs-work",
      verificationNeedsWorkLabel: "verification-gap",
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: {
          html_url: "https://github.com/acme/repo/pull/42",
          number: 42,
          head: { sha: "new-head" },
          base: { repo: { owner: { login: "acme" }, name: "repo" } },
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.headChanged).toBe(1);
    // ARC-1330 D-59b: the blunt legacy stale-label strip (`clearSynchronizeStaleReviewLoopLabels` →
    // removeLabel review-loop:done/ci-red) is deleted. In the non-live path it no longer runs at all; at
    // live the canonical `labelsOf` reconcile tears the stale managed labels down off the post-head-change
    // spine row (asserted by the sibling live test). The verdict clear still runs unconditionally.
    expect(mockRemoveLabel).not.toHaveBeenCalled();
    // ARC-1330 D-59 residue fold: the standalone verdict clear is DELETED. The webhook now DELEGATES
    // verdict-store maintenance to the head producer via shadowEmitHeadChange (a real change emits
    // `head.changed`, whose `syncLegacyVerificationStoreForHeadChange` clears at live). The producer is
    // mocked here, so the standalone writer is never called directly.
    expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
    const emitCall = mockShadowEmitHeadChange.mock.calls.find((c) => c[1] === "sess-1");
    expect(emitCall?.[2]).toMatchObject({ kind: "head.changed" });
    expect(mockSetSessionVerificationState).not.toHaveBeenCalled();
    expect(mockSetSessionVerificationResult).not.toHaveBeenCalled();
  });

  it("ARC-1330 (W11-P2): under FSM_MODE=live the blunt legacy label teardown stands down and the canonical writer reconciles off the post-head-change spine row", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
      verificationState: "verification-done",
      verificationResult: "needs-work",
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: {
          html_url: "https://github.com/acme/repo/pull/42",
          number: 42,
          head: { sha: "new-head" },
          base: { repo: { owner: { login: "acme" }, name: "repo" } },
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, {
      ...(envFor() as object),
      FSM_MODE: "live",
    } as never);
    expect(response.status).toBe(200);

    // The legacy strip (review-loop:done / review-loop:ci-red) does NOT run at live.
    expect(mockRemoveLabel).not.toHaveBeenCalled();
    // The canonical writer reconciles the managed labels off the freshly-committed spine row.
    expect(mockSyncFsmLabelsForPr).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prUrl: "https://github.com/acme/repo/pull/42", sessionId: "sess-1" }),
    );
  });

  it("releases the delivery claim and returns 500 when the review-listening head update fails", async () => {
    // The head advance is the critical idempotent operation: if it fails we must return non-2xx so
    // GitHub redelivers. The verdict clear is best-effort and runs only after a successful head update.
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
      verificationState: "verification-done",
      verificationResult: "needs-work",
    });
    mockUpdateSessionReviewListeningHead.mockResolvedValue({ ok: false, status: 503, payload: undefined });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: {
          html_url: "https://github.com/acme/repo/pull/42",
          number: 42,
          head: { sha: "new-head" },
          base: { repo: { owner: { login: "acme" }, name: "repo" } },
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());

    expect(response.status).toBe(500);
    expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
    expect(fakeDb.released.some((key) => !key.includes(":pr:"))).toBe(true);
    expect(fakeDb.idempotency.size).toBe(0);
  });

  // ARC-1330 D-59b: the test asserting a stale-label-cleanup failure returns 500 is deleted with
  // `clearSynchronizeStaleReviewLoopLabels`. That blunt teardown is gone; the canonical `labelsOf`
  // reconcile (best-effort under live) is not on the critical redelivery path, so there is no
  // label-cleanup failure that can gate the delivery claim. The head-update-failure → 500 durability
  // contract (the actual idempotent critical op) is covered by the sibling test above.

  it("does nothing when the head already matches the session", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "same-head",
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: { html_url: "https://github.com/acme/repo/pull/42", number: 42, head: { sha: "same-head" } },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(json.headChanged).toBe(0);
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).not.toHaveBeenCalled();
    expect(mockUpdateSessionReviewListeningHead).not.toHaveBeenCalled();
  });

  it("releases the whole-delivery claim and returns 500 when a session reconcile fails (so GitHub redelivers)", async () => {
    fakeDb.sessionRefs = ["sess-ok", "sess-bad"];
    mockGetSessionState.mockImplementation(async (_env: unknown, sessionId: string) => ({
      sessionId,
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
    }));
    // sess-bad's head update fails (transient non-OK); sess-ok succeeds.
    mockUpdateSessionReviewListeningHead.mockImplementation(async (_env: unknown, sessionId: string) => {
      if (sessionId === "sess-bad") return { ok: false, status: 503, payload: undefined };
      return { ok: true, status: 200, payload: { updated: true } };
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: { html_url: "https://github.com/acme/repo/pull/42", number: 42, head: { sha: "new-head" } },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());

    expect(response.status).toBe(500);
    // Whole-delivery claim (no :pr: suffix) was released so the redelivery re-enters reconciliation.
    expect(fakeDb.released.some((k) => !k.includes(":pr:"))).toBe(true);
    expect(fakeDb.idempotency.size).toBe(0);
  });

  it("commits the claim and returns 200 when all sessions reconcile (head advanced, epochs stale)", async () => {
    fakeDb.sessionRefs = ["sess-1", "sess-2"];
    mockGetSessionState.mockImplementation(async (_env: unknown, sessionId: string) => ({
      sessionId,
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
    }));

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: { html_url: "https://github.com/acme/repo/pull/42", number: 42, head: { sha: "new-head" } },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.errored).toBe(0);
    expect(json.headChanged).toBe(2);
    // Claim stays committed (not released) so GitHub does not redeliver.
    expect(fakeDb.released).toEqual([]);
    expect(fakeDb.idempotency.size).toBe(1);
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalledTimes(2);
    expect(mockUpdateSessionReviewListeningHead).toHaveBeenCalledTimes(2);
  });

  // ARC-1245: the webhook must mirror the sweep's head-change branch and carry pending review-loop
  // epochs forward when the advance is our own base-merge (a prior mergeability attempt exists),
  // instead of always stale-blocking them. The webhook advances the head out-of-band, so the sweep's
  // carry-forward branch is skipped on the next tick (previousHeadSha === newHeadSha) and the pending
  // work would otherwise be silently dropped (a base-merge carries no new feedback to re-bootstrap).
  it("carries pending epochs forward (not stale-block) when our update-branch advanced the head", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
    });
    // The spine row still names the previous head with a QUEUED update-branch marker → the change is
    // our own base-merge. A row without the marker would stale-block instead (ARC-1302, D-54).
    mockGetPrCoordination.mockResolvedValueOnce({
      sessionId: "sess-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "old-head",
      updateBranchQueuedAt: 900,
    });
    mockCarryForwardReviewLoopEpochsToNewHead.mockResolvedValueOnce(2);

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: {
          html_url: "https://github.com/acme/repo/pull/42",
          number: 42,
          head: { sha: "new-head" },
          base: { repo: { owner: { login: "acme" }, name: "repo" } },
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(mockGetPrCoordination).toHaveBeenCalledWith(fakeDb, "sess-1");
    expect(mockCarryForwardReviewLoopEpochsToNewHead).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        sessionId: "sess-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        previousHeadSha: "old-head",
        currentHeadSha: "new-head",
      }),
    );
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).not.toHaveBeenCalled();
    expect(json.carriedForward).toBe(2);
    expect(json.headChanged).toBe(1);
  });

  it("falls back to stale-block when no prior mergeability attempt recorded (foreign head change)", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
    });
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(1);

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: {
          html_url: "https://github.com/acme/repo/pull/42",
          number: 42,
          head: { sha: "new-head" },
          base: { repo: { owner: { login: "acme" }, name: "repo" } },
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(mockCarryForwardReviewLoopEpochsToNewHead).not.toHaveBeenCalled();
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).toHaveBeenCalled();
    expect(json.carriedForward).toBe(0);
    expect(json.staleEpochsBlocked).toBe(1);
    // No truncated tail owed on this head → 0 re-keyed (the field is present and numeric, guarding the
    // webhook consumer against the helper's extended result shape, ARC-1244).
    expect(json.truncatedRekeyed).toBe(0);
  });

  it("re-keys a budget-truncated tail to the new head on a foreign synchronize (ARC-1244)", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
      ownerUserId: 101,
    });
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(1);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(0);

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: {
          html_url: "https://github.com/acme/repo/pull/42",
          number: 42,
          head: { sha: "new-head" },
          base: { repo: { owner: { login: "acme" }, name: "repo" } },
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(mockCarryForwardTruncatedTailEpochsToNewHead).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ previousHeadSha: "old-head", currentHeadSha: "new-head" }),
    );
    expect(json.truncatedRekeyed).toBe(1);
    // The recovery metric is emitted with the repo from the payload's base.repo.name.
    expect(mockEmitTruncatedTailMetric).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repo: "repo", rekeyed: 1 }),
    );
  });

  it("still counts a truncated-tail recovery and tags it via the prUrl when the payload omits base.repo.name (ARC-1244)", async () => {
    // A malformed/partial synchronize payload missing base.repo.name must NOT drop the recovery: the
    // re-key happens and is counted, and the metric falls back to a repo derived from the prUrl
    // (canonical parseGithubPullRequestUrl) rather than being gated away or tagged empty.
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
      ownerUserId: 101,
    });
    mockCarryForwardTruncatedTailEpochsToNewHead.mockResolvedValueOnce(1);
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(0);

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: {
          html_url: "https://github.com/acme/repo/pull/42",
          number: 42,
          head: { sha: "new-head" },
          base: { repo: { owner: { login: "acme" } } }, // no `name`
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.truncatedRekeyed).toBe(1);
    // base.repo.name was absent, so the repo tag is derived from the prUrl (.../acme/repo/pull/42).
    expect(mockEmitTruncatedTailMetric).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ repo: "repo", rekeyed: 1 }),
    );
  });

  it("skips non-listening sessions", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: false,
      reviewListeningHeadSha: "old-head",
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: { html_url: "https://github.com/acme/repo/pull/42", number: 42, head: { sha: "new-head" } },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    expect(response.status).toBe(200);
    expect(mockMarkReviewLoopEpochsStaleForHeadChange).not.toHaveBeenCalled();
  });
});

describe("ARC-1231: synchronize head advance clears the outdated verification verdict", () => {
  // The sweep head-change handler clears a settled prior-head verdict (ARC-1227), but the
  // synchronize webhook advances the head out-of-band so the sweep's branch is skipped next tick
  // (previousHeadSha === currentHeadSha). Without clearing here, an outdated needs-work/verification-gap
  // verdict from H1 binds to H2 (the verification-intake gate keys on the live head).
  it("clears the verdict when the head advances on a session holding one", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
      verificationState: "verification-done",
      verificationResult: "needs-work",
      verificationNeedsWorkLabel: "verification-gap",
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: { html_url: "https://github.com/acme/repo/pull/42", number: 42, head: { sha: "new-head" } },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.headChanged).toBe(1);
    expect(mockUpdateSessionReviewListeningHead).toHaveBeenCalledOnce();
    // ARC-1330 D-59 residue fold: verdict-store maintenance delegates to the head producer — a real change
    // emits `head.changed` (the producer clears at live). The standalone webhook clear is gone.
    expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
    const emitCall = mockShadowEmitHeadChange.mock.calls.find((c) => c[1] === "sess-1");
    expect(emitCall?.[2]).toMatchObject({ kind: "head.changed" });
  });

  it("preserves the verdict on a content no-op head advance (identical tree) so it is not re-verified", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockIsNoOpHeadTreeChange.mockResolvedValue(true);
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
      installationId: 9001,
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationNeedsWorkLabel: null,
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: { html_url: "https://github.com/acme/repo/pull/42", number: 42, head: { sha: "new-head" } },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    // The head still advances, but the verdict + per-head baseline are PRESERVED (the scheduler's
    // verdict guard then suppresses re-verification on the new SHA).
    expect(json.headChanged).toBe(1);
    expect(mockUpdateSessionReviewListeningHead).toHaveBeenCalledOnce();
    expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
    // ARC-1330 D-59 residue fold: the standalone restamp is DELETED. A content no-op emits `head.noop_changed`
    // to the head producer, whose `syncLegacyVerificationStoreForHeadChange` restamps the preserved verdict to
    // the new head at live. The producer is mocked here, so the standalone stamp is never called directly.
    expect(mockStampVerificationVerdictHeadForHeadChange).not.toHaveBeenCalled();
    const emitCall = mockShadowEmitHeadChange.mock.calls.find((c) => c[1] === "sess-1");
    expect(emitCall?.[2]).toMatchObject({ kind: "head.noop_changed" });
  });

  it("does not clear the verdict when the head is unchanged", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "same-head",
      verificationState: "verification-done",
      verificationResult: "needs-work",
      verificationNeedsWorkLabel: "verification-gap",
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: { html_url: "https://github.com/acme/repo/pull/42", number: 42, head: { sha: "same-head" } },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    await githubMod.handleGithubWebhook(request, envFor());

    expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
  });

  it("advances the head but skips the clear when the session holds no verdict", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
      verificationState: null,
      verificationResult: null,
      verificationNeedsWorkLabel: null,
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: { html_url: "https://github.com/acme/repo/pull/42", number: 42, head: { sha: "new-head" } },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(json.headChanged).toBe(1);
    expect(mockUpdateSessionReviewListeningHead).toHaveBeenCalledOnce();
    expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
  });

  it("does not clear an in-progress verification on head advance (preserves the sweep's in-progress defer)", async () => {
    // A push while auto-verification is still running: verificationState is "verification-in-progress"
    // with a null result. Clearing it here would wipe the active state/labels mid-run AND — because the
    // webhook already advanced the head — drop the sweep's in-progress defer (state would read null), so
    // the sweep could resume review-loop work while the verifier is still running. The sweep itself
    // never clears in-progress (its pause check `continue`s before the clear), so the webhook must skip
    // it too. There is no settled verdict to discard while in-progress anyway.
    fakeDb.sessionRefs = ["sess-1"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "sess-1",
      status: "active",
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "old-head",
      verificationState: "verification-in-progress",
      verificationResult: null,
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "synchronize",
        pull_request: { html_url: "https://github.com/acme/repo/pull/42", number: 42, head: { sha: "new-head" } },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    // The head still advances (pre-existing webhook behavior), but the in-progress verdict is left
    // intact — by EVERY path. The verdict clear must route only through the helper (which skips
    // in-progress); no direct state/result reset may wipe the active run (ARC-1231 / ARC-1243).
    expect(json.headChanged).toBe(1);
    expect(mockUpdateSessionReviewListeningHead).toHaveBeenCalledOnce();
    expect(mockClearVerificationVerdictForHeadChange).not.toHaveBeenCalled();
    expect(mockSetSessionVerificationState).not.toHaveBeenCalled();
    expect(mockSetSessionVerificationResult).not.toHaveBeenCalled();
  });
});

describe("pull_request labeled events (PR-E1: the review-loop:done label handler is deleted)", () => {
  it("a review-loop:done label is a no-op — no label handler remains (the label is scrapped)", async () => {
    fakeDb.sessionRefs = ["impl-session"];
    mockGetSessionState.mockResolvedValue({
      sessionId: "impl-session",
      ownerUserId: "1001",
      businessId: "biz-1",
      status: "active",
      agentRole: "implementation",
      repoOwner: "acme",
      repoName: "repo",
      installationId: 2222,
      reviewListeningActive: true,
      reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
      reviewListeningHeadSha: "previous-head",
    });

    const body = JSON.stringify(
      buildGithubPullRequestPayload({
        action: "labeled",
        installation: { id: 2222 },
        label: { name: "review-loop:done" },
        pull_request: {
          html_url: "https://github.com/acme/repo/pull/42",
          number: 42,
          draft: false,
          head: { sha: "latest-head" },
          base: { repo: { owner: { login: "acme" }, name: "repo" } },
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("no_label_handler");
    expect(mockScheduleVerificationForPr).not.toHaveBeenCalled();
  });

  it.each(["review-loop:ci-green", "review-loop:ci-red"])(
    "does not schedule verification for any labeled event %s (no_label_handler)",
    async (labelName) => {
      fakeDb.sessionRefs = ["impl-session"];
      mockGetSessionState.mockResolvedValue({
        sessionId: "impl-session",
        ownerUserId: "1001",
        businessId: "biz-1",
        status: "active",
        agentRole: "implementation",
        repoOwner: "acme",
        repoName: "repo",
        installationId: 2222,
        reviewListeningActive: true,
        reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
        reviewListeningHeadSha: "latest-head",
      });

      const body = JSON.stringify(
        buildGithubPullRequestPayload({
          action: "labeled",
          installation: { id: 2222 },
          label: { name: labelName },
          pull_request: {
            html_url: "https://github.com/acme/repo/pull/42",
            number: 42,
            head: { sha: "latest-head" },
            base: { repo: { owner: { login: "acme" }, name: "repo" } },
          },
        }),
      );
      const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });

      const response = await githubMod.handleGithubWebhook(request, envFor());
      const json = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(json.skipped).toBe(true);
      expect(json.reason).toBe("no_label_handler");
      expect(mockScheduleVerificationForPr).not.toHaveBeenCalled();
    },
  );
});

describe("check_run per-(delivery, PR) idempotency isolation (FIX #11)", () => {
  function checkRunBodyWithTwoPrs() {
    return JSON.stringify(
      buildGithubCheckRunPayload({
        check_run: {
          id: 9500,
          name: "cursor bugbot",
          status: "completed",
          conclusion: "success",
          head_sha: "head-sha",
          app: { slug: "cursor", name: "Cursor" },
          pull_requests: [
            { number: 42, head: { sha: "head-sha" } },
            { number: 43, head: { sha: "head-sha" } },
          ],
        },
      }),
    );
  }

  it("a mid-loop failure on PR #2 leaves PR #2 reprocessable on redelivery without re-processing PR #1", async () => {
    // First delivery: PR #42 ingests; PR #43 throws (transient DO failure).
    mockIngestCheckRun.mockImplementation(async (input: { prNumber: number }) => {
      if (input.prNumber === 43) throw new Error("Session DO lookup failed with status 503");
      return { status: "handled", epoch: { id: "ep-42" } };
    });

    const deliveryId = "delivery-multi-pr";
    const body = checkRunBodyWithTwoPrs();
    const firstReq = await makeSignedGithubRequest(body, {
      eventType: "check_run",
      secret: WEBHOOK_SECRET,
      deliveryId,
    });

    const firstResp = await githubMod.handleGithubWebhook(firstReq, envFor());
    // The failed PR surfaces a non-200 so GitHub redelivers.
    expect(firstResp.status).toBe(500);
    // PR #42's per-PR claim persists; PR #43's claim was released for retry.
    const pr42Claim = [...fakeDb.idempotency].find((k) => k.endsWith(":pr:42"));
    const pr43Claim = [...fakeDb.idempotency].find((k) => k.endsWith(":pr:43"));
    expect(pr42Claim).toBeTruthy();
    expect(pr43Claim).toBeUndefined();
    expect(fakeDb.released.some((k) => k.endsWith(":pr:43"))).toBe(true);

    // Redelivery (same delivery id + payload): PR #42 is deduped, only PR #43 reprocesses (now succeeds).
    mockIngestCheckRun.mockReset();
    const ingestedPrNumbers: number[] = [];
    mockIngestCheckRun.mockImplementation(async (input: { prNumber: number }) => {
      ingestedPrNumbers.push(input.prNumber);
      return { status: "handled", epoch: { id: `ep-${input.prNumber}` } };
    });

    const secondReq = await makeSignedGithubRequest(body, {
      eventType: "check_run",
      secret: WEBHOOK_SECRET,
      deliveryId,
    });
    const secondResp = await githubMod.handleGithubWebhook(secondReq, envFor());
    const json = (await secondResp.json()) as Record<string, unknown>;

    expect(secondResp.status).toBe(200);
    // Only PR #43 was re-ingested; PR #42 was skipped as a duplicate.
    expect(ingestedPrNumbers).toEqual([43]);
    expect(json.duplicated).toBe(1);
    expect(json.handled).toBe(1);
  });

  it("records the failed PR and releases the whole-delivery claim even when the per-PR release throws", async () => {
    // PR #43 ingest throws (transient DO failure); the in-catch per-PR release ALSO throws (same
    // transient DB failure). The catch must not abort: the PR is still recorded failed and the
    // whole-delivery claim is released so the failed PR is reprocessable on redelivery.
    mockIngestCheckRun.mockImplementation(async (input: { prNumber: number }) => {
      if (input.prNumber === 43) throw new Error("Session DO lookup failed with status 503");
      return { status: "handled", epoch: { id: "ep-42" } };
    });
    fakeDb.failReleaseForKeys = [":pr:43"];

    const body = checkRunBodyWithTwoPrs();
    const request = await makeSignedGithubRequest(body, {
      eventType: "check_run",
      secret: WEBHOOK_SECRET,
      deliveryId: "delivery-release-throws",
    });

    const response = await githubMod.handleGithubWebhook(request, envFor());

    // Non-200 surfaced (PR #43 recorded as failed despite the per-PR release throwing).
    expect(response.status).toBe(500);
    // The whole-delivery claim (no :pr: suffix) was released so the redelivery re-enters the loop.
    expect(fakeDb.released.some((k) => !k.includes(":pr:"))).toBe(true);
    // The whole-delivery claim is no longer held.
    expect([...fakeDb.idempotency].some((k) => !k.includes(":pr:"))).toBe(false);
  });

  it("a fully-successful delivery is fully deduped on redelivery (no double-processing)", async () => {
    mockIngestCheckRun.mockResolvedValue({ status: "handled", epoch: { id: "ep" } });
    const deliveryId = "delivery-clean";
    const body = checkRunBodyWithTwoPrs();

    const firstReq = await makeSignedGithubRequest(body, {
      eventType: "check_run",
      secret: WEBHOOK_SECRET,
      deliveryId,
    });
    const firstResp = await githubMod.handleGithubWebhook(firstReq, envFor());
    expect(firstResp.status).toBe(200);
    expect(mockIngestCheckRun).toHaveBeenCalledTimes(2);

    mockIngestCheckRun.mockClear();
    const secondReq = await makeSignedGithubRequest(body, {
      eventType: "check_run",
      secret: WEBHOOK_SECRET,
      deliveryId,
    });
    const secondResp = await githubMod.handleGithubWebhook(secondReq, envFor());
    const json = (await secondResp.json()) as Record<string, unknown>;

    expect(secondResp.status).toBe(200);
    // Clean redelivery short-circuits at the whole-delivery claim → no ingest re-runs.
    expect(mockIngestCheckRun).not.toHaveBeenCalled();
    expect(json).toMatchObject({ ok: true, skipped: true, reason: "duplicate" });
  });
});

describe("ARC-1224: webhook idempotency-claim release on transient post-claim failure", () => {
  // Each test commits the whole-delivery claim, then forces a transient throw between the claim
  // commit and a successful response. With the fix the handler releases the claim and returns a
  // non-200 so GitHub redelivers; without it the claim stays committed and the reviewer's
  // comment / review / user intent is dropped until the ~7-day claim TTL.
  function expectReleasedAnd500(response: Response) {
    expect(response.status).toBe(500);
    // Whole-delivery claim (no :pr: suffix) was released so the redelivery reprocesses.
    expect(fakeDb.released.some((k) => !k.includes(":pr:"))).toBe(true);
    // No whole-delivery claim remains committed.
    expect([...fakeDb.idempotency].some((k) => !k.includes(":pr:"))).toBe(false);
  }

  it("issue_comment review-loop ingest (site 1145): releases the claim and 500s when ingest throws", async () => {
    mockIngestPrIssueComment.mockRejectedValue(new Error("transient D1 failure during ingest"));
    const body = JSON.stringify(
      buildGithubIssueCommentPayload({
        comment: { id: 77, body: "please address the naming nit" },
        issue: {
          id: 9001,
          number: 73,
          title: "t",
          body: "b",
          html_url: "https://github.com/acme/repo/issues/73",
          pull_request: { url: "https://api.github.com/repos/acme/repo/pulls/73" },
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "issue_comment", secret: WEBHOOK_SECRET });
    const response = await githubMod.handleGithubWebhook(request, envFor());
    expect(mockIngestPrIssueComment).toHaveBeenCalledOnce();
    expectReleasedAnd500(response);
  });

  it("pull_request_review_comment ingest (site 1715): releases the claim and 500s when ingest throws", async () => {
    mockIngestReviewComment.mockRejectedValue(new Error("transient D1 failure during ingest"));
    const body = JSON.stringify({
      action: "created",
      installation: { id: 2222 },
      repository: { name: "repo", html_url: "https://github.com/acme/repo", owner: { login: "acme" } },
      pull_request: { number: 42, html_url: "https://github.com/acme/repo/pull/42", head: { sha: "head-sha" } },
      comment: { id: 88, body: "nit: rename this", commit_id: "head-sha", user: { login: "reviewer", type: "User" } },
    });
    const request = await makeSignedGithubRequest(body, {
      eventType: "pull_request_review_comment",
      secret: WEBHOOK_SECRET,
    });
    const response = await githubMod.handleGithubWebhook(request, envFor());
    expect(mockIngestReviewComment).toHaveBeenCalledOnce();
    expectReleasedAnd500(response);
  });

  it("bot pull_request_review ingest (site 2203): releases the claim and 500s when ingest throws", async () => {
    mockIngestReview.mockRejectedValue(new Error("transient D1 failure during ingest"));
    const body = JSON.stringify(
      buildGithubPullRequestReviewPayload({ review: { user: { id: 999, login: "coderabbitai", type: "Bot" } } }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request_review", secret: WEBHOOK_SECRET });
    const response = await githubMod.handleGithubWebhook(request, envFor());
    expect(mockIngestReview).toHaveBeenCalledOnce();
    expectReleasedAnd500(response);
  });

  it("status pre-loop lookup (site 1271): releases the claim and 500s when the commit→PR lookup throws", async () => {
    mockGetPullRequestsForCommit.mockRejectedValue(new Error("transient GitHub 503"));
    const body = JSON.stringify(buildGithubCommitStatusPayload());
    const request = await makeSignedGithubRequest(body, { eventType: "status", secret: WEBHOOK_SECRET });
    const response = await githubMod.handleGithubWebhook(request, envFor());
    expect(mockGetPullRequestsForCommit).toHaveBeenCalledOnce();
    expectReleasedAnd500(response);
  });

  it("check_run per-PR claim (site 1474): releases the whole-delivery claim and 500s when the per-PR claim throws", async () => {
    // The per-PR claim INSERT throws (transient D1) before the protected ingest try; the fix widens
    // the per-PR try so the throw is recorded as a failed PR and the whole-delivery release-and-500 fires.
    fakeDb.failClaimForKeys = [":pr:42"];
    mockIngestCheckRun.mockResolvedValue({ status: "handled", epoch: { id: "ep" } });
    const body = JSON.stringify(buildGithubCheckRunPayload());
    const request = await makeSignedGithubRequest(body, { eventType: "check_run", secret: WEBHOOK_SECRET });
    const response = await githubMod.handleGithubWebhook(request, envFor());
    expectReleasedAnd500(response);
  });

  it("status per-PR claim (site 1271 loop): releases the whole-delivery claim and 500s when the per-PR claim throws", async () => {
    // Enter the per-PR loop (lookup resolves), then throw on the per-PR claim INSERT that the fix
    // widened into the per-PR try; the throw is recorded as a failed PR and the loop-end
    // status_partial_failure release-and-500 fires. Twin of the check_run case but a separate loop.
    mockGetPullRequestsForCommit.mockResolvedValue([
      { number: 42, htmlUrl: "https://github.com/acme/repo/pull/42", headSha: "head-sha" },
    ]);
    fakeDb.failClaimForKeys = [":pr:42"];
    mockIngestCommitStatus.mockResolvedValue({ status: "handled", epoch: { id: "ep" } });
    const body = JSON.stringify(buildGithubCommitStatusPayload());
    const request = await makeSignedGithubRequest(body, { eventType: "status", secret: WEBHOOK_SECRET });
    const response = await githubMod.handleGithubWebhook(request, envFor());
    expectReleasedAnd500(response);
  });

  it("pull_request draft-state reconcile (site 2702): releases the claim and 500s when reconcile throws", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    mockReconcilePrDraftStateForPr.mockRejectedValue(new Error("transient D1 failure during reconcile"));
    const body = JSON.stringify(buildGithubPullRequestPayload({ action: "converted_to_draft" }));
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });
    const response = await githubMod.handleGithubWebhook(request, envFor());
    expect(mockReconcilePrDraftStateForPr).toHaveBeenCalledOnce();
    expectReleasedAnd500(response);
  });

  it("pull_request closed pre-reconcile lookup (site 2883): releases the claim and 500s when the session lookup throws", async () => {
    fakeDb.failSessionRefsLookup = true;
    const body = JSON.stringify(buildGithubPullRequestPayload({ action: "closed", pull_request: { merged: false } }));
    const request = await makeSignedGithubRequest(body, { eventType: "pull_request", secret: WEBHOOK_SECRET });
    const response = await githubMod.handleGithubWebhook(request, envFor());
    expectReleasedAnd500(response);
  });
});
