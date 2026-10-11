import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import type { Logger } from "../../../apps/control-plane-worker/src/logger";
import { createSessionWsManager } from "../../../apps/control-plane-worker/src/session/ws-manager";
import type { SessionState } from "../../../apps/control-plane-worker/src/types";

/**
 * ARC-1196: `discardStaleSandboxTransport` pre-marks the discarded connection
 * generation as handled before closing the socket. These tests pin the
 * ws-manager close dispatcher's two sides of that contract: a pre-marked
 * generation is ignored entirely, while the same close without the mark
 * mutates session state (which would race the prompt admitted right after a
 * stale-transport discard).
 */

function makeSession(): SessionState {
  return {
    sessionId: "session-1",
    ownerUserId: "user-1",
    status: "active",
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    closedAt: null,
    lastEventId: null,
    title: null,
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
  } as SessionState;
}

function createCloseHost(options: { generationHandled: boolean; activePromptId: string | null }) {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
  const handledGenerations = new Set<number>(options.generationHandled ? [7] : []);
  const host = {
    state: { storage: { delete: vi.fn(async () => {}) } },
    log: logger,
    resolveSessionId: () => "session-1",
    ensureSocketCachesLoaded: vi.fn(async () => {}),
    listAcceptedWebSockets: vi.fn(() => []),
    getSocketTags: vi.fn(() => ["sandbox", "sid:sb-1", "gen:7"]),
    getSession: vi.fn(() => makeSession()),
    getSandboxReconnectState: vi.fn(() => ({
      activePromptId: options.activePromptId,
      sandboxId: "sb-1",
      intentionalPauseReason: null,
      promptLastActivityAt: null,
      disconnectStartedAt: null,
      autoCloseScheduledAt: null,
    })),
    getCachedSandboxConnectionGeneration: vi.fn(() => 7),
    hasHandledSandboxDisconnectGeneration: (generation: number) => handledGenerations.has(generation),
    markSandboxDisconnectGenerationHandled: (generation: number) => {
      handledGenerations.add(generation);
    },
    flushBufferedEventsBeforeDisconnect: vi.fn(async () => {}),
    setSandboxSocket: vi.fn(),
    putSandboxStatus: vi.fn(async () => {}),
    processSandboxDisconnectForLifecycle: vi.fn(async () => {}),
    finalizeTransportStop: vi.fn(async () => {}),
    completeIntentionalPauseClose: vi.fn(async () => {}),
    failActivePromptOnDisconnect: vi.fn(async () => {}),
    scheduleAutoCloseAfterDisconnect: vi.fn(async () => {}),
    rescheduleSessionAlarm: vi.fn(async () => {}),
    broadcast: vi.fn(),
  };
  return { host, logger };
}

describe("sandbox close suppression for discarded generations", () => {
  it("ignores a close whose generation was pre-marked handled by a stale-transport discard", async () => {
    const { host, logger } = createCloseHost({ generationHandled: true, activePromptId: "p-2" });
    const manager = createSessionWsManager(host as unknown as Parameters<typeof createSessionWsManager>[0]);

    await manager.handleWebSocketClose({} as WebSocket, 1000, "stale heartbeat at prompt dispatch", true);

    expect(host.finalizeTransportStop).not.toHaveBeenCalled();
    expect(host.failActivePromptOnDisconnect).not.toHaveBeenCalled();
    expect(host.putSandboxStatus).not.toHaveBeenCalled();
    expect(host.processSandboxDisconnectForLifecycle).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ closeDecision: "ignored_already_handled_generation" }),
      expect.any(String),
    );
  });

  it("without the mark, the same close with an active prompt mutates transport state", async () => {
    const { host } = createCloseHost({ generationHandled: false, activePromptId: "p-2" });
    const manager = createSessionWsManager(host as unknown as Parameters<typeof createSessionWsManager>[0]);

    await manager.handleWebSocketClose({} as WebSocket, 1006, "zombie connection severed", false);

    expect(host.putSandboxStatus).toHaveBeenCalledWith("session-1", "reconnecting");
    expect(host.processSandboxDisconnectForLifecycle).toHaveBeenCalledWith(
      "session-1",
      "sb-1",
      expect.objectContaining({
        connectionGeneration: 7,
        detectedAt: expect.any(Number),
      }),
    );
  });
});
