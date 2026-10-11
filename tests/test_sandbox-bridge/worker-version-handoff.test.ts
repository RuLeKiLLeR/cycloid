import { describe, expect, it, vi } from "vitest";

import { ControlPlaneSession } from "../../apps/sandbox-bridge/src/control-plane-session.ts";
import { createBridgeLogger, LOG_ORDINALS } from "../../apps/sandbox-bridge/src/logger.ts";
import { isWorkerVersionHandoff, normalizeWorkerVersionId } from "../../shared/constants/bridge-protocol.ts";

const log = createBridgeLogger(LOG_ORDINALS.error, {});

function makeSession() {
  return new ControlPlaneSession({
    sessionId: "session-1",
    sandboxId: "runtime-1",
    setAuthToken: vi.fn(),
    onEventSent: vi.fn(),
    log,
  });
}

const frame = (generation: number, workerVersionId?: unknown) => ({
  type: "sandbox_session" as const,
  sessionKey: `key-${generation}`,
  connectionGeneration: generation,
  nextAuthToken: `token-${generation}`,
  ...(workerVersionId === undefined ? {} : { workerVersionId }),
});

describe("Worker version handoff identity", () => {
  it("bounds and normalizes opaque version ids", () => {
    expect(normalizeWorkerVersionId("version_a-1")).toBe("version_a-1");
    expect(normalizeWorkerVersionId("a".repeat(129))).toBeNull();
    expect(normalizeWorkerVersionId("version with spaces")).toBeNull();
    expect(normalizeWorkerVersionId(42)).toBeNull();
  });

  it("requires same runtime identity, a fresh generation, and opaque version inequality", () => {
    const base = {
      currentVersionId: "rollback-id",
      persistedVersionId: "new-id",
      currentRuntimeSandboxId: "runtime-1",
      persistedRuntimeSandboxId: "runtime-1",
      currentConnectionGeneration: 9,
      persistedConnectionGeneration: 3,
    };
    expect(isWorkerVersionHandoff(base)).toBe(true);
    expect(isWorkerVersionHandoff({ ...base, currentRuntimeSandboxId: "runtime-2" })).toBe(false);
    expect(isWorkerVersionHandoff({ ...base, currentConnectionGeneration: 3 })).toBe(false);
    expect(isWorkerVersionHandoff({ ...base, currentVersionId: "new-id" })).toBe(false);
  });

  it("classifies version changes after stale-generation checks and tolerates skips", () => {
    const session = makeSession();
    session.activateSandboxSession(frame(1, "version-a"), vi.fn());
    expect(session.lastSandboxSessionWasPlannedHandoff).toBe(false);
    session.clearSessionState();
    session.activateSandboxSession(frame(7, "version-b"), vi.fn());
    expect(session.lastSandboxSessionWasPlannedHandoff).toBe(true);
    expect(session.lastAdoptedWorkerVersionId).toBe("version-b");

    session.clearSessionState();
    session.activateSandboxSession(frame(8, "version-a"), vi.fn());
    expect(session.lastSandboxSessionWasPlannedHandoff).toBe(true);

    session.clearSessionState();
    session.activateSandboxSession(frame(9, "invalid version"), vi.fn());
    expect(session.lastSandboxSessionWasPlannedHandoff).toBe(false);
    expect(session.lastAdoptedWorkerVersionId).toBe("version-a");
  });
});
