import type { AgentRole } from "../../../../shared/agent/schema.js";
import { toModelSelection, VALID_MODEL_IDS } from "../../../../shared/constants/models.js";
import type { SandboxPromptActivityPhase } from "../../../../shared/events/bridge.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { buildCodexConfig } from "../agent/codex-config.js";
import { type BridgeLogger, phaseLogFields } from "../logger.js";
import { waitForAbortable } from "../utils/bridge-runtime.js";
import { describeError } from "../utils/llm-errors.js";
import { CODEX_PROJECT_DOC_MAX_BYTES } from "../utils/project-doc-setup.js";
import type { ManagedMcpRuntimeServer } from "../utils/session-config.js";
import type {
  CodexBridgeClient as CodexClient,
  CreateCodexWithStdioOptions,
  CreateCodexWithStdioResult,
} from "./codex-server.js";
import type { RuntimeResourceSnapshot } from "./runtime-resource-snapshot.js";

// Precedence CYCLOID.md > AGENTS.md > CLAUDE.md. AGENTS.md is Codex's hardcoded
// primary; the CYCLOID.md rung is surfaced via the AGENTS.override.md symlink
// (see utils/project-doc-setup.ts). These fallbacks only fire when AGENTS.md is
// absent: CYCLOID.md leads, then the prior `CLAUDE.md > agents.md` order is kept
// intact so behavior is unchanged for repos without an CYCLOID.md.
const CODEX_PROJECT_DOC_FALLBACK_FILENAMES = ["CYCLOID.md", "CLAUDE.md", "agents.md"];
const CODEX_PROJECT_ROOT_MARKERS = [".git"];
// CODEX_PROJECT_DOC_MAX_BYTES is imported from project-doc-setup.ts so the Codex
// config ceiling and the bridge's over-budget warning share one source of truth.

export interface CodexSessionManagerDeps {
  createCodex: (opts: CreateCodexWithStdioOptions) => Promise<CreateCodexWithStdioResult>;
  getCwd: () => string;
  log: BridgeLogger;
  startupTimeoutMs: number;
  stdioLineMaxBytes: number;
  stdioSessionMaxBytes: number;
  logResourceSnapshot: (
    log: BridgeLogger,
    event: string,
    context?: Record<string, unknown>,
    before?: RuntimeResourceSnapshot,
  ) => RuntimeResourceSnapshot;
  withPromptActivityPulse: <T>(
    promptId: string,
    phase: SandboxPromptActivityPhase,
    work: () => Promise<T>,
  ) => Promise<T>;
  managedMcpServers?: ManagedMcpRuntimeServer[];
  useOpenAIFlexServiceTier?: boolean;
  adoptedExternalPr?: boolean;
}

/**
 * Owns the Codex client/server lifecycle, the per-prompt init latch, model
 * resolution (fail-closed), and Codex session creation. The session id, agent,
 * and first-prompt-in-session flag remain bridge-owned (read in many places,
 * including the stream loop) and are not duplicated here.
 */
export class CodexSessionManager {
  client: CodexClient | null = null;
  server: { url: string; close: () => void } | null = null;
  codexStaticConfig: { model?: string } = {};
  private codexInitPromise: Promise<void> | null = null;
  private activeAgentRole: AgentRole | null = null;
  private readonly deps: CodexSessionManagerDeps;

  constructor(deps: CodexSessionManagerDeps) {
    this.deps = deps;
  }

  /** Fail-closed model guard: only `openai/<known-model>` is accepted. */
  parseModel(model: string): { providerID: string; modelID: string } {
    const selection = toModelSelection(model);
    if (!selection || selection.providerID !== "openai" || !VALID_MODEL_IDS.has(selection.modelID)) {
      throw new Error(`Unsupported Codex model '${model}'`);
    }
    return selection;
  }

  /** Requested model takes precedence over the environment default. */
  getRequestedModelInfo(model?: string): { providerID: string; modelID?: string } {
    if (model) return this.parseModel(model);

    return this.getEnvModelInfo();
  }

  getEnvModelInfo(): { providerID: string; modelID?: string } {
    const envModel = process.env.MODEL;
    const envProvider = process.env.PROVIDER || "openai";
    if (envProvider !== "openai") {
      throw new Error(`Unsupported Codex provider '${envProvider}'`);
    }
    if (!envModel) return { providerID: "openai" };

    return this.parseModel(envModel);
  }

  private buildConfigForPrompt(selectedModel: string | undefined): Record<string, unknown> {
    return buildCodexConfig({
      selectedModel,
      projectDocFallbackFilenames: CODEX_PROJECT_DOC_FALLBACK_FILENAMES,
      projectRootMarkers: CODEX_PROJECT_ROOT_MARKERS,
      projectDocMaxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
      managedMcpServers: this.deps.managedMcpServers,
    });
  }

  /**
   * Ensure a Codex client exists before dispatching a prompt. The
   * `codexInitPromise` latch prevents a concurrent prompt from double-spawning
   * the runtime; a second caller awaits the in-flight init instead.
   */
  async ensureClientInitializedForPrompt(opts: {
    agentRole: AgentRole;
    model?: string;
    signal: AbortSignal;
    promptLog: BridgeLogger;
  }): Promise<void> {
    while (true) {
      if (this.client) {
        if (this.activeAgentRole === opts.agentRole) return;
        this.closeRuntime();
      }

      if (this.codexInitPromise) {
        await waitForAbortable(this.codexInitPromise, opts.signal);
        continue;
      }

      const initPromise = (async () => {
        const initStartedAt = Date.now();
        opts.promptLog.info(
          {
            event: "codex.init.start",
            hasExistingClient: !!this.client,
            hasExistingServer: !!this.server,
          },
          "Codex initialization started",
        );
        try {
          const serverInitStartedAt = Date.now();
          opts.promptLog.info(
            {
              event: "codex.runtime.start",
              startupTimeoutMs: this.deps.startupTimeoutMs,
            },
            "Codex runtime startup started",
          );
          await this.initializeCodex(
            this.buildConfigForPrompt(opts.model ?? this.codexStaticConfig.model),
            opts.signal,
            opts.agentRole,
          );
          opts.promptLog.info(
            {
              event: "codex.runtime.ready",
              duration_ms: Date.now() - serverInitStartedAt,
              totalInitDurationMs: Date.now() - initStartedAt,
              serverUrlPresent: !!this.server?.url,
            },
            "Codex runtime startup completed",
          );
        } catch (error) {
          opts.promptLog.warn(
            {
              event: "codex.init.failed",
              duration_ms: Date.now() - initStartedAt,
              error: stringifyError(error),
              errorDetails: describeError(error),
            },
            "Codex initialization failed",
          );
          throw error;
        }
      })();

      this.codexInitPromise = initPromise;

      try {
        await waitForAbortable(initPromise, opts.signal);
      } finally {
        if (this.codexInitPromise === initPromise) {
          this.codexInitPromise = null;
        }
      }

      return;
    }
  }

  private closeRuntime(): void {
    this.server?.close();
    this.client = null;
    this.server = null;
    this.activeAgentRole = null;
  }

  private async initializeCodex(
    opcodeConfig: Record<string, unknown>,
    signal: AbortSignal,
    agentRole: AgentRole,
  ): Promise<void> {
    const startedAt = Date.now();
    const opcodeOpts = {
      signal,
      agentRole,
      adoptedExternalPr: this.deps.adoptedExternalPr,
      port: 0,
      cwd: this.deps.getCwd(),
      timeout: this.deps.startupTimeoutMs,
      stdioLineMaxBytes: this.deps.stdioLineMaxBytes,
      stdioSessionMaxBytes: this.deps.stdioSessionMaxBytes,
      // opcodeConfig is built from `opts.model ?? codexStaticConfig.model`, so its
      // model key always overrides codexStaticConfig's only key — pass it directly.
      config: opcodeConfig,
      useOpenAIFlexServiceTier: this.deps.useOpenAIFlexServiceTier === true,
    };

    this.deps.log.info(
      {
        event: "codex.runtime.init_start",
        model: (opcodeOpts.config as { model?: unknown }).model,
        requestedServiceTier: opcodeOpts.useOpenAIFlexServiceTier ? "flex" : null,
      },
      "Codex runtime initialization started",
    );

    const resourceSnapshotBeforeInit = this.deps.logResourceSnapshot(
      this.deps.log,
      "runtime.resource_snapshot.codex_runtime_init_start",
      {
        phase: "codex_runtime_init_start",
      },
    );

    const result = await this.deps.createCodex(opcodeOpts);
    this.client = result.client;
    this.server = result.server;
    this.activeAgentRole = agentRole;
    this.deps.log.info(
      {
        event: "codex.runtime.init_complete",
        duration_ms: Date.now() - startedAt,
        serverUrl: result.server.url,
      },
      "Codex runtime initialization completed",
    );
    this.deps.logResourceSnapshot(
      this.deps.log,
      "runtime.resource_snapshot.codex_runtime_init_complete",
      {
        phase: "codex_runtime_init_complete",
        duration_ms: Date.now() - startedAt,
      },
      resourceSnapshotBeforeInit,
    );
  }

  async createCodexSessionForPrompt(opts: {
    messageId: string;
    promptLog: BridgeLogger;
    signal: AbortSignal;
  }): Promise<string> {
    const { messageId, promptLog } = opts;
    if (!this.client) throw new Error("Codex client not initialized");

    const sessionCreateStartedAt = Date.now();
    const sessionCreateResourceSnapshot = this.deps.logResourceSnapshot(
      promptLog,
      "runtime.resource_snapshot.session_create_start",
      { phase: "session_create_start" },
    );
    promptLog.info(
      phaseLogFields("agent.session.create", {
        step: "create",
        phase_status: "started",
        hasClient: !!this.client,
      }),
      "Codex session creation started",
    );

    const session = await this.deps.withPromptActivityPulse(messageId, "session_creating", () =>
      waitForAbortable(this.client!.session.create({ body: { title: "Cycloid Session" } }), opts.signal),
    );
    if (!session.data) throw new Error("Failed to create Codex session");

    this.deps.logResourceSnapshot(
      promptLog,
      "runtime.resource_snapshot.session_create_complete",
      {
        phase: "session_create_complete",
        duration_ms: Date.now() - sessionCreateStartedAt,
      },
      sessionCreateResourceSnapshot,
    );
    promptLog.info(
      phaseLogFields("agent.session.create", {
        step: "create",
        phase_status: "completed",
        duration_ms: Date.now() - sessionCreateStartedAt,
        codexSessionId: session.data.id,
      }),
      "Codex session creation completed",
    );

    return session.data.id;
  }
}
