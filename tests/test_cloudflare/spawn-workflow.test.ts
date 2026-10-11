/// <reference types="@cloudflare/workers-types" />
/**
 * Tests for the resumable cold-spawn workflow helpers (ARC-1042):
 * key builders, replay-stable bootstrap material, and the bridge-start
 * recovery state machine.
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { computeSha256Hex } from "../../apps/control-plane-worker/src/crypto";
import { durableStep, hasDurableStep } from "../../apps/control-plane-worker/src/session/durable-step";
import {
  buildSpawnBootstrapMaterial,
  loadOrCreateSpawnBootstrap,
  resumableBridgeStart,
  SPAWN_PHASE,
  spawnAttemptPrefix,
  spawnAttemptStepName,
  type SpawnBootstrap,
  spawnCreateStepName,
  spawnCreateStepPrefix,
} from "../../apps/control-plane-worker/src/session/spawn-workflow";

class FakeStorage {
  readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean> {
    if (Array.isArray(keyOrKeys)) {
      for (const k of keyOrKeys) this.map.delete(k);
      return true;
    }
    return this.map.delete(keyOrKeys);
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.map) {
      if (!options.prefix || k.startsWith(options.prefix)) out.set(k, v as T);
    }
    return out;
  }
}

function storage(): { fake: FakeStorage; s: DurableObjectStorage } {
  const fake = new FakeStorage();
  return { fake, s: fake as unknown as DurableObjectStorage };
}

const SESSION = "sess-1";
const ATTEMPT = "attempt-1";
const RUNTIME = "e2b-sandbox-1";

describe("buildSpawnBootstrapMaterial", () => {
  it("uses the spawn attempt id as the sandbox id", async () => {
    const first = await buildSpawnBootstrapMaterial(ATTEMPT);
    const second = await buildSpawnBootstrapMaterial(ATTEMPT);

    expect(first.sandboxId).toBe(ATTEMPT);
    expect(second.sandboxId).toBe(ATTEMPT);
    expect(second.authToken).not.toBe(first.authToken);
    expect(first.sandboxAuthTokenHash).toBe(await computeSha256Hex(first.authToken));
    expect(second.sandboxAuthTokenHash).toBe(await computeSha256Hex(second.authToken));
  });

  it("mints an independent sandbox id without an attempt id", async () => {
    const first = await buildSpawnBootstrapMaterial();
    const second = await buildSpawnBootstrapMaterial();

    expect(first.sandboxId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second.sandboxId).not.toBe(first.sandboxId);
    expect(first.sandboxAuthTokenHash).toBe(await computeSha256Hex(first.authToken));
    expect(second.sandboxAuthTokenHash).toBe(await computeSha256Hex(second.authToken));
  });
});

describe("spawn-workflow key builders", () => {
  it("scopes every key by session + attempt", () => {
    expect(spawnAttemptPrefix(SESSION, ATTEMPT)).toBe("session_attempt:sess-1:attempt-1");
    expect(spawnAttemptStepName(SESSION, ATTEMPT, SPAWN_PHASE.bridgeStartInitiated)).toBe(
      "session_attempt:sess-1:attempt-1:bridge_start_initiated",
    );
    expect(spawnAttemptStepName(SESSION, ATTEMPT, SPAWN_PHASE.runtimeAttached)).toBe(
      "session_attempt:sess-1:attempt-1:runtime_attached",
    );
    expect(spawnCreateStepName(SESSION, ATTEMPT, 2)).toBe("session_attempt:sess-1:attempt-1:create_attempt_2");
    expect(spawnAttemptStepName(SESSION, ATTEMPT, SPAWN_PHASE.bootstrap)).toBe(
      "session_attempt:sess-1:attempt-1:bootstrap",
    );
  });

  it("create step prefix covers create retries but not other phases", () => {
    const createPrefix = spawnCreateStepPrefix(SESSION, ATTEMPT);
    expect(spawnCreateStepName(SESSION, ATTEMPT, 1).startsWith(createPrefix)).toBe(true);
    expect(spawnCreateStepName(SESSION, ATTEMPT, 9).startsWith(createPrefix)).toBe(true);
    expect(spawnAttemptStepName(SESSION, ATTEMPT, SPAWN_PHASE.runtimeAttached).startsWith(createPrefix)).toBe(false);
  });

  it("attempt prefix covers all phase steps for cleanup", () => {
    const prefix = spawnAttemptPrefix(SESSION, ATTEMPT);
    for (const phase of Object.values(SPAWN_PHASE)) {
      expect(spawnAttemptStepName(SESSION, ATTEMPT, phase).startsWith(prefix)).toBe(true);
    }
    expect(spawnCreateStepName(SESSION, ATTEMPT, 1).startsWith(prefix)).toBe(true);
  });
});

describe("loadOrCreateSpawnBootstrap (B6: replay-stable bootstrap)", () => {
  const bootstrapStep = spawnAttemptStepName(SESSION, ATTEMPT, SPAWN_PHASE.bootstrap);

  it("mints and persists on first run, then reuses the same material on replay", async () => {
    const { s } = storage();
    let mints = 0;
    const generate = async (): Promise<SpawnBootstrap> => {
      mints += 1;
      return { sandboxId: `sb-${mints}`, authToken: `tok-${mints}`, sandboxAuthTokenHash: `hash-${mints}` };
    };

    const first = await loadOrCreateSpawnBootstrap(s, bootstrapStep, generate);
    const second = await loadOrCreateSpawnBootstrap(s, bootstrapStep, generate);

    expect(mints).toBe(1);
    expect(second).toEqual(first);
    // The running bridge holds the first token; a resumed attempt must reuse it.
    expect(second.authToken).toBe("tok-1");
  });

  it("is single-flight: concurrent first-run callers share one mint (no double-mint race)", async () => {
    const { s } = storage();
    let mints = 0;
    const generate = async (): Promise<SpawnBootstrap> => {
      mints += 1;
      const n = mints;
      await Promise.resolve();
      return { sandboxId: `sb-${n}`, authToken: `tok-${n}`, sandboxAuthTokenHash: `hash-${n}` };
    };

    const [a, b] = await Promise.all([
      loadOrCreateSpawnBootstrap(s, bootstrapStep, generate),
      loadOrCreateSpawnBootstrap(s, bootstrapStep, generate),
    ]);

    expect(mints).toBe(1);
    expect(a).toEqual(b);
  });

  it("always mints and never persists when there is no attempt key", async () => {
    const { fake, s } = storage();
    let mints = 0;
    const generate = async (): Promise<SpawnBootstrap> => {
      mints += 1;
      return { sandboxId: `sb-${mints}`, authToken: `tok-${mints}`, sandboxAuthTokenHash: `hash-${mints}` };
    };

    const a = await loadOrCreateSpawnBootstrap(s, null, generate);
    const b = await loadOrCreateSpawnBootstrap(s, null, generate);

    expect(mints).toBe(2);
    expect(a.authToken).toBe("tok-1");
    expect(b.authToken).toBe("tok-2");
    expect(fake.map.size).toBe(0);
  });
});

describe("resumableBridgeStart", () => {
  let startBridge: Mock<() => Promise<unknown>>;
  let probeBridgeHealth: Mock<(sessionId: string, runtimeSandboxId: string, sinceMs: number) => Promise<boolean>>;

  beforeEach(() => {
    startBridge = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    probeBridgeHealth = vi
      .fn<(sessionId: string, runtimeSandboxId: string, sinceMs: number) => Promise<boolean>>()
      .mockResolvedValue(false);
  });

  const run = (s: DurableObjectStorage) =>
    resumableBridgeStart({
      storage: s,
      sessionId: SESSION,
      spawnAttemptId: ATTEMPT,
      runtimeSandboxId: RUNTIME,
      startBridge,
      probeBridgeHealth,
    });

  it("without an attempt id, starts the bridge directly (not resumable)", async () => {
    const { s } = storage();
    await resumableBridgeStart({
      storage: s,
      sessionId: SESSION,
      spawnAttemptId: undefined,
      runtimeSandboxId: RUNTIME,
      startBridge,
      probeBridgeHealth,
    });
    expect(startBridge).toHaveBeenCalledTimes(1);
    expect(probeBridgeHealth).not.toHaveBeenCalled();
  });

  it("first run: persists intent BEFORE starting, then starts once", async () => {
    const { s } = storage();
    const order: string[] = [];
    startBridge.mockImplementation(async () => {
      // Intent must already be durable by the time the side effect runs.
      order.push(
        `intent=${await hasDurableStep(s, spawnAttemptStepName(SESSION, ATTEMPT, SPAWN_PHASE.bridgeStartInitiated))}`,
      );
      order.push("start");
    });

    await run(s);

    expect(startBridge).toHaveBeenCalledTimes(1);
    expect(probeBridgeHealth).not.toHaveBeenCalled();
    expect(order).toEqual(["intent=true", "start"]);
    expect(await hasDurableStep(s, spawnAttemptStepName(SESSION, ATTEMPT, SPAWN_PHASE.bridgeStartInitiated))).toBe(
      true,
    );
  });

  it("crash window (intent present, bridge dead): re-issues exactly once", async () => {
    const { s } = storage();
    // Crash after the intent landed but before/within start-bridge.
    await durableSeedIntent(s);
    probeBridgeHealth.mockResolvedValue(false);

    await run(s);

    expect(probeBridgeHealth).toHaveBeenCalledWith(SESSION, RUNTIME, expect.any(Number));
    expect(startBridge).toHaveBeenCalledTimes(1);
  });

  it("crash window (intent present, bridge healthy): does NOT re-issue", async () => {
    const { s } = storage();
    await durableSeedIntent(s);
    probeBridgeHealth.mockResolvedValue(true);

    await run(s);

    expect(probeBridgeHealth).toHaveBeenCalledTimes(1);
    expect(startBridge).not.toHaveBeenCalled();
  });

  it("recovery is single-flight: a dead bridge is not re-issued twice across replays", async () => {
    const { s } = storage();
    await durableSeedIntent(s);
    probeBridgeHealth.mockResolvedValue(false);

    await run(s); // first recovery: re-issues
    await run(s); // second recovery: reissue step is cached, must not start again

    expect(startBridge).toHaveBeenCalledTimes(1);
  });
});

// Seed the intent marker the way resumableBridgeStart writes it, without the
// side effect, to model "intent landed, bridge start did not complete".
async function durableSeedIntent(s: DurableObjectStorage): Promise<void> {
  await durableStep(s, spawnAttemptStepName(SESSION, ATTEMPT, SPAWN_PHASE.bridgeStartInitiated), async () => ({
    runtimeSandboxId: RUNTIME,
  }));
}
