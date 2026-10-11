import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  bindSlackIdentity,
  getLinkedSlackTeamIdForUser,
  getSlackExternalIdForUser,
  pruneExpiredSlackLinkConsumptions,
} from "../../apps/control-plane-worker/src/slack/link-db.js";
import { createSlackLinkSchema, SqliteD1 } from "./sqlite-d1-helper";

const NOW = 1_700_000_000_000;
const EXPIRES = NOW + 600_000;

let sqlite: Database.Database;
let db: D1Database;

function seedUser(id: number, login: string): void {
  sqlite.prepare("INSERT INTO users (id, login) VALUES (?, ?)").run(id, login);
}

function getLinkRow(
  userId: number,
): { external_user_id: string | null; external_team_id: string | null; oauth_access_token: string | null } | null {
  return (
    (sqlite
      .prepare(
        "SELECT external_user_id, external_team_id, oauth_access_token FROM user_integrations WHERE user_id = ? AND integration_id = 'slack'",
      )
      .get(userId) as
      | { external_user_id: string | null; external_team_id: string | null; oauth_access_token: string | null }
      | undefined) ?? null
  );
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  createSlackLinkSchema(sqlite);
  db = new SqliteD1(sqlite) as unknown as D1Database;
  seedUser(1, "alice");
  seedUser(2, "bob");
});

describe("slack/link-db bindSlackIdentity", () => {
  it("binds a fresh Slack identity and consumes the jti", async () => {
    const result = await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_BIZ",
      jti: "jti-1",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(result).toBe("bound");
    expect(await getSlackExternalIdForUser(db, 1)).toBe("U_ALICE");
    // The team is persisted durably on the link row, not only in the prunable ledger.
    expect(getLinkRow(1)?.external_team_id).toBe("T_BIZ");

    const consumed = sqlite
      .prepare("SELECT consumed_by_user_id FROM slack_link_token_consumptions WHERE jti = ?")
      .get("jti-1") as { consumed_by_user_id: number } | undefined;
    expect(consumed?.consumed_by_user_id).toBe(1);
  });

  it("returns already_linked_same when rebinding the SAME Slack id (sequential double-submit)", async () => {
    await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_BIZ",
      jti: "jti-1",
      expiresAt: EXPIRES,
      now: NOW,
    });

    // Second POST of a double-submit: a fresh token (new jti) for the same
    // identity the first POST already bound.
    const result = await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_BIZ",
      jti: "jti-2",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(result).toBe("already_linked_same");
    // Existing link unchanged; the same-id pre-check never burns the second jti.
    expect(await getSlackExternalIdForUser(db, 1)).toBe("U_ALICE");
    const jti2 = sqlite.prepare("SELECT 1 FROM slack_link_token_consumptions WHERE jti = ?").get("jti-2");
    expect(jti2).toBeUndefined();
  });

  it("backfills a missing team when rebinding the SAME Slack id", async () => {
    await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_NEW",
      jti: "jti-1",
      expiresAt: EXPIRES,
      now: NOW,
    });
    sqlite
      .prepare("UPDATE user_integrations SET external_team_id = NULL WHERE user_id = 1 AND integration_id = 'slack'")
      .run();

    const result = await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_NEW",
      jti: "jti-2",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(result).toBe("already_linked_same");
    expect(getLinkRow(1)?.external_team_id).toBe("T_NEW");
  });

  it("does not overwrite an existing team when rebinding the SAME Slack id", async () => {
    await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_OLD",
      jti: "jti-1",
      expiresAt: EXPIRES,
      now: NOW,
    });
    await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_NEW",
      jti: "jti-2",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(getLinkRow(1)?.external_team_id).toBe("T_OLD");
  });

  it("does not overwrite a legacy ledger team when rebinding the SAME Slack id", async () => {
    sqlite
      .prepare(
        `INSERT INTO user_integrations (user_id, integration_id, external_user_id, external_team_id, encrypted, connected_at, updated_at)
         VALUES (1, 'slack', 'U_ALICE', NULL, 0, ?, ?)`,
      )
      .run(NOW, NOW);
    sqlite
      .prepare(
        "INSERT INTO slack_link_token_consumptions (jti, slack_team_id, slack_user_id, consumed_by_user_id, consumed_at, expires_at) VALUES ('jti-legacy', 'T_OLD', 'U_ALICE', 1, ?, ?)",
      )
      .run(NOW, EXPIRES);

    const result = await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_NEW",
      jti: "jti-2",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(result).toBe("already_linked_same");
    expect(getLinkRow(1)?.external_team_id).toBeNull();
  });

  it("returns already_linked_same for the loser of a concurrent race (same user + same Slack id)", async () => {
    // The pre-check intercepts the sequential double-submit, so to exercise the
    // duplicate-jti re-check branch we simulate two in-flight requests: both
    // pass the pre-check while the link is still NULL, then the winner commits
    // its [jti, link] batch first. Model that by making the loser's batch land
    // the winner's link row and then fail on the jti primary key.
    const raceDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return async () => {
            sqlite
              .prepare(
                `INSERT INTO user_integrations (user_id, integration_id, external_user_id, encrypted, connected_at, updated_at)
                 VALUES (1, 'slack', 'U_ALICE', 0, ?, ?)`,
              )
              .run(NOW, NOW);
            throw new Error("UNIQUE constraint failed: slack_link_token_consumptions.jti");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;

    const result = await bindSlackIdentity(raceDb, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_BIZ",
      jti: "jti-race",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(result).toBe("already_linked_same");
    expect(await getSlackExternalIdForUser(db, 1)).toBe("U_ALICE");
    expect(getLinkRow(1)?.external_team_id).toBe("T_BIZ");
  });

  it("refuses to rebind a user who already has a Slack link and does not burn the token", async () => {
    await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_BIZ",
      jti: "jti-1",
      expiresAt: EXPIRES,
      now: NOW,
    });

    const result = await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE_2",
      slackTeamId: "T_BIZ",
      jti: "jti-2",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(result).toBe("already_linked_self");
    // Original link preserved; second jti never recorded.
    expect(await getSlackExternalIdForUser(db, 1)).toBe("U_ALICE");
    const jti2 = sqlite.prepare("SELECT 1 FROM slack_link_token_consumptions WHERE jti = ?").get("jti-2");
    expect(jti2).toBeUndefined();
  });

  it("refuses to bind a Slack user already linked to another Cycloid user", async () => {
    await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_SHARED",
      slackTeamId: "T_BIZ",
      jti: "jti-1",
      expiresAt: EXPIRES,
      now: NOW,
    });

    const result = await bindSlackIdentity(db, {
      userId: 2,
      slackUserId: "U_SHARED",
      slackTeamId: "T_BIZ",
      jti: "jti-2",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(result).toBe("already_linked_other");
    expect(await getSlackExternalIdForUser(db, 2)).toBeNull();
  });

  it("rejects a replayed jti", async () => {
    await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_BIZ",
      jti: "jti-dup",
      expiresAt: EXPIRES,
      now: NOW,
    });
    // A different user replays the same jti (e.g. a double-submitted link).
    const result = await bindSlackIdentity(db, {
      userId: 2,
      slackUserId: "U_BOB",
      slackTeamId: "T_BIZ",
      jti: "jti-dup",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(result).toBe("replayed");
    expect(await getSlackExternalIdForUser(db, 2)).toBeNull();
  });

  it("preserves an existing OAuth token row when binding identity", async () => {
    // Simulate a legacy row with an OAuth token but no external_user_id.
    sqlite
      .prepare(
        `INSERT INTO user_integrations (user_id, integration_id, oauth_access_token, external_user_id, encrypted, connected_at, updated_at)
         VALUES (1, 'slack', 'enc:search-token', NULL, 1, ?, ?)`,
      )
      .run(NOW, NOW);

    const result = await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_BIZ",
      jti: "jti-1",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(result).toBe("bound");
    const row = getLinkRow(1);
    expect(row?.external_user_id).toBe("U_ALICE");
    expect(row?.oauth_access_token).toBe("enc:search-token");
  });

  it("prunes expired consumption rows only", async () => {
    sqlite
      .prepare(
        "INSERT INTO slack_link_token_consumptions (jti, slack_team_id, slack_user_id, consumed_by_user_id, consumed_at, expires_at) VALUES (?, 'T', 'U', 1, ?, ?)",
      )
      .run("old", NOW - 1000, NOW - 1);
    sqlite
      .prepare(
        "INSERT INTO slack_link_token_consumptions (jti, slack_team_id, slack_user_id, consumed_by_user_id, consumed_at, expires_at) VALUES (?, 'T', 'U', 1, ?, ?)",
      )
      .run("fresh", NOW, EXPIRES);

    await pruneExpiredSlackLinkConsumptions(db, NOW);

    const remaining = sqlite.prepare("SELECT jti FROM slack_link_token_consumptions").all() as { jti: string }[];
    expect(remaining.map((r) => r.jti)).toEqual(["fresh"]);
  });
});

describe("slack/link-db getLinkedSlackTeamIdForUser", () => {
  it("returns null when the user has no Slack link", async () => {
    expect(await getLinkedSlackTeamIdForUser(db, 1)).toBeNull();
  });

  it("reads the durable team from the link row", async () => {
    await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_BIZ",
      jti: "jti-1",
      expiresAt: EXPIRES,
      now: NOW,
    });
    expect(await getLinkedSlackTeamIdForUser(db, 1)).toBe("T_BIZ");
  });

  it("survives a ledger prune because the team is stored durably on the link row", async () => {
    await bindSlackIdentity(db, {
      userId: 1,
      slackUserId: "U_ALICE",
      slackTeamId: "T_BIZ",
      jti: "jti-1",
      expiresAt: EXPIRES,
      now: NOW,
    });
    // The 10-minute token window lapses and the consumption row is swept.
    await pruneExpiredSlackLinkConsumptions(db, EXPIRES + 1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM slack_link_token_consumptions").get()).toEqual({ n: 0 });
    // Durable column still resolves the team.
    expect(await getLinkedSlackTeamIdForUser(db, 1)).toBe("T_BIZ");
  });

  it("falls back to the ledger for a legacy link row with no durable team", async () => {
    // A link bound before external_team_id existed: link row has the Slack id but
    // a null team, and only the ledger records the workspace.
    sqlite
      .prepare(
        `INSERT INTO user_integrations (user_id, integration_id, external_user_id, external_team_id, encrypted, connected_at, updated_at)
         VALUES (1, 'slack', 'U_ALICE', NULL, 0, ?, ?)`,
      )
      .run(NOW, NOW);
    sqlite
      .prepare(
        "INSERT INTO slack_link_token_consumptions (jti, slack_team_id, slack_user_id, consumed_by_user_id, consumed_at, expires_at) VALUES ('jti-legacy', 'T_LEDGER', 'U_ALICE', 1, ?, ?)",
      )
      .run(NOW, EXPIRES);
    expect(await getLinkedSlackTeamIdForUser(db, 1)).toBe("T_LEDGER");
  });
});
