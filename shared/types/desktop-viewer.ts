export interface DesktopViewTicket {
  ticketId: string;
  expiresAtMs: number;
  hardExpiresAtMs: number;
  heartbeatIntervalMs: number;
  viewOnly: true;
}

export interface DesktopViewTicketClientPaths {
  websocketPath: string;
  heartbeatPath: string;
  revokePath: string;
  statusPath: string;
}

export interface CreateDesktopViewTicketResponse {
  ok: true;
  ticket: DesktopViewTicket & DesktopViewTicketClientPaths;
}

export interface DesktopViewTicketHeartbeatRequest {
  ticketId: string;
}

export interface DesktopViewTicketHeartbeatResponse {
  ok: true;
  ticket: DesktopViewTicket;
}

export interface DesktopViewTicketRevokeRequest {
  ticketId: string;
}

export interface DesktopViewTicketRevokeResponse {
  ok: true;
  revoked: boolean;
}

export interface DesktopViewTicketConnectRequest {
  ticketId: string;
  connectionId: string;
}

export interface DesktopViewTicketConnectResponse {
  ok: true;
  ticket: DesktopViewTicket;
  connectionId: string;
}

export interface DesktopViewTicketCloseRequest {
  ticketId: string;
  connectionId: string;
  reason: string;
  detail?: string | null;
  diagnostics?: DesktopViewTicketCloseDiagnostics | null;
}

export interface DesktopViewTicketCloseResponse {
  ok: true;
  closed: boolean;
}

export interface DesktopViewTicketStatusRequest {
  ticketId: string;
}

export interface DesktopViewTicketStatusResponse {
  ok: true;
  ticket: DesktopViewTicket;
  connectionId: string | null;
  connectedAtMs: number | null;
  closedAtMs: number | null;
  closeReason: string | null;
  closeDetail?: string | null;
  closeDiagnostics?: DesktopViewTicketCloseDiagnostics | null;
  revoked: boolean;
  expired: boolean;
}

export interface DesktopViewTicketCloseDiagnostics {
  phase?: string | null;
  reason?: string | null;
  durationMs?: number | null;
  statusCode?: number | null;
  retryable?: boolean | null;
  sandboxStatus?: string | null;
  runtimeState?: string | null;
  runtimeBackend?: string | null;
  supervisorExitCode?: number | null;
  supervisorHealthStatus?: string | null;
  supervisorHealthFailedComponent?: string | null;
  supervisorHealthFailedPhase?: string | null;
  supervisorHealthLastError?: string | null;
  supervisorHealthDisplay?: string | null;
  supervisorHealthWidth?: number | null;
  supervisorHealthHeight?: number | null;
  supervisorHealthScreenshotOk?: boolean | null;
  supervisorHealthScreenshotNonBlackPixelRatio?: number | null;
  supervisorHealthScreenshotEntropy?: number | null;
  supervisorHealthScreenshotUniform?: boolean | null;
  supervisorHealthVncReachable?: boolean | null;
  supervisorHealthNovncReachable?: boolean | null;
  supervisorHealthLoopbackOnly?: boolean | null;
  providerErrorCode?: string | null;
  providerErrorStatus?: number | null;
  providerErrorRetryAfterMs?: number | null;
  providerErrorRequestSent?: boolean | null;
  websocketCloseSource?: string | null;
  websocketCloseCode?: number | null;
  websocketCloseReason?: string | null;
  websocketCloseWasClean?: boolean | null;
  upstreamHostPresent?: boolean | null;
  trafficAccessTokenPresent?: boolean | null;
}
