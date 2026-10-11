import WebSocket from "ws";

import { BRIDGE_PROTOCOL_VERSION, normalizeWorkerVersionId } from "../../../shared/constants/bridge-protocol.js";
import type { BridgeEvent as SandboxEvent } from "../../../shared/events/bridge.js";
import type { SandboxAckMessage, SandboxSessionMessage, SandboxSocketMessage } from "../../../shared/types/sandbox.js";
import { EVENT_BUFFER_MAX } from "./constants/bridge.js";
import { translateBridgeEventToCycloidEvent } from "./events/translate.js";
import { type BridgeLogger, phaseLogFields } from "./logger.js";
import { type DurableOutbox, type PendingOutboxEvent } from "./services/outbox.js";
import { simpleHash } from "./utils/protection.js";

export const UNEXPECTED_SANDBOX_CONNECTION_GENERATION_ERROR = "Unexpected sandbox WebSocket connection generation";

export type BridgeSocket = {
  on(event: string, handler: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
  ping(): void;
  readyState: number;
};

export type BridgeWsCloseInitiator = "remote" | "bridge_watchdog" | "bridge_auth_error" | "shutdown";

export type BridgeWsCloseSummary = {
  closeCode: number | null;
  closeReason: string | null;
  closeReasonClass: string;
  closeInitiator: BridgeWsCloseInitiator;
  promptWorkInFlight: boolean;
  activePromptId: string | null;
};

const ACK_REQUIRED_EVENT_TYPES = new Set([
  "execution_complete",
  "final_answer",
  "patch",
  "post_execution",
  "push_complete",
  "push_error",
  "question",
  "tool_call",
  "tool_result",
  "tool_update",
  "usage",
]);
// Event types whose ackId includes a payload hash so a reused message/sequence
// pair cannot collide with an earlier, different event. 'question' is hashed
// because ackSequenceByMessageId is in-memory and resets to 1 after a bridge
// restart: a second, different question on the same messageId would otherwise
// reuse `${messageId}:question:1`, the DO would dedupe it by eventId, and the
// agent would block on an answer the UI never showed. Structured transcript
// events are hashed for the same reason: a bridge restart resets in-memory
// sequence counters, while genuinely new tool/patch/step events may still be
// emitted for the same prompt. Two genuinely identical payloads on the same
// messageId still collide - that is a true replay and is correctly deduped.
const ACK_HASHED_EVENT_TYPES = new Set([
  "final_answer",
  "patch",
  "post_execution",
  "push_complete",
  "push_error",
  "question",
  "tool_call",
  "tool_result",
  "tool_update",
  "usage",
]);

export interface ControlPlaneSessionDeps {
  sessionId: string;
  sandboxId: string;
  setAuthToken: (token: string) => void;
  onEventSent: (event: SandboxEvent) => void;
  onEventBuffered?: (event: SandboxEvent) => void;
  log: BridgeLogger;
  /** Durable outbox for crash-safe redelivery. Optional so tests that don't
   * exercise durability can omit it (behaviour falls back to in-memory only). */
  outbox?: DurableOutbox;
  /** Invoked once the outbox signing key is installed on sandbox activation, so
   * the bridge can run crash recovery with a usable key. */
  onSandboxActivated?: () => void;
}

export class ControlPlaneSession {
  ws: BridgeSocket | null = null;
  eventBuffer: SandboxEvent[] = [];
  pendingAckEvents = new Map<string, SandboxEvent>();
  ackSequenceByMessageId = new Map<string, number>();
  lastInboundControlActivityAt = 0;
  lastOutboundPromptActivityAt = 0;
  sandboxSessionKey: string | null = null;
  sandboxSessionNonce = 0;
  expectedSandboxConnectionGeneration: number | null = null;
  lastAdoptedWorkerVersionId: string | null = null;
  lastSandboxSessionWasPlannedHandoff = false;
  currentReconnectAttempt = 0;
  pendingWsCloseInitiator: BridgeWsCloseInitiator | null = null;

  private readonly deps: ControlPlaneSessionDeps;

  constructor(deps: ControlPlaneSessionDeps) {
    this.deps = deps;
  }

  clearSessionState(): void {
    this.ws = null;
    this.sandboxSessionKey = null;
    this.sandboxSessionNonce = 0;
  }

  isAckMessage(message: SandboxSocketMessage): message is SandboxAckMessage {
    return message.type === "ack";
  }

  isSandboxSessionMessage(message: SandboxSocketMessage): message is SandboxSessionMessage {
    return message.type === "sandbox_session";
  }

  isAuthErrorMessage(message: SandboxSocketMessage): message is { type: "auth_error"; reason: string } {
    return message.type === "auth_error";
  }

  activateSandboxSession(message: SandboxSessionMessage, sendRuntimeInfo: () => void): void {
    this.lastSandboxSessionWasPlannedHandoff = false;
    if (this.sandboxSessionKey !== null || this.sandboxSessionNonce !== 0) {
      throw new Error("Duplicate sandbox WebSocket session frame");
    }
    if (typeof message.sessionKey !== "string" || message.sessionKey.length === 0) {
      throw new Error("Invalid sandbox WebSocket session key");
    }
    if (!Number.isSafeInteger(message.connectionGeneration) || message.connectionGeneration <= 0) {
      throw new Error("Invalid sandbox WebSocket connection generation");
    }
    if (
      this.expectedSandboxConnectionGeneration !== null &&
      message.connectionGeneration <= this.expectedSandboxConnectionGeneration
    ) {
      // Reject only stale/replayed frames (a generation we have already adopted
      // or an older one). A forward jump past expected+1 is legitimate and must
      // be re-adopted: a control-plane Worker redeploy evicts the session DO,
      // which increments + persists the connection generation on every WS
      // accept, so during a deploy storm a single bridge reconnect can be
      // accepted (and superseded) more than once before we adopt a frame. The
      // strict "=== expected + 1" check used to treat that skip as fatal and
      // stop the bridge, failing the in-flight prompt (ARC-1164).
      throw new Error(UNEXPECTED_SANDBOX_CONNECTION_GENERATION_ERROR);
    }
    if (typeof message.nextAuthToken !== "string" || message.nextAuthToken.length === 0) {
      throw new Error("Invalid sandbox WebSocket next auth token");
    }
    if (
      typeof message.bridgeProtocolVersion === "number" &&
      Number.isSafeInteger(message.bridgeProtocolVersion) &&
      message.bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION
    ) {
      this.deps.log.warn(
        {
          event: "bridge.protocol_skew",
          bridgeVersion: BRIDGE_PROTOCOL_VERSION,
          workerVersion: message.bridgeProtocolVersion,
        },
        "Bridge protocol version differs from control-plane worker version",
      );
    }

    const incomingWorkerVersionId = normalizeWorkerVersionId(message.workerVersionId);
    const plannedHandoff =
      incomingWorkerVersionId !== null &&
      this.lastAdoptedWorkerVersionId !== null &&
      incomingWorkerVersionId !== this.lastAdoptedWorkerVersionId;

    const previousAdoptedGeneration = this.expectedSandboxConnectionGeneration;
    this.sandboxSessionKey = message.sessionKey;
    this.deps.setAuthToken(message.nextAuthToken);
    process.env.SANDBOX_AUTH_TOKEN = message.nextAuthToken;
    this.expectedSandboxConnectionGeneration = message.connectionGeneration;
    if (incomingWorkerVersionId !== null) {
      this.lastSandboxSessionWasPlannedHandoff = plannedHandoff;
      if (plannedHandoff) {
        this.deps.log.info(
          {
            event: "sandbox_session.control_plane_handoff",
            previousVersionId: this.lastAdoptedWorkerVersionId,
            newVersionId: incomingWorkerVersionId,
            connectionGeneration: message.connectionGeneration,
            runtimeSandboxId: this.deps.sandboxId,
          },
          "Adopted sandbox session from a new control-plane Worker version",
        );
      }
      this.lastAdoptedWorkerVersionId = incomingWorkerVersionId;
    }
    this.sandboxSessionNonce = 0;

    // Diagnostic + metric signal: we adopted a generation that skipped past
    // expected+1, i.e. the server burned intermediate generations the bridge
    // never adopted (deploy-eviction storm). The generation integers are not
    // otherwise logged anywhere retrievable, so emit them here to make the
    // relaxed re-adoption path measurable post-deploy (ARC-1164).
    if (previousAdoptedGeneration !== null && message.connectionGeneration > previousAdoptedGeneration + 1) {
      this.deps.log.info(
        {
          event: "sandbox_session.generation_skip_adopted",
          expectedGeneration: previousAdoptedGeneration,
          receivedGeneration: message.connectionGeneration,
          skippedGenerations: message.connectionGeneration - previousAdoptedGeneration - 1,
        },
        "Re-adopted sandbox WebSocket session after a skipped connection generation",
      );
    }

    // Install the durable-outbox signing key (authenticated frame; never in the
    // agent-readable environment) and run crash recovery once, before the
    // redelivery flush below so recovered pending events are resent on connect.
    // The key arrives only here, so recovery cannot run earlier (it needs the key
    // to verify records). Optional for deploy-skew: absent key => no durability.
    if (typeof message.outboxSigningKey === "string" && message.outboxSigningKey.length > 0) {
      this.deps.outbox?.setSigningKey(message.outboxSigningKey);
    }
    this.deps.onSandboxActivated?.();

    this.sendEvent({
      type: "heartbeat",
      sandboxId: this.deps.sandboxId,
      status: "ready",
      timestamp: Date.now(),
    });
    sendRuntimeInfo();
    // Flush buffered (non-ack) events BEFORE redelivering unacked completions.
    // resendPendingAckEvents replays execution_complete events; the buffered
    // token stream logically precedes them, so flushing first lands streamed
    // text ahead of the completion that closes it and keeps the UI timeline in
    // order on reconnect.
    this.flushEventBuffer();
    this.resendPendingAckEvents();
  }

  markInboundControlActivity(timestamp = Date.now()): void {
    this.lastInboundControlActivityAt = timestamp;
  }

  markOutboundPromptActivity(timestamp = Date.now()): void {
    this.lastOutboundPromptActivityAt = timestamp;
  }

  markNextWsCloseInitiator(initiator: BridgeWsCloseInitiator): void {
    this.pendingWsCloseInitiator = initiator;
  }

  formatWsCloseReason(reason: unknown): string | null {
    if (reason === undefined || reason === null) return null;
    const text = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason);
    const trimmed = text.trim();
    if (!trimmed) return null;
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
  }

  classifyWsCloseReason(code: number | null, reason: string | null): string {
    if (reason?.includes("Superseded by newer connection")) return "superseded";
    if (code === null) return "unknown";
    if (code === 1000) return "normal";
    if (code === 1001) return "going_away";
    if (code === 1006) return "abnormal";
    if (code >= 4000) return "application";
    return "other";
  }

  handleAckMessage(message: SandboxAckMessage): void {
    this.markInboundControlActivity();
    const acked = this.pendingAckEvents.get(message.ackId);
    if (acked) {
      this.pendingAckEvents.delete(message.ackId);
      this.deps.outbox?.appendEventAcked(message.ackId, messageIdOf(acked));
      this.deps.log.debug({ ackId: message.ackId }, "Received sandbox event ACK");
    }
  }

  /**
   * Re-inject pending ACK-required events recovered from the durable outbox
   * after a process restart. Events keep their persisted `ackId` (the recovered
   * event object already carries it) so the control plane's `event_id` dedupe
   * sees the same identity. The sequence counter is seeded so any *new* event
   * emitted post-restart for the same messageId cannot collide with a reloaded
   * ackId. Must run before the first WebSocket activation so
   * `resendPendingAckEvents` flushes them on connect.
   */
  restorePendingAckEvents(entries: PendingOutboxEvent[], maxAckSequenceByMessageId: Map<string, number>): void {
    for (const [messageId, seq] of maxAckSequenceByMessageId) {
      if (seq > this.getOrZeroAckSequence(messageId)) {
        this.ackSequenceByMessageId.set(messageId, seq);
      }
    }
    for (const entry of entries) {
      if (!this.pendingAckEvents.has(entry.ackId)) {
        this.pendingAckEvents.set(entry.ackId, entry.event);
      }
    }
  }

  /**
   * Durably persist and queue a recovery-synthesized event WITHOUT sending it
   * now. Recovery runs on activation just before `resendPendingAckEvents`, which
   * flushes the whole pending set on connect, so sending here too would deliver
   * the event twice. The caller supplies a stable `ackId` so a re-synthesis
   * dedupes on the control plane. No-op for events without an ackId.
   */
  queueRecoveredEvent(event: SandboxEvent): void {
    const outbound = this.withAckId(event);
    const ackId =
      "ackId" in outbound && typeof outbound.ackId === "string" && outbound.ackId.length > 0 ? outbound.ackId : null;
    if (!ackId) return;
    this.deps.outbox?.appendEventQueued(ackId, messageIdOf(outbound), outbound);
    this.pendingAckEvents.set(ackId, outbound);
  }

  private getOrZeroAckSequence(messageId: string): number {
    return this.ackSequenceByMessageId.get(messageId) ?? 0;
  }

  nextAckSequence(messageId: string): number {
    const next = this.getOrZeroAckSequence(messageId) + 1;
    this.ackSequenceByMessageId.set(messageId, next);
    return next;
  }

  withAckId(event: SandboxEvent): SandboxEvent {
    if (!ACK_REQUIRED_EVENT_TYPES.has(event.type)) {
      return event;
    }
    if ("ackId" in event && typeof event.ackId === "string" && event.ackId.length > 0) {
      return event;
    }
    if (!("messageId" in event) || typeof event.messageId !== "string" || event.messageId.length === 0) {
      this.deps.log.warn({ eventType: event.type }, "Skipping ACK tracking for event without messageId");
      return event;
    }

    const sequence = this.nextAckSequence(event.messageId);
    let ackId = `${event.messageId}:${event.type}:${sequence}`;
    if (ACK_HASHED_EVENT_TYPES.has(event.type)) {
      ackId = `${ackId}:${simpleHash(JSON.stringify(event))}`;
    }
    return { ...event, ackId } as SandboxEvent;
  }

  serializeTransportEvent(event: SandboxEvent): string {
    if (!this.sandboxSessionKey) {
      throw new Error("Sandbox WebSocket session key is not available");
    }
    const transportEvent = translateBridgeEventToCycloidEvent(this.deps.sessionId, event);
    return JSON.stringify({
      ...event,
      ...transportEvent,
      auth: {
        sessionKey: this.sandboxSessionKey,
        nonce: ++this.sandboxSessionNonce,
      },
    });
  }

  resendPendingAckEvents(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.pendingAckEvents.size === 0) {
      return;
    }
    const pendingCompletionEvents = [...this.pendingAckEvents.values()].filter(
      (event) => event.type === "execution_complete",
    );
    if (pendingCompletionEvents.length > 0) {
      this.deps.log.warn(
        phaseLogFields("bridge.connect", {
          step: "pending_completion_redelivery",
          phase_status: "started",
          pendingAckCount: this.pendingAckEvents.size,
          pendingCompletionCount: pendingCompletionEvents.length,
          promptIds: pendingCompletionEvents.map((event) => event.messageId),
        }),
        "Redelivering unacknowledged completion events after reconnect",
      );
    }
    for (const event of this.pendingAckEvents.values()) {
      try {
        this.ws.send(this.serializeTransportEvent(event));
        this.deps.onEventSent(event);
      } catch (err) {
        this.deps.log.warn({ error: String(err), eventType: event.type }, "Failed to resend pending ACK event");
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          return;
        }
      }
    }
  }

  enqueueEventBuffer(event: SandboxEvent): void {
    if (this.eventBuffer.length >= EVENT_BUFFER_MAX) {
      // Drop the OLDEST buffered event, not the incoming one. The freshest
      // output is the most valuable to preserve; tail-dropping the newest event
      // silently lost the latest stream output. Only non-ack events reach this
      // buffer (ack-required events go through pendingAckEvents), so dropping a
      // buffered event never loses a durable completion.
      const dropped = this.eventBuffer.shift();
      this.deps.log.warn(
        {
          eventType: event.type,
          droppedEventType: dropped?.type,
          // The buffer was at capacity (EVENT_BUFFER_MAX) when the drop fired;
          // a fresh event is pushed in its place below.
          cap: EVENT_BUFFER_MAX,
          reason: "dropped_oldest",
        },
        "Event buffer full, dropping oldest event",
      );
    }
    this.eventBuffer.push(event);
    this.deps.onEventBuffered?.(event);
  }

  private restoreEventBufferFront(events: SandboxEvent[]): void {
    if (events.length === 0) return;
    this.eventBuffer = [...events, ...this.eventBuffer].slice(0, EVENT_BUFFER_MAX);
  }

  trySendTransportEvent(event: SandboxEvent, failureMessage: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(this.serializeTransportEvent(event));
      this.deps.onEventSent(event);
      return true;
    } catch (err) {
      this.deps.log.warn({ error: String(err), eventType: event.type }, failureMessage);
      return false;
    }
  }

  sendEvent(event: SandboxEvent): void {
    // `heartbeat` and passive telemetry (`sandbox_resource_sample`, emitted every 30s regardless of
    // prompt work) must NOT count as outbound prompt activity. The idle-socket watchdog only reconnects
    // a silent DO when BOTH inbound and outbound have been quiet past the liveness window; letting these
    // periodic events refresh `lastOutboundPromptActivityAt` would keep `outboundSilent` false forever and
    // disable stale-socket recovery on an otherwise-idle bridge.
    if (event.type !== "heartbeat" && event.type !== "sandbox_resource_sample") {
      this.markOutboundPromptActivity();
    }
    const outbound = this.withAckId(event);
    const ackId =
      "ackId" in outbound && typeof outbound.ackId === "string" && outbound.ackId.length > 0 ? outbound.ackId : null;
    if (ackId) {
      // Append the durable record BEFORE the in-memory set and the WS send, so a
      // crash after the WS send still recovers the event. appendEventQueued
      // self-filters to durable event types and fail-opens on fs errors, so it
      // never throws here.
      this.deps.outbox?.appendEventQueued(ackId, messageIdOf(outbound), outbound);
      this.pendingAckEvents.set(ackId, outbound);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!ackId) this.enqueueEventBuffer(outbound);
      return;
    }
    if (!this.trySendTransportEvent(outbound, "Failed to send event, buffering") && !ackId) {
      this.enqueueEventBuffer(outbound);
    }
  }

  flushEventBuffer(): void {
    if (this.eventBuffer.length === 0) return;
    this.deps.log.debug({ size: this.eventBuffer.length }, "Flushing event buffer");
    const buffer = [...this.eventBuffer];
    this.eventBuffer = [];
    for (let index = 0; index < buffer.length; index++) {
      const event = buffer[index];
      if (!this.trySendTransportEvent(event, "Failed to flush buffered event")) {
        this.restoreEventBufferFront(buffer.slice(index));
        return;
      }
    }
  }
}

/** All ACK-required (and thus durably persisted) events carry a string
 * `messageId`; fall back to "" defensively for the type guard. */
function messageIdOf(event: SandboxEvent): string {
  return "messageId" in event && typeof event.messageId === "string" ? event.messageId : "";
}
