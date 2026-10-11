import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { getUserBySlackIdForTeam } from "../../apps/control-plane-worker/src/auth/db";
import { createSlackLinkSchema, SqliteD1 } from "./sqlite-d1-helper";

const NOW = 1_700_000_000_000;

let sqlite: Database.Database;
let db: D1Database;

function seedUser(id: number, login: string): void {
  sqlite.prepare("INSERT INTO users (id, login) VALUES (?, ?)").run(id, login);
}

function seedSlackLink(userId: number, slackUserId: string, teamId: string | null): void {
  sqlite
    .prepare(
      `INSERT INTO user_integrations
       (user_id, integration_id, external_user_id, external_team_id, encrypted, connected_at, updated_at)
       VALUES (?, 'slack', ?, ?, 0, ?, ?)`,
    )
    .run(userId, slackUserId, teamId, NOW, NOW);
}

function seedLedgerConsumption(userId: number, slackUserId: string, teamId: string, consumedAt: number): void {
  sqlite
    .prepare(
      `INSERT INTO slack_link_token_consumptions
       (jti, slack_team_id, slack_user_id, consumed_by_user_id, consumed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`jti-${userId}-${consumedAt}`, teamId, slackUserId, userId, consumedAt, consumedAt + 600_000);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  createSlackLinkSchema(sqlite);
  db = new SqliteD1(sqlite) as unknown as D1Database;
  seedUser(1, "alice");
});

describe("auth/db getUserBySlackIdForTeam", () => {
  it("resolves the user when the durable external_team_id matches", async () => {
    seedSlackLink(1, "U1", "T1");
    expect(await getUserBySlackIdForTeam(db, "U1", "T1")).toEqual({ id: 1, login: "alice" });
  });

  it("rejects the same Slack user id from a different workspace", async () => {
    seedSlackLink(1, "U1", "T1");
    expect(await getUserBySlackIdForTeam(db, "U1", "T_OTHER")).toBeNull();
  });

  it("falls back to the consumption ledger for pre-0205 links with no stored team", async () => {
    seedSlackLink(1, "U1", null);
    seedLedgerConsumption(1, "U1", "T1", NOW);
    expect(await getUserBySlackIdForTeam(db, "U1", "T1")).toEqual({ id: 1, login: "alice" });
    expect(await getUserBySlackIdForTeam(db, "U1", "T_OTHER")).toBeNull();
  });

  it("uses the most recent ledger row when several exist", async () => {
    seedSlackLink(1, "U1", null);
    seedLedgerConsumption(1, "U1", "T_OLD", NOW - 1_000);
    seedLedgerConsumption(1, "U1", "T_NEW", NOW);
    expect(await getUserBySlackIdForTeam(db, "U1", "T_NEW")).toEqual({ id: 1, login: "alice" });
    expect(await getUserBySlackIdForTeam(db, "U1", "T_OLD")).toBeNull();
  });

  it("prefers the durable column over the ledger when both exist", async () => {
    // A stale ledger row must not widen the match beyond the durable binding.
    seedSlackLink(1, "U1", "T1");
    seedLedgerConsumption(1, "U1", "T_STALE", NOW);
    expect(await getUserBySlackIdForTeam(db, "U1", "T_STALE")).toBeNull();
    expect(await getUserBySlackIdForTeam(db, "U1", "T1")).toEqual({ id: 1, login: "alice" });
  });

  it("fails closed when neither source records a team", async () => {
    seedSlackLink(1, "U1", null);
    expect(await getUserBySlackIdForTeam(db, "U1", "T1")).toBeNull();
  });

  it("returns null for an unlinked Slack user id", async () => {
    expect(await getUserBySlackIdForTeam(db, "U_NOBODY", "T1")).toBeNull();
  });
});
