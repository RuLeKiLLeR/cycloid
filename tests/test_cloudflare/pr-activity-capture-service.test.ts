import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { listPrActivityEvents } from "../../apps/control-plane-worker/src/session/pr-activity-events-db";
import { capturePrActivityEvent } from "../../apps/control-plane-worker/src/webhooks/pr-activity-capture";
import { SqliteD1 } from "./sqlite-d1-helper";

let sqlite: Database.Database;
let db: D1Database;

const PR_URL = "https://github.com/acme/repo/pull/7";

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0214_pr_coordination.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0248_pr_activity_events.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

function seedCoordination(sessionId: string, prUrl: string, stateEnteredAt = 1_000): void {
  sqlite
    .prepare("INSERT INTO pr_coordination (session_id, state, pr_url, state_entered_at) VALUES (?, 'REVIEW', ?, ?)")
    .run(sessionId, prUrl, stateEnteredAt);
}

function issueCommentPayload(action = "created", prUrl = PR_URL): Record<string, unknown> {
  return {
    action,
    issue: { number: 7, html_url: "https://github.com/acme/repo/issues/7", pull_request: { html_url: prUrl } },
    comment: {
      id: 100,
      body: "a comment",
      user: { id: 1, login: "octocat", type: "User" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    sender: { id: 1, login: "octocat", type: "User" },
    repository: { name: "repo", owner: { login: "acme" } },
    installation: { id: 42 },
  };
}

function request(deliveryId: string | null = "d-1"): Request {
  const headers = new Headers();
  if (deliveryId) headers.set("x-github-delivery", deliveryId);
  return new Request("https://cp.example/webhooks/github", { method: "POST", headers });
}

async function events() {
  return listPrActivityEvents(db, { repoOwner: "acme", repoName: "repo", prNumber: 7 });
}

describe("capturePrActivityEvent", () => {
  it("captures an event on a tracked PR with the coordinating session id", async () => {
    seedCoordination("sess-real", PR_URL);
    await capturePrActivityEvent({
      env: { DB: db },
      eventType: "issue_comment",
      payload: issueCommentPayload(),
      request: request(),
    });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "sess-real",
      eventType: "issue_comment",
      action: "created",
      body: "a comment",
    });
  });

  it("skips an untracked PR (no coordination row) — data-minimization gate", async () => {
    await capturePrActivityEvent({
      env: { DB: db },
      eventType: "issue_comment",
      payload: issueCommentPayload(),
      request: request(),
    });
    expect(await events()).toHaveLength(0);
  });

  it("skips a PR that has only a synthetic coordinator (would escape offboarding)", async () => {
    seedCoordination("pr-coord:encoded-url", PR_URL);
    await capturePrActivityEvent({
      env: { DB: db },
      eventType: "issue_comment",
      payload: issueCommentPayload(),
      request: request(),
    });
    expect(await events()).toHaveLength(0);
  });

  it("prefers a real coordinator over a co-existing synthetic one", async () => {
    seedCoordination("pr-coord:encoded-url", PR_URL, 5_000);
    seedCoordination("sess-real", PR_URL, 1_000);
    await capturePrActivityEvent({
      env: { DB: db },
      eventType: "issue_comment",
      payload: issueCommentPayload(),
      request: request(),
    });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("sess-real");
  });

  it("captures deleted comments (before the created-only handler guard)", async () => {
    seedCoordination("sess-real", PR_URL);
    await capturePrActivityEvent({
      env: { DB: db },
      eventType: "issue_comment",
      payload: issueCommentPayload("deleted"),
      request: request("d-del"),
    });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("deleted");
  });

  it("skips a non-PR event (issue_comment on a plain issue) without a coordination lookup", async () => {
    const payload = issueCommentPayload();
    delete (payload.issue as Record<string, unknown>).pull_request;
    await capturePrActivityEvent({ env: { DB: db }, eventType: "issue_comment", payload, request: request() });
    expect(await events()).toHaveLength(0);
  });

  it("skips (does not throw) a malformed event missing the delivery id", async () => {
    seedCoordination("sess-real", PR_URL);
    await capturePrActivityEvent({
      env: { DB: db },
      eventType: "issue_comment",
      payload: issueCommentPayload(),
      request: request(null),
    });
    expect(await events()).toHaveLength(0);
  });

  it("is idempotent across a redelivery of the same event", async () => {
    seedCoordination("sess-real", PR_URL);
    const args = {
      env: { DB: db },
      eventType: "issue_comment",
      payload: issueCommentPayload(),
      request: request("d-same"),
    } as const;
    await capturePrActivityEvent(args);
    await capturePrActivityEvent(args);
    expect(await events()).toHaveLength(1);
  });
});
