import { VERIFICATION_RESULT_CHIP_LABELS, VERIFICATION_STATE_CHIP_LABELS } from "../../../constants/session-pr";
import type { AgentScreenshot } from "../../../hooks/useSessionScreenshots";
import type { SessionDetail } from "../../../types";
import { MarkdownEventContent } from "../../MarkdownEventContent";
import { Badge, type BadgeTone, cx, EmptyState } from "../../ui";
import { CommandStatusChip } from "./shared";

export type ChecksPanelProps = {
  session: SessionDetail;
  screenshots: AgentScreenshot[];
  /** From the page's display-status projection; switches the no-evidence copy to past tense. */
  isComplete?: boolean;
};

/**
 * True when the session carries any verification/check evidence worth
 * rendering — the same signal the section body branches on. The Report tab
 * uses this to decide whether its Verification section appears while the
 * session is still active.
 */
export function hasVerificationEvidence(
  session: Pick<SessionDetail, "verificationSummary" | "verification" | "verificationState" | "verificationResult">,
  screenshots: AgentScreenshot[],
): boolean {
  return Boolean(
    session.verificationSummary || session.verification || deriveQaVerificationChip(session) || screenshots.length > 0,
  );
}

const NO_VERIFICATION_RECORDED_COPY =
  "No verification recorded — test-gate results and evidence appear here when Cycloid runs checks.";

export function deriveQaVerificationChip(
  session: Pick<SessionDetail, "verificationState" | "verificationResult">,
): { label: string; tone: BadgeTone } | null {
  const state = session.verificationState ?? null;
  if (!state) return null;
  if (state === "verification-done" && session.verificationResult) {
    return session.verificationResult === "merge-ready"
      ? { label: VERIFICATION_RESULT_CHIP_LABELS["merge-ready"], tone: "success" }
      : { label: VERIFICATION_RESULT_CHIP_LABELS["needs-work"], tone: "warning" };
  }
  return {
    label: VERIFICATION_STATE_CHIP_LABELS[state],
    tone: state === "verification-in-progress" ? "accent" : "default",
  };
}

function ScreenshotGrid({ screenshots }: { screenshots: AgentScreenshot[] }) {
  if (screenshots.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {screenshots.map((shot) => (
        <a key={shot.artifactId} href={shot.viewUrl} target="_blank" rel="noopener noreferrer" className="block">
          <img src={shot.viewUrl} alt={shot.label} loading="lazy" className="img-outline w-full object-cover" />
        </a>
      ))}
    </div>
  );
}

/**
 * Verification/check evidence for the session. Rendered as the Report tab's
 * Verification section so evidence is available before, during, and after PR
 * publication.
 */
export function ChecksPanel({ session, screenshots, isComplete = false }: ChecksPanelProps) {
  const summary = session.verificationSummary;
  const verification = session.verification;
  const qaVerificationChip = deriveQaVerificationChip(session);
  const caveats = [...new Set([...(summary?.caveats ?? []), ...(verification?.caveats ?? [])])];
  const artifacts = [...(summary?.visualArtifacts ?? []), ...(verification?.artifacts ?? [])].filter(
    (artifact, index, all) =>
      all.findIndex((candidate) => candidate.url === artifact.url && candidate.label === artifact.label) === index,
  );
  const runtimeEvidence =
    summary?.runtimeEvidence ??
    (verification?.runtimeEvidenceRequired !== undefined || verification?.runtimeEvidenceSatisfied !== undefined
      ? {
          required: verification.runtimeEvidenceRequired === true,
          satisfied: verification.runtimeEvidenceSatisfied === true,
        }
      : null);
  const hasSummary = Boolean(
    summary &&
    (summary.commands.length > 0 ||
      summary.checksPassed.length > 0 ||
      summary.skippedChecks.length > 0 ||
      summary.visualArtifacts.length > 0 ||
      summary.runtimeEvidence ||
      summary.caveats.length > 0 ||
      summary.outcome),
  );

  if (!hasSummary && !verification && !qaVerificationChip && screenshots.length === 0) {
    return isComplete ? (
      <EmptyState title="No verification recorded" description={NO_VERIFICATION_RECORDED_COPY} />
    ) : (
      <EmptyState title="No verification yet" description="Test-gate results and evidence will appear here." />
    );
  }

  // A verification object with no detail sections would render a bare outcome
  // chip — pair it with the explanatory sentence so the state stays legible.
  const hasDetailSections = Boolean(
    (summary?.outcome === "draft" && summary.draftReason) ||
    (summary && (summary.commands.length > 0 || summary.checksPassed.length > 0 || summary.skippedChecks.length > 0)) ||
    verification?.explanation ||
    verification?.claim ||
    (verification?.evidence && verification.evidence.length > 0) ||
    runtimeEvidence ||
    (verification?.steps && verification.steps.length > 0) ||
    verification?.visualAssertion ||
    verification?.previewContract ||
    caveats.length > 0 ||
    (verification?.notes && verification.notes.length > 0) ||
    (verification?.publishWarnReasons && verification.publishWarnReasons.length > 0) ||
    verification?.manualReviewReason ||
    artifacts.length > 0 ||
    screenshots.length > 0,
  );

  const outcomeLabel = summary
    ? summary.outcome === "verified"
      ? "Verified"
      : summary.outcome === "draft"
        ? "Draft — manual review"
        : "Unverified"
    : verification?.verified
      ? "Verified"
      : "Unverified";
  // Grayscale outcome chip — verified/draft/unverified read from the label, never
  // a hue (error is reserved for blocked/failed).
  const outcomeTone =
    (summary?.outcome === "verified" || verification?.verified) && summary?.outcome !== "draft"
      ? "success"
      : summary?.outcome === "draft"
        ? "warning"
        : "default";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        {(summary || verification) && <Badge tone={outcomeTone}>{outcomeLabel}</Badge>}
        {qaVerificationChip && <Badge tone={qaVerificationChip.tone}>{qaVerificationChip.label}</Badge>}
        {verification?.status && (
          <Badge tone={verification.status === "failed" ? "error" : "default"}>
            {verification.status.replace(/_/g, " ")}
          </Badge>
        )}
        {verification?.mode && <Badge tone="default">{verification.mode}</Badge>}
        {verification?.publishMode && <Badge tone="default">Publish {verification.publishMode}</Badge>}
        {verification?.verdict && (
          <Badge tone={verification.verdict === "REFUTED" ? "error" : "default"}>
            {verification.verdict.toLowerCase()}
          </Badge>
        )}
      </div>

      {!hasDetailSections && <p className="text-sm text-text-secondary">{NO_VERIFICATION_RECORDED_COPY}</p>}

      {summary?.outcome === "draft" && summary.draftReason && (
        <p className="text-sm text-text-secondary">{summary.draftReason}</p>
      )}

      {summary && summary.commands.length > 0 && (
        <section className="flex flex-col gap-2">
          <p className="eyebrow">Commands</p>
          <div className="border border-border bg-surface-1">
            {summary.commands.map((command, i) => (
              <div
                key={`${command.command}-${i}`}
                className={cx(i < summary.commands.length - 1 && "border-b border-border")}
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary"
                    title={command.command}
                  >
                    {command.command}
                  </span>
                  {command.exitCode != null && (
                    <span className="shrink-0 font-mono-tabular text-xs text-text-muted">exit {command.exitCode}</span>
                  )}
                  <CommandStatusChip status={command.status} />
                  {command.checks.length > 0 && (
                    <span className="shrink-0 font-mono text-xs text-text-muted">{command.checks.join(", ")}</span>
                  )}
                </div>
                {command.summary && <p className="px-3 pb-2 text-xs text-text-muted">{command.summary}</p>}
                {command.skipReason && <p className="px-3 pb-2 text-xs text-text-muted">{command.skipReason}</p>}
                {command.failureOutput && (
                  <pre className="overflow-x-auto whitespace-pre-wrap px-3 pb-2 font-mono text-xs text-error">
                    {command.failureOutput}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {summary && summary.checksPassed.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Passed</p>
          <p className="text-sm text-text-secondary">{summary.checksPassed.join(", ")}</p>
        </section>
      )}

      {summary && summary.skippedChecks.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Skipped</p>
          {summary.skippedChecks.map((skip) => (
            <p key={skip.check} className="text-sm text-text-muted">
              {skip.check}: {skip.reason}
            </p>
          ))}
        </section>
      )}

      {verification?.explanation && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Summary</p>
          <div className="text-sm text-text-secondary">
            <MarkdownEventContent content={verification.explanation} renderAsPlainText={false} />
          </div>
        </section>
      )}

      {verification?.claim && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Claim</p>
          <p className="text-sm text-text-secondary">{verification.claim}</p>
        </section>
      )}

      {verification?.evidence && verification.evidence.length > 0 && (
        <section className="flex flex-col gap-2">
          <p className="eyebrow">Evidence</p>
          {verification.evidence.map((item, index) => (
            <div
              key={`${item.type}-${item.label}-${index}`}
              className="flex flex-col gap-1 border-l border-border pl-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                    {item.label}
                  </a>
                ) : (
                  <span>{item.label}</span>
                )}
                {item.status && <Badge tone={item.status === "failed" ? "error" : "default"}>{item.status}</Badge>}
              </div>
              {item.command && <code className="font-mono text-xs text-text-muted">{item.command}</code>}
              {(item.summary || item.failureOutput) && (
                <p className="text-xs whitespace-pre-wrap text-text-muted">{item.summary || item.failureOutput}</p>
              )}
            </div>
          ))}
        </section>
      )}

      {runtimeEvidence && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Runtime evidence</p>
          <p className="text-sm text-text-secondary">
            {runtimeEvidence.required ? "Required" : "Optional"} ·{" "}
            {runtimeEvidence.satisfied ? "satisfied" : "not satisfied"}
          </p>
        </section>
      )}

      {verification?.steps && verification.steps.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Steps</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-text-secondary">
            {verification.steps.map((step, index) => (
              <li key={`${step}-${index}`}>{step}</li>
            ))}
          </ol>
        </section>
      )}

      {verification?.visualAssertion && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Visual assertion</p>
          <p className="text-sm text-text-secondary">{verification.visualAssertion}</p>
        </section>
      )}

      {verification?.previewContract && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Preview</p>
          <p className="font-mono text-xs text-text-secondary">
            {verification.previewContract.cwd} · port {verification.previewContract.url.hostPort}
            {verification.previewContract.url.path ?? ""}
          </p>
        </section>
      )}

      {caveats.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Caveats</p>
          {caveats.map((caveat, i) => (
            <p key={i} className="text-sm text-text-secondary">
              {caveat}
            </p>
          ))}
        </section>
      )}

      {verification?.notes && verification.notes.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Notes</p>
          {verification.notes.map((note, index) => (
            <p key={index} className="text-sm text-text-secondary">
              {note}
            </p>
          ))}
        </section>
      )}

      {verification?.publishWarnReasons && verification.publishWarnReasons.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Publish warnings</p>
          {verification.publishWarnReasons.map((reason, index) => (
            <p key={index} className="text-sm text-text-secondary">
              {reason}
            </p>
          ))}
        </section>
      )}

      {verification?.manualReviewReason && (
        <section className="flex flex-col gap-1.5">
          <p className="eyebrow">Manual review</p>
          <p className="text-sm text-text-secondary">{verification.manualReviewReason}</p>
        </section>
      )}

      {artifacts.length > 0 && (
        <section className="flex flex-col gap-2">
          <p className="eyebrow">Artifacts</p>
          {artifacts.map((artifact, index) => (
            <div key={`${artifact.url}-${index}`} className="text-sm text-text-secondary">
              <a href={artifact.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                {artifact.label}
              </a>
              {artifact.inlineText?.content && (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-text-muted">
                  {artifact.inlineText.content}
                </pre>
              )}
            </div>
          ))}
        </section>
      )}

      {screenshots.length > 0 && (
        <section className="flex flex-col gap-2">
          <p className="eyebrow">Screenshots</p>
          <ScreenshotGrid screenshots={screenshots} />
        </section>
      )}
    </div>
  );
}
