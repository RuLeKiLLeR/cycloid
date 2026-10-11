// Deterministic dedup marker for PR creation (ARC-1014).
//
// PR-create dedup layers a D1 `ext.prUrl` check, a GitHub re-query before
// `createPr`, and `durableStep` memoization. The re-query is the load-bearing
// layer when no D1 row exists yet (crash between `createPr` and the D1 write).
// Matching by head branch alone cannot prove the open PR on that branch is the
// one *this* publish attempt created versus an unrelated PR on the same branch.
//
// The marker closes that gap: it is embedded in the PR body on create and
// matched on the recovery query, turning "a PR exists on this branch" into
// "*our* PR exists". The identity is `(sessionId, promptKey)` — the same
// replay-stable anchor `durableStep` uses for its `create_pr_<sessionId>_<promptId>`
// step name — so a replay computes the exact same marker the prior attempt wrote.
// (The parent ticket names this `publishAttemptId`; `publishAttempt` is a
// monotonic counter that changes every replay, so it is deliberately not used —
// the marker must be deterministic across replays.)

const MARKER_PREFIX = "cycloid-dedup";
const NO_PROMPT_KEY = "no_prompt";

function promptKey(promptId: string | null | undefined): string {
  return promptId ?? NO_PROMPT_KEY;
}

/** The deterministic dedup marker token for a publish identity. */
export function buildPrDedupMarker(sessionId: string, promptId: string | null | undefined): string {
  return `<!-- ${MARKER_PREFIX}: ${sessionId}:${promptKey(promptId)} -->`;
}

/** Append the dedup marker to a PR body. Idempotent — never adds a second marker. */
export function appendPrDedupMarker(body: string, sessionId: string, promptId: string | null | undefined): string {
  const marker = buildPrDedupMarker(sessionId, promptId);
  if (body.includes(marker)) return body;
  return `${body.trimEnd()}\n\n${marker}\n`;
}
