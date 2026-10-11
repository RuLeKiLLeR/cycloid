import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { buildGenesisRecord } from "../../apps/control-plane-worker/src/session/fsm/genesis";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../apps/control-plane-worker/src/session/pr-coordination-db";
import { SqliteD1 } from "./sqlite-d1-helper";

// ARC-1330 Wave 11 D-54: migration 0233 drops pr_mergeability_attempts. The one KEEP — the ARC-1302
// update-branch queued marker (update_branch_queued_at) — was already folded onto the FSM spine
// (pr_coordination, migration 0214) by W11-V9. This test is the SF22 survival guard: dropping the
// legacy table must not touch the spine's update_branch_queued_at value.

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const DROP_MIGRATION = "0233_drop_pr_mergeability_attempts.sql";
const NOW = 1_700_000_000_000;

function applyMigrations(sqlite: Database.Database, predicate: (name: string) => boolean): void {
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .filter(predicate)
    .sort()) {
    sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  return sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

describe("migration 0233 drop_pr_mergeability_attempts", () => {
  it("drops pr_mergeability_attempts while preserving pr_coordination.update_branch_queued_at (SF22)", async () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    // Apply everything BEFORE the drop so both the legacy table and the spine exist.
    applyMigrations(sqlite, (name) => name < DROP_MIGRATION);
    const db = new SqliteD1(sqlite) as unknown as D1Database;

    expect(tableExists(sqlite, "pr_mergeability_attempts")).toBe(true);

    // Seed a spine row carrying the ARC-1302 queued marker, plus a legacy attempt row.
    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-carry", NOW),
      prUrl: "https://github.com/acme/repo/pull/7",
      headSha: "head-abc",
      updateBranchQueuedAt: 424242,
    });
    sqlite
      .prepare(
        `INSERT INTO pr_mergeability_attempts
           (session_id, pr_url, head_sha, attempt_count, last_attempt_at, created_at, updated_at, update_branch_queued_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run("sess-carry", "https://github.com/acme/repo/pull/7", "head-abc", NOW, NOW, NOW, 424242);

    // Pre-V9 in-flight row V9's dual-write missed: legacy marker set, matching-key spine row NULL.
    // The migration's backfill must copy it (the at-risk SF22 class — #6521 review finding).
    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-unmirrored", NOW),
      prUrl: "https://github.com/acme/repo/pull/8",
      headSha: "head-live",
      updateBranchQueuedAt: null,
    });
    sqlite
      .prepare(
        `INSERT INTO pr_mergeability_attempts
           (session_id, pr_url, head_sha, attempt_count, last_attempt_at, created_at, updated_at, update_branch_queued_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run("sess-unmirrored", "https://github.com/acme/repo/pull/8", "head-live", NOW, NOW, NOW, 515151);

    // Stale-head marker: the spine has ADVANCED past the marker's head. Dead by construction
    // (the head it guarded is gone) — the backfill must NOT copy it.
    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-stale", NOW),
      prUrl: "https://github.com/acme/repo/pull/9",
      headSha: "head-new",
      updateBranchQueuedAt: null,
    });
    sqlite
      .prepare(
        `INSERT INTO pr_mergeability_attempts
           (session_id, pr_url, head_sha, attempt_count, last_attempt_at, created_at, updated_at, update_branch_queued_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run("sess-stale", "https://github.com/acme/repo/pull/9", "head-old", NOW, NOW, NOW, 616161);

    // Apply the drop.
    applyMigrations(sqlite, (name) => name === DROP_MIGRATION);

    // The legacy table is gone; the spine marker survives untouched.
    expect(tableExists(sqlite, "pr_mergeability_attempts")).toBe(false);
    const spine = await getPrCoordination(db, "sess-carry");
    expect(spine?.updateBranchQueuedAt).toBe(424242);
    expect(spine?.headSha).toBe("head-abc");

    // The unmirrored same-head marker was backfilled; the stale-head marker was not.
    const unmirrored = await getPrCoordination(db, "sess-unmirrored");
    expect(unmirrored?.updateBranchQueuedAt).toBe(515151);
    const stale = await getPrCoordination(db, "sess-stale");
    expect(stale?.updateBranchQueuedAt).toBeNull();
  });

  it("the guarded DROP statement re-applies cleanly", () => {
    // D1's migration ledger applies each file exactly once, so whole-file re-exec is not a
    // platform requirement (the backfill UPDATE references the dropped table and cannot re-run).
    // The destructive statement itself stays guarded: re-running the DROP must not throw.
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    applyMigrations(sqlite, (name) => name < DROP_MIGRATION);
    const dropSql = readFileSync(resolve(MIGRATIONS_DIR, DROP_MIGRATION), "utf8");
    sqlite.exec(dropSql);
    expect(() => sqlite.exec("DROP TABLE IF EXISTS pr_mergeability_attempts;")).not.toThrow();
    expect(tableExists(sqlite, "pr_mergeability_attempts")).toBe(false);
  });
});
