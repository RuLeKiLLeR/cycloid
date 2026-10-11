export const EVAL_TRANSCRIPT_MAX_BYTES = 1_000_000; // 1MB

const EVAL_RATINGS = ["horrible", "bad", "ok", "good", "great"] as const;
export type EvalRating = (typeof EVAL_RATINGS)[number];
