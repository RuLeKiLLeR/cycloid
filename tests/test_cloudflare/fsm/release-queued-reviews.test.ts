// Tests for the ARC-1330 §17-C `release_queued_reviews` → `review.item_ready` producer (PR 25).
//
// Proves the design §17-C contract: released/injected items (the undispositioned actionable items held in
// the disposition store while VERIFYING owned the head) each re-run the REVIEW cascade and get an epoch on
// the drain — NO wedge. Three layers:
//   • the pure producer (`reviewItemReadyEvents`): one event per released item, deduped, order-stable, empty→empty;
//   • the DAO read (`listUndispositionedActionable`): the released item set = `disposition = 'none'`, oldest-first;
//   • end-to-end: held items → producer events → each `transition("REVIEW", …)` dispatches an epoch, and the
//     items stay undispositioned (so `caught_up` is correctly false) until an epoch stamps them — proving the
//     drain dispatches rather than wedges.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { registerReview } from "../../../apps/control-plane-worker/src/session/fsm/actions";

// A4 retired `inject_findings`; this drain test just needs undispositioned actionable rows.
const undispositionedItems = (sourceIds: readonly string[]) =>
  sourceIds.map((sourceId) => ({ sourceId, origin: "findings" as const, disposition: "none" as const }));
import { caughtUp, type CaughtUpStore } from "../../../apps/control-plane-worker/src/session/fsm/guards";
import { reviewItemReadyEvents } from "../../../apps/control-plane-worker/src/session/fsm/release-queued-reviews";
import { type Guards, transition } from "../../../apps/control-plane-worker/src/session/fsm/transition";
import type { FsmEvent } from "../../../apps/control-plane-worker/src/session/fsm/types";
import {
  countUndispositionedActionable,
  listUndispositionedActionable,
  upsertDisposition,
} from "../../../apps/control-plane-worker/src/session/pr-review-item-disposition-db";
import { SqliteD1 } from "../sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");
const SESSION = "sess-25";
const PR = "https://github.com/acme/web/pull/25";

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

// A REVIEW guard bag whose `review.item_ready` edge dispatches an epoch (no in-flight epoch).
const NEW_EPOCH = "epoch-drain-1";
const REVIEW_BASE: Guards = {
  sandboxAlive: true,
  noInflightEpoch: true,
  newEpochId: NEW_EPOCH,
};
const g = (over: Partial<Guards> = {}): Guards => ({ ...REVIEW_BASE, ...over });

function storeFromCount(undispositioned: number): CaughtUpStore {
  return {
    countUndispositionedActionable: () => undispositioned,
  };
}

describe("reviewItemReadyEvents — the pure §17-C producer", () => {
  it("mints one review.item_ready per released item, in released-set order", () => {
    const events = reviewItemReadyEvents(["find-a", "rev-1", "find-b"]);
    expect(events).toEqual([
      { type: "review.item_ready", itemId: "find-a" },
      { type: "review.item_ready", itemId: "rev-1" },
      { type: "review.item_ready", itemId: "find-b" },
    ]);
  });

  it("dedupes a repeated source id (one drain emits each item at most once)", () => {
    expect(reviewItemReadyEvents(["rev-1", "rev-1", "rev-2", "rev-1"])).toEqual([
      { type: "review.item_ready", itemId: "rev-1" },
      { type: "review.item_ready", itemId: "rev-2" },
    ]);
  });

  it("mints no events for an empty released set (nothing held → no spurious dispatch)", () => {
    expect(reviewItemReadyEvents([])).toEqual([]);
  });
});

describe("§17-C drain — DAO released set + producer + transition (no wedge)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("listUndispositionedActionable returns only disposition='none' items, oldest-first", async () => {
    // Two held reviews + an injected app_breaks finding (the VERIFYING-hold set), then one gets fixed.
    await upsertDisposition(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-1", disposition: "none" }, 1_000);
    await upsertDisposition(db, { sessionId: SESSION, prUrl: PR, sourceId: "find-a", disposition: "none" }, 1_100);
    await upsertDisposition(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-2", disposition: "none" }, 1_200);
    // A sibling PR's held item must not leak into this PR's released set.
    await upsertDisposition(
      db,
      { sessionId: SESSION, prUrl: "https://github.com/acme/web/pull/99", sourceId: "other", disposition: "none" },
      1_300,
    );
    // rev-1 already dispositioned by an epoch → NOT released.
    await upsertDisposition(
      db,
      { sessionId: SESSION, prUrl: PR, sourceId: "rev-1", disposition: "fixed", epochId: "e0" },
      1_400,
    );

    const released = await listUndispositionedActionable(db, SESSION, PR);
    expect(released).toEqual(["find-a", "rev-2"]);
  });

  it("released + injected items each re-run the cascade and get an epoch on drain", async () => {
    // The VERIFYING-hold set: PR-13 producers mint undispositioned rows (registerReview + injectFindings).
    const regs = [registerReview("rev-1"), ...undispositionedItems(["find-a", "find-b"])];
    for (const reg of regs) {
      await upsertDisposition(
        db,
        { sessionId: SESSION, prUrl: PR, sourceId: reg.sourceId, disposition: reg.disposition },
        1_000,
      );
    }

    // The drain reads the released set and the producer mints one item_ready per held item.
    // (All three rows share created_at, so the DAO's `created_at ASC, source_id ASC` ordering is alphabetical.)
    const released = await listUndispositionedActionable(db, SESSION, PR);
    expect(released).toEqual(["find-a", "find-b", "rev-1"]);
    const events = reviewItemReadyEvents(released);
    expect(events).toHaveLength(3);

    // Each released item re-runs the REVIEW cascade and GETS AN EPOCH (no wedge): with no epoch in flight,
    // every `review.item_ready` dispatches and stamps the in-flight id under the same CAS (§17-B).
    for (const event of events) {
      const d = transition("REVIEW", event, g());
      expect(d).toEqual({
        to: "REVIEW",
        fieldWrites: { inFlightEpochId: NEW_EPOCH },
        sideEffects: [{ kind: "dispatch_epoch", args: { trigger: "review" } }],
      });
    }

    // While the held items remain undispositioned, `caught_up` is correctly FALSE — the drain dispatched
    // them (an epoch will disposition them), it did not falsely mark the PR caught up.
    const outstanding = await countUndispositionedActionable(db, SESSION, PR);
    expect(outstanding).toBe(3);
    expect(caughtUp(true, storeFromCount(outstanding))).toBe(false);
  });

  it("an in-flight epoch accumulates the released items (no double-dispatch), still no wedge", async () => {
    await upsertDisposition(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-1", disposition: "none" }, 1_000);
    const [event] = reviewItemReadyEvents(await listUndispositionedActionable(db, SESSION, PR)) as [FsmEvent];
    // An epoch is already running → the item accumulates (log_noop), dispatches on the next no-inflight trigger.
    expect(transition("REVIEW", event, g({ noInflightEpoch: false }))).toEqual({
      to: "REVIEW",
      fieldWrites: {},
      sideEffects: [{ kind: "log_noop" }],
    });
  });
});
