import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGithubCheckRunPayload,
  buildGithubCommitStatusPayload,
  makeSignedGithubRequest,
} from "./github-webhook-fixtures";

// ---------------------------------------------------------------------------
// PR3 Part B / ARC-1330 D-59a: the status / check_run handlers defer the best-effort, sweep-backed
// emitReviewLoopCiSignalFromWebhook (the CI-webhook → spine ci.signal producer; the legacy done-state
// reconcile it used to drive is deleted) off the hot path via executionCtx.waitUntil so the 200 acks
// BEFORE the slow GitHub/DO work runs. The deferred promise is wrapped in runWithSentryTag so a failure
// is logged + Sentry-captured, never dropped. These tests drive the real handleGithubWebhook with the
// ci-signal and ingest services mocked so we can observe the ack/deferral ordering.
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

const mockCaptureException = vi.fn();
vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_o: unknown, D: unknown) => D,
  withSentry: (_o: unknown, h: unknown) => h,
  setTag: () => {},
  setUser: () => {},
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockReconcile = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/review-loop-ci-signal", () => ({
  emitReviewLoopCiSignalFromWebhook: (...args: unknown[]) => mockReconcile(...args),
}));

const mockIngestCheckRun = vi.fn();
const mockIngestCommitStatus = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/review-loop-epochs", () => ({
  ingestReviewLoopCheckRunWebhook: (...args: unknown[]) => mockIngestCheckRun(...args),
  ingestReviewLoopCiFailureWebhook: vi.fn().mockResolvedValue({ status: "ignored", reason: "noop" }),
  ingestReviewLoopCommitStatusWebhook: (...args: unknown[]) => mockIngestCommitStatus(...args),
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

const mockGetPullRequestsForCommit = vi.fn();
vi.mock("../../apps/control-plane-worker/src/github/pr", async (importActual) => ({
  ...(await importActual<typeof import("../../apps/control-plane-worker/src/github/pr")>()),
  getPullRequestsForCommit: (...args: unknown[]) => mockGetPullRequestsForCommit(...args),
}));

const WEBHOOK_SECRET = "test-webhook-secret";

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
      if (this.db.idempotency.has(key)) return { success: true, meta: { changes: 0 } };
      this.db.idempotency.add(key);
      return { success: true, meta: { changes: 1 } };
    }
    if (this.query.includes("DELETE FROM webhook_idempotency")) {
      const [, key] = this.boundValues as [string, string];
      this.db.idempotency.delete(key);
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
  async first(): Promise<null> {
    return null;
  }
  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    return { results: [] };
  }
}

class FakeD1 {
  readonly idempotency = new Set<string>();
  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
  async batch(statements: FakeD1Statement[]): Promise<unknown[]> {
    return Promise.all(statements.map((s) => s.run()));
  }
}

// Mirror the production ExecutionContext.waitUntil: the platform keeps the worker alive until the
// captured promise settles, but the response is returned synchronously without awaiting it.
function makeCapturingCtx(): { ctx: { waitUntil: (p: Promise<unknown>) => void }; deferred: Promise<unknown>[] } {
  const deferred: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => deferred.push(p) },
    deferred,
  };
}

type GithubWebhookModule = {
  handleGithubWebhook: (request: Request, env: unknown, ctx?: unknown) => Promise<Response>;
};

let githubMod: GithubWebhookModule;
let fakeDb: FakeD1;

beforeEach(async () => {
  mockReconcile.mockReset().mockResolvedValue(undefined);
  mockCaptureException.mockReset();
  mockIngestCheckRun.mockReset().mockResolvedValue({ status: "handled", epoch: { id: "ep" } });
  mockIngestCommitStatus.mockReset().mockResolvedValue({ status: "handled", epoch: { id: "ep" } });
  mockGetPullRequestsForCommit
    .mockReset()
    .mockResolvedValue([{ number: 42, headSha: "head-sha", htmlUrl: "https://github.com/acme/repo/pull/42" }]);
  fakeDb = new FakeD1();
  githubMod = (await import("../../apps/control-plane-worker/src/webhooks/github")) as unknown as GithubWebhookModule;
});

function envFor(): unknown {
  return { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };
}

describe("PR3 Part B: webhook acks before the deferred review-loop reconcile runs", () => {
  it("check_run: returns 200 with the reconcile still pending (captured via waitUntil, not awaited)", async () => {
    // Gate the reconcile on an external resolver so we can prove the response resolves first.
    let releaseReconcile!: () => void;
    const reconcileStarted = vi.fn();
    mockReconcile.mockImplementation(async () => {
      reconcileStarted();
      await new Promise<void>((resolve) => {
        releaseReconcile = resolve;
      });
    });

    const body = JSON.stringify(buildGithubCheckRunPayload());
    const request = await makeSignedGithubRequest(body, { eventType: "check_run", secret: WEBHOOK_SECRET });
    const { ctx, deferred } = makeCapturingCtx();

    const response = await githubMod.handleGithubWebhook(request, envFor(), ctx);

    // The 200 is returned while the reconcile is still pending: it was handed to waitUntil, not awaited.
    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(1);
    expect(reconcileStarted).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headSha: "head-sha", token: "ghs_install_token" }),
    );

    // Now let the deferred work finish; the captured promise resolves cleanly.
    releaseReconcile();
    await expect(Promise.all(deferred)).resolves.toBeDefined();
  });

  it("status: returns 200 with the reconcile deferred via waitUntil", async () => {
    let releaseReconcile!: () => void;
    mockReconcile.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseReconcile = resolve;
        }),
    );

    const body = JSON.stringify(buildGithubCommitStatusPayload({ sha: "head-sha", state: "success" }));
    const request = await makeSignedGithubRequest(body, { eventType: "status", secret: WEBHOOK_SECRET });
    const { ctx, deferred } = makeCapturingCtx();

    const response = await githubMod.handleGithubWebhook(request, envFor(), ctx);

    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(1);
    expect(mockReconcile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headSha: "head-sha", token: "ghs_install_token" }),
    );

    releaseReconcile();
    await expect(Promise.all(deferred)).resolves.toBeDefined();
  });

  it("a deferred reconcile failure is logged + Sentry-captured (runWithSentryTag) and never fails the 200", async () => {
    mockReconcile.mockRejectedValue(new Error("transient DO failure during reconcile"));

    const body = JSON.stringify(buildGithubCheckRunPayload());
    const request = await makeSignedGithubRequest(body, { eventType: "check_run", secret: WEBHOOK_SECRET });
    const { ctx, deferred } = makeCapturingCtx();

    const response = await githubMod.handleGithubWebhook(request, envFor(), ctx);

    // The webhook still acks 200 — the deferred failure must not surface as a non-200 / redelivery.
    expect(response.status).toBe(200);
    expect(deferred).toHaveLength(1);

    // Draining the deferred promise must NOT reject (runWithSentryTag swallows-and-reports), and the
    // failure is routed to Sentry with the operation tag rather than silently dropped.
    await expect(Promise.all(deferred)).resolves.toBeDefined();
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ operation: "webhook.reconcile_review_loop_done" }) }),
    );
  });

  it("without an execution context the reconcile runs inline (awaited before the 200)", async () => {
    const reconcileSettled = vi.fn();
    mockReconcile.mockImplementation(async () => {
      await Promise.resolve();
      reconcileSettled();
    });

    const body = JSON.stringify(buildGithubCheckRunPayload());
    const request = await makeSignedGithubRequest(body, { eventType: "check_run", secret: WEBHOOK_SECRET });

    // No ctx → fall back to inline await so the sweep-backed work still runs in test/no-ctx paths.
    const response = await githubMod.handleGithubWebhook(request, envFor());

    expect(response.status).toBe(200);
    expect(reconcileSettled).toHaveBeenCalledTimes(1);
  });
});
