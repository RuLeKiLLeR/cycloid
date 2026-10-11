import {
  type AgentRuntimeBackend,
  CODEX_AGENT_RUNTIME_BACKEND,
} from "../../../../shared/agent/agent-runtime-backend.js";
import type { TurnMode } from "../../../../shared/agent/constants.js";
import type { AgentRole, HarnessKind } from "../../../../shared/agent/schema.js";
import type { MemoryRef } from "../../../../shared/events/bridge.js";
import type { ReviewLoopPromptSourceKind } from "../../../../shared/types/sandbox.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { SANDBOX_BRIDGE_RUNTIME_CONFIG } from "../config/runtime.js";
import { type BridgeLogger, phaseLogFields } from "../logger.js";
import type { PromptLoopState } from "../prompt-loop-state.js";
import type { ClaudeStartupFn } from "../services/claude-session.js";
import {
  type CodexBridgeClient as CodexClient,
  codexTurnSandboxPolicyForTurnMode,
  resolveCodexHome,
} from "../services/codex-server.js";
import { CodexSessionManager, type CodexSessionManagerDeps } from "../services/codex-session.js";
import { translateCodexEvent, type TranslateEventDeps, type TranslateOutcome } from "../services/event-translator.js";
import type { Memory } from "../services/memory-ranking.js";
import { handleRespond, type QuestionReplyDeps } from "../services/question-reply.js";
import {
  createCoalescingPersister,
  persistRuntimeStateRollout,
  prepareStateRolloutRestore,
  type StateRolloutPort,
} from "../services/state-rollout.js";
import type { ToolPartTracker } from "../trackers/tool-part-tracker.js";
import type { PromptExecutionState } from "../types.js";
import type { ExtendedEvent } from "../utils/event-guards.js";

/**
 * Dependencies the bridge injects into a runtime adapter. The Codex session
 * lifecycle dep set, plus the neutral transport accessors an adapter needs to
 * persist/restore CLI state to the session volume (sandbox auth token + the
 * control-plane rollout upload URL).
 */
export type AgentRuntimeAdapterDeps = CodexSessionManagerDeps & {
  getSandboxToken: () => string;
  getRolloutUploadUrl: () => string;
  getRepoMemories?: () => Memory[];
  getMemoryRefById?: () => ReadonlyMap<string, MemoryRef>;
  /**
   * Live review-loop authorization context for the in-process Claude tool gate
   * (`worktreeRoot` is `getCwd()`) plus session-local auth readiness that the
   * in-process safety gates cannot read directly from bridge internals.
   */
  getReviewLoopContext?: () => {
    reviewLoopMode: boolean;
    reviewLoopSourceKind?: ReviewLoopPromptSourceKind;
    agentProfile?: string;
    cycloidCliAuthState?: "ready" | "pending" | "failed";
  };
  createClaudeStartup?: ClaudeStartupFn;
};

/** Async event stream the prompt loop iterates (with an optional `return`). */
export type EventStream = AsyncIterable<unknown> & {
  return?: (value?: unknown) => Promise<unknown>;
};

/**
 * Neutral prompt-part union handed to {@link AgentRuntimeAdapter.sendPrompt}:
 * the user's text (optionally flagged `synthetic` for injected upload context)
 * and image/file parts. Each adapter maps these to its backend's native request
 * shape. Properly discriminated on `type` so adapters can branch on it.
 */
export type PromptPart =
  { type: "text"; text: string; synthetic?: true } | { type: "file"; mime: string; filename: string; url: string };

/** Backend-neutral prompt request assembled by the bridge per turn. */
export type PromptRequest = {
  parts: PromptPart[];
  agent: string;
  agentRole: AgentRole;
  turnMode: TurnMode;
  /** Raw `provider/model` string; the adapter validates + maps it. */
  model?: string;
  system?: string;
  variant?: string;
  summary?: string;
};

export type RuntimeWarmupSkippedReason = "not_supported";

export type RuntimeWarmupOptions = {
  signal: AbortSignal;
  promptLog: BridgeLogger;
};

export type RuntimeWarmupResult =
  | {
      outcome: "skipped";
      reason: RuntimeWarmupSkippedReason;
      duration_ms: number;
    }
  | {
      outcome: "ready";
      duration_ms: number;
    };

/** Bridge-owned question-reply deps; the adapter supplies the Codex client handle. */
export type QuestionReplyBridgeDeps = Omit<QuestionReplyDeps, "getClient">;

/**
 * Backend-neutral coding-agent runtime contract. The bridge drives every
 * backend (Codex, Claude Code) exclusively through these methods; it no longer
 * touches a raw client/server. Model resolution stays here so the fail-closed
 * guard lives next to the backend that enforces it.
 */
export interface AgentRuntimeAdapter {
  readonly backend: AgentRuntimeBackend;
  readonly harnessKind: HarnessKind;
  readonly promptStartTimeoutMs: number;
  readonly rawFallbackPrefix: "codex" | "claude" | "opencode";

  /** True once the backend client/server is up and able to serve prompts. */
  readonly isInitialized: boolean;

  /**
   * Optional pre-prompt readiness work. Must not create transcripts, runtime
   * sessions, event subscriptions, or dispatch a real model turn.
   */
  warmup(opts: RuntimeWarmupOptions): Promise<RuntimeWarmupResult>;

  // Model resolution (fail-closed; delegates to the backend session manager).
  parseModel(model: string): { providerID: string; modelID: string };
  getRequestedModelInfo(model?: string): { providerID: string; modelID?: string };
  getEnvModelInfo(): { providerID: string; modelID?: string };
  /** Set the session-static model default (`undefined` clears it). */
  setStaticModel(model: string | undefined): void;

  ensureClientInitializedForPrompt(opts: {
    agentRole: AgentRole;
    model?: string;
    signal: AbortSignal;
    promptLog: BridgeLogger;
  }): Promise<void>;

  createSessionForPrompt(opts: { messageId: string; promptLog: BridgeLogger; signal: AbortSignal }): Promise<string>;

  /** Subscribe to the backend event stream for the active session. */
  subscribeEvents(): Promise<{ stream: EventStream }>;

  /** Dispatch a prompt to `sessionId`; owns model-spec + request-body assembly. */
  sendPrompt(
    request: PromptRequest,
    opts: { sessionId: string; signal: AbortSignal; promptLog: BridgeLogger },
  ): Promise<unknown>;

  /** Translate one backend event into bridge effects (see {@link TranslateOutcome}). */
  translateEvent(
    event: ExtendedEvent,
    deps: TranslateEventDeps,
    loopState: PromptLoopState,
    promptState: PromptExecutionState,
    toolTracker: ToolPartTracker,
  ): Promise<TranslateOutcome>;

  /** Abort the active turn on `sessionId` (best-effort; caller handles rejection). */
  abortSession(sessionId: string): Promise<unknown>;

  /**
   * Pre-init restore of persisted CLI state from the session volume, run before
   * the backend client boots. Codex copies the rollout into `$CODEX_HOME`.
   */
  prepareSessionRestore(opts: { restorableSessionId: string; promptLog: BridgeLogger }): Promise<void>;

  /**
   * Post-init resume: reattach to a restorable session. Returns the resumed
   * session id, or `null` when the prior session cannot be restored.
   */
  resumeSession(opts: {
    restorableSessionId: string;
    signal: AbortSignal;
    promptLog: BridgeLogger;
  }): Promise<{ sessionId: string } | null>;

  /** Persist the latest CLI state to the session volume (best-effort, never throws). */
  persistSession(promptLog: BridgeLogger): Promise<void>;

  /** Deliver a user's answer to a pending question via the backend's reply transport. */
  respondToQuestion(deps: QuestionReplyBridgeDeps, answer: string, requestId?: string): void;

  /** Tear down the backend server process. Safe to call multiple times. */
  shutdown(): void;
}

/** Codex body shape accepted by `session.promptAsync`, plus the reasoning `variant`. */
type CodexPromptBody = NonNullable<Parameters<CodexClient["session"]["promptAsync"]>[0]["body"]> & {
  variant?: string;
};

/** Codex runtime adapter: wraps `CodexSessionManager` and the rollout transport. */
export class CodexRuntimeAdapter implements AgentRuntimeAdapter {
  readonly backend = CODEX_AGENT_RUNTIME_BACKEND;
  readonly harnessKind = "codex-session";
  readonly promptStartTimeoutMs = SANDBOX_BRIDGE_RUNTIME_CONFIG.promptLoop.promptStartTimeoutMs;
  readonly rawFallbackPrefix = "codex";
  private readonly session: CodexSessionManager;
  private readonly deps: AgentRuntimeAdapterDeps;
  // Watermark of the newest rollout file mtime already uploaded, so we skip the
  // tar+upload when a prompt produced no new Codex rollout content.
  private lastRolloutMtimeMs = 0;
  // Serializes mid-turn periodic persists against the end-of-turn persist so two
  // concurrent uploads never race the per-session rollout blob.
  private readonly persistRollout = createCoalescingPersister();

  constructor(deps: AgentRuntimeAdapterDeps) {
    this.deps = deps;
    this.session = new CodexSessionManager(deps);
  }

  get isInitialized(): boolean {
    return this.session.client != null && this.session.server != null;
  }

  parseModel(model: string) {
    return this.session.parseModel(model);
  }
  getRequestedModelInfo(model?: string) {
    return this.session.getRequestedModelInfo(model);
  }
  getEnvModelInfo() {
    return this.session.getEnvModelInfo();
  }
  setStaticModel(model: string | undefined) {
    this.session.codexStaticConfig = model ? { model } : {};
  }

  async warmup(_opts: RuntimeWarmupOptions): Promise<RuntimeWarmupResult> {
    return { outcome: "skipped", reason: "not_supported", duration_ms: 0 };
  }

  ensureClientInitializedForPrompt(opts: {
    agentRole: AgentRole;
    model?: string;
    signal: AbortSignal;
    promptLog: BridgeLogger;
  }) {
    return this.session.ensureClientInitializedForPrompt(opts);
  }

  createSessionForPrompt(opts: { messageId: string; promptLog: BridgeLogger; signal: AbortSignal }) {
    return this.session.createCodexSessionForPrompt(opts);
  }

  subscribeEvents(): Promise<{ stream: EventStream }> {
    if (!this.session.client) throw new Error("Codex client not initialized");
    return this.session.client.event.subscribe();
  }

  sendPrompt(
    request: PromptRequest,
    opts: { sessionId: string; signal: AbortSignal; promptLog: BridgeLogger },
  ): Promise<unknown> {
    if (!this.session.client) throw new Error("Codex client not initialized");
    const modelSpec = request.model ? this.session.parseModel(request.model) : undefined;
    const body: CodexPromptBody = {
      parts: request.parts,
      ...(modelSpec ? { model: modelSpec } : {}),
      agent: request.agent,
      sandboxPolicy: codexTurnSandboxPolicyForTurnMode(request.turnMode),
      ...(request.system ? { system: request.system } : {}),
      ...(request.variant ? { variant: request.variant } : {}),
      ...(request.summary ? { summary: request.summary } : {}),
    };
    return this.session.client.session.promptAsync({
      signal: opts.signal,
      path: { id: opts.sessionId },
      promptLog: opts.promptLog,
      body,
    });
  }

  translateEvent(
    event: ExtendedEvent,
    deps: TranslateEventDeps,
    loopState: PromptLoopState,
    promptState: PromptExecutionState,
    toolTracker: ToolPartTracker,
  ): Promise<TranslateOutcome> {
    if (!deps.codex) throw new Error("Codex translator deps missing");
    return translateCodexEvent(event, { ...deps, ...deps.codex }, loopState, promptState, toolTracker);
  }

  abortSession(sessionId: string): Promise<unknown> {
    if (!this.session.client) throw new Error("Codex client not initialized");
    return this.session.client.session.abort({ path: { id: sessionId } });
  }

  async prepareSessionRestore(opts: { restorableSessionId: string; promptLog: BridgeLogger }): Promise<void> {
    // Cold resume: restore the persisted Codex rollout into $CODEX_HOME before the
    // app-server boots, so the resumeSession() lookup below finds the thread on disk.
    await prepareStateRolloutRestore(this.rolloutPort(opts.promptLog), {
      restorableSessionId: opts.restorableSessionId,
      promptLog: opts.promptLog,
      setLastRolloutMtimeMs: (value) => {
        this.lastRolloutMtimeMs = value;
      },
      messages: {
        skippedLocal: "Skipping Codex rollout restore; on-disk rollout state is present",
        restoreError: "Codex rollout restore error",
        restoreMissing: "Cold resume expected a Codex rollout but none was restored",
      },
    });
  }

  async resumeSession(opts: {
    restorableSessionId: string;
    signal: AbortSignal;
    promptLog: BridgeLogger;
  }): Promise<{ sessionId: string } | null> {
    if (!this.session.client) throw new Error("Codex client not initialized");
    const { restorableSessionId, promptLog } = opts;
    const restoreStartedAt = Date.now();
    promptLog.info(
      phaseLogFields("agent.session.create", {
        step: "restore",
        phase_status: "started",
        restorableSessionId,
      }),
      "Codex session restore started",
    );
    try {
      const existing = await this.session.client.session.get({
        path: { id: restorableSessionId },
      });
      if (existing.data) {
        promptLog.info(
          phaseLogFields("agent.session.create", {
            step: "restore",
            phase_status: "completed",
            duration_ms: Date.now() - restoreStartedAt,
            codexSessionId: restorableSessionId,
          }),
          "Restored Codex session from volume",
        );
        return { sessionId: restorableSessionId };
      }
    } catch (error) {
      promptLog.warn(
        phaseLogFields("agent.session.create", {
          step: "restore",
          phase_status: "failed",
          duration_ms: Date.now() - restoreStartedAt,
          error: stringifyError(error),
        }),
        "Stored Codex session not found in DB, creating new",
      );
    }
    return null;
  }

  async persistSession(promptLog: BridgeLogger): Promise<void> {
    await persistRuntimeStateRollout({
      persistRollout: this.persistRollout,
      getPort: () => this.rolloutPort(promptLog),
      getLastRolloutMtimeMs: () => this.lastRolloutMtimeMs,
      setLastRolloutMtimeMs: (value) => {
        this.lastRolloutMtimeMs = value;
      },
      promptLog,
      eventPrefix: "codex_rollout",
      errorMessage: "Codex rollout upload error",
    });
  }

  respondToQuestion(deps: QuestionReplyBridgeDeps, answer: string, requestId?: string): void {
    handleRespond({ ...deps, getClient: () => this.session.client }, answer, requestId);
  }

  shutdown(): void {
    this.session.server?.close();
    this.session.server = null;
    // Also clear the client: ensureClientInitializedForPrompt short-circuits on a
    // non-null client, so leaving it set would block any re-init after shutdown.
    this.session.client = null;
  }

  private rolloutPort(log: BridgeLogger): StateRolloutPort {
    return {
      // CODEX_HOME is set by buildCodexEnv before Codex runs; resolveCodexHome only
      // falls back to a random path when it is absent (not the case at these call sites).
      stateRoot: resolveCodexHome(process.env),
      subdir: "sessions",
      eventPrefix: "codex_rollout",
      rolloutUrl: this.deps.getRolloutUploadUrl(),
      getSandboxToken: () => this.deps.getSandboxToken(),
      fetch: globalThis.fetch,
      log,
    };
  }
}
