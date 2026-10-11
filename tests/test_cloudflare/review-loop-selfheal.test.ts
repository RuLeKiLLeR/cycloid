// ARC-1330 self-heal: `reconcileStrandedTerminalEpochMarkers` clears the standing stock that wedged in
// REVIEW before the emit-on-terminal fix landed — pr_coordination.in_flight_epoch_id pointing at an epoch
// that already reached a terminal status (completed / blocked) with no spine terminal ever emitted.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  reconcileStrandedTerminalEpochMarkers,
  reconcileUndispatchedReviewItems,
} from "../../apps/control-plane-worker/src/services/review-loop-sweep";
import { buildGenesisRecord } from "../../apps/control-plane-worker/src/session/fsm/genesis";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../apps/control-plane-worker/src/session/pr-coordination-db";
import { SqliteD1 } from "./sqlite-d1-helper";

const NOW = 1_700_000_000_000;
const PR = "https://github.com/o/r/pull/1";
const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

describe("reconcileStrandedTerminalEpochMarkers — self-heal of stranded in-flight markers", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
    db = new SqliteD1(sqlite) as unknown as D1Database;
  });

  const env = () => ({ DB: db, FSM_MODE: "shadow", DD_API_KEY: undefined, WORKER_ENV: "test" }) as never;

  const seedWedged = async (
    sid: string,
    epochId: string,
    status: string,
    blockedReason: string | null,
    lastPromptId: string | null = null,
  ) => {
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      prUrl: PR,
      headSha: "h1",
      inFlightEpochId: epochId,
    });
    sqlite
      .prepare(
        `INSERT INTO pr_review_response_epochs (
           id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha,
           expected_bots_hash, expected_bots_json, expected_bot_keys_json,
           handled_source_ids_json, triggering_source_ids_json,
           first_activity_at, fallback_after_at, status, blocked_reason, last_prompt_id, source_kind,
           created_at, updated_at
         ) VALUES (?, ?, 1, 'o', 'r', 1, ?, 'h1', 'hash', '[]', '[]', '[]', '["review:1"]', ?, ?, ?, ?, ?, 'bot', ?, ?)`,
      )
      .run(epochId, sid, PR, NOW, NOW, status, blockedReason, lastPromptId, NOW, NOW);
  };

  it("clears a REVIEW row stranded on a proven-no-op COMPLETED epoch (last_prompt_id=NULL → epoch.settled)", async () => {
    await seedWedged("sess-completed", "ep-c", "completed", null);
    const result = await reconcileStrandedTerminalEpochMarkers(env(), { limit: 50, logger });
    expect(result.cleared).toBe(1);
    const rec = await getPrCoordination(db, "sess-completed");
    expect(rec?.inFlightEpochId).toBeNull(); // un-stranded → caught_up can fire
    expect(rec?.state).toBe("REVIEW");
  });

  it("prefetches stranded epochs in one IN-clause lookup for the candidate set", async () => {
    await seedWedged("sess-completed-1", "ep-c-1", "completed", null);
    await seedWedged("sess-completed-2", "ep-c-2", "completed", null);
    const preparedQueries: string[] = [];
    const countingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (query: string) => {
            preparedQueries.push(query);
            return target.prepare(query);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
    const result = await reconcileStrandedTerminalEpochMarkers(
      { DB: countingDb, FSM_MODE: "shadow", DD_API_KEY: undefined, WORKER_ENV: "test" } as never,
      { limit: 50, logger },
    );

    expect(result.cleared).toBe(2);
    expect(preparedQueries.filter((query) => query.includes("pr_review_response_epochs WHERE id IN"))).toHaveLength(1);
    expect(
      preparedQueries.filter((query) => query.includes("pr_review_response_epochs WHERE id = ? LIMIT 1")),
    ).toHaveLength(0);
  });

  it("SKIPS a COMPLETED epoch that dispatched a prompt (last_prompt_id set) — settled would drop its disposition/code-changed", async () => {
    await seedWedged("sess-prompted", "ep-p", "completed", null, "prompt-1");
    const result = await reconcileStrandedTerminalEpochMarkers(env(), { limit: 50, logger });
    expect(result.cleared).toBe(0);
    const rec = await getPrCoordination(db, "sess-prompted");
    expect(rec?.inFlightEpochId).toBe("ep-p"); // left for the 24h backstop, not mis-healed as a no-op
  });

  it("clears a REVIEW row stranded on a head_changed BLOCKED epoch (→ epoch.settled)", async () => {
    await seedWedged("sess-headchanged", "ep-h", "blocked", "head_changed");
    const result = await reconcileStrandedTerminalEpochMarkers(env(), { limit: 50, logger });
    expect(result.cleared).toBe(1);
    const rec = await getPrCoordination(db, "sess-headchanged");
    expect(rec?.inFlightEpochId).toBeNull();
  });

  it("leaves a row whose in-flight epoch is STILL LIVE (collecting) untouched", async () => {
    await seedWedged("sess-live", "ep-live", "collecting", null);
    const result = await reconcileStrandedTerminalEpochMarkers(env(), { limit: 50, logger });
    expect(result.cleared).toBe(0);
    const rec = await getPrCoordination(db, "sess-live");
    expect(rec?.inFlightEpochId).toBe("ep-live"); // still in-flight — not stranded
  });
});

describe("reconcileUndispatchedReviewItems — self-heal of undispositioned items with no epoch (ARC-1445)", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
    db = new SqliteD1(sqlite) as unknown as D1Database;
  });

  const env = () => ({ DB: db, FSM_MODE: "shadow", DD_API_KEY: undefined, WORKER_ENV: "test" }) as never;

  const seedReviewRow = async (sid: string) =>
    insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      prUrl: PR,
      headSha: "h1",
      inFlightEpochId: null,
    });

  const registerUndispositioned = (sid: string, sourceId: string) =>
    sqlite
      .prepare(
        `INSERT INTO pr_review_item_dispositions (session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at)
         VALUES (?, ?, ?, 'none', NULL, NULL, ?, ?)`,
      )
      .run(sid, PR, sourceId, NOW, NOW);

  const seedLiveEpoch = (sid: string, epochId: string, sourceId: string) =>
    sqlite
      .prepare(
        `INSERT INTO pr_review_response_epochs (
           id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha,
           expected_bots_hash, expected_bots_json, expected_bot_keys_json,
           handled_source_ids_json, triggering_source_ids_json,
           first_activity_at, fallback_after_at, status, source_kind, created_at, updated_at
         ) VALUES (?, ?, 1, 'o', 'r', 1, ?, 'h1', 'hash', '[]', '[]', '[]', ?, ?, ?, 'collecting', 'bot', ?, ?)`,
      )
      .run(epochId, sid, PR, JSON.stringify([sourceId]), NOW, NOW, NOW, NOW);

  it("ARMS the drain for a REVIEW row with in_flight NULL + undispositioned items + no live epoch", async () => {
    const sid = "sess-undispatched";
    await seedReviewRow(sid);
    registerUndispositioned(sid, "review-comment:1");
    registerUndispositioned(sid, "issue-comment:2");
    const result = await reconcileUndispatchedReviewItems(env(), { limit: 50, logger });
    expect(result.dispatched).toBe(1);
    const rec = await getPrCoordination(db, sid);
    // The drain armed: a FRESH synthetic in-flight id is stamped (epoch creation from it is the executor's
    // job, covered by the dispatchEpochExecutor suite). NOT null (still wedged) and matches the synthetic id.
    expect(rec?.inFlightEpochId).not.toBeNull();
    expect(rec?.inFlightEpochId).toMatch(new RegExp(`^epoch-${sid}-`));
    expect(rec?.state).toBe("REVIEW");
  });

  it("SKIPS a REVIEW row whose undispositioned items are covered by a LIVE epoch (no double-drive)", async () => {
    const sid = "sess-covered";
    await seedReviewRow(sid);
    registerUndispositioned(sid, "review-comment:1");
    seedLiveEpoch(sid, "ep-live", "review-comment:1"); // a live epoch already owns the source
    const result = await reconcileUndispatchedReviewItems(env(), { limit: 50, logger });
    expect(result.dispatched).toBe(0);
    const rec = await getPrCoordination(db, sid);
    expect(rec?.inFlightEpochId).toBeNull(); // untouched — the live epoch will disposition it
  });

  it("SKIPS a healthy REVIEW row with NO undispositioned items", async () => {
    const sid = "sess-healthy";
    await seedReviewRow(sid);
    const result = await reconcileUndispatchedReviewItems(env(), { limit: 50, logger });
    expect(result.dispatched).toBe(0);
    expect((await getPrCoordination(db, sid))?.inFlightEpochId).toBeNull();
  });
});
