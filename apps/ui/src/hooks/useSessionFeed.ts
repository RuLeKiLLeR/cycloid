import { useRef } from "react";

import type { FeedDelta } from "../../../../shared/types/session-feed";
import { getSessionFeedWsUrl } from "../api/sessions";
import { createReconnectBackoff } from "./sessionWebSocketBackoff";
import { useSyncEffect } from "./useEffects";

const FEED_DELTA_TYPES = new Set<FeedDelta["type"]>([
  "session_upserted",
  "session_status",
  "pr",
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  "verification",
  "session_closed",
]);

/** Parse + whitelist a feed frame. Anything unrecognized is dropped. */
function parseFeedDelta(data: unknown): FeedDelta | null {
  if (typeof data !== "string") return null;
  try {
    const msg = JSON.parse(data) as Record<string, unknown>;
    if (
      msg &&
      typeof msg === "object" &&
      typeof msg.type === "string" &&
      FEED_DELTA_TYPES.has(msg.type as FeedDelta["type"]) &&
      typeof msg.sessionId === "string" &&
      // A session_upserted must carry its row object, or applyFeedDelta would
      // normalize `undefined` into a blank ghost row.
      (msg.type !== "session_upserted" || (typeof msg.session === "object" && msg.session !== null))
    ) {
      return msg as unknown as FeedDelta;
    }
  } catch {
    // Malformed frame.
  }
  return null;
}

interface UseSessionFeedOptions {
  /** Gate the subscription (e.g. only when signed in). */
  enabled: boolean;
  /** Apply one delta to the sidebar list. */
  onDelta: (delta: FeedDelta) => void;
  /** Fired on every (re)connect so the caller can refetch and close any gap. */
  onReconnect: () => void;
}

/**
 * Always-on, business-scoped sidebar feed subscription (ARC-1322). A trimmed
 * clone of `useSessionWebSocket` with no watchdog / replay / afterSequence —
 * the feed is a pure push of list deltas. Reconnects with the shared backoff;
 * gaps from a disconnect are closed by `onReconnect` (refetch) on the next open.
 */
export function useSessionFeed({ enabled, onDelta, onReconnect }: UseSessionFeedOptions): void {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectBackoffRef = useRef<ReturnType<typeof createReconnectBackoff> | null>(null);
  const mountedRef = useRef(false);

  // Stable callback refs so a changing callback identity never reconnects.
  const onDeltaRef = useRef(onDelta);
  onDeltaRef.current = onDelta;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useSyncEffect(() => {
    if (!enabled) return;
    mountedRef.current = true;
    reconnectBackoffRef.current ??= createReconnectBackoff();
    reconnectBackoffRef.current.resetForNewSession();

    function connect() {
      if (!mountedRef.current) return;
      const ws = new WebSocket(getSessionFeedWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws || !mountedRef.current) {
          ws.close();
          return;
        }
        reconnectBackoffRef.current!.recordConnected();
        onReconnectRef.current();
      };

      ws.onmessage = (event) => {
        const delta = parseFeedDelta(event.data);
        if (!delta) return;
        try {
          onDeltaRef.current(delta);
        } catch {
          // A bad consumer callback must not tear down the socket handler.
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (!mountedRef.current) return;
        reconnectBackoffRef.current!.recordClose(null);
        const delay = reconnectBackoffRef.current!.consumeReconnectDelay();
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose fires after onerror; reconnection is handled there.
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        // Strict-mode safe: don't close while still CONNECTING.
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.addEventListener("open", () => ws.close(), { once: true });
        }
        wsRef.current = null;
      }
    };
  }, [enabled]);
}
