import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Config, createOpencode, type OpencodeClient } from "@opencode-ai/sdk";

import { OPENCODE_AGENT_RUNTIME_BACKEND } from "../../../../shared/agent/agent-runtime-backend.js";
import { BUILTIN_AGENTS, PLAN_AGENT_NAME } from "../../../../shared/agent/constants.js";
import type { AgentRole } from "../../../../shared/agent/schema.js";
import {
  BasetenModel,
  getModelDefinition,
  isModelAllowedForBackend,
  toModelSelection,
} from "../../../../shared/constants/models.js";
import type { MemoryRef, SandboxPromptActivityPhase } from "../../../../shared/events/bridge.js";
import type { BridgeLogger } from "../logger.js";
import { waitForAbortable } from "../utils/bridge-runtime.js";
import { buildAgentChildEnv } from "../utils/sanitized-env.js";
import type { Memory } from "./memory-ranking.js";
import {
  applyOpencodeFirstPartyDynamicToolsConfig,
  buildOpencodeFirstPartyDynamicToolsProjection,
  connectOpencodeFirstPartyDynamicTools,
  OPENCODE_AGENT_PROFILE_FILE_ENV,
  OPENCODE_MEMORY_CONTEXT_FILE_ENV,
  OPENCODE_MEMORY_TELEMETRY_FILE_ENV,
} from "./opencode-first-party-dynamic-tools.js";
import { OPENCODE_IMAGE_FEEDBACK_MODEL_ENV } from "./opencode-image-feedback.js";

const BASETEN_MODEL_API_BASE_URL = "https://inference.baseten.co/v1";
const BASETEN_API_KEY_ENV = "BASETEN_API_KEY";
export const OPENCODE_HEADLESS_PERMISSIONS = {
  edit: "ask",
  bash: "ask",
  webfetch: "ask",
} as const satisfies NonNullable<Config["permission"]>;

type OpencodeBridgeConfig = Config & {
  compaction: {
    tail_turns: number;
    preserve_recent_tokens: number;
  };
};

// OpenCode merges its global user ruleset after the native plan-agent rules and
// evaluates permissions with the last match. Without this per-agent override,
// OPENCODE_HEADLESS_PERMISSIONS.edit: "ask" would re-enable the plan agent's
// built-in edit/write/apply_patch tools that OpenCode's native plan agent denies.
const OPENCODE_PLAN_PERMISSIONS = {
  ...OPENCODE_HEADLESS_PERMISSIONS,
  edit: "deny",
} as const satisfies NonNullable<Config["permission"]>;

function withTemporaryProcessEnv<T>(env: Record<string, string>, work: () => T): T {
  const previousEnv = process.env;
  process.env = { ...env };
  try {
    return work();
  } finally {
    process.env = previousEnv;
  }
}

export function buildOpencodeAgentConfig(
  model: string,
  permission: NonNullable<Config["permission"]>,
): NonNullable<Config["agent"]> {
  return Object.fromEntries(
    Object.entries(BUILTIN_AGENTS).map(([name, agent]) => {
      const agentPermission = name === PLAN_AGENT_NAME ? OPENCODE_PLAN_PERMISSIONS : permission;
      return [name, { mode: "primary", model, description: agent.description, permission: agentPermission }];
    }),
  );
}

export interface OpencodeSessionManagerDeps {
  getCwd: () => string;
  log: BridgeLogger;
  startupTimeoutMs: number;
  getRepoMemories?: () => Memory[];
  getMemoryRefById?: () => ReadonlyMap<string, MemoryRef>;
  withPromptActivityPulse: <T>(
    promptId: string,
    phase: SandboxPromptActivityPhase,
    work: () => Promise<T>,
  ) => Promise<T>;
  adoptedExternalPr?: boolean;
}

export class OpencodeSessionManager {
  client: OpencodeClient | null = null;
  server: { url: string; close: () => void } | null = null;
  private readonly deps: OpencodeSessionManagerDeps;
  private initPromise: Promise<void> | null = null;
  private staticModel: string | undefined;
  private activeModelId: string | null = null;
  private activeAgentRole: AgentRole | null = null;
  private dynamicToolTempDir: string | null = null;
  private agentProfileFile: string | null = null;
  private memoryContextFile: string | null = null;
  private memoryTelemetryFile: string | null = null;

  constructor(deps: OpencodeSessionManagerDeps) {
    this.deps = deps;
  }

  parseModel(model: string): { providerID: string; modelID: string } {
    const selection = toModelSelection(model);
    if (
      !selection ||
      selection.providerID !== "baseten" ||
      !isModelAllowedForBackend(selection.modelID, OPENCODE_AGENT_RUNTIME_BACKEND)
    ) {
      throw new Error(`Unsupported opencode model '${model}'`);
    }
    return selection;
  }

  private parsePersistedModel(model: string): { providerID: string; modelID: string } {
    try {
      return this.parseModel(model);
    } catch (error) {
      const retiredModel = model.replace(/^baseten\//, "");
      if (
        retiredModel === "glm-4.7" ||
        retiredModel === "zai-org/GLM-4.7" ||
        retiredModel === "gpt-oss-120b" ||
        retiredModel === "openai/gpt-oss-120b"
      ) {
        return { providerID: "baseten", modelID: BasetenModel.KimiK27Code };
      }
      throw error;
    }
  }

  // The registry model id is slash-free (e.g. `kimi-k2.7-code`) for Cycloid's
  // provider/model parsing, but opencode must reference the namespaced Baseten
  // wire id (`moonshotai/Kimi-K2.7-Code`) - it is both the provider config models-map
  // key and the model sent to Baseten. Resolve registry id -> wire id here so
  // the prompt-dispatch path and the provider config stay in sync.
  toWireModelId(registryModelId: string): string {
    return getModelDefinition(registryModelId)?.providerModelId ?? registryModelId;
  }

  // Model identifier for opencode's `promptAsync` (provider + wire model id).
  resolveOpencodeModel(model: string): { providerID: string; modelID: string } {
    const selection = this.parseModel(model);
    return { providerID: selection.providerID, modelID: this.toWireModelId(selection.modelID) };
  }

  getRequestedModelInfo(model?: string): { providerID: string; modelID?: string } {
    if (model) return this.parseModel(model);
    return this.getEnvModelInfo();
  }

  getEnvModelInfo(): { providerID: string; modelID?: string } {
    const envModel = process.env.MODEL;
    const providerID = process.env.PROVIDER || "baseten";
    if (providerID !== "baseten") throw new Error(`Unsupported opencode provider '${providerID}'`);
    if (!envModel) return { providerID };
    return this.parseModel(envModel);
  }

  setStaticModel(model: string | undefined): void {
    this.staticModel = model;
  }

  private resolveRuntimeModelId(model: string | undefined): string {
    return model ? this.parsePersistedModel(model).modelID : BasetenModel.KimiK27Code;
  }

  private resolveRequestedRuntimeModelId(model: string | undefined): string {
    return this.resolveRuntimeModelId(model ?? this.staticModel);
  }

  assertPromptModelMatchesActiveRuntime(model: string | undefined): void {
    if (!model || !this.activeModelId) return;
    const promptModelId = this.parseModel(model).modelID;
    if (promptModelId !== this.activeModelId) {
      throw new Error(
        `Opencode prompt model '${promptModelId}' does not match initialized runtime model '${this.activeModelId}'`,
      );
    }
  }

  async ensureClientInitializedForPrompt(opts: {
    agentRole: AgentRole;
    model?: string;
    signal: AbortSignal;
    promptLog: BridgeLogger;
  }): Promise<void> {
    const requestedModelId = this.resolveRequestedRuntimeModelId(opts.model);
    while (true) {
      if (this.client) {
        if (this.activeAgentRole === opts.agentRole && this.activeModelId === requestedModelId) {
          this.writeMemoryContextFile();
          return;
        }
        this.closeRuntime();
      }

      if (this.initPromise) {
        await waitForAbortable(this.initPromise, opts.signal);
        continue;
      }

      const initPromise = this.initialize(opts.model ?? this.staticModel, opts.signal, opts.promptLog, opts.agentRole);
      this.initPromise = initPromise;
      try {
        await waitForAbortable(initPromise, opts.signal);
      } finally {
        if (this.initPromise === initPromise) this.initPromise = null;
      }
      return;
    }
  }

  private closeRuntime(): void {
    this.server?.close();
    this.server = null;
    this.client = null;
    this.activeAgentRole = null;
    this.activeModelId = null;
    this.cleanupDynamicToolSideChannel();
  }

  private async initialize(
    model: string | undefined,
    signal: AbortSignal,
    promptLog: BridgeLogger,
    agentRole: AgentRole,
  ): Promise<void> {
    const apiKey = process.env[BASETEN_API_KEY_ENV]?.trim();
    if (!apiKey) throw new Error("BASETEN_API_KEY is required for opencode");
    const { env: opencodeChildEnv } = buildAgentChildEnv(process.env, {
      providerKeys: { [BASETEN_API_KEY_ENV]: apiKey },
    });
    const selected = model
      ? this.parsePersistedModel(model)
      : { providerID: "baseten", modelID: BasetenModel.KimiK27Code };
    const definition = getModelDefinition(selected.modelID);
    // Baseten serves namespaced model ids (e.g. `moonshotai/Kimi-K2.7-Code`). The
    // registry id is slash-free to avoid colliding with provider/model
    // parsing, so resolve the real upstream wire id here.
    const wireModelId = this.toWireModelId(selected.modelID);
    const startedAt = Date.now();
    promptLog.info(
      { event: "opencode.runtime.start", startupTimeoutMs: this.deps.startupTimeoutMs, model: selected.modelID },
      "Opencode runtime startup started",
    );
    // Headless serve mode: opencode's `build` agent edit/bash/webfetch tools
    // default to "ask". The bridge auto-answers these permission requests via
    // the shared safety gate (resolveOpencodePermissionDecision), approving safe
    // operations and rejecting unsafe ones without surfacing human questions.
    // Run as a serve client to disable the question tool.
    opencodeChildEnv.OPENCODE_CLIENT = "serve";
    const dynamicToolSideChannelEnv = {
      ...this.prepareDynamicToolSideChannelEnv(),
      [OPENCODE_IMAGE_FEEDBACK_MODEL_ENV]: selected.modelID,
    };
    const firstPartyToolsProjection = buildOpencodeFirstPartyDynamicToolsProjection(
      process.env,
      dynamicToolSideChannelEnv,
      {
        agentRole,
        modelId: selected.modelID,
        emitUnsupported: (fields) => {
          promptLog.warn(fields, "Opencode desktop image feedback is unavailable");
        },
      },
    );
    const config: OpencodeBridgeConfig = {
      disabled_providers: [],
      enabled_providers: ["baseten"],
      compaction: {
        tail_turns: 4,
        preserve_recent_tokens: 30_000,
      },
      model: `baseten/${wireModelId}`,
      permission: OPENCODE_HEADLESS_PERMISSIONS,
      agent: buildOpencodeAgentConfig(`baseten/${wireModelId}`, OPENCODE_HEADLESS_PERMISSIONS),
      provider: {
        baseten: {
          id: "baseten",
          name: "Baseten",
          api: "openai",
          options: {
            apiKey,
            baseURL: BASETEN_MODEL_API_BASE_URL,
          },
          models: {
            [wireModelId]: {
              id: wireModelId,
              name: definition?.name ?? selected.modelID,
              tool_call: true,
              reasoning: true,
              limit: {
                context: definition?.contextWindow ?? 128_000,
                output: 32_000,
              },
            },
          },
        },
      },
    };
    applyOpencodeFirstPartyDynamicToolsConfig(config, firstPartyToolsProjection);

    // createOpencode's ServerOptions has no `cwd` field - opencode roots its
    // project at the server process's working directory. Without this chdir the
    // agent edits relative to the bridge's startup dir, not the repo clone, so
    // edits land outside the worktree and produce an empty git diff (no PR).
    // The bridge's own shell-outs pass explicit cwd, and a sandbox runs a single
    // backend, so changing the process cwd here is safe.
    process.chdir(this.deps.getCwd());
    // @opencode-ai/sdk 1.17.11 spawns the server subprocess synchronously inside
    // createOpencode before returning its Promise. The temporary env swap relies
    // on that observed behavior; re-audit this call before upgrading the SDK.
    const result = await withTemporaryProcessEnv(opencodeChildEnv, () =>
      createOpencode({
        port: 0,
        signal,
        timeout: this.deps.startupTimeoutMs,
        config,
      }),
    );
    try {
      await connectOpencodeFirstPartyDynamicTools({
        client: result.client,
        projection: firstPartyToolsProjection,
        signal,
      });
    } catch (err) {
      // createOpencode already booted the server subprocess; if the MCP handshake
      // fails we never store it on `this`, so close it here or it leaks for the
      // rest of the sandbox lifetime.
      result.server.close();
      throw err;
    }
    this.client = result.client;
    this.server = result.server;
    this.activeAgentRole = agentRole;
    this.activeModelId = selected.modelID;
    promptLog.info(
      { event: "opencode.runtime.ready", duration_ms: Date.now() - startedAt, serverUrl: result.server.url },
      "Opencode runtime startup completed",
    );
  }

  async createSessionForPrompt(opts: {
    messageId: string;
    promptLog: BridgeLogger;
    signal: AbortSignal;
  }): Promise<string> {
    if (!this.client) throw new Error("Opencode client not initialized");
    const result = await this.client.session.create({ signal: opts.signal });
    const data = "data" in result ? result.data : result;
    const id = (data as { id?: unknown }).id;
    if (typeof id !== "string" || !id) throw new Error("Opencode session.create did not return an id");
    return id;
  }

  shutdown(): void {
    this.closeRuntime();
  }

  drainMemoryTelemetry(): Record<string, unknown>[] {
    if (!this.memoryTelemetryFile) return [];
    try {
      const text = readFileSync(this.memoryTelemetryFile, "utf8");
      if (!text.trim()) return [];
      writeFileSync(this.memoryTelemetryFile, "", "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as unknown;
            return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  private prepareDynamicToolSideChannelEnv(): Record<string, string> {
    this.cleanupDynamicToolSideChannel();
    const dir = mkdtempSync(join(tmpdir(), "cycloid-opencode-tools-"));
    this.dynamicToolTempDir = dir;
    const contextFile = join(dir, "memory-context.json");
    const telemetryFile = join(dir, "memory-telemetry.jsonl");
    const agentProfileFile = join(dir, "agent-profile.txt");
    this.agentProfileFile = agentProfileFile;
    this.memoryContextFile = contextFile;
    writeFileSync(agentProfileFile, "", "utf8");
    this.writeMemoryContextFile();
    writeFileSync(telemetryFile, "", "utf8");
    this.memoryTelemetryFile = telemetryFile;
    return {
      [OPENCODE_MEMORY_CONTEXT_FILE_ENV]: contextFile,
      [OPENCODE_MEMORY_TELEMETRY_FILE_ENV]: telemetryFile,
      [OPENCODE_AGENT_PROFILE_FILE_ENV]: agentProfileFile,
    };
  }

  writeDynamicToolAgentProfile(agentProfile: string): void {
    if (!this.agentProfileFile) return;
    writeFileSync(this.agentProfileFile, agentProfile, "utf8");
  }

  private writeMemoryContextFile(): void {
    if (!this.memoryContextFile) return;
    const repoMemories = this.deps.getRepoMemories?.() ?? [];
    const memoryRefById = this.deps.getMemoryRefById?.();
    writeFileSync(
      this.memoryContextFile,
      JSON.stringify({
        repoMemories,
        memoryRefs: memoryRefById ? [...memoryRefById.entries()] : [],
      }),
      "utf8",
    );
  }

  private cleanupDynamicToolSideChannel(): void {
    if (!this.dynamicToolTempDir) return;
    try {
      rmSync(this.dynamicToolTempDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup.
    }
    this.dynamicToolTempDir = null;
    this.agentProfileFile = null;
    this.memoryContextFile = null;
    this.memoryTelemetryFile = null;
  }
}
