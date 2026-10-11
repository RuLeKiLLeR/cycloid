import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateInstallationToken = vi.hoisted(() => vi.fn());
const mockTracedFetch = vi.hoisted(() => vi.fn());

vi.mock("../../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: (...args: unknown[]) => mockTracedFetch(...args),
}));

describe("github/issues", () => {
  beforeEach(() => {
    mockCreateInstallationToken.mockReset().mockResolvedValue("ghs_installation");
    mockTracedFetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ id: 99 }), { status: 201 }));
  });

  it("posts an issue-comment reaction with the installation token", async () => {
    const { postIssueCommentReaction } = await import("../../../apps/control-plane-worker/src/github/issues");
    const env = {} as Parameters<typeof postIssueCommentReaction>[0];

    await postIssueCommentReaction(env, 123, "acme", "repo", 987, "eyes");

    expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 123);
    expect(mockTracedFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/issues/comments/987/reactions",
      {
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer ghs_installation",
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ content: "eyes" }),
      },
      "github.postIssueCommentReaction",
    );
  });

  it("uses the supported +1 reaction content for finished QA", async () => {
    const { GITHUB_QA_FINISHED_REACTION, postIssueCommentReaction } =
      await import("../../../apps/control-plane-worker/src/github/issues");
    const env = {} as Parameters<typeof postIssueCommentReaction>[0];

    await postIssueCommentReaction(env, 123, "acme", "repo", 987, GITHUB_QA_FINISHED_REACTION);

    const options = mockTracedFetch.mock.calls[0]?.[1] as { body?: string };
    expect(JSON.parse(options.body ?? "{}")).toEqual({ content: "+1" });
  });

  it("posts an inline review-comment reaction to the pulls/comments endpoint", async () => {
    const { postReviewCommentReaction, GITHUB_REVIEW_ACK_REACTION } =
      await import("../../../apps/control-plane-worker/src/github/issues");
    const env = {} as Parameters<typeof postReviewCommentReaction>[0];

    await postReviewCommentReaction(env, 123, "acme", "repo", 555, GITHUB_REVIEW_ACK_REACTION);

    expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 123);
    expect(mockTracedFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/pulls/comments/555/reactions",
      {
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer ghs_installation",
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ content: "eyes" }),
      },
      "github.postReviewCommentReaction",
    );
  });
});
