// ARC-1330 (W11-G3) — POST /api/admin/fsm/parity-check param validation + terminal-cohort wiring.
//
// Proves the route contract: `limit` must be a positive number; an empty body runs the default-limit batch;
// the route enumerates the terminal cohort and wires the GitHub ground-truth reader. With no GitHub creds
// on `env`, the injected reader resolves a null token → `pr_unreadable` → `no_ground_truth` (NEVER an
// agreement — the empty-metric-reads-as-GO trap the checker exists to avoid), so the route exercises the
// full read/classify/emit path with zero network. READ-ONLY — no spine writes.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  adminFsmParityCheckRoutes,
  reconcileDivergedTerminals,
} from "../../../apps/control-plane-worker/src/routes/admin-fsm-parity-check";
import type { ParityRow } from "../../../apps/control-plane-worker/src/session/fsm/parity-check";
import {
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { listPrCoordinationEvents } from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
import type { AuthInfo, Env } from "../../../apps/control-plane-worker/src/types";
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

const route = adminFsmParityCheckRoutes[0];

const ADMIN_AUTH: AuthInfo = {
  userId: "1",
  tokenSource: "admin-token",
  authMode: "admin_token",
  canAccessAllSessions: true,
};

const NON_ADMIN_AUTH: AuthInfo = {
  userId: "42",
  tokenSource: "cli-token",
  authMode: "cli_token",
  canAccessAllSessions: false,
};

function request(body: Record<string, unknown>): Request {
  return new Request("https://example.com/api/admin/fsm/parity-check", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const NOW = 1_700_000_000_000;

function terminalRow(overrides: Partial<PrCoordinationRecord>): PrCoordinationRecord {
  return {
    sessionId: "sess-1",
    version: 5,
    state: "MERGED",
    prUrl: "https://github.com/acme/app/pull/7",
    headSha: "h1",
    verdict: "pass",
    verdictHeadSha: "h1",
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: false,
    promptIntendsChange: null,
    mergeReadyReopenCount: 0,
    blockedReason: null,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: NOW,
    ...overrides,
  };
}

describe("POST /api/admin/fsm/parity-check — validation + terminal-cohort wiring", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    db = new SqliteD1(createMigratedSqlite()) as unknown as D1Database;
    // No GITHUB_APP_ID/PRIVATE_KEY: the injected reader resolves a null token → pr_unreadable.
    // No DD_API_KEY: the real `postStructuredEventToDd` no-ops (no network) — the route wires the real
    // emit (no injectable mock, matching the production path), so the batch runs emit-side-effect-free.
    env = { DB: db, WORKER_ENV: "test" } as unknown as Env;
  });

  it("rejects a non-positive limit with 400", async () => {
    const res = await route.handler(request({ limit: 0 }), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("limit");
  });

  it("rejects a non-numeric limit with 400", async () => {
    const res = await route.handler(request({ limit: "ten" }), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(400);
  });

  it("rejects a non-admin session with 403 (fails closed)", async () => {
    const res = await route.handler(request({}), env, [] as unknown as RegExpMatchArray, NON_ADMIN_AUTH);
    expect(res.status).toBe(403);
  });

  it("empty body runs the default-limit batch over an empty cohort (clean zeroed report)", async () => {
    const res = await route.handler(request({}), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      report: { checked: number; agree: number; diverge: number; noGroundTruth: number };
      rows: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.report).toMatchObject({ checked: 0, agree: 0, diverge: 0, noGroundTruth: 0 });
    expect(body.rows).toEqual([]);
  });

  it("checks terminal-cohort rows; a null token classifies as no_ground_truth, NEVER agreement", async () => {
    await insertPrCoordination(db, terminalRow({ sessionId: "merged-1", state: "MERGED" }));
    await insertPrCoordination(db, terminalRow({ sessionId: "needsyou-1", state: "NEEDS_YOU" }));
    // Outside the cohort — must not be checked.
    await insertPrCoordination(db, terminalRow({ sessionId: "review-1", state: "REVIEW" }));

    const res = await route.handler(request({}), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { checked: number; agree: number; noGroundTruth: number };
      rows: Array<{ sessionId: string; result: string; reason: string }>;
    };
    // Two cohort rows checked, both no_ground_truth (no creds → pr_unreadable), zero false agreements.
    expect(body.report).toMatchObject({ checked: 2, agree: 0, noGroundTruth: 2 });
    expect(body.rows.map((r) => r.sessionId).sort()).toEqual(["merged-1", "needsyou-1"]);
    expect(body.rows.every((r) => r.result === "no_ground_truth" && r.reason === "pr_unreadable")).toBe(true);
  });

  // ── W11-T2: stock re-emit (reconcile) ─────────────────────────────────────────
  it("rejects a non-boolean reconcile with 400", async () => {
    const res = await route.handler(request({ reconcile: "yes" }), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("reconcile");
  });

  it("default run omits the reconcile field (read-only preserved)", async () => {
    const res = await route.handler(request({}), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("reconcile");
  });

  it("reconcile:true with no creds reconciles nothing (no diverge without ground truth) and never fabricates a terminal", async () => {
    await insertPrCoordination(db, terminalRow({ sessionId: "needsyou-1", state: "NEEDS_YOU" }));
    const res = await route.handler(request({ reconcile: true }), env, [] as unknown as RegExpMatchArray, ADMIN_AUTH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reconcile: { reconciled: number; skipped: number } };
    expect(body.reconcile).toEqual({ reconciled: 0, skipped: 0 });
    // No ground truth → no divergence → the wedged row is untouched (soundness: only an OBSERVED merge mints).
    expect((await getPrCoordination(db, "needsyou-1"))?.state).toBe("NEEDS_YOU");
  });
});

function divergedRow(overrides: Partial<ParityRow> & { sessionId: string }): ParityRow {
  return {
    businessId: null,
    spineState: "NEEDS_YOU",
    spineVersion: 1,
    result: "diverge",
    source: "github_pr",
    reason: "spine_NEEDS_YOU_pr_merged",
    expectedPrStates: ["open"],
    observedPrState: "merged",
    ...overrides,
  };
}

describe("reconcileDivergedTerminals — the W11-T2 stock re-emit", () => {
  let db: D1Database;
  let env: Env;
  beforeEach(() => {
    db = new SqliteD1(createMigratedSqlite()) as unknown as D1Database;
    env = { DB: db, FSM_MODE: "shadow", WORKER_ENV: "test" } as unknown as Env;
  });

  it("a diverged NEEDS_YOU row whose PR is observed merged → MERGED via the real §10 edge", async () => {
    await insertPrCoordination(db, terminalRow({ sessionId: "s1", state: "NEEDS_YOU", version: 0 }));
    const report = await reconcileDivergedTerminals(env, [divergedRow({ sessionId: "s1", observedPrState: "merged" })]);
    expect(report).toEqual({ reconciled: 1, skipped: 0 });
    expect((await getPrCoordination(db, "s1"))?.state).toBe("MERGED");
    // Proves the transition ran the normal edge (a committed journal row), not a hand-written state.
    const log = await listPrCoordinationEvents(db, "s1");
    expect(log[0]).toMatchObject({ toState: "MERGED", event: "pr.merged", actor: "internal" });
  });

  it("a diverged MERGE_READY row whose PR is observed closed → CLOSED", async () => {
    await insertPrCoordination(db, terminalRow({ sessionId: "s1", state: "MERGE_READY", version: 0 }));
    const report = await reconcileDivergedTerminals(env, [
      divergedRow({
        sessionId: "s1",
        spineState: "MERGE_READY",
        observedPrState: "closed",
        reason: "spine_MERGE_READY_pr_closed",
      }),
    ]);
    expect(report).toEqual({ reconciled: 1, skipped: 0 });
    expect((await getPrCoordination(db, "s1"))?.state).toBe("CLOSED");
  });

  it("skips (idempotent no-op) a row already in a final terminal — the edge is unhandled there", async () => {
    await insertPrCoordination(db, terminalRow({ sessionId: "s1", state: "MERGED", version: 0 }));
    // A stale/odd diverge (PR shows closed, spine already MERGED). pr.closed is unhandled in a final terminal.
    const report = await reconcileDivergedTerminals(env, [
      divergedRow({
        sessionId: "s1",
        spineState: "MERGED",
        observedPrState: "closed",
        reason: "spine_MERGED_pr_closed",
      }),
    ]);
    expect(report).toEqual({ reconciled: 0, skipped: 1 });
    expect((await getPrCoordination(db, "s1"))?.state).toBe("MERGED");
  });

  it("ignores non-eligible rows: an open/absent observation and an agreeing row are never re-emitted", async () => {
    await insertPrCoordination(db, terminalRow({ sessionId: "open-1", state: "NEEDS_YOU", version: 0 }));
    await insertPrCoordination(db, terminalRow({ sessionId: "agree-1", state: "MERGED", version: 0 }));
    const report = await reconcileDivergedTerminals(env, [
      divergedRow({ sessionId: "open-1", observedPrState: "open", reason: "n/a" }),
      { ...divergedRow({ sessionId: "agree-1" }), result: "agree", observedPrState: "merged" },
    ]);
    // Open observation is not a mintable terminal; an agreeing row is not diverged → neither is counted.
    expect(report).toEqual({ reconciled: 0, skipped: 0 });
    expect((await getPrCoordination(db, "open-1"))?.state).toBe("NEEDS_YOU");
  });
});
