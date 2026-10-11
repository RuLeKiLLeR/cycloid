// ARC-1330 (PR 42) — verification-verdict producer: a verification child's terminal verdict →
// `verification.pass/app_breaks/skipped/stopped/failed/run_limit{head_sha, run_id}` on the shadow spine.
//
// The PR-42 contract test: the PURE classifier (the spec-named "verdict mapping" — total over the six
// outcomes, echoing the run-identity token, B4 token-less guard) + the `VerifierTerminalResult → outcome`
// derivation (CONCLUSIVE→pass, INCONCLUSIVE→app_breaks, INCONCLUSIVE-exhausted→run_limit) + the
// record-derived resolver, then a small integration leg driving `applyEvent` over a real migrated D1 (the
// Wave-1 createMigratedSqlite/asD1 idiom) proving a FRESH verdict's echoed run_id is what the spine accepts
// (VERIFYING→REVIEW, stamping the validated head) while a SUPERSEDED run's echoed run_id is ghost-discarded
// (self-loops in VERIFYING, no record) — the run-identity echo end-to-end.
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
import { buildLiveGuardResolver } from "../../../apps/control-plane-worker/src/session/fsm/live-resolver";
import {
  classifyVerificationOutcome,
  shadowEmitVerificationOutcome,
  shadowEmitVerificationTerminalOutcome,
  shadowEmitVerifierTerminalVerdict,
  type VerificationEmission,
  verificationOutcomeFromVerifierResult,
} from "../../../apps/control-plane-worker/src/session/fsm/verification-producer";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { listForPr } from "../../../apps/control-plane-worker/src/session/pr-review-item-disposition-db";
import type { Env } from "../../../apps/control-plane-worker/src/types";
import type { VerifierTerminalResult } from "../../../shared/types/sandbox";
import { SqliteD1 } from "../sqlite-d1-helper";

const NOW = 1_700_000_000_000;

const verifierResult = (over: Partial<VerifierTerminalResult> = {}): VerifierTerminalResult => ({
  verdict: "CONCLUSIVE",
  verifiedHeadSha: "headH",
  summary: "ok",
  evidence: [],
  blockers: [],
  ...over,
});

describe("verification producer — verdict mapping + run_id echo (PR 42)", () => {
  it("classifyVerificationOutcome: verdict-bearing outcomes carry head + run_id on event AND the §18.6 slice", () => {
    expect(classifyVerificationOutcome({ outcome: "pass", runId: 6, headSha: "abc" })).toEqual({
      event: { type: "verification.pass", headSha: "abc", runId: 6 },
      metadata: { type: "verification.pass", verificationRunId: 6, verdict: "pass", headSha: "abc" },
      actor: "verification",
    });
    expect(classifyVerificationOutcome({ outcome: "app_breaks", runId: 4, headSha: "def" })).toEqual({
      event: { type: "verification.app_breaks", headSha: "def", runId: 4 },
      metadata: { type: "verification.app_breaks", verificationRunId: 4, verdict: "app_breaks", headSha: "def" },
      actor: "verification",
    });
    expect(classifyVerificationOutcome({ outcome: "skipped", runId: 2, headSha: "ghi" })).toEqual({
      event: { type: "verification.skipped", headSha: "ghi", runId: 2 },
      metadata: { type: "verification.skipped", verificationRunId: 2, verdict: "skipped", headSha: "ghi" },
      actor: "verification",
    });
  });

  it("classifyVerificationOutcome: non-head terminals carry only run_id on the event; metadata verdict=none", () => {
    expect(classifyVerificationOutcome({ outcome: "run_limit", runId: 9, headSha: "h" })).toEqual({
      event: { type: "verification.run_limit", runId: 9 },
      metadata: { type: "verification.run_limit", verificationRunId: 9, verdict: "none", headSha: "h" },
      actor: "verification",
    });
    expect(classifyVerificationOutcome({ outcome: "stopped", runId: 3, headSha: null })).toEqual({
      event: { type: "verification.stopped", runId: 3 },
      metadata: { type: "verification.stopped", verificationRunId: 3, verdict: "none", headSha: null },
      actor: "verification",
    });
    expect(classifyVerificationOutcome({ outcome: "failed", runId: 1, headSha: null })).toEqual({
      event: { type: "verification.failed", runId: 1 },
      metadata: { type: "verification.failed", verificationRunId: 1, verdict: "none", headSha: null },
      actor: "verification",
    });
  });

  it("classifyVerificationOutcome: missing run token ⇒ null (no token-less false accept, B4)", () => {
    expect(classifyVerificationOutcome({ outcome: "pass", runId: undefined, headSha: "abc" })).toBeNull();
    expect(classifyVerificationOutcome({ outcome: "run_limit", runId: undefined, headSha: null })).toBeNull();
  });

  it("classifyVerificationOutcome: a verdict-bearing outcome with no validated head ⇒ null (no empty stamp)", () => {
    expect(classifyVerificationOutcome({ outcome: "pass", runId: 6, headSha: null })).toBeNull();
    expect(classifyVerificationOutcome({ outcome: "app_breaks", runId: 6, headSha: "" })).toBeNull();
  });

  // A4: `verificationFindingSourceIds` retired — the app_breaks verdict no longer injects spine findings
  // (QA re-intake rides the managed QA comment admitted as known:cycloid-qa).

  it("verificationOutcomeFromVerifierResult: CONCLUSIVE→pass; INCONCLUSIVE→app_breaks; exhausted→run_limit", () => {
    expect(verificationOutcomeFromVerifierResult(verifierResult({ verdict: "CONCLUSIVE" }), { exhausted: false })).toBe(
      "pass",
    );
    // exhausted is ignored for a CONCLUSIVE (a merge-ready that simply landed on the last run still converged).
    expect(verificationOutcomeFromVerifierResult(verifierResult({ verdict: "CONCLUSIVE" }), { exhausted: true })).toBe(
      "pass",
    );
    expect(
      verificationOutcomeFromVerifierResult(verifierResult({ verdict: "INCONCLUSIVE" }), { exhausted: false }),
    ).toBe("app_breaks");
    expect(
      verificationOutcomeFromVerifierResult(verifierResult({ verdict: "INCONCLUSIVE" }), { exhausted: true }),
    ).toBe("run_limit");
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

describe("verification producer — applyEvent integration over the spine row (PR 42)", () => {
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

  const apply = (sid: string, emission: VerificationEmission) =>
    applyEvent(depsFor(sid), {
      sessionId: sid,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });

  it("VERIFYING + a FRESH verdict (echoed run_id == active) accepts → REVIEW, stamping the validated head", async () => {
    const sid = "sess-verif-fresh";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "VERIFYING",
      headSha: "headH",
      verificationRunId: 6,
      verificationChildId: "child-active",
    });
    // The child echoes the ACTIVE run (6) → fresh accept.
    const emission = classifyVerificationOutcome({ outcome: "pass", runId: 6, headSha: "headH" });
    const r = await apply(sid, emission!);
    expect(r).toMatchObject({ outcome: "handled", from: "VERIFYING", to: "REVIEW" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.verdict).toBe("pass");
    expect(rec?.verdictHeadSha).toBe("headH"); // stamped against the validated head → fresh
  });

  it("VERIFYING + a SUPERSEDED run's verdict (echoed run_id != active) is ghost-discarded → stays VERIFYING, no record", async () => {
    const sid = "sess-verif-ghost";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "VERIFYING",
      headSha: "headH",
      verificationRunId: 6, // active run is 6
      verificationChildId: "child-active",
    });
    // ABA ghost: a late verdict echoing run 5 (a SUPERSEDED run) — head matches again, but run 5 != active 6.
    const emission = classifyVerificationOutcome({ outcome: "pass", runId: 5, headSha: "headH" });
    const r = await apply(sid, emission!);
    expect(r).toMatchObject({ outcome: "handled", from: "VERIFYING", to: "VERIFYING" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.verdict).toBeNull(); // NOT recorded — the stale-pass false accept is rejected (B4)
  });

  it("INCONCLUSIVE that exhausted the run cap → verification.run_limit → NEEDS_YOU(verification_run_limit)", async () => {
    const sid = "sess-verif-runlimit";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "VERIFYING",
      headSha: "headH",
      verificationRunId: 6,
      verificationChildId: "child-active",
    });
    const outcome = verificationOutcomeFromVerifierResult(
      verifierResult({ verdict: "INCONCLUSIVE", verifiedHeadSha: "headH", verificationRunId: 6 }),
      { exhausted: true },
    );
    const emission = classifyVerificationOutcome({ outcome, runId: 6, headSha: "headH" });
    const r = await apply(sid, emission!);
    expect(r).toMatchObject({ outcome: "handled", from: "VERIFYING", to: "NEEDS_YOU" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.blockedReason).toBe("verification_run_limit");
  });

  it("shadowEmitVerificationOutcome drives the spine end-to-end (accepts a fresh verdict)", async () => {
    const sid = "sess-verif-emit";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "VERIFYING",
      headSha: "headH",
      verificationRunId: 6,
      verificationChildId: "child-active",
    });
    const input = { outcome: "pass" as const, runId: 6, headSha: "headH" };
    const env = { DB: db, DD_API_KEY: undefined, WORKER_ENV: "test" } as never;
    await shadowEmitVerificationOutcome(env, sid, input);
    expect((await getPrCoordination(db, sid))?.verdict).toBe("pass"); // accepted
  });
});

describe("verification producer — verdict-back self-sources the run id (ARC-1330)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  it("no-op when the keyed session has no spine row (the verifier child id would have none)", async () => {
    const env = { DB: db, DD_API_KEY: undefined, WORKER_ENV: "test" } as never;
    await shadowEmitVerifierTerminalVerdict(env, "no-such-parent", verifierResult({ verifiedHeadSha: "headH" }), {
      exhausted: false,
    });
    expect(await getPrCoordination(db, "no-such-parent")).toBeNull();
  });
});

// PR 49 (Fix A): the two prompt-queue seams that sync legacy verification state but carried NO spine
// verdict (planner `skipped`, abnormal `stopped`) — these stranded the parent row in VERIFYING forever.
describe("verification producer — non-verdict-back terminal outcomes unstick VERIFYING (PR 49)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const liveEnv = () => ({ DB: db, FSM_MODE: "live", DD_API_KEY: undefined, WORKER_ENV: "test" }) as never;

  it("live skipped requires the echoed run id and exits when the prompt seam supplies it", async () => {
    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-live-tokenless-skip", NOW),
      state: "VERIFYING",
      headSha: "headH",
      verificationRunId: 9,
    });
    await shadowEmitVerificationTerminalOutcome(liveEnv(), "sess-live-tokenless-skip", {
      outcome: "skipped",
      headSha: "headH",
    });
    expect((await getPrCoordination(db, "sess-live-tokenless-skip"))?.state).toBe("VERIFYING");

    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-live-echoed-skip", NOW),
      state: "VERIFYING",
      headSha: "headH",
      verificationRunId: 9,
    });
    await shadowEmitVerificationTerminalOutcome(liveEnv(), "sess-live-echoed-skip", {
      outcome: "skipped",
      headSha: "headH",
      runId: 9,
    });

    const rec = await getPrCoordination(db, "sess-live-echoed-skip");
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.verdict).toBe("skipped");
    expect(rec?.verdictHeadSha).toBe("headH");
  });

  it("live stopped requires the echoed run id and exits when the prompt seam supplies it", async () => {
    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-live-tokenless-stop", NOW),
      state: "VERIFYING",
      headSha: "headH",
      verificationRunId: 9,
    });
    await shadowEmitVerificationTerminalOutcome(liveEnv(), "sess-live-tokenless-stop", {
      outcome: "stopped",
      headSha: null,
    });
    expect((await getPrCoordination(db, "sess-live-tokenless-stop"))?.state).toBe("VERIFYING");

    await insertPrCoordination(db, {
      ...buildGenesisRecord("sess-live-echoed-stop", NOW),
      state: "VERIFYING",
      headSha: "headH",
      verificationRunId: 9,
    });
    await shadowEmitVerificationTerminalOutcome(liveEnv(), "sess-live-echoed-stop", {
      outcome: "stopped",
      headSha: null,
      runId: 9,
    });

    const rec = await getPrCoordination(db, "sess-live-echoed-stop");
    expect(rec?.state).toBe("NEEDS_YOU");
    expect(rec?.blockedReason).toBe("verification_stopped");
  });
});

// A4: the LIVE app_breaks verdict exit is RECORD-ONLY — no spine finding is injected (QA re-intake rides the
// managed QA comment admitted as known:cycloid-qa). The §4 soundness traps still hold: (i) app_breaks
// PRESERVES verification_run_count; (ii) record_verification stamps verdict_head_sha := the live head. No
// disposition-store finding is registered on ANY verdict verdict-back.
describe("verification producer — LIVE app_breaks verdict exit (A4 record-only)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const liveEnv = () => ({ DB: db, FSM_MODE: "live", DD_API_KEY: undefined, WORKER_ENV: "test" }) as never;

  const PR_URL = "https://github.com/acme/repo/pull/7";

  async function seedVerifyingRow(sid: string): Promise<void> {
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "VERIFYING",
      prUrl: PR_URL,
      headSha: "headH",
      verificationRunId: 6,
      verificationChildId: "child-active",
      verificationRunCount: 1,
    });
  }

  it("live app_breaks records the verdict → REVIEW, run count preserved, and registers NO spine finding (A4)", async () => {
    const sid = "sess-a4-live-appbreaks";
    await seedVerifyingRow(sid);

    await shadowEmitVerificationOutcome(liveEnv(), sid, { outcome: "app_breaks", runId: 6, headSha: "headH" });

    const rec = await getPrCoordination(db, sid);
    // Fresh app_breaks exits VERIFYING → REVIEW.
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.verdict).toBe("app_breaks");
    expect(rec?.verdictHeadSha).toBe("headH"); // §4 trap (ii): verdict_head_sha := live head
    expect(rec?.verificationRunCount).toBe(1); // §4 trap (i): app_breaks does NOT ++ the run count

    // A4: NO disposition-store finding is injected — the QA comment (known:cycloid-qa) is the sole re-intake.
    expect(await listForPr(db, sid, PR_URL)).toEqual([]);
  });

  it("the full verdict-back seam (shadowEmitVerifierTerminalVerdict, live) records app_breaks and injects NO finding", async () => {
    const sid = "sess-a4-seam";
    await seedVerifyingRow(sid);

    await shadowEmitVerifierTerminalVerdict(
      liveEnv(),
      sid,
      verifierResult({ verdict: "INCONCLUSIVE", verifiedHeadSha: "headH", verificationRunId: 6 }),
      { exhausted: false }, // budget remaining → app_breaks (re-openable), NOT run_limit
    );

    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.verdict).toBe("app_breaks");
    expect(await listForPr(db, sid, PR_URL)).toEqual([]);
  });

  it("a live pass verdict on the same row registers NO finding", async () => {
    const sid = "sess-a4-pass";
    await seedVerifyingRow(sid);

    await shadowEmitVerificationOutcome(liveEnv(), sid, { outcome: "pass", runId: 6, headSha: "headH" });

    expect((await getPrCoordination(db, sid))?.verdict).toBe("pass");
    expect(await listForPr(db, sid, PR_URL)).toEqual([]);
  });
});
