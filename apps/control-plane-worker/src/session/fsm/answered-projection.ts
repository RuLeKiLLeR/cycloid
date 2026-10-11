// ARC-1330 (PR 27): the `ANSWERED_NO_PR` projection split (design §12 projection table).
//
// `ANSWERED_NO_PR` is the single `¬has_diff` terminal-success state, reached from either
// `FINALIZING[¬has_changes]` or `PUBLISHING[publish.no_changes]` (a net-zero diff). The two cases
// look identical by state alone, so the user-facing copy is a projection of the persisted
// `prompt_intends_change` record field (set on BOTH `postexec.done` branches, SF11):
//
//   • `prompt_intends_change` (the prompt asked for a code change but the turn produced no diff)
//       → "No change produced"
//   • `¬prompt_intends_change` (a Q&A / investigation turn — no change was ever intended)
//       → "Answered"
//
// Projection-only: this NEVER gates any transition (publish is gated on `has_diff` alone, D3). It is
// a pure read of the record, total over `boolean | null` (a null/unset field reads as "no intent" →
// "Answered"). PR 30 folds this split into the full `project(record)` / `stageOf(record)` surface.

/** The user-facing `ANSWERED_NO_PR` stage-section copy (design §12). */
export type AnsweredNoPrStageSection = "Answered" | "No change produced";

/**
 * Project the `ANSWERED_NO_PR` stage-section copy from the persisted `prompt_intends_change` field.
 *
 * Total over `boolean | null`: only a strict `true` (the prompt intended a change yet none landed)
 * yields "No change produced"; `false`/`null`/unset all read as a plain "Answered" (Q&A turn).
 */
export function projectAnsweredNoPr(record: { promptIntendsChange: boolean | null }): AnsweredNoPrStageSection {
  return record.promptIntendsChange === true ? "No change produced" : "Answered";
}
