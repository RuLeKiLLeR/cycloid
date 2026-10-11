// ARC-1330 (PR 40) — head-webhook producer: GitHub PR head advance → `head.changed`/`head.noop_changed`.
//
// The PR-40 contract test: the PURE classifier (the spec-named "real-vs-noop discrimination" over
// `{headSha, prevHeadSha, isContentNoop}`) + the builder (event/metadata/actor) + the record-derived
// resolver, then a small integration leg driving `applyEvent` over a real migrated D1 (the Wave-1
// createMigratedSqlite/asD1 idiom) to prove a real head advance forces a re-QA (REVIEW + code_changed +
// dropped verdict) while a content-noop advance keeps a settled verdict fresh (restamp).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyEvent,
  noopSideEffectSink,
  noopWorklistSink,
} from "../../../apps/control-plane-worker/src/session/fsm/apply-event";
import { buildGenesisRecord } from "../../../apps/control-plane-worker/src/session/fsm/genesis";
import {
  buildHeadChangeEmission,
  classifyHeadChange,
  type HeadEmission,
} from "../../../apps/control-plane-worker/src/session/fsm/head-producer";
import { buildLiveGuardResolver } from "../../../apps/control-plane-worker/src/session/fsm/live-resolver";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import type { Env } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

const NOW = 1_700_000_000_000;

describe("head producer — real-vs-noop discrimination (PR 40)", () => {
  it("classifyHeadChange: content-noop tree advance → head.noop_changed, anything else → head.changed", () => {
    // A real code change (different tree) re-opens for re-QA.
    expect(classifyHeadChange({ headSha: "h2", prevHeadSha: "h1", isContentNoop: false })).toEqual({
      kind: "head.changed",
      headSha: "h2",
      prevHeadSha: "h1",
    });
    // A content-noop push (same tree SHA: rebase / reword / no-op force-push) keeps the verdict.
    expect(classifyHeadChange({ headSha: "h2", prevHeadSha: "h1", isContentNoop: true })).toEqual({
      kind: "head.noop_changed",
      headSha: "h2",
      prevHeadSha: "h1",
    });
    // A first advance with no prior head → still a real change; the slice carries a null prev.
    expect(classifyHeadChange({ headSha: "h1", prevHeadSha: null, isContentNoop: false })).toEqual({
      kind: "head.changed",
      headSha: "h1",
      prevHeadSha: null,
    });
  });

  it("buildHeadChangeEmission carries headSha on the event + the {headSha, prevHeadSha} slice + webhook actor", () => {
    expect(buildHeadChangeEmission({ kind: "head.changed", headSha: "h2", prevHeadSha: "h1" })).toEqual({
      event: { type: "head.changed", headSha: "h2" },
      metadata: { type: "head.changed", headSha: "h2", prevHeadSha: "h1" },
      actor: "webhook",
    });
    expect(buildHeadChangeEmission({ kind: "head.noop_changed", headSha: "h3", prevHeadSha: null })).toEqual({
      event: { type: "head.noop_changed", headSha: "h3" },
      metadata: { type: "head.noop_changed", headSha: "h3", prevHeadSha: null },
      actor: "webhook",
    });
  });
});

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

describe("head producer — applyEvent integration over the spine row (PR 40)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const depsFor = (sid: string) => {
    const env = { DB: db, DD_API_KEY: undefined, WORKER_ENV: "test" } as unknown as Env;
    return {
      db,
      env,
      now: () => NOW,
      resolver: buildLiveGuardResolver(env, sid),
      emit: vi.fn(async () => true),
      sideEffects: noopSideEffectSink,
      worklist: noopWorklistSink,
    };
  };

  const apply = (sid: string, emission: HeadEmission) =>
    applyEvent(depsFor(sid), {
      sessionId: sid,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });

  it("REVIEW + head.changed (real change) advances the head, sets code_changed, clears the verdict", async () => {
    const sid = "sess-head-real";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      headSha: "h1",
      verdict: "pass",
      verdictHeadSha: "h1",
      codeChangedSinceVerification: false,
    });
    const emission = buildHeadChangeEmission(
      classifyHeadChange({ headSha: "h2", prevHeadSha: "h1", isContentNoop: false }),
    );
    const r = await apply(sid, emission);
    expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.headSha).toBe("h2");
    expect(rec?.codeChangedSinceVerification).toBe(true);
    expect(rec?.verdict).toBe("none"); // clear_verification → re-QA forced
  });

  it("MERGE_READY + head.noop_changed (content-identical) restamps the verdict and stays Ready", async () => {
    const sid = "sess-head-noop";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "MERGE_READY",
      headSha: "h1",
      verdict: "pass",
      verdictHeadSha: "h1",
      codeChangedSinceVerification: false,
    });
    const emission = buildHeadChangeEmission(
      classifyHeadChange({ headSha: "h2", prevHeadSha: "h1", isContentNoop: true }),
    );
    const r = await apply(sid, emission);
    expect(r).toMatchObject({ outcome: "handled", to: "MERGE_READY" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.headSha).toBe("h2");
    expect(rec?.verdict).toBe("pass"); // preserved
    expect(rec?.verdictHeadSha).toBe("h2"); // restamped to the new head → stays fresh
  });
});
