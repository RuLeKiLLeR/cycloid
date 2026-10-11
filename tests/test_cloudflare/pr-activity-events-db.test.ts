import { beforeEach, describe, expect, it } from "vitest";

import { OFFBOARDING_SESSION_ID_TABLES } from "../../apps/control-plane-worker/src/business/offboarding-tables";
import {
  listPrActivityEvents,
  type PrActivityEventInput,
  recordPrActivityEvent,
} from "../../apps/control-plane-worker/src/session/pr-activity-events-db";
import { createControlPlaneD1 } from "./helpers/seed-db";

let db: D1Database;

beforeEach(() => {
  db = createControlPlaneD1().d1;
});

function makeInput(overrides: Partial<PrActivityEventInput> = {}): PrActivityEventInput {
  return {
    deliveryId: "delivery-1",
    sessionId: "sess-1",
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 7,
    prUrl: "https://github.com/acme/repo/pull/7",
    installationId: 42,
    eventType: "pull_request_review_comment",
    action: "created",
    subjectId: "9001",
    inReplyToId: null,
    reviewState: null,
    actorLogin: "octocat",
    actorType: "User",
    actorClass: "human",
    subjectAuthorLogin: "octocat",
    subjectAuthorType: "User",
    body: "please rename this",
    filePath: "src/app.ts",
    line: 12,
    side: "RIGHT",
    diffHunk: "@@ -1 +1 @@",
    headSha: "abc123",
    githubCreatedAt: 1_000,
    githubUpdatedAt: 1_000,
    occurredAt: 1_000,
    receivedAt: 2_000,
    rawJson: '{"body":"please rename this"}',
    ...overrides,
  };
}

describe("recordPrActivityEvent / listPrActivityEvents", () => {
  it("inserts a row and lists it back with fields intact", async () => {
    await recordPrActivityEvent(db, makeInput());

    const rows = await listPrActivityEvents(db, { repoOwner: "acme", repoName: "repo", prNumber: 7 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deliveryId: "delivery-1",
      sessionId: "sess-1",
      eventType: "pull_request_review_comment",
      action: "created",
      subjectId: "9001",
      actorLogin: "octocat",
      subjectAuthorLogin: "octocat",
      body: "please rename this",
      filePath: "src/app.ts",
      line: 12,
      side: "RIGHT",
      occurredAt: 1_000,
      receivedAt: 2_000,
    });
    expect(typeof rows[0].id).toBe("number");
  });

  it("is idempotent on delivery_id: a redelivery is a no-op and preserves the first-seen body", async () => {
    await recordPrActivityEvent(db, makeInput({ body: "original body" }));
    // Same delivery_id, different body (a redelivery must NOT overwrite).
    await recordPrActivityEvent(db, makeInput({ body: "rewritten body" }));

    const rows = await listPrActivityEvents(db, { repoOwner: "acme", repoName: "repo", prNumber: 7 });
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("original body");
  });

  it("keeps a genuine edit (new delivery_id) as its own append-only row", async () => {
    await recordPrActivityEvent(db, makeInput({ deliveryId: "d-create", action: "created", occurredAt: 1_000 }));
    await recordPrActivityEvent(
      db,
      makeInput({ deliveryId: "d-edit", action: "edited", body: "edited body", occurredAt: 2_000 }),
    );

    const rows = await listPrActivityEvents(db, { repoOwner: "acme", repoName: "repo", prNumber: 7 });
    expect(rows.map((r) => r.action)).toEqual(["created", "edited"]);
  });

  it("orders events by occurred_at then id", async () => {
    await recordPrActivityEvent(db, makeInput({ deliveryId: "d-b", occurredAt: 3_000, subjectId: "later" }));
    await recordPrActivityEvent(db, makeInput({ deliveryId: "d-a", occurredAt: 1_500, subjectId: "earlier" }));

    const rows = await listPrActivityEvents(db, { repoOwner: "acme", repoName: "repo", prNumber: 7 });
    expect(rows.map((r) => r.subjectId)).toEqual(["earlier", "later"]);
  });

  it("scopes the list to the requested PR", async () => {
    await recordPrActivityEvent(db, makeInput({ deliveryId: "d-1", prNumber: 7 }));
    await recordPrActivityEvent(db, makeInput({ deliveryId: "d-2", prNumber: 8 }));

    const rows = await listPrActivityEvents(db, { repoOwner: "acme", repoName: "repo", prNumber: 7 });
    expect(rows).toHaveLength(1);
    expect(rows[0].prNumber).toBe(7);
  });
});

describe("offboarding classification", () => {
  it("registers pr_activity_events in the session-id offboarding cascade", () => {
    // The table stores user-content bodies keyed by session, so offboarding must
    // delete it by session_id (unlike hash-only managed_pr_comments, which is skipped).
    // The dynamic business-id pass (business/db.ts) would otherwise DELETE ... WHERE
    // business_id = ? on this table, which has no business_id column.
    const entry = OFFBOARDING_SESSION_ID_TABLES.find((t) => t.table === "pr_activity_events");
    expect(entry).toEqual({ table: "pr_activity_events", column: "session_id" });
  });
});
