import { z } from "zod";

import { loadJsonEnvConfig } from "../../../../shared/utils/config.js";

const SANDBOX_BRIDGE_RUNTIME_CONFIG_ENV = "ARCANIST_BRIDGE_RUNTIME_CONFIG";

const LOG_PREFIX = "[sandbox-bridge-runtime-config]";

const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().min(0);
const fraction = z.number().finite().min(0).max(1);

const runtimeConfigSchema = z
  .object({
    websocket: z
      .object({
        heartbeatIntervalMs: positiveInteger,
        livenessThresholdMs: positiveInteger,
        watchdogIntervalMs: positiveInteger,
      })
      .strict(),
    reconnect: z
      .object({
        jitterFactor: fraction,
        warnThreshold: positiveInteger,
      })
      .strict(),
    codex: z
      .object({
        startupTimeoutMs: positiveInteger,
        stdioLineMaxBytes: positiveInteger,
        stdioSessionMaxBytes: positiveInteger,
      })
      .strict(),
    mcp: z
      .object({
        toolRegistrationRetries: nonNegativeInteger,
        toolRegistrationDelayMs: nonNegativeInteger,
        serverToolDiscoveryTimeoutMs: positiveInteger,
        dynamicRegistrationRequestTimeoutMs: positiveInteger,
        diagnosticsTimeoutMs: positiveInteger,
      })
      .strict(),
    promptLoop: z
      .object({
        promptStartTimeoutMs: positiveInteger,
        // Per-backend override of the prompt-start deadline. The default
        // (`promptStartTimeoutMs`) is codex-tuned; the claude_code backend boots
        // the Agent SDK's native binary on turn 1, so its cold first-token can
        // exceed the codex deadline. Optional so pre-existing env payloads still
        // parse; the Claude adapter supplies a fallback when absent.
        claudeCodePromptStartTimeoutMs: positiveInteger.optional(),
        promptActivityPulseIntervalMs: positiveInteger,
        // Cadence of the mid-turn rollout persist: while a prompt is executing,
        // the bridge re-uploads the agent rollout this often so a sandbox crash
        // during a long turn cold-resumes from recent state instead of restarting.
        midTurnRolloutPersistIntervalMs: positiveInteger,
        typecheckTimeoutMs: positiveInteger,
        // Bridge buffers up to this many events while the websocket is closed.
        // When full, drops oldest buffered non-ACK events.
        eventBufferMax: positiveInteger.max(1_000),
      })
      .strict(),
    output: z
      .object({
        toolSummaryMaxLength: positiveInteger,
        maxVerificationArtifacts: positiveInteger,
      })
      .strict(),
    verificationPhase: z.object({
      timeoutMs: positiveInteger,
    }),
    postExecution: z
      .object({
        prFullDiffMaxBuffer: positiveInteger,
        cloneTokenRefreshTimeoutMs: positiveInteger,
        artifactUploadTimeoutMs: positiveInteger,
        taskClassifierTimeoutMs: positiveInteger,
        taskClassifierHotPathTimeoutMs: positiveInteger,
        previewStartTimeoutMs: positiveInteger,
      })
      .strict(),
    diagnostics: z
      .object({
        execMaxBufferBytes: positiveInteger,
        timeoutMs: positiveInteger,
        debounceMs: nonNegativeInteger,
      })
      .strict(),
    // Accepted-but-ignored: present in deployed env payloads from before the
    // disk-backed critical-event outbox was removed. Allowing it keeps strict
    // mode from rejecting the whole config and silently falling back to all
    // defaults (which would clobber unrelated overrides like websocket/prompt
    // timeouts) during deploy skew.
    outbox: z.unknown().optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const require = (ok: boolean, path: PropertyKey[], message: string) => {
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    };

    const { websocket, codex, mcp, postExecution, diagnostics } = config;

    require(websocket.livenessThresholdMs > websocket.heartbeatIntervalMs, [
      "websocket",
      "livenessThresholdMs",
    ], "livenessThresholdMs must be greater than heartbeatIntervalMs");
    require(websocket.watchdogIntervalMs <= websocket.livenessThresholdMs, [
      "websocket",
      "watchdogIntervalMs",
    ], "watchdogIntervalMs must be less than or equal to livenessThresholdMs");
    require(codex.stdioLineMaxBytes <= codex.stdioSessionMaxBytes, [
      "codex",
      "stdioLineMaxBytes",
    ], "stdioLineMaxBytes must be less than or equal to stdioSessionMaxBytes");
    require(mcp.toolRegistrationDelayMs <= mcp.serverToolDiscoveryTimeoutMs, [
      "mcp",
      "toolRegistrationDelayMs",
    ], "toolRegistrationDelayMs must be less than or equal to serverToolDiscoveryTimeoutMs");
    require(postExecution.taskClassifierHotPathTimeoutMs <= postExecution.taskClassifierTimeoutMs, [
      "postExecution",
      "taskClassifierHotPathTimeoutMs",
    ], "taskClassifierHotPathTimeoutMs must be less than or equal to taskClassifierTimeoutMs");
    require(diagnostics.debounceMs <= diagnostics.timeoutMs, [
      "diagnostics",
      "debounceMs",
    ], "debounceMs must be less than or equal to diagnostics.timeoutMs");
  })
  .transform(({ outbox: _legacyOutbox, ...rest }) => rest);

export type SandboxBridgeRuntimeConfig = z.infer<typeof runtimeConfigSchema>;

const DEFAULT_SANDBOX_BRIDGE_RUNTIME_CONFIG = {
  websocket: {
    heartbeatIntervalMs: 30_000,
    livenessThresholdMs: 90_000,
    watchdogIntervalMs: 15_000,
  },
  reconnect: {
    jitterFactor: 0.25,
    warnThreshold: 3,
  },
  codex: {
    startupTimeoutMs: 30_000,
    // Transport/log forwarding boundary for raw Codex CLI stderr/stdout.
    // Kept below the per-event storage ceiling while allowing realistic
    // compiler/search diagnostic lines to survive intact.
    stdioLineMaxBytes: 32 * 1024,
    stdioSessionMaxBytes: 2_000_000,
  },
  mcp: {
    toolRegistrationRetries: 3,
    toolRegistrationDelayMs: 500,
    serverToolDiscoveryTimeoutMs: 5_000,
    dynamicRegistrationRequestTimeoutMs: 12_000,
    diagnosticsTimeoutMs: 15_000,
  },
  promptLoop: {
    promptStartTimeoutMs: 10_000,
    claudeCodePromptStartTimeoutMs: 60_000,
    promptActivityPulseIntervalMs: 30_000,
    midTurnRolloutPersistIntervalMs: 30_000,
    typecheckTimeoutMs: 5 * 60_000,
    eventBufferMax: 1_000,
  },
  output: {
    toolSummaryMaxLength: 80,
    maxVerificationArtifacts: 25,
  },
  verificationPhase: {
    timeoutMs: 20 * 60_000,
  },
  postExecution: {
    prFullDiffMaxBuffer: 512_000,
    cloneTokenRefreshTimeoutMs: 10_000,
    artifactUploadTimeoutMs: 15_000,
    taskClassifierTimeoutMs: 5_000,
    taskClassifierHotPathTimeoutMs: 750,
    previewStartTimeoutMs: 240_000,
  },
  diagnostics: {
    execMaxBufferBytes: 1024 * 1024,
    timeoutMs: 15_000,
    debounceMs: 500,
  },
} as const satisfies SandboxBridgeRuntimeConfig;

export function loadSandboxBridgeRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { logger?: Pick<Console, "warn"> } = {},
): SandboxBridgeRuntimeConfig {
  return loadJsonEnvConfig({
    envName: SANDBOX_BRIDGE_RUNTIME_CONFIG_ENV,
    schema: runtimeConfigSchema,
    defaultValue: DEFAULT_SANDBOX_BRIDGE_RUNTIME_CONFIG,
    env,
    logger: options.logger,
    logPrefix: LOG_PREFIX,
  });
}

export const SANDBOX_BRIDGE_RUNTIME_CONFIG = loadSandboxBridgeRuntimeConfig();
