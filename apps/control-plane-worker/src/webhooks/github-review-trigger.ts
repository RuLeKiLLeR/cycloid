import { CYCLOID_REVIEW_TRIGGER_TOKEN } from "../constants/pr-review-trigger";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractCycloidReviewTrigger(commentBody: unknown): { triggered: boolean; focus: string | null } {
  if (typeof commentBody !== "string") return { triggered: false, focus: null };
  const pattern = new RegExp(`(^|\\s)${escapeRegex(CYCLOID_REVIEW_TRIGGER_TOKEN)}(?=$|\\s|[.,:;!?])`, "i");
  const match = pattern.exec(commentBody);
  if (!match) return { triggered: false, focus: null };
  const focus = commentBody
    .slice(match.index + match[0].length)
    .replace(/^[\s,.:;!?\-]+/, "")
    .trim();
  return { triggered: true, focus: focus || null };
}
