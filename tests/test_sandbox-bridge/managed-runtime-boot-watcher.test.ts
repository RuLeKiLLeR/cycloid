// Load harness mocks before bridge modules are evaluated.
import "./helpers/bridge-test-harness.ts";

import { existsSync, rmSync, writeFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentBridge } from "../../apps/sandbox-bridge/src/bridge.ts";
import {
  RUNTIME_BOOT_REQUEST_PATH,
  RUNTIME_READINESS_PATH,
} from "../../apps/sandbox-bridge/src/services/runtime-readiness-tracker.ts";
import { defaultConfig, setupBridgeTestLifecycle } from "./helpers/bridge-test-harness.ts";

setupBridgeTestLifecycle();

const VALID_CONTRACT = JSON.stringify({
  cwd: "/workspace/repo",
  kind: "web",
  runner: "docker",
  entry: { type: "compose", files: ["docker-compose.yml"], service: "web" },
  url: { hostPort: 3123 },
  composeEnv: { SOME_SECRET: "value" },
});

function cleanupFiles(): void {
  rmSync(RUNTIME_BOOT_REQUEST_PATH, { force: true });
  rmSync(RUNTIME_READINESS_PATH, { force: true });
}

describe("managed runtime boot request watcher", () => {
  beforeEach(() => {
    cleanupFiles();
    delete process.env.ARCANIST_PREVIEW_CONTRACT_JSON;
  });

  afterEach(() => {
    cleanupFiles();
    delete process.env.ARCANIST_PREVIEW_CONTRACT_JSON;
  });

  it("arms for QA sessions so launcher requests can boot after the planner", () => {
    process.env.ARCANIST_PREVIEW_CONTRACT_JSON = VALID_CONTRACT;
    const bridge = new AgentBridge({ ...defaultConfig(), agentRole: "verification" }) as unknown as {
      armManagedRuntimeBootWatcher(): void;
      managedRuntimeBootWatcher: unknown;
      stopManagedRuntimeBootWatcher(): void;
    };
    bridge.armManagedRuntimeBootWatcher();
    expect(bridge.managedRuntimeBootWatcher).not.toBeNull();
    bridge.stopManagedRuntimeBootWatcher();
  });

  it("does not arm for read-only code review sessions", () => {
    process.env.ARCANIST_PREVIEW_CONTRACT_JSON = VALID_CONTRACT;
    const bridge = new AgentBridge({ ...defaultConfig(), agentRole: "review" }) as unknown as {
      armManagedRuntimeBootWatcher(): void;
      managedRuntimeBootWatcher: unknown;
    };
    bridge.armManagedRuntimeBootWatcher();
    expect(bridge.managedRuntimeBootWatcher).toBeNull();
  });

  it("does not arm for legacy verification-role reviewer startup config", () => {
    process.env.ARCANIST_PREVIEW_CONTRACT_JSON = VALID_CONTRACT;
    const bridge = new AgentBridge({
      ...defaultConfig(),
      agentRole: "verification",
      agentProfile: "review",
    }) as unknown as {
      armManagedRuntimeBootWatcher(): void;
      managedRuntimeBootWatcher: unknown;
    };
    bridge.armManagedRuntimeBootWatcher();
    expect(bridge.managedRuntimeBootWatcher).toBeNull();
  });

  it("does not arm without a valid preview contract", () => {
    const bridge = new AgentBridge({ ...defaultConfig(), agentRole: "implementation" }) as unknown as {
      armManagedRuntimeBootWatcher(): void;
      managedRuntimeBootWatcher: unknown;
    };
    bridge.armManagedRuntimeBootWatcher();
    expect(bridge.managedRuntimeBootWatcher).toBeNull();
  });

  it("arms once for implementation sessions with a valid contract and stops cleanly", () => {
    process.env.ARCANIST_PREVIEW_CONTRACT_JSON = VALID_CONTRACT;
    const bridge = new AgentBridge({ ...defaultConfig(), agentRole: "implementation" }) as unknown as {
      armManagedRuntimeBootWatcher(): void;
      stopManagedRuntimeBootWatcher(): void;
      managedRuntimeBootWatcher: unknown;
    };
    bridge.armManagedRuntimeBootWatcher();
    const timer = bridge.managedRuntimeBootWatcher;
    expect(timer).not.toBeNull();
    bridge.armManagedRuntimeBootWatcher();
    expect(bridge.managedRuntimeBootWatcher).toBe(timer);
    bridge.stopManagedRuntimeBootWatcher();
    expect(bridge.managedRuntimeBootWatcher).toBeNull();
  });

  it("consumes a request and starts the credentialed boot exactly once", () => {
    process.env.ARCANIST_PREVIEW_CONTRACT_JSON = VALID_CONTRACT;
    const bridge = new AgentBridge({ ...defaultConfig(), agentRole: "implementation" }) as unknown as {
      serviceManagedRuntimeBootRequest(): void;
      prepareVerificationRuntimeBeforePrompt: unknown;
      runtimeReadiness: { markStarting(startedAt: number, deadline: number): void; clear(): void };
    };
    const boot = vi.fn();
    bridge.prepareVerificationRuntimeBeforePrompt = boot;

    // No request file: nothing happens.
    bridge.serviceManagedRuntimeBootRequest();
    expect(boot).not.toHaveBeenCalled();

    // Request with no boot in flight: consumed + boot fired.
    writeFileSync(RUNTIME_BOOT_REQUEST_PATH, JSON.stringify({ requestedAt: 1 }), "utf-8");
    bridge.serviceManagedRuntimeBootRequest();
    expect(boot).toHaveBeenCalledTimes(1);
    expect(existsSync(RUNTIME_BOOT_REQUEST_PATH)).toBe(false);

    // Duplicate request while a boot is starting: consumed, no second boot
    // (the wrapper joins the in-flight boot via readiness state on its own).
    bridge.runtimeReadiness.markStarting(Date.now(), Date.now() + 60_000);
    writeFileSync(RUNTIME_BOOT_REQUEST_PATH, JSON.stringify({ requestedAt: 2 }), "utf-8");
    bridge.serviceManagedRuntimeBootRequest();
    expect(boot).toHaveBeenCalledTimes(1);
    expect(existsSync(RUNTIME_BOOT_REQUEST_PATH)).toBe(false);

    // Request while "ready" re-boots: the wrapper only requests when the ready
    // stack is not attachable (post-stop or crashed app), so ready is stale.
    bridge.runtimeReadiness.markReady();
    writeFileSync(RUNTIME_BOOT_REQUEST_PATH, JSON.stringify({ requestedAt: 3 }), "utf-8");
    bridge.serviceManagedRuntimeBootRequest();
    expect(boot).toHaveBeenCalledTimes(2);
    bridge.runtimeReadiness.clear();
  });

  it("keeps the request path in sync with the cycloid-app wrapper", () => {
    expect(RUNTIME_BOOT_REQUEST_PATH).toBe("/tmp/cycloid-runtime-boot-request.json");
  });
});
