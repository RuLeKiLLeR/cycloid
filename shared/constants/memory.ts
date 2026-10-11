/**
 * Default-off fallback for UI-only memory surfaces. Runtime model-facing memory
 * availability is decided by the control plane and passed to sandboxes through
 * ARCANIST_MEMORY_TOOLS_ENABLED.
 */
export const MEMORY_FEATURE_DISABLED = true;

/**
 * Hide memory transcript cards while still allowing model-facing memory
 * injection, recall events, telemetry, and eval data to flow.
 */
export const MEMORY_TRANSCRIPT_VISUALS_DISABLED = true;
