import { beforeEach, describe, expect, it, vi } from "vitest";

import { decideReviewAckReaction } from "../../apps/control-plane-worker/src/webhooks/review-ack-reaction";

const mockPostIssueCommentReaction = vi.hoisted(() => vi.fn());
const mockPostReviewCommentReaction = vi.hoisted(() => vi.fn());
const mockGetPrReviewComments = vi.hoisted(() => vi.fn());
const mockCreateInstallationToken = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/github/issues", () => ({
  GITHUB_REVIEW_ACK_REACTION: "eyes",
  postIssueCommentReaction: (...a: unknown[]) => mockPostIssueCommentReaction(...a),
  postReviewCommentReaction: (...a: unknown[]) => mockPostReviewCommentReaction(...a),
}));
vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getPrReviewComments: (...a: unknown[]) => mockGetPrReviewComments(...a),
}));
vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...a: unknown[]) => mockCreateInstallationToken(...a),
}));

describe("decideReviewAckReaction", () => {
  it("reacts to a human review", () => {
    expect(
      decideReviewAckReaction({ actorLogin: "octocat", actorType: "User", body: "please fix the null check" }),
    ).toEqual({ react: true });
  });

  it("reacts to a human review with an empty body (inline-only review)", () => {
    expect(decideReviewAckReaction({ actorLogin: "octocat", actorType: "User", body: "" })).toEqual({ react: true });
  });

  it("skips a Cycloid-owned author (cycloid-qa[bot] QA verdict)", () => {
    expect(
      decideReviewAckReaction({ actorLogin: "cycloid-qa[bot]", actorType: "Bot", body: "app_breaks: login fails" }),
    ).toEqual({ react: false, reason: "owned" });
  });

  it("skips a known bot's no-findings placeholder", () => {
    expect(
      decideReviewAckReaction({ actorLogin: "greptile-apps[bot]", actorType: "Bot", body: "No issues found." }),
    ).toEqual({ react: false, reason: "noise" });
  });

  it("skips a known bot's in-progress placeholder", () => {
    expect(
      decideReviewAckReaction({
        actorLogin: "greptile-apps[bot]",
        actorType: "Bot",
        body: "Security review in progress.",
      }),
    ).toEqual({ react: false, reason: "noise" });
  });

  it("reacts to a known bot review that carries real feedback", () => {
    expect(
      decideReviewAckReaction({
        actorLogin: "greptile-apps[bot]",
        actorType: "Bot",
        body: "This dereferences a null pointer on line 40.",
      }),
    ).toEqual({ react: true });
  });

  it("reacts to a custom (unknown) bot — never noise-gated", () => {
    expect(
      decideReviewAckReaction({ actorLogin: "acme-review-bot[bot]", actorType: "Bot", body: "No issues found." }),
    ).toEqual({ react: true });
  });
});

describe("runReviewAckReaction", () => {
  const env = {} as import("../../apps/control-plane-worker/src/types").Env;

  beforeEach(() => {
    mockPostIssueCommentReaction.mockReset().mockResolvedValue(undefined);
    mockPostReviewCommentReaction.mockReset().mockResolvedValue(undefined);
    mockGetPrReviewComments.mockReset().mockResolvedValue([]);
    mockCreateInstallationToken.mockReset().mockResolvedValue("ghs_x");
  });

  it("reacts on a top-level issue comment", async () => {
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: { kind: "issue_comment", commentId: 111, body: "please fix" },
    });
    expect(mockPostIssueCommentReaction).toHaveBeenCalledWith(env, 7, "acme", "repo", 111, "eyes");
    expect(r).toEqual({ posted: 1, skipped: null, cappedFrom: null });
  });

  it("reacts on a single inline review comment", async () => {
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: { kind: "review_comment", commentId: 222, body: "nit" },
    });
    expect(mockPostReviewCommentReaction).toHaveBeenCalledWith(env, 7, "acme", "repo", 222, "eyes");
    expect(r).toEqual({ posted: 1, skipped: null, cappedFrom: null });
  });

  it("reacts on each inline comment of a review submission (pre-supplied)", async () => {
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: {
        kind: "review_submission",
        reviewId: 900,
        reviewBody: "",
        prNumber: 3,
        inlineComments: [
          { id: 1, reviewId: 900 },
          { id: 2, reviewId: 900 },
          { id: 3, reviewId: 999 },
        ],
      },
    });
    expect(mockGetPrReviewComments).not.toHaveBeenCalled();
    expect(mockPostReviewCommentReaction).toHaveBeenCalledTimes(2); // 3 belongs to a different review
    expect(r).toEqual({ posted: 2, skipped: null, cappedFrom: null });
  });

  it("fetches inline comments for a review submission when not pre-supplied", async () => {
    mockGetPrReviewComments.mockResolvedValue([
      { id: 5, reviewId: 900 },
      { id: 6, reviewId: 900 },
    ]);
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "greptile-apps[bot]",
      actorType: "Bot",
      surface: { kind: "review_submission", reviewId: 900, reviewBody: "", prNumber: 3 },
    });
    expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 7);
    expect(mockGetPrReviewComments).toHaveBeenCalledWith("ghs_x", "acme", "repo", 3);
    expect(r.posted).toBe(2);
  });

  it("caps inline fan-out at 50 and reports cappedFrom", async () => {
    const inlineComments = Array.from({ length: 63 }, (_, i) => ({ id: i + 1, reviewId: 900 }));
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: { kind: "review_submission", reviewId: 900, reviewBody: "", prNumber: 3, inlineComments },
    });
    expect(mockPostReviewCommentReaction).toHaveBeenCalledTimes(50);
    expect(r).toEqual({ posted: 50, skipped: null, cappedFrom: 63 });
  });

  it("reacts to inline comments of a KNOWN bot review even when the summary reads as no-findings noise", async () => {
    // Fix 1: review_submission is owned-only gated; the summary body no longer blocks inline acks.
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "greptile-apps[bot]",
      actorType: "Bot",
      surface: {
        kind: "review_submission",
        reviewId: 900,
        reviewBody: "LGTM", // a no-findings phrase that WOULD gate a single-body surface
        prNumber: 3,
        inlineComments: [
          { id: 1, reviewId: 900 },
          { id: 2, reviewId: 900 },
        ],
      },
    });
    expect(mockPostReviewCommentReaction).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ posted: 2, skipped: null, cappedFrom: null });
  });

  it("still skips a review submission from a Cycloid-owned author (owned gate binds)", async () => {
    // Fix 1: dropping the summary noise-gate must NOT drop the owned-author gate on this surface.
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "cycloid-qa[bot]",
      actorType: "Bot",
      surface: {
        kind: "review_submission",
        reviewId: 900,
        reviewBody: "app_breaks: login fails",
        prNumber: 3,
        inlineComments: [{ id: 1, reviewId: 900 }],
      },
    });
    expect(mockGetPrReviewComments).not.toHaveBeenCalled();
    expect(mockPostReviewCommentReaction).not.toHaveBeenCalled();
    expect(r).toEqual({ posted: 0, skipped: "owned", cappedFrom: null });
  });

  it("isolates a failing inline post — the other reactions land and the task does not reject", async () => {
    // Fix 2: one rejection (e.g. a 404 on a deleted comment) must not strand the rest.
    mockPostReviewCommentReaction
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("404 comment deleted"))
      .mockResolvedValueOnce(undefined);
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: {
        kind: "review_submission",
        reviewId: 900,
        reviewBody: "",
        prNumber: 3,
        inlineComments: [
          { id: 1, reviewId: 900 },
          { id: 2, reviewId: 900 },
          { id: 3, reviewId: 900 },
        ],
      },
    });
    expect(mockPostReviewCommentReaction).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ posted: 2, skipped: null, cappedFrom: null });
  });

  it("no-ops a review submission with a null reviewId (no fetch, no posts)", async () => {
    // Fix 3: a null reviewId must not wildcard-match every comment whose reviewId is also null.
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: { kind: "review_submission", reviewId: null, reviewBody: "", prNumber: 3 },
    });
    expect(mockGetPrReviewComments).not.toHaveBeenCalled();
    expect(mockPostReviewCommentReaction).not.toHaveBeenCalled();
    expect(r).toEqual({ posted: 0, skipped: null, cappedFrom: null });
  });

  it("skips (no post) for an owned author", async () => {
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "cycloid-qa[bot]",
      actorType: "Bot",
      surface: { kind: "issue_comment", commentId: 111, body: "app_breaks" },
    });
    expect(mockPostIssueCommentReaction).not.toHaveBeenCalled();
    expect(r).toEqual({ posted: 0, skipped: "owned", cappedFrom: null });
  });

  it("no-ops when installationId is null", async () => {
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: null,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: { kind: "issue_comment", commentId: 111, body: "x" },
    });
    expect(mockPostIssueCommentReaction).not.toHaveBeenCalled();
    expect(r).toEqual({ posted: 0, skipped: null, cappedFrom: null });
  });
});
