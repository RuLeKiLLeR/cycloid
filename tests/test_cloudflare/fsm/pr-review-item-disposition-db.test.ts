// DAO tests for the per-item review disposition store (ARC-1330 lifecycle FSM, PR 22 —
// migration 0214). The SINGLE authoritative item set `caught_up` reads (Locked decision 1):
//   • round-trip — `upsertDisposition` (register `none` → stamp terminal) then `listForPr`;
//   • `caught_up` counts undispositioned — the real DAO `countUndispositionedActionable` feeds
//     the PR-9 `caughtUp()` guard (the write-path producers `register_review`/`inject_findings`
//     map onto `upsertDisposition('none')`, the epoch terminals onto the terminal stamp);
//   • `declined` requires basis — triage-with-basis (§13): a `declined` write with no basis throws.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { registerReview } from "../../../apps/control-plane-worker/src/session/fsm/actions";

// A4 retired `inject_findings`; these DAO tests just need undispositioned actionable rows.
const undispositionedItems = (sourceIds: readonly string[]) =>
  sourceIds.map((sourceId) => ({ sourceId, origin: "findings" as const, disposition: "none" as const }));
import { caughtUp, type CaughtUpStore } from "../../../apps/control-plane-worker/src/session/fsm/guards";
import {
  countUndispositionedActionable,
  listForPr,
  registerDispositionIfAbsent,
  registerDispositionsIfAbsent,
  stampInformationalDispositions,
  upsertDisposition,
  upsertDispositionsBatch,
} from "../../../apps/control-plane-worker/src/session/pr-review-item-disposition-db";
import { SqliteD1 } from "../sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");
const SESSION = "sess-22";
const PR = "https://github.com/acme/web/pull/22";

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

/** Build the disposition half of the `caught_up` snapshot from the real DAO count. */
function storeFromCount(undispositioned: number): CaughtUpStore {
  return {
    countUndispositionedActionable: () => undispositioned,
  };
}

describe("pr_review_item_dispositions DAO", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  // ── (1) round-trip — register undispositioned, then stamp a terminal disposition ──────────
  it("round-trips a registered item then its terminal stamp through listForPr", async () => {
    await upsertDisposition(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-1", disposition: "none" }, 1_000);
    let rows = await listForPr(db, SESSION, PR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      sessionId: SESSION,
      prUrl: PR,
      sourceId: "rev-1",
      disposition: "none",
      basis: null,
      epochId: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    // The epoch terminal stamps it `fixed` (same PK upsert) — created_at preserved, updated_at bumped.
    await upsertDisposition(
      db,
      { sessionId: SESSION, prUrl: PR, sourceId: "rev-1", disposition: "fixed", epochId: "epoch-7" },
      2_000,
    );
    rows = await listForPr(db, SESSION, PR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      disposition: "fixed",
      epochId: "epoch-7",
      createdAt: 1_000,
      updatedAt: 2_000,
    });
  });

  it("returns an empty list for a PR with no items", async () => {
    expect(await listForPr(db, SESSION, PR)).toEqual([]);
  });

  // ── (2) caught_up counts undispositioned — the real DAO read feeds the PR-9 guard ─────────
  it("caught_up is false while actionable items are undispositioned, true once all are stamped", async () => {
    // The PR-13 producers mint UNDISPOSITIONED rows; they map onto upsertDisposition('none').
    const review = registerReview("rev-1");
    const findings = undispositionedItems(["find-a", "find-b"]);
    for (const reg of [review, ...findings]) {
      await upsertDisposition(
        db,
        { sessionId: SESSION, prUrl: PR, sourceId: reg.sourceId, disposition: reg.disposition },
        1_000,
      );
    }

    let outstanding = await countUndispositionedActionable(db, SESSION, PR);
    expect(outstanding).toBe(3);
    // caught_up reads the real count via the store: not caught up while items are undispositioned.
    expect(caughtUp(true, storeFromCount(outstanding))).toBe(false);

    // Disposition every item (fixed / declined-with-basis / replied) — the epoch terminals.
    await upsertDisposition(
      db,
      { sessionId: SESSION, prUrl: PR, sourceId: "rev-1", disposition: "fixed", epochId: "e1" },
      2_000,
    );
    await upsertDisposition(
      db,
      {
        sessionId: SESSION,
        prUrl: PR,
        sourceId: "find-a",
        disposition: "declined",
        basis: "no-op repo path",
        epochId: "e2",
      },
      2_000,
    );
    await upsertDisposition(
      db,
      { sessionId: SESSION, prUrl: PR, sourceId: "find-b", disposition: "replied", epochId: "e3" },
      2_000,
    );

    outstanding = await countUndispositionedActionable(db, SESSION, PR);
    expect(outstanding).toBe(0);
    // Now caught_up holds (no inflight epoch, nothing undispositioned, reviewers settled).
    expect(caughtUp(true, storeFromCount(outstanding))).toBe(true);
  });

  it("scopes the undispositioned count per (session, pr) — neither a sibling PR nor a sibling SESSION leaks in", async () => {
    await upsertDisposition(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-1", disposition: "none" }, 1_000);
    const OTHER = "https://github.com/acme/web/pull/99";
    await upsertDisposition(db, { sessionId: SESSION, prUrl: OTHER, sourceId: "rev-1", disposition: "none" }, 1_000);
    // Same prUrl + same sourceId, DIFFERENT session — must not leak into SESSION's count for PR.
    const OTHER_SESSION = "session-other";
    await upsertDisposition(db, { sessionId: OTHER_SESSION, prUrl: PR, sourceId: "rev-1", disposition: "none" }, 1_000);
    expect(await countUndispositionedActionable(db, SESSION, PR)).toBe(1);
    expect(await countUndispositionedActionable(db, SESSION, OTHER)).toBe(1);
    expect(await countUndispositionedActionable(db, OTHER_SESSION, PR)).toBe(1);
  });

  // ── (3) declined requires basis — triage-with-basis (§13) ─────────────────────────────────
  it("refuses a declined disposition with no basis (triage-with-basis), nothing written", async () => {
    await expect(
      upsertDisposition(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-1", disposition: "declined" }, 1_000),
    ).rejects.toThrow(/basis/i);
    // A blank/whitespace basis is likewise refused.
    await expect(
      upsertDisposition(
        db,
        { sessionId: SESSION, prUrl: PR, sourceId: "rev-1", disposition: "declined", basis: "   " },
        1_000,
      ),
    ).rejects.toThrow(/basis/i);
    // The refusal is pre-write: no row landed.
    expect(await listForPr(db, SESSION, PR)).toEqual([]);
  });

  // ── registerDispositionIfAbsent (PR 46) — registration never rewinds a terminal stamp ──────
  it("registerDispositionIfAbsent inserts a fresh undispositioned row", async () => {
    await registerDispositionIfAbsent(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-9" }, 1_000);
    const rows = await listForPr(db, SESSION, PR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceId: "rev-9", disposition: "none", basis: null, epochId: null });
    expect(await countUndispositionedActionable(db, SESSION, PR)).toBe(1);
  });

  it("registerDispositionIfAbsent never rewinds a terminal stamp (redelivered review keeps 'fixed')", async () => {
    await upsertDisposition(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-9", disposition: "none" }, 1_000);
    await upsertDisposition(
      db,
      { sessionId: SESSION, prUrl: PR, sourceId: "rev-9", disposition: "fixed", epochId: "e1" },
      2_000,
    );
    // The webhook redelivery re-registers the SAME source id — the DO-NOTHING keeps the stamp.
    await registerDispositionIfAbsent(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-9" }, 3_000);
    const rows = await listForPr(db, SESSION, PR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disposition: "fixed", epochId: "e1", updatedAt: 2_000 });
    expect(await countUndispositionedActionable(db, SESSION, PR)).toBe(0);
  });

  it("registerDispositionIfAbsent is a no-op on an existing still-'none' row (idempotent)", async () => {
    await registerDispositionIfAbsent(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-9" }, 1_000);
    await registerDispositionIfAbsent(db, { sessionId: SESSION, prUrl: PR, sourceId: "rev-9" }, 5_000);
    const rows = await listForPr(db, SESSION, PR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disposition: "none", createdAt: 1_000, updatedAt: 1_000 });
  });

  it("registerDispositionsIfAbsent inserts the whole registration set with one D1 batch", async () => {
    let batchCalls = 0;
    const batchSizes: number[] = [];
    const batchingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batchCalls += 1;
            batchSizes.push(statements.length);
            return target.batch(statements);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;

    await registerDispositionsIfAbsent(
      batchingDb,
      [
        { sessionId: SESSION, prUrl: PR, sourceId: "rev-10" },
        { sessionId: SESSION, prUrl: PR, sourceId: "rev-11" },
      ],
      6_000,
    );

    expect(batchCalls).toBe(1);
    expect(batchSizes).toEqual([2]);
    const rows = await listForPr(db, SESSION, PR);
    expect(rows.map((row) => [row.sourceId, row.disposition, row.createdAt, row.updatedAt])).toEqual([
      ["rev-10", "none", 6_000, 6_000],
      ["rev-11", "none", 6_000, 6_000],
    ]);
  });

  it("stampInformationalDispositions batches the whole set in one D1 round trip", async () => {
    let batchCalls = 0;
    const batchingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batchCalls += 1;
            return target.batch(statements);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;

    await stampInformationalDispositions(
      batchingDb,
      [
        { sessionId: SESSION, prUrl: PR, sourceId: "issue-comment:10", basis: "no_findings" },
        { sessionId: SESSION, prUrl: PR, sourceId: "review-comment:11", basis: "empty_commented_review" },
      ],
      6_000,
    );
    expect(batchCalls).toBe(1);
    const rows = await listForPr(db, SESSION, PR);
    expect(rows.map((row) => [row.sourceId, row.disposition, row.basis])).toEqual([
      ["issue-comment:10", "no_action_needed_informational", "no_findings"],
      ["review-comment:11", "no_action_needed_informational", "empty_commented_review"],
    ]);
    expect(await countUndispositionedActionable(db, SESSION, PR)).toBe(0);
  });

  it("accepts a declined disposition with a real basis", async () => {
    await upsertDisposition(
      db,
      {
        sessionId: SESSION,
        prUrl: PR,
        sourceId: "rev-1",
        disposition: "declined",
        basis: "suggestion is out of scope",
        epochId: "e9",
      },
      1_000,
    );
    const rows = await listForPr(db, SESSION, PR);
    expect(rows[0]).toMatchObject({ disposition: "declined", basis: "suggestion is out of scope", epochId: "e9" });
    expect(await countUndispositionedActionable(db, SESSION, PR)).toBe(0);
  });

  it("upsertDispositionsBatch chunks writes into bounded D1 batches", async () => {
    let batchCalls = 0;
    const batchSizes: number[] = [];
    const batchingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batchCalls += 1;
            batchSizes.push(statements.length);
            return target.batch(statements);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
    const inputs = Array.from({ length: 105 }, (_, index) => ({
      sessionId: SESSION,
      prUrl: PR,
      sourceId: `rev-batch-${index}`,
      disposition: "fixed" as const,
      epochId: "epoch-batch",
    }));

    await upsertDispositionsBatch(batchingDb, inputs, 7_000);

    expect(batchCalls).toBe(3);
    expect(batchSizes).toEqual([50, 50, 5]);
    expect(await countUndispositionedActionable(db, SESSION, PR)).toBe(0);
    expect(await listForPr(db, SESSION, PR)).toHaveLength(105);
  });

  it("upsertDispositionsBatch refuses invalid declined rows before any partial write", async () => {
    let batchCalls = 0;
    const batchingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batchCalls += 1;
            return target.batch(statements);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;

    await expect(
      upsertDispositionsBatch(
        batchingDb,
        [
          { sessionId: SESSION, prUrl: PR, sourceId: "rev-good", disposition: "fixed", epochId: "epoch-1" },
          { sessionId: SESSION, prUrl: PR, sourceId: "rev-bad", disposition: "declined", basis: "  " },
        ],
        8_000,
      ),
    ).rejects.toThrow(/basis/i);

    expect(batchCalls).toBe(0);
    expect(await listForPr(db, SESSION, PR)).toEqual([]);
  });
});
