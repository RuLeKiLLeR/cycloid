import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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

type MockFetchResponse = { ok: boolean; status: number; body: unknown; jsonError?: Error };

let mockFetchResponse: MockFetchResponse = {
  ok: true,
  status: 201,
  body: { id: 12345 },
};
let mockFetchResponses: MockFetchResponse[] = [];
let mockFetchError: Error | null = null;
let lastFetchOptions: { method?: string; headers?: Record<string, string>; body?: string } | null = null;
let fetchUrls: string[] = [];

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: async (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    lastFetchOptions = options ?? null;
    fetchUrls.push(url);
    if (mockFetchError) throw mockFetchError;
    const response = mockFetchResponses.length > 0 ? mockFetchResponses.shift()! : mockFetchResponse;
    return {
      ok: response.ok,
      status: response.status,
      json: async () => {
        if (response.jsonError) throw response.jsonError;
        return response.body;
      },
      text: async () => JSON.stringify(response.body),
    };
  },
  tracedEnv: (env: unknown) => env,
}));

type PrModule = {
  getCommitCheckRuns: (
    token: string,
    owner: string,
    repo: string,
    sha: string,
  ) => Promise<
    Array<{
      id: number;
      name: string | null;
      status: string;
      conclusion: string | null;
      appSlug: string | null;
      appName: string | null;
      detailsUrl: string | null;
      outputTitle: string | null;
      outputSummary: string | null;
      outputText: string | null;
    }>
  >;
  createPullRequest: (params: {
    token: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body?: string;
    draft?: boolean;
  }) => Promise<{ prUrl: string; prNumber: number; branchName: string; created: boolean; actualDraft?: boolean }>;
  createPullRequestReview: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
    input: {
      commitId: string;
      body: string;
      event: "COMMENT";
      comments: Array<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }>;
    },
  ) => Promise<{ id: number; htmlUrl: string }>;
  createPrReviewCommentReply: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string,
  ) => Promise<{ id: number; htmlUrl: string }>;
  createPrIssueComment: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ) => Promise<{ id: number; htmlUrl: string }>;
  getPrState: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<"open" | "closed" | "merged" | null>;
  getPrHeadSha: (token: string, owner: string, repo: string, prNumber: number) => Promise<string | null>;
  getPrReviewComments: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<
    Array<{
      id: number | null;
      reviewId: number | null;
      path: string;
      line: number | null;
      body: string;
      author: string;
      inReplyToId: number | null;
    }>
  >;
  getPrCommitShas: (token: string, owner: string, repo: string, prNumber: number) => Promise<string[]>;
  getCommitCiStatus: (
    token: string,
    owner: string,
    repo: string,
    sha: string,
  ) => Promise<"success" | "failed" | "pending" | "unknown">;
  getCommitStatusContexts: (
    token: string,
    owner: string,
    repo: string,
    sha: string,
  ) => Promise<
    Array<{
      id: number;
      context: string | null;
      state: string;
      description: string | null;
      targetUrl: string | null;
      creatorLogin: string | null;
      creatorType: string | null;
    }>
  >;
  isRepoPrivate: (token: string, owner: string, repo: string) => Promise<boolean>;
  findOpenPrByHead: (
    token: string,
    owner: string,
    repo: string,
    head: string,
    dedupMarker?: string,
  ) => Promise<{ prUrl: string; prNumber: number; branchName: string; matchedMarker?: boolean } | null>;
  getPrDraftState: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<{ nodeId: string; isDraft: boolean } | null>;
  markPullRequestReadyForReview: (token: string, nodeId: string) => Promise<void>;
  parsePrMergeableState: (raw: unknown) => string;
  getPrMergeStatus: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<{
    state: "open" | "closed" | "merged" | null;
    headSha: string | null;
    mergeable: boolean | null;
    mergeableState: string;
    rawMergeableState: string | null;
  }>;
  updatePullRequestBranch: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
    expectedHeadSha: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string; status: number; detail: string }>;
  dedupeLatestCheckRunsByName: <T extends { id: number; name: string | null }>(runs: T[]) => T[];
  getCommitTreeSha: (token: string, owner: string, repo: string, sha: string) => Promise<string | null>;
  isNoOpHeadTreeChange: (
    token: string,
    owner: string,
    repo: string,
    previousHeadSha: string,
    newHeadSha: string,
  ) => Promise<boolean>;
};

describe("github/pr", () => {
  let mod: PrModule;

  afterEach(() => {
    mockFetchResponse = { ok: true, status: 201, body: { id: 12345 } };
    mockFetchResponses = [];
    mockFetchError = null;
    lastFetchOptions = null;
    fetchUrls = [];
  });

  beforeAll(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/github/pr";
    mod = (await import(modulePath)) as unknown as PrModule;
  });

  describe("review-loop comment replies", () => {
    it("creates inline review comment replies", async () => {
      mockFetchResponse = {
        ok: true,
        status: 201,
        body: { id: 987, html_url: "https://github.com/org/repo/pull/42#discussion_r987" },
      };

      const result = await mod.createPrReviewCommentReply("ghp_test", "org", "repo", 42, 10, "Fixed.");

      expect(fetchUrls).toEqual(["https://api.github.com/repos/org/repo/pulls/42/comments/10/replies"]);
      expect(lastFetchOptions?.method).toBe("POST");
      expect(JSON.parse(lastFetchOptions?.body ?? "{}")).toEqual({ body: "Fixed." });
      expect(result).toEqual({ id: 987, htmlUrl: "https://github.com/org/repo/pull/42#discussion_r987" });
    });

    it("creates top-level PR issue comments for issue-comment replies", async () => {
      mockFetchResponse = {
        ok: true,
        status: 201,
        body: { id: 654, html_url: "https://github.com/org/repo/pull/42#issuecomment-654" },
      };

      const result = await mod.createPrIssueComment("ghp_test", "org", "repo", 42, "Fixed.");

      expect(fetchUrls).toEqual(["https://api.github.com/repos/org/repo/issues/42/comments"]);
      expect(lastFetchOptions?.method).toBe("POST");
      expect(JSON.parse(lastFetchOptions?.body ?? "{}")).toEqual({ body: "Fixed." });
      expect(result).toEqual({ id: 654, htmlUrl: "https://github.com/org/repo/pull/42#issuecomment-654" });
    });
  });

  describe("createPullRequest", () => {
    it("creates PR ready for review", async () => {
      mockFetchResponse = {
        ok: true,
        status: 201,
        body: { html_url: "https://github.com/org/repo/pull/1", number: 1 },
      };
      const result = await mod.createPullRequest({
        token: "ghp_test",
        owner: "org",
        repo: "repo",
        head: "feature-branch",
        base: "main",
        title: "Test PR",
        body: "Test body",
      });

      expect(result).toEqual({
        prUrl: "https://github.com/org/repo/pull/1",
        prNumber: 1,
        branchName: "feature-branch",
        created: true,
      });

      const sentBody = JSON.parse(lastFetchOptions!.body!);
      expect(sentBody.draft).toBe(false);
    });

    it("sends draft: false when draft is not requested", async () => {
      mockFetchResponse = {
        ok: true,
        status: 201,
        body: { html_url: "https://github.com/org/repo/pull/2", number: 2 },
      };
      await mod.createPullRequest({
        token: "ghp_test",
        owner: "org",
        repo: "repo",
        head: "another-branch",
        base: "main",
        title: "Another PR",
      });

      const sentBody = JSON.parse(lastFetchOptions!.body!);
      expect(sentBody).toMatchObject({
        title: "Another PR",
        body: "",
        head: "another-branch",
        base: "main",
        draft: false,
      });
    });

    it("throws on non-recoverable create errors without looking up the branch PR", async () => {
      mockFetchResponse = { ok: false, status: 400, body: { message: "Validation failed" } };
      await expect(
        mod.createPullRequest({
          token: "ghp_test",
          owner: "org",
          repo: "repo",
          head: "fail-branch",
          base: "main",
          title: "Fail PR",
        }),
      ).rejects.toThrow("GitHub PR creation failed (400)");
      expect(fetchUrls).toEqual(["https://api.github.com/repos/org/repo/pulls"]);
    });

    it("adopts an existing head PR after an ambiguous 502 create failure", async () => {
      mockFetchResponses = [
        { ok: false, status: 502, body: { message: "Bad Gateway" } },
        { ok: true, status: 200, body: [{ html_url: "https://github.com/org/repo/pull/10", number: 10 }] },
      ];

      const result = await mod.createPullRequest({
        token: "ghp_test",
        owner: "org",
        repo: "repo",
        head: "recovered-branch",
        base: "main",
        title: "Recovered PR",
      });

      expect(result).toEqual({
        prUrl: "https://github.com/org/repo/pull/10",
        prNumber: 10,
        branchName: "recovered-branch",
        created: false,
      });
      expect(fetchUrls).toEqual([
        "https://api.github.com/repos/org/repo/pulls",
        "https://api.github.com/repos/org/repo/pulls?head=org%3Arecovered-branch&state=open&sort=created&direction=desc&per_page=1",
      ]);
    });

    it("adopts an existing head PR after an ambiguous 429 create failure", async () => {
      mockFetchResponses = [
        { ok: false, status: 429, body: { message: "rate limited" } },
        { ok: true, status: 200, body: [{ html_url: "https://github.com/org/repo/pull/11", number: 11 }] },
      ];

      const result = await mod.createPullRequest({
        token: "ghp_test",
        owner: "org",
        repo: "repo",
        head: "rate-limited-branch",
        base: "main",
        title: "Rate limited PR",
      });

      expect(result).toEqual({
        prUrl: "https://github.com/org/repo/pull/11",
        prNumber: 11,
        branchName: "rate-limited-branch",
        created: false,
      });
      expect(fetchUrls[1]).toContain("/pulls?head=org%3Arate-limited-branch&state=open");
    });

    it("does not adopt closed or merged branch PRs after an ambiguous create failure", async () => {
      mockFetchResponses = [
        { ok: false, status: 500, body: { message: "Internal Server Error" } },
        { ok: true, status: 200, body: [] },
      ];

      await expect(
        mod.createPullRequest({
          token: "ghp_test",
          owner: "org",
          repo: "repo",
          head: "missing-branch",
          base: "main",
          title: "Missing PR",
        }),
      ).rejects.toThrow('GitHub PR creation failed (500): {"message":"Internal Server Error"}');
      expect(fetchUrls[1]).toContain("/pulls?head=org%3Amissing-branch&state=open");
    });

    it("throws the original transient create error when recovery lookup fails", async () => {
      mockFetchResponses = [
        { ok: false, status: 502, body: { message: "Bad Gateway" } },
        { ok: false, status: 503, body: { message: "lookup unavailable" } },
      ];

      await expect(
        mod.createPullRequest({
          token: "ghp_test",
          owner: "org",
          repo: "repo",
          head: "lookup-fail-branch",
          base: "main",
          title: "Lookup Fail PR",
        }),
      ).rejects.toThrow('GitHub PR creation failed (502): {"message":"Bad Gateway"}');
      expect(fetchUrls[1]).toContain("/pulls?head=org%3Alookup-fail-branch&state=open");
    });

    it("returns existing PR with created=false on 422 already exists", async () => {
      mockFetchResponses = [
        { ok: false, status: 422, body: { message: "A pull request already exists for acme:memory-branch." } },
        { ok: true, status: 200, body: [{ html_url: "https://github.com/org/repo/pull/9", number: 9 }] },
      ];

      const result = await mod.createPullRequest({
        token: "ghp_test",
        owner: "org",
        repo: "repo",
        head: "memory-branch",
        base: "main",
        title: "Memory update PR",
      });

      expect(result).toEqual({
        prUrl: "https://github.com/org/repo/pull/9",
        prNumber: 9,
        branchName: "memory-branch",
        created: false,
      });
      expect(fetchUrls[1]).toContain("/pulls?head=org%3Amemory-branch&state=all");
    });

    it("returns actualDraft false when draft creation downgrades to ready-for-review", async () => {
      mockFetchResponses = [
        { ok: false, status: 422, body: { message: "Draft pull requests are not supported for this repository." } },
        { ok: true, status: 201, body: { html_url: "https://github.com/org/repo/pull/12", number: 12 } },
      ];

      const result = await mod.createPullRequest({
        token: "ghp_test",
        owner: "org",
        repo: "repo",
        head: "draft-unsupported",
        base: "main",
        title: "Draft unsupported PR",
        draft: true,
      });

      expect(result).toEqual({
        prUrl: "https://github.com/org/repo/pull/12",
        prNumber: 12,
        branchName: "draft-unsupported",
        created: true,
        actualDraft: false,
      });
      expect(JSON.parse(lastFetchOptions!.body!).draft).toBe(false);
    });

    it("recovers an existing PR when the draft-downgrade retry returns already exists", async () => {
      mockFetchResponses = [
        { ok: false, status: 422, body: { message: "Draft pull requests are not supported for this repository." } },
        { ok: false, status: 422, body: { message: "A pull request already exists for acme:downgrade-race." } },
        { ok: true, status: 200, body: [{ html_url: "https://github.com/org/repo/pull/13", number: 13 }] },
      ];

      const result = await mod.createPullRequest({
        token: "ghp_test",
        owner: "org",
        repo: "repo",
        head: "downgrade-race",
        base: "main",
        title: "Downgrade race PR",
        draft: true,
      });

      expect(result).toEqual({
        prUrl: "https://github.com/org/repo/pull/13",
        prNumber: 13,
        branchName: "downgrade-race",
        created: false,
      });
      expect(fetchUrls[2]).toContain("/pulls?head=org%3Adowngrade-race&state=all");
    });

    it("recovers an open PR when the draft-downgrade retry returns an ambiguous failure", async () => {
      mockFetchResponses = [
        { ok: false, status: 422, body: { message: "Draft pull requests are not supported for this repository." } },
        { ok: false, status: 429, body: { message: "rate limited" } },
        { ok: true, status: 200, body: [{ html_url: "https://github.com/org/repo/pull/14", number: 14 }] },
      ];

      const result = await mod.createPullRequest({
        token: "ghp_test",
        owner: "org",
        repo: "repo",
        head: "downgrade-rate-limited",
        base: "main",
        title: "Downgrade rate limited PR",
        draft: true,
      });

      expect(result).toEqual({
        prUrl: "https://github.com/org/repo/pull/14",
        prNumber: 14,
        branchName: "downgrade-rate-limited",
        created: false,
      });
      expect(fetchUrls[2]).toContain("/pulls?head=org%3Adowngrade-rate-limited&state=open");
    });
  });

  describe("createPullRequestReview", () => {
    it("creates a comment review with inline comments anchored to the requested commit", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: { id: 77, html_url: "https://github.com/org/repo/pull/42#pullrequestreview-77" },
      };

      const result = await mod.createPullRequestReview("installation-token", "org", "repo", 42, {
        commitId: "head-sha",
        body: "See the managed review summary.",
        event: "COMMENT",
        comments: [{ path: "src/index.ts", line: 12, side: "RIGHT", body: "This can fail closed." }],
      });

      expect(fetchUrls).toEqual(["https://api.github.com/repos/org/repo/pulls/42/reviews"]);
      expect(lastFetchOptions).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer installation-token",
          Accept: "application/vnd.github+json",
        }),
      });
      expect(JSON.parse(lastFetchOptions?.body ?? "{}")).toEqual({
        commit_id: "head-sha",
        body: "See the managed review summary.",
        event: "COMMENT",
        comments: [{ path: "src/index.ts", line: 12, side: "RIGHT", body: "This can fail closed." }],
      });
      expect(result).toEqual({ id: 77, htmlUrl: "https://github.com/org/repo/pull/42#pullrequestreview-77" });
    });

    it("surfaces GitHub review creation failures", async () => {
      mockFetchResponse = { ok: false, status: 422, body: { message: "Validation Failed" } };

      await expect(
        mod.createPullRequestReview("installation-token", "org", "repo", 42, {
          commitId: "head-sha",
          body: "Review summary.",
          event: "COMMENT",
          comments: [],
        }),
      ).rejects.toThrow('GitHub PR review creation failed (422): {"message":"Validation Failed"}');
    });
  });

  describe("getPrState", () => {
    it("returns 'open' for an open PR", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { state: "open", merged: false } };
      const state = await mod.getPrState("ghp_test", "org", "repo", 42);
      expect(state).toBe("open");
    });

    it("returns 'closed' for a closed-unmerged PR", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { state: "closed", merged: false } };
      const state = await mod.getPrState("ghp_test", "org", "repo", 42);
      expect(state).toBe("closed");
    });

    it("returns 'merged' for a merged PR (state=closed, merged=true)", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { state: "closed", merged: true } };
      const state = await mod.getPrState("ghp_test", "org", "repo", 42);
      expect(state).toBe("merged");
    });

    it("returns null on non-200 response", async () => {
      mockFetchResponse = { ok: false, status: 404, body: { message: "Not Found" } };
      const state = await mod.getPrState("ghp_test", "org", "repo", 42);
      expect(state).toBeNull();
    });

    it("throws on auth failures so callers can retry with installation auth", async () => {
      mockFetchResponse = { ok: false, status: 401, body: { message: "Bad credentials" } };
      await expect(mod.getPrState("ghp_test", "org", "repo", 42)).rejects.toThrow(
        'GitHub PR state lookup failed (401): {"message":"Bad credentials"}',
      );
    });

    it("returns null on 500 server error", async () => {
      mockFetchResponse = { ok: false, status: 500, body: { message: "Internal Server Error" } };
      const state = await mod.getPrState("ghp_test", "org", "repo", 42);
      expect(state).toBeNull();
    });
  });

  describe("getPrHeadSha", () => {
    it("returns the head SHA on success", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { head: { sha: "abc123" } } };
      const sha = await mod.getPrHeadSha("ghp_test", "org", "repo", 42);
      expect(sha).toBe("abc123");
    });

    it("throws with the HTTP status on 404 (repo/PR gone) so the sweep can classify repo_gone", async () => {
      mockFetchResponse = { ok: false, status: 404, body: { message: "Not Found" } };
      await expect(mod.getPrHeadSha("ghp_test", "org", "repo", 42)).rejects.toThrow(
        'GitHub PR head lookup failed (404): {"message":"Not Found"}',
      );
    });

    it("throws with the HTTP status on 401/403 (auth lost) so the sweep can classify github_auth_lost", async () => {
      mockFetchResponse = { ok: false, status: 401, body: { message: "Bad credentials" } };
      await expect(mod.getPrHeadSha("ghp_test", "org", "repo", 42)).rejects.toThrow(
        "GitHub PR head lookup failed (401)",
      );

      mockFetchResponse = { ok: false, status: 403, body: { message: "Forbidden" } };
      await expect(mod.getPrHeadSha("ghp_test", "org", "repo", 42)).rejects.toThrow(
        "GitHub PR head lookup failed (403)",
      );
    });

    it("throws with the HTTP status on 5xx (transient)", async () => {
      mockFetchResponse = { ok: false, status: 502, body: { message: "Bad Gateway" } };
      await expect(mod.getPrHeadSha("ghp_test", "org", "repo", 42)).rejects.toThrow(
        "GitHub PR head lookup failed (502)",
      );
    });

    it("returns null only for the genuine no-head edge (read succeeded, head.sha absent)", async () => {
      mockFetchResponse = { ok: true, status: 200, body: {} };
      const sha = await mod.getPrHeadSha("ghp_test", "org", "repo", 42);
      expect(sha).toBeNull();
    });
  });

  describe("getPrDraftState", () => {
    it("returns the node id and draft state for a ready PR", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { node_id: "PR_node_1", draft: false } };
      const state = await mod.getPrDraftState("ghp_test", "org", "repo", 42);
      expect(fetchUrls).toEqual(["https://api.github.com/repos/org/repo/pulls/42"]);
      expect(state).toEqual({ nodeId: "PR_node_1", isDraft: false });
    });

    it("reports isDraft true for a draft PR", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { node_id: "PR_node_1", draft: true } };
      const state = await mod.getPrDraftState("ghp_test", "org", "repo", 42);
      expect(state).toEqual({ nodeId: "PR_node_1", isDraft: true });
    });

    it("throws when the PR cannot be read (non-ok response)", async () => {
      mockFetchResponse = { ok: false, status: 404, body: { message: "Not Found" } };
      await expect(mod.getPrDraftState("ghp_test", "org", "repo", 42)).rejects.toThrow(
        /GitHub PR draft-state lookup failed \(404\)/,
      );
    });

    it("returns null only for the genuine read-succeeded-but-no-node_id edge", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { draft: false } };
      const state = await mod.getPrDraftState("ghp_test", "org", "repo", 42);
      expect(state).toBeNull();
    });
  });

  describe("markPullRequestReadyForReview", () => {
    it("posts the markPullRequestReadyForReview GraphQL mutation with the node id", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } },
      };
      await mod.markPullRequestReadyForReview("ghp_test", "PR_node_1");
      expect(fetchUrls).toEqual(["https://api.github.com/graphql"]);
      expect(lastFetchOptions?.method).toBe("POST");
      const payload = JSON.parse(lastFetchOptions?.body ?? "{}");
      expect(payload.query).toContain("markPullRequestReadyForReview");
      expect(payload.variables).toEqual({ id: "PR_node_1" });
    });

    it("throws on a non-ok response", async () => {
      mockFetchResponse = { ok: false, status: 403, body: { message: "Forbidden" } };
      await expect(mod.markPullRequestReadyForReview("ghp_test", "PR_node_1")).rejects.toThrow(
        /GitHub mark PR ready for review failed \(403\)/,
      );
    });

    it("throws when the GraphQL response contains errors", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { errors: [{ message: "boom" }] } };
      await expect(mod.markPullRequestReadyForReview("ghp_test", "PR_node_1")).rejects.toThrow(
        /GraphQL response contained errors/,
      );
    });

    it("does not throw on an empty errors array", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }, errors: [] },
      };
      await expect(mod.markPullRequestReadyForReview("ghp_test", "PR_node_1")).resolves.toBeUndefined();
    });
  });

  describe("getPrReviewComments", () => {
    it("fetches and normalizes paginated review comments", async () => {
      mockFetchResponses = [
        {
          ok: true,
          status: 200,
          body: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            pull_request_review_id: 700 + index,
            path: "src/review.ts",
            line: index + 10,
            body: `Comment ${index + 1}`,
            user: { login: "reviewer" },
          })),
        },
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 101,
              pull_request_review_id: 9001,
              path: "src/legacy.ts",
              line: null,
              original_line: 77,
              body: "Fallback to original line",
              in_reply_to_id: 55,
              user: { login: "alice" },
            },
          ],
        },
      ];

      const comments = await mod.getPrReviewComments("ghp_test", "org", "repo", 42);

      expect(fetchUrls).toEqual([
        "https://api.github.com/repos/org/repo/pulls/42/comments?per_page=100&page=1",
        "https://api.github.com/repos/org/repo/pulls/42/comments?per_page=100&page=2",
      ]);
      expect(comments).toHaveLength(101);
      expect(comments[0]).toEqual({
        id: 1,
        reviewId: 700,
        path: "src/review.ts",
        line: 10,
        body: "Comment 1",
        author: "reviewer",
        inReplyToId: null,
      });
      expect(comments[100]).toEqual({
        id: 101,
        reviewId: 9001,
        path: "src/legacy.ts",
        line: 77,
        body: "Fallback to original line",
        author: "alice",
        inReplyToId: 55,
      });
    });

    it("stops paginating once maxComments is exceeded instead of walking the whole collection", async () => {
      mockFetchResponses = [
        {
          ok: true,
          status: 200,
          body: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            pull_request_review_id: 700 + index,
            path: "src/review.ts",
            line: index + 10,
            body: `Comment ${index + 1}`,
            user: { login: "reviewer" },
          })),
        },
        {
          ok: true,
          status: 200,
          body: Array.from({ length: 100 }, (_, index) => ({
            id: 101 + index,
            pull_request_review_id: 900 + index,
            path: "src/more.ts",
            line: index,
            body: `Comment ${101 + index}`,
            user: { login: "reviewer" },
          })),
        },
        // A third page exists on the server, but the bounded walk must never request it.
        { ok: true, status: 200, body: [{ id: 999, user: { login: "reviewer" } }] },
      ];

      const comments = await mod.getPrReviewComments("ghp_test", "org", "repo", 42, 100);

      // Fetches one page past the cap (to detect >100) and then stops — page 3 is never requested.
      expect(fetchUrls).toEqual([
        "https://api.github.com/repos/org/repo/pulls/42/comments?per_page=100&page=1",
        "https://api.github.com/repos/org/repo/pulls/42/comments?per_page=100&page=2",
      ]);
      expect(comments.length).toBeGreaterThan(100);
    });

    it("throws when the GitHub API rejects the review comment fetch", async () => {
      mockFetchResponse = { ok: false, status: 500, body: { message: "boom" } };

      await expect(mod.getPrReviewComments("ghp_test", "org", "repo", 42)).rejects.toThrow(
        "GitHub PR review comments fetch failed (500)",
      );
    });
  });

  describe("getPrCommitShas", () => {
    it("fetches paginated PR commit SHAs", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: Array.from({ length: 100 }, (_, index) => ({ sha: `sha-${index}` })) },
        { ok: true, status: 200, body: [{ sha: "sha-100" }] },
      ];

      const shas = await mod.getPrCommitShas("ghp_test", "org", "repo", 42);

      expect(shas).toHaveLength(101);
      expect(shas[100]).toBe("sha-100");
      expect(fetchUrls).toEqual([
        "https://api.github.com/repos/org/repo/pulls/42/commits?per_page=100&page=1",
        "https://api.github.com/repos/org/repo/pulls/42/commits?per_page=100&page=2",
      ]);
    });

    it("throws when the GitHub API rejects the commit fetch", async () => {
      mockFetchResponse = { ok: false, status: 500, body: { message: "boom" } };

      await expect(mod.getPrCommitShas("ghp_test", "org", "repo", 42)).rejects.toThrow(
        "GitHub PR commits fetch failed (500)",
      );
    });
  });

  describe("getCommitStatusContexts", () => {
    it("returns status contexts with authenticated creator identity", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: [
          {
            id: 48028166171,
            context: "CodeRabbit",
            state: "success",
            description: "Review completed",
            target_url: null,
            created_at: "2026-06-08T12:00:00Z",
            updated_at: "2026-06-08T12:05:00Z",
            creator: { login: "coderabbitai[bot]", type: "Bot" },
          },
        ],
      };

      await expect(mod.getCommitStatusContexts("ghp_test", "org", "repo", "abc")).resolves.toEqual([
        {
          id: 48028166171,
          context: "CodeRabbit",
          state: "success",
          description: "Review completed",
          targetUrl: null,
          createdAt: "2026-06-08T12:00:00Z",
          updatedAt: "2026-06-08T12:05:00Z",
          creatorLogin: "coderabbitai[bot]",
          creatorType: "Bot",
        },
      ]);
      expect(fetchUrls).toEqual(["https://api.github.com/repos/org/repo/commits/abc/statuses?per_page=100&page=1"]);
    });
  });

  describe("getCommitCheckRuns", () => {
    it("captures the check-run output fields used as CI-fix evidence", async () => {
      mockFetchResponses = [
        {
          ok: true,
          status: 200,
          body: {
            check_runs: [
              {
                id: 7,
                name: "unit",
                status: "completed",
                conclusion: "failure",
                details_url: "https://ci/7",
                app: { slug: "github-actions", name: "GitHub Actions" },
                output: { title: "2 failed", summary: "AssertionError in foo.test.ts", text: "full log body" },
              },
            ],
          },
        },
      ];

      await expect(mod.getCommitCheckRuns("ghp_test", "org", "repo", "abc")).resolves.toEqual([
        {
          id: 7,
          name: "unit",
          status: "completed",
          conclusion: "failure",
          appSlug: "github-actions",
          appName: "GitHub Actions",
          detailsUrl: "https://ci/7",
          outputTitle: "2 failed",
          outputSummary: "AssertionError in foo.test.ts",
          outputText: "full log body",
        },
      ]);
    });

    it("nulls output fields when the check run has no output", async () => {
      mockFetchResponses = [
        {
          ok: true,
          status: 200,
          body: { check_runs: [{ id: 8, name: "lint", status: "completed", conclusion: "failure", output: null }] },
        },
      ];

      const runs = await mod.getCommitCheckRuns("ghp_test", "org", "repo", "abc");
      expect(runs[0].outputTitle).toBeNull();
      expect(runs[0].outputSummary).toBeNull();
      expect(runs[0].outputText).toBeNull();
    });

    it("collapses re-run check-runs to the latest per name (stale failures dropped)", async () => {
      // Mirrors mialabs/mia#3089: a PR-title validator re-ran on each title edit, leaving four stale
      // `Validate PR Title` failures + one later success on the same SHA. Only the latest must survive.
      mockFetchResponses = [
        {
          ok: true,
          status: 200,
          body: {
            check_runs: [
              { id: 1, name: "Validate PR Title", status: "completed", conclusion: "failure" },
              { id: 2, name: "Validate PR Title", status: "completed", conclusion: "failure" },
              { id: 9, name: "Validate PR Title", status: "completed", conclusion: "success" },
              { id: 3, name: "Validate PR Title", status: "completed", conclusion: "failure" },
              { id: 5, name: "test-core", status: "completed", conclusion: "success" },
            ],
          },
        },
      ];

      const runs = await mod.getCommitCheckRuns("ghp_test", "org", "repo", "abc");
      expect(runs).toHaveLength(2);
      const byName = Object.fromEntries(runs.map((r) => [r.name, r]));
      expect(byName["Validate PR Title"].id).toBe(9);
      expect(byName["Validate PR Title"].conclusion).toBe("success");
      expect(byName["test-core"].conclusion).toBe("success");
    });

    it("keeps every null-named run and picks highest id regardless of order", async () => {
      mockFetchResponses = [
        {
          ok: true,
          status: 200,
          body: {
            check_runs: [
              { id: 20, name: "build", status: "completed", conclusion: "success" },
              { id: 10, name: "build", status: "completed", conclusion: "failure" },
              { id: 4, name: null, status: "completed", conclusion: "failure" },
              { id: 6, name: null, status: "completed", conclusion: "failure" },
            ],
          },
        },
      ];

      const runs = await mod.getCommitCheckRuns("ghp_test", "org", "repo", "abc");
      expect(runs.filter((r) => r.name === "build")).toHaveLength(1);
      expect(runs.find((r) => r.name === "build")?.conclusion).toBe("success");
      expect(runs.filter((r) => r.name === null)).toHaveLength(2);
    });
  });

  describe("dedupeLatestCheckRunsByName", () => {
    it("keeps the highest-id run per name and all null-named runs", () => {
      const result = mod.dedupeLatestCheckRunsByName([
        { id: 1, name: "a" },
        { id: 7, name: "a" },
        { id: 3, name: "b" },
        { id: 2, name: null },
        { id: 9, name: null },
      ]);
      expect(result).toEqual([
        { id: 7, name: "a" },
        { id: 3, name: "b" },
        { id: 2, name: null },
        { id: 9, name: null },
      ]);
    });
  });

  describe("getCommitCiStatus", () => {
    it("returns failed when any check run failed", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: { state: "success", statuses: [{ id: 1 }] } },
        { ok: true, status: 200, body: { check_runs: [{ status: "completed", conclusion: "failure" }] } },
      ];

      await expect(mod.getCommitCiStatus("ghp_test", "org", "repo", "abc")).resolves.toBe("failed");
    });

    it("returns failed when a paginated check run failed after the first page", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: { state: "success", statuses: [{ id: 1 }] } },
        {
          ok: true,
          status: 200,
          body: {
            check_runs: Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success" })),
          },
        },
        { ok: true, status: 200, body: { check_runs: [{ status: "completed", conclusion: "failure" }] } },
      ];

      await expect(mod.getCommitCiStatus("ghp_test", "org", "repo", "abc")).resolves.toBe("failed");
      expect(fetchUrls).toContain("https://api.github.com/repos/org/repo/commits/abc/check-runs?per_page=100&page=2");
    });

    it("returns success when checks are all passing", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: { state: "success", statuses: [{ id: 1 }] } },
        { ok: true, status: 200, body: { check_runs: [{ status: "completed", conclusion: "success" }] } },
      ];

      await expect(mod.getCommitCiStatus("ghp_test", "org", "repo", "abc")).resolves.toBe("success");
    });

    it("returns pending when checks are not completed yet", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: { state: "pending", statuses: [{ id: 1 }] } },
        { ok: true, status: 200, body: { check_runs: [{ status: "in_progress", conclusion: null }] } },
      ];

      await expect(mod.getCommitCiStatus("ghp_test", "org", "repo", "abc")).resolves.toBe("pending");
    });

    it("returns unknown when GitHub has no statuses or check runs", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: { state: "success", statuses: [] } },
        { ok: true, status: 200, body: { check_runs: [] } },
      ];

      await expect(mod.getCommitCiStatus("ghp_test", "org", "repo", "abc")).resolves.toBe("unknown");
    });

    it("returns unknown when combined status JSON parsing fails", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: null, jsonError: new Error("malformed status JSON") },
        { ok: true, status: 200, body: { check_runs: [] } },
      ];

      await expect(mod.getCommitCiStatus("ghp_test", "org", "repo", "abc")).resolves.toBe("unknown");
    });

    it("returns unknown when check runs JSON parsing fails", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: { state: "success", statuses: [] } },
        { ok: true, status: 200, body: null, jsonError: new Error("malformed check-runs JSON") },
      ];

      await expect(mod.getCommitCiStatus("ghp_test", "org", "repo", "abc")).resolves.toBe("unknown");
    });

    it("returns success when a re-run check's latest conclusion passes despite stale failures", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: { state: "success", statuses: [] } },
        {
          ok: true,
          status: 200,
          body: {
            check_runs: [
              { id: 1, name: "Validate PR Title", status: "completed", conclusion: "failure" },
              { id: 4, name: "Validate PR Title", status: "completed", conclusion: "success" },
              { id: 2, name: "test-core", status: "completed", conclusion: "success" },
            ],
          },
        },
      ];

      await expect(mod.getCommitCiStatus("ghp_test", "org", "repo", "abc")).resolves.toBe("success");
    });
  });

  describe("isRepoPrivate", () => {
    it("returns true for private repos", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { default_branch: "main", private: true } };

      const result = await mod.isRepoPrivate("ghp_test", "org", "repo");

      expect(result).toBe(true);
      expect(fetchUrls[0]).toContain("/repos/org/repo");
    });

    it("returns false for public repos", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { default_branch: "main", private: false } };

      const result = await mod.isRepoPrivate("ghp_test", "org", "repo");

      expect(result).toBe(false);
    });
  });

  describe("findOpenPrByHead", () => {
    const MARKER = "<!-- cycloid-dedup: sess-1:prompt-9 -->";

    it("returns the newest open PR by head with no marker query (single result)", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: [{ html_url: "https://github.com/org/repo/pull/7", number: 7 }],
      };

      const result = await mod.findOpenPrByHead("ghp_test", "org", "repo", "feature");

      expect(fetchUrls[0]).toContain("/repos/org/repo/pulls?head=org%3Afeature&state=open");
      expect(fetchUrls[0]).toContain("per_page=1");
      expect(result).toEqual({
        prUrl: "https://github.com/org/repo/pull/7",
        prNumber: 7,
        branchName: "feature",
        matchedMarker: false,
      });
    });

    it("returns null when no open PR exists on the head branch", async () => {
      mockFetchResponse = { ok: true, status: 200, body: [] };
      const result = await mod.findOpenPrByHead("ghp_test", "org", "repo", "feature", MARKER);
      expect(result).toBeNull();
    });

    it("prefers the PR whose body carries the dedup marker over the newest", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: [
          { html_url: "https://github.com/org/repo/pull/9", number: 9, body: "unrelated PR on same branch" },
          { html_url: "https://github.com/org/repo/pull/5", number: 5, body: `## Summary\n\n${MARKER}\n` },
        ],
      };

      const result = await mod.findOpenPrByHead("ghp_test", "org", "repo", "feature", MARKER);

      // Widens the page when a marker is supplied so a non-newest match is found.
      expect(fetchUrls[0]).toContain("per_page=20");
      expect(result).toEqual({
        prUrl: "https://github.com/org/repo/pull/5",
        prNumber: 5,
        branchName: "feature",
        matchedMarker: true,
      });
    });

    it("falls back to the newest open PR when no body carries the marker", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: [
          { html_url: "https://github.com/org/repo/pull/9", number: 9, body: "no marker here" },
          { html_url: "https://github.com/org/repo/pull/5", number: 5, body: "still nothing" },
        ],
      };

      const result = await mod.findOpenPrByHead("ghp_test", "org", "repo", "feature", MARKER);

      expect(result).toEqual({
        prUrl: "https://github.com/org/repo/pull/9",
        prNumber: 9,
        branchName: "feature",
        matchedMarker: false,
      });
    });
  });

  describe("parsePrMergeableState", () => {
    it("passes through modeled values", () => {
      for (const value of ["behind", "dirty", "clean", "unstable", "blocked", "draft"]) {
        expect(mod.parsePrMergeableState(value)).toBe(value);
      }
    });

    it("buckets unmodeled / non-string values as unknown", () => {
      expect(mod.parsePrMergeableState("has_hooks")).toBe("unknown");
      expect(mod.parsePrMergeableState(null)).toBe("unknown");
      expect(mod.parsePrMergeableState(undefined)).toBe("unknown");
      expect(mod.parsePrMergeableState(42)).toBe("unknown");
    });
  });

  describe("getPrMergeStatus", () => {
    it("parses a behind PR (mergeable true)", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: {
          state: "open",
          merged: false,
          head: { sha: "abc123" },
          base: { ref: "release/next" },
          mergeable: true,
          mergeable_state: "behind",
        },
      };
      const status = await mod.getPrMergeStatus("ghp_test", "org", "repo", 42);
      expect(status).toEqual({
        state: "open",
        headSha: "abc123",
        baseRef: "release/next",
        mergeable: true,
        mergeableState: "behind",
        rawMergeableState: "behind",
        labels: [],
      });
    });

    it("parses label names from the PR payload (ignoring entries without a string name)", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: {
          state: "open",
          merged: false,
          head: { sha: "abc123" },
          mergeable: true,
          mergeable_state: "clean",
          labels: [{ name: "review-loop:ci-green" }, { name: "cycloid" }, { id: 5 }, { name: 7 }],
        },
      };
      const status = await mod.getPrMergeStatus("ghp_test", "org", "repo", 42);
      expect(status.labels).toEqual(["review-loop:ci-green", "cycloid"]);
    });

    it("defaults labels to [] when the field is absent", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: { state: "open", merged: false, head: { sha: "x" }, mergeable: true, mergeable_state: "clean" },
      };
      expect((await mod.getPrMergeStatus("ghp_test", "org", "repo", 42)).labels).toEqual([]);
    });

    it("defaults labels to [] on a non-auth non-OK fallback", async () => {
      mockFetchResponse = { ok: false, status: 404, body: { message: "Not Found" } };
      expect((await mod.getPrMergeStatus("ghp_test", "org", "repo", 42)).labels).toEqual([]);
    });

    it("parses a dirty PR (mergeable false)", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: { state: "open", merged: false, head: { sha: "def456" }, mergeable: false, mergeable_state: "dirty" },
      };
      const status = await mod.getPrMergeStatus("ghp_test", "org", "repo", 42);
      expect(status.mergeableState).toBe("dirty");
      expect(status.mergeable).toBe(false);
      expect(status.state).toBe("open");
    });

    it("returns mergeable null while GitHub is still computing", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: { state: "open", merged: false, head: { sha: "x" }, mergeable: null, mergeable_state: "unknown" },
      };
      const status = await mod.getPrMergeStatus("ghp_test", "org", "repo", 42);
      expect(status.mergeable).toBeNull();
      expect(status.mergeableState).toBe("unknown");
    });

    it("buckets an unmodeled mergeable_state as unknown but keeps the raw value", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: { state: "open", merged: false, head: { sha: "x" }, mergeable: true, mergeable_state: "has_hooks" },
      };
      const status = await mod.getPrMergeStatus("ghp_test", "org", "repo", 42);
      expect(status.mergeableState).toBe("unknown");
      expect(status.rawMergeableState).toBe("has_hooks");
    });

    it("resolves merged state", async () => {
      mockFetchResponse = {
        ok: true,
        status: 200,
        body: { state: "closed", merged: true, head: { sha: "x" }, mergeable: null, mergeable_state: "clean" },
      };
      const status = await mod.getPrMergeStatus("ghp_test", "org", "repo", 42);
      expect(status.state).toBe("merged");
    });

    it("returns state null on a non-auth non-OK response", async () => {
      mockFetchResponse = { ok: false, status: 404, body: { message: "Not Found" } };
      const status = await mod.getPrMergeStatus("ghp_test", "org", "repo", 42);
      expect(status.state).toBeNull();
      expect(status.headSha).toBeNull();
      expect(status.mergeableState).toBe("unknown");
    });

    it("throws on auth failures so callers can retry with installation auth", async () => {
      mockFetchResponse = { ok: false, status: 401, body: { message: "Bad credentials" } };
      await expect(mod.getPrMergeStatus("ghp_test", "org", "repo", 42)).rejects.toThrow(
        "GitHub PR merge-status lookup failed (401)",
      );
    });
  });

  describe("updatePullRequestBranch", () => {
    it("returns ok and sends expected_head_sha on 202", async () => {
      mockFetchResponse = { ok: true, status: 202, body: { message: "Updating pull request branch." } };
      const result = await mod.updatePullRequestBranch("ghp_test", "org", "repo", 42, "headsha1");
      expect(result).toEqual({ ok: true });
      expect(fetchUrls[0]).toBe("https://api.github.com/repos/org/repo/pulls/42/update-branch");
      expect(lastFetchOptions?.method).toBe("PUT");
      expect(JSON.parse(lastFetchOptions?.body ?? "{}")).toEqual({ expected_head_sha: "headsha1" });
    });

    it("classifies a 422 expected-head mismatch as expected_head_mismatch (not a conflict)", async () => {
      mockFetchResponse = {
        ok: false,
        status: 422,
        body: { message: "Expected head sha didn't match current head ref." },
      };
      const result = await mod.updatePullRequestBranch("ghp_test", "org", "repo", 42, "stale");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("expected_head_mismatch");
    });

    it("classifies other 422 as validation_failed", async () => {
      mockFetchResponse = { ok: false, status: 422, body: { message: "Validation Failed" } };
      const result = await mod.updatePullRequestBranch("ghp_test", "org", "repo", 42, "h");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("validation_failed");
    });

    it("classifies 401 as auth_failed (transient), not permission_denied", async () => {
      mockFetchResponse = { ok: false, status: 401, body: { message: "Bad credentials" } };
      const result = await mod.updatePullRequestBranch("ghp_test", "org", "repo", 42, "h");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("auth_failed");
        expect(result.status).toBe(401);
      }
    });

    it("classifies 403 as permission_denied", async () => {
      mockFetchResponse = { ok: false, status: 403, body: { message: "Resource not accessible by integration" } };
      const result = await mod.updatePullRequestBranch("ghp_test", "org", "repo", 42, "h");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("permission_denied");
    });

    it("classifies other statuses as unavailable", async () => {
      mockFetchResponse = { ok: false, status: 502, body: { message: "Bad Gateway" } };
      const result = await mod.updatePullRequestBranch("ghp_test", "org", "repo", 42, "h");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unavailable");
        expect(result.status).toBe(502);
      }
    });
  });

  describe("getCommitTreeSha", () => {
    it("returns the commit's tree SHA from the Git Database endpoint", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { sha: "commit1", tree: { sha: "tree1" } } };
      const treeSha = await mod.getCommitTreeSha("ghp_test", "org", "repo", "commit1");
      expect(treeSha).toBe("tree1");
      expect(fetchUrls).toEqual(["https://api.github.com/repos/org/repo/git/commits/commit1"]);
    });

    it("throws with the HTTP status on 401/403 (auth lost) so direct callers can retry", async () => {
      mockFetchResponse = { ok: false, status: 401, body: { message: "Bad credentials" } };
      await expect(mod.getCommitTreeSha("ghp_test", "org", "repo", "c")).rejects.toThrow(
        "GitHub commit lookup failed (401)",
      );

      mockFetchResponse = { ok: false, status: 403, body: { message: "Forbidden" } };
      await expect(mod.getCommitTreeSha("ghp_test", "org", "repo", "c")).rejects.toThrow(
        "GitHub commit lookup failed (403)",
      );
    });

    it("returns null on other non-ok responses (e.g. orphaned pre-rebase commit 404) to fail open", async () => {
      mockFetchResponse = { ok: false, status: 404, body: { message: "Not Found" } };
      const treeSha = await mod.getCommitTreeSha("ghp_test", "org", "repo", "gone");
      expect(treeSha).toBeNull();
    });

    it("returns null when the read succeeds but tree.sha is absent", async () => {
      mockFetchResponse = { ok: true, status: 200, body: { sha: "commit1" } };
      const treeSha = await mod.getCommitTreeSha("ghp_test", "org", "repo", "commit1");
      expect(treeSha).toBeNull();
    });
  });

  describe("isNoOpHeadTreeChange", () => {
    it("returns true when both heads resolve to the same tree SHA (content no-op)", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: { tree: { sha: "sameTree" } } },
        { ok: true, status: 200, body: { tree: { sha: "sameTree" } } },
      ];
      const result = await mod.isNoOpHeadTreeChange("ghp_test", "org", "repo", "prev", "next");
      expect(result).toBe(true);
    });

    it("returns false when the head trees differ (real content change)", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: { tree: { sha: "treeA" } } },
        { ok: true, status: 200, body: { tree: { sha: "treeB" } } },
      ];
      const result = await mod.isNoOpHeadTreeChange("ghp_test", "org", "repo", "prev", "next");
      expect(result).toBe(false);
    });

    it("returns false (fail open) when either commit cannot be read", async () => {
      mockFetchResponses = [
        { ok: true, status: 200, body: { tree: { sha: "treeA" } } },
        { ok: false, status: 404, body: { message: "Not Found" } },
      ];
      const result = await mod.isNoOpHeadTreeChange("ghp_test", "org", "repo", "prev", "next");
      expect(result).toBe(false);
    });

    it("returns false (fail open) when a read throws on auth loss rather than propagating", async () => {
      mockFetchResponse = { ok: false, status: 401, body: { message: "Bad credentials" } };
      const result = await mod.isNoOpHeadTreeChange("ghp_test", "org", "repo", "prev", "next");
      expect(result).toBe(false);
    });
  });
});
