// ARC-1330 — NO-SIGNAL ADVANCE producer: bounded CI re-poll on the per-session DO alarm for EVERY
// published PR. This is the FSM-native carrier that mints MERGE_READY for the no-CI / configured-but-
// silent-bot cohort: publish arms a per-session deadline, the alarm reads the current PR head's CI state,
// and settled CI buckets route through the existing `shadowEmitCiSignal` carrier. Arming is universal
// because the fire path ONLY ever reads the live head honestly and never fabricates green (see
// `shadowFireDueNoSignalAdvance` / honest-ci-read.ts): a repo with real CI reads green/failing/pending
// honestly (and the CI-webhook producer's emit dedups the re-poll), while a no-CI repo gets the
// `ci.signal(absent)` that both settles MERGE_READY and corroborates every later honest read.

import { NO_SIGNAL_ADVANCE_WINDOW_MS } from "../../constants/review-loop";
import { getInstallationByOwner } from "../../github/installations-db";
import { createInstallationToken } from "../../github/octokit";
import { parseGithubPullRequestUrl } from "../../github/verification-pr-context";
import { readHeadCiState, type ReviewLoopCiState } from "../../services/review-loop-rollup";
import type { Env } from "../../types";
import { getPrCoordination, type PrCoordinationRecord } from "../pr-coordination-db";
import { shadowEmitCiSignal } from "./ci-producer";
import type { CiSignalState } from "./types";

/**
 * DO-storage key holding the next no-signal advance fire deadline (ms epoch). Written at publish time
 * by `armNoSignalAdvanceOnPrOpened`, projected by `SessionDO.rescheduleSessionAlarm`, and advanced or
 * deleted by the alarm tick after `shadowFireDueNoSignalAdvance`.
 */
export const FSM_NO_SIGNAL_ADVANCE_DEADLINE_STORAGE_KEY = "fsm_no_signal_advance_deadline";

/** Small DO-storage counter for the ≥2 consecutive absent polls debounce. */
export const FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY = "fsm_no_signal_advance_absent_count";

/** Last emitted settled CI bucket for the current record context, used to suppress unchanged re-emits. */
export const FSM_NO_SIGNAL_ADVANCE_LAST_EMIT_STORAGE_KEY = "fsm_no_signal_advance_last_emit";

type NoSignalAdvanceStorage = Pick<DurableObjectStorage, "delete" | "get" | "put">;

type NoSignalLogger = { warn: (obj: Record<string, unknown>, msg: string) => void };

interface AbsentPollState {
  headSha: string;
  count: number;
}

interface LastEmitState {
  ciState: CiSignalState;
  contextKey: string;
}

export interface NoSignalAdvanceArmInput {
  sessionId: string;
  prUrl: string;
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
  now: number;
  armNoSignalAdvanceAlarm?: (deadlineMs: number) => Promise<void>;
}

export interface NoSignalAdvanceArmOutcome {
  armed: boolean;
  deadlineMs: number | null;
}

export interface NoSignalAdvanceFireOptions {
  storage: NoSignalAdvanceStorage;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface NoSignalAdvanceFireResult {
  ok: boolean;
  reArm: boolean;
  emitted: boolean;
  ciState: ReviewLoopCiState | null;
}

const NO_SIGNAL_KEEPALIVE_STATES = new Set(["REVIEW", "VERIFYING", "MERGE_READY", "NEEDS_YOU"]);

function isSettledCiState(ciState: ReviewLoopCiState): ciState is CiSignalState {
  return ciState !== "pending";
}

function keepAliveState(record: PrCoordinationRecord): boolean {
  return NO_SIGNAL_KEEPALIVE_STATES.has(record.state);
}

function shouldPoll(record: PrCoordinationRecord): boolean {
  return record.state === "REVIEW";
}

function shouldRetainAuxiliaryState(record: PrCoordinationRecord | null): boolean {
  return record?.state === "REVIEW" || record?.state === "VERIFYING";
}

function noPollResult(reArm: boolean): NoSignalAdvanceFireResult {
  return { ok: true, reArm, emitted: false, ciState: null };
}

function faultResult(): NoSignalAdvanceFireResult {
  return { ok: false, reArm: true, emitted: false, ciState: null };
}

function noSignalEmissionContextKey(record: PrCoordinationRecord): string {
  return JSON.stringify([
    record.state,
    record.headSha,
    record.codeChangedSinceVerification,
    record.verdict,
    record.verdictHeadSha,
    record.verificationRunId,
    record.inFlightEpochId,
    record.ciFixRounds,
  ]);
}

function parseAbsentPollState(raw: unknown, headSha: string): AbsentPollState {
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { headSha?: unknown }).headSha === headSha &&
    typeof (raw as { count?: unknown }).count === "number" &&
    Number.isFinite((raw as { count: number }).count)
  ) {
    return { headSha, count: Math.max(0, Math.floor((raw as { count: number }).count)) };
  }
  return { headSha, count: 0 };
}

function parseLastEmitState(raw: unknown): LastEmitState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as { ciState?: unknown; contextKey?: unknown };
  if (
    (candidate.ciState === "green" || candidate.ciState === "failing" || candidate.ciState === "absent") &&
    typeof candidate.contextKey === "string"
  ) {
    return { ciState: candidate.ciState, contextKey: candidate.contextKey };
  }
  return null;
}

async function clearAuxiliaryNoSignalStorage(storage: NoSignalAdvanceStorage): Promise<void> {
  await storage.delete(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY);
  await storage.delete(FSM_NO_SIGNAL_ADVANCE_LAST_EMIT_STORAGE_KEY);
}

/**
 * Arm the no-signal advance poll for EVERY just-opened PR. There is no expected-bot / checklist gate: a
 * repo with configured review bots but no CI (or bots that never actually review) has no other carrier to
 * mint MERGE_READY once its worklist is caught up, and the pre-#7003 no-show escape is gone. Arming
 * universally is SOUND because the fire path never fabricates green — it reads the live head honestly and
 * only routes a genuinely settled bucket — so at worst a repo whose CI signal already arrived via webhook
 * pays a deduped re-poll. Best-effort by contract: any fault returns `{armed:false}` and leaves the session
 * on the normal REVIEW backstop rather than blocking publish.
 */
export async function armNoSignalAdvanceOnPrOpened(
  env: Env,
  input: NoSignalAdvanceArmInput,
  log?: NoSignalLogger,
): Promise<NoSignalAdvanceArmOutcome> {
  const none: NoSignalAdvanceArmOutcome = { armed: false, deadlineMs: null };
  // Fail closed when D1 is unbound (local/test): arming an alarm the fire path could never service
  // (its `getPrCoordination` read needs D1) is pointless. Inlined — the arm body itself never touches D1.
  if (!env.DB || typeof (env.DB as Partial<D1Database>).prepare !== "function") return none;
  const repoOwner = input.repoOwner.trim();
  const repoName = input.repoName.trim();
  if (!Number.isSafeInteger(input.ownerUserId) || input.ownerUserId <= 0 || !repoOwner || !repoName || !input.prUrl) {
    return none;
  }

  try {
    const deadlineMs = input.now + NO_SIGNAL_ADVANCE_WINDOW_MS;
    await input.armNoSignalAdvanceAlarm?.(deadlineMs);
    return { armed: true, deadlineMs };
  } catch (error) {
    log?.warn(
      { sessionId: input.sessionId, prUrl: input.prUrl, error: String(error) },
      "fsm no-signal advance arm failed (ignored)",
    );
    return none;
  }
}

/**
 * STANDING-STOCK self-heal predicate (DO alarm tick). The universal publish-time arm above only helps NEW
 * publishes; a review-listening REVIEW row published BEFORE this fix has no deadline armed, so its drain
 * never runs and an epoch-terminal recompute reads its zero-checks head as UNCORROBORATED-absent → pending
 * forever (the wedge / hot-loop). Re-arm once, on the first alarm tick, when the session is review-listening
 * and no deadline is already armed; the existing fire machinery (debounce + honest read + dedup) owns
 * everything after, so this can never fabricate green either. Idempotent: a no-op once a key exists.
 */
export function shouldSelfArmNoSignalAdvance(reviewListeningActive: boolean, hasArmedDeadline: boolean): boolean {
  return reviewListeningActive === true && !hasArmedDeadline;
}

/**
 * Fire one due no-signal advance tick. Only REVIEW polls GitHub; VERIFYING keeps the alarm alive with
 * its debounce/dedup context, and re-openable MERGE_READY/NEEDS_YOU keep only the deadline alive so a
 * later REVIEW re-entry gets a bounded CI signal. All other terminal/non-review states clean-stop.
 */
export async function shadowFireDueNoSignalAdvance(
  env: Env,
  sessionId: string,
  now: number,
  opts: NoSignalAdvanceFireOptions,
  log?: NoSignalLogger,
): Promise<NoSignalAdvanceFireResult> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return noPollResult(false);

  try {
    const record = await getPrCoordination(db, sessionId);
    if (!record || !record.prUrl || !record.headSha || !keepAliveState(record)) {
      await clearAuxiliaryNoSignalStorage(opts.storage);
      return noPollResult(false);
    }
    if (!shouldPoll(record)) {
      if (!shouldRetainAuxiliaryState(record)) await clearAuxiliaryNoSignalStorage(opts.storage);
      return noPollResult(true);
    }

    const parsed = parseGithubPullRequestUrl(record.prUrl);
    if (!parsed) {
      await clearAuxiliaryNoSignalStorage(opts.storage);
      return noPollResult(false);
    }
    const headSha = record.headSha;
    const installation = await getInstallationByOwner(db, parsed.owner);
    if (!installation || installation.suspended_at !== null) return faultResult();
    const token = await createInstallationToken(env, installation.installation_id);
    const ciState = await readHeadCiState(token, parsed.owner, parsed.repo, headSha);

    const latest = await getPrCoordination(db, sessionId);
    if (!latest || !keepAliveState(latest)) {
      await clearAuxiliaryNoSignalStorage(opts.storage);
      return { ok: true, reArm: false, emitted: false, ciState };
    }
    if (latest.headSha !== headSha || !shouldPoll(latest)) {
      if (!shouldRetainAuxiliaryState(latest)) await clearAuxiliaryNoSignalStorage(opts.storage);
      return { ok: true, reArm: keepAliveState(latest), emitted: false, ciState };
    }

    if (ciState !== "absent") {
      await opts.storage.delete(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY);
    } else {
      const absentState = parseAbsentPollState(
        await opts.storage.get(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY),
        headSha,
      );
      const nextAbsentState = { headSha, count: absentState.count + 1 };
      await opts.storage.put(FSM_NO_SIGNAL_ADVANCE_ABSENT_COUNT_STORAGE_KEY, nextAbsentState);
      if (nextAbsentState.count < 2) {
        return { ok: true, reArm: true, emitted: false, ciState };
      }
    }

    if (!isSettledCiState(ciState)) {
      return { ok: true, reArm: true, emitted: false, ciState };
    }

    const contextKey = noSignalEmissionContextKey(latest);
    const lastEmit = parseLastEmitState(await opts.storage.get(FSM_NO_SIGNAL_ADVANCE_LAST_EMIT_STORAGE_KEY));
    if (lastEmit?.ciState === ciState && lastEmit.contextKey === contextKey) {
      return { ok: true, reArm: true, emitted: false, ciState };
    }

    await shadowEmitCiSignal(env, sessionId, ciState, log, opts.waitUntil);
    const afterEmit = await getPrCoordination(db, sessionId);
    const reArm = afterEmit ? keepAliveState(afterEmit) : false;
    if (afterEmit && afterEmit.version !== latest.version && shouldRetainAuxiliaryState(afterEmit)) {
      await opts.storage.put(FSM_NO_SIGNAL_ADVANCE_LAST_EMIT_STORAGE_KEY, {
        ciState,
        contextKey: noSignalEmissionContextKey(afterEmit),
      });
    }
    if (!shouldRetainAuxiliaryState(afterEmit)) {
      await clearAuxiliaryNoSignalStorage(opts.storage);
    }

    return { ok: true, reArm, emitted: true, ciState };
  } catch (error) {
    log?.warn({ sessionId, now, error: String(error) }, "fsm no-signal advance producer failed (ignored)");
    return faultResult();
  }
}
