import { type ReactNode, useState } from "react";
import { useOutletContext } from "react-router";

import { stringifyError } from "../../../../../../shared/utils/errors.js";
import { retrySession } from "../../../api/sessions";
import { SESSION_COMPOSER_PROMPT_SELECTOR } from "../../../constants/session-summary";
import type { SessionDetail } from "../../../types";
import { parseRepoFullNameFromUrl } from "../../../utils/repos";
import { safeHttpsUrl } from "../../../utils/safe-url";
import { sessionEntrypointLabel } from "../../../utils/session-entrypoint";
import { formatTimestamp } from "../../../utils/time";
import type { LayoutContext } from "../../Layout";
import { useToast } from "../../Toast";
import { Button, buttonClasses, PhaseTimeline } from "../../ui";
import { type ArtifactTabId, deriveWorkbenchPhaseStates, sessionDisplayBranch, WORKBENCH_PHASES } from "../workbench";
import { deriveSummaryNextAction, type SummaryNextAction } from "./summary-derivations";

export type SummaryPanelProps = {
  session: SessionDetail;
  hydrated: boolean;
  promptCount: number;
  observedEvents?: readonly import("../../../types").ActivityEvent[];
  /** Switch the inspector to another artifact tab. The shell owns tab state. */
  onSelectTab?: (id: ArtifactTabId) => void;
  /** Clears the PR-updated indicator when the PR is opened from here. */
  onViewPr?: () => void;
};

/**
 * Focus the session composer so the user can answer the agent. The composer is
 * a sibling column owned by the page; the panel reaches it through the stable
 * prompt-textarea selector rather than new plumbing across the shell.
 */
function focusComposer() {
  const el = document.querySelector<HTMLTextAreaElement>(SESSION_COMPOSER_PROMPT_SELECTOR);
  if (!el) return;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  el.focus({ preventScroll: true });
}

function NextActionCard({
  action,
  prHref,
  onSelectTab,
  onViewPr,
  onRetry,
  retryPending,
}: {
  action: SummaryNextAction;
  prHref: string | null;
  onSelectTab?: (id: ArtifactTabId) => void;
  onViewPr?: () => void;
  /** Absent in read-only (support) views: the card renders without a button. */
  onRetry?: () => void;
  retryPending?: boolean;
}) {
  let control: ReactNode = null;
  if (action.kind === "review-pr" && prHref) {
    control = (
      <a
        href={prHref}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onViewPr}
        className={buttonClasses({ variant: "primary", size: "sm", className: "w-fit" })}
      >
        {action.label}
      </a>
    );
  } else if (action.kind === "answer-agent") {
    control = (
      <Button type="button" variant="primary" size="sm" className="w-fit" onClick={focusComposer}>
        {action.label}
      </Button>
    );
  } else if (action.kind === "retry") {
    if (onRetry) {
      control = (
        <Button type="button" variant="primary" size="sm" className="w-fit" disabled={retryPending} onClick={onRetry}>
          {retryPending ? "Retrying…" : action.label}
        </Button>
      );
    }
  } else if (action.targetTab && onSelectTab) {
    const tab = action.targetTab;
    control = (
      <Button type="button" variant="primary" size="sm" className="w-fit" onClick={() => onSelectTab(tab)}>
        {action.label}
      </Button>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <p className="eyebrow">Next action</p>
      <div className="session-stack-surface flex flex-col gap-3 p-3">
        <p className="text-sm text-text-secondary">{action.description}</p>
        {action.failureDetail && (
          <p className="border border-error-soft-border bg-error-soft p-2 text-sm break-words text-error">
            {action.failureDetail}
          </p>
        )}
        {control}
      </div>
    </section>
  );
}

/**
 * Summary tab — the session command center: stage progression, the single
 * recommended next action, and orientation context. Status text lives in the
 * header chip and runtime strip; model/context readouts live in the strip and
 * Runtime tab. Request/answer prose belongs to the thread and final Report;
 * PR detail belongs to the PR tab.
 */
export function SummaryPanel({
  session,
  hydrated,
  promptCount,
  observedEvents = [],
  onSelectTab,
  onViewPr,
}: SummaryPanelProps) {
  const toast = useToast();
  // Outlet context is absent in isolated renders (tests); treat that as a
  // normal, non-impersonated view. Support (read-only impersonation) views get
  // no retry button — the server rejects the mutation anyway.
  const layoutContext = useOutletContext<LayoutContext | null>();
  const isSupportView = Boolean(layoutContext?.user?.impersonation?.readOnly);
  const [retryPending, setRetryPending] = useState(false);

  async function handleRetry() {
    if (retryPending) return;
    setRetryPending(true);
    try {
      // Not destructive (clones + re-queues the last prompt), so no confirm —
      // matches the wake/restore actions on the Runtime tab.
      await retrySession(session.sessionId);
      toast("Retrying last prompt", { variant: "success" });
    } catch (error) {
      toast(stringifyError(error), { variant: "error" });
    } finally {
      setRetryPending(false);
    }
  }

  const repoParsed = session.repoUrl ? parseRepoFullNameFromUrl(session.repoUrl) : null;
  const repoHref = session.repoUrl ? safeHttpsUrl(session.repoUrl) : null;
  const repoLabel = repoParsed ? `${repoParsed.owner}/${repoParsed.repo}` : session.repoUrl;
  const branch = sessionDisplayBranch(session);
  const sourceLabel = sessionEntrypointLabel(session.entrypoint, session.initiationMode);
  const scheduleLabel =
    session.entrypoint === "scheduled" && session.ruleNameSnapshot?.trim() ? session.ruleNameSnapshot.trim() : null;
  const createdLabel = formatTimestamp(session.createdAt);
  const phaseStates = deriveWorkbenchPhaseStates({
    phase: session.phase,
    uiLifecycleStage: session.uiLifecycleStage,
    finalizingStep: session.finalizingStep,
    reviewLoopDoneState: session.reviewLoopDoneState,
    sandboxSubstate: session.sandboxSubstate,
    prUrl: session.prUrl,
    hasVerification: Boolean(session.verification || session.verificationSummary),
    promptCount,
    observedEvents,
  });
  // The next action reads the same lifecycle projection the status chip does;
  // it is gated on hydration so a half-loaded record cannot recommend.
  const nextAction = hydrated ? deriveSummaryNextAction(session) : null;
  const prHref = safeHttpsUrl(session.prUrl);

  return (
    <div className="flex flex-col gap-5">
      {/* No status chip here — the header chip and timeline already carry it. */}
      <section className="flex flex-col gap-2">
        <p className="eyebrow">Status</p>
        <PhaseTimeline phases={[...WORKBENCH_PHASES]} states={phaseStates} orientation="vertical" />
      </section>

      {nextAction && (
        <NextActionCard
          action={nextAction}
          prHref={prHref}
          onSelectTab={onSelectTab}
          onViewPr={onViewPr}
          onRetry={isSupportView ? undefined : () => void handleRetry()}
          retryPending={retryPending}
        />
      )}

      <section className="flex flex-col gap-2">
        <p className="eyebrow">Context</p>
        <dl className="grid grid-cols-[minmax(0,7rem)_1fr] gap-x-4 gap-y-2 text-sm">
          {repoLabel && (
            <>
              <dt className="eyebrow pt-0.5">Repository</dt>
              <dd className="min-w-0">
                {repoHref ? (
                  <a
                    href={repoHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-accent hover:underline"
                  >
                    {repoLabel}
                  </a>
                ) : (
                  <span className="break-all text-text-secondary">{repoLabel}</span>
                )}
              </dd>
            </>
          )}
          {branch && (
            <>
              <dt className="eyebrow pt-0.5">Branch</dt>
              <dd className="min-w-0 break-all font-mono-tabular text-text-secondary">{branch}</dd>
            </>
          )}
          {sourceLabel && (
            <>
              <dt className="eyebrow pt-0.5">Started by</dt>
              <dd className="min-w-0 text-text-secondary">
                {sourceLabel}
                {scheduleLabel && <span className="text-text-muted"> · {scheduleLabel}</span>}
              </dd>
            </>
          )}
          {session.ownerLogin && (
            <>
              <dt className="eyebrow pt-0.5">Owner</dt>
              <dd className="min-w-0 truncate text-text-secondary">{session.ownerLogin}</dd>
            </>
          )}
          {createdLabel && (
            <>
              <dt className="eyebrow pt-0.5">Created</dt>
              <dd className="min-w-0 font-mono-tabular text-text-secondary">{createdLabel}</dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}
