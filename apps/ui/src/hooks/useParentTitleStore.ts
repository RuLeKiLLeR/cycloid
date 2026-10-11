import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import { fetchSessionTitle } from "../api/sessions";
import type { SessionMetadata } from "../types";
import { useSyncEffect } from "./useEffects";

export function useParentTitleStore(sessions: SessionMetadata[]) {
  const parentTitleMapRef = useRef(new Map<string, string>());
  const parentTitleStoreVersionRef = useRef(0);
  const parentTitleSubscribersRef = useRef<Set<() => void> | null>(null);
  const parentTitleInFlightRef = useRef<Set<string> | null>(null);
  parentTitleSubscribersRef.current ??= new Set();
  parentTitleInFlightRef.current ??= new Set();

  const liveSessionTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const session of sessions) {
      if (session.title) titles.set(session.sessionId, session.title);
    }
    return titles;
  }, [sessions]);
  const liveSessionTitlesRef = useRef(liveSessionTitles);
  liveSessionTitlesRef.current = liveSessionTitles;

  const notifyParentTitleSubscribers = useCallback(() => {
    parentTitleStoreVersionRef.current += 1;
    for (const listener of parentTitleSubscribersRef.current!) listener();
  }, []);

  const setParentTitle = useCallback(
    (parentId: string, title: string | null) => {
      const nextValue = title ?? "";
      if (parentTitleMapRef.current.get(parentId) === nextValue) return;
      parentTitleMapRef.current.set(parentId, nextValue);
      notifyParentTitleSubscribers();
    },
    [notifyParentTitleSubscribers],
  );

  const subscribeToParentTitles = useCallback((listener: () => void) => {
    parentTitleSubscribersRef.current!.add(listener);
    return () => parentTitleSubscribersRef.current!.delete(listener);
  }, []);

  const getParentTitlesSnapshot = useCallback(() => parentTitleStoreVersionRef.current, []);

  // Snapshot value intentionally unused: the subscription only forces rerenders
  // when the ref-backed parent-title store changes.
  useSyncExternalStore(subscribeToParentTitles, getParentTitlesSnapshot);

  const visibleParentSessionIds = useMemo(
    () =>
      Array.from(
        new Set(
          sessions
            .map((session) => session.parentSessionId)
            .filter((parentId): parentId is string => typeof parentId === "string" && parentId.length > 0),
        ),
      ),
    [sessions],
  );

  useSyncEffect(() => {
    let changed = false;
    for (const [sessionId, title] of liveSessionTitles) {
      if (parentTitleMapRef.current.get(sessionId) === title) continue;
      parentTitleMapRef.current.set(sessionId, title);
      changed = true;
    }
    if (changed) notifyParentTitleSubscribers();
  }, [liveSessionTitles, notifyParentTitleSubscribers]);

  useSyncEffect(() => {
    for (const parentId of visibleParentSessionIds) {
      if (parentTitleMapRef.current.has(parentId) || parentTitleInFlightRef.current!.has(parentId)) continue;
      parentTitleInFlightRef.current!.add(parentId);
      // Dedupe by parentId so a sidebar full of children sharing one parent
      // only fires one request. Cache null on miss/failure so we do not
      // re-fetch during normal rerenders.
      void fetchSessionTitle(parentId)
        .then((title) => {
          parentTitleInFlightRef.current!.delete(parentId);
          setParentTitle(parentId, title);
        })
        .catch(() => {
          parentTitleInFlightRef.current!.delete(parentId);
          setParentTitle(parentId, null);
        });
    }
  }, [setParentTitle, visibleParentSessionIds]);

  const parentTitleFor = useCallback((parentId: string): string | null => {
    const liveTitle = liveSessionTitlesRef.current.get(parentId);
    if (liveTitle) return liveTitle;
    const cached = parentTitleMapRef.current.get(parentId);
    return cached === undefined || cached === "" ? null : cached;
  }, []);

  const resetParentTitles = useCallback(() => {
    const hadCachedTitles = parentTitleMapRef.current.size > 0;
    parentTitleMapRef.current.clear();
    parentTitleInFlightRef.current!.clear();
    if (hadCachedTitles) notifyParentTitleSubscribers();
  }, [notifyParentTitleSubscribers]);

  return { parentTitleFor, resetParentTitles };
}
