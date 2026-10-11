import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { SlackInteractionKind } from "../../apps/control-plane-worker/src/enums/slack-interaction.js";
import { syncCardControlRequests } from "../../apps/control-plane-worker/src/slack/card-control-requests";
import { getNewestPending } from "../../apps/control-plane-worker/src/slack/interaction-requests-db.js";
import { SqliteD1 } from "./sqlite-d1-helper";

const MIGRATION_SQL = readFileSync(
  new URL("../../apps/control-plane-worker/migrations/0244_slack_interaction_requests.sql", import.meta.url),
  "utf8",
);

const NOW = 1_700_000_000_000;

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(MIGRATION_SQL);
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

function sync(stage: Parameters<typeof syncCardControlRequests>[1]["stage"], now = NOW) {
  return syncCardControlRequests(db, {
    stage,
    businessId: "biz-1",
    sessionId: "sess-1",
    slackTeamId: "T1",
    slackChannelId: "C1",
    messageTs: "1000.0",
    now,
  });
}

function rowCount(): number {
  return (sqlite.prepare("SELECT COUNT(*) AS n FROM slack_interaction_requests").get() as { n: number }).n;
}

function statuses(kind: string): string[] {
  return (
    sqlite
      .prepare("SELECT status FROM slack_interaction_requests WHERE kind = ? ORDER BY created_at")
      .all(kind) as Array<{ status: string }>
  ).map((row) => row.status);
}

describe("syncCardControlRequests", () => {
  it("mints a resume row on a stopped render and reuses it across re-renders (no row explosion)", async () => {
    const first = await sync("stopped");
    expect(first.resumeRequestId).toBeTruthy();
    expect(first.retryRequestId).toBeUndefined();

    for (let render = 0; render < 10; render++) {
      const again = await sync("stopped", NOW + render);
      expect(again.resumeRequestId).toBe(first.resumeRequestId);
    }
    expect(rowCount()).toBe(1);
  });

  it("mints a retry row for failed and blocked stages", async () => {
    const failed = await sync("failed");
    expect(failed.retryRequestId).toBeTruthy();
    expect(failed.resumeRequestId).toBeUndefined();

    const blocked = await sync("blocked", NOW + 1);
    expect(blocked.retryRequestId).toBe(failed.retryRequestId);
    expect(rowCount()).toBe(1);
  });

  it("supersedes pending rows the moment the stage makes them inapplicable", async () => {
    const stopped = await sync("stopped");
    expect(stopped.resumeRequestId).toBeTruthy();

    // Session resumed and later failed: resume row superseded, retry row minted.
    const failed = await sync("failed", NOW + 10);
    expect(failed.resumeRequestId).toBeUndefined();
    expect(failed.retryRequestId).toBeTruthy();
    expect(statuses(SlackInteractionKind.ResumeSession)).toEqual(["superseded"]);

    // Back to running: both kinds superseded, nothing pending.
    const running = await sync("running", NOW + 20);
    expect(running).toEqual({});
    expect(statuses(SlackInteractionKind.RetrySession)).toEqual(["superseded"]);
    expect(await getNewestPending(db, "sess-1", SlackInteractionKind.ResumeSession, NOW + 30)).toBeNull();
    expect(await getNewestPending(db, "sess-1", SlackInteractionKind.RetrySession, NOW + 30)).toBeNull();
  });

  it("re-mints a fresh row after a supersede when the stage applies again", async () => {
    const first = await sync("stopped");
    await sync("running", NOW + 10);
    const second = await sync("stopped", NOW + 20);
    expect(second.resumeRequestId).toBeTruthy();
    expect(second.resumeRequestId).not.toBe(first.resumeRequestId);
    expect(statuses(SlackInteractionKind.ResumeSession)).toEqual(["superseded", "pending"]);
  });

  it("degrades to no buttons on a D1 failure instead of failing the render", async () => {
    const broken = {
      prepare: () => {
        throw new Error("d1 down");
      },
    } as unknown as D1Database;
    await expect(
      syncCardControlRequests(broken, {
        stage: "stopped",
        businessId: "biz-1",
        sessionId: "sess-1",
        slackTeamId: "T1",
        slackChannelId: "C1",
        messageTs: null,
      }),
    ).resolves.toEqual({});
  });
});
