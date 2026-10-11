import { homedir } from "os";
import { join } from "path";

import {
  type AgentRuntimeBackend,
  OPENCODE_AGENT_RUNTIME_BACKEND,
} from "../../../../shared/agent/agent-runtime-backend.js";
import type { AgentRole } from "../../../../shared/agent/schema.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { SANDBOX_BRIDGE_RUNTIME_CONFIG } from "../config/runtime.js";
import { buildSessionStaticBehavioralGuidance } from "../constants/bridge.js";
import { type BridgeLogger, phaseLogFields } from "../logger.js";
import type { PromptLoopState } from "../prompt-loop-state.js";
import type { TranslateEventDeps, TranslateOutcome } from "../services/event-translator.js";
import {
  getAvailableFirstPartyDynamicToolNames,
  getFirstPartyDynamicToolPlanMode,
} from "../services/first-party-dynamic-tools.js";
import { translateOpencodeEvent } from "../services/opencode-event-translator.js";
import { OPENCODE_IMAGE_INPUT_MAX_BYTES } from "../services/opencode-image-feedback.js";
import { OpencodeSessionManager } from "../services/opencode-session.js";
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
  PromptPart,
  PromptRequest,
  QuestionReplyBridgeDeps,
  RuntimeWarmupOptions,
  RuntimeWarmupResult,
} from "./agent-runtime-adapter.js";

const SUPPORTED_OPENCODE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const OPENCODE_PERMISSION_REPLY_TIMEOUT_MS = 10_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          onTimeout();
          reject(new Error(`Opencode permission reply timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    void promise.catch(() => {});
  }
}

function estimateBase64Bytes(data: string): number {
  const cleaned = data.replace(/\s/g, "");
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  return Math.floor((cleaned.length * 3) / 4) - padding;
}

function validateOpencodeImagePart(part: Extract<PromptPart, { type: "file" }>): void {
  if (!SUPPORTED_OPENCODE_IMAGE_MIME_TYPES.has(part.mime)) {
    throw new Error(`Opencode image input does not support MIME type '${part.mime}' for '${part.filename}'`);
  }
  const dataUrlMatch = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(part.url);
  if (!dataUrlMatch) return;
  const dataUrlMime = dataUrlMatch[1];
  if (dataUrlMime !== part.mime) {
    throw new Error(
      `Opencode image input MIME mismatch for '${part.filename}': part declares '${part.mime}' but data URL is '${dataUrlMime}'`,
    );
  }
  const sizeBytes = estimateBase64Bytes(dataUrlMatch[2]);
  if (sizeBytes > OPENCODE_IMAGE_INPUT_MAX_BYTES) {
    throw new Error(
      `Opencode image input '${part.filename}' is ${sizeBytes} bytes, above the ${OPENCODE_IMAGE_INPUT_MAX_BYTES} byte limit`,
    );
  }
}

function toOpencodePromptPart(part: PromptPart) {
  if (part.type === "text") {
    return { type: "text" as const, text: part.text, ...(part.synthetic ? { synthetic: true } : {}) };
  }
  validateOpencodeImagePart(part);
  return {
    type: "file" as const,
    mime: part.mime,
    filename: part.filename,
    url: part.url,
  };
}

// opencode persists session state under its XDG data dir (`opencode.db` + WAL
// sidecars + `snapshot/`/`storage/`). Credentials (`auth.json`) can share this
// dir, so the rollout excludes it defensively - verified (2026-06-30) that the
// headless serve path injects the Baseten key via SDK config and never writes
// auth.json, but the exclude fails safe if a future opencode does. `bin`/`log`/
// `cache` are regenerable per-sandbox and excluded to keep the archive small.
const OPENCODE_STATE_SUBDIR = "opencode";
const OPENCODE_ROLLOUT_EXCLUDES = ["auth.json", "bin", "log", "cache"];

export class OpencodeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly backend: AgentRuntimeBackend = OPENCODE_AGENT_RUNTIME_BACKEND;
  readonly harnessKind = "codex-session";
  readonly promptStartTimeoutMs = SANDBOX_BRIDGE_RUNTIME_CONFIG.promptLoop.promptStartTimeoutMs;
  readonly rawFallbackPrefix = "opencode";
  private readonly session: OpencodeSessionManager;
  private readonly deps: AgentRuntimeAdapterDeps;
  private activeSessionId: string | null = null;
  // Watermark of the newest rollout file mtime already uploaded, so we skip the
  // tar+upload when a prompt produced no new opencode state.
  private lastRolloutMtimeMs = 0;
  // Serializes mid-turn periodic persists against the end-of-turn persist so two
  // concurrent uploads never race the per-session rollout blob.
  private readonly persistRollout = createCoalescingPersister();

  constructor(deps: AgentRuntimeAdapterDeps) {
    this.deps = deps;
    this.session = new OpencodeSessionManager({
      getCwd: deps.getCwd,
      log: deps.log,
      startupTimeoutMs: deps.startupTimeoutMs,
      ...(deps.getRepoMemories ? { getRepoMemories: deps.getRepoMemories } : {}),
      ...(deps.getMemoryRefById ? { getMemoryRefById: deps.getMemoryRefById } : {}),
      withPromptActivityPulse: deps.withPromptActivityPulse,
      adoptedExternalPr: deps.adoptedExternalPr,
    });
  }

  get isInitialized(): boolean {
    return this.session.client != null && this.session.server != null;
  }

  parseModel(model: string) {
    return this.session.parseModel(model);
  }

  getRequestedModelInfo(model?: string): { providerID: string; modelID?: string } {
    return this.session.getRequestedModelInfo(model);
  }

  getEnvModelInfo(): { providerID: string; modelID?: string } {
    return this.session.getEnvModelInfo();
  }

  setStaticModel(model: string | undefined): void {
    this.session.setStaticModel(model);
  }

  async warmup(_opts: RuntimeWarmupOptions): Promise<RuntimeWarmupResult> {
    return { outcome: "skipped", reason: "not_supported", duration_ms: 0 };
  }

  ensureClientInitializedForPrompt(opts: {
    agentRole: AgentRole;
    model?: string;
    signal: AbortSignal;
    promptLog: import("../logger.js").BridgeLogger;
  }): Promise<void> {
    return this.session.ensureClientInitializedForPrompt(opts);
  }

  async createSessionForPrompt(opts: {
    messageId: string;
    promptLog: import("../logger.js").BridgeLogger;
    signal: AbortSignal;
  }): Promise<string> {
    const id = await this.session.createSessionForPrompt(opts);
    this.activeSessionId = id;
    return id;
  }

  async subscribeEvents(): Promise<{ stream: EventStream }> {
    if (!this.session.client) throw new Error("Opencode client not initialized");
    return this.session.client.event.subscribe();
  }

  // Async so a synchronous throw (client not initialized, or image validation in
  // toOpencodePromptPart) surfaces as a rejected promise. runDispatchPhase only
  // closes the event stream from the returned promise's `.catch()`; a sync throw
  // would bypass that and leak the subscribed stream.
  async sendPrompt(
    request: PromptRequest,
    opts: { sessionId: string; signal: AbortSignal; promptLog: BridgeLogger },
  ): Promise<unknown> {
    if (!this.session.client) throw new Error("Opencode client not initialized");
    this.session.writeDynamicToolAgentProfile(request.agent);
    this.session.assertPromptModelMatchesActiveRuntime(request.model);
    const model = request.model ? this.session.resolveOpencodeModel(request.model) : undefined;
    const system = [
      buildSessionStaticBehavioralGuidance({
        agentRole: request.agentRole,
        adoptedExternalPr: this.deps.adoptedExternalPr === true,
        dynamicToolNames: getAvailableFirstPartyDynamicToolNames(process.env, { agentRole: request.agentRole }),
      }),
      request.system,
    ]
      .filter((section): section is string => Boolean(section))
      .join("\n\n");
    return await this.session.client.session.promptAsync({
      signal: opts.signal,
      path: { id: opts.sessionId },
      body: {
        ...(model ? { model } : {}),
        agent: request.agent,
        system,
        parts: request.parts.map(toOpencodePromptPart),
      },
    });
  }

  translateEvent(
    event: ExtendedEvent,
    deps: TranslateEventDeps,
    loopState: PromptLoopState,
    promptState: PromptExecutionState,
    toolTracker: ToolPartTracker,
  ): Promise<TranslateOutcome> {
    if (!this.activeSessionId) throw new Error("Opencode session not initialized");
    const reviewLoop = this.deps.getReviewLoopContext?.();
    return translateOpencodeEvent(
      event as unknown as Record<string, unknown>,
      {
        ...deps,
        opencodeSessionId: this.activeSessionId,
        safetyOptions: {
          worktreeRoot: this.deps.getCwd(),
          reviewLoopMode: reviewLoop?.reviewLoopMode ?? false,
          ...(reviewLoop?.reviewLoopSourceKind ? { reviewLoopSourceKind: reviewLoop.reviewLoopSourceKind } : {}),
          ...(reviewLoop?.agentProfile ? { agentProfile: reviewLoop.agentProfile } : {}),
          ...(reviewLoop?.cycloidCliAuthState ? { cycloidCliAuthState: reviewLoop.cycloidCliAuthState } : {}),
          hasReadOnlyOsSandbox: false,
          getPlanModeToolDisposition: getFirstPartyDynamicToolPlanMode,
        },
        respondToPermission: (sessionId, permissionId, response) =>
          this.respondToPermission(sessionId, permissionId, response, deps.promptLog),
        drainMemoryTelemetry: () => this.session.drainMemoryTelemetry(),
      },
      loopState,
      promptState,
      toolTracker,
    );
  }

  abortSession(sessionId: string): Promise<unknown> {
    if (!this.session.client) return Promise.resolve(undefined);
    return this.session.client.session.abort({ path: { id: sessionId } });
  }

  async prepareSessionRestore(opts: { restorableSessionId: string; promptLog: BridgeLogger }): Promise<void> {
    // Cold resume: restore the persisted opencode data dir before the server
    // boots, so the resumeSession() lookup below finds the thread in `opencode.db`.
    await prepareStateRolloutRestore(this.rolloutPort(opts.promptLog), {
      restorableSessionId: opts.restorableSessionId,
      promptLog: opts.promptLog,
      setLastRolloutMtimeMs: (value) => {
        this.lastRolloutMtimeMs = value;
      },
      messages: {
        skippedLocal: "Skipping opencode rollout restore; on-disk state is present",
        restoreError: "Opencode rollout restore error",
        restoreMissing: "Cold resume expected an opencode rollout but none was restored",
      },
    });
  }

  async resumeSession(opts: {
    restorableSessionId: string;
    signal: AbortSignal;
    promptLog: BridgeLogger;
  }): Promise<{ sessionId: string } | null> {
    if (!this.session.client) throw new Error("Opencode client not initialized");
    const { restorableSessionId, promptLog } = opts;
    const restoreStartedAt = Date.now();
    promptLog.info(
      phaseLogFields("agent.session.create", {
        step: "restore",
        phase_status: "started",
        restorableSessionId,
      }),
      "Opencode session restore started",
    );
    try {
      const existing = await this.session.client.session.get({ path: { id: restorableSessionId } });
      const data = existing && "data" in existing ? existing.data : existing;
      if (data && typeof (data as { id?: unknown }).id === "string") {
        // Re-prompting this id (not session.create) continues the thread. The
        // translator keys off activeSessionId, which createSessionForPrompt
        // normally sets - but that path is skipped on resume, so set it here.
        this.activeSessionId = restorableSessionId;
        promptLog.info(
          phaseLogFields("agent.session.create", {
            step: "restore",
            phase_status: "completed",
            duration_ms: Date.now() - restoreStartedAt,
            opencodeSessionId: restorableSessionId,
          }),
          "Restored opencode session from volume",
        );
        return { sessionId: restorableSessionId };
      }
      // session.get resolved but carried no usable id (e.g. `{}` or a changed
      // SDK response envelope). Without this the degradation is invisible - the
      // only failure log lives in the catch below.
      promptLog.warn(
        phaseLogFields("agent.session.create", {
          step: "restore",
          phase_status: "failed",
          duration_ms: Date.now() - restoreStartedAt,
          restorableSessionId,
        }),
        "Opencode session.get returned no valid id; creating new session",
      );
    } catch (error) {
      promptLog.warn(
        phaseLogFields("agent.session.create", {
          step: "restore",
          phase_status: "failed",
          duration_ms: Date.now() - restoreStartedAt,
          error: stringifyError(error),
        }),
        "Stored opencode session not found, creating new",
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
      eventPrefix: "opencode_rollout",
      errorMessage: "Opencode rollout upload error",
    });
  }

  private rolloutPort(log: BridgeLogger): StateRolloutPort {
    return {
      // opencode resolves its data dir as `$XDG_DATA_HOME/opencode` (default
      // `~/.local/share/opencode`); it shares the bridge process env, so this
      // matches wherever the opencode server actually writes.
      stateRoot: process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"),
      subdir: OPENCODE_STATE_SUBDIR,
      excludes: OPENCODE_ROLLOUT_EXCLUDES,
      eventPrefix: "opencode_rollout",
      rolloutUrl: this.deps.getRolloutUploadUrl(),
      getSandboxToken: () => this.deps.getSandboxToken(),
      fetch: globalThis.fetch,
      log,
    };
  }

  respondToQuestion(deps: QuestionReplyBridgeDeps, answer: string, requestId?: string): void {
    if (!this.session.client || !this.activeSessionId) throw new Error("Opencode session not initialized");
    if (!requestId) throw new Error("Opencode permission reply requires a question id");
    if (deps.isQuestionResolved(requestId)) {
      deps.log.debug({ requestId }, "Ignoring redelivered opencode permission reply");
      return;
    }
    const normalizedAnswer = answer.trim().toLowerCase();
    // Fail closed on a permission gate: only an explicit approve maps to "once".
    // Anything else - a differently worded denial, an ambiguous string, or an
    // empty answer - rejects rather than silently approving.
    const response = /^(approve|allow|yes|once|ok|true|1)\b/.test(normalizedAnswer) ? "once" : "reject";
    // Mark resolved synchronously, before the request, so a redelivered answer
    // arriving while this POST is still in flight is suppressed by the guard
    // above (which otherwise only sees the resolved marker after `.then`).
    deps.markQuestionResolved(requestId);
    void this.session.client
      .postSessionIdPermissionsPermissionId({
        path: { id: this.activeSessionId, permissionID: requestId },
        body: { response },
      })
      .catch((error: unknown) => {
        deps.log.error(
          { err: error, requestId, response, event: "opencode.permission.reply_failed" },
          "Failed to reply to opencode permission request",
        );
      });
  }

  private async respondToPermission(
    sessionId: string,
    permissionId: string,
    response: "once" | "reject",
    log: BridgeLogger,
  ): Promise<void> {
    if (!this.session.client || !this.activeSessionId) throw new Error("Opencode session not initialized");
    const startedAt = Date.now();
    try {
      await withTimeout(
        this.session.client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: permissionId },
          body: { response },
        }),
        OPENCODE_PERMISSION_REPLY_TIMEOUT_MS,
        () => {
          log.error(
            {
              event: "opencode.permission.reply_timeout",
              permissionId,
              response,
              duration_ms: Date.now() - startedAt,
              timeout_ms: OPENCODE_PERMISSION_REPLY_TIMEOUT_MS,
            },
            "Opencode permission reply timed out",
          );
        },
      );
    } catch (error) {
      log.error(
        { err: error, permissionId, response, event: "opencode.permission.auto_reply_failed" },
        "Failed to auto-reply to opencode permission request",
      );
      throw error;
    }
  }

  shutdown(): void {
    this.session.shutdown();
  }
}
