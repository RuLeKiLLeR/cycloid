// ARC-1330 lifecycle FSM (PR 35) — `pr_coordination` ROW GENESIS at `CREATED`.
//
// Every NEW session gets its single `pr_coordination` row INSERTed at genesis, in the `CREATED`
// state (design §4: "Row exists from genesis (F8/F11/F17)"; §3 state table: `CREATED` = "Row created
// (keyed session_id), no sandbox"). This is the row the spine (`applyEvent`, PR 34) and every later
// producer (PR 36–44) reads/CASes — `applyEvent` early-returns `no_record` against a missing row, so
// without this insert a session is invisible to the FSM (the PR 35A backfill is the analog for the
// pre-shadow in-flight cohort).
//
// FAULT ISOLATION: the producer call site (`createSessionState`) wraps this BEST-EFFORT/try-caught OFF
// the legacy critical path, so a genesis fault never perturbs session creation. It is also
// self-idempotent (a SELECT guard) because the session-create funnel can retry with the same
// `sessionId` (a DO-initialize retry).
//
// `init_record` (design §4) later SETS `pr_url`/`head_sha`/counters on THIS existing row at publish —
// genesis never writes a second row (F20). Genesis only stamps the `CREATED` shell + `state_entered_at`.

import { createLogger } from "../../logger";
import { getPrCoordination, insertPrCoordination, type PrCoordinationRecord } from "../pr-coordination-db";
import type { FsmRecord } from "./types";

const log = createLogger({ bindings: { component: "fsm-genesis" } });

/**
 * The genesis `CREATED` record (design §4 initial column set). `version=0`; every nullable field null;
 * every counter 0; `code_changed_since_verification=false` (D12 inits it TRUE only at `init_record`,
 * i.e. publish — at `CREATED` it is the column default 0). `state_entered_at := now` arms the dwell
 * anchor (design §18.1) from the first instant. Pure — no I/O — so it is unit-testable in isolation and
 * the insert side is a thin wrapper. Returns the full `FsmRecord` (the `PrCoordinationRecord` refined
 * to the closed `CREATED` state) so callers/tests can assert on the typed shape.
 */
export function buildGenesisRecord(sessionId: string, now: number): FsmRecord {
  return {
    sessionId,
    version: 0,
    state: "CREATED",
    prUrl: null,
    headSha: null,
    verdict: null,
    verdictHeadSha: null,
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
    stateEnteredAt: now,
  };
}

/** Outcome of a genesis attempt (observe-only; producers ignore it, the integration test asserts it). */
export type GenesisOutcome = "inserted" | "exists";

export interface GenesisDeps {
  db: D1Database;
  /** Clock seam (deterministic in tests). */
  now: () => number;
}

/**
 * Insert the `CREATED` genesis row for a new session (the design §4 row-from-genesis guarantee),
 * idempotent. A SELECT guard makes a same-`sessionId` retry a no-op (`exists`) instead of a PK-collision
 * throw, so the common DO-initialize retry stays quiet. A rarer concurrent-INSERT race still throws — the
 * CALLER wraps this best-effort off the legacy path (fault isolation), so a thrown duplicate is swallowed
 * there, not here.
 */
export async function insertGenesisRecord(deps: GenesisDeps, sessionId: string): Promise<GenesisOutcome> {
  // Idempotency guard: the session-create funnel can re-run for the same session (DO initialize retry),
  // and `init_record` mutates this same row — a second INSERT would PK-collide. A present row means
  // genesis (or a later transition) already ran; leave it untouched.
  const existing = await getPrCoordination(deps.db, sessionId);
  if (existing) {
    return "exists";
  }
  const record: PrCoordinationRecord = buildGenesisRecord(sessionId, deps.now());
  await insertPrCoordination(deps.db, record);
  log.debug({ sessionId }, "fsm genesis: inserted CREATED pr_coordination row");
  return "inserted";
}
