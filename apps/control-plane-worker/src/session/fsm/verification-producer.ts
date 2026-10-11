// ARC-1330 lifecycle FSM (PR 42) — VERIFICATION-VERDICT producer: a verification child's terminal verdict →
// `verification.pass/app_breaks/skipped/stopped/failed/run_limit{head_sha, run_id}` on the spine.
//
// The verification child (spawned by `scheduleVerificationForPr`) reports its verdict back on
// its `post_execution` event as a `VerifierTerminalResult` (`shared/types/sandbox.ts`), handled at the legacy
// chokepoint `prompt-queue.ts` (`verificationResultFromAgentVerdict → syncVerificationResultForPr → ...`). That
// terminal carries the §17-A run-identity token the FSM stamped on the active run at spawn
// (`result.verificationRunId`) plus the head the verifier validated (`result.verifiedHeadSha`). This producer
// DUAL-EMITS that terminal onto the shadow spine, ECHOING the run-identity token as the event's `runId` — which
// is what makes the spine's run-scoped verdict freshness work (the VERIFYING verdict exits decide freshness by
// `event.runId == record.verification_run_id`, transition.ts): a verdict from a SUPERSEDED run (the H→H′→H ABA
// ghost) fails the match and is discarded as a late emission, never a stale-pass false accept (gate class B4). A
// terminal that did NOT echo a token mints NO spine verdict (fails toward NOT-fresh, never a token-less accept).
//
// FAULT ISOLATION: the producer DUAL-EMITS into `applyEvent` wrapped best-effort/try-caught OFF the
// legacy critical path (the verdict-back DAO write + comment publish), so a producer fault never perturbs
// the live review loop.
//
// EMISSION SITE (soundness over completeness, the shadow rule): the SINGLE sound run-scoped emission site is the
// `prompt-queue.ts` verdict-back path, because that is the only seam holding the `VerifierTerminalResult` with
// the echoed run-identity token + the validated head. The downstream `POST /session/verification/result` route
// (durable-object.ts) is the LOSSY convergence layer — it receives only the already-mapped `merge-ready`/
// `needs-work` result with no run id, no validated head, and no granular run_limit/stopped/skipped/failed kind —
// and it is REACHED FROM the prompt-queue path, so emitting there too would either double-emit or mint a
// token-less false accept. Hence the producer is wired at the one run-identity-bearing seam (matching the
// PR 36-41 producer dual-emit contract: emit at the legacy chokepoint that holds the richest signal).
//
// SCOPE: the two VERDICT-bearing agent outcomes (`CONCLUSIVE → pass`, `INCONCLUSIVE → app_breaks`) plus the
// run-cap terminal (`INCONCLUSIVE` that exhausted the per-PR cap → `run_limit → NEEDS_YOU`) are derivable at the
// verdict-back seam and wired here. The `skipped` (planner skip) / `stopped` / `failed` (infra/contract) kinds do
// not arrive as a converged agent verdict on this seam; the pure classifier supports all six so their dedicated
// seams are a one-line `shadowEmitVerificationOutcome` call when wired — they are intentionally not minted here.
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.

import type { VerifierTerminalResult } from "../../../../../shared/types/sandbox.js";
import type { Env } from "../../types";
import { getPrCoordination } from "../pr-coordination-db";
import { applyEvent, type ApplyEventDeps } from "./apply-event";
import { type CiBucket, classifyCi } from "./guards";
import { readSettleableHeadCiForRecord } from "./honest-ci-read";
import { buildLiveGuardResolver } from "./live-resolver";
import { liveFsmSinks } from "./live-side-effects";
import type { EventActor, EventMetadata, FsmEvent, Verdict } from "./types";

/** The six terminal verification outcomes the spine recognizes (the `verification.*` event family). */
export type VerificationOutcome = "pass" | "app_breaks" | "skipped" | "stopped" | "failed" | "run_limit";

/** The raw, verdict-back-seam inputs the pure classifier reads. */
export interface VerificationOutcomeInput {
  /** Which terminal fired (derived at the seam from the agent verdict + the run-cap signal). */
  outcome: VerificationOutcome;
  /**
   * The echoed run-identity token (`VerifierTerminalResult.verificationRunId`) — the spine run-scopes verdict
   * freshness by `event.runId == record.verification_run_id`. MANDATORY: `undefined` ⇒ the producer mints NO
   * spine verdict (fails toward NOT-fresh — a missing token must never become a token-less false accept, B4).
   */
  runId: number | undefined;
  /**
   * The head the verifier validated (`VerifierTerminalResult.verifiedHeadSha`), stamped as `verdict_head_sha`
   * on a fresh accept. Required for the verdict-bearing exits (`pass`/`app_breaks`/`skipped`); `null` is fine on
   * the non-head terminals (`stopped`/`failed`/`run_limit` carry only `runId` on the spine event).
   */
  headSha: string | null;
}

/** One spine emission: the `FsmEvent` to apply, its §18.6 observability `EventMetadata`, and the actor tag. */
export interface VerificationEmission {
  event: FsmEvent;
  metadata: EventMetadata;
  actor: EventActor;
}

/** Every verification-produced spine event is attributed to the `verification` actor (the verifier child). */
const VERIFICATION_ACTOR: EventActor = "verification";

/** outcome → the `verdict` token on the §18.6 metadata slice (`none` for the non-verdict-bearing terminals). */
function verdictFor(outcome: VerificationOutcome): Verdict {
  switch (outcome) {
    case "pass":
      return "pass";
    case "app_breaks":
      return "app_breaks";
    case "skipped":
      return "skipped";
    case "stopped":
    case "failed":
    case "run_limit":
      return "none";
  }
}

/**
 * The pure classifier: a terminal verification outcome → its run-scoped spine `verification.*` event (echoing
 * the run-identity token) + the §18.6 metadata slice (`{verification_run_id, verdict, head_sha}`) + the actor.
 * Total over `VerificationOutcome`. Returns `null` (mints NO spine verdict) when:
 *   - the run-identity token is absent (`runId === undefined`) — fails toward NOT-fresh, never a token-less
 *     accept (B4); or
 *   - a VERDICT-bearing outcome (`pass`/`app_breaks`/`skipped`) carries no validated head — those exits stamp
 *     `verdict_head_sha`, so a headless verdict is malformed and is dropped rather than stamped empty.
 */
export function classifyVerificationOutcome(input: VerificationOutcomeInput): VerificationEmission | null {
  const runId = input.runId;
  if (runId === undefined) return null;
  const headSha = input.headSha;
  const verdict = verdictFor(input.outcome);

  switch (input.outcome) {
    case "pass":
      if (headSha === null || headSha.length === 0) return null;
      return {
        event: { type: "verification.pass", headSha, runId },
        metadata: { type: "verification.pass", verificationRunId: runId, verdict, headSha },
        actor: VERIFICATION_ACTOR,
      };
    case "app_breaks":
      if (headSha === null || headSha.length === 0) return null;
      return {
        event: { type: "verification.app_breaks", headSha, runId },
        metadata: { type: "verification.app_breaks", verificationRunId: runId, verdict, headSha },
        actor: VERIFICATION_ACTOR,
      };
    case "skipped":
      if (headSha === null || headSha.length === 0) return null;
      return {
        event: { type: "verification.skipped", headSha, runId },
        metadata: { type: "verification.skipped", verificationRunId: runId, verdict, headSha },
        actor: VERIFICATION_ACTOR,
      };
    case "stopped":
      return {
        event: { type: "verification.stopped", runId },
        metadata: { type: "verification.stopped", verificationRunId: runId, verdict, headSha },
        actor: VERIFICATION_ACTOR,
      };
    case "failed":
      return {
        event: { type: "verification.failed", runId },
        metadata: { type: "verification.failed", verificationRunId: runId, verdict, headSha },
        actor: VERIFICATION_ACTOR,
      };
    case "run_limit":
      return {
        event: { type: "verification.run_limit", runId },
        metadata: { type: "verification.run_limit", verificationRunId: runId, verdict, headSha },
        actor: VERIFICATION_ACTOR,
      };
  }
}

/**
 * Map a verifier terminal result + the run-cap signal to its `VerificationOutcome`. `CONCLUSIVE` is the verified
 * verdict (`pass`); an `INCONCLUSIVE` (needs-work) verdict that EXHAUSTED the per-PR run cap routes to the
 * `run_limit` terminal (→ `NEEDS_YOU{verification_run_limit}`), while one with budget remaining re-opens the
 * review loop (`app_breaks` → inject findings). The `exhausted` flag is the seam's authoritative run-cap read
 * (`result === "needs-work" && !limit.allowed`); on a failed limiter read it falls back to `false`, biasing
 * toward the re-openable `app_breaks` (the safe direction — never a spurious terminal in shadow).
 */
export function verificationOutcomeFromVerifierResult(
  result: VerifierTerminalResult,
  opts: { exhausted: boolean },
): VerificationOutcome {
  if (result.verdict === "CONCLUSIVE") return "pass";
  return opts.exhausted ? "run_limit" : "app_breaks";
}

/**
 * The fresh-accept verdict events — the only outcomes whose VERIFYING → REVIEW exit is the §6.5
 * `verification_verdict_return` recompute trigger (`caught-up.ts`). `stopped`/`failed`/`run_limit` route to
 * NEEDS_YOU (never REVIEW), so their transition is not a recompute trigger and the cascade never reads
 * `ciBucket` — an honest CI read there would be wasted work.
 */
const VERDICT_RETURN_EVENT_TYPES: ReadonlySet<FsmEvent["type"]> = new Set([
  "verification.pass",
  "verification.skipped",
  "verification.app_breaks",
]);

/**
 * HONEST, bounded, best-effort CI observation for the verdict-return seam (LIVE only). Reads the record's
 * live head via the shared {@link readSettleableHeadCiForRecord} helper (token resolution + one-head
 * `reduceCiState` poll; an UNCORROBORATED `absent` degrades to `pending` — the W11-T1 absent trap, see
 * poll) and classifies to a `CiBucket`. Returns `undefined` on any missing input / read fault; a genuine
 * read maps `green`/`absent` → `ci_green`, `failing` → `ci_red`, and `pending` → `ci_pending`. Both
 * `undefined` and `ci_pending` land the resolver on `ci_pending` (cascade row-5 WAIT — `buildLiveGuardResolver`
 * does `ctx.ciBucket ?? "ci_pending"`), so a non-green/faulted read keeps waiting and the sweep/webhook
 * green `ci.signal` carry still mints MERGE_READY later, exactly as today. NEVER fabricates green: only a
 * genuine `reduceCiState` of `green`/`absent` yields `ci_green`.
 */
async function readVerdictReturnCiBucket(env: Env, sessionId: string): Promise<CiBucket | undefined> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return undefined;
  let rec: Awaited<ReturnType<typeof getPrCoordination>>;
  try {
    rec = await getPrCoordination(db, sessionId);
  } catch {
    return undefined;
  }
  const ci = await readSettleableHeadCiForRecord(env, sessionId, rec?.prUrl ?? null, rec?.headSha ?? null);
  return ci === undefined ? undefined : classifyCi(ci);
}

/**
 * DUAL-EMIT a classified verification terminal onto the shadow spine. SHADOW/observe-only — the whole body is
 * try-caught OFF the legacy critical path (the verdict-back DAO write), so a producer fault is isolated here and
 * never perturbs the live review loop (the producer dual-emit contract, mirroring PR 36-41). No-op when
 * D1 is unbound (local/test) or when the outcome mints no spine verdict (missing run
 * token / headless verdict — see `classifyVerificationOutcome`).
 */
export async function shadowEmitVerificationOutcome(
  env: Env,
  sessionId: string,
  input: VerificationOutcomeInput,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  const db = env.DB;
  if (!db || typeof (db as Partial<D1Database>).prepare !== "function") return;
  const emission = classifyVerificationOutcome(input);
  if (!emission) return;
  // PR 47 emitter rewire: the shared live resolver — the fresh-accept VERIFYING → REVIEW return is the
  // §6.5 recompute trigger, so the REAL disposition snapshot decides whether the cascade
  // fires on arrival. ARC-1330 latency fix: the verdict-return seam sources an HONEST CI observation for
  // that recompute (a bounded one-head `reduceCiState` read), so a genuinely green PR settles MERGE_READY
  // in this SAME applyEvent instead of waiting for the next green `ci.signal` (webhook / cron sweep).
  // Best-effort: on any fault / pending CI it stays `undefined` → the resolver's conservative `ci_pending`
  // (row-5 WAIT), and the green `ci.signal` carry still settles it later. NEVER fabricates green.
  let ciBucket: CiBucket | undefined;
  if (VERDICT_RETURN_EVENT_TYPES.has(emission.event.type)) {
    ciBucket = await readVerdictReturnCiBucket(env, sessionId);
  }
  // A4: an `app_breaks` verdict no longer injects findings onto the spine (the VERIFYING→REVIEW exit is
  // record-only). QA re-intake rides the managed QA comment admitted as `known:cycloid-qa`.
  const resolver = buildLiveGuardResolver(env, sessionId, { ciBucket });
  const deps: ApplyEventDeps = {
    db,
    env,
    now: Date.now,
    resolver,
    // PR 47: effect execution defers through the verdict-back host's waitUntil.
    ...liveFsmSinks(env, { waitUntil }),
  };
  try {
    await applyEvent(deps, {
      sessionId,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });
  } catch (err) {
    log?.warn({ sessionId, outcome: input.outcome, error: String(err) }, "fsm verification producer failed (ignored)");
  }
}

/**
 * The single mapping point the `prompt-queue.ts` verdict-back path calls: derive the `VerificationOutcome` from
 * a `VerifierTerminalResult` + the run-cap signal, then DUAL-EMIT it. `sessionId` MUST be the implementation
 * (parent) session that owns the spine row — the verifier CHILD has none (the prompt-queue caller resolves
 * `childRow.parent_session_id`).
 *
 * RUN-ID SOURCING (§17-A, PR 47):
 *   • LIVE — the ECHOED token ONLY. The end-to-end echo is wired (scheduler → per-prompt DO storage →
 *     verdict-back populates `VerifierTerminalResult.verificationRunId`), so a verdict WITHOUT an echoed
 *     run id is REJECTED (mints nothing — fails toward NOT-fresh, B4; the VERIFYING deadline backstop owns
 *     unwedging a session whose every verdict lacked the echo). Self-sourcing at live would defeat the
 *     ghost-discard: a SUPERSEDED run's late verdict would read the row's CURRENT (newer) run id and
 *     false-accept as fresh — the exact H→H′→H ABA hole §17-A closes.
 *   • SHADOW — self-source FALLBACK only: read the parent spine row's current `verification_run_id` (the
 *     value the A1 enter stamped) so freshness holds by construction and the shadow soak records verdicts.
 *     The stale-run edge is deliberately un-modeled in shadow (no ordering coupling to the live
 *     re-dispatch); a genuinely echoed id takes precedence (the `??` short-circuits).
 * Best-effort/try-caught inside `shadowEmitVerificationOutcome` OFF the legacy verdict-back write.
 */
export async function shadowEmitVerifierTerminalVerdict(
  env: Env,
  sessionId: string,
  result: VerifierTerminalResult,
  opts: { exhausted: boolean; waitUntil?: (promise: Promise<unknown>) => void },
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<void> {
  // The ECHOED run id ONLY: a verdict WITHOUT an echoed run id mints nothing (fails toward NOT-fresh,
  // B4; the VERIFYING deadline backstop owns unwedging). Never self-sourced (see the doc above).
  const runId = result.verificationRunId;
  await shadowEmitVerificationOutcome(
    env,
    sessionId,
    {
      outcome: verificationOutcomeFromVerifierResult(result, opts),
      runId,
      headSha: result.verifiedHeadSha,
    },
    log,
    opts.waitUntil,
  );
}

/**
 * Emit a NON-verdict-back verification terminal — the planner `skipped` and abnormal `stopped` seams
 * (prompt-queue.ts) that sync LEGACY verification state but carry no `VerifierTerminalResult` to route
 * through `shadowEmitVerifierTerminalVerdict`. Without this, a stranded parent's `pr_coordination` row
 * stays in VERIFYING FOREVER (A1 cannot re-enter from VERIFYING; the §10 deadline backstop is its only
 * other exit — the exact class the prod soak found stranded). `parentSessionId` MUST be the parent
 * (implementation) session that owns the spine row — the verifier CHILD has none.
 *
 * RUN-ID/HEAD SOURCING mirrors `shadowEmitVerifierTerminalVerdict`'s echo-vs-self-source split:
 *   • an ECHOED `runId` wins; else LIVE mints nothing (a missing echo fails toward NOT-fresh — the
 *     deadline backstop owns unwedging), and SHADOW self-sources the parent row's current
 *     `verification_run_id` so freshness holds and the soak records the exit.
 *   • a verdict-bearing `skipped` REQUIRES a head (it stamps `verdict_head_sha` → REVIEW). When the skip
 *     event carries none, shadow self-sources the parent row's head so the skip still exits VERIFYING →
 *     REVIEW (the correct terminal — the deadline backstop would instead route it to
 *     NEEDS_YOU(verification_stopped), the WRONG outcome for a skip). `stopped` is head-less by design.
 */
export async function shadowEmitVerificationTerminalOutcome(
  env: Env,
  parentSessionId: string,
  input: { outcome: VerificationOutcome; headSha: string | null; runId?: number },
  opts: { waitUntil?: (promise: Promise<unknown>) => void } = {},
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<void> {
  // The ECHOED run id/head ONLY — never self-sourced. A missing echo fails toward NOT-fresh (the
  // deadline backstop owns unwedging); a head-less skip carries no echoed run id, so
  // `classifyVerificationOutcome` refuses to mint a verdict at all (fail-toward-NOT-fresh, B4).
  await shadowEmitVerificationOutcome(
    env,
    parentSessionId,
    { outcome: input.outcome, runId: input.runId, headSha: input.headSha },
    log,
    opts.waitUntil,
  );
}
