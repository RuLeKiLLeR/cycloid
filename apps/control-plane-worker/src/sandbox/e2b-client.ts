import type { SandboxInfo } from "e2b";

import type { SandboxRuntimeProvider } from "../../../../shared/types/sandbox.js";
import { createLogger, type Logger } from "../logger";
import type { SandboxProviderClient } from "./provider-client";

const E2B_REFRESH_MAX_SECONDS = 3_600;

/**
 * Why the control plane asked E2B to kill a sandbox. The E2B orchestrator logs
 * a flat `kill_reason: 'request'` for every API-initiated kill, so this is the
 * only place the originating code path is captured. Add a value here when you
 * add a new `terminateSandbox` call site; never reuse a loosely-related one.
 */
export type SandboxTerminateReason =
  | "orphan_reaper"
  | "runtime_cleanup"
  // R4: a FINAL-terminal session (merged/closed/superseded/verifier-kill archive) reclaiming its
  // own runtime VM through the DO cleanup-run workflow instead of parking it paused for 72h.
  | "session_terminal"
  | "duplicate_spawn_retry"
  | "superseded_runtime"
  | "resume_stale_cleanup"
  | "resume_failure_cleanup"
  | "cold_create_unusable"
  | "bridge_start_failed"
  | "stale_spawn_after_bridge"
  | "sandbox_layer_smoke"
  | "business_offboarding";

export type E2BSandboxRuntimeErrorCode =
  | "missing_config"
  | "auth"
  | "quota"
  | "rate_limit"
  | "missing_template"
  | "missing_sandbox"
  | "timeout"
  | "killed"
  | "network_policy"
  | "network"
  // Provider VM/host state that clears on its own shortly (e.g. Freestyle
  // VM_IS_SUSPENDING while a suspend completes). Transient and retryable —
  // MUST stay in RETRYABLE_SANDBOX_SPAWN_ERROR_CODES or a resume that races a
  // suspend hard-fails the prompt (ARC-1479).
  | "not_ready"
  | "unknown";

// Single source for "this sandbox runtime error is worth retrying the spawn":
// both the in-place create retry (durable-object createRuntimeSandboxForSpawn)
// and the prompt-level spawn retry (prompt-queue isRetryableSpawnFailure) key on
// this set. Typed ReadonlySet<string> so callers can pass an unvalidated code
// string; the satisfies clause pins every member to the real code union.
export const RETRYABLE_SANDBOX_SPAWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "network",
  "timeout",
  "rate_limit",
  "not_ready",
  "unknown",
] satisfies E2BSandboxRuntimeErrorCode[]);

export class E2BSandboxRuntimeError extends Error {
  readonly code: E2BSandboxRuntimeErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly requestSent: boolean;

  constructor(
    message: string,
    options: {
      code: E2BSandboxRuntimeErrorCode;
      status?: number;
      retryAfterMs?: number;
      requestSent: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "E2BSandboxRuntimeError";
    this.code = options.code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.requestSent = options.requestSent;
    this.cause = options.cause;
  }
}

// Per-repo VM resource sizing resolved from the repo sandbox spec. E2B bakes sizing
// into the `template` id (mem<MB>-cpu<N>) and IGNORES this field; the Freestyle client
// maps it onto vms.create (memSizeGb/vcpuCount/rootfsSizeGb). Present ONLY for repos
// with an explicit spec — unspecced repos omit it so the Freestyle create stays on the
// base snapshot's baked sizing (unchanged behavior).
export type SandboxResourceSpec = {
  cpuCount: number;
  memoryMB: number;
  // Rootfs disk in whole GiB; omit to keep the snapshot's rootfs.
  diskGB?: number;
};

export type E2BCreateSandboxRequest = {
  sessionId?: string;
  sandboxId: string;
  template: string;
  timeoutMs: number;
  envs: Record<string, string>;
  metadata: Record<string, string>;
  allowInternetAccess?: boolean;
  network?: {
    allowPublicTraffic: boolean;
    allowOut?: string[];
    denyOut?: string[];
  };
  resources?: SandboxResourceSpec;
  // Freestyle-only: per-repo prebaked snapshot to boot instead of the client's default
  // base snapshot (resolved from FREESTYLE_REPO_SNAPSHOT_MAP_JSON). Deliberately
  // separate from `template`, which carries E2B template ids that must never reach
  // a Freestyle create. The E2B client ignores it.
  freestyleSnapshotId?: string;
};

export type E2BCreateSandboxResponse = {
  // Honest vendor tag of the runtime that produced this response. The E2B client
  // returns "e2b"; the Freestyle client (which reuses this response shape) returns
  // "freestyle". Widened from the old `"e2b"` literal so a second provider's honest
  // return typechecks; this value is telemetry-only and not the persistence source
  // (the spawn-persist derives `runtime_provider` from `runtime_backend`).
  runtimeProvider: SandboxRuntimeProvider;
  runtimeSandboxId: string;
  runtimeTemplateId: string;
  status: "running" | "paused" | "unknown";
  createdAt: number;
  // Wall-clock duration of the underlying `Sandbox.create` call (E2B microVM
  // allocation + boot). Surfaced for spawn-latency instrumentation so the
  // control plane can attribute cold-spawn time to E2B create vs. repo prep.
  createDurationMs: number;
};

export type E2BListedSandbox = {
  runtimeSandboxId: string;
  runtimeTemplateId: string;
  status: "running" | "paused" | "unknown";
  createdAt: number;
  metadata: Record<string, string>;
};

// Liveness probe result. `missing` means the provider has no such sandbox
// (definitively dead). `unknown` means we could not determine liveness (timeout,
// auth, network, classification miss) — callers MUST fail toward their existing
// terminate/clear behavior on `unknown` so a flaky probe can never leak a VM.
// `rawState` preserves the raw SDK `info.state` on any classification-miss branch:
// on `unknown` (state was neither running nor paused) and on a live-biased read
// (Freestyle maps an unrecognized state on an existing VM to `paused` — ARC-1478);
// without it the dropped state string is lost above this layer and a "we killed our
// own" vs "genuine drop" vs "state-map drift" diagnosis cannot read what the
// provider actually reported.
export type E2BSandboxInfoResult =
  | { status: "running" | "paused"; rawState?: string }
  | { status: "missing" }
  | { status: "unknown"; errorCode: E2BSandboxRuntimeErrorCode; rawState?: string };

export class E2BConnectedSandbox {
  constructor(readonly runtimeSandboxId: string) {}
}

export type E2BSandboxPortConnection = {
  runtimeProvider: "e2b";
  runtimeSandboxId: string;
  port: number;
  host: string;
  trafficAccessToken: string | null;
};

type CommandRequestBase = {
  runtimeSandboxId: string;
  command: string;
  cwd?: string;
  envs?: Record<string, string>;
};

export type RunCommandRequest = CommandRequestBase & {
  timeoutMs?: number;
};

export type RunCommandResult = { exitCode: number; stdout: string; stderr: string };

export type StartCommandRequest = CommandRequestBase;

export type E2BClientConfig = {
  apiKey?: string;
  domain?: string;
  defaultTemplate?: string;
  logger?: Logger;
};

type E2BCommandOptions = {
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  background?: true;
};

type E2BCommandResultLike = {
  pid?: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

type E2BSandboxHandle = {
  sandboxId: string;
  getHost(port: number): string;
  setTimeout(timeoutMs: number): Promise<unknown>;
  trafficAccessToken?: string | null;
  commands: {
    run(command: string, options: E2BCommandOptions): Promise<E2BCommandResultLike>;
  };
};

type E2BSandboxPaginator = {
  hasNext: boolean;
  nextItems(): Promise<SandboxInfo[]>;
};

type E2BSandboxSdk = {
  create(
    template: string,
    options: {
      apiKey: string;
      domain?: string;
      timeoutMs: number;
      lifecycle: { onTimeout: "pause"; autoResume: false };
      envs?: Record<string, string>;
      metadata: Record<string, string>;
      allowInternetAccess?: boolean;
      network?: {
        allowPublicTraffic: boolean;
        allowOut?: string[];
        denyOut?: string[];
      };
    },
  ): Promise<E2BSandboxHandle>;
  list(options: {
    apiKey: string;
    domain?: string;
    query: {
      metadata: { runtime_provider: "e2b" };
      state: Array<"running" | "paused">;
    };
  }): E2BSandboxPaginator;
  connect(
    runtimeSandboxId: string,
    options: { apiKey: string; domain?: string; timeoutMs?: number },
  ): Promise<E2BSandboxHandle>;
  setTimeout(
    runtimeSandboxId: string,
    timeoutMs: number,
    options: { apiKey: string; domain?: string },
  ): Promise<unknown>;
  pause(runtimeSandboxId: string, options: { apiKey: string; domain?: string }): Promise<unknown>;
  kill(runtimeSandboxId: string, options: { apiKey: string; domain?: string }): Promise<boolean>;
  getInfo(
    runtimeSandboxId: string,
    options: { apiKey: string; domain?: string; requestTimeoutMs?: number },
  ): Promise<SandboxInfo>;
};

let sandboxSdkPromise: Promise<E2BSandboxSdk> | null = null;

async function loadSandboxSdk(): Promise<E2BSandboxSdk> {
  sandboxSdkPromise ??= import("e2b").then((module) => module.Sandbox as E2BSandboxSdk);
  return sandboxSdkPromise;
}

export class E2BSandboxClient implements SandboxProviderClient {
  private readonly apiKey?: string;
  private readonly domain?: string;
  private readonly defaultTemplate?: string;
  private readonly logger: Logger;

  constructor(config: E2BClientConfig) {
    this.apiKey = config.apiKey;
    this.domain = config.domain?.trim() || undefined;
    this.defaultTemplate = config.defaultTemplate;
    this.logger = config.logger ?? createLogger({ bindings: { component: "e2b-sandbox-client" } });
  }

  async createSandbox(request: E2BCreateSandboxRequest): Promise<E2BCreateSandboxResponse> {
    const templateForError = request.template || this.defaultTemplate;
    return this.withRuntimeErrors(
      "createSandbox",
      undefined,
      async () => {
        const Sandbox = await loadSandboxSdk();
        const connection = this.requireConnectionOptions();
        const template = templateForError;
        if (!template) throw missingConfig("E2B sandbox template is required");
        validatePositiveMs(request.timeoutMs, "E2B sandbox timeout");
        const metadata = {
          ...request.metadata,
          ...(request.sessionId ? { session_id: request.sessionId } : {}),
          sandbox_id: request.sandboxId,
          runtime_provider: "e2b",
          template,
        };
        const createStartedAt = Date.now();
        const sandbox = await Sandbox.create(template, {
          ...connection,
          timeoutMs: request.timeoutMs,
          lifecycle: {
            onTimeout: "pause",
            autoResume: false,
          },
          envs: request.envs,
          metadata,
          ...(request.allowInternetAccess !== undefined ? { allowInternetAccess: request.allowInternetAccess } : {}),
          ...(request.network ? { network: request.network } : {}),
        });
        const createdAt = Date.now();
        return {
          runtimeProvider: "e2b",
          runtimeSandboxId: sandbox.sandboxId,
          runtimeTemplateId: template,
          status: "running",
          createdAt,
          createDurationMs: createdAt - createStartedAt,
        };
      },
      { runtimeSandboxIdFromResult: (result) => result.runtimeSandboxId, template: templateForError },
    );
  }

  async listCycloidSandboxes(): Promise<E2BListedSandbox[]> {
    return this.withRuntimeErrors("listSandboxes", undefined, async () => {
      const Sandbox = await loadSandboxSdk();
      const connection = this.requireConnectionOptions();
      const paginator = Sandbox.list({
        ...connection,
        query: {
          metadata: { runtime_provider: "e2b" },
          state: ["running", "paused"],
        },
      });
      const sandboxes: E2BListedSandbox[] = [];
      while (paginator.hasNext) {
        const page = await paginator.nextItems();
        sandboxes.push(...page.map(listedSandboxToRuntime));
      }
      return sandboxes;
    });
  }

  async connectSandbox(runtimeSandboxId: string, timeoutMs: number): Promise<E2BConnectedSandbox> {
    return this.withRuntimeErrors("connectSandbox", runtimeSandboxId, async () => {
      const Sandbox = await loadSandboxSdk();
      const connection = this.requireConnectionOptions();
      validateSandboxId(runtimeSandboxId);
      validatePositiveMs(timeoutMs, "E2B sandbox timeout");
      const sandbox = await Sandbox.connect(runtimeSandboxId, {
        ...connection,
        timeoutMs,
      });
      await sandbox.setTimeout(timeoutMs);
      return new E2BConnectedSandbox(runtimeSandboxId);
    });
  }

  async resolveSandboxPort(
    runtimeSandboxId: string,
    port: number,
    timeoutMs: number,
  ): Promise<E2BSandboxPortConnection> {
    return this.withRuntimeErrors("resolveSandboxPort", runtimeSandboxId, async () => {
      const Sandbox = await loadSandboxSdk();
      const connection = this.requireConnectionOptions();
      validateSandboxId(runtimeSandboxId);
      validatePositiveMs(timeoutMs, "E2B sandbox timeout");
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new E2BSandboxRuntimeError("Invalid sandbox port", {
          code: "unknown",
          requestSent: false,
        });
      }
      const sandbox = await Sandbox.connect(runtimeSandboxId, {
        ...connection,
        timeoutMs,
      });
      await sandbox.setTimeout(timeoutMs);
      return {
        runtimeProvider: "e2b",
        runtimeSandboxId,
        port,
        host: sandbox.getHost(port),
        trafficAccessToken: sandbox.trafficAccessToken ?? null,
      };
    });
  }

  async refreshSandbox(
    runtimeSandboxId: string,
    durationMs: number,
  ): Promise<{ status: "refreshed"; refreshedUntil?: number | null }> {
    return this.withRuntimeErrors("refreshSandbox", runtimeSandboxId, async () => {
      const Sandbox = await loadSandboxSdk();
      const connection = this.requireConnectionOptions();
      validateSandboxId(runtimeSandboxId);
      const durationSeconds = durationMsToE2BRefreshSeconds(durationMs);
      const normalizedDurationMs = durationSeconds * 1_000;
      const startedAt = Date.now();
      await Sandbox.setTimeout(runtimeSandboxId, normalizedDurationMs, {
        ...connection,
      });
      return { status: "refreshed", refreshedUntil: startedAt + normalizedDurationMs };
    });
  }

  async runCommand(request: RunCommandRequest): Promise<RunCommandResult> {
    return this.withRuntimeErrors("runCommand", request.runtimeSandboxId, async () => {
      const sandbox = await this.connectForCommand(request.runtimeSandboxId);
      let result: E2BCommandResultLike;
      try {
        result = await sandbox.commands.run(request.command, buildRunCommandOptions(request));
      } catch (error) {
        const commandResult = readThrownCommandResult(error);
        if (commandResult) return commandResult;
        throw error;
      }
      return {
        exitCode: requireNumberField(result.exitCode, "E2B command exitCode"),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    });
  }

  async startCommand(request: StartCommandRequest): Promise<{ pid: number; startedAt: number }> {
    return this.withRuntimeErrors("startCommand", request.runtimeSandboxId, async () => {
      const sandbox = await this.connectForCommand(request.runtimeSandboxId);
      const startedAt = Date.now();
      const handle = await sandbox.commands.run(request.command, buildStartCommandOptions(request));
      return { pid: requireNumberField(handle.pid, "E2B command pid"), startedAt };
    });
  }

  async pauseSandbox(runtimeSandboxId: string): Promise<{ status: "paused" }> {
    return this.withRuntimeErrors("pauseSandbox", runtimeSandboxId, async () => {
      const Sandbox = await loadSandboxSdk();
      const connection = this.requireConnectionOptions();
      validateSandboxId(runtimeSandboxId);
      await Sandbox.pause(runtimeSandboxId, connection);
      return { status: "paused" };
    });
  }

  /**
   * Kill an E2B sandbox. `reason` names the control-plane code path requesting
   * the kill — the E2B orchestrator only ever logs `kill_reason: 'request'`, so
   * without this every terminate (orphan reaper, runtime cleanup, spawn-failure
   * cleanup, duplicate-retry) is indistinguishable in logs.
   * It is required so a new call site cannot silently lose attribution.
   */
  async terminateSandbox(
    runtimeSandboxId: string,
    reason: SandboxTerminateReason,
  ): Promise<{ status: "killed" | "missing" }> {
    return this.withRuntimeErrors(
      "terminateSandbox",
      runtimeSandboxId,
      async () => {
        const Sandbox = await loadSandboxSdk();
        const connection = this.requireConnectionOptions();
        validateSandboxId(runtimeSandboxId);
        const killed = await Sandbox.kill(runtimeSandboxId, connection);
        return { status: killed ? "killed" : "missing" };
      },
      { missingSandboxAsResult: true, extraLogFields: { reason } },
    );
  }

  /**
   * Liveness probe via the static metadata read `Sandbox.getInfo`. Does NOT use
   * `Sandbox.connect`, which auto-resumes paused sandboxes — a probe must never
   * mutate the sandbox. Classifies `missing_sandbox` -> `missing`; any other
   * failure (timeout, auth, network) -> `unknown` so callers fail toward their
   * existing terminate behavior rather than leaking on a flaky probe.
   */
  async getSandboxInfo(
    runtimeSandboxId: string,
    options: { requestTimeoutMs?: number } = {},
  ): Promise<E2BSandboxInfoResult> {
    const startedAt = Date.now();
    try {
      const Sandbox = await loadSandboxSdk();
      const connection = this.requireConnectionOptions();
      validateSandboxId(runtimeSandboxId);
      const info = await Sandbox.getInfo(runtimeSandboxId, {
        ...connection,
        ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      });
      this.logOperation("getSandboxInfo", runtimeSandboxId, startedAt, "success");
      if (info.state === "running" || info.state === "paused") return { status: info.state };
      return { status: "unknown", errorCode: "unknown", rawState: String(info.state) };
    } catch (error) {
      const runtimeError = normalizeE2BError(error, "getSandboxInfo");
      if (runtimeError.code === "missing_sandbox") {
        this.logOperation("getSandboxInfo", runtimeSandboxId, startedAt, "missing", runtimeError);
        return { status: "missing" };
      }
      this.logOperation("getSandboxInfo", runtimeSandboxId, startedAt, "error", runtimeError);
      return { status: "unknown", errorCode: runtimeError.code };
    }
  }

  private async connectForCommand(runtimeSandboxId: string): Promise<E2BSandboxHandle> {
    const Sandbox = await loadSandboxSdk();
    const connection = this.requireConnectionOptions();
    validateSandboxId(runtimeSandboxId);
    return Sandbox.connect(runtimeSandboxId, connection);
  }

  private requireConnectionOptions(): { apiKey: string; domain?: string } {
    if (!this.apiKey) throw missingConfig("E2B_API_KEY is required");
    return {
      apiKey: this.apiKey,
      ...(this.domain ? { domain: this.domain } : {}),
    };
  }

  private async withRuntimeErrors<T>(
    method: string,
    runtimeSandboxId: string | undefined,
    run: () => Promise<T>,
    options: {
      missingSandboxAsResult?: boolean;
      runtimeSandboxIdFromResult?: (result: T) => string | undefined;
      template?: string;
      extraLogFields?: Record<string, unknown>;
    } = {},
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await run();
      this.logOperation(
        method,
        options.runtimeSandboxIdFromResult?.(result) ?? runtimeSandboxId,
        startedAt,
        "success",
        undefined,
        options.extraLogFields,
      );
      return result;
    } catch (error) {
      const runtimeError = normalizeE2BError(error, method, { template: options.template });
      if (options.missingSandboxAsResult && runtimeError.code === "missing_sandbox") {
        this.logOperation(method, runtimeSandboxId, startedAt, "missing", runtimeError, options.extraLogFields);
        return { status: "missing" } as T;
      }
      this.logOperation(method, runtimeSandboxId, startedAt, "error", runtimeError, options.extraLogFields);
      throw runtimeError;
    }
  }

  private logOperation(
    method: string,
    runtimeSandboxId: string | undefined,
    startedAt: number,
    outcome: "success" | "missing" | "error",
    error?: E2BSandboxRuntimeError,
    extraLogFields?: Record<string, unknown>,
  ): void {
    const fields = {
      endpoint: "e2b",
      method,
      runtimeSandboxId,
      durationMs: Date.now() - startedAt,
      outcome,
      ...(extraLogFields ?? {}),
      ...(error ? { errorCode: error.code, status: error.status, requestSent: error.requestSent } : {}),
    };
    if (error) {
      this.logger.error(fields, "E2B sandbox runtime operation failed");
    } else {
      this.logger.info(fields, "E2B sandbox runtime operation completed");
    }
  }
}

function listedSandboxToRuntime(sandbox: SandboxInfo): E2BListedSandbox {
  return {
    runtimeSandboxId: sandbox.sandboxId,
    runtimeTemplateId: sandbox.templateId,
    status: sandbox.state === "running" || sandbox.state === "paused" ? sandbox.state : "unknown",
    createdAt: sandbox.startedAt.getTime(),
    metadata: sandbox.metadata,
  };
}

function buildStartCommandOptions(request: StartCommandRequest): {
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs: 0;
  background: true;
} {
  return {
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.envs ? { envs: request.envs } : {}),
    timeoutMs: 0,
    background: true,
  };
}

function buildRunCommandOptions(request: RunCommandRequest): {
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
} {
  return {
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.envs ? { envs: request.envs } : {}),
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
  };
}

function readThrownCommandResult(error: unknown): RunCommandResult | null {
  const record = findCommandResultRecord(error);
  const exitCode = record ? readCommandExitCode(record) : readCommandExitCode(error);
  if (exitCode === undefined) return null;
  return {
    exitCode,
    stdout:
      (record ? readCommandOutput(record, ["stdout", "stdOut"]) : readCommandOutput(error, ["stdout", "stdOut"])) ?? "",
    stderr:
      (record ? readCommandOutput(record, ["stderr", "stdErr"]) : readCommandOutput(error, ["stderr", "stdErr"])) ?? "",
  };
}

function findCommandResultRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 2 || typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (readCommandExitCode(record) !== undefined) return record;
  for (const key of ["result", "data", "details", "commandResult"]) {
    const nested = findCommandResultRecord(record[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function readCommandExitCode(value: unknown): number | undefined {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const direct =
      readNumber(record.exitCode) ??
      readNumber(record.exit_code) ??
      readNumber(record.exitStatus) ??
      readNumber(record.exit_status) ??
      readNumber(record.commandExitCode);
    if (direct !== undefined) return direct;
  }
  const message = readMessage(value);
  const match = message.match(/\b(?:exit status|exited with code)\s+(\d+)\b/i);
  return match ? Number(match[1]) : undefined;
}

function readCommandOutput(value: unknown, keys: string[]): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function validatePositiveMs(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw missingConfig(`${label} must be a positive number of milliseconds`);
}

function validateSandboxId(value: string): void {
  if (!value) throw missingConfig("E2B sandbox ID is required");
}

function durationMsToE2BRefreshSeconds(durationMs: number): number {
  validatePositiveMs(durationMs, "E2B refresh duration");
  const seconds = Math.ceil(durationMs / 1_000);
  if (seconds > E2B_REFRESH_MAX_SECONDS) {
    throw missingConfig(`E2B refresh duration must be at most ${E2B_REFRESH_MAX_SECONDS} seconds`);
  }
  return seconds;
}

function missingConfig(message: string): E2BSandboxRuntimeError {
  return new E2BSandboxRuntimeError(message, {
    code: "missing_config",
    requestSent: false,
  });
}

function normalizeE2BError(
  error: unknown,
  method: string,
  context: { template?: string } = {},
): E2BSandboxRuntimeError {
  if (error instanceof E2BSandboxRuntimeError) return error;
  const status = readStatus(error);
  const message = readMessage(error);
  const retryAfterMs = readRetryAfterMs(error);
  const code = classifyE2BError(error, method, status, message);
  const contextualMessage =
    code === "missing_template" && context.template
      ? `${message || "E2B sandbox runtime request failed"} (template: ${context.template})`
      : message || "E2B sandbox runtime request failed";
  return new E2BSandboxRuntimeError(contextualMessage, {
    code,
    status,
    retryAfterMs,
    requestSent: true,
    cause: error,
  });
}

function classifyE2BError(
  error: unknown,
  method: string,
  status: number | undefined,
  message: string,
): E2BSandboxRuntimeErrorCode {
  const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
  const text = `${name} ${message}`.toLowerCase();
  if (status === 401 || status === 403 || text.includes("authentication")) return "auth";
  if (status === 402 || text.includes("quota") || text.includes("not enough credits")) return "quota";
  if (status === 429 || text.includes("rate limit")) return "rate_limit";
  if (status === 404)
    return method === "createSandbox" || text.includes("template") ? "missing_template" : "missing_sandbox";
  if (text.includes("sandboxnotfound") || text.includes("sandbox not found")) return "missing_sandbox";
  if (text.includes("templatenotfound") || text.includes("template not found")) return "missing_template";
  if (status === 408 || status === 504 || text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("killed") || text.includes("terminated")) return "killed";
  if (text.includes("network policy") || text.includes("denyout") || text.includes("allowout")) return "network_policy";
  if (
    error instanceof TypeError ||
    text.includes("fetch failed") ||
    text.includes("econnreset") ||
    text.includes("enotfound") ||
    text.includes("network")
  ) {
    return "network";
  }
  return "unknown";
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return "E2B sandbox runtime request failed";
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const direct = readNumber(record.status) ?? readNumber(record.statusCode);
  if (direct !== undefined) return direct;
  const response = record.response;
  if (typeof response === "object" && response !== null) {
    return readNumber((response as Record<string, unknown>).status);
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireNumberField(value: unknown, label: string): number {
  const parsed = readNumber(value);
  if (parsed !== undefined) return parsed;
  throw new Error(`${label} was missing from the E2B SDK response`);
}

function readRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response = (error as Record<string, unknown>).response;
  if (typeof response !== "object" || response === null) return undefined;
  const headers = (response as Record<string, unknown>).headers;
  const value =
    typeof headers === "object" && headers !== null && "get" in headers
      ? (headers as { get(name: string): string | null }).get("retry-after")
      : undefined;
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
}
