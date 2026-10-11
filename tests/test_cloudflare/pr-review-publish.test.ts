import { beforeEach, describe, expect, it, vi } from "vitest";

import { REVIEW_AGENT_DISPLAY_NAME } from "../../shared/agent/constants";
import { PR_PERSONAS, renderPersonaHeader } from "../../shared/agent/pr-personas";

const mocks = vi.hoisted(() => ({
  createPrIssueComment: vi.fn(),
  createPullRequestReview: vi.fn(),
  getPrDiff: vi.fn(),
  fetchRepoTextFileAtCommit: vi.fn(),
  getPrReviewComments: vi.fn(),
  listPrIssueComments: vi.fn(),
  updateIssueComment: vi.fn(),
  updatePrReviewComment: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/github/pr", () => mocks);
vi.mock("../../apps/control-plane-worker/src/github/repo-source", () => ({
  fetchRepoTextFileAtCommit: mocks.fetchRepoTextFileAtCommit,
}));

import {
  changedRightSideLines,
  prReviewFindingMarker,
  type PrReviewPublication,
  publishPrReview,
} from "../../apps/control-plane-worker/src/github/pr-review-publish";

const publication: PrReviewPublication = {
  summaryMarkdown: "## Summary\n\n- Adds review publishing.",
  verdict: "issues_found",
  checks: [
    {
      command: "npm test",
      reason: "Targeted checks",
      status: "passed",
      exitCode: 0,
      detail: "Configured check passed.",
    },
  ],
  scopeNotVerified: ["Browser and runtime behavior are not verified."],
  confidenceScore: 4,
  importantFiles: [{ path: "src/index.ts", reason: "Owns the changed behavior." }],
  findings: [
    {
      path: "src/index.ts",
      line: 11,
      side: "RIGHT",
      severity: "P1",
      title: "Handle the failure",
      confidence: 3,
      bodyMarkdown: "This call can reject.",
    },
    {
      path: "src/index.ts",
      line: 30,
      side: "RIGHT",
      severity: "P2",
      title: "Outside the hunk",
      confidence: 4,
      bodyMarkdown: "This line is not changed.",
    },
  ],
  headSha: "a".repeat(40),
};
const logger = { info: vi.fn() };

function publishArgs(
  overrides: Partial<Parameters<typeof publishPrReview>[0]> = {},
): Parameters<typeof publishPrReview>[0] {
  return {
    token: "token",
    owner: "acme",
    repo: "repo",
    prNumber: 42,
    currentHeadSha: publication.headSha,
    publication,
    sessionId: "session-1",
    prUrl: "https://github.com/acme/repo/pull/42",
    logger,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrDiff.mockResolvedValue(
    "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -10,2 +10,3 @@\n context\n+changed\n context",
  );
  mocks.fetchRepoTextFileAtCommit.mockResolvedValue("file contents");
  mocks.getPrReviewComments.mockResolvedValue([]);
  mocks.listPrIssueComments.mockResolvedValue([]);
  mocks.createPrIssueComment.mockResolvedValue({ id: 55, htmlUrl: "comment-url" });
  mocks.createPullRequestReview.mockResolvedValue({ id: 77, htmlUrl: "review-url" });
});

describe("changedRightSideLines", () => {
  it("tracks only added lines on the right side across hunks and files", () => {
    const changed = changedRightSideLines(
      "diff --git a/a.ts b/a.ts\n@@ -1,2 +1,3 @@\n same\n+added\n-old\n+replaced\ndiff --git a/b.ts b/b.ts\n@@ -4,0 +5,1 @@\n+other",
    );

    expect([...changed.get("a.ts")!]).toEqual([2, 3]);
    expect([...changed.get("b.ts")!]).toEqual([5]);
  });
});

describe("publishPrReview", () => {
  it("posts a managed summary and only valid inline anchors", async () => {
    const result = await publishPrReview(publishArgs());

    expect(result).toEqual({
      outcome: "published",
      summaryCommentId: 55,
      inlineCommentCount: 1,
      foldedFindingCount: 1,
    });
    expect(mocks.createPrIssueComment).toHaveBeenCalledWith(
      "token",
      "acme",
      "repo",
      42,
      expect.stringContaining(`<!-- cycloid-review -->\n\n${renderPersonaHeader(PR_PERSONAS.zeus)}`),
    );
    expect(mocks.createPullRequestReview).toHaveBeenCalledWith(
      "token",
      "acme",
      "repo",
      42,
      expect.objectContaining({
        commitId: publication.headSha,
        event: "COMMENT",
        body: `${REVIEW_AGENT_DISPLAY_NAME} — Review summary: https://github.com/acme/repo/pull/42#issuecomment-55`,
        comments: [expect.objectContaining({ path: "src/index.ts", line: 11, side: "RIGHT" })],
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      {
        sessionId: "session-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        droppedCount: 0,
        keptCount: 2,
      },
      "Filtered PR review findings by confidence",
    );
  });

  it("updates an existing matching inline finding when evidence wording changes", async () => {
    const matching = { ...publication.findings[0]!, bodyMarkdown: "New evidence." };
    const existingBody = `${prReviewFindingMarker(matching)}\n🔴 **[P1] Handle the failure**\n\nOld evidence.`;
    mocks.getPrReviewComments.mockResolvedValue([
      { id: 88, path: "src/index.ts", line: 11, body: existingBody, author: "cycloid-app[bot]" },
    ]);
    await publishPrReview(publishArgs({ publication: { ...publication, findings: [matching] } }));
    expect(mocks.createPullRequestReview).not.toHaveBeenCalled();
    expect(mocks.updatePrReviewComment).toHaveBeenCalledWith(
      "token",
      "acme",
      "repo",
      88,
      expect.stringContaining("[P1]"),
    );
  });

  it("updates a legacy unmarked inline finding instead of duplicating it", async () => {
    const finding = { ...publication.findings[0]!, bodyMarkdown: "New evidence." };
    mocks.getPrReviewComments.mockResolvedValue([
      {
        id: 89,
        path: "src/index.ts",
        line: 11,
        body: "**[P1] Handle the failure**\n\nOld evidence.",
        author: "cycloid-app[bot]",
      },
    ]);
    await publishPrReview(publishArgs({ publication: { ...publication, findings: [finding] } }));
    expect(mocks.createPullRequestReview).not.toHaveBeenCalled();
    expect(mocks.updatePrReviewComment).toHaveBeenCalledWith(
      "token",
      "acme",
      "repo",
      89,
      expect.stringContaining("[P1]"),
    );
  });

  it("matches a marked finding when GitHub omits its line metadata", async () => {
    const finding = { ...publication.findings[0]!, bodyMarkdown: "New evidence." };
    mocks.getPrReviewComments.mockResolvedValue([
      {
        id: 90,
        path: "src/index.ts",
        line: null,
        body: `${prReviewFindingMarker(finding)}\nOld evidence.`,
        author: "cycloid-app[bot]",
      },
    ]);
    await publishPrReview(publishArgs({ publication: { ...publication, findings: [finding] } }));
    expect(mocks.createPullRequestReview).not.toHaveBeenCalled();
    expect(mocks.updatePrReviewComment).toHaveBeenCalledWith("token", "acme", "repo", 90, expect.any(String));
  });

  it("renders severity badges, safe suggestions, and context citations", async () => {
    await publishPrReview(
      publishArgs({
        publication: {
          ...publication,
          findings: [
            { ...publication.findings[0]!, security: true, suggestion: "return fallback;", citations: ["AGENTS.md"] },
          ],
        },
      }),
    );

    const body = mocks.createPullRequestReview.mock.calls[0][4].comments[0].body as string;
    expect(body).toContain("🔴 **[P1 · 🔐 security] Handle the failure**");
    expect(body).toContain("```suggestion\nreturn fallback;\n```");
    expect(body).toContain("**Context Used:** `AGENTS.md`");
  });

  it("updates the existing managed summary instead of creating another", async () => {
    mocks.listPrIssueComments.mockResolvedValue([
      { id: 99, body: "<!-- cycloid-review -->\nold", author: "cycloid", createdAt: null },
    ]);

    await publishPrReview(publishArgs({ publication: { ...publication, findings: [] } }));

    expect(mocks.updateIssueComment).toHaveBeenCalledWith("token", "acme", "repo", 99, expect.any(String));
    expect(mocks.createPrIssueComment).not.toHaveBeenCalled();
  });

  it("posts a stale-head summary and skips diff and inline review calls", async () => {
    const result = await publishPrReview(publishArgs({ currentHeadSha: "b".repeat(40) }));

    expect(result.outcome).toBe("stale_head");
    expect(mocks.getPrDiff).not.toHaveBeenCalled();
    expect(mocks.createPullRequestReview).not.toHaveBeenCalled();
    expect(mocks.createPrIssueComment).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      expect.stringContaining("PR head moved"),
    );
  });

  it("truncates large folded summaries before upserting", async () => {
    const largePublication: PrReviewPublication = {
      ...publication,
      summaryMarkdown: "s".repeat(60_000),
      findings: Array.from({ length: 40 }, (_, index) => ({
        path: "src/index.ts",
        line: 100 + index,
        side: "RIGHT",
        severity: "P2",
        title: `Folded ${index}`,
        confidence: 4,
        bodyMarkdown: "x".repeat(8_000),
      })),
    };

    await publishPrReview(publishArgs({ currentHeadSha: "b".repeat(40), publication: largePublication }));

    const body = mocks.createPrIssueComment.mock.calls[0][4] as string;
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain("[Truncated to fit GitHub comment limits.]");
  });

  it("keeps all findings in the summary when inline review creation fails", async () => {
    mocks.createPullRequestReview.mockRejectedValue(new Error("GitHub rejected review"));

    const result = await publishPrReview(publishArgs());

    expect(result).toMatchObject({ outcome: "publish_partial", inlineCommentCount: 0, foldedFindingCount: 2 });
    expect(mocks.createPrIssueComment).toHaveBeenCalledTimes(2);
    expect(mocks.createPrIssueComment.mock.calls[1][4]).toContain("Inline comments could not be posted");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "createPullRequestReview", findingCount: 1 }),
      "Inline PR review publication failed; falling back to summary",
    );
  });

  it("returns the replacement summary comment id from inline failure fallback", async () => {
    mocks.createPullRequestReview.mockRejectedValue(new Error("GitHub rejected review"));
    mocks.createPrIssueComment.mockResolvedValueOnce({ id: 55, htmlUrl: "comment-url" });
    mocks.createPrIssueComment.mockResolvedValueOnce({ id: 66, htmlUrl: "comment-url-2" });

    const result = await publishPrReview(publishArgs());

    expect(result.summaryCommentId).toBe(66);
  });

  it("drops below-threshold findings before inline and folded rendering", async () => {
    const result = await publishPrReview(
      publishArgs({
        publication: {
          ...publication,
          findings: [
            publication.findings[0]!,
            publication.findings[1]!,
            {
              path: "src/index.ts",
              line: 11,
              side: "RIGHT",
              severity: "P2",
              title: "Dropped inline",
              confidence: 2,
              bodyMarkdown: "This should not render inline.",
            },
            {
              path: "src/index.ts",
              line: 40,
              side: "RIGHT",
              severity: "P2",
              title: "Dropped folded",
              confidence: 1,
              bodyMarkdown: "This should not render in the summary.",
            },
          ],
        },
      }),
    );

    expect(result).toMatchObject({ inlineCommentCount: 1, foldedFindingCount: 1 });
    expect(mocks.createPullRequestReview.mock.calls[0][4].comments).toEqual([
      expect.objectContaining({ body: expect.stringContaining("Handle the failure") }),
    ]);
    const summaryBody = mocks.createPrIssueComment.mock.calls[0][4] as string;
    expect(summaryBody).toContain("Outside the hunk");
    expect(summaryBody).not.toContain("Dropped inline");
    expect(summaryBody).not.toContain("Dropped folded");
    expect(logger.info).toHaveBeenCalledWith(
      {
        sessionId: "session-1",
        prUrl: "https://github.com/acme/repo/pull/42",
        droppedCount: 2,
        keptCount: 2,
      },
      "Filtered PR review findings by confidence",
    );
  });

  it("keeps missing confidence during deploy skew", async () => {
    const { confidence: _confidence, ...findingWithoutConfidence } = publication.findings[0]!;

    const result = await publishPrReview(
      publishArgs({
        publication: {
          ...publication,
          findings: [findingWithoutConfidence],
        },
      }),
    );

    expect(result).toMatchObject({ inlineCommentCount: 1, foldedFindingCount: 0 });
    expect(mocks.createPullRequestReview).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({
        comments: [expect.objectContaining({ body: expect.stringContaining("Handle the failure") })],
      }),
    );
  });
});
