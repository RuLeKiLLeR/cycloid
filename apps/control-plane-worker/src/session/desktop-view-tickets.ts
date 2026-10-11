import type {
  DesktopViewTicket,
  DesktopViewTicketCloseDiagnostics,
  DesktopViewTicketCloseResponse,
  DesktopViewTicketConnectResponse,
  DesktopViewTicketHeartbeatResponse,
  DesktopViewTicketRevokeResponse,
  DesktopViewTicketStatusResponse,
} from "../../../../shared/types/desktop-viewer.js";

export const DESKTOP_VIEW_TICKET_ID_RE = /^[a-f0-9]{64}$/;
export const DESKTOP_VIEW_CONNECTION_ID_RE = /^[0-9a-f-]{16,64}$/i;
export const DESKTOP_VIEW_TICKET_TTL_MS = 60_000;
export const DESKTOP_VIEW_TICKET_HARD_MAX_MS = 5 * 60_000;
export const DESKTOP_VIEW_TICKET_HEARTBEAT_INTERVAL_MS = 20_000;
export const DESKTOP_VIEW_MAX_CONNECTED_VIEWERS = 5;

const DESKTOP_VIEW_TICKET_RETAIN_MS = 60 * 60_000;
const DURABLE_OBJECT_STORAGE_MAX_KEYS_PER_OPERATION = 128;

type DesktopViewTicketRecord = {
  ticketId: string;
  sessionId: string;
  viewerUserId: string;
  createdAtMs: number;
  expiresAtMs: number;
  hardExpiresAtMs: number;
  revokedAtMs: number | null;
  lastHeartbeatAtMs: number | null;
  connectionId: string | null;
  connectedAtMs: number | null;
  closedAtMs: number | null;
  closeReason: string | null;
  closeDetail?: string | null;
  closeDiagnostics?: DesktopViewTicketCloseDiagnostics | null;
};

type TicketFailure = { ok: false; status: 400 | 403 | 404 | 409 | 410; error: string };

export type CreateDesktopViewTicketResult =
  { ok: true; status: 200; body: { ok: true; ticket: DesktopViewTicket } } | TicketFailure;
export type HeartbeatDesktopViewTicketResult =
  { ok: true; status: 200; body: DesktopViewTicketHeartbeatResponse } | TicketFailure;
export type RevokeDesktopViewTicketResult =
  { ok: true; status: 200; body: DesktopViewTicketRevokeResponse } | TicketFailure;
export type ConnectDesktopViewTicketResult =
  { ok: true; status: 200; body: DesktopViewTicketConnectResponse } | TicketFailure;
export type CloseDesktopViewTicketResult =
  { ok: true; status: 200; body: DesktopViewTicketCloseResponse } | TicketFailure;
export type StatusDesktopViewTicketResult =
  { ok: true; status: 200; body: DesktopViewTicketStatusResponse } | TicketFailure;

function indexKey(sessionId: string): string {
  return `desktop_view_ticket:${sessionId}:index`;
}

function recordKey(sessionId: string, ticketId: string): string {
  return `desktop_view_ticket:${sessionId}:record:${ticketId}`;
}

function toTicket(record: DesktopViewTicketRecord): DesktopViewTicket {
  return {
    ticketId: record.ticketId,
    expiresAtMs: record.expiresAtMs,
    hardExpiresAtMs: record.hardExpiresAtMs,
    heartbeatIntervalMs: DESKTOP_VIEW_TICKET_HEARTBEAT_INTERVAL_MS,
    viewOnly: true,
  };
}

function trimTicketIndex(
  index: string[],
  records: Map<string, DesktopViewTicketRecord>,
  nowMs: number,
): { retainedIds: string[]; deleteKeys: string[] } {
  const retainedIds: string[] = [];
  const deleteKeys: string[] = [];
  const seen = new Set<string>();
  for (const ticketId of index) {
    if (seen.has(ticketId)) continue;
    seen.add(ticketId);
    const record = records.get(ticketId);
    if (!record) continue;
    if (nowMs - record.hardExpiresAtMs > DESKTOP_VIEW_TICKET_RETAIN_MS) {
      deleteKeys.push(recordKey(record.sessionId, ticketId));
      continue;
    }
    retainedIds.push(ticketId);
  }
  return { retainedIds, deleteKeys };
}

function isExpired(record: DesktopViewTicketRecord, nowMs: number): boolean {
  return nowMs > record.expiresAtMs || nowMs > record.hardExpiresAtMs;
}

function invalidTicketFailure(ticketId: string): TicketFailure | null {
  return DESKTOP_VIEW_TICKET_ID_RE.test(ticketId) ? null : { ok: false, status: 400, error: "Invalid desktop ticket" };
}

function invalidConnectionFailure(connectionId: string): TicketFailure | null {
  return DESKTOP_VIEW_CONNECTION_ID_RE.test(connectionId)
    ? null
    : { ok: false, status: 400, error: "Invalid desktop viewer connection" };
}

function validateTicketForViewer(
  record: DesktopViewTicketRecord | undefined,
  viewerUserId: string,
  nowMs: number,
): TicketFailure | null {
  if (!record) return { ok: false, status: 404, error: "Desktop viewing ticket not found" };
  if (record.viewerUserId !== viewerUserId)
    return { ok: false, status: 403, error: "Desktop viewing ticket forbidden" };
  if (record.revokedAtMs !== null) return { ok: false, status: 410, error: "Desktop viewing ticket revoked" };
  if (isExpired(record, nowMs)) return { ok: false, status: 410, error: "Desktop viewing ticket expired" };
  return null;
}

function activeConnectedViewerCount(records: Iterable<DesktopViewTicketRecord>, nowMs: number): number {
  let count = 0;
  for (const record of records) {
    if (
      record.connectedAtMs !== null &&
      record.closedAtMs === null &&
      record.revokedAtMs === null &&
      !isExpired(record, nowMs)
    ) {
      count += 1;
    }
  }
  return count;
}

function storageKeyChunks(keys: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < keys.length; index += DURABLE_OBJECT_STORAGE_MAX_KEYS_PER_OPERATION) {
    chunks.push(keys.slice(index, index + DURABLE_OBJECT_STORAGE_MAX_KEYS_PER_OPERATION));
  }
  return chunks;
}

async function getStorageRecordsInChunks<T>(txn: DurableObjectTransaction, keys: string[]): Promise<Map<string, T>> {
  const records = new Map<string, T>();
  for (const chunk of storageKeyChunks(keys)) {
    const stored = await txn.get<T>(chunk);
    for (const [key, record] of stored) {
      records.set(key, record);
    }
  }
  return records;
}

async function deleteStorageKeysInChunks(txn: DurableObjectTransaction, keys: string[]): Promise<void> {
  for (const chunk of storageKeyChunks(keys)) {
    await txn.delete(chunk);
  }
}

async function loadIndexedRecords(
  txn: DurableObjectTransaction,
  sessionId: string,
): Promise<{ index: string[]; records: Map<string, DesktopViewTicketRecord> }> {
  const index = (await txn.get<string[]>(indexKey(sessionId))) ?? [];
  const stored = await getStorageRecordsInChunks<DesktopViewTicketRecord>(
    txn,
    index.map((ticketId) => recordKey(sessionId, ticketId)),
  );
  const records = new Map<string, DesktopViewTicketRecord>();
  for (const ticketId of index) {
    const record = stored.get(recordKey(sessionId, ticketId));
    if (record) records.set(ticketId, record);
  }
  return { index, records };
}

export async function createDesktopViewTicket(
  storage: DurableObjectStorage,
  params: { sessionId: string; viewerUserId: string; nowMs: number; generateRandomHex: (bytes: number) => string },
): Promise<CreateDesktopViewTicketResult> {
  const ticketId = params.generateRandomHex(32);
  if (!DESKTOP_VIEW_TICKET_ID_RE.test(ticketId)) return { ok: false, status: 400, error: "Invalid desktop ticket" };
  const record: DesktopViewTicketRecord = {
    ticketId,
    sessionId: params.sessionId,
    viewerUserId: params.viewerUserId,
    createdAtMs: params.nowMs,
    expiresAtMs: params.nowMs + DESKTOP_VIEW_TICKET_TTL_MS,
    hardExpiresAtMs: params.nowMs + DESKTOP_VIEW_TICKET_HARD_MAX_MS,
    revokedAtMs: null,
    lastHeartbeatAtMs: null,
    connectionId: null,
    connectedAtMs: null,
    closedAtMs: null,
    closeReason: null,
    closeDetail: null,
    closeDiagnostics: null,
  };

  await storage.transaction(async (txn) => {
    const loaded = await loadIndexedRecords(txn, params.sessionId);
    const trimmed = trimTicketIndex(loaded.index, loaded.records, params.nowMs);
    await txn.put({
      [indexKey(params.sessionId)]: [...trimmed.retainedIds, ticketId],
      [recordKey(params.sessionId, ticketId)]: record,
    });
    if (trimmed.deleteKeys.length > 0) {
      await deleteStorageKeysInChunks(txn, trimmed.deleteKeys);
    }
  });

  return { ok: true, status: 200, body: { ok: true, ticket: toTicket(record) } };
}

export async function heartbeatDesktopViewTicket(
  storage: DurableObjectStorage,
  params: { sessionId: string; viewerUserId: string; ticketId: string; nowMs: number },
): Promise<HeartbeatDesktopViewTicketResult> {
  const invalid = invalidTicketFailure(params.ticketId);
  if (invalid) return invalid;

  return storage.transaction(async (txn) => {
    const key = recordKey(params.sessionId, params.ticketId);
    const record = await txn.get<DesktopViewTicketRecord>(key);
    const failure = validateTicketForViewer(record, params.viewerUserId, params.nowMs);
    if (failure) return failure;
    if (!record) return { ok: false, status: 404, error: "Desktop viewing ticket not found" };

    const updated: DesktopViewTicketRecord = {
      ...record,
      lastHeartbeatAtMs: params.nowMs,
      expiresAtMs: Math.min(params.nowMs + DESKTOP_VIEW_TICKET_TTL_MS, record.hardExpiresAtMs),
    };
    await txn.put(key, updated);
    return { ok: true, status: 200, body: { ok: true, ticket: toTicket(updated) } };
  });
}

export async function revokeDesktopViewTicket(
  storage: DurableObjectStorage,
  params: { sessionId: string; viewerUserId: string; ticketId: string; nowMs: number },
): Promise<RevokeDesktopViewTicketResult> {
  const invalid = invalidTicketFailure(params.ticketId);
  if (invalid) return invalid;

  return storage.transaction(async (txn) => {
    const key = recordKey(params.sessionId, params.ticketId);
    const record = await txn.get<DesktopViewTicketRecord>(key);
    if (!record) return { ok: false, status: 404, error: "Desktop viewing ticket not found" };
    if (record.viewerUserId !== params.viewerUserId) {
      return { ok: false, status: 403, error: "Desktop viewing ticket forbidden" };
    }
    if (record.revokedAtMs !== null) return { ok: true, status: 200, body: { ok: true, revoked: false } };

    await txn.put(key, { ...record, revokedAtMs: params.nowMs, closedAtMs: record.closedAtMs ?? params.nowMs });
    return { ok: true, status: 200, body: { ok: true, revoked: true } };
  });
}

export async function connectDesktopViewTicket(
  storage: DurableObjectStorage,
  params: { sessionId: string; viewerUserId: string; ticketId: string; connectionId: string; nowMs: number },
): Promise<ConnectDesktopViewTicketResult> {
  const invalidTicket = invalidTicketFailure(params.ticketId);
  if (invalidTicket) return invalidTicket;
  const invalidConnection = invalidConnectionFailure(params.connectionId);
  if (invalidConnection) return invalidConnection;

  return storage.transaction(async (txn) => {
    const { index, records } = await loadIndexedRecords(txn, params.sessionId);
    const record = records.get(params.ticketId);
    const failure = validateTicketForViewer(record, params.viewerUserId, params.nowMs);
    if (failure) return failure;
    if (!record) return { ok: false, status: 404, error: "Desktop viewing ticket not found" };
    if (record.connectedAtMs !== null) {
      return { ok: false, status: 409, error: "Desktop viewing ticket already connected" };
    }

    if (activeConnectedViewerCount(records.values(), params.nowMs) >= DESKTOP_VIEW_MAX_CONNECTED_VIEWERS) {
      return { ok: false, status: 409, error: "Too many desktop viewers for this session" };
    }

    const updated: DesktopViewTicketRecord = {
      ...record,
      connectionId: params.connectionId,
      connectedAtMs: params.nowMs,
      closedAtMs: null,
      closeReason: null,
      closeDetail: null,
      closeDiagnostics: null,
    };
    await txn.put({
      [indexKey(params.sessionId)]: index,
      [recordKey(params.sessionId, params.ticketId)]: updated,
    });
    return {
      ok: true,
      status: 200,
      body: { ok: true, ticket: toTicket(updated), connectionId: params.connectionId },
    };
  });
}

export async function closeDesktopViewTicket(
  storage: DurableObjectStorage,
  params: {
    sessionId: string;
    viewerUserId: string;
    ticketId: string;
    connectionId: string;
    reason: string;
    detail?: string | null;
    diagnostics?: DesktopViewTicketCloseDiagnostics | null;
    nowMs: number;
  },
): Promise<CloseDesktopViewTicketResult> {
  const invalidTicket = invalidTicketFailure(params.ticketId);
  if (invalidTicket) return invalidTicket;
  const invalidConnection = invalidConnectionFailure(params.connectionId);
  if (invalidConnection) return invalidConnection;

  return storage.transaction(async (txn) => {
    const key = recordKey(params.sessionId, params.ticketId);
    const record = await txn.get<DesktopViewTicketRecord>(key);
    if (!record) return { ok: false, status: 404, error: "Desktop viewing ticket not found" };
    if (record.viewerUserId !== params.viewerUserId) {
      return { ok: false, status: 403, error: "Desktop viewing ticket forbidden" };
    }
    if (record.connectionId !== params.connectionId) {
      return { ok: false, status: 409, error: "Desktop viewer connection mismatch" };
    }
    if (record.closedAtMs !== null) return { ok: true, status: 200, body: { ok: true, closed: false } };

    await txn.put(key, {
      ...record,
      closedAtMs: params.nowMs,
      closeReason: params.reason.slice(0, 128),
      closeDetail: typeof params.detail === "string" && params.detail.length > 0 ? params.detail.slice(0, 256) : null,
      closeDiagnostics: normalizeCloseDiagnostics(params.diagnostics),
    });
    return { ok: true, status: 200, body: { ok: true, closed: true } };
  });
}

export async function getDesktopViewTicketStatus(
  storage: DurableObjectStorage,
  params: { sessionId: string; viewerUserId: string; ticketId: string; nowMs: number },
): Promise<StatusDesktopViewTicketResult> {
  const invalid = invalidTicketFailure(params.ticketId);
  if (invalid) return invalid;

  const record = await storage.get<DesktopViewTicketRecord>(recordKey(params.sessionId, params.ticketId));
  if (!record) return { ok: false, status: 404, error: "Desktop viewing ticket not found" };
  if (record.viewerUserId !== params.viewerUserId) {
    return { ok: false, status: 403, error: "Desktop viewing ticket forbidden" };
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      ticket: toTicket(record),
      connectionId: record.connectionId,
      connectedAtMs: record.connectedAtMs,
      closedAtMs: record.closedAtMs,
      closeReason: record.closeReason,
      closeDetail: record.closeDetail ?? null,
      closeDiagnostics: record.closeDiagnostics ?? null,
      revoked: record.revokedAtMs !== null,
      expired: isExpired(record, params.nowMs),
    },
  };
}

function normalizeCloseDiagnostics(
  diagnostics: DesktopViewTicketCloseDiagnostics | null | undefined,
): DesktopViewTicketCloseDiagnostics | null {
  if (!diagnostics || typeof diagnostics !== "object") return null;
  return {
    phase: stringOrNull(diagnostics.phase),
    reason: stringOrNull(diagnostics.reason),
    durationMs: typeof diagnostics.durationMs === "number" ? diagnostics.durationMs : null,
    statusCode: typeof diagnostics.statusCode === "number" ? diagnostics.statusCode : null,
    retryable: typeof diagnostics.retryable === "boolean" ? diagnostics.retryable : null,
    sandboxStatus: stringOrNull(diagnostics.sandboxStatus),
    runtimeState: stringOrNull(diagnostics.runtimeState),
    runtimeBackend: stringOrNull(diagnostics.runtimeBackend),
    supervisorExitCode: typeof diagnostics.supervisorExitCode === "number" ? diagnostics.supervisorExitCode : null,
    supervisorHealthStatus: stringOrNull(diagnostics.supervisorHealthStatus),
    supervisorHealthFailedComponent: stringOrNull(diagnostics.supervisorHealthFailedComponent),
    supervisorHealthFailedPhase: stringOrNull(diagnostics.supervisorHealthFailedPhase),
    supervisorHealthLastError: stringOrNull(diagnostics.supervisorHealthLastError),
    supervisorHealthDisplay: stringOrNull(diagnostics.supervisorHealthDisplay),
    supervisorHealthWidth:
      typeof diagnostics.supervisorHealthWidth === "number" ? diagnostics.supervisorHealthWidth : null,
    supervisorHealthHeight:
      typeof diagnostics.supervisorHealthHeight === "number" ? diagnostics.supervisorHealthHeight : null,
    supervisorHealthScreenshotOk:
      typeof diagnostics.supervisorHealthScreenshotOk === "boolean" ? diagnostics.supervisorHealthScreenshotOk : null,
    supervisorHealthScreenshotNonBlackPixelRatio:
      typeof diagnostics.supervisorHealthScreenshotNonBlackPixelRatio === "number"
        ? diagnostics.supervisorHealthScreenshotNonBlackPixelRatio
        : null,
    supervisorHealthScreenshotEntropy:
      typeof diagnostics.supervisorHealthScreenshotEntropy === "number"
        ? diagnostics.supervisorHealthScreenshotEntropy
        : null,
    supervisorHealthScreenshotUniform:
      typeof diagnostics.supervisorHealthScreenshotUniform === "boolean"
        ? diagnostics.supervisorHealthScreenshotUniform
        : null,
    supervisorHealthVncReachable:
      typeof diagnostics.supervisorHealthVncReachable === "boolean" ? diagnostics.supervisorHealthVncReachable : null,
    supervisorHealthNovncReachable:
      typeof diagnostics.supervisorHealthNovncReachable === "boolean"
        ? diagnostics.supervisorHealthNovncReachable
        : null,
    supervisorHealthLoopbackOnly:
      typeof diagnostics.supervisorHealthLoopbackOnly === "boolean" ? diagnostics.supervisorHealthLoopbackOnly : null,
    providerErrorCode: stringOrNull(diagnostics.providerErrorCode),
    providerErrorStatus: typeof diagnostics.providerErrorStatus === "number" ? diagnostics.providerErrorStatus : null,
    providerErrorRetryAfterMs:
      typeof diagnostics.providerErrorRetryAfterMs === "number" ? diagnostics.providerErrorRetryAfterMs : null,
    providerErrorRequestSent:
      typeof diagnostics.providerErrorRequestSent === "boolean" ? diagnostics.providerErrorRequestSent : null,
    websocketCloseSource: stringOrNull(diagnostics.websocketCloseSource),
    websocketCloseCode: typeof diagnostics.websocketCloseCode === "number" ? diagnostics.websocketCloseCode : null,
    websocketCloseReason: stringOrNull(diagnostics.websocketCloseReason),
    websocketCloseWasClean:
      typeof diagnostics.websocketCloseWasClean === "boolean" ? diagnostics.websocketCloseWasClean : null,
    upstreamHostPresent: typeof diagnostics.upstreamHostPresent === "boolean" ? diagnostics.upstreamHostPresent : null,
    trafficAccessTokenPresent:
      typeof diagnostics.trafficAccessTokenPresent === "boolean" ? diagnostics.trafficAccessTokenPresent : null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 256) : null;
}
