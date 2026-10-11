import type { E2BListedSandbox, E2BSandboxInfoResult } from "./e2b-client";

/**
 * Observational disconnect cross-check (diagnosis only — see
 * docs/plans `sandbox-loss-diagnosis.md`).
 *
 * At terminalize time the chokepoint has already decided to kill an in-flight
 * prompt because the liveness probe read `dead` (a `missing_sandbox`). This
 * helper asks E2B's own running-sandbox list whether the VM is in fact still
 * listed running. It exists to split:
 *   - H2 (false-negative probe): the id is still listed running while our probe
 *     said dead -> we are killing a live VM on a bad read; and
 *   - "genuinely gone" (H3/H1): absent from the list.
 *
 * Cycloid runs a single runtime backend (e2b_cloud); the cross-check lists that
 * one backend. The legacy multi-backend framing was retired with self-hosted
 * E2B, but the `absent_from_all_backends` signal name is kept for telemetry
 * continuity (a documented Datadog query joins against it — see docs/debugging.md).
 *
 * It is strictly observational: it never throws, never blocks, and its result is
 * never fed back into the terminate/defer decision. The list call is bounded by a
 * timeout and its failure is captured rather than propagated.
 */

export type CrossCheckStatus = "ok" | "error" | "timeout";

export type CrossCheckResult = {
  runtimeSandboxId: string;
  status: CrossCheckStatus;
  /** Whether the target id was present in the running/paused list. */
  listed: boolean;
  /** The listed entry's state when found (log hygiene: only the target id's state). */
  listedState?: E2BListedSandbox["status"];
  durationMs: number;
  /** Sanitized failure code; never a raw provider response. */
  errorCode?: string;
};

type CrossCheckOptions = {
  runtimeSandboxId: string;
  /** Lists Cycloid sandboxes on the e2b_cloud backend (running/paused only). */
  list: () => Promise<E2BListedSandbox[]>;
  timeoutMs: number;
  /** Injectable clock for deterministic durations in tests. Defaults to Date.now. */
  now?: () => number;
};

class CrossCheckTimeoutError extends Error {
  constructor() {
    super("cross-check list timed out");
    this.name = "CrossCheckTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CrossCheckTimeoutError()), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Bounded, PII-safe error identifier for diagnostic log/Datadog payloads: the
 * timeout sentinel, the Error's `name`, or `"error"`. Never the raw message
 * (which can carry provider/network detail). Shared by the cross-check result
 * and the disconnect diagnostic events in the session DO.
 */
export function sanitizeErrorCode(error: unknown): string {
  if (error instanceof CrossCheckTimeoutError) return "timeout";
  if (error instanceof Error && error.name) return error.name;
  return "error";
}

/**
 * Diagnosis signal derived from a cross-check result + the liveness probe that
 * drove the terminate. The signal must not over-claim:
 *   - `probe_false_negative_suspected` (H2): the probe affirmatively read `dead`
 *     yet E2B still lists the VM. This is the only true false-negative case.
 *   - `listed_without_dead_probe`: the VM is listed but the probe did NOT read
 *     dead (hold-exhausted/kill-switch-off -> liveness null; probe error ->
 *     unknown). These terminates are expected, not H2; flagging them as false
 *     negatives would pollute the H2 signal.
 *   - `inconclusive`: not listed, but the cross-check errored or timed out, so
 *     absence is not proven (a timeout != a genuine loss).
 *   - `absent_from_all_backends`: the cross-check answered and the VM was not
 *     listed (genuine loss -> H3 self-inflicted / H1 E2B drop, attributed via
 *     `runtime.terminate` logs). Name kept for telemetry continuity (see above).
 */
export type CrossCheckSignal =
  "probe_false_negative_suspected" | "listed_without_dead_probe" | "inconclusive" | "absent_from_all_backends";

export function classifyCrossCheckSignal(input: {
  listed: boolean;
  status: CrossCheckStatus;
  liveness: "alive" | "dead" | "unknown" | null;
}): CrossCheckSignal {
  if (input.listed) {
    return input.liveness === "dead" ? "probe_false_negative_suspected" : "listed_without_dead_probe";
  }
  if (input.status !== "ok") return "inconclusive";
  return "absent_from_all_backends";
}

export async function crossCheckRuntimeLiveness(options: CrossCheckOptions): Promise<CrossCheckResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    const sandboxes = await withTimeout(options.list(), options.timeoutMs);
    const entry = sandboxes.find((s) => s.runtimeSandboxId === options.runtimeSandboxId);
    return {
      runtimeSandboxId: options.runtimeSandboxId,
      status: "ok",
      listed: entry !== undefined,
      ...(entry ? { listedState: entry.status } : {}),
      durationMs: now() - startedAt,
    };
  } catch (error) {
    const isTimeout = error instanceof CrossCheckTimeoutError;
    return {
      runtimeSandboxId: options.runtimeSandboxId,
      status: isTimeout ? "timeout" : "error",
      listed: false,
      durationMs: now() - startedAt,
      errorCode: sanitizeErrorCode(error),
    };
  }
}

type CrossCheckProbeOptions = {
  runtimeSandboxId: string;
  /**
   * Per-VM liveness read (`getSandboxInfo` = GET /v1/vms/{vm_id}) for the session's
   * OWN sandbox id. MUST be self-bounding and non-throwing per the
   * `SandboxProviderClient` contract — the Freestyle client bounds each attempt with
   * its `requestTimeoutMs`, retries transient failures, and returns
   * `{status:"unknown"}` (never throws) on exhaustion (ARC-1478/1479). No outer
   * timeout is layered here: re-wrapping the already-hardened read would re-introduce
   * the slow-but-alive clip ARC-1478 fixed.
   */
  probe: () => Promise<E2BSandboxInfoResult>;
  /** Injectable clock for deterministic durations in tests. Defaults to Date.now. */
  now?: () => number;
};

/**
 * Per-VM disconnect cross-check for providers whose account list cannot be used
 * (ARC-1484: Freestyle's list is account-wide and shared across envs, so it never
 * reliably contains a single env's VM). It reads the session's OWN VM and maps the
 * result onto the same {@link CrossCheckResult} shape the list path produces, so
 * {@link classifyCrossCheckSignal} is unchanged:
 *   - `running`/`paused` -> `listed` (VM present; feeds H2 when the probe read `dead`);
 *   - `missing` (decisive death: `deleted` flag / VM_DELETED) -> not listed, `ok`
 *     (genuine loss -> `absent_from_all_backends`);
 *   - `unknown` (transient, retries exhausted) -> not listed, `error` so absence is
 *     NOT claimed (`inconclusive`), never a false `absent_from_all_backends`.
 * Strictly observational: it never throws (the catch is a defensive net for a
 * contract violation only), never blocks, and never feeds the terminate decision.
 */
export async function crossCheckRuntimeViaProbe(options: CrossCheckProbeOptions): Promise<CrossCheckResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    const info = await options.probe();
    if (info.status === "unknown") {
      // A bounded-retry read that still could not classify the VM. Absence is NOT
      // proven -> surface as `error` (like a list timeout/failure) so the summary
      // reports `inconclusive`, not a false genuine-loss.
      return {
        runtimeSandboxId: options.runtimeSandboxId,
        status: "error",
        listed: false,
        durationMs: now() - startedAt,
        errorCode: info.errorCode,
      };
    }
    if (info.status === "missing") {
      return {
        runtimeSandboxId: options.runtimeSandboxId,
        status: "ok",
        listed: false,
        durationMs: now() - startedAt,
      };
    }
    // `running` | `paused`: the VM is present (feeds H2 when the probe read `dead`).
    return {
      runtimeSandboxId: options.runtimeSandboxId,
      status: "ok",
      listed: true,
      listedState: info.status,
      durationMs: now() - startedAt,
    };
  } catch (error) {
    return {
      runtimeSandboxId: options.runtimeSandboxId,
      status: "error",
      listed: false,
      durationMs: now() - startedAt,
      errorCode: sanitizeErrorCode(error),
    };
  }
}
