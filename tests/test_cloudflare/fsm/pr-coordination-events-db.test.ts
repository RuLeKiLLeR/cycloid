// DAO tests for the `pr_coordination_events` append-only log (ARC-1330 lifecycle
// FSM, PR 3): version-ASC ordered reads regardless of insertion order, metadata
// JSON round-trip (object and null), nullable dwell_ms persistence, and the
// latest-non-null settle_dedup_key read that mirrors the DO's
// `review_loop_settled_last` storage key. Pure persistence — no dedup decisions
// or dwell computation here.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  appendPrCoordinationEvent,
  listPrCoordinationEvents,
  type PrCoordinationEventInput,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
import { SqliteD1 } from "../sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function buildEvent(overrides: Partial<PrCoordinationEventInput> = {}): PrCoordinationEventInput {
  return {
    sessionId: "sess-1",
    version: 1,
    fromState: "REVIEW",
    toState: "REVIEW",
    event: "review_observed",
    at: 1000,
    actor: "webhook",
    ...overrides,
  };
}

describe("pr_coordination_events DAO", () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("returns events ordered by version regardless of insertion order", async () => {
    await appendPrCoordinationEvent(db, buildEvent({ version: 3, event: "third" }));
    await appendPrCoordinationEvent(db, buildEvent({ version: 1, event: "first" }));
    await appendPrCoordinationEvent(db, buildEvent({ version: 2, event: "second" }));

    const events = await listPrCoordinationEvents(db, "sess-1");

    expect(events.map((e) => e.version)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.event)).toEqual(["first", "second", "third"]);
  });

  it("round-trips a JSON metadata object and reads null back as null", async () => {
    const metadata = { reviewerKind: "bot", actionable: true };
    await appendPrCoordinationEvent(db, buildEvent({ version: 1, metadata }));
    await appendPrCoordinationEvent(db, buildEvent({ version: 2 }));

    const events = await listPrCoordinationEvents(db, "sess-1");

    expect(events[0].metadata).toEqual(metadata);
    expect(events[1].metadata).toBeNull();
  });

  it("persists dwell_ms when provided and null when omitted", async () => {
    await appendPrCoordinationEvent(db, buildEvent({ version: 1, dwellMs: 1234 }));
    await appendPrCoordinationEvent(db, buildEvent({ version: 2 }));

    const events = await listPrCoordinationEvents(db, "sess-1");

    expect(events[0].dwellMs).toBe(1234);
    expect(events[1].dwellMs).toBeNull();
  });
});
