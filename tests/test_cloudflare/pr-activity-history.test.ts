import { describe, expect, it } from "vitest";

import type { PrActivityEvent } from "../../apps/control-plane-worker/src/session/pr-activity-events-db";
import { reconstructPrConversation } from "../../apps/control-plane-worker/src/session/pr-activity-history";

let nextId = 1;

function ev(over: Partial<PrActivityEvent>): PrActivityEvent {
  return {
    id: nextId++,
    deliveryId: `d-${nextId}`,
    sessionId: "sess-1",
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 7,
    prUrl: "https://github.com/acme/repo/pull/7",
    installationId: 42,
    eventType: "pull_request_review_comment",
    action: "created",
    subjectId: "1",
    inReplyToId: null,
    reviewState: null,
    actorLogin: "octocat",
    actorType: "User",
    actorClass: "human",
    subjectAuthorLogin: "octocat",
    subjectAuthorType: "User",
    body: null,
    filePath: null,
    line: null,
    side: null,
    diffHunk: null,
    headSha: null,
    githubCreatedAt: null,
    githubUpdatedAt: null,
    occurredAt: 0,
    receivedAt: 0,
    rawJson: "{}",
    ...over,
  };
}

describe("reconstructPrConversation", () => {
  it("folds create + edit + delete of a comment, retaining prior bodies", () => {
    const result = reconstructPrConversation([
      ev({ subjectId: "c1", action: "created", body: "first", occurredAt: 100 }),
      ev({ subjectId: "c1", action: "edited", body: "second", occurredAt: 200 }),
      ev({ subjectId: "c1", action: "deleted", body: "second", occurredAt: 300, actorLogin: "maintainer" }),
    ]);

    expect(result.subjects).toHaveLength(1);
    const c1 = result.subjects[0];
    expect(c1.currentBody).toBe("second");
    expect(c1.deleted).toBe(true);
    expect(c1.firstSeenAt).toBe(100);
    expect(c1.lastActivityAt).toBe(300);
    expect(c1.history.map((h) => h.body)).toEqual(["first", "second", "second"]);
    expect(c1.history.map((h) => h.action)).toEqual(["created", "edited", "deleted"]);
  });

  it("folds a review submitted -> edited -> dismissed, tracking current review state", () => {
    const result = reconstructPrConversation([
      ev({
        eventType: "pull_request_review",
        subjectId: "r1",
        action: "submitted",
        reviewState: "changes_requested",
        body: "needs work",
        occurredAt: 100,
      }),
      ev({
        eventType: "pull_request_review",
        subjectId: "r1",
        action: "edited",
        body: "needs a bit of work",
        occurredAt: 200,
      }),
      ev({
        eventType: "pull_request_review",
        subjectId: "r1",
        action: "dismissed",
        reviewState: "dismissed",
        occurredAt: 300,
      }),
    ]);

    expect(result.subjects).toHaveLength(1);
    const r1 = result.subjects[0];
    expect(r1.reviewState).toBe("dismissed");
    expect(r1.currentBody).toBe("needs a bit of work");
    expect(r1.history).toHaveLength(3);
  });

  it("builds the PR-level track: latest title/body, derived state, ordered timeline", () => {
    const result = reconstructPrConversation([
      ev({
        eventType: "pull_request",
        subjectId: null,
        action: "opened",
        body: "desc v1",
        rawJson: '{"title":"Title v1"}',
        occurredAt: 100,
      }),
      ev({
        eventType: "pull_request",
        subjectId: null,
        action: "edited",
        body: "desc v2",
        rawJson: '{"title":"Title v2"}',
        occurredAt: 200,
      }),
      ev({
        eventType: "pull_request",
        subjectId: null,
        action: "closed",
        body: "desc v2",
        rawJson: '{"title":"Title v2"}',
        occurredAt: 300,
      }),
    ]);

    expect(result.title).toBe("Title v2");
    expect(result.body).toBe("desc v2");
    expect(result.state).toBe("closed");
    expect(result.stateTimeline.map((s) => s.action)).toEqual(["opened", "edited", "closed"]);
    expect(result.subjects).toHaveLength(0);
  });

  it("orders subjects by first appearance and separates distinct subjects", () => {
    const result = reconstructPrConversation([
      ev({ subjectId: "later", action: "created", body: "b", occurredAt: 300 }),
      ev({ subjectId: "earlier", action: "created", body: "a", occurredAt: 100 }),
    ]);
    expect(result.subjects.map((s) => s.subjectId)).toEqual(["earlier", "later"]);
  });

  it("folds correctly even when events are passed out of order", () => {
    const result = reconstructPrConversation([
      ev({ subjectId: "c1", action: "deleted", body: "second", occurredAt: 300 }),
      ev({ subjectId: "c1", action: "created", body: "first", occurredAt: 100 }),
      ev({ subjectId: "c1", action: "edited", body: "second", occurredAt: 200 }),
    ]);
    const c1 = result.subjects[0];
    expect(c1.history.map((h) => h.action)).toEqual(["created", "edited", "deleted"]);
    expect(c1.currentBody).toBe("second");
    expect(c1.deleted).toBe(true);
  });

  it("carries inline-comment location and the content author distinctly from the actor", () => {
    const result = reconstructPrConversation([
      ev({
        subjectId: "c1",
        action: "created",
        body: "nit",
        filePath: "src/app.ts",
        line: 12,
        subjectAuthorLogin: "author",
        actorLogin: "author",
        occurredAt: 100,
      }),
    ]);
    const c1 = result.subjects[0];
    expect(c1.filePath).toBe("src/app.ts");
    expect(c1.line).toBe(12);
    expect(c1.author.login).toBe("author");
  });
});
