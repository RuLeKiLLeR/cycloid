import type { UiLifecycleStage } from "../../../../../shared/session/lifecycle-stage.js";
import type { CycloidDoneStatus, ReviewLoopDoneState } from "../../../../../shared/session/phase.js";
import type { SessionViewReadTiming } from "../../types";
import { getPrCoordination } from "../pr-coordination-db";
import { cycloidDoneOf, reviewLoopDoneStateOf, uiLifecycleStageOf } from "./project";
import { FSM_STATES, type FsmRecord } from "./types";

export interface SpineDoneMirror {
  cycloidDone: CycloidDoneStatus;
  reviewLoopDoneState: ReviewLoopDoneState | null;
  uiLifecycleStage: UiLifecycleStage;
}

function fallbackSpineDoneMirror(): SpineDoneMirror {
  return {
    cycloidDone: { state: "working", outcome: null, reasons: [] },
    reviewLoopDoneState: null,
    uiLifecycleStage: null,
  };
}

export async function resolveSpineDoneMirror(
  db: D1Database | null | undefined,
  sessionId: string,
  timing?: SessionViewReadTiming,
): Promise<SpineDoneMirror> {
  const startedAt = Date.now();
  if (!db) {
    if (timing) {
      timing.durationMs = Date.now() - startedAt;
      timing.outcome = "fallback";
      timing.errorClass = "MissingD1Database";
    }
    return fallbackSpineDoneMirror();
  }
  const record = await getPrCoordination(db, sessionId).catch((err) => {
    if (timing) {
      timing.outcome = "fallback";
      timing.errorClass = err instanceof Error ? err.name : typeof err;
    }
    return null;
  });
  if (timing) {
    timing.durationMs = Date.now() - startedAt;
    timing.outcome ??= "success";
  }
  if (!record || !(FSM_STATES as readonly string[]).includes(record.state)) {
    if (timing) {
      timing.outcome = "fallback";
    }
    return fallbackSpineDoneMirror();
  }
  const fsmRecord = record as FsmRecord;
  return {
    cycloidDone: cycloidDoneOf(fsmRecord),
    reviewLoopDoneState: reviewLoopDoneStateOf(fsmRecord),
    uiLifecycleStage: uiLifecycleStageOf(fsmRecord.state),
  };
}
