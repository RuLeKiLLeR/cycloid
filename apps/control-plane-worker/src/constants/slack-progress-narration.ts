/**
 * LLM progress-narration constants (slack/progress-narration.ts).
 *
 * The deterministic mapper (slack/narration.ts) stays the instant, $0,
 * always-on fallback line. This richer line is a periodic overlay synthesized
 * by a cheap/fast model from a rolling buffer of recent session activity, and
 * shares the exact same render + throttle path on the status card.
 *
 * All spacing/size/timeout values live here (never inline) per repo convention.
 */
import { GPT54_MINI_SIDECAR_REASONING_EFFORT, OpenAIModel } from "../../../../shared/constants/models.js";

/**
 * Minimum spacing between LLM narration calls for one session (fail-open,
 * cost-bounded). Tuned for a live-feeling card: frequent enough that the line
 * visibly moves, spaced enough to stay cheap and avoid twitchy repaints.
 */
export const PROGRESS_NARRATION_INTERVAL_MS = 12_000;

/** Rolling buffer ring size: only the most recent N narration-relevant items are kept. */
export const PROGRESS_NARRATION_BUFFER_SIZE = 25;

/** Per-item text cap (reasoning/text snippets are truncated to this before buffering). */
export const PROGRESS_NARRATION_ITEM_MAX_CHARS = 200;

/**
 * Total character budget across all buffered items. Enforced after the ring
 * bound by dropping oldest items so the prompt stays small and cheap.
 */
export const PROGRESS_NARRATION_BUFFER_MAX_CHARS = 4_000;

/** Hard cap on the synthesized progress line rendered on the card. */
export const PROGRESS_NARRATION_MAX_LINE_LENGTH = 90;

/** Hard timeout for the LLM call (Promise.race ceiling + per-attempt signal). */
export const PROGRESS_NARRATION_TIMEOUT_MS = 4_000;

/** Output token ceiling — the schema returns one short line + a boolean. */
export const PROGRESS_NARRATION_MAX_TOKENS = 256;

/**
 * Cheapest suitable model: nano is enough for this one-line cosmetic overlay,
 * with the deterministic mapper as a fail-open fallback. Pulled from the shared
 * MODEL_REGISTRY source — never a hardcoded id.
 */
export const PROGRESS_NARRATION_MODEL = OpenAIModel.GPT54Nano;
export const PROGRESS_NARRATION_REASONING_EFFORT = GPT54_MINI_SIDECAR_REASONING_EFFORT;
