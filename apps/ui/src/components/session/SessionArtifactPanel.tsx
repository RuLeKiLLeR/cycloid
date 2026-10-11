import { type ReactNode } from "react";
import { useSearchParams } from "react-router";

import { SESSION_ARTIFACT_TAB_IDS } from "../../constants/session-workbench";
import type { SessionTokenUsage } from "../../hooks/session-state/types";
import type { AgentScreenshot } from "../../hooks/useSessionScreenshots";
import type { ActivityEvent, SessionDetail } from "../../types";
import { TabPanel, Tabs } from "../ui";
import { ChangesPanel } from "./panels/ChangesPanel";
import { PrPanel } from "./panels/PrPanel";
import { ReportPanel } from "./panels/ReportPanel";
import { SummaryPanel } from "./panels/SummaryPanel";
import { type ContextUsage, type RuntimeActionId, type RuntimeLogEntry } from "./runtime";
import { SessionRuntimePanel } from "./SessionRuntimePanel";
import { buildArtifactTabs, type FileChange, resolveArtifactTab } from "./workbench";

const ID_BASE = "session-artifacts";

type Props = {
  session: SessionDetail;
  hydrated: boolean;
  promptCount: number;
  changes: FileChange[];
  screenshots: AgentScreenshot[];
  /** Compact tail of log-like transcript events for the Runtime tab. */
  logTail: RuntimeLogEntry[];
  /** Latest known context-window usage, or null when no context event streamed. */
  contextUsage: ContextUsage | null;
  tokenUsage: SessionTokenUsage;
  runtimeActionInFlight: RuntimeActionId | null;
  onRuntimeAction: (id: RuntimeActionId) => void;
  observedEvents?: readonly ActivityEvent[];
  isComplete: boolean;
  /** First user prompt — the request, for the report. */
  requestText: string | null;
  /** Latest settled assistant message — the summary, for the report. */
  finalMessage: string | null;
  // PR tab (PrPanel).
  prError: string | null;
  qaTestSessionUrl?: string | null;
  canTriggerQaVerification?: boolean;
  qaVerificationLoading?: boolean;
  qaVerificationError?: string | null;
  onTriggerQaVerification?: () => void;
  onViewPr: () => void;
  readOnly?: boolean;
  /** Right-aligned slot in the tab bar (e.g. the desktop expand/collapse toggles). */
  headerAction?: ReactNode;
};

/**
 * Inspector tab shell. `?artifact=` is the sole selection source so a tab can
 * be linked, survives refresh, and drives the below-xl drawer without a second
 * state path.
 */
export function SessionArtifactPanel({
  session,
  hydrated,
  promptCount,
  changes,
  screenshots,
  logTail,
  contextUsage,
  tokenUsage,
  runtimeActionInFlight,
  onRuntimeAction,
  observedEvents = [],
  isComplete,
  requestText,
  finalMessage,
  prError,
  qaTestSessionUrl = null,
  canTriggerQaVerification = false,
  qaVerificationLoading = false,
  qaVerificationError = null,
  onTriggerQaVerification,
  onViewPr,
  readOnly = false,
  headerAction,
}: Props) {
  // PR-object signal — the same data PrSection renders from: a published PR
  // URL, a session outcome, or a publish failure that needs surfacing.
  const hasPr = Boolean(session.prUrl || session.outcome || prError || session.publishError);
  const tabs = buildArtifactTabs({ changesCount: changes.length, hasPr, prUrl: session.prUrl });
  const [searchParams, setSearchParams] = useSearchParams();
  const active = resolveArtifactTab(searchParams.get("artifact"), tabs);

  const onValueChange = (id: string) => {
    const next = resolveArtifactTab(id, tabs);
    const updated = new URLSearchParams(searchParams);
    updated.set("artifact", next);
    setSearchParams(updated, { replace: true });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2">
        <Tabs
          tabs={tabs.map((tab) => ({
            id: tab.id,
            label: tab.label,
            // Dynamic count readout: tabular digits so the badge holds width.
            badge: tab.badge !== null ? <span className="numeral">{tab.badge}</span> : undefined,
          }))}
          value={active}
          onValueChange={onValueChange}
          variant="underline"
          idBase={ID_BASE}
          ariaLabel="Session artifacts"
          className="flex-1 overflow-x-auto"
        />
        {headerAction != null && <span className="shrink-0">{headerAction}</span>}
      </div>
      {/* Each panel body is wrapped in an .editorial-fade div. TabPanel
          unmounts inactive children, so the wrapper remounts (and the fade
          plays) exactly once per tab activation — streaming re-renders of an
          already-active panel reconcile in place and never replay it. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <TabPanel id={SESSION_ARTIFACT_TAB_IDS.summary} value={active} idBase={ID_BASE}>
          <div className="editorial-fade">
            <SummaryPanel
              session={session}
              hydrated={hydrated}
              promptCount={promptCount}
              observedEvents={observedEvents}
              onSelectTab={onValueChange}
              onViewPr={onViewPr}
            />
          </div>
        </TabPanel>
        <TabPanel id={SESSION_ARTIFACT_TAB_IDS.runtime} value={active} idBase={ID_BASE}>
          <div className="editorial-fade">
            <SessionRuntimePanel
              session={session}
              logTail={logTail}
              contextUsage={contextUsage}
              tokenUsage={tokenUsage}
              pendingAction={runtimeActionInFlight}
              onAction={onRuntimeAction}
            />
          </div>
        </TabPanel>
        <TabPanel id={SESSION_ARTIFACT_TAB_IDS.changes} value={active} idBase={ID_BASE}>
          <div className="editorial-fade">
            <ChangesPanel changes={changes} prUrl={session.prUrl} />
          </div>
        </TabPanel>
        <TabPanel id={SESSION_ARTIFACT_TAB_IDS.report} value={active} idBase={ID_BASE}>
          <div className="editorial-fade">
            <ReportPanel
              session={session}
              requestText={requestText}
              finalMessage={finalMessage}
              changes={changes}
              screenshots={screenshots}
              isComplete={isComplete}
            />
          </div>
        </TabPanel>
        {hasPr && (
          <TabPanel id={SESSION_ARTIFACT_TAB_IDS.pr} value={active} idBase={ID_BASE}>
            <div className="editorial-fade">
              <PrPanel
                session={session}
                prError={prError}
                qaTestSessionUrl={qaTestSessionUrl}
                canTriggerQaVerification={canTriggerQaVerification}
                qaVerificationLoading={qaVerificationLoading}
                qaVerificationError={qaVerificationError}
                onTriggerQaVerification={onTriggerQaVerification}
                onViewPr={onViewPr}
                readOnly={readOnly}
              />
            </div>
          </TabPanel>
        )}
      </div>
    </div>
  );
}
