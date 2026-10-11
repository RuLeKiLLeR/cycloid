import { useRef, useState } from "react";

import type { SessionMetadata } from "../types";
import { setAuthenticatedTitleAttention } from "../utils/authenticated-title";
import { useSyncEffect } from "./useEffects";

const ATTENTION_ICONS = new Map([
  ["16x16", "/favicon-16-attention.png"],
  ["32x32", "/favicon-32-attention.png"],
]);

export type AttentionSignalState = {
  statuses: ReadonlyMap<string, SessionMetadata["displayStatus"]>;
  waiting: boolean;
  completed: boolean;
};

export function deriveAttentionSignalState(
  previous: AttentionSignalState,
  sessions: SessionMetadata[],
  visibilityState: DocumentVisibilityState,
): AttentionSignalState {
  const statuses = new Map(sessions.map((session) => [session.sessionId, session.displayStatus]));
  const completed =
    previous.completed ||
    (visibilityState === "hidden" &&
      sessions.some(
        (session) =>
          previous.statuses.has(session.sessionId) &&
          previous.statuses.get(session.sessionId) !== "completed" &&
          session.displayStatus === "completed",
      ));
  const waiting = sessions.some((session) => session.displayStatus === "waiting_for_input");
  const statusesUnchanged =
    statuses.size === previous.statuses.size &&
    [...statuses].every(([sessionId, status]) => previous.statuses.get(sessionId) === status);

  if (statusesUnchanged && waiting === previous.waiting && completed === previous.completed) return previous;

  return {
    statuses,
    waiting,
    completed,
  };
}

function initialState(sessions: SessionMetadata[]): AttentionSignalState {
  return deriveAttentionSignalState({ statuses: new Map(), waiting: false, completed: false }, sessions, "visible");
}

export function useAttentionSignal(sessions: SessionMetadata[]) {
  const [state, setState] = useState(() => initialState(sessions));
  const stateRef = useRef(state);
  const originalIconsRef = useRef<Map<HTMLLinkElement, string | null> | null>(null);

  useSyncEffect(() => {
    const next = deriveAttentionSignalState(stateRef.current, sessions, document.visibilityState);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, [sessions]);

  useSyncEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        const previous = stateRef.current;
        if (!previous.completed) return;
        const next = { ...previous, completed: false };
        stateRef.current = next;
        setState(next);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const active = state.waiting || state.completed;
  useSyncEffect(() => {
    if (active) {
      const icons = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'));
      originalIconsRef.current = new Map(icons.map((icon) => [icon, icon.getAttribute("href")]));
      for (const icon of icons) {
        const attentionHref = ATTENTION_ICONS.get(icon.getAttribute("sizes") ?? "");
        if (attentionHref) icon.setAttribute("href", attentionHref);
      }
      setAuthenticatedTitleAttention(true);
    } else {
      for (const [icon, href] of originalIconsRef.current ?? []) {
        if (href === null) icon.removeAttribute("href");
        else icon.setAttribute("href", href);
      }
      originalIconsRef.current = null;
      setAuthenticatedTitleAttention(false);
    }

    return () => {
      for (const [icon, href] of originalIconsRef.current ?? []) {
        if (href === null) icon.removeAttribute("href");
        else icon.setAttribute("href", href);
      }
      originalIconsRef.current = null;
      setAuthenticatedTitleAttention(false);
    };
  }, [active]);
}
