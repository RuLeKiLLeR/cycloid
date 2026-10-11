import { useCallback, useRef, useState } from "react";

import type { DesktopActionPathRow } from "../../../../shared/types/desktop-action-path";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { fetchSessionDesktopActionPath } from "../api/sessions";
import { useSyncEffect } from "./useEffects";

type DesktopActionPathState = {
  sessionId: string;
  rows: DesktopActionPathRow[];
  maxDesktopActionSeq: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
};

type UseSessionDesktopActionPathResult = {
  rows: DesktopActionPathRow[];
  maxDesktopActionSeq: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  ingestLiveRow: (row: DesktopActionPathRow) => void;
  refreshSnapshot: () => void;
};

type UseSessionDesktopActionPathOptions = {
  enabled?: boolean;
};

type SnapshotRefreshOptions = {
  showLoading?: boolean;
  coalesce?: boolean;
};

function sortDesktopActionRows(rows: DesktopActionPathRow[]): DesktopActionPathRow[] {
  return [...rows].sort((left, right) => {
    if (left.desktopActionSeq !== right.desktopActionSeq) return left.desktopActionSeq - right.desktopActionSeq;
    if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
    return left.actionId.localeCompare(right.actionId);
  });
}

function isNewerDesktopActionRow(existing: DesktopActionPathRow, incoming: DesktopActionPathRow): boolean {
  if (incoming.updatedAtMs !== existing.updatedAtMs) return incoming.updatedAtMs > existing.updatedAtMs;
  return incoming.desktopActionSeq >= existing.desktopActionSeq;
}

function mergeDesktopActionRows(
  existingRows: DesktopActionPathRow[],
  incomingRows: DesktopActionPathRow[],
): DesktopActionPathRow[] {
  const byActionId = new Map<string, DesktopActionPathRow>();
  for (const row of existingRows) byActionId.set(row.actionId, row);
  for (const row of incomingRows) {
    const existing = byActionId.get(row.actionId);
    if (!existing || isNewerDesktopActionRow(existing, row)) byActionId.set(row.actionId, row);
  }
  return sortDesktopActionRows(Array.from(byActionId.values()));
}

function emptyState(sessionId: string, loading: boolean): DesktopActionPathState {
  return {
    sessionId,
    rows: [],
    maxDesktopActionSeq: 0,
    loading,
    refreshing: false,
    error: null,
  };
}

function liveRowMayPruneScreenshots(row: DesktopActionPathRow): boolean {
  return row.screenshot?.status === "available";
}

const NOOP_REFRESH = () => undefined;

export function useSessionDesktopActionPath(
  sessionId: string,
  options: UseSessionDesktopActionPathOptions = {},
): UseSessionDesktopActionPathResult {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<DesktopActionPathState>(() => emptyState(sessionId, enabled));
  const stateRef = useRef(state);
  stateRef.current = state;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const inFlightSnapshotRef = useRef<{ controller: AbortController; requestId: number } | null>(null);
  const requestSeqRef = useRef(0);
  const pendingCoalescedRefreshRef = useRef(false);
  const startSnapshotRefreshRef = useRef<(refreshOptions?: SnapshotRefreshOptions) => void>(NOOP_REFRESH);
  const maxDesktopActionSeqRef = useRef(state.maxDesktopActionSeq);
  if (state.sessionId === sessionId) {
    maxDesktopActionSeqRef.current = state.maxDesktopActionSeq;
  }

  const abortInFlightSnapshot = useCallback(() => {
    const inFlight = inFlightSnapshotRef.current;
    if (!inFlight) return;
    inFlightSnapshotRef.current = null;
    inFlight.controller.abort();
  }, []);

  const startSnapshotRefresh = useCallback(
    (refreshOptions: SnapshotRefreshOptions = {}) => {
      if (!enabledRef.current) return;
      if (refreshOptions.coalesce === true && inFlightSnapshotRef.current) {
        pendingCoalescedRefreshRef.current = true;
        return;
      }

      pendingCoalescedRefreshRef.current = false;
      abortInFlightSnapshot();
      const controller = new AbortController();
      const requestId = requestSeqRef.current + 1;
      requestSeqRef.current = requestId;
      inFlightSnapshotRef.current = { controller, requestId };

      setState((prev) => {
        if (prev.sessionId !== sessionId) return emptyState(sessionId, refreshOptions.showLoading === true);
        return {
          ...prev,
          loading: refreshOptions.showLoading === true && prev.rows.length === 0,
          refreshing: refreshOptions.showLoading !== true || prev.rows.length > 0,
          error: null,
        };
      });

      void (async () => {
        try {
          const snapshot = await fetchSessionDesktopActionPath(sessionId, controller.signal);
          if (controller.signal.aborted || inFlightSnapshotRef.current?.requestId !== requestId) return;
          const rows = sortDesktopActionRows(snapshot.rows);
          const maxDesktopActionSeq = Math.max(
            snapshot.maxDesktopActionSeq,
            ...rows.map((row) => row.desktopActionSeq),
            0,
          );
          maxDesktopActionSeqRef.current = maxDesktopActionSeq;
          setState((prev) => {
            if (prev.sessionId !== sessionId) return prev;
            return {
              sessionId,
              rows,
              maxDesktopActionSeq,
              loading: false,
              refreshing: false,
              error: null,
            };
          });
        } catch (error) {
          if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
          if (inFlightSnapshotRef.current?.requestId !== requestId) return;
          setState((prev) => {
            if (prev.sessionId !== sessionId) return prev;
            return {
              ...prev,
              loading: false,
              refreshing: false,
              error: stringifyError(error),
            };
          });
        } finally {
          if (inFlightSnapshotRef.current?.requestId === requestId) {
            inFlightSnapshotRef.current = null;
          }
          if (pendingCoalescedRefreshRef.current && enabledRef.current && stateRef.current.sessionId === sessionId) {
            pendingCoalescedRefreshRef.current = false;
            startSnapshotRefreshRef.current({ coalesce: false });
          }
        }
      })();
    },
    [abortInFlightSnapshot, sessionId],
  );
  startSnapshotRefreshRef.current = startSnapshotRefresh;

  useSyncEffect(() => {
    pendingCoalescedRefreshRef.current = false;
    maxDesktopActionSeqRef.current = 0;
    if (!enabled) {
      requestSeqRef.current += 1;
      abortInFlightSnapshot();
      setState(emptyState(sessionId, false));
      return;
    }

    setState(emptyState(sessionId, true));
    startSnapshotRefresh({ showLoading: true });
    return () => {
      pendingCoalescedRefreshRef.current = false;
      requestSeqRef.current += 1;
      abortInFlightSnapshot();
    };
  }, [sessionId, enabled, abortInFlightSnapshot, startSnapshotRefresh]);

  const refreshSnapshot = useCallback(() => {
    if (!enabledRef.current) return;
    startSnapshotRefresh({ coalesce: false });
  }, [startSnapshotRefresh]);

  const ingestLiveRow = useCallback(
    (row: DesktopActionPathRow) => {
      if (!enabledRef.current) return;
      if (row.sessionId !== sessionId) return;
      const currentMaxDesktopActionSeq = stateRef.current.sessionId === sessionId ? maxDesktopActionSeqRef.current : 0;
      const expectedNextSeq = currentMaxDesktopActionSeq + 1;
      if (row.desktopActionSeq > expectedNextSeq) {
        startSnapshotRefresh({ coalesce: false });
      } else if (liveRowMayPruneScreenshots(row)) {
        startSnapshotRefresh({ coalesce: true });
      }
      maxDesktopActionSeqRef.current = Math.max(currentMaxDesktopActionSeq, row.desktopActionSeq);

      setState((prev) => {
        if (prev.sessionId !== sessionId) return prev;
        const rows = mergeDesktopActionRows(prev.rows, [row]);
        return {
          ...prev,
          rows,
          maxDesktopActionSeq: Math.max(prev.maxDesktopActionSeq, row.desktopActionSeq),
          loading: false,
          error: null,
        };
      });
    },
    [sessionId, startSnapshotRefresh],
  );

  const effectiveState = state.sessionId === sessionId ? state : emptyState(sessionId, enabled);
  if (!enabled) {
    return {
      rows: [],
      maxDesktopActionSeq: 0,
      loading: false,
      refreshing: false,
      error: null,
      ingestLiveRow,
      refreshSnapshot: NOOP_REFRESH,
    };
  }

  return {
    rows: effectiveState.rows,
    maxDesktopActionSeq: effectiveState.maxDesktopActionSeq,
    loading: effectiveState.loading,
    refreshing: effectiveState.refreshing,
    error: effectiveState.error,
    ingestLiveRow,
    refreshSnapshot,
  };
}
