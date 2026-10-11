import type { SessionDetail } from "../types";
import { safeHttpsUrl } from "../utils/safe-url";
import { buttonClasses } from "./ui";

// Shared with the inspector's PrPanel so draft detection never forks.
export function isDraftPr(session: SessionDetail): boolean {
  if (typeof session.prDraft === "boolean") return session.prDraft;
  return session.verification?.publishMode === "draft";
}

export function getManualReviewReason(session: SessionDetail): string | null {
  const reason = session.prManualReviewReason ?? session.verification?.manualReviewReason ?? null;
  return reason?.trim() || null;
}

/**
 * The single PR-open idiom: a secondary sm button-shaped link to the PR on
 * GitHub, labelled "Open PR" / "View draft". Used by the sticky bar; the PR
 * tab's PrPanel renders the same treatment inline.
 */
export function PrLink({ session, onViewPr }: { session: SessionDetail; onViewPr: () => void }) {
  const prHref = safeHttpsUrl(session.prUrl);
  if (!prHref) return null;

  return (
    <a
      href={prHref}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onViewPr}
      className={buttonClasses({ variant: "secondary", size: "sm" })}
    >
      {isDraftPr(session) ? "View draft" : "Open PR"}
    </a>
  );
}
