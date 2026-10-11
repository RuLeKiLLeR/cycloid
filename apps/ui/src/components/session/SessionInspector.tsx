/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- a focusable ARIA separator is an interactive widget */
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";

import { displayStatusFromSession } from "../../../../../shared/session/display-status.js";
import {
  RUNTIME_LOG_TAIL_LIMIT,
  SESSION_INSPECTOR_COLLAPSED_KEY,
  SESSION_INSPECTOR_DEFAULT_WIDTH,
  SESSION_INSPECTOR_EXPANDED_KEY,
  SESSION_INSPECTOR_EXPANDED_VIEWPORT_FRACTION,
  SESSION_INSPECTOR_EXPANDED_WIDTH,
  SESSION_INSPECTOR_KEYBOARD_STEP,
  SESSION_INSPECTOR_MAX_WIDTH,
  SESSION_INSPECTOR_MIN_WIDTH,
  SESSION_INSPECTOR_WIDTH_KEY,
  SESSION_THREAD_MIN_WIDTH,
} from "../../constants/session-workbench";
import type { SessionTokenUsage } from "../../hooks/session-state/types";
import { useSyncEffect } from "../../hooks/useEffects";
import type { AgentScreenshot } from "../../hooks/useSessionScreenshots";
import type { ActivityEvent, PromptRow, SessionDetail } from "../../types";
import { CaretRightIcon } from "../icons";
import { Button } from "../ui";
import type { ContextUsage, RuntimeActionId } from "./runtime";
import { deriveRuntimeLogTail } from "./runtime";
import { SessionArtifactPanel } from "./SessionArtifactPanel";
import { deriveReportTexts, deriveSessionChanges, parseStoredPanelWidth } from "./workbench";

export type SessionArtifactWorkspaceProps = {
  session: SessionDetail;
  hydrated: boolean;
  prompts: PromptRow[];
  transcripts: Map<string, ActivityEvent[]>;
  screenshotsByPrompt: Map<string, AgentScreenshot[]>;
  contextUsage: ContextUsage | null;
  tokenUsage: SessionTokenUsage;
  runtimeActionInFlight: RuntimeActionId | null;
  onRuntimeAction: (id: RuntimeActionId) => void;
  prError: string | null;
  qaTestSessionUrl: string | null;
  canTriggerQaVerification: boolean;
  qaVerificationLoading: boolean;
  qaVerificationError: string | null;
  onTriggerQaVerification: () => void;
  onViewPr: () => void;
  readOnly: boolean;
};

type Props = SessionArtifactWorkspaceProps;

function readInspectorWidthPreference(): number {
  try {
    return parseStoredPanelWidth(localStorage.getItem(SESSION_INSPECTOR_WIDTH_KEY), {
      min: SESSION_INSPECTOR_MIN_WIDTH,
      max: SESSION_INSPECTOR_MAX_WIDTH,
      fallback: SESSION_INSPECTOR_DEFAULT_WIDTH,
    });
  } catch {
    return SESSION_INSPECTOR_DEFAULT_WIDTH;
  }
}

function readInspectorCollapsedPreference(): boolean {
  try {
    return localStorage.getItem(SESSION_INSPECTOR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function readInspectorExpandedPreference(): boolean {
  try {
    return localStorage.getItem(SESSION_INSPECTOR_EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Outward-pointing chevrons: the widen/restore affordance for the inspector. */
function ExpandWidthIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4L2.5 8 6 12" />
      <path d="M10 4l3.5 4L10 12" />
    </svg>
  );
}

/**
 * Desktop artifact inspector: the right workbench column on the session page.
 * Owns panel ergonomics — collapse/expand and a drag splitter with the width
 * persisted in localStorage — and projects the transcript/prompt state the
 * page already holds into the artifact panel's inputs. Hidden below xl; the
 * mobile session view keeps its single-column stack.
 */
export function SessionInspector({
  session,
  hydrated,
  prompts,
  transcripts,
  screenshotsByPrompt,
  contextUsage,
  tokenUsage,
  runtimeActionInFlight,
  onRuntimeAction,
  prError,
  qaTestSessionUrl,
  canTriggerQaVerification,
  qaVerificationLoading,
  qaVerificationError,
  onTriggerQaVerification,
  onViewPr,
  readOnly,
}: Props) {
  const [collapsed, setCollapsed] = useState(readInspectorCollapsedPreference);
  const [width, setWidth] = useState(readInspectorWidthPreference);
  const [expanded, setExpanded] = useState(readInspectorExpandedPreference);

  // Drag state mirrors the sidebar splitter in Layout.tsx: refs during the
  // drag, rAF-throttled state updates, and the persisted write on mouseup
  // (never inside the state updater — StrictMode double-invokes updaters).
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(SESSION_INSPECTOR_DEFAULT_WIDTH);
  const pendingWidthRef = useRef(width);
  const resizeRafIdRef = useRef<number | null>(null);

  useSyncEffect(() => {
    pendingWidthRef.current = width;
  }, [width]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    // The handle sits on the panel's left edge, so dragging left grows it.
    pendingWidthRef.current = Math.min(
      SESSION_INSPECTOR_MAX_WIDTH,
      Math.max(SESSION_INSPECTOR_MIN_WIDTH, startWidth.current + (startX.current - e.clientX)),
    );
    if (resizeRafIdRef.current !== null) return;
    resizeRafIdRef.current = requestAnimationFrame(() => {
      resizeRafIdRef.current = null;
      setWidth((current) => {
        const nextWidth = pendingWidthRef.current;
        return current === nextWidth ? current : nextWidth;
      });
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (resizeRafIdRef.current !== null) {
      cancelAnimationFrame(resizeRafIdRef.current);
      resizeRafIdRef.current = null;
    }
    const nextWidth = pendingWidthRef.current;
    try {
      localStorage.setItem(SESSION_INSPECTOR_WIDTH_KEY, String(nextWidth));
    } catch {
      // Persisting is best-effort; in-memory width still drives this session.
    }
    setWidth((current) => (current === nextWidth ? current : nextWidth));
  }, []);

  useSyncEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      if (resizeRafIdRef.current !== null) {
        cancelAnimationFrame(resizeRafIdRef.current);
        resizeRafIdRef.current = null;
      }
    };
  }, [handleMouseMove, handleMouseUp]);

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    if (isDragging.current) return;
    isDragging.current = true;
    startX.current = e.clientX;
    startWidth.current = pendingWidthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function handleResizeKeyDown(e: React.KeyboardEvent) {
    let nextWidth: number | null = null;
    if (e.key === "ArrowLeft") nextWidth = width + SESSION_INSPECTOR_KEYBOARD_STEP;
    if (e.key === "ArrowRight") nextWidth = width - SESSION_INSPECTOR_KEYBOARD_STEP;
    if (e.key === "Home") nextWidth = SESSION_INSPECTOR_MIN_WIDTH;
    if (e.key === "End") nextWidth = SESSION_INSPECTOR_MAX_WIDTH;
    if (nextWidth === null) return;
    e.preventDefault();
    const clamped = Math.min(SESSION_INSPECTOR_MAX_WIDTH, Math.max(SESSION_INSPECTOR_MIN_WIDTH, nextWidth));
    pendingWidthRef.current = clamped;
    setWidth(clamped);
    try {
      localStorage.setItem(SESSION_INSPECTOR_WIDTH_KEY, String(clamped));
    } catch {
      // Best-effort persistence only.
    }
  }

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SESSION_INSPECTOR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // Best-effort persistence only.
      }
      return next;
    });
  }, []);

  // Wide-layout toggle. The drag width state is untouched, so restoring drops
  // the panel straight back to the previous width.
  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SESSION_INSPECTOR_EXPANDED_KEY, next ? "1" : "0");
      } catch {
        // Best-effort persistence only.
      }
      return next;
    });
  }, []);

  if (collapsed) {
    return (
      <aside aria-label="Session artifacts, collapsed" className="hidden w-10 shrink-0 border-l border-border xl:flex">
        <div className="flex w-full flex-col items-center pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleCollapsed}
            aria-label="Expand panel"
            title="Expand panel"
            className="w-8 px-0"
          >
            <CaretRightIcon className="size-3.5 rotate-180" />
          </Button>
        </div>
      </aside>
    );
  }

  // Expanded claims 2x the max drag width, capped at a viewport fraction so
  // the thread column stays visible on narrower desktops.
  const expandedMaxWidth = `min(${Math.round(SESSION_INSPECTOR_EXPANDED_VIEWPORT_FRACTION * 100)}vw, calc(100vw - ${SESSION_THREAD_MIN_WIDTH}px))`;

  return (
    <aside
      aria-label="Session artifacts"
      className="editorial-rise editorial-rise-3 relative hidden shrink-0 xl:flex"
      style={expanded ? { width: SESSION_INSPECTOR_EXPANDED_WIDTH, maxWidth: expandedMaxWidth } : { width }}
    >
      {!expanded && (
        <div
          role="separator"
          aria-label="Resize artifact panel"
          aria-orientation="vertical"
          aria-valuemin={SESSION_INSPECTOR_MIN_WIDTH}
          aria-valuemax={SESSION_INSPECTOR_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          onMouseDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
          className="group absolute top-0 left-0 z-10 h-full w-3 -translate-x-1/2 cursor-col-resize"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-[--duration-fast] group-hover:bg-border-hover" />
        </div>
      )}
      <div className="flex min-h-0 w-full flex-col border-l border-border">
        <SessionArtifactWorkspace
          session={session}
          hydrated={hydrated}
          prompts={prompts}
          transcripts={transcripts}
          screenshotsByPrompt={screenshotsByPrompt}
          contextUsage={contextUsage}
          tokenUsage={tokenUsage}
          runtimeActionInFlight={runtimeActionInFlight}
          onRuntimeAction={onRuntimeAction}
          prError={prError}
          qaTestSessionUrl={qaTestSessionUrl}
          canTriggerQaVerification={canTriggerQaVerification}
          qaVerificationLoading={qaVerificationLoading}
          qaVerificationError={qaVerificationError}
          onTriggerQaVerification={onTriggerQaVerification}
          onViewPr={onViewPr}
          readOnly={readOnly}
          headerAction={
            <span className="flex items-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={toggleExpanded}
                aria-label={expanded ? "Restore panel width" : "Widen panel"}
                title={expanded ? "Restore panel width" : "Widen panel"}
                className="w-8 px-0"
              >
                <ExpandWidthIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={toggleCollapsed}
                aria-label="Collapse panel"
                title="Collapse panel"
                className="w-8 px-0"
              >
                <CaretRightIcon className="size-3.5" />
              </Button>
            </span>
          }
        />
      </div>
    </aside>
  );
}

export function SessionArtifactWorkspace({
  session,
  hydrated,
  prompts,
  transcripts,
  screenshotsByPrompt,
  contextUsage,
  tokenUsage,
  runtimeActionInFlight,
  onRuntimeAction,
  prError,
  qaTestSessionUrl,
  canTriggerQaVerification,
  qaVerificationLoading,
  qaVerificationError,
  onTriggerQaVerification,
  onViewPr,
  readOnly,
  headerAction,
}: SessionArtifactWorkspaceProps & { headerAction?: ReactNode }) {
  const promptOrder = useMemo(() => prompts.map((prompt) => prompt.promptId), [prompts]);
  const changes = useMemo(() => deriveSessionChanges(promptOrder, transcripts), [promptOrder, transcripts]);
  const logTail = useMemo(
    () => deriveRuntimeLogTail(promptOrder, transcripts, RUNTIME_LOG_TAIL_LIMIT),
    [promptOrder, transcripts],
  );
  const observedEvents = useMemo(
    () => promptOrder.flatMap((promptId) => transcripts.get(promptId) ?? []),
    [promptOrder, transcripts],
  );
  const { requestText, finalMessage } = useMemo(() => deriveReportTexts(prompts, transcripts), [prompts, transcripts]);
  const screenshots = useMemo(() => {
    const all: AgentScreenshot[] = [];
    for (const promptId of promptOrder) {
      const shots = screenshotsByPrompt.get(promptId);
      if (shots) all.push(...shots);
    }
    return all;
  }, [promptOrder, screenshotsByPrompt]);
  const displayStatus = displayStatusFromSession(session);

  return (
    <SessionArtifactPanel
      session={session}
      hydrated={hydrated}
      promptCount={prompts.length}
      changes={changes}
      screenshots={screenshots}
      logTail={logTail}
      contextUsage={contextUsage}
      tokenUsage={tokenUsage}
      runtimeActionInFlight={runtimeActionInFlight}
      onRuntimeAction={onRuntimeAction}
      observedEvents={observedEvents}
      isComplete={displayStatus === "completed"}
      requestText={requestText}
      finalMessage={finalMessage}
      prError={prError}
      qaTestSessionUrl={qaTestSessionUrl}
      canTriggerQaVerification={canTriggerQaVerification}
      qaVerificationLoading={qaVerificationLoading}
      qaVerificationError={qaVerificationError}
      onTriggerQaVerification={onTriggerQaVerification}
      onViewPr={onViewPr}
      readOnly={readOnly}
      headerAction={headerAction}
    />
  );
}
