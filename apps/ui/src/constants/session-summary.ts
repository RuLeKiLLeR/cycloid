// Summary tab statics: request/answer clamp thresholds and the composer focus
// target. Constants live here per docs/conventions.md; never inline them in
// components.

/** Character count beyond which the request/answer readouts collapse behind an expand toggle. */
export const SUMMARY_TEXT_CLAMP_CHAR_THRESHOLD = 320;

/** Newline count at which the request/answer readouts collapse behind an expand toggle. */
export const SUMMARY_TEXT_CLAMP_LINE_THRESHOLD = 6;

/**
 * The session composer's prompt textarea — the "Answer agent" focus target.
 * Matches the aria-label both PromptForm variants render (PromptFormViews.tsx).
 */
export const SESSION_COMPOSER_PROMPT_SELECTOR = 'textarea[aria-label="Prompt"]';
