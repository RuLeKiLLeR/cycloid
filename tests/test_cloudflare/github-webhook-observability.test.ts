import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildGithubCheckRunPayload,
  buildGithubCommitStatusPayload,
  makeSignedGithubRequest,
} from "./github-webhook-fixtures";

// ---------------------------------------------------------------------------
// PR1 webhook-pipeline observability: every currently-silent skip/failure path
// in the GitHub webhook handler must emit a direct-posted Datadog structured
// event (control-plane app logs do not reach Datadog: logpush=false). These
// drive the real handleGithubWebhook with the review-loop services mocked and
// assert the @event names + bounded reason codes that back the follow-up
// Terraform metrics.
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

const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: vi.fn().mockResolvedValue(null),
  updateSessionReviewListeningHead: vi.fn(),
  closeSessionForWebhook: vi.fn(),
  notifySessionPrMerged: vi.fn(),
  createSessionState: vi.fn(),
  enqueueSessionPrompt: vi.fn(),
}));

const mockIngestCheckRun = vi.fn();
const mockIngestCommitStatus = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/review-loop-epochs", () => ({
  markReviewLoopEpochsStaleForHeadChange: vi.fn(),
  carryForwardReviewLoopEpochsToNewHead: vi.fn(),
  ingestReviewLoopCheckRunWebhook: (...args: unknown[]) => mockIngestCheckRun(...args),
  ingestReviewLoopCiFailureWebhook: vi.fn().mockResolvedValue({ status: "ignored", reason: "noop" }),
  ingestReviewLoopCommitStatusWebhook: (...args: unknown[]) => mockIngestCommitStatus(...args),
  ingestReviewLoopPrIssueCommentWebhook: vi.fn(),
  ingestReviewLoopPullRequestReviewCommentWebhook: vi.fn(),
  ingestReviewLoopPullRequestReviewWebhook: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/services/review-loop-ci-signal", () => ({
  emitReviewLoopCiSignalFromWebhook: vi.fn().mockResolvedValue(undefined),
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
      if (this.db.failReleaseForKeys.some((suffix) => key.endsWith(suffix))) {
        throw new Error(`Simulated transient DB failure releasing claim ${key}`);
      }
      this.db.idempotency.delete(key);
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
  async first(): Promise<Record<string, unknown> | null> {
    return null;
  }
  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    return { results: [] };
  }
}

class FakeD1 {
  readonly idempotency = new Set<string>();
  // An empty-string suffix matches every key (`endsWith("")`), so [""] fails ALL releases.
  failReleaseForKeys: string[] = [];
  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
}

type GithubWebhookModule = {
  handleGithubWebhook: (request: Request, env: unknown, ctx?: unknown) => Promise<Response>;
};

let githubMod: GithubWebhookModule;
let fakeDb: FakeD1;
let waitUntilPromises: Promise<unknown>[];

function envFor(): unknown {
  return { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };
}

function ctxFor(): unknown {
  return {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
  };
}

function emittedEvents(): Record<string, unknown>[] {
  return mockPostStructuredEventToDd.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

beforeEach(async () => {
  vi.resetModules();
  waitUntilPromises = [];
  fakeDb = new FakeD1();
  mockPostStructuredEventToDd.mockClear().mockResolvedValue(true);
  mockIngestCheckRun.mockReset().mockResolvedValue({ status: "ignored", reason: "noop" });
  mockIngestCommitStatus.mockReset().mockResolvedValue({ status: "ignored", reason: "noop" });
  mockGetPullRequestsForCommit.mockReset().mockResolvedValue([]);
  githubMod = (await import("../../apps/control-plane-worker/src/webhooks/github")) as unknown as GithubWebhookModule;
});

describe("W1: whole-delivery idempotency skip emits webhook.idempotency_skipped", () => {
  it("emits a duplicate event on the second delivery of the same payload", async () => {
    mockGetPullRequestsForCommit.mockResolvedValue([{ number: 42, headSha: "head-sha", htmlUrl: null }]);
    const body = JSON.stringify(buildGithubCommitStatusPayload());
    const deliveryId = "delivery-dup-1";

    const first = await githubMod.handleGithubWebhook(
      await makeSignedGithubRequest(body, { eventType: "status", secret: WEBHOOK_SECRET, deliveryId }),
      envFor(),
      ctxFor(),
    );
    expect(first.status).toBe(200);

    const second = await githubMod.handleGithubWebhook(
      await makeSignedGithubRequest(body, { eventType: "status", secret: WEBHOOK_SECRET, deliveryId }),
      envFor(),
      ctxFor(),
    );
    const json = (await second.json()) as Record<string, unknown>;

    expect(json.reason).toBe("duplicate");
    expect(emittedEvents()).toContainEqual(
      expect.objectContaining({
        event: "webhook.idempotency_skipped",
        webhook_source: "github",
        reason_code: "duplicate",
        delivery_id: deliveryId,
      }),
    );
  });
});

describe("W3: commit lookup empty emits webhook.commit_lookup_empty", () => {
  it("emits on a status delivery whose commit has no associated PR", async () => {
    mockGetPullRequestsForCommit.mockResolvedValue([]);
    const body = JSON.stringify(buildGithubCommitStatusPayload({ sha: "orphan-sha" }));
    const request = await makeSignedGithubRequest(body, { eventType: "status", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor(), ctxFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(json.reason).toBe("no_pull_requests");
    expect(emittedEvents()).toContainEqual(
      expect.objectContaining({
        event: "webhook.commit_lookup_empty",
        webhook_source: "github",
        status_sha: "orphan-sha",
        repo_owner: "acme",
        repo_name: "repo",
      }),
    );
  });

  it("emits on a check_run delivery carrying no pull_requests", async () => {
    const body = JSON.stringify(
      buildGithubCheckRunPayload({
        check_run: {
          id: 9500,
          name: "cursor bugbot",
          status: "completed",
          conclusion: "success",
          head_sha: "cr-head-sha",
          app: { slug: "cursor", name: "Cursor" },
          pull_requests: [],
        },
      }),
    );
    const request = await makeSignedGithubRequest(body, { eventType: "check_run", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor(), ctxFor());
    const json = (await response.json()) as Record<string, unknown>;

    expect(json.reason).toBe("no_pull_requests");
    expect(emittedEvents()).toContainEqual(
      expect.objectContaining({
        event: "webhook.commit_lookup_empty",
        webhook_source: "github",
        status_sha: "cr-head-sha",
        repo_owner: "acme",
        repo_name: "repo",
      }),
    );
  });
});

describe("W2: claim-release failure emits webhook.claim_release_failed", () => {
  it("emits for both the per-PR and whole-delivery release when a status ingest fails and releases throw", async () => {
    mockGetPullRequestsForCommit.mockResolvedValue([{ number: 42, headSha: "head-sha", htmlUrl: null }]);
    mockIngestCommitStatus.mockRejectedValue(new Error("Session DO lookup failed with status 503"));
    fakeDb.failReleaseForKeys = [""]; // fail every release so both sites are exercised

    const body = JSON.stringify(buildGithubCommitStatusPayload());
    const request = await makeSignedGithubRequest(body, { eventType: "status", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor(), ctxFor());
    expect(response.status).toBe(500);

    const claimFailures = emittedEvents().filter((e) => e.event === "webhook.claim_release_failed");
    // Per-PR release failure carries the PR number.
    expect(claimFailures).toContainEqual(
      expect.objectContaining({
        event: "webhook.claim_release_failed",
        webhook_source: "github",
        pr_number: 42,
      }),
    );
    // Whole-delivery partial-failure release failure carries the status context.
    expect(claimFailures).toContainEqual(
      expect.objectContaining({
        event: "webhook.claim_release_failed",
        webhook_source: "github",
        context: "status_partial_failure",
      }),
    );
  });

  it("emits for both the per-PR and whole-delivery release when a check_run ingest fails and releases throw", async () => {
    mockIngestCheckRun.mockRejectedValue(new Error("Session DO lookup failed with status 503"));
    fakeDb.failReleaseForKeys = [""];

    const body = JSON.stringify(buildGithubCheckRunPayload());
    const request = await makeSignedGithubRequest(body, { eventType: "check_run", secret: WEBHOOK_SECRET });

    const response = await githubMod.handleGithubWebhook(request, envFor(), ctxFor());
    expect(response.status).toBe(500);

    const claimFailures = emittedEvents().filter((e) => e.event === "webhook.claim_release_failed");
    expect(claimFailures).toContainEqual(
      expect.objectContaining({ event: "webhook.claim_release_failed", webhook_source: "github", pr_number: 42 }),
    );
    expect(claimFailures).toContainEqual(
      expect.objectContaining({
        event: "webhook.claim_release_failed",
        webhook_source: "github",
        context: "check_run_partial_failure",
      }),
    );
  });
});
