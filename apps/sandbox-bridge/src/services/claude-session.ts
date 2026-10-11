import {
  type EffortLevel,
  type Options,
  type PermissionResult,
  type Query,
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
  startup as sdkStartup,
  type WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";

import { CLAUDE_CODE_AGENT_RUNTIME_BACKEND } from "../../../../shared/agent/agent-runtime-backend.js";
import type { AgentRole } from "../../../../shared/agent/schema.js";
import { getModelDefinition, isModelAllowedForBackend } from "../../../../shared/constants/models.js";
import { withProviderRetry } from "../../../../shared/llm/retry.mjs";
import { redact } from "../../../../shared/observability/redact.js";
import type { ReviewLoopPromptSourceKind } from "../../../../shared/types/sandbox.js";
import type { PromptRequest } from "../agent/agent-runtime-adapter.js";
import { buildSessionStaticBehavioralGuidance } from "../constants/bridge.js";
import { type BridgeLogger } from "../logger.js";
import { waitForAbortable } from "../utils/bridge-runtime.js";
import { readEffectiveProjectDocContent } from "../utils/project-doc-setup.js";
import { buildAgentChildEnv } from "../utils/sanitized-env.js";
import type { ManagedMcpRuntimeServer } from "../utils/session-config.js";
import {
  buildClaudeFirstPartyDynamicToolsProjection,
  CLAUDE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME,
  parseClaudeFirstPartyDynamicToolName,
} from "./claude-first-party-dynamic-tools.js";
import { loadProjectMcpServers, type ProjectMcpServerConfig } from "./claude-mcp-config.js";
import { resolveCanUseToolDecision } from "./claude-tool-safety.js";
import { getFirstPartyDynamicToolPlanMode } from "./first-party-dynamic-tools.js";

const CLAUDE_SETUP_MAX_ATTEMPTS = 3;
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
const CLAUDE_EFFORT_LEVEL_SET = new Set<string>(CLAUDE_EFFORT_LEVELS);

/** Streaming-input factory; injectable for tests, defaults to the SDK `query()`. */
export type ClaudeQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
export type ClaudeStartupFn = (params?: { options?: Options; initializeTimeoutMs?: number }) => Promise<WarmQuery>;

/** Resolution of a pending AskUserQuestion gate: a user answer, or cancellation. */
type QuestionOutcome = { answer: string } | { aborted: true };

/**
 * Push-backed async iterable handed to the SDK as the long-lived prompt source.
 * The SDK is the sole consumer; `dispatch()` enqueues one {@link SDKUserMessage}
 * per turn. Closing wakes a pending reader with `done`, ending the session input.
 */
class PushInputStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiter: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) throw new Error("Cannot dispatch after the Claude input stream is closed");
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

/**
 * Per-turn demultiplexed view of the persistent SDK message generator. The
 * session manager pushes each {@link SDKMessage} for the active turn here; the
 * bridge prompt loop iterates until the turn's `result` arrives, then calls
 * `return()` (its `finally`). `return()`/`close()` ONLY detach this turn — they
 * never touch the underlying persistent query, so the next turn reuses it.
 */
export class ClaudeEventStream implements AsyncIterable<SDKMessage> {
  private queue: SDKMessage[] = [];
  private waiters: Array<(value: IteratorResult<SDKMessage>) => void> = [];
  private closed = false;

  push(record: SDKMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: record });
      return;
    }
    this.queue.push(record);
  }

  /**
   * Surface a generator-level failure to the prompt loop as a terminal error
   * `result` so the translator emits the `error` durable event and breaks,
   * instead of the loop hanging on a dead generator.
   */
  pushSyntheticError(message: string): void {
    this.push({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [message],
    } as unknown as SDKMessage);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter({ done: true, value: undefined });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  return(_value?: unknown): Promise<IteratorResult<SDKMessage>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<SDKMessage>>((resolve) => this.waiters.push(resolve));
      },
      return: () => this.return(),
    };
  }
}

export interface ClaudeSessionManagerDeps {
  getCwd: () => string;
  log: BridgeLogger;
  /**
   * Explicit path to the `claude` executable, passed as
   * `pathToClaudeCodeExecutable`. Defaults to undefined so the SDK resolves its
   * own version-locked native binary from `node_modules`.
   */
  claudePath?: string;
  /** Injectable for tests; defaults to the SDK `query()`. */
  queryImpl?: ClaudeQueryFn;
  /** Injectable for tests; defaults to the SDK `startup()`. */
  startupImpl?: ClaudeStartupFn;
  /**
   * Current review-loop authorization context, read fresh on each tool gate so
   * the in-process gate enforces the SAME worktree boundary as the Codex path
   * (`worktreeRoot` is `getCwd()`). Omit on a non-review-loop session.
   */
  getReviewLoopContext?: () => {
    reviewLoopMode: boolean;
    reviewLoopSourceKind?: ReviewLoopPromptSourceKind;
    agentProfile?: string;
    cycloidCliAuthState?: "ready" | "pending" | "failed";
  };
  managedMcpServers?: ManagedMcpRuntimeServer[];
  getRepoMemories?: () => import("./memory-ranking.js").Memory[];
  getMemoryRefById?: () => ReadonlyMap<string, import("../../../../shared/events/bridge.js").MemoryRef>;
  adoptedExternalPr?: boolean;
}

/**
 * Resolve a Claude model selection, fail-closed against the shared model
 * registry. Strips an optional `anthropic/` prefix, then rejects anything that
 * is not an Anthropic registry model runnable on the claude_code backend. This
 * is the bridge-side guard backing the control-plane (model, backend)
 * validation — an unknown or non-Claude id never reaches the SDK.
 */
export function parseClaudeModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  const providerID = slash > 0 ? model.slice(0, slash) : "anthropic";
  const modelID = slash > 0 ? model.slice(slash + 1) : model;
  if (!modelID) throw new Error(`Unsupported Claude model '${model}'`);
  if (providerID !== "anthropic") {
    throw new Error(`Unsupported Claude model provider '${providerID}' for '${model}'`);
  }
  const definition = getModelDefinition(modelID);
  if (
    !definition ||
    definition.provider !== "anthropic" ||
    !isModelAllowedForBackend(modelID, CLAUDE_CODE_AGENT_RUNTIME_BACKEND)
  ) {
    throw new Error(`Unsupported Claude model '${model}'`);
  }
  return { providerID, modelID };
}

function buildManagedClaudeMcpServers(
  servers: readonly ManagedMcpRuntimeServer[],
  env: NodeJS.ProcessEnv = process.env,
): { servers: Record<string, ProjectMcpServerConfig>; referencedEnvNames: Set<string> } {
  const result: Record<string, ProjectMcpServerConfig> = {};
  const referencedEnvNames = new Set<string>();
  for (const server of servers) {
    if (server.transport === "stdio") {
      if (!server.command) continue;
      const serverEnv: Record<string, string> = {};
      for (const envVar of server.envVars ?? []) {
        referencedEnvNames.add(envVar);
        const value = env[envVar];
        if (value) serverEnv[envVar] = value;
      }
      result[server.name] = {
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        ...(Object.keys(serverEnv).length > 0 ? { env: serverEnv } : {}),
      };
      continue;
    }
    if (!server.url) continue;
    const headers: Record<string, string> = {};
    for (const [name, config] of Object.entries(server.headers ?? {})) {
      if (config.envVar) {
        referencedEnvNames.add(config.envVar);
        const value = env[config.envVar];
        if (value) headers[name] = value;
      } else if (config.value !== undefined) {
        headers[name] = config.value;
      }
    }
    result[server.name] = {
      type: server.transport,
      url: server.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }
  return { servers: result, referencedEnvNames };
}

/**
 * Anthropic image content block for a prompt `file` part. `buildImageParts`
 * encodes uploads as `data:<mime>;base64,<data>` URLs, so prefer a base64 source
 * and fall back to a URL source for any other (e.g. remote) url shape.
 */
function toImageBlock(part: { mime: string; url: string }): Record<string, unknown> {
  const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(part.url);
  if (dataUrl) {
    return { type: "image", source: { type: "base64", media_type: dataUrl[1], data: dataUrl[2] } };
  }
  return { type: "image", source: { type: "url", url: part.url } };
}

/**
 * Build one streaming-input {@link SDKUserMessage} from a {@link PromptRequest}.
 * The SDK `systemPrompt` option is fixed at query open (static `claude_code`
 * preset only), so the per-prompt dynamic system context (`request.system`:
 * verification role, diagnostics, active memories, workspace state — rebuilt
 * every turn) is delivered HERE, as a delimited leading text block, so it
 * reaches the model on every turn. Text parts follow; uploaded images become
 * Anthropic `image` blocks.
 *
 * CACHE INVARIANT: this `<cycloid-system-context>` block is where ALL
 * Cycloid-owned per-turn volatile content MUST live. Keeping it out of the
 * cached system prefix (`systemPromptAppend`) is what lets the prefix stay
 * byte-stable and prompt-cacheable across turns and resumes. Do not move
 * Cycloid-owned volatile content into the append/system prompt. (The SDK's own
 * dynamic sections — cwd/git-status/auto-memory — are relocated separately by
 * `excludeDynamicSections: true` on the preset and are out of Cycloid's hands.)
 * See docs/prompt-agents.md#cached-system-prefix-invariant.
 */
export function buildUserMessage(request: PromptRequest): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [];
  if (request.system) {
    content.push({
      type: "text",
      text: `<cycloid-system-context>\n${request.system}\n</cycloid-system-context>`,
    });
  }
  for (const part of request.parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "file" && part.mime.startsWith("image/")) content.push(toImageBlock(part));
  }
  return {
    type: "user",
    message: { role: "user", content: content as never },
    parent_tool_use_id: null,
  };
}

/**
 * Owns ONE long-lived SDK `query()` for the whole session (streaming-input
 * mode). A push-queue feeds user messages in; the returned message generator is
 * demuxed per turn into a {@link ClaudeEventStream} the bridge loop drains. The
 * query is opened lazily on the first `dispatch()` — when the session id, model,
 * and first prompt body are all known — and reused for every later turn (no new
 * boot). The in-process `canUseTool` gate enforces tool safety; a generator
 * failure is surfaced to the active turn as a terminal error.
 */
export class ClaudeSessionManager {
  private readonly deps: ClaudeSessionManagerDeps;
  private readonly queryImpl: ClaudeQueryFn;
  private readonly startupImpl: ClaudeStartupFn;
  private readonly claudePath: string | undefined;

  private ready = false;
  private shuttingDown = false;

  private query: Query | null = null;
  private openingQuery: Promise<Query> | null = null;
  private queryGeneration = 0;
  private inputStream: PushInputStream | null = null;
  private abortController: AbortController | null = null;
  private currentStream: ClaudeEventStream | null = null;
  private currentModelId: string | undefined;
  private currentEffort: EffortLevel | undefined;
  private activeTurn = false;
  private detachAbort: (() => void) | null = null;
  /** Session id the live `query()` is pinned to; drives mid-session reopen on change. */
  private boundSessionId: string | null = null;
  private dynamicToolsGuidance: string | null = null;

  /** Sessions already dispatched this run (next open reuses via `resume`). */
  private readonly startedSessions = new Set<string>();
  /** Sessions restored from disk (open via `resume`, not a fresh `sessionId`). */
  private readonly resumeFromDisk = new Set<string>();
  /** AskUserQuestion gates awaiting a user answer, keyed by question id. */
  private readonly pendingQuestions = new Map<string, (outcome: QuestionOutcome) => void>();

  constructor(deps: ClaudeSessionManagerDeps) {
    this.deps = deps;
    this.queryImpl = deps.queryImpl ?? sdkQuery;
    this.startupImpl = deps.startupImpl ?? sdkStartup;
    this.claudePath = deps.claudePath ?? process.env.CLAUDE_CLI_PATH;
  }

  get isInitialized(): boolean {
    return this.ready;
  }

  /** Cheap readiness latch — the persistent query opens lazily on first dispatch. */
  ensureReady(): void {
    this.ready = true;
  }

  async warmup(opts: { signal: AbortSignal; promptLog: BridgeLogger; timeoutMs: number }): Promise<void> {
    const { env: childEnv } = buildAgentChildEnv(process.env, {
      providerKeys: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    });
    let handleToClose: WarmQuery | undefined;
    const abortController = new AbortController();
    const abortWarmup = () => abortController.abort();
    if (opts.signal.aborted) {
      abortWarmup();
    } else {
      opts.signal.addEventListener("abort", abortWarmup, { once: true });
    }
    const warmupPromise = this.startupImpl({
      initializeTimeoutMs: opts.timeoutMs,
      options: {
        cwd: this.deps.getCwd(),
        abortController,
        env: childEnv,
        settingSources: [],
        strictMcpConfig: true,
        ...(this.claudePath ? { pathToClaudeCodeExecutable: this.claudePath } : {}),
      },
    });

    try {
      handleToClose = await waitForAbortable(warmupPromise, opts.signal);
      opts.promptLog.info({ event: "claude.warmup.ready" }, "Claude SDK warmup completed");
    } finally {
      if (handleToClose) {
        handleToClose.close();
      } else {
        void warmupPromise.then((handle) => handle.close()).catch(() => {});
      }
      opts.signal.removeEventListener("abort", abortWarmup);
    }
  }

  /** Mark a restored session so its first query opens with `resume` instead of pinning. */
  markResumable(sessionId: string): void {
    this.resumeFromDisk.add(sessionId);
  }

  subscribeEvents(): { stream: ClaudeEventStream } {
    const stream = new ClaudeEventStream();
    this.currentStream = stream;
    return { stream };
  }

  /**
   * Surface a scheduled provider retry (from {@link withProviderRetry} during
   * query open or model switch) to the bridge loop as a synthetic
   * `cycloid_retry_status` stream record, translated into the same durable
   * `retry_status` event Codex emits. Best-effort: no live turn stream means the
   * retry is silent, never blocked.
   */
  private emitRetryStatus(info: { attempt: number; maxAttempts: number; delayMs: number }): void {
    this.currentStream?.push({
      type: "cycloid_retry_status",
      attempt: info.attempt,
      maxAttempts: info.maxAttempts,
      delayMs: info.delayMs,
    } as unknown as SDKMessage);
  }

  /**
   * Enqueue one prompt for the active turn, opening the persistent query on the
   * first call. Resolves once the message is accepted onto the input queue;
   * turn events then flow asynchronously through the subscribed stream until the
   * SDK emits `result`. Rejects on shutdown, an overlapping turn, an unsupported
   * model change, or an input stream that has already closed.
   */
  async dispatch(
    request: PromptRequest,
    opts: { sessionId: string; signal: AbortSignal; promptLog: BridgeLogger },
  ): Promise<void> {
    if (this.shuttingDown) throw new Error("Claude session is shutting down");
    if (this.activeTurn || this.openingQuery) throw new Error("Claude dispatch while a turn is already active");
    const stream = this.currentStream;
    if (!stream) throw new Error("Claude event stream not subscribed before dispatch");

    // Already cancelled: do not enqueue onto the SDK input queue (the persistent
    // query could still pick it up). Close only this turn's stream — do NOT
    // interrupt the persistent query. No turn is active here (guarded above), so
    // there is nothing to interrupt, and interrupting would tear down a still-
    // healthy session left alive by a prior completed prompt.
    if (opts.signal.aborted) {
      this.deps.log.info(
        { event: "claude.dispatch_aborted", sessionId: opts.sessionId },
        "Dispatch skipped; prompt already aborted",
      );
      this.currentStream?.close();
      return;
    }

    // Fail-closed model resolution before any state mutation.
    const modelId = request.model ? parseClaudeModel(request.model).modelID : undefined;
    const effort = resolveClaudeEffort(request.variant);

    // Open the query on the first dispatch, OR reopen when the bridge swaps the
    // session id mid-life (an agent-profile switch mints a new id). Reusing the
    // old query would bind turns to the previous session; tear it down first.
    let openedQuery: Query | null = null;
    if (!this.query || opts.sessionId !== this.boundSessionId) {
      if (this.query) this.closeCurrentQuery();
      this.openingQuery = this.openQuery(
        opts.sessionId,
        modelId,
        effort,
        request.agentRole,
        request.agent,
        opts.promptLog,
      );
      try {
        openedQuery = await this.openingQuery;
      } finally {
        this.openingQuery = null;
      }
      if (this.shuttingDown) throw new Error("Claude session is shutting down");
    } else {
      if (effort !== this.currentEffort) {
        this.deps.log.warn(
          {
            event: "claude.effort_mismatch",
            sessionId: opts.sessionId,
            currentEffort: this.currentEffort ?? null,
            requestedEffort: effort ?? null,
          },
          "Claude reasoning effort changed after the persistent query opened",
        );
        throw new Error("Claude reasoning effort cannot change after the persistent query opens");
      }
      if (modelId && modelId !== this.currentModelId) {
        await withProviderRetry({
          maxAttempts: CLAUDE_SETUP_MAX_ATTEMPTS,
          op: () => this.query!.setModel(modelId),
          onRetry: (info) => this.emitRetryStatus(info),
        });
        this.currentModelId = modelId;
        this.deps.log.info(
          { event: "claude.set_model", sessionId: opts.sessionId, model: modelId },
          "Switched Claude model",
        );
      }
    }

    const message = buildUserMessage(this.withDynamicToolsGuidance(request));
    this.inputStream!.push(message);
    this.activeTurn = true;
    this.startedSessions.add(opts.sessionId);
    if (openedQuery) this.consumeQuery(openedQuery);

    this.detachAbort?.();
    const onAbort = (): void => this.abort();
    opts.signal.addEventListener("abort", onAbort);
    this.detachAbort = () => opts.signal.removeEventListener("abort", onAbort);

    this.deps.log.info(
      { event: "claude.dispatch", sessionId: opts.sessionId, model: modelId ?? null },
      "Dispatched Claude turn",
    );
  }

  private async openQuery(
    sessionId: string,
    modelId: string | undefined,
    effort: EffortLevel | undefined,
    agentRole: AgentRole,
    agentProfile: string,
    promptLog: BridgeLogger,
  ): Promise<Query> {
    // Resume ONLY when this specific id already has on-disk state — restored from
    // a respawn (`resumeFromDisk`) or already dispatched this run (`startedSessions`,
    // e.g. a reopen after a generator died). A brand-new id (first turn, or an
    // agent-switch id) is pinned with `sessionId`, never resumed.
    const useResume = this.resumeFromDisk.has(sessionId) || this.startedSessions.has(sessionId);
    this.boundSessionId = sessionId;
    const inputStream = new PushInputStream();
    this.inputStream = inputStream;
    this.currentModelId = modelId;
    this.currentEffort = effort;
    this.abortController = new AbortController();

    // Project the customer repo's committed `.mcp.json`. The SDK loads NO
    // filesystem settings (`settingSources: []` below), so without this the
    // customer's committed servers would be invisible. Tool calls from these
    // servers still pass the in-process canUseTool safety gate.
    const managedMcp = buildManagedClaudeMcpServers(this.deps.managedMcpServers ?? []);
    const projectedMcp = loadProjectMcpServers(this.deps.getCwd(), this.deps.log, process.env, {
      deniedRemoteEnvNames: managedMcp.referencedEnvNames,
    });
    const firstPartyDynamicTools = buildClaudeFirstPartyDynamicToolsProjection(
      process.env,
      {
        env: process.env,
        cwd: this.deps.getCwd(),
        agentProfile,
        signal: this.abortController.signal,
        promptLog,
        ...(this.deps.getRepoMemories ? { getRepoMemories: this.deps.getRepoMemories } : {}),
        ...(this.deps.getMemoryRefById ? { getMemoryRefById: this.deps.getMemoryRefById } : {}),
        recordTelemetry: (eventName, fields) => {
          try {
            this.currentStream?.push({
              type: "memory.recall.telemetry",
              properties: {
                sessionID: sessionId,
                eventName,
                ...fields,
              },
            } as unknown as SDKMessage);
          } catch {
            // Telemetry must never fail a dynamic tool call.
          }
        },
      },
      { agentRole, modelId },
    );
    this.dynamicToolsGuidance = firstPartyDynamicTools?.guidance ?? null;
    const mcpServers =
      projectedMcp || firstPartyDynamicTools || Object.keys(managedMcp.servers).length > 0
        ? {
            ...(projectedMcp?.servers ?? {}),
            ...managedMcp.servers,
            ...(firstPartyDynamicTools
              ? { [CLAUDE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME]: firstPartyDynamicTools.mcpServer }
              : {}),
          }
        : undefined;
    // Only managed MCP registration can request credential preservation into
    // the child env. Repo-local `.mcp.json` is repository-controlled input; any
    // accepted references are expanded into that server config and must not
    // make integration credentials generally visible to the Claude runtime.
    const managedMcpEnvNames = managedMcp.referencedEnvNames;
    const { env: childEnv } = buildAgentChildEnv(process.env, {
      providerKeys: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
      preserveNames: managedMcpEnvNames,
      trustedPreserveNames: managedMcpEnvNames,
    });

    // Project-doc parity with Codex: the SDK also loads no instruction files
    // (no settingSources), so the customer's CYCLOID.md > AGENTS.md > CLAUDE.md
    // winner rides the system-prompt append, byte-capped like Codex's injection.
    const projectDoc = readEffectiveProjectDocContent(this.deps.getCwd(), this.deps.log);
    if (projectDoc) {
      this.deps.log.info(
        { event: "claude.project_doc_injected", doc: projectDoc.name, truncated: projectDoc.truncated },
        "Injected customer project doc into the Claude system prompt",
      );
    }
    const sessionStaticGuidance = buildSessionStaticBehavioralGuidance({
      agentRole,
      adoptedExternalPr: this.deps.adoptedExternalPr === true,
    });
    const systemPromptAppend = projectDoc
      ? `${sessionStaticGuidance}\n\n# Repo instructions (${projectDoc.name})\n\n${projectDoc.content}`
      : sessionStaticGuidance;

    const options: Options = {
      // Behavioral-guidance parity with Codex: the same durable Cycloid rules
      // Codex loads from `${CODEX_HOME}/AGENTS.md` ride the system prompt here
      // (`append` keeps the claude_code preset). System-prompt placement is
      // higher-trust than a first message and cannot collide with customer
      // repo CLAUDE.md files. The `append` carries no Cycloid first-party
      // dynamic-tool guidance: those tools are projected as an SDK MCP server
      // and their volatile guidance rides the per-turn user context. The append
      // is byte-stable for a session-static agent role.
      //
      // `excludeDynamicSections: true` is the SDK-level cache lever (distinct
      // from Cycloid dynamic tools above). The claude_code preset otherwise
      // bakes per-user *SDK* dynamic sections (working directory, git status,
      // auto-memory) into the cached system prefix; those change after commits
      // and on every reopen, so the prefix differs on each resume → prompt-cache
      // miss. Setting this strips them from the prefix and re-injects them as the
      // SDK's first user message, keeping the cached prefix stable across resume
      // and (for matching append inputs) across sessions on the same key. The
      // model still receives that context, just slightly later in the prompt.
      systemPrompt: { type: "preset", preset: "claude_code", append: systemPromptAppend, excludeDynamicSections: true },
      cwd: this.deps.getCwd(),
      includePartialMessages: true,
      canUseTool: (toolName, input) => this.gate(toolName, input, sessionId),
      abortController: this.abortController,
      // The SDK `env` REPLACES the subprocess environment entirely — sanitized
      // allowlist plus the reinjected ANTHROPIC_API_KEY (else the CLI loses its
      // provider key). settingSources [] / strictMcpConfig stop the SDK from
      // loading the untrusted repo's settings.json hooks/env and foreign MCP
      // configs; only bridge-projected MCP servers above are honored.
      env: childEnv,
      settingSources: [],
      strictMcpConfig: true,
      ...(mcpServers ? { mcpServers: mcpServers as Options["mcpServers"] } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(effort ? { effort } : {}),
      ...(this.claudePath ? { pathToClaudeCodeExecutable: this.claudePath } : {}),
      ...(useResume ? { resume: sessionId } : { sessionId }),
    };

    const { value: q } = await withProviderRetry({
      maxAttempts: CLAUDE_SETUP_MAX_ATTEMPTS,
      op: async () => this.queryImpl({ prompt: inputStream, options }),
      onRetry: (info) => this.emitRetryStatus(info),
    });
    this.query = q;
    this.queryGeneration += 1;
    this.deps.log.info(
      { event: "claude.query_open", sessionId, resume: useResume, model: modelId ?? null },
      "Opened persistent Claude SDK query",
    );
    return q;
  }

  private withDynamicToolsGuidance(request: PromptRequest): PromptRequest {
    if (!this.dynamicToolsGuidance) return request;
    const system = request.system ? `${request.system}\n\n${this.dynamicToolsGuidance}` : this.dynamicToolsGuidance;
    return { ...request, system };
  }

  /** In-process tool-safety gate (replaces the external PreToolUse hook). */
  private async gate(toolName: string, input: Record<string, unknown>, sessionId: string): Promise<PermissionResult> {
    const firstPartyTool = parseClaudeFirstPartyDynamicToolName(toolName);
    const safetyToolName = firstPartyTool ? `${firstPartyTool.namespace}.${firstPartyTool.name}` : toolName;

    // Enforce the same review-loop worktree boundary as the Codex path
    // (bridge.ts checkToolSafety call): the in-process gate can now read the
    // live context the external hook subprocess never could.
    const reviewLoop = this.deps.getReviewLoopContext?.();
    const decision = resolveCanUseToolDecision(safetyToolName, input, {
      worktreeRoot: this.deps.getCwd(),
      reviewLoopMode: reviewLoop?.reviewLoopMode ?? false,
      ...(reviewLoop?.reviewLoopSourceKind ? { reviewLoopSourceKind: reviewLoop.reviewLoopSourceKind } : {}),
      ...(reviewLoop?.agentProfile ? { agentProfile: reviewLoop.agentProfile } : {}),
      ...(reviewLoop?.cycloidCliAuthState ? { cycloidCliAuthState: reviewLoop.cycloidCliAuthState } : {}),
      hasReadOnlyOsSandbox: false,
      getPlanModeToolDisposition: getFirstPartyDynamicToolPlanMode,
    });
    if (decision.behavior === "deny") {
      // Never log `input` — it may carry secrets.
      this.deps.log.warn(
        { event: "claude.tool_denied", sessionId, tool: toolName, reason: decision.message },
        "Claude tool call denied by safety gate",
      );
      return { behavior: "deny", message: decision.message };
    }
    // AskUserQuestion: hold the gate open until the user answers (surfaced as a
    // durable `question` event; answered via the session `respond` route).
    if (toolName === "AskUserQuestion") {
      return this.gateAskUserQuestion(input, sessionId);
    }
    // The SDK control protocol requires `updatedInput` on an allow decision; echo
    // the unmodified input back (we permit, we do not rewrite the tool call).
    return { behavior: "allow", updatedInput: input };
  }

  /**
   * Intercept an `AskUserQuestion` tool call: surface it to the bridge loop as a
   * synthetic `cycloid_question` stream message (translated into the durable
   * `question` event Codex also emits), then hold the SDK gate open until
   * {@link respondToQuestion} delivers the user's answer. The answer is returned
   * to the SDK via `updatedInput.answers`, the slot the CLI's own permission
   * component uses, so the tool resolves without any UI in the sandbox.
   */
  private async gateAskUserQuestion(input: Record<string, unknown>, sessionId: string): Promise<PermissionResult> {
    const questionId = crypto.randomUUID();
    const rawQuestions = (input as { questions?: unknown }).questions;
    const questions = Array.isArray(rawQuestions) ? (rawQuestions as Array<Record<string, unknown>>) : [];
    const first = questions[0] ?? {};

    // No live turn stream means the question can never reach a user: deny
    // immediately instead of registering a gate nothing can answer.
    const stream = this.currentStream;
    if (!stream || stream.isClosed) {
      this.deps.log.warn(
        { event: "claude.question_dropped", sessionId, questionId },
        "AskUserQuestion arrived with no active turn stream; denying",
      );
      return { behavior: "deny", message: "Question could not be surfaced to the user" };
    }

    // The durable event carries one question text; when the call asks several
    // (the schema allows 1-4), surface them all as a numbered list so none are
    // hidden from the user. Options come from the first question only.
    const questionText =
      questions.length > 1
        ? questions.map((q, i) => `${i + 1}. ${String(q.question ?? "")}`).join("\n")
        : String(first.question ?? "");

    const outcome = await new Promise<QuestionOutcome>((resolve) => {
      // Entries are removed by respondToQuestion / cancelPendingQuestions
      // BEFORE resolving (pre-delete prevents a double-answer race); those two
      // paths are the only resolvers, so no extra cleanup is needed here.
      this.pendingQuestions.set(questionId, resolve);
      stream.push({
        type: "cycloid_question",
        id: questionId,
        question: questionText,
        options: Array.isArray(first.options) ? first.options : [],
      } as unknown as SDKMessage);
      this.deps.log.info(
        { event: "claude.question_asked", sessionId, questionId },
        "Claude AskUserQuestion awaiting user answer",
      );
    });

    if ("aborted" in outcome) {
      return { behavior: "deny", message: "Question cancelled before the user answered" };
    }
    // One free-text answer answers every question in the call: the durable
    // contract carries a single answer string (Codex replies `[[answer]]` the
    // same way), and the surfaced text lists every question.
    const answers = Object.fromEntries(questions.map((q) => [String(q.question ?? ""), outcome.answer]));
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  /**
   * Deliver a user's answer to a pending question. A reply that names a
   * `requestId` is matched strictly — a stale id (already answered, or from a
   * superseded question) never falls through to a different pending question.
   * Only an id-less reply falls back to the single pending question. Returns
   * false when nothing matched so the adapter can log the unrouted reply.
   */
  respondToQuestion(answer: string, requestId?: string): boolean {
    const id =
      requestId !== undefined
        ? this.pendingQuestions.has(requestId)
          ? requestId
          : undefined
        : this.pendingQuestions.size === 1
          ? [...this.pendingQuestions.keys()][0]
          : undefined;
    if (id === undefined) return false;
    const resolve = this.pendingQuestions.get(id)!;
    this.pendingQuestions.delete(id);
    resolve({ answer });
    return true;
  }

  /** Resolve all pending question gates as aborted (deny) so no gate hangs forever. */
  private cancelPendingQuestions(): void {
    const pending = [...this.pendingQuestions.values()];
    this.pendingQuestions.clear();
    for (const resolve of pending) resolve({ aborted: true });
  }

  /** Single demux loop over the persistent generator; routes each message to the active turn. */
  private consumeQuery(q: Query): void {
    const generation = this.queryGeneration;
    void this.consume(q, generation);
  }

  private async consume(q: Query, generation: number): Promise<void> {
    try {
      for await (const message of q) {
        // Ignore a superseded query's tail (a mid-session session-id swap opened a
        // newer one); it must not push to the new turn's stream or clear its state.
        if (this.queryGeneration !== generation) continue;
        this.currentStream?.push(message);
        if (message.type === "result") {
          this.activeTurn = false;
          this.detachAbort?.();
          this.detachAbort = null;
        }
      }
      this.onGeneratorEnd(q, generation, null);
    } catch (err) {
      this.onGeneratorEnd(q, generation, err);
    }
  }

  /**
   * Tear down the live query without failing the turn — used when the bridge
   * swaps the session id (agent-profile switch) and we must reopen on the new id.
   */
  private closeCurrentQuery(): void {
    this.detachAbort?.();
    this.detachAbort = null;
    this.activeTurn = false;
    this.cancelPendingQuestions();
    this.openingQuery = null;
    this.boundSessionId = null;
    const q = this.query;
    const input = this.inputStream;
    this.query = null;
    this.queryGeneration += 1;
    this.inputStream = null;
    this.currentModelId = undefined;
    this.currentEffort = undefined;
    input?.close();
    if (q) {
      void q.interrupt().catch(() => {});
      void q.return?.(undefined).catch(() => {});
    }
  }

  /** Handle the persistent generator ending — propagate failures, allow a later reopen. */
  private onGeneratorEnd(q: Query, generation: number, err: unknown): void {
    // A superseded query (replaced by a session-id swap) ended: ignore — its state
    // was already migrated to the new query by closeCurrentQuery.
    if (this.query !== q || this.queryGeneration !== generation) return;
    const wasActive = this.activeTurn;
    this.query = null;
    this.boundSessionId = null;
    this.currentModelId = undefined;
    this.currentEffort = undefined;
    this.activeTurn = false;
    this.detachAbort?.();
    this.detachAbort = null;
    this.cancelPendingQuestions();
    this.openingQuery = null;
    this.inputStream?.close();
    this.inputStream = null;

    if (this.shuttingDown) return;

    if (err || wasActive) {
      const message = err
        ? `Claude SDK session error: ${redact(String(err))}`
        : "Claude SDK session ended unexpectedly";
      this.deps.log.warn(
        { event: "claude.generator_end", error: err ? redact(String(err)) : null, wasActive },
        "Claude SDK message generator ended; failing the active turn",
      );
      this.currentStream?.pushSyntheticError(message);
    }
  }

  /** Abort the current turn only (the persistent query stays alive for the next turn). */
  abort(): void {
    this.detachAbort?.();
    this.detachAbort = null;
    this.activeTurn = false;
    this.cancelPendingQuestions();
    if (this.query) {
      void this.query.interrupt().catch((err: unknown) => {
        this.deps.log.info({ event: "claude.interrupt_error", error: redact(String(err)) }, "Claude interrupt failed");
      });
    }
    this.currentStream?.close();
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.ready = false;
    this.detachAbort?.();
    this.detachAbort = null;
    this.cancelPendingQuestions();
    this.openingQuery = null;
    this.inputStream?.close();
    if (this.query) {
      void this.query.interrupt().catch(() => {});
      void this.query.return?.(undefined).catch(() => {});
    }
    this.query = null;
    this.boundSessionId = null;
    this.currentModelId = undefined;
    this.currentEffort = undefined;
    this.currentStream?.close();
  }
}

function resolveClaudeEffort(variant: string | undefined): EffortLevel | undefined {
  if (!variant || variant === "none") return undefined;
  if (CLAUDE_EFFORT_LEVEL_SET.has(variant)) return variant as EffortLevel;
  throw new Error(`Unsupported Claude reasoning effort: ${variant}`);
}
