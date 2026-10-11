export function parseReviewLoopSourceNumericId(
  sourceId: string,
  prefix: "review-comment" | "issue-comment" | "review-body" | "check-run-failure" | "human",
): number | null {
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(sourceId.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function isCheckRunFailureSourceId(sourceId: string): boolean {
  // Classification only checks the `check-run-failure:<positive digits>` shape; it never converts
  // the id to a JS number, so unlike reply-id parsing it must NOT require a safe integer. A check-run
  // id above Number.MAX_SAFE_INTEGER is still a valid CI item — rejecting it here would misclassify
  // that item as unresolved human feedback in hasUnresolvedPromptedWorkAfterNoDiff.
  const match = /^check-run-failure:(\d+)$/.exec(sourceId.trim());
  return match !== null && Number(match[1]) > 0;
}
