import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { OFFBOARDING_SESSION_ID_TABLES } from "../../apps/control-plane-worker/src/business/offboarding-tables";
import {
  claimPrTakeoverAdmission,
  releasePrTakeoverAdmission,
} from "../../apps/control-plane-worker/src/session/pr-takeover-admission-claims-db";
import { SqliteD1 } from "./sqlite-d1-helper";

const PR_URL = "https://github.com/trycycloid/cycloid/pull/123";
let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE pr_coordination (session_id TEXT PRIMARY KEY, state TEXT NOT NULL)`);
  sqlite.exec(`CREATE TABLE session_index (session_id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0267_pr_takeover_admission_claims.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("PR takeover admission claims DAO", () => {
  it("lets exactly one in-flight session claim a pull request", async () => {
    const claims = await Promise.all(
      ["session-1", "session-2"].map((sessionId) => claimPrTakeoverAdmission(db, { prUrl: PR_URL, sessionId })),
    );

    expect(claims).toContainEqual({ won: true, sessionId: "session-1" });
    expect(claims).toContainEqual({ won: false, sessionId: "session-1" });
  });

  it("allows retries from the winning session", async () => {
    await claimPrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "session-1", now: 1 });

    await expect(claimPrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "session-1", now: 2 })).resolves.toEqual({
      won: true,
      sessionId: "session-1",
    });
  });

  it("allows a later takeover after the previous coordinator is terminal", async () => {
    await claimPrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "session-1", now: 1 });
    sqlite.prepare(`INSERT INTO pr_coordination (session_id, state) VALUES (?, 'CLOSED')`).run("session-1");

    await expect(claimPrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "session-2", now: 2 })).resolves.toEqual({
      won: true,
      sessionId: "session-2",
    });
  });

  it("reclaims a stale claim whose session never projected", async () => {
    await claimPrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "crashed-session", now: 1 });

    await expect(
      claimPrTakeoverAdmission(db, {
        prUrl: PR_URL,
        sessionId: "replacement-session",
        now: 102,
        staleAfterMs: 100,
      }),
    ).resolves.toEqual({ won: true, sessionId: "replacement-session" });
  });

  it("canonicalizes equivalent pull request URLs to one claim", async () => {
    await claimPrTakeoverAdmission(db, {
      prUrl: "https://github.com/TryCycloid/Cycloid/pull/123/",
      sessionId: "session-1",
    });

    await expect(claimPrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "session-2" })).resolves.toEqual({
      won: false,
      sessionId: "session-1",
    });
  });

  it("releases only the matching unprojected claim", async () => {
    await claimPrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "session-1" });
    await releasePrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "session-2" });
    await expect(claimPrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "session-2" })).resolves.toEqual({
      won: false,
      sessionId: "session-1",
    });

    await releasePrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "session-1" });
    await expect(claimPrTakeoverAdmission(db, { prUrl: PR_URL, sessionId: "session-2" })).resolves.toEqual({
      won: true,
      sessionId: "session-2",
    });
  });

  it("offboards claims by their coordinating session", () => {
    expect(OFFBOARDING_SESSION_ID_TABLES).toContainEqual({
      table: "pr_takeover_admission_claims",
      column: "session_id",
    });
  });
});
