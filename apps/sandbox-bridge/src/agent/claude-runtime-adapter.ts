import { type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type AgentRuntimeBackend,
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
} from "../../../../shared/agent/agent-runtime-backend.js";
import { turnModeForAgentProfile } from "../../../../shared/agent/constants.js";
import type { AgentRole } from "../../../../shared/agent/schema.js";
import { SANDBOX_BRIDGE_RUNTIME_CONFIG } from "../config/runtime.js";
import { type BridgeLogger, phaseLogFields } from "../logger.js";
import type { PromptLoopState } from "../prompt-loop-state.js";
import { type ClaudeStreamEvent, ClaudeTurnState, translateClaudeEvent } from "../services/claude-event-translator.js";
import { ClaudeSessionManager, parseClaudeModel } from "../services/claude-session.js";
import type { TranslateEventDeps, TranslateOutcome } from "../services/event-translator.js";
import {
  createCoalescingPersister,
  persistRuntimeStateRollout,
  prepareStateRolloutRestore,
  type StateRolloutPort,
} from "../services/state-rollout.js";
import type { ToolPartTracker } from "../trackers/tool-part-tracker.js";
import type { PromptExecutionState } from "../types.js";
import type { ExtendedEvent } from "../utils/event-guards.js";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeAdapterDeps,
  EventStream,
  PromptRequest,
  QuestionReplyBridgeDeps,
  RuntimeWarmupOptions,
  RuntimeWarmupResult,
} from "./agent-runtime-adapter.js";

const CLAUDE_CODE_PROMPT_START_TIMEOUT_FALLBACK_MS = 60_000;

/**
 * Claude Code runtime adapter. Drives the `@anthropic-ai/claude-agent-sdk`
 * streaming-input `query()` through the same neutral {@link AgentRuntimeAdapter}
 * contract the bridge uses for Codex.
 *
 * Like Codex, one long-lived process serves the whole session: the
 * {@link ClaudeSessionManager} keeps a single persistent `query()` and demuxes
 * its message generator per turn. `subscribeEvents` opens the per-turn stream,
 * `sendPrompt` enqueues the user message (opening the query lazily on the first
 * call, when the session id, model, and per-prompt system context are all
 * known), and `translateEvent` maps each typed `SDKMessage` to the durable event
 * contract. Tool safety is enforced in-process via the SDK `canUseTool` gate.
 *
 * Project `.mcp.json` MCP servers are projected into the query options at open
 * (see services/claude-mcp-config.ts), and `~/.claude/projects` transcripts are
 * synced cross-sandbox through the shared state-rollout transport. Follow-up
 * (out of scope here): the question/permission reply path.
 */
export class ClaudeCodeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly backend: AgentRuntimeBackend = CLAUDE_CODE_AGENT_RUNTIME_BACKEND;
  readonly harnessKind = "claude-session";
  readonly promptStartTimeoutMs =
    SANDBOX_BRIDGE_RUNTIME_CONFIG.promptLoop.claudeCodePromptStartTimeoutMs ??
    CLAUDE_CODE_PROMPT_START_TIMEOUT_FALLBACK_MS;
  readonly rawFallbackPrefix = "claude";
  private readonly session: ClaudeSessionManager;
  private readonly deps: AgentRuntimeAdapterDeps;
  private readonly log: BridgeLogger;
  private staticModel: string | undefined;
  /** Per-prompt translator state, reset each time a new event stream is opened. */
  private currentTurnState: ClaudeTurnState;
  // Watermark of the newest transcript mtime already uploaded, so we skip the
  // tar+upload when a prompt produced no new Claude session content.
  private lastRolloutMtimeMs = 0;
  // Serializes mid-turn periodic persists against the end-of-turn persist so two
  // concurrent uploads never race the per-session rollout blob.
  private readonly persistRollout = createCoalescingPersister();

  constructor(deps: AgentRuntimeAdapterDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.currentTurnState = new ClaudeTurnState(deps.getCwd());
    this.session = new ClaudeSessionManager({
      getCwd: deps.getCwd,
      log: deps.log,
      managedMcpServers: deps.managedMcpServers,
      ...(deps.getReviewLoopContext ? { getReviewLoopContext: deps.getReviewLoopContext } : {}),
      ...(deps.getRepoMemories ? { getRepoMemories: deps.getRepoMemories } : {}),
      ...(deps.getMemoryRefById ? { getMemoryRefById: deps.getMemoryRefById } : {}),
      adoptedExternalPr: deps.adoptedExternalPr,
      ...(deps.createClaudeStartup ? { startupImpl: deps.createClaudeStartup } : {}),
    });
  }

  get isInitialized(): boolean {
    return this.session.isInitialized;
  }

  parseModel(model: string) {
    return parseClaudeModel(model);
  }

  getRequestedModelInfo(model?: string): { providerID: string; modelID?: string } {
    if (model) return parseClaudeModel(model);
    return this.getEnvModelInfo();
  }

  getEnvModelInfo(): { providerID: string; modelID?: string } {
    const envModel = process.env.MODEL;
    const providerID = process.env.PROVIDER || "anthropic";
    if (!envModel) return { providerID };
    return parseClaudeModel(envModel);
  }

  setStaticModel(model: string | undefined): void {
    this.staticModel = model;
  }

  async warmup(opts: RuntimeWarmupOptions): Promise<RuntimeWarmupResult> {
    const startedAt = Date.now();
    await this.session.warmup({
      signal: opts.signal,
      promptLog: opts.promptLog,
      timeoutMs: Math.min(
        this.promptStartTimeoutMs,
        SANDBOX_BRIDGE_RUNTIME_CONFIG.promptLoop.claudeCodePromptStartTimeoutMs ??
          CLAUDE_CODE_PROMPT_START_TIMEOUT_FALLBACK_MS,
      ),
    });
    return { outcome: "ready", duration_ms: Date.now() - startedAt };
  }

  async ensureClientInitializedForPrompt(_opts: {
    agentRole: AgentRole;
    model?: string;
    signal: AbortSignal;
    promptLog: BridgeLogger;
  }): Promise<void> {
    // The persistent SDK query opens lazily on the first dispatch and is reused
    // across turns. Just latch readiness so the bridge's `isInitialized` guards pass.
    this.session.ensureReady();
  }

  async createSessionForPrompt(_opts: {
    messageId: string;
    promptLog: BridgeLogger;
    signal: AbortSignal;
  }): Promise<string> {
    // We pin the session id (passed as the SDK `sessionId` option on the first
    // query open) so it can be resumed deterministically across turns and
    // sandbox respawns. Must be a valid UUID per the SDK contract.
    return crypto.randomUUID();
  }

  async subscribeEvents(): Promise<{ stream: EventStream }> {
    this.currentTurnState = new ClaudeTurnState(this.deps.getCwd());
    return this.session.subscribeEvents();
  }

  async sendPrompt(
    request: PromptRequest,
    opts: { sessionId: string; signal: AbortSignal; promptLog: BridgeLogger },
  ): Promise<unknown> {
    const effective = this.preparePromptRequest(request);
    return this.session.dispatch(effective, opts);
  }

  private preparePromptRequest(request: PromptRequest): PromptRequest {
    const { summary: _summary, ...backendRequest } = request;
    const expectedTurnMode = turnModeForAgentProfile(request.agent);
    if (request.turnMode !== expectedTurnMode) {
      throw new Error(
        `Claude Code turnMode mismatch: agent '${request.agent}' requires '${expectedTurnMode}', got '${request.turnMode}'`,
      );
    }
    return !backendRequest.model && this.staticModel ? { ...backendRequest, model: this.staticModel } : backendRequest;
  }

  translateEvent(
    event: ExtendedEvent,
    deps: TranslateEventDeps,
    loopState: PromptLoopState,
    promptState: PromptExecutionState,
    toolTracker: ToolPartTracker,
  ): Promise<TranslateOutcome> {
    return translateClaudeEvent(
      event as unknown as ClaudeStreamEvent,
      deps,
      loopState,
      promptState,
      this.currentTurnState,
      toolTracker,
    );
  }

  async abortSession(_sessionId: string): Promise<unknown> {
    this.session.abort();
    return undefined;
  }

  async prepareSessionRestore(opts: { restorableSessionId: string; promptLog: BridgeLogger }): Promise<void> {
    // Cold resume: restore the persisted `~/.claude/projects` transcripts before
    // the first query opens, so the SDK `resume` lookup finds the session on disk.
    await prepareStateRolloutRestore(this.rolloutPort(opts.promptLog), {
      restorableSessionId: opts.restorableSessionId,
      promptLog: opts.promptLog,
      setLastRolloutMtimeMs: (value) => {
        this.lastRolloutMtimeMs = value;
      },
      messages: {
        skippedLocal: "Skipping Claude rollout restore; on-disk transcripts are present",
        restoreError: "Claude rollout restore error",
        restoreMissing: "Cold resume expected a Claude rollout but none was restored",
      },
    });
  }

  async resumeSession(opts: {
    restorableSessionId: string;
    signal: AbortSignal;
    promptLog: BridgeLogger;
  }): Promise<{ sessionId: string } | null> {
    const { restorableSessionId, promptLog } = opts;
    const restoreStartedAt = Date.now();
    promptLog.info(
      phaseLogFields("agent.session.create", {
        step: "restore",
        phase_status: "started",
        restorableSessionId,
      }),
      "Claude session restore started",
    );

    const port = this.rolloutPort(promptLog);
    if (!(await claudeSessionTranscriptExists(port.stateRoot, port.subdir, restorableSessionId))) {
      promptLog.warn(
        phaseLogFields("agent.session.create", {
          step: "restore",
          phase_status: "failed",
          duration_ms: Date.now() - restoreStartedAt,
          restorableSessionId,
          error: "Claude session transcript not found on disk",
        }),
        "Stored Claude session not found on disk, creating new",
      );
      return null;
    }

    // Mark the id so the next dispatch resumes it (`--resume`) instead of pinning
    // a fresh one. Only do this after confirming the SDK's on-disk transcript exists.
    this.session.markResumable(restorableSessionId);
    promptLog.info(
      phaseLogFields("agent.session.create", {
        step: "restore",
        phase_status: "completed",
        duration_ms: Date.now() - restoreStartedAt,
        claudeSessionId: restorableSessionId,
      }),
      "Restored Claude session from volume",
    );
    return { sessionId: restorableSessionId };
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
      eventPrefix: "claude_rollout",
      errorMessage: "Claude rollout upload error",
    });
  }

  private rolloutPort(log: BridgeLogger): StateRolloutPort {
    return {
      // The CLI honors CLAUDE_CONFIG_DIR; default is ~/.claude. Only the
      // `projects/` transcript subtree is synced — credentials and settings live
      // outside it and never leave the sandbox.
      stateRoot: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      subdir: "projects",
      eventPrefix: "claude_rollout",
      rolloutUrl: this.deps.getRolloutUploadUrl(),
      getSandboxToken: () => this.deps.getSandboxToken(),
      fetch: globalThis.fetch,
      log,
    };
  }

  respondToQuestion(_deps: QuestionReplyBridgeDeps, answer: string, requestId?: string): void {
    // Fully in-process: the SDK `canUseTool` gate holds the AskUserQuestion call
    // open; resolving the pending question feeds the answer back through
    // `updatedInput.answers` (no HTTP reply endpoint like Codex).
    const resolved = this.session.respondToQuestion(answer, requestId);
    if (!resolved) {
      this.log.warn({ event: "claude.respond_unmatched", requestId }, "No pending Claude question matched the reply");
    }
  }

  shutdown(): void {
    this.session.shutdown();
  }
}

async function claudeSessionTranscriptExists(stateRoot: string, subdir: string, sessionId: string): Promise<boolean> {
  const stateSubtreeRoot = join(stateRoot, subdir);
  const targetFilename = `${sessionId}.jsonl`;
  const pendingDirs = [stateSubtreeRoot];

  while (pendingDirs.length > 0) {
    const dir = pendingDirs.pop();
    if (!dir) continue;
    const entries = await readDirents(dir);
    if (!entries) continue;

    for (const entry of entries) {
      if (entry.isFile() && entry.name === targetFilename) return true;
      if (entry.isDirectory()) pendingDirs.push(join(dir, entry.name));
    }
  }

  return false;
}

async function readDirents(dir: string): Promise<Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}
