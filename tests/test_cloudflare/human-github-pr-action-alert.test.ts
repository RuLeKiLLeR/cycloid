import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import {
  buildHumanGithubPrActionAlertText,
  notifyHumanGithubPrAction,
} from "../../apps/control-plane-worker/src/session/human-github-pr-action-alert";
import { SESSION_MONITORING_CHANNEL_ID } from "../../apps/control-plane-worker/src/slack/internal-channels";

const mockPostInternalAlert = vi.fn();
const mockListSessionIdsByWebhookRef = vi.fn();
const mockClaimWebhookIdempotency = vi.fn();
const mockReleaseWebhookIdempotencyClaim = vi.fn();
const mockGetSessionIndexBusinessId = vi.fn();

vi.mock("../../apps/control-plane-worker/src/slack/internal-alerts", () => ({
  postInternalAlert: (...args: unknown[]) => mockPostInternalAlert(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/business-id", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/control-plane-worker/src/session/business-id")>();
  return {
    ...actual,
    getSessionIndexBusinessId: (...args: unknown[]) => mockGetSessionIndexBusinessId(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/webhooks/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/control-plane-worker/src/webhooks/db")>();
  return {
    ...actual,
    claimWebhookIdempotency: (...args: unknown[]) => mockClaimWebhookIdempotency(...args),
    listSessionIdsByWebhookRef: (...args: unknown[]) => mockListSessionIdsByWebhookRef(...args),
    releaseWebhookIdempotencyClaim: (...args: unknown[]) => mockReleaseWebhookIdempotencyClaim(...args),
  };
});

const env = {
  DB: {} as D1Database,
  FRONTEND_URL: "https://app.trycycloid.com",
  SLACK_BOT_TOKEN: "xoxb-test",
};

describe("human GitHub PR action alert", () => {
  beforeEach(() => {
    mockPostInternalAlert.mockReset().mockResolvedValue({ ok: true, channel: SESSION_MONITORING_CHANNEL_ID });
    mockClaimWebhookIdempotency.mockReset().mockResolvedValue(true);
    mockListSessionIdsByWebhookRef.mockReset().mockResolvedValue(["session-1234567890"]);
    mockReleaseWebhookIdempotencyClaim.mockReset().mockResolvedValue(undefined);
    // Default to an external customer business so the base cases post.
    mockGetSessionIndexBusinessId.mockReset().mockResolvedValue("biz-customer");
  });

  it("formats a metadata-only Slack alert with PR and session links", () => {
    const text = buildHumanGithubPrActionAlertText(env, {
      deliveryId: "delivery-1",
      prUrl: "https://github.com/acme/app/pull/42",
      prNumber: 42,
      repoOwner: "acme",
      repoName: "app",
      actorLogin: "octocat",
      actorType: "User",
      actionKind: "issue_comment",
      sessionIds: ["session-1234567890"],
    });

    expect(text).toContain("*Human comment on a Cycloid-authored PR*");
    expect(text).toContain("<https://github.com/acme/app/pull/42|acme/app#42>");
    expect(text).toContain(
      "Comment by: <https://github.com/octocat|@octocat> — GitHub account on the PR, not necessarily a Cycloid user",
    );
    expect(text).toContain("<https://app.trycycloid.com/sessions/session-1234567890|session-1234...>");
    expect(text).not.toContain("delivery-1");
  });

  it("posts human actions for tracked Cycloid PRs to session monitoring", async () => {
    await expect(
      notifyHumanGithubPrAction({
        env,
        deliveryId: "delivery-1",
        prUrl: "https://github.com/acme/app/pull/42",
        prNumber: 42,
        repoOwner: "acme",
        repoName: "app",
        actorLogin: "octocat",
        actorType: "User",
        actionKind: "pull_request_review",
        reviewId: 9001,
      }),
    ).resolves.toBe(true);

    expect(mockListSessionIdsByWebhookRef).toHaveBeenCalledWith(
      env.DB,
      "github_pr_url",
      "https://github.com/acme/app/pull/42",
    );
    expect(mockPostInternalAlert).toHaveBeenCalledWith(
      env,
      SESSION_MONITORING_CHANNEL_ID,
      expect.stringContaining("*Human review on a Cycloid-authored PR*"),
      undefined,
      expect.objectContaining({
        prNumber: 42,
        repoOwner: "acme",
        repoName: "app",
        actorLogin: "octocat",
        actionKind: "pull_request_review",
        reviewId: 9001,
        commentId: null,
        deliveryId: "delivery-1",
      }),
    );
  });

  it("dedupes review and inline review comment alerts for the same GitHub review", async () => {
    const claimedKeys = new Set<string>();
    mockClaimWebhookIdempotency.mockImplementation(async (_db, _source, idempotencyKey) => {
      if (claimedKeys.has(String(idempotencyKey))) return false;
      claimedKeys.add(String(idempotencyKey));
      return true;
    });

    await expect(
      notifyHumanGithubPrAction({
        env,
        deliveryId: "delivery-review-comment",
        prUrl: "https://github.com/acme/app/pull/42",
        prNumber: 42,
        repoOwner: "acme",
        repoName: "app",
        actorLogin: "octocat",
        actorType: "User",
        actionKind: "pull_request_review_comment",
        reviewId: 9001,
        commentId: 9101,
      }),
    ).resolves.toBe(true);

    await expect(
      notifyHumanGithubPrAction({
        env,
        deliveryId: "delivery-review",
        prUrl: "https://github.com/acme/app/pull/42",
        prNumber: 42,
        repoOwner: "acme",
        repoName: "app",
        actorLogin: "octocat",
        actorType: "User",
        actionKind: "pull_request_review",
        reviewId: 9001,
      }),
    ).resolves.toBe(false);

    expect(mockPostInternalAlert).toHaveBeenCalledTimes(1);
    expect(mockClaimWebhookIdempotency).toHaveBeenNthCalledWith(
      1,
      env.DB,
      "human_github_pr_action_alert",
      "human_github_pr_action_alert:review:acme/app#42:9001",
      null,
    );
    expect(mockClaimWebhookIdempotency).toHaveBeenNthCalledWith(
      2,
      env.DB,
      "human_github_pr_action_alert",
      "human_github_pr_action_alert:review:acme/app#42:9001",
      null,
    );
  });

  it("releases the alert claim when Slack returns a failed response", async () => {
    mockPostInternalAlert.mockResolvedValueOnce({ ok: false, error: "ratelimited" });

    await expect(
      notifyHumanGithubPrAction({
        env,
        deliveryId: "delivery-1",
        prUrl: "https://github.com/acme/app/pull/42",
        prNumber: 42,
        repoOwner: "acme",
        repoName: "app",
        actorLogin: "octocat",
        actorType: "User",
        actionKind: "pull_request_review",
        reviewId: 9001,
      }),
    ).resolves.toBe(false);

    expect(mockReleaseWebhookIdempotencyClaim).toHaveBeenCalledWith(
      env.DB,
      "human_github_pr_action_alert",
      "human_github_pr_action_alert:review:acme/app#42:9001",
    );
  });

  it("releases the alert claim when Slack posting throws", async () => {
    mockPostInternalAlert.mockRejectedValueOnce(new Error("slack timeout"));

    await expect(
      notifyHumanGithubPrAction({
        env,
        deliveryId: "delivery-1",
        prUrl: "https://github.com/acme/app/pull/42",
        prNumber: 42,
        repoOwner: "acme",
        repoName: "app",
        actorLogin: "octocat",
        actorType: "User",
        actionKind: "pull_request_review",
        reviewId: 9001,
      }),
    ).rejects.toThrow("slack timeout");

    expect(mockReleaseWebhookIdempotencyClaim).toHaveBeenCalledWith(
      env.DB,
      "human_github_pr_action_alert",
      "human_github_pr_action_alert:review:acme/app#42:9001",
    );
  });

  it("suppresses internal Cycloid-business PRs without claiming idempotency or posting", async () => {
    mockGetSessionIndexBusinessId.mockResolvedValue(SEEDED_BUSINESS_IDS.cycloid);

    await expect(
      notifyHumanGithubPrAction({
        env,
        deliveryId: "delivery-internal",
        prUrl: "https://github.com/trycycloid/cycloid/pull/7119",
        prNumber: 7119,
        repoOwner: "trycycloid",
        repoName: "cycloid",
        actorLogin: "josiah-arcanist",
        actorType: "User",
        actionKind: "issue_comment",
        commentId: 555,
      }),
    ).resolves.toBe(false);

    // Business is resolved from the PR's first linked session.
    expect(mockGetSessionIndexBusinessId).toHaveBeenCalledWith(env.DB, "session-1234567890");
    // Suppressed before the idempotency claim / post so no key is claimed for a dropped alert.
    expect(mockClaimWebhookIdempotency).not.toHaveBeenCalled();
    expect(mockPostInternalAlert).not.toHaveBeenCalled();
  });

  it("suppresses the QA-seeded Cycloid business too", async () => {
    mockGetSessionIndexBusinessId.mockResolvedValue(SEEDED_BUSINESS_IDS.cycloidQa);

    await expect(
      notifyHumanGithubPrAction({
        env,
        prUrl: "https://github.com/trycycloid/cycloid/pull/7119",
        prNumber: 7119,
        repoOwner: "trycycloid",
        repoName: "cycloid",
        actorLogin: "josiah-arcanist",
        actorType: "User",
        actionKind: "issue_comment",
        commentId: 556,
      }),
    ).resolves.toBe(false);
    expect(mockPostInternalAlert).not.toHaveBeenCalled();
  });

  it("still posts for external customer PRs", async () => {
    mockGetSessionIndexBusinessId.mockResolvedValue(SEEDED_BUSINESS_IDS.armory);

    await expect(
      notifyHumanGithubPrAction({
        env,
        deliveryId: "delivery-customer",
        prUrl: "https://github.com/openevidence/xyla/pull/7",
        prNumber: 7,
        repoOwner: "openevidence",
        repoName: "xyla",
        actorLogin: "octocat",
        actorType: "User",
        actionKind: "issue_comment",
        commentId: 777,
      }),
    ).resolves.toBe(true);

    expect(mockPostInternalAlert).toHaveBeenCalledTimes(1);
  });

  it("posts (fail open) when the linked session's business cannot be resolved", async () => {
    mockGetSessionIndexBusinessId.mockResolvedValue(null);

    await expect(
      notifyHumanGithubPrAction({
        env,
        deliveryId: "delivery-unknown-business",
        prUrl: "https://github.com/openevidence/xyla/pull/8",
        prNumber: 8,
        repoOwner: "openevidence",
        repoName: "xyla",
        actorLogin: "octocat",
        actorType: "User",
        actionKind: "issue_comment",
        commentId: 888,
      }),
    ).resolves.toBe(true);

    expect(mockPostInternalAlert).toHaveBeenCalledTimes(1);
  });

  it("posts (fail open) when the business lookup throws", async () => {
    mockGetSessionIndexBusinessId.mockRejectedValue(new Error("D1 unavailable"));

    await expect(
      notifyHumanGithubPrAction({
        env,
        deliveryId: "delivery-lookup-error",
        prUrl: "https://github.com/openevidence/xyla/pull/9",
        prNumber: 9,
        repoOwner: "openevidence",
        repoName: "xyla",
        actorLogin: "octocat",
        actorType: "User",
        actionKind: "issue_comment",
        commentId: 999,
      }),
    ).resolves.toBe(true);

    expect(mockPostInternalAlert).toHaveBeenCalledTimes(1);
  });

  it("skips bot actors and untracked PRs", async () => {
    await expect(
      notifyHumanGithubPrAction({
        env,
        prUrl: "https://github.com/acme/app/pull/42",
        prNumber: 42,
        repoOwner: "acme",
        repoName: "app",
        actorLogin: "coderabbitai[bot]",
        actorType: "Bot",
        actionKind: "pull_request_review_comment",
      }),
    ).resolves.toBe(false);
    expect(mockListSessionIdsByWebhookRef).not.toHaveBeenCalled();

    mockListSessionIdsByWebhookRef.mockResolvedValueOnce([]);
    await expect(
      notifyHumanGithubPrAction({
        env,
        prUrl: "https://github.com/acme/app/pull/42",
        prNumber: 42,
        repoOwner: "acme",
        repoName: "app",
        actorLogin: "octocat",
        actorType: "User",
        actionKind: "issue_comment",
      }),
    ).resolves.toBe(false);
    expect(mockPostInternalAlert).not.toHaveBeenCalled();
  });
});
