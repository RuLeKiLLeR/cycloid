import { type MutableRefObject, useCallback, useRef, useState } from "react";

import { REPLAY_PAGE_SIZE } from "../../../../shared/constants/session";
import type { DesktopActionPathRow } from "../../../../shared/types/desktop-action-path";
import type { SessionReplayEvent } from "../../../../shared/types/session-replay";
import type { PromptHistoryFetchResult } from "../api/sessions";
import { TERMINAL_FOR_FALLBACK_POLLING_PHASES, TERMINAL_PHASES } from "../constants";
import { SANDBOX_ID_UNKNOWN_SENTINEL } from "../constants/session-workbench";
import type { Phase, PromptRow, Provider, SessionDetail, SessionMetadata } from "../types";
import { type DurableEventDispatchContext, handleDurableEvent } from "../utils/durable-event-dispatch";
import { dispatchRealtimeDurableEvent } from "../utils/session-realtime-dispatch";
import { toSubscribedSessionDetail } from "../utils/session-subscribe";
import { isWatchdogActivePhase } from "../utils/status-display";
import { buildSessionStatusPatch } from "./sessionStatusPatch";
import { useLayoutSyncEffect, useMountEffect, useSyncEffect } from "./useEffects";
import type { ActivePromptHistoryRefreshSource } from "./useSessionFallbackPolling";
import { getInFlightPromptId, type SessionState, type SessionStateAction } from "./useSessionState";
import { isLivenessMessage, type ServerMessage, useSessionWebSocket } from "./useSessionWebSocket";

// Treat the user as "pinned to bottom" if they're within this many pixels of the end.
// Tolerates fractional scroll positions and small layout shifts (e.g., images loading).
const STICK_TO_BOTTOM_THRESHOLD_PX = 80;

type RequestReplayPageFn = (request: { afterSequence?: number; beforeSequence?: number; limit?: number }) => boolean;

function isTruncatedBootstrapReplay(msg: Extract<ServerMessage, { type: "subscribed" }>): boolean {
  return (
    msg.replay.droppedCount > 0 ||
    (msg.replay.afterSequence > 0 &&
      msg.replay.hasMore &&
      msg.replay.firstSequence != null &&
      msg.replay.firstSequence > msg.replay.afterSequence + 1)
  );
}

function buildReplayTruncationKey(replay: {
  afterSequence: number;
  firstSequence: number | null;
  lastSequence: number | null;
}): string | null {
  if (replay.firstSequence == null || replay.lastSequence == null) return null;
  // Replay truncation now uses a sentinel contract, so the dedupe key only
  // needs the truncated window identity, not a dropped-count payload.
  return `${replay.afterSequence}:${replay.firstSequence}:${replay.lastSequence}:truncated`;
}

type UseSessionReplayOptions = {
  applyPromptHistoryFetchResult: (
    promptId: string,
    result: PromptHistoryFetchResult,
  ) => { replacedPartialReplay: boolean; staleDiscarded: boolean };
  aggressiveFallbackActiveRef: MutableRefObject<boolean>;
  bootstrapFromHttp: () => Promise<void>;
  clearBootstrapTimeout: () => void;
  clearPolling: () => void;
  dispatchSessionState: (action: SessionStateAction) => void;
  fetchPromptHistoryOnce: (promptId: string, signal?: AbortSignal) => Promise<PromptHistoryFetchResult>;
  getCurrentActivePromptId: (promptList?: PromptRow[]) => string | null;
  hydratePromptHistories: (promptIds: string[]) => void;
  ingestReplayPage: (events: SessionReplayEvent[]) => void;
  markPromptHistoriesSkipped?: (promptIds: string[]) => void;
  maybeNotify?: (eventType: string) => void;
  onDesktopActionPathRow?: (row: DesktopActionPathRow) => void;
  refreshDesktopActionPathSnapshot?: () => void;
  models: Provider[];
  refresh: (source?: ActivePromptHistoryRefreshSource) => Promise<void>;
  refreshActivePromptHistory: (promptList: PromptRow[], source: ActivePromptHistoryRefreshSource) => Promise<void>;
  mergeSessionMetadata: (session: SessionDetail, prompts: PromptRow[]) => void;
  session: SessionDetail | null;
  sessionId: string;
  setError: (error: string | null) => void;
  setSessionHydrated: (value: boolean) => void;
  setSessions: (updater: (prev: SessionMetadata[]) => SessionMetadata[]) => void;
  refreshSessions?: () => Promise<void>;
  startAggressiveFallbackPolling: () => void;
  startResiliencePolling: () => void;
  stateRef: { current: SessionState };
  transcripts: SessionState["transcripts"];
  updateSession: (updater: (prev: SessionDetail | null) => SessionDetail | null) => void;
  wsBootstrappedRef: MutableRefObject<boolean>;
};

export function useSessionReplay({
  applyPromptHistoryFetchResult,
  aggressiveFallbackActiveRef,
  bootstrapFromHttp,
  clearBootstrapTimeout,
  clearPolling,
  dispatchSessionState,
  fetchPromptHistoryOnce,
  getCurrentActivePromptId,
  hydratePromptHistories,
  ingestReplayPage,
  markPromptHistoriesSkipped,
  maybeNotify,
  onDesktopActionPathRow,
  refreshDesktopActionPathSnapshot,
  mergeSessionMetadata,
  models,
  refresh,
  refreshActivePromptHistory,
  session,
  sessionId,
  setError,
  setSessionHydrated,
  setSessions,
  refreshSessions,
  startAggressiveFallbackPolling,
  startResiliencePolling,
  stateRef,
  transcripts,
  updateSession,
  wsBootstrappedRef,
}: UseSessionReplayOptions) {
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false);
  const dispatchCtxRef = useRef<DurableEventDispatchContext | null>(null);
  const lastSequenceRef = useRef(0);
  const oldestReplaySequenceRef = useRef<number | null>(null);
  const olderEventsAvailableRef = useRef(false);
  const handledReplayTruncationKeyRef = useRef<string | null>(null);
  const replayPagingInFlightRef = useRef(false);
  const requestReplayPageRef = useRef<RequestReplayPageFn | undefined>(undefined);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const sidebarRefreshChildIdsKeyRef = useRef(session?.childSessionIds?.join(",") ?? "");
  const childSessionIdsKey = session?.childSessionIds?.join(",") ?? "";
  useSyncEffect(() => {
    sidebarRefreshChildIdsKeyRef.current = childSessionIdsKey;
  }, [childSessionIdsKey]);
  useSyncEffect(() => {
    handledReplayTruncationKeyRef.current = null;
  }, [sessionId]);
  // Mirror the scroll container / top-sentinel nodes into state so the effects that attach
  // listeners re-run when the nodes are remounted — e.g. after an error screen unmounts the
  // transcript and a later recovery restores it. Keying those effects on [sessionId, !!session]
  // missed that remount, leaving the scroll listener / observer bound to a detached node.
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  const [topSentinelEl, setTopSentinelEl] = useState<HTMLDivElement | null>(null);
  const setScrollContainerNode = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node;
    setScrollContainerEl(node);
  }, []);
  const setTopSentinelNode = useCallback((node: HTMLDivElement | null) => {
    topSentinelRef.current = node;
    setTopSentinelEl(node);
  }, []);
  const prevScrollHeightRef = useRef(0);
  const isPrependingRef = useRef(false);
  // Start true so first content load (subscribed replay) lands at the latest event.
  const isAtBottomRef = useRef(true);
  const scrollPinnedRafIdRef = useRef<number | null>(null);

  const updatePinnedState = useCallback((container: HTMLDivElement) => {
    const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
    isAtBottomRef.current = distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX;
  }, []);

  useMountEffect(() => {
    lastSequenceRef.current = 0;
    oldestReplaySequenceRef.current = null;
    olderEventsAvailableRef.current = false;
    handledReplayTruncationKeyRef.current = null;
    replayPagingInFlightRef.current = false;
    setLoadingOlderEvents(false);
  });

  const syncSessionStatus = useCallback(
    (
      phase: Phase,
      title?: string,
      lifecycle?: {
        displayStatus?: SessionDetail["displayStatus"];
        sandboxSubstate?: SessionDetail["sandboxSubstate"];
        stopMode?: SessionDetail["stopMode"];
        finalizingStep?: SessionDetail["finalizingStep"];
        uiLifecycleStage?: SessionDetail["uiLifecycleStage"];
        userStopped?: SessionDetail["userStopped"];
      },
    ) => {
      const patch = buildSessionStatusPatch({ phase, title, ...lifecycle }, Date.now());
      setSessions((prev) => prev.map((item) => (item.sessionId === sessionId ? { ...item, ...patch } : item)));
    },
    [sessionId, setSessions],
  );

  const syncSessionPrUrl = useCallback(
    (prUrl: string, draft: boolean) => {
      const patchedAt = Date.now();
      setSessions((prev) =>
        prev.map((item) =>
          item.sessionId === sessionId ? { ...item, prUrl, prDraft: draft, lastLivePrPatchAt: patchedAt } : item,
        ),
      );
    },
    [sessionId, setSessions],
  );

  const dispatchCtx: DurableEventDispatchContext = {
    sessionId,
    context: "live",
    dispatch: dispatchSessionState,
    applyPromptHistoryFetchResult,
    stateRef,
    syncSessionStatus,
    syncSessionPrUrl,
    refresh,
    fetchPromptEvents: (_sessionId, promptId) => fetchPromptHistoryOnce(promptId),
    terminalPhases: TERMINAL_PHASES as Set<Phase>,
  };
  dispatchCtxRef.current = dispatchCtx;

  const dispatchRealtimeEvent = useCallback(
    (event: SessionReplayEvent, context: DurableEventDispatchContext["context"]) => {
      const currentDispatchCtx = dispatchCtxRef.current;
      if (!currentDispatchCtx) return;
      dispatchRealtimeDurableEvent(event, context, currentDispatchCtx, {
        lastSequenceRef,
      });
    },
    [],
  );

  const maybeRequestOlderReplayPage = useCallback((requestReplayPage: RequestReplayPageFn | undefined) => {
    const beforeSequence = oldestReplaySequenceRef.current;
    if (!requestReplayPage || replayPagingInFlightRef.current || beforeSequence == null || beforeSequence <= 1) return;
    replayPagingInFlightRef.current = true;
    setLoadingOlderEvents(true);
    if (!requestReplayPage({ beforeSequence, limit: REPLAY_PAGE_SIZE })) {
      replayPagingInFlightRef.current = false;
      setLoadingOlderEvents(false);
    }
  }, []);

  const handleWsMessage = useCallback(
    (msg: ServerMessage) => {
      try {
        if (aggressiveFallbackActiveRef.current && isLivenessMessage(msg)) {
          startResiliencePolling();
        }

        switch (msg.type) {
          case "subscribed": {
            const subscribedStartedAt = performance.now();
            const replayTruncated = isTruncatedBootstrapReplay(msg);
            const replayTruncationKey = replayTruncated ? buildReplayTruncationKey(msg.replay) : null;
            wsBootstrappedRef.current = true;
            replayPagingInFlightRef.current = false;
            olderEventsAvailableRef.current = replayTruncated ? false : msg.replay.hasMore;
            clearBootstrapTimeout();
            setLoadingOlderEvents(false);
            setError(null);
            setSessionHydrated(true);
            const subscribedSession = toSubscribedSessionDetail(msg, stateRef.current.session ?? null, models);
            mergeSessionMetadata(subscribedSession, msg.prompts);
            const childIdsKey = subscribedSession.childSessionIds?.join(",") ?? "";
            if (childIdsKey !== sidebarRefreshChildIdsKeyRef.current) {
              sidebarRefreshChildIdsKeyRef.current = childIdsKey;
              if (childIdsKey) void refreshSessions?.();
            }
            ingestReplayPage(msg.replay.events);
            oldestReplaySequenceRef.current = replayTruncated ? null : msg.replay.firstSequence;
            lastSequenceRef.current = Math.max(lastSequenceRef.current, msg.replay.lastSequence ?? 0);
            syncSessionStatus(subscribedSession.phase, subscribedSession.title ?? undefined, {
              displayStatus: subscribedSession.displayStatus,
              sandboxSubstate: subscribedSession.sandboxSubstate,
              stopMode: subscribedSession.stopMode,
              finalizingStep: subscribedSession.finalizingStep,
              uiLifecycleStage: subscribedSession.uiLifecycleStage,
              userStopped: subscribedSession.userStopped,
            });
            if (TERMINAL_FOR_FALLBACK_POLLING_PHASES.has(subscribedSession.phase)) {
              clearPolling();
            }
            if (!replayTruncated) {
              hydratePromptHistories(msg.prompts.map((prompt) => prompt.promptId));
            } else {
              markPromptHistoriesSkipped?.(msg.prompts.map((prompt) => prompt.promptId));
            }
            if (!replayTruncated && getInFlightPromptId(msg.prompts)) {
              void refreshActivePromptHistory(msg.prompts, "subscribed_replay");
            }
            void import("../datadog").then(({ trackAction }) =>
              trackAction("session_ws_subscribed_bootstrap", {
                sessionId,
                promptCount: msg.prompts.length,
                replayEventCount: msg.replay.events.length,
                replayTruncated,
                replayDroppedCount: msg.replay.droppedCount,
                replayHasMore: msg.replay.hasMore,
                durationMs: Math.round(performance.now() - subscribedStartedAt),
              }),
            );
            if (replayTruncated && replayTruncationKey !== handledReplayTruncationKeyRef.current) {
              handledReplayTruncationKeyRef.current = replayTruncationKey;
              void refresh("replay_truncated");
            }
            break;
          }
          case "session_event": {
            dispatchRealtimeEvent(msg.event, "live");
            break;
          }
          case "replay_event": {
            dispatchRealtimeEvent(msg.event, "replay");
            break;
          }
          case "replay_page": {
            replayPagingInFlightRef.current = false;
            olderEventsAvailableRef.current = msg.hasMore;
            setLoadingOlderEvents(false);
            if (msg.events.length > 0) {
              const container = scrollContainerRef.current;
              if (container) {
                prevScrollHeightRef.current = container.scrollHeight;
                isPrependingRef.current = true;
              }
            }
            ingestReplayPage(msg.events);
            oldestReplaySequenceRef.current = msg.firstSequence;
            break;
          }
          case "replay_error":
            replayPagingInFlightRef.current = false;
            setLoadingOlderEvents(false);
            setError(msg.message);
            break;
          case "replay_truncated":
            replayPagingInFlightRef.current = false;
            olderEventsAvailableRef.current = false;
            setLoadingOlderEvents(false);
            const replayTruncationKey = buildReplayTruncationKey({
              afterSequence: msg.requestedAfterSequence,
              firstSequence: msg.firstReturnedSequence,
              lastSequence: msg.lastReturnedSequence,
            });
            if (replayTruncationKey === handledReplayTruncationKeyRef.current) {
              break;
            }
            handledReplayTruncationKeyRef.current = replayTruncationKey;
            console.warn(`[SessionDetail] Replay truncated for session ${sessionId}; refreshing authoritative state`);
            void import("../datadog").then(({ trackAction }) =>
              trackAction("session_replay_truncated", {
                sessionId,
                truncated: true,
              }),
            );
            void refresh("replay_truncated");
            break;
          case "sandbox_ready":
            updateSession((prev) =>
              prev
                ? {
                    ...prev,
                    // Clear the reconnecting substate; phase transitions are driven by the
                    // canonical session_status frame elsewhere.
                    sandboxSubstate: prev.sandboxSubstate === "reconnecting" ? "none" : prev.sandboxSubstate,
                    spawnDurationMs: msg.spawnDurationMs ?? null,
                    // The frame is broadcast when the bridge socket attaches, so
                    // connected flips true here; the "unknown" placeholder id is
                    // never surfaced over a previously known real id.
                    sandboxConnected: true,
                    sandboxId:
                      msg.sandboxId && msg.sandboxId !== SANDBOX_ID_UNKNOWN_SENTINEL
                        ? msg.sandboxId
                        : (prev.sandboxId ?? null),
                  }
                : prev,
            );
            break;
          case "sandbox_error":
            setError(msg.error);
            break;
          case "prompt_updated": {
            const currentDispatchCtx = dispatchCtxRef.current;
            if (currentDispatchCtx) {
              handleDurableEvent("prompt_updated", { prompt: msg.prompt }, { ...currentDispatchCtx, context: "live" });
            }
            break;
          }
          case "desktop_action_path_row": {
            onDesktopActionPathRow?.(msg.row);
            break;
          }
          case "sandbox_event": {
            const event = msg.event as { type: string; status?: string };
            if (event.type === "heartbeat" && event.status === "reconnecting") {
              updateSession((prev) =>
                prev ? { ...prev, sandboxSubstate: "reconnecting", sandboxConnected: false } : prev,
              );
            }
            if (event.type === "heartbeat" && event.status === "disconnected") {
              updateSession((prev) => (prev ? { ...prev, sandboxConnected: false } : prev));
              void refresh("heartbeat_disconnect");
            }
            // Bridge heartbeats (status "ready") only arrive over an attached
            // socket, so they self-heal a stale disconnected indicator.
            if (event.type === "heartbeat" && event.status === "ready") {
              updateSession((prev) =>
                prev && prev.sandboxConnected !== true ? { ...prev, sandboxConnected: true } : prev,
              );
            }
            break;
          }
          case "session_status": {
            updateSession((prev) =>
              prev
                ? {
                    ...prev,
                    phase: msg.phase,
                    displayStatus: msg.displayStatus,
                    ...(msg.uiLifecycleStage !== undefined ? { uiLifecycleStage: msg.uiLifecycleStage } : {}),
                    ...(msg.sandboxSubstate !== undefined ? { sandboxSubstate: msg.sandboxSubstate } : {}),
                    ...(msg.stopMode !== undefined ? { stopMode: msg.stopMode } : {}),
                    // `!== undefined` so an explicit `false` from prompt-admit clears a
                    // prior `true` (else the "Stopped — continue anytime" badge sticks);
                    // an omitted field never clobbers.
                    ...(msg.userStopped !== undefined ? { userStopped: msg.userStopped } : {}),
                    // Plan-approval park metadata rides the live status frame. Same
                    // `!== undefined` discipline: approve broadcasts
                    // `planApprovalPending:false` and that explicit false must clear a
                    // prior park (else the "Needs you" chip / watchdog disarm stick).
                    ...(msg.planApprovalPending !== undefined ? { planApprovalPending: msg.planApprovalPending } : {}),
                    ...(msg.planRevision !== undefined ? { planRevision: msg.planRevision } : {}),
                    ...(msg.planStatus !== undefined ? { planStatus: msg.planStatus } : {}),
                    ...(msg.finalizingStep !== undefined ? { finalizingStep: msg.finalizingStep } : {}),
                    ...(msg.title !== undefined ? { title: msg.title } : {}),
                    ...(msg.lastBranch !== undefined ? { lastBranch: msg.lastBranch } : {}),
                  }
                : prev,
            );
            syncSessionStatus(msg.phase, msg.title, {
              displayStatus: msg.displayStatus,
              sandboxSubstate: msg.sandboxSubstate,
              stopMode: msg.stopMode,
              finalizingStep: msg.finalizingStep,
              uiLifecycleStage: msg.uiLifecycleStage,
              userStopped: msg.userStopped,
            });
            break;
          }
          case "pr_created":
            dispatchSessionState({
              type: "event/publish_state",
              publishStatus: "published",
              prUrl: msg.prUrl,
              draft: msg.draft === true,
              manualReviewReason: msg.manualReviewReason ?? null,
              prActivityKind: "created",
              prActivityAt: Date.now(),
            });
            maybeNotify?.("pr_created");
            break;
          case "pr_updated":
            dispatchSessionState({
              type: "event/publish_state",
              publishStatus: "published",
              prUrl: msg.prUrl,
              draft: msg.draft === true,
              manualReviewReason: msg.manualReviewReason ?? null,
              prActivityKind: "updated",
              prActivityAt: Date.now(),
            });
            break;
          case "verification_updated":
            updateSession((prev) =>
              prev
                ? {
                    ...prev,
                    verification: msg.verification ?? null,
                    // Older payloads omit the field; keep the snapshot value.
                    verificationSummary:
                      msg.verificationSummary !== undefined
                        ? msg.verificationSummary
                        : (prev.verificationSummary ?? null),
                  }
                : prev,
            );
            break;
          case "runtime_provenance_updated":
            updateSession((prev) => (prev ? { ...prev, runtimeProvenance: msg.runtimeProvenance ?? null } : prev));
            break;
          case "observability_readiness_updated":
            updateSession((prev) =>
              prev ? { ...prev, observabilityReadiness: msg.observabilityReadiness ?? null } : prev,
            );
            break;
          case "pr_failed":
            dispatchSessionState({
              type: "event/publish_state",
              publishStatus: "failed",
              publishError: msg.error ?? "PR creation failed",
            });
            break;
          case "pong":
            break;
        }
      } catch (err) {
        console.error("[SessionDetail] WS message handler error", err);
        import("../sentry").then(({ captureUiError }) =>
          captureUiError(err instanceof Error ? err : new Error(String(err)), { operation: "ws_message", sessionId }),
        );
      }
    },
    [
      aggressiveFallbackActiveRef,
      clearBootstrapTimeout,
      clearPolling,
      dispatchRealtimeEvent,
      dispatchSessionState,
      hydratePromptHistories,
      ingestReplayPage,
      markPromptHistoriesSkipped,
      maybeNotify,
      models,
      onDesktopActionPathRow,
      refresh,
      refreshSessions,
      refreshActivePromptHistory,
      refreshDesktopActionPathSnapshot,
      mergeSessionMetadata,
      sessionId,
      setError,
      setSessionHydrated,
      startResiliencePolling,
      stateRef,
      syncSessionStatus,
      updateSession,
      wsBootstrappedRef,
    ],
  );

  const { requestReplayPage } = useSessionWebSocket({
    sessionId,
    getLastSequence: () => lastSequenceRef.current,
    onMessage: handleWsMessage,
    isPromptActive: session?.phase ? isWatchdogActivePhase(session.phase, session.planApprovalPending ?? false) : false,
    onWsBlocked: () => {
      refreshDesktopActionPathSnapshot?.();
      void bootstrapFromHttp();
      startAggressiveFallbackPolling();
    },
    onConnected: () => {
      refreshDesktopActionPathSnapshot?.();
      if (!aggressiveFallbackActiveRef.current) {
        startResiliencePolling();
      }
    },
    onDisconnected: () => {
      replayPagingInFlightRef.current = false;
      olderEventsAvailableRef.current = false;
      setLoadingOlderEvents(false);
    },
    enabled: true,
  });
  requestReplayPageRef.current = requestReplayPage;

  useSyncEffect(() => {
    const container = scrollContainerEl;
    const sentinel = topSentinelEl;
    if (typeof IntersectionObserver === "undefined") return;
    if (!container || !sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        try {
          if (entry?.isIntersecting && olderEventsAvailableRef.current) {
            maybeRequestOlderReplayPage(requestReplayPageRef.current);
          }
        } catch (err) {
          console.error("[SessionDetail] Observer callback error", err);
        }
      },
      { root: container, rootMargin: "200px 0px 0px 0px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [maybeRequestOlderReplayPage, scrollContainerEl, topSentinelEl]);

  useSyncEffect(() => {
    const container = scrollContainerEl;
    if (!container) return;
    // Fresh container (initial mount, or a remount after an error screen): default to pinned
    // and jump to the latest event, then track the user's position via the "scroll" listener
    // registered below.
    isAtBottomRef.current = true;
    container.scrollTop = container.scrollHeight;
    const updatePinned = () => {
      if (scrollPinnedRafIdRef.current !== null) return;
      scrollPinnedRafIdRef.current = requestAnimationFrame(() => {
        scrollPinnedRafIdRef.current = null;
        updatePinnedState(container);
      });
    };
    container.addEventListener("scroll", updatePinned, { passive: true });
    return () => {
      container.removeEventListener("scroll", updatePinned);
      if (scrollPinnedRafIdRef.current !== null) {
        cancelAnimationFrame(scrollPinnedRafIdRef.current);
        scrollPinnedRafIdRef.current = null;
      }
    };
  }, [scrollContainerEl, updatePinnedState]);

  useLayoutSyncEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (scrollPinnedRafIdRef.current !== null) {
      cancelAnimationFrame(scrollPinnedRafIdRef.current);
      scrollPinnedRafIdRef.current = null;
      updatePinnedState(container);
    }
    if (isPrependingRef.current) {
      isPrependingRef.current = false;
      container.scrollTop += container.scrollHeight - prevScrollHeightRef.current;
      return;
    }
    if (isAtBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [transcripts, updatePinnedState]);

  return {
    loadingOlderEvents,
    scrollContainerRef: setScrollContainerNode,
    topSentinelRef: setTopSentinelNode,
  };
}
