// ARC-1330 (PR 38) — CI-webhook producer: CI rollup → `ci.signal` spine-event mapping.
//
// The PR-38 contract test: the pure builder + `reduceCiState`→emission mapper carry the right
// `FsmEvent`/`EventMetadata`/actor (and `pending` → NO event), the resolver derives the CI/epoch/cap
// guards from the committed record, and a small integration leg drives `applyEvent` over a real
// migrated D1 (the Wave-1 createMigratedSqlite/asD1 idiom) to prove the emission + resolver actually
// advance the shadow `pr_coordination` row on the real `ci.signal` edges (REVIEW ciFix self-loop, the
// FG-2 green reset, and the MERGE_READY red-CI re-open).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyEvent,
  noopSideEffectSink,
  noopWorklistSink,
} from "../../../apps/control-plane-worker/src/session/fsm/apply-event";
import {
  buildCiSignalEmission,
  type CiEmission,
  ciSignalEmissionForRollup,
} from "../../../apps/control-plane-worker/src/session/fsm/ci-producer";
import { buildGenesisRecord } from "../../../apps/control-plane-worker/src/session/fsm/genesis";
import { classifyCi } from "../../../apps/control-plane-worker/src/session/fsm/guards";
import { buildLiveGuardResolver } from "../../../apps/control-plane-worker/src/session/fsm/live-resolver";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import type { Env } from "../../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "../sqlite-d1-helper";

const NOW = 1_700_000_000_000;

describe("ci producer — rollup → ci.signal mapping (PR 38)", () => {
  it("buildCiSignalEmission carries ciState on the event + metadata + webhook actor", () => {
    expect(buildCiSignalEmission("green")).toEqual({
      event: { type: "ci.signal", ciState: "green" },
      metadata: { type: "ci.signal", ciState: "green" },
      actor: "webhook",
    });
    expect(buildCiSignalEmission("failing")).toEqual({
      event: { type: "ci.signal", ciState: "failing" },
      metadata: { type: "ci.signal", ciState: "failing" },
      actor: "webhook",
    });
    expect(buildCiSignalEmission("absent")).toEqual({
      event: { type: "ci.signal", ciState: "absent" },
      metadata: { type: "ci.signal", ciState: "absent" },
      actor: "webhook",
    });
  });

  it("ciSignalEmissionForRollup maps green/failing/absent → emission and pending → null (live-read guard)", () => {
    expect(ciSignalEmissionForRollup("green")?.event).toEqual({ type: "ci.signal", ciState: "green" });
    expect(ciSignalEmissionForRollup("failing")?.event).toEqual({ type: "ci.signal", ciState: "failing" });
    expect(ciSignalEmissionForRollup("absent")?.event).toEqual({ type: "ci.signal", ciState: "absent" });
    // `pending` dominates in reduceCiState and is a live-read guard — never a settled event.
    expect(ciSignalEmissionForRollup("pending")).toBeNull();
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

describe("ci producer — applyEvent integration over the spine row (PR 38)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const depsFor = (sid: string, ciState: "green" | "failing" | "absent") => {
    const env = { DB: db, DD_API_KEY: undefined, WORKER_ENV: "test" } as unknown as Env;
    return {
      db,
      env,
      now: () => NOW,
      resolver: buildLiveGuardResolver(env, sid, { ciBucket: classifyCi(ciState) }),
      emit: vi.fn(async () => true),
      sideEffects: noopSideEffectSink,
      worklist: noopWorklistSink,
    };
  };

  const apply = (sid: string, emission: CiEmission, ciState: "green" | "failing" | "absent") =>
    applyEvent(depsFor(sid, ciState), {
      sessionId: sid,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });

  it("REVIEW + ci.signal(failing) [no inflight ∧ under cap] dispatches a ciFix epoch (stays REVIEW, inc rounds)", async () => {
    const sid = "sess-ci-fail";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "REVIEW", headSha: "h1" });
    const r = await apply(sid, buildCiSignalEmission("failing"), "failing");
    expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.ciFixRounds).toBe(1);
    expect(rec?.inFlightEpochId).not.toBeNull();
  });

  it("REVIEW + ci.signal(failing) at the ciFix cap trips NEEDS_YOU(ci_fix_exhausted)", async () => {
    const sid = "sess-ci-cap";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      headSha: "h1",
      ciFixRounds: 3, // at MAX_CI_FIX_ROUNDS → !under_ci_fix_cap
    });
    const r = await apply(sid, buildCiSignalEmission("failing"), "failing");
    expect(r).toMatchObject({ outcome: "handled", to: "NEEDS_YOU" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("NEEDS_YOU");
    expect(rec?.blockedReason).toBe("ci_fix_exhausted");
  });

  it("REVIEW + ci.signal(green) is a self-loop that resets ci_fix_rounds (FG-2)", async () => {
    const sid = "sess-ci-green";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      headSha: "h1",
      ciFixRounds: 2,
    });
    const r = await apply(sid, buildCiSignalEmission("green"), "green");
    expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.ciFixRounds).toBe(0);
  });

  it("MERGE_READY + ci.signal(failing) under the flap cap re-opens to REVIEW", async () => {
    const sid = "sess-ci-reopen";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "MERGE_READY", headSha: "h1" });
    const r = await apply(sid, buildCiSignalEmission("failing"), "failing");
    expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.mergeReadyReopenCount).toBe(1);
  });
});
