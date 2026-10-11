import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { SlackInteractionKind } from "../../apps/control-plane-worker/src/enums/slack-interaction.js";
import {
  consumeInteractionRequest,
  expireDue,
  getInteractionRequest,
  getNewestPending,
  insertInteractionRequest,
  pruneOldInteractionRequests,
  supersedePending,
} from "../../apps/control-plane-worker/src/slack/interaction-requests-db.js";
import { SqliteD1 } from "./sqlite-d1-helper";

// Real migration SQL so schema drift between the DAO and the deployed table
// fails here instead of in production.
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

async function seedRequest(overrides: Partial<Parameters<typeof insertInteractionRequest>[1]> = {}): Promise<string> {
  return insertInteractionRequest(db, {
    businessId: "biz-1",
    sessionId: "sess-1",
    kind: SlackInteractionKind.ResumeSession,
    payloadJson: JSON.stringify({}),
    slackTeamId: "T1",
    slackChannelId: "C1",
    messageTs: "1000.0",
    expiresAt: null,
    now: NOW,
    ...overrides,
  });
}

function statusOf(id: string): string {
  return (sqlite.prepare("SELECT status FROM slack_interaction_requests WHERE id = ?").get(id) as { status: string })
    .status;
}

describe("slack/interaction-requests-db insert + get", () => {
  it("round-trips a pending row through insert and getInteractionRequest", async () => {
    const id = await seedRequest({ expiresAt: NOW + 60_000 });
    const record = await getInteractionRequest(db, id);
    expect(record).toMatchObject({
      id,
      businessId: "biz-1",
      sessionId: "sess-1",
      kind: "resume_session",
      payloadJson: "{}",
      slackTeamId: "T1",
      slackChannelId: "C1",
      messageTs: "1000.0",
      status: "pending",
      expiresAt: NOW + 60_000,
      createdAt: NOW,
      consumedAt: null,
      consumedByUserId: null,
    });
  });

  it("returns null for an unknown id", async () => {
    expect(await getInteractionRequest(db, "nope")).toBeNull();
  });
});

describe("slack/interaction-requests-db getNewestPending", () => {
  it("returns the newest pending row for the (session, kind) pair", async () => {
    const older = await seedRequest({ now: NOW });
    const newer = await seedRequest({ now: NOW + 1_000 });
    await seedRequest({ kind: SlackInteractionKind.AnswerQuestion, now: NOW + 5_000 });
    await seedRequest({ sessionId: "sess-other", now: NOW + 5_000 });

    const record = await getNewestPending(db, "sess-1", SlackInteractionKind.ResumeSession, NOW + 10_000);
    expect(record?.id).toBe(newer);
    expect(record?.id).not.toBe(older);
  });

  it("skips consumed rows and falls back to the older pending one", async () => {
    const older = await seedRequest({ now: NOW });
    const newer = await seedRequest({ now: NOW + 1_000 });
    expect(await consumeInteractionRequest(db, newer, "7", NOW + 2_000)).toBe(true);

    const record = await getNewestPending(db, "sess-1", SlackInteractionKind.ResumeSession, NOW + 10_000);
    expect(record?.id).toBe(older);
  });

  it("skips pending rows already past their expiry", async () => {
    await seedRequest({ expiresAt: NOW + 1_000, now: NOW });
    expect(await getNewestPending(db, "sess-1", SlackInteractionKind.ResumeSession, NOW + 1_000)).toBeNull();
  });
});

describe("slack/interaction-requests-db consumeInteractionRequest", () => {
  it("lets exactly one of two consumes win and records the winner", async () => {
    const id = await seedRequest();
    const first = await consumeInteractionRequest(db, id, "7", NOW + 1_000);
    const second = await consumeInteractionRequest(db, id, "8", NOW + 1_001);

    expect(first).toBe(true);
    expect(second).toBe(false);
    const record = await getInteractionRequest(db, id);
    expect(record).toMatchObject({ status: "consumed", consumedAt: NOW + 1_000, consumedByUserId: "7" });
  });

  it("treats expires_at as an exclusive boundary", async () => {
    const atBoundary = await seedRequest({ expiresAt: NOW + 1_000 });
    expect(await consumeInteractionRequest(db, atBoundary, "7", NOW + 1_000)).toBe(false);
    expect(statusOf(atBoundary)).toBe("pending");

    const beforeBoundary = await seedRequest({ expiresAt: NOW + 1_000 });
    expect(await consumeInteractionRequest(db, beforeBoundary, "7", NOW + 999)).toBe(true);
  });

  it("refuses superseded rows", async () => {
    const id = await seedRequest();
    expect(await supersedePending(db, "sess-1", SlackInteractionKind.ResumeSession, NOW + 500)).toBe(1);
    expect(await consumeInteractionRequest(db, id, "7", NOW + 1_000)).toBe(false);
    expect(statusOf(id)).toBe("superseded");
  });
});

describe("slack/interaction-requests-db supersedePending", () => {
  it("supersedes only live pending rows of the same (session, kind)", async () => {
    const a = await seedRequest();
    const b = await seedRequest({ now: NOW + 1 });
    const otherKind = await seedRequest({ kind: SlackInteractionKind.AnswerQuestion });
    const otherSession = await seedRequest({ sessionId: "sess-2" });
    const consumed = await seedRequest({ now: NOW + 2 });
    await consumeInteractionRequest(db, consumed, "7", NOW + 3);

    const count = await supersedePending(db, "sess-1", SlackInteractionKind.ResumeSession, NOW + 500);

    expect(count).toBe(2);
    expect(statusOf(a)).toBe("superseded");
    expect(statusOf(b)).toBe("superseded");
    expect(statusOf(otherKind)).toBe("pending");
    expect(statusOf(otherSession)).toBe("pending");
    expect(statusOf(consumed)).toBe("consumed");
  });

  it("leaves due-but-unswept rows to expireDue so their terminal status stays truthful", async () => {
    const due = await seedRequest({ expiresAt: NOW + 100 });
    expect(await supersedePending(db, "sess-1", SlackInteractionKind.ResumeSession, NOW + 200)).toBe(0);
    expect(statusOf(due)).toBe("pending");
    expect(await expireDue(db, NOW + 200)).toBe(1);
    expect(statusOf(due)).toBe("expired");
  });
});

describe("slack/interaction-requests-db expireDue", () => {
  it("expires only due pending rows and is idempotent", async () => {
    const due = await seedRequest({ expiresAt: NOW + 100 });
    const future = await seedRequest({ expiresAt: NOW + 10_000 });
    const never = await seedRequest({ expiresAt: null });

    expect(await expireDue(db, NOW + 100)).toBe(1);
    expect(statusOf(due)).toBe("expired");
    expect(statusOf(future)).toBe("pending");
    expect(statusOf(never)).toBe("pending");
    expect(await expireDue(db, NOW + 100)).toBe(0);
  });
});

describe("slack/interaction-requests-db pruneOldInteractionRequests", () => {
  it("deletes only terminal rows created before the cutoff", async () => {
    const oldConsumed = await seedRequest({ now: NOW - 10_000 });
    await consumeInteractionRequest(db, oldConsumed, "7", NOW - 9_000);
    const oldExpired = await seedRequest({ now: NOW - 10_000, expiresAt: NOW - 9_000 });
    await expireDue(db, NOW - 9_000);
    const oldSuperseded = await seedRequest({ now: NOW - 10_000, kind: SlackInteractionKind.AnswerQuestion });
    await supersedePending(db, "sess-1", SlackInteractionKind.AnswerQuestion, NOW - 9_000);
    const oldPending = await seedRequest({ now: NOW - 10_000, sessionId: "sess-keep" });
    const newConsumed = await seedRequest({ now: NOW, sessionId: "sess-new" });
    await consumeInteractionRequest(db, newConsumed, "7", NOW + 1);

    const deleted = await pruneOldInteractionRequests(db, NOW - 5_000);

    expect(deleted).toBe(3);
    expect(await getInteractionRequest(db, oldConsumed)).toBeNull();
    expect(await getInteractionRequest(db, oldExpired)).toBeNull();
    expect(await getInteractionRequest(db, oldSuperseded)).toBeNull();
    expect(statusOf(oldPending)).toBe("pending");
    expect(statusOf(newConsumed)).toBe("consumed");
  });
});
