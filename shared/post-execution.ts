import {
  type GateDecision,
  type GateResults,
  PUBLISH_GATE_NAMES,
  type PublishMode,
  type SerializedGateResult,
  type VerificationVerdict,
} from "./types/sandbox.js";

// Invisible marker the sandbox-bridge appends to its default-layout PR body to
// signal that it has already rendered the verification/claim sections. The
// control-plane uses it to skip re-injecting its own `## Verdict` block (which
// would duplicate the bridge's claim/evidence and resurrect the removed Verdict
// heading). Kept here as the single source of truth shared by both packages.
export const BRIDGE_VERIFICATION_RENDERED_MARKER = "<!-- cycloid:verification:rendered -->";

export type PrTemplate = {
  footer: string;
};

/**
 * Publish-mode precedence: `draft > normal`. Single source of truth for
 * the ordering, imported by the bridge's gate fold (publish-gates.ts) and the
 * control plane's authoritative re-derivation so the precedence cannot drift.
 */
export const PUBLISH_MODE_PRIORITY: Record<PublishMode, number> = {
  normal: 0,
  draft: 1,
};

/** Return whichever of two publish modes is the more conservative. */
export function maxPublishMode(a: PublishMode, b: PublishMode): PublishMode {
  return PUBLISH_MODE_PRIORITY[a] >= PUBLISH_MODE_PRIORITY[b] ? a : b;
}

/**
 * Fold the per-gate decisions to the publish mode they justify. The MODE is fully
 * determined by the decisions alone: any `draft` raises to at least draft,
 * `pass`/`skipped` contribute nothing.
 */
export function foldGateResults(gateResults: GateResults): PublishMode {
  let mode: PublishMode = "normal";
  for (const name of PUBLISH_GATE_NAMES) {
    const decision = gateResults[name]?.decision;
    if (decision === "draft") mode = maxPublishMode(mode, "draft");
  }
  return mode;
}

const GATE_DECISIONS: ReadonlySet<string> = new Set<GateDecision>(["pass", "draft", "skipped"]);

/**
 * Runtime-validate untrusted `gateResults` off the wire (sandbox events are typed
 * JSON with no schema validation on ingress). Returns a complete, type-safe
 * {@link GateResults} only when EVERY closed gate name is present with a valid
 * decision; otherwise returns `undefined` so the caller fails closed to `draft`.
 * An absent, incomplete, or malformed signal is indistinguishable here on purpose
 * — all three are untrustworthy and must not be re-derived as `normal`.
 */
export function normalizeGateResults(value: unknown): GateResults | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const result = {} as GateResults;
  for (const name of PUBLISH_GATE_NAMES) {
    const entry = obj[name];
    if (!entry || typeof entry !== "object") return undefined;
    const decision = (entry as { decision?: unknown }).decision;
    if (typeof decision !== "string" || !GATE_DECISIONS.has(decision)) return undefined;
    const reason = (entry as { reason?: unknown }).reason;
    result[name] = {
      decision: decision as GateDecision,
      ...(typeof reason === "string" && reason.length > 0 ? { reason: reason.slice(0, 2_000) } : {}),
    };
  }
  return result;
}

export type AuthoritativePublishReason = "missing_signal" | "agreement" | "sandbox_stricter" | "clamped_to_floor";

export type AuthoritativePublishDecisionInput = {
  /** Per-gate decisions the sandbox ran, complete over the closed gate set. */
  gateResults: GateResults | undefined;
  /** Final verification verdict, if the sandbox produced one. */
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  functionalVerdict?: VerificationVerdict;
  /** The sandbox's self-reported final mode (advisory). Absent ⇒ treat as normal. */
  sandboxMode?: PublishMode;
};

export type AuthoritativePublishDecision = {
  /** The control-plane's authoritative publish mode. */
  publishMode: PublishMode;
  /** The sandbox's advisory mode the decision was compared against. */
  sandboxMode: PublishMode;
  /** True when the authoritative mode diverged from the sandbox's report. */
  mismatch: boolean;
  reason: AuthoritativePublishReason;
  /**
   * The raw gate fold before the functional-verdict raise. `null` on the
   * `missing_signal` path, where no usable gate signal exists to fold — do not
   * read it as a gate result there. Lets the `publish_decision.mismatch` log
   * facet on the gate fold and the functional cause separately, instead of
   * pre-baking that distinction into a separate clamp `reason`.
   */
  gateFloor: PublishMode | null;
  /** Whether functional verification (REFUTED/INCONCLUSIVE) raised the floor to draft. */
  functionalForcedDraft: boolean;
};

/**
 * Re-derive the authoritative publish mode from the sandbox-provided inputs. The
 * trust model: we trust the sandbox's gate INPUTS, not its final FOLD. The rule:
 *
 * - No usable gate signal ⇒ fail closed to `draft` (never `normal`).
 * - Otherwise compute a server-provable floor: the gate fold, raised to at least
 *   `draft` when functional verification was REFUTED/INCONCLUSIVE.
 * - The sandbox may always be MORE conservative than the floor (failure path,
 *   extra caveats) — pass that through.
 * - The sandbox may never go BELOW the floor: clamp UP to the floor and flag the
 *   divergence.
 */
export function deriveAuthoritativePublishMode(input: AuthoritativePublishDecisionInput): AuthoritativePublishDecision {
  const sandboxMode: PublishMode = input.sandboxMode ?? "normal";
  // Derived from the verdict alone, so it is valid in both branches (including
  // missing_signal, where it is descriptive but does not drive the mode).
  const functionalForcedDraft = input.functionalVerdict === "REFUTED" || input.functionalVerdict === "INCONCLUSIVE";
  let publishMode: PublishMode;
  let reason: AuthoritativePublishReason;
  // null until a usable gate signal is folded; stays null on missing_signal so
  // the log never implies gates ran when they did not.
  let gateFloor: PublishMode | null = null;

  if (!input.gateResults) {
    // No usable gate signal: fail closed to draft.
    publishMode = "draft";
    reason = "missing_signal";
  } else {
    gateFloor = foldGateResults(input.gateResults);
    let floor = gateFloor;
    if (functionalForcedDraft) {
      floor = maxPublishMode(floor, "draft");
    }
    if (PUBLISH_MODE_PRIORITY[sandboxMode] >= PUBLISH_MODE_PRIORITY[floor]) {
      publishMode = sandboxMode;
      reason = sandboxMode === floor ? "agreement" : "sandbox_stricter";
    } else {
      publishMode = floor;
      // The cause (gate fold vs functional raise) is not pre-baked into the
      // reason; `gateFloor` + `functionalForcedDraft` carry it to the log.
      reason = "clamped_to_floor";
    }
  }

  return { publishMode, sandboxMode, mismatch: publishMode !== sandboxMode, reason, gateFloor, functionalForcedDraft };
}

/**
 * Translate the bridge's free-form per-gate decision string (the legacy
 * `gateDecisions` map values: `passed` / `draft` / `resource_killed`)
 * into the closed wire {@link GateDecision}. A resource-killed gate is
 * inconclusive, so it maps to `draft` (manual review). Anything unrecognized or
 * absent is `skipped`.
 */
export function mapGateDecision(legacy: string | undefined): GateDecision {
  switch (legacy) {
    case "passed":
      return "pass";
    case "draft":
      return "draft";
    case "resource_killed":
      return "draft";
    case "skipped":
      return "skipped";
    default:
      return "skipped";
  }
}

/**
 * Build a COMPLETE {@link GateResults} (one entry per closed gate name) from the
 * bridge's legacy `gateDecisions` map. Gates the bridge never reached stay
 * `{ decision: "skipped" }` so the control plane can distinguish "ran and passed"
 * from "did not run" without ambiguity. Optional per-gate `reason` strings are
 * descriptive context only.
 */
export function buildGateResults(
  gateDecisions: Record<string, string>,
  reasons: Partial<Record<(typeof PUBLISH_GATE_NAMES)[number], string>> = {},
): GateResults {
  const result = {} as GateResults;
  for (const name of PUBLISH_GATE_NAMES) {
    const entry: SerializedGateResult = { decision: mapGateDecision(gateDecisions[name]) };
    const reason = reasons[name];
    if (reason) entry.reason = reason;
    result[name] = entry;
  }
  return result;
}

export const PR_FULL_DIFF_TRUNCATION = 160_000;
export const TRUNCATED_DIFF_OMISSION_MARKER_PREFIX = "[... omitted ";

export const DEFAULT_PR_TEMPLATE: PrTemplate = {
  footer: "🤖 Generated with [Cycloid](https://trycycloid.com)",
};

function buildOmissionMarker(omittedChars: number): string {
  return `\n${TRUNCATED_DIFF_OMISSION_MARKER_PREFIX}${omittedChars} chars ...]\n`;
}

export function buildTruncatedDiffExcerpt(text: string | undefined, max: number): string {
  if (!text || max <= 0) return "";
  if (text.length <= max) return text;

  const available = Math.max(0, max - buildOmissionMarker(text.length - max).length);
  const headLength = Math.ceil(available * 0.6);
  const tailLength = available - headLength;
  const marker = buildOmissionMarker(text.length - headLength - tailLength);

  return `${text.slice(0, headLength)}${marker}${tailLength > 0 ? text.slice(-tailLength) : ""}`.slice(0, max);
}
