import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildGithubPullRequestPayload, makeSignedGithubRequest } from "./github-webhook-fixtures";

// ---------------------------------------------------------------------------
// ARC-895: pull_request `closed` outcome reconciliation must be durable.
//
// Reconciliation runs on the acknowledged path. When the outcome write throws,
// the handler releases the idempotency claim and returns a retryable 5xx so
// GitHub redelivers, instead of swallowing the failure under a committed claim
// (which previously left pr_outcome NULL forever and kept closed PRs eligible
// as "similar sessions"). Driven end-to-end against the real handleGithubWebhook.
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

const mockCloseSessionForWebhook = vi.fn();
const mockNotifySessionPrMerged = vi.fn();
const mockNotifySessionPrClosed = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: vi.fn(),
  updateSessionReviewListeningHead: vi.fn(),
  closeSessionForWebhook: (...args: unknown[]) => mockCloseSessionForWebhook(...args),
  notifySessionPrMerged: (...args: unknown[]) => mockNotifySessionPrMerged(...args),
  notifySessionPrClosed: (...args: unknown[]) => mockNotifySessionPrClosed(...args),
  createSessionState: vi.fn(),
  enqueueSessionPrompt: vi.fn(),
}));

const mockCreateInstallationToken = vi.fn();

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  createScopedInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

const mockGetPrReviewComments = vi.fn();
const mockGetPrCommitShas = vi.fn();
const mockGetCommitCiStatus = vi.fn();

vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  FAILING_CHECK_RUN_CONCLUSIONS: new Set(["failure", "timed_out", "cancelled"]),
  getPrReviewComments: (...args: unknown[]) => mockGetPrReviewComments(...args),
  getPrCommitShas: (...args: unknown[]) => mockGetPrCommitShas(...args),
  getCommitCiStatus: (...args: unknown[]) => mockGetCommitCiStatus(...args),
  getPullRequestsForCommit: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/memory/db", () => ({
  createMemoryAnalysisJob: vi.fn().mockResolvedValue(null),
  updateMemoryPrOutcome: vi.fn().mockResolvedValue(false),
}));

const WEBHOOK_SECRET = "test-webhook-secret";
const PR_URL = "https://github.com/org/repo/pull/42";

type CompletionRecord = {
  session_id: string;
  prompt_id: string;
  pr_url: string | null;
  pr_draft: number | null;
  pr_outcome: string | null;
  pr_outcome_at: number | null;
  first_pass_passed: number | null;
  review_thread_count: number | null;
  followup_commit_count: number | null;
  ci_first_run_status: string | null;
  commit_sha: string | null;
  success: number;
};

function makeRecord(overrides: Partial<CompletionRecord> = {}): CompletionRecord {
  return {
    session_id: "sess-1",
    prompt_id: "p-1",
    pr_url: null,
    pr_draft: null,
    pr_outcome: null,
    pr_outcome_at: null,
    first_pass_passed: null,
    review_thread_count: null,
    followup_commit_count: null,
    ci_first_run_status: null,
    commit_sha: "sha-1",
    success: 1,
    ...overrides,
  };
}

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
      this.db.released.push(key);
      return { success: true, meta: { changes: 1 } };
    }
    // Outcome write: SET pr_outcome = ? ... WHERE session_id = ? AND prompt_id = ?
    if (this.query.includes("SET pr_outcome = ?")) {
      if (this.db.failOutcomeWrite) throw new Error("Simulated transient outcome write failure");
      const [prOutcome, prOutcomeAt, firstPass, reviewCount, followup, ciStatus, sessionId, promptId] = this
        .boundValues as [string, number, number, number | null, number | null, string | null, string, string];
      let changes = 0;
      for (const row of this.db.completions) {
        if (row.session_id === sessionId && row.prompt_id === promptId) {
          row.pr_outcome = prOutcome;
          row.pr_outcome_at = prOutcomeAt;
          row.first_pass_passed = firstPass;
          row.review_thread_count = reviewCount;
          row.followup_commit_count = followup;
          row.ci_first_run_status = ciStatus;
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    return { success: true, meta: { changes: 0 } };
  }
  async first(): Promise<Record<string, unknown> | null> {
    return null;
  }
  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (this.query.includes("FROM session_webhook_refs")) {
      return { results: this.db.sessionRefs.map((id) => ({ session_id: id, external_ref: PR_URL })) };
    }
    // findCompletionsForSessionsPr: session_id IN (...) AND pr_url = ? AND success = 1
    if (this.query.includes("FROM session_completions") && this.query.includes("pr_url = ?")) {
      const prUrl = this.boundValues[this.boundValues.length - 1] as string;
      const sessionIds = this.boundValues.slice(0, -1) as string[];
      const results = this.db.completions.filter(
        (row) => sessionIds.includes(row.session_id) && row.pr_url === prUrl && row.success === 1,
      );
      return { results: results as unknown as Array<Record<string, unknown>> };
    }
    return { results: [] };
  }
}

class FakeD1 {
  readonly idempotency = new Set<string>();
  readonly released: string[] = [];
  sessionRefs: string[] = [];
  completions: CompletionRecord[] = [];
  failOutcomeWrite = false;
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
  mockCloseSessionForWebhook.mockReset().mockResolvedValue({ closed: true });
  mockNotifySessionPrMerged.mockReset().mockResolvedValue({ ok: true, status: 200, payload: { notified: true } });
  mockNotifySessionPrClosed.mockReset().mockResolvedValue({ ok: true, status: 200, payload: { notified: true } });
  mockCreateInstallationToken.mockReset().mockResolvedValue("ghs_install_token");
  mockGetPrReviewComments.mockReset().mockResolvedValue([]);
  mockGetPrCommitShas.mockReset().mockResolvedValue([]);
  mockGetCommitCiStatus.mockReset().mockResolvedValue("success");
  fakeDb = new FakeD1();
  githubMod = (await import("../../apps/control-plane-worker/src/webhooks/github")) as unknown as GithubWebhookModule;
});

function envFor(): unknown {
  return { GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: fakeDb, SESSION: {} };
}

function closedPrBody(
  overrides: Record<string, unknown> = {},
  sender?: { login: string; id?: number; type?: string },
): string {
  return JSON.stringify(
    buildGithubPullRequestPayload({
      action: "closed",
      installation: { id: 99999 },
      ...(sender ? { sender: { id: 1, type: "User", ...sender } } : {}),
      pull_request: {
        html_url: PR_URL,
        number: 42,
        merged: false,
        draft: false,
        head: { sha: "abc123" },
        base: { repo: { owner: { login: "org" }, name: "repo" } },
        ...overrides,
      },
    }),
  );
}

describe("pull_request closed outcome reconciliation (ARC-895)", () => {
  it("records the closed outcome for the matching completion", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    fakeDb.completions = [makeRecord({ session_id: "sess-1", prompt_id: "p-1", pr_url: PR_URL })];

    const request = await makeSignedGithubRequest(closedPrBody(), {
      eventType: "pull_request",
      secret: WEBHOOK_SECRET,
    });
    const response = await githubMod.handleGithubWebhook(request, envFor());

    expect(response.status).toBe(200);
    expect(fakeDb.completions[0].pr_outcome).toBe("closed");
  });

  it("posts the PR-closed Slack notice naming the closer when an unmerged close archives the session", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    fakeDb.completions = [makeRecord({ session_id: "sess-1", prompt_id: "p-1", pr_url: PR_URL })];
    mockCloseSessionForWebhook.mockResolvedValue({ closed: true });

    const request = await makeSignedGithubRequest(closedPrBody({}, { login: "vrn21-arcanist" }), {
      eventType: "pull_request",
      secret: WEBHOOK_SECRET,
    });
    const response = await githubMod.handleGithubWebhook(request, envFor());

    expect(response.status).toBe(200);
    expect(mockNotifySessionPrClosed).toHaveBeenCalledTimes(1);
    // (env, sessionId, prUrl, closedByLogin)
    expect(mockNotifySessionPrClosed.mock.calls[0].slice(1)).toEqual(["sess-1", PR_URL, "vrn21-arcanist"]);
    // Merged notice must not fire for an unmerged close.
    expect(mockNotifySessionPrMerged).not.toHaveBeenCalled();
  });

  it("does not post the PR-closed notice when the close did not archive the session (already archived / redelivery)", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    fakeDb.completions = [makeRecord({ session_id: "sess-1", prompt_id: "p-1", pr_url: PR_URL })];
    // Session was already archived by an earlier delivery.
    mockCloseSessionForWebhook.mockResolvedValue({ closed: false });

    const request = await makeSignedGithubRequest(closedPrBody({}, { login: "vrn21-arcanist" }), {
      eventType: "pull_request",
      secret: WEBHOOK_SECRET,
    });
    const response = await githubMod.handleGithubWebhook(request, envFor());

    expect(response.status).toBe(200);
    expect(mockNotifySessionPrClosed).not.toHaveBeenCalled();
  });

  it("does not post the PR-closed notice when the PR was merged (merged has its own card)", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    fakeDb.completions = [makeRecord({ session_id: "sess-1", prompt_id: "p-1", pr_url: PR_URL })];
    mockCloseSessionForWebhook.mockResolvedValue({ closed: true });

    const request = await makeSignedGithubRequest(closedPrBody({ merged: true }, { login: "vrn21-arcanist" }), {
      eventType: "pull_request",
      secret: WEBHOOK_SECRET,
    });
    const response = await githubMod.handleGithubWebhook(request, envFor());

    expect(response.status).toBe(200);
    expect(mockNotifySessionPrClosed).not.toHaveBeenCalled();
    expect(mockNotifySessionPrMerged).toHaveBeenCalledTimes(1);
  });

  it("falls back to the PR's first commit for CI status when the completion has no commit_sha", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    fakeDb.completions = [makeRecord({ session_id: "sess-1", prompt_id: "p-1", pr_url: PR_URL, commit_sha: null })];
    mockGetPrCommitShas.mockResolvedValue(["first-sha", "second-sha"]);
    mockGetCommitCiStatus.mockResolvedValue("success");

    const request = await makeSignedGithubRequest(closedPrBody(), {
      eventType: "pull_request",
      secret: WEBHOOK_SECRET,
    });
    const response = await githubMod.handleGithubWebhook(request, envFor());

    expect(response.status).toBe(200);
    expect(mockGetCommitCiStatus).toHaveBeenCalledWith("ghs_install_token", "org", "repo", "first-sha");
    expect(fakeDb.completions[0].ci_first_run_status).toBe("success");
    // First-commit anchor: one commit landed after the first push.
    expect(fakeDb.completions[0].followup_commit_count).toBe(1);
  });

  it("still records unknown CI status when the completion has no commit_sha and the PR has no commits", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    fakeDb.completions = [makeRecord({ session_id: "sess-1", prompt_id: "p-1", pr_url: PR_URL, commit_sha: null })];
    mockGetPrCommitShas.mockResolvedValue([]);

    const request = await makeSignedGithubRequest(closedPrBody(), {
      eventType: "pull_request",
      secret: WEBHOOK_SECRET,
    });
    const response = await githubMod.handleGithubWebhook(request, envFor());

    expect(response.status).toBe(200);
    expect(mockGetCommitCiStatus).not.toHaveBeenCalled();
    expect(fakeDb.completions[0].ci_first_run_status).toBe("unknown");
  });

  it("records the outcome and closes the session when the installation token cannot be created (no 500)", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    fakeDb.completions = [makeRecord({ session_id: "sess-1", prompt_id: "p-1", pr_url: PR_URL })];
    // A suspended/removed installation makes token creation throw persistently.
    mockCreateInstallationToken.mockRejectedValue(new Error("installation suspended"));

    const request = await makeSignedGithubRequest(closedPrBody(), {
      eventType: "pull_request",
      secret: WEBHOOK_SECRET,
    });
    const response = await githubMod.handleGithubWebhook(request, envFor());

    // Enrichment is best-effort: a token failure must not 500 (which would block
    // session close and make GitHub redeliver the same failing event forever).
    expect(response.status).toBe(200);
    expect(fakeDb.completions[0].pr_outcome).toBe("closed");
    // Degraded enrichment: recorded with unknown CI status and null review count.
    expect(fakeDb.completions[0].ci_first_run_status).toBe("unknown");
    expect(fakeDb.completions[0].review_thread_count).toBeNull();
    // The notify/close loop still ran.
    expect(mockCloseSessionForWebhook).toHaveBeenCalled();
    // No enrichment fetches were attempted without a token.
    expect(mockGetPrReviewComments).not.toHaveBeenCalled();
    expect(mockGetPrCommitShas).not.toHaveBeenCalled();
  });

  it("releases the claim and returns 500 when the outcome write fails, so GitHub redelivers", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    fakeDb.completions = [makeRecord({ session_id: "sess-1", prompt_id: "p-1", pr_url: PR_URL })];
    fakeDb.failOutcomeWrite = true;

    const request = await makeSignedGithubRequest(closedPrBody(), {
      eventType: "pull_request",
      secret: WEBHOOK_SECRET,
    });
    const response = await githubMod.handleGithubWebhook(request, envFor());

    // Retryable 5xx surfaced and the claim was released so the redelivery is not deduped.
    expect(response.status).toBe(500);
    expect(fakeDb.released.length).toBeGreaterThan(0);
    expect(fakeDb.idempotency.size).toBe(0);
    // The notify/close loop did not run on the failed delivery (it runs after reconciliation).
    expect(mockCloseSessionForWebhook).not.toHaveBeenCalled();
  });

  it("re-records on redelivery after a transient failure (idempotent retry)", async () => {
    fakeDb.sessionRefs = ["sess-1"];
    fakeDb.completions = [makeRecord({ session_id: "sess-1", prompt_id: "p-1", pr_url: PR_URL })];
    fakeDb.failOutcomeWrite = true;

    const body = closedPrBody();
    const firstReq = await makeSignedGithubRequest(body, {
      eventType: "pull_request",
      secret: WEBHOOK_SECRET,
      deliveryId: "delivery-retry",
    });
    const firstResp = await githubMod.handleGithubWebhook(firstReq, envFor());
    expect(firstResp.status).toBe(500);

    // Redelivery (same delivery id + payload): claim was released, so it re-enters reconciliation.
    fakeDb.failOutcomeWrite = false;
    const secondReq = await makeSignedGithubRequest(body, {
      eventType: "pull_request",
      secret: WEBHOOK_SECRET,
      deliveryId: "delivery-retry",
    });
    const secondResp = await githubMod.handleGithubWebhook(secondReq, envFor());

    expect(secondResp.status).toBe(200);
    expect(fakeDb.completions[0].pr_outcome).toBe("closed");
  });
});
