import { describe, expect, it } from "vitest";

import { loadSandboxBridgeRuntimeConfig } from "../../apps/sandbox-bridge/src/config/runtime";

describe("sandbox bridge runtime config", () => {
  it("keeps Codex stdio forwarding defaults high enough for diagnostic output", () => {
    const config = loadSandboxBridgeRuntimeConfig({}, { logger: { warn: () => {} } });
    expect(config.codex.stdioLineMaxBytes).toBe(32 * 1024);
    expect(config.codex.stdioSessionMaxBytes).toBe(2_000_000);
  });

  it("parses the verification phase timeout override", () => {
    const config = loadSandboxBridgeRuntimeConfig(
      {
        ARCANIST_BRIDGE_RUNTIME_CONFIG: JSON.stringify({
          verificationPhase: { timeoutMs: 123_000 },
        }),
      },
      { logger: { warn: () => {} } },
    );
    expect(config.verificationPhase.timeoutMs).toBe(123_000);
  });

  it("ignores unknown verification phase keys without clobbering sibling overrides", () => {
    const warnings: unknown[] = [];
    const config = loadSandboxBridgeRuntimeConfig(
      {
        ARCANIST_BRIDGE_RUNTIME_CONFIG: JSON.stringify({
          verificationPhase: { timeoutMs: 123_000, timeoutMS: 456_000 },
          promptLoop: { typecheckTimeoutMs: 90_000 },
        }),
      },
      { logger: { warn: (...args: unknown[]) => warnings.push(args) } },
    );
    expect(warnings).toEqual([]);
    expect(config.verificationPhase.timeoutMs).toBe(123_000);
    expect(config).not.toHaveProperty("verificationPhase.timeoutMS");
    expect(config.promptLoop.typecheckTimeoutMs).toBe(90_000);
  });

  it("parses the optional per-backend claudeCodePromptStartTimeoutMs", () => {
    const config = loadSandboxBridgeRuntimeConfig(
      {
        ARCANIST_BRIDGE_RUNTIME_CONFIG: JSON.stringify({
          promptLoop: { claudeCodePromptStartTimeoutMs: 75_000, typecheckTimeoutMs: 90_000 },
        }),
      },
      { logger: { warn: () => {} } },
    );
    expect(config.promptLoop.claudeCodePromptStartTimeoutMs).toBe(75_000);
  });

  it("falls back to the default claudeCodePromptStartTimeoutMs when the payload omits it", () => {
    const warnings: unknown[] = [];
    const config = loadSandboxBridgeRuntimeConfig(
      {
        ARCANIST_BRIDGE_RUNTIME_CONFIG: JSON.stringify({ promptLoop: { typecheckTimeoutMs: 90_000 } }),
      },
      { logger: { warn: (...a: unknown[]) => warnings.push(a) } },
    );
    expect(warnings).toEqual([]);
    expect(config.promptLoop.typecheckTimeoutMs).toBe(90_000);
    expect(config.promptLoop.claudeCodePromptStartTimeoutMs).toBe(60_000);
  });

  it("parses the post-removal promptLoop/postExecution shape without warnings", () => {
    const warnings: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(args) };

    const config = loadSandboxBridgeRuntimeConfig(
      {
        ARCANIST_BRIDGE_RUNTIME_CONFIG: JSON.stringify({
          promptLoop: { typecheckTimeoutMs: 90_000, eventBufferMax: 500 },
          postExecution: { previewStartTimeoutMs: 123_000 },
        }),
      },
      { logger },
    );

    expect(warnings).toEqual([]);
    expect(config.promptLoop.typecheckTimeoutMs).toBe(90_000);
    expect(config.promptLoop.eventBufferMax).toBe(500);
    expect(config.postExecution.previewStartTimeoutMs).toBe(123_000);
  });

  // Each payload pairs an otherwise-valid section override with one removed
  // legacy key, so the rejection is attributable to the legacy key alone (not a
  // missing required field). The valid overrides — typecheckTimeoutMs: 90_000
  // and previewStartTimeoutMs: 123_000 — must NOT survive: the whole config
  // falls back to defaults because strict parse rejects the unknown legacy key.
  it.each([
    [
      "promptLoop.llmResponseWaitingIntervalMs",
      { promptLoop: { typecheckTimeoutMs: 90_000, eventBufferMax: 500, llmResponseWaitingIntervalMs: 30_000 } },
    ],
    [
      "promptLoop.applyPatchAbortThreshold",
      { promptLoop: { typecheckTimeoutMs: 90_000, eventBufferMax: 500, applyPatchAbortThreshold: 3 } },
    ],
    [
      "promptLoop.followUpStartTimeoutMs",
      { promptLoop: { typecheckTimeoutMs: 90_000, eventBufferMax: 500, followUpStartTimeoutMs: 45_000 } },
    ],
    [
      "promptLoop.repetitionThreshold",
      { promptLoop: { typecheckTimeoutMs: 90_000, eventBufferMax: 500, repetitionThreshold: 5 } },
    ],
    [
      "postExecution.evidenceClassifierTimeoutMs",
      { postExecution: { previewStartTimeoutMs: 123_000, evidenceClassifierTimeoutMs: 5_000 } },
    ],
    [
      "postExecution.automatedBeforeAfterScreenshotsEnabled",
      { postExecution: { previewStartTimeoutMs: 123_000, automatedBeforeAfterScreenshotsEnabled: true } },
    ],
  ])("rejects the removed legacy key %s and falls back to defaults", (_label, payload) => {
    const warnings: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(args) };

    const config = loadSandboxBridgeRuntimeConfig(
      { ARCANIST_BRIDGE_RUNTIME_CONFIG: JSON.stringify(payload) },
      { logger },
    );

    // Strict parse rejects the unknown key, so the whole config falls back to
    // defaults (the valid overrides above are discarded) and a warning is logged.
    expect(warnings.length).toBeGreaterThan(0);
    expect(config.promptLoop.typecheckTimeoutMs).toBe(5 * 60_000);
    expect(config.promptLoop.eventBufferMax).toBe(1_000);
    expect(config.postExecution.previewStartTimeoutMs).toBe(240_000);
  });

  it("accepts and strips the legacy top-level outbox key without clobbering siblings", () => {
    const warnings: unknown[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(args) };

    const config = loadSandboxBridgeRuntimeConfig(
      {
        ARCANIST_BRIDGE_RUNTIME_CONFIG: JSON.stringify({
          outbox: { maxEntries: 500, maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
          websocket: { heartbeatIntervalMs: 45_000 },
        }),
      },
      { logger },
    );

    expect(warnings).toEqual([]);
    expect(config).not.toHaveProperty("outbox");
    expect(config.websocket.heartbeatIntervalMs).toBe(45_000);
  });
});
