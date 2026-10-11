import { redact } from "../../../../../shared/observability/redact.js";
import { hasEnospcSignature } from "../enospc-detect.js";
import type { GitOperationsConfig } from "./types.js";

// Best-effort disk-full OUTCOME signal: when a git operation fails with an ENOSPC
// signature (full sandbox disk), send `sandbox_enospc` so the control plane emits
// the arcanist.sandbox.disk.enospc counter — the disk equivalent of the OOM signal.
// Fail-open: a telemetry hiccup must never affect the push/commit path.
export function maybeEmitEnospcEvent(
  config: Pick<GitOperationsConfig, "sandboxId" | "sendEvent">,
  source: string,
  err: unknown,
): void {
  try {
    if (!hasEnospcSignature(err)) return;
    config.sendEvent({
      type: "sandbox_enospc",
      source,
      sandboxId: config.sandboxId,
      timestamp: Date.now(),
    });
  } catch {
    // never let telemetry break the git path
  }
}

export function emitPushErrorEvent(
  config: Pick<GitOperationsConfig, "sandboxId" | "sendEvent">,
  params: { messageId: string; branchName: string; error: string },
): void {
  // A full disk fails `git push` (can't write the pack) — surface it as the ENOSPC
  // outcome. Non-ENOSPC push errors (auth, diverged, …) are a no-op in the detector.
  maybeEmitEnospcEvent(config, "push", params.error);
  config.sendEvent({
    type: "push_error",
    messageId: params.messageId,
    branchName: params.branchName,
    error: redact(params.error),
    sandboxId: config.sandboxId,
    timestamp: Date.now(),
  });
}
