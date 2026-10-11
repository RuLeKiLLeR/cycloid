import { type RefObject, useRef, useState } from "react";

import type {
  CreateDesktopViewTicketResponse,
  DesktopViewTicketCloseDiagnostics,
} from "../../../../shared/types/desktop-viewer";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { ApiError } from "../api/client";
import {
  createSessionDesktopViewTicket,
  fetchSessionDesktopViewTicketStatus,
  getSessionDesktopViewerWsUrl,
  heartbeatSessionDesktopViewTicket,
  revokeSessionDesktopViewTicket,
} from "../api/sessions";
import { useSyncEffect } from "./useEffects";

export type SessionDesktopViewerStatus =
  "preparing" | "connecting" | "connected" | "reconnecting" | "unavailable" | "rate_limited";

export type SessionDesktopViewerState = {
  status: SessionDesktopViewerStatus;
  message: string;
  desktopName: string | null;
  viewOnly: true;
  retryAfterSeconds: number | null;
};

type RfbEventMap = {
  connect: CustomEvent<Record<string, never>>;
  disconnect: CustomEvent<{ clean?: boolean }>;
  securityfailure: CustomEvent<{ reason?: string }>;
  credentialsrequired: CustomEvent<{ types?: string[] }>;
  desktopname: CustomEvent<{ name?: string }>;
};

type RfbLike = {
  viewOnly: boolean;
  focusOnClick: boolean;
  clipViewport: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  disconnect: () => void;
  addEventListener: <K extends keyof RfbEventMap>(type: K, listener: (event: RfbEventMap[K]) => void) => void;
};

type RfbConstructor = new (
  target: HTMLElement,
  urlOrChannel: string | WebSocket | RTCDataChannel,
  options?: { shared?: boolean },
) => RfbLike;

const DEFAULT_RATE_LIMIT_RETRY_SECONDS = 2;
const DEFAULT_UNAVAILABLE_RETRY_SECONDS = 2;
const CLOSE_STATUS_RACE_RETRY_DELAY_MS = 100;
export const DESKTOP_VIEWER_RECONNECT_DELAY_MS = 1_000;
export const DESKTOP_VIEWER_STARTUP_RETRY_DELAY_MS = 5_000;
export const DESKTOP_VIEWER_UPSTREAM_UNAVAILABLE_RETRY_MS = 90_000;

const PREPARING_MESSAGE = "Desktop is preparing. The live viewer will connect when the stack is ready.";
const CONNECTING_MESSAGE = "Connecting to the view-only desktop.";
const CONNECTED_MESSAGE = "View-only live desktop connected.";
const RECONNECTING_MESSAGE = "Desktop stream interrupted. Reconnecting with a fresh ticket.";
const RATE_LIMITED_MESSAGE = "Desktop live view is reconnecting too quickly. Retrying shortly.";
const UNAVAILABLE_MESSAGE = "Desktop live view is unavailable for this session.";

type ActiveTicket = CreateDesktopViewTicketResponse["ticket"];
type TicketCloseStatus = {
  reason: string | null;
  detail: string | null;
  closed: boolean;
  retryable: boolean | null;
  diagnostics: DesktopViewTicketCloseDiagnostics | null;
};

function desktopErrorRetryable(error: unknown): boolean | null {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== "object") return null;
  const retryable = (error.data as { desktopViewRetryable?: unknown }).desktopViewRetryable;
  return typeof retryable === "boolean" ? retryable : null;
}

function desktopRetryAfterSeconds(error: unknown, fallbackSeconds: number): number {
  const retryAfterSeconds = retryAfterSecondsFromError(error);
  return retryAfterSeconds ?? fallbackSeconds;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function retryAfterSecondsFromError(error: unknown): number | null {
  if (!(error instanceof ApiError) || typeof error.data !== "object" || error.data === null) return null;
  const value = (error.data as Record<string, unknown>).retryAfterSeconds;
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(120, Math.ceil(seconds));
}

function rateLimitedState(
  error: unknown,
  retryAfterSeconds = DEFAULT_RATE_LIMIT_RETRY_SECONDS,
): SessionDesktopViewerState {
  const baseMessage = error instanceof ApiError ? error.message : RATE_LIMITED_MESSAGE;
  return {
    status: "rate_limited",
    message: `${baseMessage} Retrying in ${retryAfterSeconds}s.`,
    desktopName: null,
    viewOnly: true,
    retryAfterSeconds,
  };
}

function unavailableState(error: unknown): SessionDesktopViewerState {
  return {
    status: "unavailable",
    message: error ? stringifyError(error) : UNAVAILABLE_MESSAGE,
    desktopName: null,
    viewOnly: true,
    retryAfterSeconds: null,
  };
}

function closeReasonSuffix(closeReason: string | null, closeDetail: string | null): string {
  if (!closeReason) return "";
  const detailSuffix = closeDetail ? ` (${closeDetail})` : "";
  return ` Server reason: ${closeReason}${detailSuffix}.`;
}

function formatBool(value: boolean | null | undefined): string | null {
  if (value === true) return "true";
  if (value === false) return "false";
  return null;
}

function compactNumber(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toPrecision(4)).toString() : null;
}

function closeDiagnosticsSuffix(
  diagnostics: DesktopViewTicketCloseDiagnostics | null,
  closeDetail: string | null,
): string {
  if (!diagnostics) return "";
  const fields: string[] = [];
  const add = (label: string, value: string | number | boolean | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    fields.push(`${label}=${String(value)}`);
  };
  add("phase", diagnostics.phase);
  if (diagnostics.reason && diagnostics.reason !== closeDetail) add("reason", diagnostics.reason);
  add("status", diagnostics.statusCode);
  add("retryable", formatBool(diagnostics.retryable));
  add("runtime", diagnostics.runtimeState);
  add("sandbox", diagnostics.sandboxStatus);
  add("exit", diagnostics.supervisorExitCode);
  add("health", diagnostics.supervisorHealthStatus);
  add("failed", diagnostics.supervisorHealthFailedComponent);
  add("failedPhase", diagnostics.supervisorHealthFailedPhase);
  if (diagnostics.supervisorHealthLastError && diagnostics.supervisorHealthLastError !== closeDetail) {
    add("lastError", diagnostics.supervisorHealthLastError);
  }
  add("display", diagnostics.supervisorHealthDisplay);
  if (diagnostics.supervisorHealthWidth && diagnostics.supervisorHealthHeight) {
    add("size", `${diagnostics.supervisorHealthWidth}x${diagnostics.supervisorHealthHeight}`);
  }
  add("screenshot", formatBool(diagnostics.supervisorHealthScreenshotOk));
  add("nonBlack", compactNumber(diagnostics.supervisorHealthScreenshotNonBlackPixelRatio));
  add("entropy", compactNumber(diagnostics.supervisorHealthScreenshotEntropy));
  add("uniform", formatBool(diagnostics.supervisorHealthScreenshotUniform));
  add("vnc", formatBool(diagnostics.supervisorHealthVncReachable));
  add("novnc", formatBool(diagnostics.supervisorHealthNovncReachable));
  add("loopbackOnly", formatBool(diagnostics.supervisorHealthLoopbackOnly));
  add("provider", diagnostics.providerErrorCode);
  add("providerStatus", diagnostics.providerErrorStatus);
  add("providerRetryMs", diagnostics.providerErrorRetryAfterMs);
  add("providerRequestSent", formatBool(diagnostics.providerErrorRequestSent));
  add("wsSource", diagnostics.websocketCloseSource);
  add("wsCode", diagnostics.websocketCloseCode);
  add("wsReason", diagnostics.websocketCloseReason);
  add("wsClean", formatBool(diagnostics.websocketCloseWasClean));
  return fields.length > 0 ? ` Diagnostics: ${fields.join(", ")}.` : "";
}

function proxyFailureState(
  closeReason: string | null,
  closeDetail: string | null = null,
  diagnostics: DesktopViewTicketCloseDiagnostics | null = null,
): SessionDesktopViewerState {
  const reasonSuffix = closeReasonSuffix(closeReason, closeDetail);
  const diagnosticSuffix = closeDiagnosticsSuffix(diagnostics, closeDetail);
  const message =
    closeReason === "upstream_forbidden"
      ? "Desktop live view was rejected by the sandbox port proxy."
      : closeReason === "upstream_unavailable"
        ? "Desktop live view upstream stayed unavailable after repeated connection attempts."
        : closeReason === "proxy_failed"
          ? "Desktop live view proxy failed before the noVNC stream opened."
          : closeReason === "input_blocked"
            ? "Desktop live view closed because input was attempted on a view-only connection."
            : UNAVAILABLE_MESSAGE;
  return {
    status: "unavailable",
    message: `${message}${reasonSuffix}${diagnosticSuffix}`,
    desktopName: null,
    viewOnly: true,
    retryAfterSeconds: null,
  };
}

function preparingProxyState(
  closeReason: string | null,
  closeDetail: string | null = null,
  diagnostics: DesktopViewTicketCloseDiagnostics | null = null,
): SessionDesktopViewerState {
  const diagnosticSuffix = closeDiagnosticsSuffix(diagnostics, closeDetail);
  return {
    status: "preparing",
    message: closeReason
      ? `Desktop stack is still starting.${closeReasonSuffix(closeReason, closeDetail)}${diagnosticSuffix}`
      : PREPARING_MESSAGE,
    desktopName: null,
    viewOnly: true,
    retryAfterSeconds: null,
  };
}

function isTerminalProxyCloseReason(closeReason: string | null): boolean {
  return closeReason === "upstream_forbidden" || closeReason === "proxy_failed" || closeReason === "input_blocked";
}

function shouldRetryUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 503;
}

function statusState(
  status: Exclude<SessionDesktopViewerStatus, "rate_limited" | "unavailable">,
  desktopName: string | null = null,
): SessionDesktopViewerState {
  const messages: Record<typeof status, string> = {
    preparing: PREPARING_MESSAGE,
    connecting: CONNECTING_MESSAGE,
    connected: CONNECTED_MESSAGE,
    reconnecting: RECONNECTING_MESSAGE,
  };
  return {
    status,
    message: messages[status],
    desktopName,
    viewOnly: true,
    retryAfterSeconds: null,
  };
}

async function loadRfbConstructor(): Promise<RfbConstructor> {
  const module = await import("@novnc/novnc/lib/rfb.js");
  return module.default as RfbConstructor;
}

export function useSessionDesktopViewer(
  sessionId: string,
  options: { enabled?: boolean } = {},
): {
  targetRef: RefObject<HTMLDivElement>;
  state: SessionDesktopViewerState;
} {
  const enabled = options.enabled ?? true;
  const targetRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<SessionDesktopViewerState>(() => statusState("preparing"));
  const rfbRef = useRef<RfbLike | null>(null);
  const ticketRef = useRef<ActiveTicket | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstConnectAttemptAtRef = useRef(0);
  const runIdRef = useRef(0);

  useSyncEffect(() => {
    if (!enabled) {
      setState(statusState("preparing"));
      return;
    }

    let active = true;
    let connectedOnce = false;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    firstConnectAttemptAtRef.current = 0;
    const createTicketAbort = new AbortController();

    const isCurrentRun = () => active && runIdRef.current === runId;

    const clearHeartbeatTimer = () => {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const revokeTicket = (ticket: ActiveTicket | null) => {
      if (!ticket) return;
      void revokeSessionDesktopViewTicket(ticket.revokePath).catch(() => {
        // Revocation is best effort; expiry still closes stale tickets.
      });
    };

    const disconnectCurrentRfb = () => {
      const rfb = rfbRef.current;
      rfbRef.current = null;
      if (!rfb) return;
      try {
        rfb.disconnect();
      } catch {
        // A half-open noVNC instance can already be torn down.
      }
    };

    const cleanupConnection = () => {
      clearHeartbeatTimer();
      disconnectCurrentRfb();
      revokeTicket(ticketRef.current);
      ticketRef.current = null;
    };

    const scheduleReconnect = (delayMs: number, nextState: SessionDesktopViewerState) => {
      clearReconnectTimer();
      setState(nextState);
      reconnectTimerRef.current = setTimeout(() => {
        if (isCurrentRun()) void connect(true);
      }, delayMs);
    };

    const startHeartbeat = (ticket: ActiveTicket) => {
      clearHeartbeatTimer();
      heartbeatTimerRef.current = setInterval(
        () => {
          void heartbeatSessionDesktopViewTicket(ticket.heartbeatPath).catch((error) => {
            if (!isCurrentRun() || isAbortError(error)) return;
            cleanupConnection();
            if (error instanceof ApiError && error.status === 429) {
              const retryAfterSeconds = retryAfterSecondsFromError(error) ?? DEFAULT_RATE_LIMIT_RETRY_SECONDS;
              scheduleReconnect(retryAfterSeconds * 1_000, rateLimitedState(error, retryAfterSeconds));
              return;
            }
            scheduleReconnect(DESKTOP_VIEWER_RECONNECT_DELAY_MS, statusState("reconnecting"));
          });
        },
        Math.max(1_000, ticket.heartbeatIntervalMs),
      );
    };

    const readTicketCloseStatusOnce = async (ticket: ActiveTicket): Promise<TicketCloseStatus> => {
      try {
        const status = await fetchSessionDesktopViewTicketStatus(ticket.statusPath);
        const retryable =
          typeof status.closeDiagnostics?.retryable === "boolean" ? status.closeDiagnostics.retryable : null;
        return {
          reason: status.closeReason,
          detail: status.closeDetail ?? null,
          closed: status.closedAtMs !== null,
          retryable,
          diagnostics: status.closeDiagnostics ?? null,
        };
      } catch {
        return { reason: null, detail: null, closed: true, retryable: null, diagnostics: null };
      }
    };

    const readTicketCloseStatus = async (ticket: ActiveTicket | null): Promise<TicketCloseStatus> => {
      if (!ticket) return { reason: null, detail: null, closed: true, retryable: null, diagnostics: null };
      const initialStatus = await readTicketCloseStatusOnce(ticket);
      if (initialStatus.reason || initialStatus.closed) return initialStatus;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, CLOSE_STATUS_RACE_RETRY_DELAY_MS);
      });
      if (!isCurrentRun()) return initialStatus;
      return readTicketCloseStatusOnce(ticket);
    };

    const handleDisconnect = (rfb: RfbLike, clean: boolean) => {
      if (rfbRef.current !== rfb) return;
      rfbRef.current = null;
      clearHeartbeatTimer();
      const ticket = ticketRef.current;
      ticketRef.current = null;
      const wasConnected = connectedOnce;
      if (!clean) {
        revokeTicket(ticket);
        if (!isCurrentRun()) return;
        scheduleReconnect(DESKTOP_VIEWER_RECONNECT_DELAY_MS, statusState("reconnecting"));
        return;
      }
      void (async () => {
        const closeStatus = await readTicketCloseStatus(ticket);
        const closeReason = closeStatus.reason;
        const closeDetail = closeStatus.detail;
        const retryable = closeStatus.retryable;
        const diagnostics = closeStatus.diagnostics;
        revokeTicket(ticket);
        if (!isCurrentRun()) return;
        const elapsedMs = Date.now() - firstConnectAttemptAtRef.current;
        if (isTerminalProxyCloseReason(closeReason)) {
          setState(proxyFailureState(closeReason, closeDetail, diagnostics));
          return;
        }
        if (retryable === false) {
          setState(proxyFailureState(closeReason, closeDetail, diagnostics));
          return;
        }
        if (
          !wasConnected &&
          closeReason === "upstream_unavailable" &&
          elapsedMs < DESKTOP_VIEWER_UPSTREAM_UNAVAILABLE_RETRY_MS
        ) {
          scheduleReconnect(
            DESKTOP_VIEWER_STARTUP_RETRY_DELAY_MS,
            preparingProxyState(closeReason, closeDetail, diagnostics),
          );
          return;
        }
        if (!wasConnected && closeReason) {
          setState(proxyFailureState(closeReason, closeDetail, diagnostics));
          return;
        }
        scheduleReconnect(DESKTOP_VIEWER_RECONNECT_DELAY_MS, statusState("preparing"));
      })();
    };

    async function connect(reconnecting: boolean) {
      const target = targetRef.current;
      if (!target) {
        setState(unavailableState(new Error("Desktop viewer target is unavailable")));
        return;
      }

      cleanupConnection();
      if (firstConnectAttemptAtRef.current === 0) firstConnectAttemptAtRef.current = Date.now();
      setState(statusState(reconnecting ? "reconnecting" : "preparing"));

      let response: CreateDesktopViewTicketResponse;
      try {
        response = await createSessionDesktopViewTicket(sessionId, createTicketAbort.signal);
      } catch (error) {
        if (!isCurrentRun() || isAbortError(error)) return;
        if (error instanceof ApiError && error.status === 429) {
          const retryAfterSeconds = desktopRetryAfterSeconds(error, DEFAULT_RATE_LIMIT_RETRY_SECONDS);
          scheduleReconnect(retryAfterSeconds * 1_000, rateLimitedState(error, retryAfterSeconds));
          return;
        }
        const retryable = desktopErrorRetryable(error);
        if (retryable === false) {
          setState(unavailableState(error));
          return;
        }
        if (retryable === true) {
          scheduleReconnect(DEFAULT_UNAVAILABLE_RETRY_SECONDS * 1_000, statusState("preparing"));
          return;
        }
        if (shouldRetryUnavailable(error)) {
          scheduleReconnect(DEFAULT_UNAVAILABLE_RETRY_SECONDS * 1_000, statusState("preparing"));
          return;
        }
        setState(unavailableState(error));
        return;
      }

      if (!isCurrentRun()) {
        revokeTicket(response.ticket);
        return;
      }

      ticketRef.current = response.ticket;
      setState(statusState(reconnecting ? "reconnecting" : "connecting"));
      startHeartbeat(response.ticket);

      try {
        const RFB = await loadRfbConstructor();
        if (!isCurrentRun() || ticketRef.current !== response.ticket) {
          revokeTicket(response.ticket);
          return;
        }
        target.replaceChildren();
        const rfb = new RFB(target, getSessionDesktopViewerWsUrl(response.ticket.websocketPath), { shared: true });
        rfb.viewOnly = true;
        rfb.focusOnClick = false;
        rfb.clipViewport = false;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfbRef.current = rfb;

        rfb.addEventListener("connect", () => {
          if (rfbRef.current !== rfb || !isCurrentRun()) return;
          connectedOnce = true;
          setState((current) => statusState("connected", current.desktopName));
        });
        rfb.addEventListener("disconnect", (event) => {
          handleDisconnect(rfb, event.detail.clean === true);
        });
        rfb.addEventListener("securityfailure", () => {
          if (rfbRef.current !== rfb || !isCurrentRun()) return;
          cleanupConnection();
          setState(unavailableState(new Error("Desktop live view security negotiation failed")));
        });
        rfb.addEventListener("credentialsrequired", () => {
          if (rfbRef.current !== rfb || !isCurrentRun()) return;
          cleanupConnection();
          setState(unavailableState(new Error("Desktop live view requires unsupported credentials")));
        });
        rfb.addEventListener("desktopname", (event) => {
          if (rfbRef.current !== rfb || !isCurrentRun()) return;
          const desktopName = typeof event.detail.name === "string" && event.detail.name ? event.detail.name : null;
          setState((current) => ({ ...current, desktopName }));
        });
      } catch (error) {
        if (!isCurrentRun()) return;
        cleanupConnection();
        setState(unavailableState(error));
      }
    }

    void connect(false);

    return () => {
      active = false;
      createTicketAbort.abort();
      clearReconnectTimer();
      cleanupConnection();
    };
  }, [enabled, sessionId]);

  return { targetRef, state };
}
