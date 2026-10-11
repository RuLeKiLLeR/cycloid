import { describe, expect, it } from "vitest";

import {
  buildPrActivityEventInput,
  extractPrActivityRef,
  type PrActivityPrRef,
} from "../../apps/control-plane-worker/src/webhooks/pr-activity-capture";

const REPO = { name: "repo", owner: { login: "acme" }, private: true };
const INSTALLATION = { id: 42 };

function user(login: string, type = "User", extra: Record<string, unknown> = {}) {
  return { id: 1, login, type, email: `${login}@example.com`, avatar_url: `https://avatars/${login}`, ...extra };
}

function build(eventType: string, payload: Record<string, unknown>, deliveryId: string | null = "d-1") {
  const prRef = extractPrActivityRef(eventType, payload) as PrActivityPrRef;
  return buildPrActivityEventInput({ eventType, payload, prRef, deliveryId, sessionId: "sess-1", receivedAt: 9_000 });
}

function issueComment(over: Record<string, unknown> = {}, action = "created", isPr = true) {
  return {
    action,
    issue: {
      number: 7,
      html_url: "https://github.com/acme/repo/issues/7",
      ...(isPr ? { pull_request: { html_url: "https://github.com/acme/repo/pull/7" } } : {}),
    },
    comment: {
      id: 100,
      body: "top-level comment",
      user: user("octocat"),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      ...over,
    },
    sender: user("octocat"),
    repository: REPO,
    installation: INSTALLATION,
  };
}

function review(over: Record<string, unknown> = {}, action = "submitted", sender = user("reviewer")) {
  return {
    action,
    review: {
      id: 200,
      state: "changes_requested",
      body: "please fix",
      user: user("reviewer"),
      submitted_at: "2026-03-01T00:00:00Z",
      ...over,
    },
    pull_request: { number: 7, html_url: "https://github.com/acme/repo/pull/7", head: { sha: "sha7" } },
    sender,
    repository: REPO,
    installation: INSTALLATION,
  };
}

function reviewComment(over: Record<string, unknown> = {}, action = "created") {
  return {
    action,
    comment: {
      id: 300,
      body: "inline nit",
      user: user("octocat"),
      path: "src/app.ts",
      line: 12,
      original_line: 8,
      side: "RIGHT",
      diff_hunk: "@@ -1 +1 @@",
      in_reply_to_id: 299,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-02T00:00:00Z",
      ...over,
    },
    pull_request: { number: 7, html_url: "https://github.com/acme/repo/pull/7", head: { sha: "sha7" } },
    sender: user("octocat"),
    repository: REPO,
    installation: INSTALLATION,
  };
}

function pullRequest(over: Record<string, unknown> = {}, action = "opened", sender = user("octocat")) {
  return {
    action,
    pull_request: {
      number: 7,
      html_url: "https://github.com/acme/repo/pull/7",
      title: "My PR",
      body: "PR description",
      user: user("octocat"),
      head: { sha: "sha7" },
      created_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
      ...over,
    },
    sender,
    repository: REPO,
    installation: INSTALLATION,
  };
}

function captured(result: ReturnType<typeof build>) {
  if (result.kind !== "capture") throw new Error(`expected capture, got ${result.kind}`);
  return result.input;
}

describe("extractPrActivityRef", () => {
  it("resolves the PR ref for an issue_comment on a PR", () => {
    expect(extractPrActivityRef("issue_comment", issueComment())).toEqual({
      prUrl: "https://github.com/acme/repo/pull/7",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 7,
      installationId: 42,
      headSha: null,
    });
  });

  it("returns null for an issue_comment on a plain issue", () => {
    expect(extractPrActivityRef("issue_comment", issueComment({}, "created", false))).toBeNull();
  });

  it("resolves head sha for review-comment events", () => {
    expect(extractPrActivityRef("pull_request_review_comment", reviewComment())?.headSha).toBe("sha7");
  });

  it("returns null when the PR identity is missing", () => {
    const payload = pullRequest();
    delete (payload.pull_request as Record<string, unknown>).html_url;
    expect(extractPrActivityRef("pull_request", payload)).toBeNull();
  });

  it("does not fall back to the issue URL when a PR issue_comment lacks pull_request.html_url", () => {
    // The issues URL (.../issues/N) never matches pr_coordination's pull URL, so it
    // must resolve to null (skip) rather than a mismatching prUrl.
    const payload = issueComment();
    delete ((payload.issue as Record<string, unknown>).pull_request as Record<string, unknown>).html_url;
    expect(extractPrActivityRef("issue_comment", payload)).toBeNull();
  });
});

describe("buildPrActivityEventInput — per event type", () => {
  it("issue_comment created: body, unix-ms timestamps, occurred_at = created", () => {
    const input = captured(build("issue_comment", issueComment()));
    expect(input).toMatchObject({
      eventType: "issue_comment",
      action: "created",
      subjectId: "100",
      body: "top-level comment",
      githubCreatedAt: Date.parse("2026-01-01T00:00:00Z"),
      githubUpdatedAt: Date.parse("2026-01-02T00:00:00Z"),
      occurredAt: Date.parse("2026-01-01T00:00:00Z"),
    });
  });

  it("issue_comment edited: occurred_at = updated", () => {
    const input = captured(build("issue_comment", issueComment({}, "edited")));
    expect(input.action).toBe("edited");
    expect(input.occurredAt).toBe(Date.parse("2026-01-02T00:00:00Z"));
  });

  it("issue_comment deleted: occurred_at falls back to received_at", () => {
    const input = captured(build("issue_comment", issueComment({}, "deleted")));
    expect(input.action).toBe("deleted");
    expect(input.occurredAt).toBe(9_000);
  });

  it("pull_request_review submitted: review_state + occurred_at = submitted", () => {
    const input = captured(build("pull_request_review", review()));
    expect(input).toMatchObject({
      eventType: "pull_request_review",
      action: "submitted",
      subjectId: "200",
      reviewState: "changes_requested",
      body: "please fix",
      occurredAt: Date.parse("2026-03-01T00:00:00Z"),
    });
  });

  it("pull_request_review dismissed: occurred_at falls back to received_at", () => {
    const input = captured(build("pull_request_review", review({ state: "dismissed" }, "dismissed")));
    expect(input.action).toBe("dismissed");
    expect(input.reviewState).toBe("dismissed");
    expect(input.occurredAt).toBe(9_000);
  });

  it("pull_request_review edited: occurred_at falls back to received_at", () => {
    const input = captured(build("pull_request_review", review({}, "edited")));
    expect(input.occurredAt).toBe(9_000);
  });

  it("pull_request_review_comment: path/line/side/diff_hunk/in_reply_to", () => {
    const input = captured(build("pull_request_review_comment", reviewComment()));
    expect(input).toMatchObject({
      subjectId: "300",
      filePath: "src/app.ts",
      line: 12,
      side: "RIGHT",
      diffHunk: "@@ -1 +1 @@",
      inReplyToId: "299",
    });
  });

  it("pull_request_review_comment falls back to original_line when line is absent", () => {
    const input = captured(build("pull_request_review_comment", reviewComment({ line: null })));
    expect(input.line).toBe(8);
  });

  it("pull_request opened: title in raw_json, body in column, occurred_at = created", () => {
    const input = captured(build("pull_request", pullRequest()));
    expect(input.subjectId).toBeNull();
    expect(input.body).toBe("PR description");
    expect(input.occurredAt).toBe(Date.parse("2026-05-01T00:00:00Z"));
    expect(JSON.parse(input.rawJson).title).toBe("My PR");
  });

  it("pull_request closed: occurred_at falls back to received_at", () => {
    const input = captured(build("pull_request", pullRequest({}, "closed")));
    expect(input.action).toBe("closed");
    expect(input.occurredAt).toBe(9_000);
  });
});

describe("buildPrActivityEventInput — identity, classification, redaction, caps", () => {
  it("distinguishes the action actor (sender) from the content author", () => {
    // A maintainer deletes someone else's comment.
    const payload = issueComment({ user: user("original-author") }, "deleted");
    payload.sender = user("maintainer");
    const input = captured(build("issue_comment", payload));
    expect(input.actorLogin).toBe("maintainer");
    expect(input.subjectAuthorLogin).toBe("original-author");
  });

  it("classifies actor_class: human, bot, cycloid", () => {
    expect(captured(build("issue_comment", issueComment())).actorClass).toBe("human");

    const botPayload = issueComment();
    botPayload.sender = user("greptileai", "Bot");
    expect(captured(build("issue_comment", botPayload)).actorClass).toBe("bot");

    const cycloidPayload = issueComment();
    cycloidPayload.sender = user("cycloid-app", "Bot");
    // cycloid-app may or may not be in the owned set; assert bot-or-cycloid, never human.
    expect(["bot", "cycloid"]).toContain(captured(build("issue_comment", cycloidPayload)).actorClass);
  });

  it("omits incidental PII (user.email / avatar_url) from raw_json", () => {
    const input = captured(build("issue_comment", issueComment()));
    expect(input.rawJson).not.toContain("@example.com");
    expect(input.rawJson).not.toContain("avatars/");
  });

  it("redacts secrets in the body column and in raw_json", () => {
    const secretBody = "here is a token ghs_0123456789abcdefghij do not leak";
    const payload = pullRequest({ body: secretBody, title: "token sk-ant-0123456789abcdefghij here" });
    const input = captured(build("pull_request", payload));
    expect(input.body).toContain("[REDACTED]");
    expect(input.body).not.toContain("ghs_0123456789abcdefghij");
    // title lives in raw_json (whitelisted) — its secret must be redacted too.
    expect(input.rawJson).toContain("[REDACTED]");
    expect(input.rawJson).not.toContain("sk-ant-0123456789abcdefghij");
  });

  it("caps an oversized body with a truncation marker", () => {
    const huge = "x".repeat(70_000);
    const input = captured(build("issue_comment", issueComment({ body: huge })));
    expect(input.body).not.toBeNull();
    expect((input.body as string).length).toBeLessThanOrEqual(65_536);
    expect(input.body).toContain("truncated");
  });

  it("replaces an oversized raw_json with a truncation marker object", () => {
    const input = captured(build("pull_request", pullRequest({ title: "t".repeat(70_000) })));
    const parsed = JSON.parse(input.rawJson);
    expect(parsed.__truncated__).toBe(true);
    expect(parsed.eventType).toBe("pull_request");
  });
});

describe("buildPrActivityEventInput — malformed", () => {
  it("is malformed when the delivery id is missing", () => {
    const result = build("issue_comment", issueComment(), null);
    expect(result.kind).toBe("malformed");
  });

  it("is malformed when the action is missing", () => {
    const payload = issueComment();
    delete (payload as Record<string, unknown>).action;
    const result = build("issue_comment", payload);
    expect(result.kind).toBe("malformed");
  });
});
