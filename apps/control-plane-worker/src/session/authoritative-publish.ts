import {
  type AuthoritativePublishDecision,
  deriveAuthoritativePublishMode,
  normalizeGateResults,
} from "../../../../shared/post-execution.js";
import type { ExecutionVerification, PublishMode, VerificationVerdict } from "../../../../shared/types/sandbox.js";
import type { SandboxEvent } from "../ws/types.js";

type PostExecutionEvent = Extract<SandboxEvent, { type: "post_execution" }>;

const VERIFICATION_VERDICTS: ReadonlySet<string> = new Set<VerificationVerdict>([
  "CONFIRMED",
  "REFUTED",
  "INCONCLUSIVE",
]);

function coerceFunctionalVerdict(value: unknown): VerificationVerdict | undefined {
  return typeof value === "string" && VERIFICATION_VERDICTS.has(value) ? (value as VerificationVerdict) : undefined;
}

function synthesizeVerification(publishMode: PublishMode): ExecutionVerification {
  return {
    verified: false,
    explanation:
      "Marked for manual review by the control plane: the sandbox-reported gate results were absent or did not justify a normal PR.",
    publishMode,
    verdict: "INCONCLUSIVE",
  };
}

/**
 * Make the publish-mode decision server-authoritative. Re-derives the mode from
 * the sandbox-provided gate inputs (trusting the inputs, not the sandbox's final
 * fold) and rewrites the event IN PLACE so every downstream consumer — durable
 * history (the event object is the durable entry's data), the stored verification,
 * the `verification_updated` broadcast, and automatic PR creation/update — reads
 * the same authoritative value.
 *
 * Untrusted input is validated first (`normalizeGateResults`); an absent,
 * incomplete, or malformed signal fails closed to `draft`. When the sandbox
 * omitted a verification payload but the derived mode is non-normal (the
 * buggy/compromised case this hardening targets), a minimal verification is
 * synthesized so the draft actually takes effect.
 *
 * Returns the decision (including the mismatch flag and reason) for telemetry.
 * Mutating the event is deterministic and idempotent: re-deriving the already
 * rewritten event yields the same mode (agreement, no mismatch).
 */
export function applyServerAuthoritativePublishMode(event: PostExecutionEvent): AuthoritativePublishDecision {
  let decision = deriveAuthoritativePublishMode({
    gateResults: normalizeGateResults(event.gateResults),
    functionalVerdict: coerceFunctionalVerdict(event.verification?.verdict),
    // The sandbox's advisory final mode: prefer the always-present top-level
    // field, fall back to the verification payload for deploy-skewed bridges.
    sandboxMode: event.publishMode ?? event.verification?.publishMode,
  });
  event.publishMode = decision.publishMode;
  if (event.verification) {
    event.verification.publishMode = decision.publishMode;
    // Clear any sandbox-reported verdict when clamping to a non-normal mode.
    // resolveVerificationVerdict (pr-body.ts) returns verification.verdict FIRST,
    // so a retained "CONFIRMED" would render "ready for review" on a draft
    // PR and nullify the control-plane override in the user-visible description.
    if (decision.publishMode !== "normal") {
      delete event.verification.verdict;
    }
  } else if (decision.publishMode !== "normal") {
    event.verification = synthesizeVerification(decision.publishMode);
  }

  return decision;
}
