import type { AgentScreenshot } from "../../../hooks/useSessionScreenshots";
import { useTransitionReveal } from "../../../hooks/useTransitionReveal";
import type { SessionDetail } from "../../../types";
import { safeHttpsUrl } from "../../../utils/safe-url";
import { MarkdownEventContent } from "../../MarkdownEventContent";
import { EmptyState } from "../../ui";
import type { FileChange } from "../workbench";
import { ChecksPanel, hasVerificationEvidence } from "./ChecksPanel";

export type ReportPanelProps = {
  session: SessionDetail;
  /** First user prompt — the request. */
  requestText: string | null;
  /** Latest settled assistant message — the summary. */
  finalMessage: string | null;
  changes: FileChange[];
  /** Agent screenshots for the verification section's evidence grid. */
  screenshots: AgentScreenshot[];
  /** From the page's display-status projection; gates the rendered report. */
  isComplete: boolean;
};

/**
 * Report tab — the reviewer artifact. While the session is still active it
 * holds a restrained empty state, with the Verification section surfaced early
 * when check evidence already exists; the full rendered report (request,
 * summary, files, verification, PR, risks) appears once the session finishes.
 */
export function ReportPanel({
  session,
  requestText,
  finalMessage,
  changes,
  screenshots,
  isComplete,
}: ReportPanelProps) {
  const showVerification = hasVerificationEvidence(session, screenshots);
  const revealReport = useTransitionReveal(isComplete, true);

  if (!isComplete) {
    return (
      <div className="flex flex-col gap-5">
        {showVerification && (
          <section className="flex flex-col gap-2">
            <p className="eyebrow">Verification</p>
            <ChecksPanel session={session} screenshots={screenshots} isComplete={false} />
          </section>
        )}
        <EmptyState title="Report will be available when the session finishes." />
      </div>
    );
  }

  const summary = session.verificationSummary;
  const prHref = safeHttpsUrl(session.prUrl);
  const risks = [...(summary?.caveats ?? []), ...(session.prManualReviewReason ? [session.prManualReviewReason] : [])];

  return (
    <div className={`flex flex-col gap-5 ${revealReport ? "review-loop-settle" : ""}`}>
      {requestText && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Request</p>
          <p className="text-sm text-text-secondary whitespace-pre-wrap break-words line-clamp-6">{requestText}</p>
        </section>
      )}

      {finalMessage && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Summary</p>
          <div className="text-sm text-text-secondary">
            <MarkdownEventContent content={finalMessage} renderAsPlainText={false} />
          </div>
        </section>
      )}

      <section className="flex flex-col gap-1.5">
        <p className="eyebrow">Touched files ({changes.length})</p>
        {changes.length === 0 ? (
          <p className="text-sm text-text-muted">No file changes recorded.</p>
        ) : (
          <ul className="flex flex-col gap-px">
            {changes.slice(0, 12).map((change) => (
              <li key={change.path} className="flex items-center gap-3 py-0.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">{change.path}</span>
              </li>
            ))}
            {changes.length > 12 && <li className="text-xs text-text-muted">+{changes.length - 12} more</li>}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <p className="eyebrow">Verification</p>
        <ChecksPanel session={session} screenshots={screenshots} isComplete />
      </section>

      {prHref && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Pull request</p>
          <a
            href={prHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-accent hover:underline break-all"
          >
            {prHref}
          </a>
        </section>
      )}

      {risks.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Risks and follow-ups</p>
          {risks.map((risk, i) => (
            <div key={i} className="text-sm text-text-secondary">
              <MarkdownEventContent content={risk} renderAsPlainText={false} variant="inline" />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
