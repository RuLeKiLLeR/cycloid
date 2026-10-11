// The managed QTA comment's hidden HTML marker. Lives apart from verification-comment.ts so the
// review-loop worklist builder (github/pr.ts) can match the marker without importing the comment
// publisher (which itself imports pr.ts - a cycle otherwise).

const QA_MARKER_PREFIX = "<!-- cycloid-qa:v1";

// The managed marker is a single short HTML-comment line (`<!-- cycloid-qa:v1 owner=… repo=… pr=… head=<40>
// verdict=… -->`), well under this bound. It caps the verdict-scan window so a malformed/truncated marker
// (missing `-->`) can't extend the slice into the comment body.
const MAX_MARKER_SCAN_LENGTH = 512;

export type ManagedQaVerdict = "app_breaks" | "pass" | "none";

export function qaCommentMarker(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  verdict: ManagedQaVerdict,
): string {
  // `verdict=` trails `head=` so `qaCommentMarkerSearch` (…pr=N head=) stays a prefix of the full
  // marker and #6939's comment-lookup keeps matching unchanged.
  return `${QA_MARKER_PREFIX} owner=${owner} repo=${repo} pr=${prNumber} head=${headSha} verdict=${verdict} -->`;
}

/**
 * The canonical head-agnostic search prefix used to locate the managed QA comment for a PR -
 * matches any head's marker for that (owner, repo, prNumber).
 */
export function qaCommentMarkerSearch(owner: string, repo: string, prNumber: number): string {
  return `${QA_MARKER_PREFIX} owner=${owner} repo=${repo} pr=${prNumber} head=`;
}

export function managedQaCommentMarkerSearches(owner: string, repo: string, prNumber: number): string[] {
  return [qaCommentMarkerSearch(owner, repo, prNumber)];
}

/** Whether a comment body carries a managed QA marker for this PR. */
export function containsManagedQaCommentMarker(
  body: string,
  target: { owner: string; repo: string; prNumber: number },
): boolean {
  return managedQaCommentMarkerSearches(target.owner, target.repo, target.prNumber).some((markerSearch) =>
    body.includes(markerSearch),
  );
}

/**
 * The verdict carried by this PR's managed QA marker: `app_breaks` (needs work → actionable review-loop
 * item) or `pass` (satisfied → inert). Returns `null` when no managed marker for this PR is present, and
 * `"none"` for a legacy #6939 marker written before the `verdict=` field existed (pending/skipped states
 * and pre-field comments) — a non-actionable default so a malformed/legacy marker never mints an epoch.
 */
export function extractManagedQaCommentVerdict(
  body: string,
  target: { owner: string; repo: string; prNumber: number },
): ManagedQaVerdict | null {
  if (!containsManagedQaCommentMarker(body, target)) return null;
  const search = qaCommentMarkerSearch(target.owner, target.repo, target.prNumber);
  const markerStart = body.indexOf(search);
  const markerEnd = body.indexOf("-->", markerStart);
  // Bound the scan to the marker line. A well-formed marker is one short HTML-comment line, so cap the
  // window: when the closing `-->` is absent or lies past the bound (a truncated/malformed marker), slice
  // only the capped window instead of the whole (possibly large) body — a stray `verdict=` deep in the
  // comment text then can't be misread out of a broken marker.
  const boundedEnd = Math.min(body.length, markerStart + MAX_MARKER_SCAN_LENGTH);
  const markerLine =
    markerEnd === -1 || markerEnd > boundedEnd
      ? body.slice(markerStart, boundedEnd)
      : body.slice(markerStart, markerEnd);
  const match = /\bverdict=(app_breaks|pass|none)\b/.exec(markerLine);
  return match ? (match[1] as ManagedQaVerdict) : "none";
}
