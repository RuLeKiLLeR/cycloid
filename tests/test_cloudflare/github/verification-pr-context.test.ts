import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTracedFetch = vi.hoisted(() => vi.fn());
const mockGetInstallationByOwner = vi.hoisted(() => vi.fn());
const mockCreateInstallationToken = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: mockTracedFetch,
}));

vi.mock("../../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...args: unknown[]) => mockGetInstallationByOwner(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
}));

import { fetchVerificationPrContext } from "../../../apps/control-plane-worker/src/github/verification-pr-context";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeEnv() {
  return {
    DB: {} as D1Database,
    REPOS_CACHE: {} as KVNamespace,
    GITHUB_APP_ID: "",
    GITHUB_PRIVATE_KEY: "",
  };
}

function checkRun(opts: {
  id: number;
  runId: number;
  name: string;
  conclusion: string;
  started: string;
  app?: string;
}) {
  return {
    id: opts.id,
    name: opts.name,
    status: "completed",
    conclusion: opts.conclusion,
    started_at: opts.started,
    completed_at: opts.started,
    // The Actions job URL is the only link from a check run back to its workflow run.
    details_url: `https://github.com/acme/widgets/actions/runs/${opts.runId}/job/${opts.id}`,
    app: { slug: opts.app ?? "github-actions" },
  };
}

function mockGithubResponses(overrides: { body?: string; commentBody?: string; commitMessage?: string } = {}) {
  mockTracedFetch.mockImplementation(async (url: string) => {
    if (url.endsWith("/pulls/123")) {
      return jsonResponse({
        html_url: "https://github.com/acme/widgets/pull/123",
        number: 123,
        title: "Fix widget auth",
        body: overrides.body ?? "Implementation details",
        state: "open",
        draft: true,
        merged: false,
        mergeable: true,
        mergeable_state: "clean",
        labels: [{ name: "enhancement" }, { name: "migration-with-code" }],
        user: { login: "octocat" },
        head: { ref: "feature/auth", sha: "abc123", repo: { name: "widgets", owner: { login: "acme" } } },
        base: { ref: "main" },
      });
    }
    if (url.includes("/pulls/123/files")) {
      return jsonResponse([{ filename: "src/auth.ts", status: "modified", additions: 12, deletions: 3 }]);
    }
    if (url.includes("/pulls/123/commits")) {
      return jsonResponse([
        {
          sha: "abc123",
          commit: { message: overrides.commitMessage ?? "Fix auth flow", author: { name: "Mona" } },
          author: { login: "octocat" },
        },
      ]);
    }
    if (url.includes("/issues/123/comments")) {
      return jsonResponse([
        {
          user: { login: "reviewer" },
          body: overrides.commentBody ?? "Please verify auth.",
          created_at: "2026-06-05T01:00:00Z",
        },
      ]);
    }
    if (url.includes("/pulls/123/reviews")) {
      return jsonResponse([{ user: { login: "reviewer" }, body: "Looks close.", created_at: "2026-06-05T02:00:00Z" }]);
    }
    if (url.includes("/commits/abc123/check-runs")) {
      return jsonResponse({ check_runs: [{ name: "typecheck", status: "completed", conclusion: "success" }] });
    }
    if (url.includes("/commits/abc123/status")) {
      return jsonResponse({ state: "success", statuses: [{ context: "ci/test", state: "success" }] });
    }
    if (url.includes("/actions/runs")) {
      return jsonResponse({ workflow_runs: [] });
    }
    throw new Error(`Unexpected URL ${url}`);
  });
}

describe("fetchVerificationPrContext", () => {
  beforeEach(() => {
    mockTracedFetch.mockReset();
    mockGetInstallationByOwner.mockReset();
    mockCreateInstallationToken.mockReset();
  });

  it("fetches authoritative PR context with head SHA and changed files", async () => {
    mockGithubResponses();

    const context = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    expect(context).toMatchObject({
      prUrl: "https://github.com/acme/widgets/pull/123",
      owner: "acme",
      repo: "widgets",
      number: 123,
      title: "Fix widget auth",
      state: "open",
      draft: true,
      headRef: "feature/auth",
      headSha: "abc123",
      headRepoOwner: "acme",
      headRepoName: "widgets",
      baseRef: "main",
      authorLogin: "octocat",
      files: [{ path: "src/auth.ts", status: "modified", additions: 12, deletions: 3 }],
      commits: [{ sha: "abc123", message: "Fix auth flow", authorLogin: "octocat" }],
    });
    expect(context.checksSummary).toContain("Check runs: success=1");
    expect(context.recentDiscussion.map((item) => item.kind)).toEqual(["review", "comment"]);
    expect(context.fetchWarnings).toEqual([
      "GitHub App credentials unavailable; fetching public PR context anonymously",
    ]);
    expect(context.mergeable).toBe(true);
    expect(context.mergeStateStatus).toBe("clean");
    expect(context.labels).toEqual(["enhancement", "migration-with-code"]);
  });

  it("extracts Vercel deploy preview evidence from GitHub check runs", async () => {
    mockTracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/pulls/123")) {
        return jsonResponse({
          html_url: "https://github.com/acme/widgets/pull/123",
          number: 123,
          title: "Fix widget auth",
          body: "Implementation details",
          state: "open",
          draft: true,
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          labels: [],
          user: { login: "octocat" },
          head: { ref: "feature/auth", sha: "abc123", repo: { name: "widgets", owner: { login: "acme" } } },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/123/files")) return jsonResponse([]);
      if (url.includes("/pulls/123/commits")) return jsonResponse([]);
      if (url.includes("/issues/123/comments")) return jsonResponse([]);
      if (url.includes("/pulls/123/reviews")) return jsonResponse([]);
      if (url.includes("/commits/abc123/check-runs")) {
        return jsonResponse({
          check_runs: [
            {
              name: "Vercel",
              status: "completed",
              conclusion: "success",
              details_url: "https://vercel.com/acme/widgets/dpl_123",
              app: { slug: "vercel" },
              output: { summary: "Visit Preview: https://widgets-git-feature-acme.vercel.app" },
            },
          ],
        });
      }
      if (url.includes("/commits/abc123/status")) return jsonResponse({ state: "success", statuses: [] });
      if (url.includes("/actions/runs")) return jsonResponse({ workflow_runs: [] });
      throw new Error(`Unexpected URL ${url}`);
    });

    const context = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    expect(context.vercelDeployPreview).toEqual({
      provider: "vercel",
      status: "ready",
      previewUrl: "https://widgets-git-feature-acme.vercel.app",
      dashboardUrl: "https://vercel.com/acme/widgets/dpl_123",
      checkName: "Vercel",
      conclusion: "success",
    });
  });

  it("uses the latest Vercel check run when an older successful attempt was superseded", async () => {
    mockTracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/pulls/123")) {
        return jsonResponse({
          html_url: "https://github.com/acme/widgets/pull/123",
          number: 123,
          title: "Fix widget auth",
          body: "Implementation details",
          state: "open",
          draft: true,
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          labels: [],
          user: { login: "octocat" },
          head: { ref: "feature/auth", sha: "abc123", repo: { name: "widgets", owner: { login: "acme" } } },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/123/files")) return jsonResponse([]);
      if (url.includes("/pulls/123/commits")) return jsonResponse([]);
      if (url.includes("/issues/123/comments")) return jsonResponse([]);
      if (url.includes("/pulls/123/reviews")) return jsonResponse([]);
      if (url.includes("/commits/abc123/check-runs")) {
        return jsonResponse({
          check_runs: [
            {
              id: 1,
              name: "Vercel",
              status: "completed",
              conclusion: "success",
              started_at: "2026-06-23T15:41:09Z",
              details_url: "https://vercel.com/acme/widgets/dpl_old",
              app: { slug: "vercel" },
              output: { summary: "Visit Preview: https://widgets-git-feature-old.vercel.app" },
            },
            {
              id: 2,
              name: "Vercel",
              status: "completed",
              conclusion: "failure",
              started_at: "2026-06-23T16:33:57Z",
              details_url: "https://vercel.com/acme/widgets/dpl_new",
              app: { slug: "vercel" },
              output: { summary: "Deployment failed." },
            },
          ],
        });
      }
      if (url.includes("/commits/abc123/status")) return jsonResponse({ state: "failure", statuses: [] });
      if (url.includes("/actions/runs")) return jsonResponse({ workflow_runs: [] });
      throw new Error(`Unexpected URL ${url}`);
    });

    const context = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    expect(context.vercelDeployPreview).toEqual({
      provider: "vercel",
      status: "error",
      previewUrl: null,
      dashboardUrl: "https://vercel.com/acme/widgets/dpl_new",
      checkName: "Vercel",
      conclusion: "failure",
    });
  });

  it("bounds large PR fields before returning context", async () => {
    mockGithubResponses({
      body: "b".repeat(5000),
      commentBody: "c".repeat(1300),
      commitMessage: "m".repeat(400),
    });

    const context = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    expect(context.body?.length).toBeLessThan(4050);
    expect(context.body).toContain("[truncated]");
    expect(context.commits[0]?.message.length).toBeLessThan(350);
    expect(context.recentDiscussion.some((item) => item.body.includes("[truncated]"))).toBe(true);
    expect(context.fetchWarnings).toEqual(
      expect.arrayContaining(["body truncated to 4000 characters.", "commits[0].message truncated to 300 characters."]),
    );
  });

  it("uses the last GitHub discussion page so recent comments are included", async () => {
    mockTracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/pulls/123")) {
        return jsonResponse({
          html_url: "https://github.com/acme/widgets/pull/123",
          number: 123,
          title: "Fix widget auth",
          body: null,
          state: "open",
          draft: false,
          merged: false,
          user: { login: "octocat" },
          head: { ref: "feature/auth", sha: "abc123", repo: { name: "widgets", owner: { login: "acme" } } },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/123/files")) return jsonResponse([]);
      if (url.includes("/pulls/123/commits")) return jsonResponse([]);
      if (url.includes("/commits/abc123/check-runs")) return jsonResponse({ check_runs: [] });
      if (url.includes("/commits/abc123/status")) return jsonResponse({ state: "success", statuses: [] });
      if (url.includes("/issues/123/comments") && !url.includes("page=3")) {
        return jsonResponse([{ user: { login: "old" }, body: "old comment", created_at: "2026-06-01T00:00:00Z" }], {
          headers: {
            "content-type": "application/json",
            link: '<https://api.github.com/repos/acme/widgets/issues/123/comments?per_page=100&page=3>; rel="last"',
          },
        });
      }
      if (url.includes("/issues/123/comments") && url.includes("page=3")) {
        return jsonResponse([{ user: { login: "new" }, body: "new comment", created_at: "2026-06-05T00:00:00Z" }]);
      }
      if (url.includes("/pulls/123/reviews")) return jsonResponse([]);
      if (url.includes("/actions/runs")) return jsonResponse({ workflow_runs: [] });
      throw new Error(`Unexpected URL ${url}`);
    });

    const context = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    expect(context.recentDiscussion).toEqual([
      { kind: "comment", authorLogin: "new", body: "new comment", createdAt: "2026-06-05T00:00:00Z" },
    ]);
    expect(mockTracedFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/widgets/issues/123/comments?per_page=100&page=3",
      expect.anything(),
      "github.verificationPrContext.comments",
    );
  });

  function mockWithDiscussionAndChecks(opts: {
    comments: Array<{ user: { login: string }; body: string; created_at: string }>;
    reviews: Array<{ user: { login: string }; body: string; created_at: string }>;
    checkRuns: Array<{ name: string; status: string; conclusion: string | null }>;
    statuses: Array<{ context: string; state: string }>;
  }) {
    mockTracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/pulls/123")) {
        return jsonResponse({
          html_url: "https://github.com/acme/widgets/pull/123",
          number: 123,
          title: "Fix widget auth",
          body: null,
          state: "open",
          draft: false,
          merged: false,
          user: { login: "octocat" },
          head: { ref: "feature/auth", sha: "abc123", repo: { name: "widgets", owner: { login: "acme" } } },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/123/files")) return jsonResponse([]);
      if (url.includes("/pulls/123/commits")) return jsonResponse([]);
      if (url.includes("/issues/123/comments")) return jsonResponse(opts.comments);
      if (url.includes("/pulls/123/reviews")) return jsonResponse(opts.reviews);
      if (url.includes("/commits/abc123/check-runs")) return jsonResponse({ check_runs: opts.checkRuns });
      if (url.includes("/commits/abc123/status")) return jsonResponse({ state: "success", statuses: opts.statuses });
      if (url.includes("/actions/runs")) return jsonResponse({ workflow_runs: [] });
      throw new Error(`Unexpected URL ${url}`);
    });
  }

  it("produces an identical checksSummary regardless of GitHub check-run / status arrival order", async () => {
    // 12 runs (> the slice(0, 10) cap) plus statuses, so order changes both the
    // rendered lines and which subset survives the slice unless sorted first.
    const checkRuns = Array.from({ length: 12 }, (_, i) => ({
      name: `check-${String(i).padStart(2, "0")}`,
      status: "completed",
      conclusion: i % 3 === 0 ? "failure" : i % 3 === 1 ? "success" : "neutral",
    }));
    const statuses = Array.from({ length: 5 }, (_, i) => ({
      context: `ci/job-${i}`,
      state: i % 2 ? "success" : "pending",
    }));

    mockWithDiscussionAndChecks({ comments: [], reviews: [], checkRuns, statuses });
    const first = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    mockWithDiscussionAndChecks({
      comments: [],
      reviews: [],
      checkRuns: [...checkRuns].reverse(),
      statuses: [...statuses].reverse(),
    });
    const second = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    expect(first.checksSummary).toEqual(second.checksSummary);
    // Counts line is sorted by state name, independent of arrival order.
    expect(first.checksSummary).toContain("Check runs: failure=4, neutral=4, success=4");
  });

  it("orders recentDiscussion deterministically when comments and reviews share a timestamp", async () => {
    const ts = "2026-06-05T00:00:00Z";
    const comments = [
      { user: { login: "zoe" }, body: "c-zoe", created_at: ts },
      { user: { login: "amy" }, body: "c-amy", created_at: ts },
    ];
    const reviews = [
      { user: { login: "bob" }, body: "r-bob", created_at: ts },
      { user: { login: "ann" }, body: "r-ann", created_at: ts },
    ];

    mockWithDiscussionAndChecks({ comments, reviews, checkRuns: [], statuses: [] });
    const first = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    mockWithDiscussionAndChecks({
      comments: [...comments].reverse(),
      reviews: [...reviews].reverse(),
      checkRuns: [],
      statuses: [],
    });
    const second = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    expect(first.recentDiscussion).toEqual(second.recentDiscussion);
    // kind asc (comment before review), then author login asc.
    expect(first.recentDiscussion).toEqual([
      { kind: "comment", authorLogin: "amy", body: "c-amy", createdAt: ts },
      { kind: "comment", authorLogin: "zoe", body: "c-zoe", createdAt: ts },
      { kind: "review", authorLogin: "ann", body: "r-ann", createdAt: ts },
      { kind: "review", authorLogin: "bob", body: "r-bob", createdAt: ts },
    ]);
  });

  it("collapses superseded check re-runs to the latest run per check (no false failure on a green rerun)", async () => {
    // Mirrors ARC-1326 / PR #5500: a gate check failed, then re-ran green after a label
    // flip. GitHub keeps BOTH runs on the SHA forever, so summarizing the raw list makes a
    // green, mergeable PR look like it still has a failing gate — a false INCONCLUSIVE.
    mockTracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/pulls/123")) {
        return jsonResponse({
          html_url: "https://github.com/acme/widgets/pull/123",
          number: 123,
          title: "Migration + code",
          body: null,
          state: "open",
          draft: false,
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          user: { login: "octocat" },
          head: { ref: "feature/auth", sha: "abc123", repo: { name: "widgets", owner: { login: "acme" } } },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/123/files")) return jsonResponse([]);
      if (url.includes("/pulls/123/commits")) return jsonResponse([]);
      if (url.includes("/issues/123/comments")) return jsonResponse([]);
      if (url.includes("/pulls/123/reviews")) return jsonResponse([]);
      if (url.includes("/commits/abc123/check-runs")) {
        // Three runs of the SAME workflow's "check" job (workflow 100), each a separate
        // workflow run (distinct run ids), plus one unrelated "lint" check (workflow 999).
        return jsonResponse({
          check_runs: [
            // Superseded failed run (before the label) — must be dropped.
            checkRun({ id: 1, runId: 101, name: "check", conclusion: "failure", started: "2026-06-23T15:41:09Z" }),
            // A cancelled rerun — also superseded.
            checkRun({ id: 2, runId: 102, name: "check", conclusion: "cancelled", started: "2026-06-23T16:23:26Z" }),
            // Latest run for "check": green.
            checkRun({ id: 3, runId: 103, name: "check", conclusion: "success", started: "2026-06-23T16:33:57Z" }),
            // An unrelated check with a single run.
            checkRun({ id: 4, runId: 200, name: "lint", conclusion: "success", started: "2026-06-23T15:41:00Z" }),
          ],
        });
      }
      if (url.includes("/commits/abc123/status")) return jsonResponse({ state: "success", statuses: [] });
      if (url.includes("/actions/runs")) {
        // The three "check" runs all belong to workflow 100; "lint" to workflow 999.
        return jsonResponse({
          workflow_runs: [
            { id: 101, workflow_id: 100 },
            { id: 102, workflow_id: 100 },
            { id: 103, workflow_id: 100 },
            { id: 200, workflow_id: 999 },
          ],
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const context = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    // Only the latest run per check survives: check=success (not failure), lint=success.
    expect(context.checksSummary).toContain("Check runs: success=2");
    expect(context.checksSummary).not.toContain("failure");
    expect(context.checksSummary).not.toContain("cancelled");
    expect(context.checksSummary).toContain("- check: success");
    expect(context.mergeStateStatus).toBe("clean");
  });

  it("keeps distinct checks that share a job name across workflows (does not hide a real failure)", async () => {
    // Two independent workflows both emit a "Validate" job from github-actions. Keying dedup
    // on (name, app) alone would collapse them and could hide a genuine failure (ARC-1326 / Codex P2).
    mockTracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/pulls/123")) {
        return jsonResponse({
          html_url: "https://github.com/acme/widgets/pull/123",
          number: 123,
          title: "Two Validate jobs",
          body: null,
          state: "open",
          draft: false,
          merged: false,
          user: { login: "octocat" },
          head: { ref: "feature/auth", sha: "abc123", repo: { name: "widgets", owner: { login: "acme" } } },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/123/files")) return jsonResponse([]);
      if (url.includes("/pulls/123/commits")) return jsonResponse([]);
      if (url.includes("/issues/123/comments")) return jsonResponse([]);
      if (url.includes("/pulls/123/reviews")) return jsonResponse([]);
      if (url.includes("/commits/abc123/check-runs")) {
        return jsonResponse({
          check_runs: [
            // Validate from workflow 300 — failed.
            checkRun({ id: 10, runId: 301, name: "Validate", conclusion: "failure", started: "2026-06-23T16:00:00Z" }),
            // Validate from workflow 400 — succeeded, started later.
            checkRun({ id: 11, runId: 401, name: "Validate", conclusion: "success", started: "2026-06-23T16:05:00Z" }),
          ],
        });
      }
      if (url.includes("/commits/abc123/status")) return jsonResponse({ state: "failure", statuses: [] });
      if (url.includes("/actions/runs")) {
        return jsonResponse({
          workflow_runs: [
            { id: 301, workflow_id: 300 },
            { id: 401, workflow_id: 400 },
          ],
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const context = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    // Both Validate checks are distinct workflows, so neither is dropped — the failure stays visible.
    expect(context.checksSummary).toContain("Check runs: failure=1, success=1");
    expect(context.checksSummary).toContain("- Validate: failure");
    expect(context.checksSummary).toContain("- Validate: success");
  });

  it("defaults labels to empty and mergeable fields to null when GitHub omits them", async () => {
    mockTracedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/pulls/123")) {
        return jsonResponse({
          html_url: "https://github.com/acme/widgets/pull/123",
          number: 123,
          title: "No merge info yet",
          body: null,
          state: "open",
          draft: false,
          merged: false,
          // mergeable / mergeable_state / labels intentionally omitted (GitHub still computing).
          user: { login: "octocat" },
          head: { ref: "feature/auth", sha: "abc123", repo: { name: "widgets", owner: { login: "acme" } } },
          base: { ref: "main" },
        });
      }
      if (url.includes("/pulls/123/files")) return jsonResponse([]);
      if (url.includes("/pulls/123/commits")) return jsonResponse([]);
      if (url.includes("/issues/123/comments")) return jsonResponse([]);
      if (url.includes("/pulls/123/reviews")) return jsonResponse([]);
      if (url.includes("/commits/abc123/check-runs")) return jsonResponse({ check_runs: [] });
      if (url.includes("/commits/abc123/status")) return jsonResponse({ state: "success", statuses: [] });
      if (url.includes("/actions/runs")) return jsonResponse({ workflow_runs: [] });
      throw new Error(`Unexpected URL ${url}`);
    });

    const context = await fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123");

    expect(context.labels).toEqual([]);
    expect(context.mergeable).toBeNull();
    expect(context.mergeStateStatus).toBeNull();
  });

  it("rejects strict PR context fetches when the target does not match the authorized repo hint", async () => {
    await expect(
      fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123", {
        installationId: 123,
        repoOwner: "other-owner",
        repoName: "other-repo",
        requireRepoMatch: true,
      }),
    ).rejects.toThrow("Verification target PR repository does not match authorized session repository");

    expect(mockTracedFetch).not.toHaveBeenCalled();
  });

  it("fails closed without an anonymous fetch when auth-required GitHub App credentials are missing", async () => {
    mockGithubResponses();

    await expect(
      fetchVerificationPrContext(makeEnv(), "https://github.com/acme/widgets/pull/123", {
        installationId: 123,
        repoOwner: "acme",
        repoName: "widgets",
        requireRepoMatch: true,
      }),
    ).rejects.toThrow("GitHub App credentials are required");

    expect(mockTracedFetch).not.toHaveBeenCalled();
  });

  it("fails closed without an anonymous fetch when an auth-required installation is unavailable", async () => {
    mockGithubResponses();
    mockGetInstallationByOwner.mockResolvedValue(null);

    await expect(
      fetchVerificationPrContext(
        { ...makeEnv(), GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "key" },
        "https://github.com/acme/widgets/pull/123",
        {
          repoOwner: "acme",
          repoName: "widgets",
          requireRepoMatch: true,
        },
      ),
    ).rejects.toThrow("GitHub App installation is unavailable");

    expect(mockTracedFetch).not.toHaveBeenCalled();
  });
});
