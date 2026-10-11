import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "fs";

import type {
  AgentProgressLabel,
  AgentProgressStep,
  SandboxPromptActivityPhase,
} from "../../../../shared/events/bridge.js";
import { sleep as defaultSleep } from "../../../../shared/utils/timing.js";
import { type BridgeLogger, phaseLogFields } from "../logger.js";

const WORKSPACE_SETUP_POLL_INTERVAL_MS = 1_000;

type WorkspaceSetupReason = "background" | "dependency_command" | "initial_prompt";
type WorkspaceSetupWaitPurpose = "dependency_command" | "initial_prompt";

export interface WorkspaceSetupTrackerDeps {
  pendingPath: string;
  readyPath: string;
  /**
   * Failure marker written by start-bridge.sh when a repo-owned setup script
   * exits non-zero or times out. start-bridge still writes the ready marker so
   * dispatch proceeds, so when this marker is present alongside ready we report
   * the workspace setup as failed instead of completed.
   */
  failedPath?: string;
  /**
   * Timing breadcrumb written by start-bridge.sh holding `setup_kind=<label>`
   * and `setup_ms=<int>` (the real execution wall time of the dep/setup phase).
   * Read once when completion is first observed; folded into the completion log
   * so the install/build phase is attributable in cold-start analysis. Distinct
   * from `duration_ms` below, which is the per-prompt time spent waiting.
   */
  setupTimingsPath?: string;
  timeoutMs: number;
  sendPromptActivity: (promptId: string, phase: SandboxPromptActivityPhase, detail?: string) => void;
  sendAgentProgress: (
    promptId: string,
    step: AgentProgressStep,
    label: AgentProgressLabel,
    opts?: { terminal?: boolean; repeat?: boolean },
  ) => void;
  /** Read dynamically — the bridge's serverAbort controller can be replaced mid-session. */
  getBackgroundAbortSignal: () => AbortSignal;
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Tracks the external workspace dependency-setup process (a pending/ready file
 * pair). Owns the per-prompt completion + start-time bookkeeping and emits the
 * workspace prompt-activity / agent-progress signals. The background watcher and
 * the dependency-command wait share one poll loop (`awaitReady`); they differ
 * only in throw-vs-return on timeout/abort and in log wording.
 */
export class WorkspaceSetupTracker {
  private readonly completionPromptIds = new Set<string>();
  private readonly startedAtByPromptId = new Map<string, number>();
  private readonly deps: WorkspaceSetupTrackerDeps;
  private readonly exists: (path: string) => boolean;
  private readonly readFile: (path: string) => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  // Memoized parse of the start-bridge setup-timing breadcrumb. Only a SUCCESSFUL
  // parse is cached; an absent/malformed read returns null without memoizing, so a
  // read that races the breadcrumb write retries on the next completion instead of
  // dropping the timing for the whole session.
  private setupTiming: { setupKind: string; setupMs: number } | undefined;
  // Whether the dedicated workspace_setup_timing telemetry line has been emitted.
  // The breadcrumb describes one session-global fact, so it is logged at most once.
  private setupTimingLogged = false;

  constructor(deps: WorkspaceSetupTrackerDeps) {
    this.deps = deps;
    this.exists = deps.existsSync ?? nodeExistsSync;
    this.readFile = deps.readFileSync ?? ((path: string) => nodeReadFileSync(path, "utf-8"));
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Read + parse the start-bridge.sh setup-timing breadcrumb, caching only a
   * successful parse. Best-effort: a missing/garbled file (or no configured path)
   * returns null and is retried on the next call, so a read racing the breadcrumb
   * write recovers rather than silently dropping the timing for the session. The
   * kind label is a fixed start-bridge vocabulary, not untrusted repo content.
   */
  private readSetupTiming(): { setupKind: string; setupMs: number } | null {
    if (this.setupTiming) return this.setupTiming;
    const path = this.deps.setupTimingsPath;
    if (!path || !this.exists(path)) return null;
    try {
      const fields = new Map<string, string>();
      for (const line of this.readFile(path).split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
      const setupKind = fields.get("setup_kind");
      const setupMs = Number(fields.get("setup_ms"));
      if (setupKind && Number.isFinite(setupMs) && setupMs >= 0) {
        this.setupTiming = { setupKind, setupMs };
        return this.setupTiming;
      }
    } catch {
      // Swallow: telemetry breadcrumb, never block completion on a read error.
    }
    return null;
  }

  /**
   * Emit the dedicated workspace_setup_timing telemetry line once per session, if
   * the breadcrumb is readable. This is decoupled from the completion-signal path
   * (`sendCompleteOnce`) on purpose: the synchronous `.cycloid/setup.sh` path and
   * the warm `node_modules`-skip path are already ready before the first prompt, so
   * the bridge never engages the tracker for them — yet their setup time is exactly
   * what cold-start attribution needs. Callers invoke this both unconditionally at
   * prompt dispatch (covers the already-ready paths) and from `sendCompleteOnce`
   * (covers a background install that is still running at dispatch). The once-guard
   * + the read's retry-on-absent make it safe to call from every path on every
   * prompt without double-logging.
   */
  emitSetupTimingOnce(promptLog: BridgeLogger): void {
    if (this.setupTimingLogged) return;
    const timing = this.readSetupTiming();
    if (!timing) return;
    this.setupTimingLogged = true;
    promptLog.info(
      phaseLogFields("prompt.dispatch", {
        step: "workspace_setup_timing",
        setup_kind: timing.setupKind,
        setup_execution_ms: timing.setupMs,
      }),
      "Workspace setup timing",
    );
  }

  isPending(): boolean {
    return this.exists(this.deps.pendingPath) && !this.exists(this.deps.readyPath);
  }

  hasFailed(): boolean {
    return Boolean(this.deps.failedPath && this.exists(this.deps.failedPath));
  }

  private sendCompleteOnce(
    messageId: string,
    promptLog: BridgeLogger,
    startedAt: number,
    reason: WorkspaceSetupReason,
  ): void {
    if (this.completionPromptIds.has(messageId)) return;
    this.completionPromptIds.add(messageId);
    this.startedAtByPromptId.delete(messageId);
    // Background-install path: the breadcrumb is written just before the ready
    // marker, so completion is the first point it is reliably present here.
    this.emitSetupTimingOnce(promptLog);
    const durationMs = this.now() - startedAt;
    if (this.hasFailed()) {
      promptLog.warn(
        phaseLogFields("prompt.dispatch", {
          step: "workspace_setup",
          phase_status: "failed",
          duration_ms: durationMs,
          reason,
        }),
        "Workspace dependency setup failed; continuing so the agent can run",
      );
      this.deps.sendPromptActivity(messageId, "prompt_preparing", "workspace_setup_failed");
      this.deps.sendAgentProgress(messageId, "workspace_setup_failed", "Workspace setup failed", { terminal: true });
      return;
    }
    promptLog.info(
      phaseLogFields("prompt.dispatch", {
        step: "workspace_setup",
        phase_status: "completed",
        duration_ms: durationMs,
        reason,
      }),
      "Workspace dependency setup completed",
    );
    this.deps.sendPromptActivity(messageId, "prompt_preparing", "workspace_setup_complete");
    this.deps.sendAgentProgress(messageId, "workspace_ready", "Workspace ready", { terminal: true });
  }

  flushCompletionIfReady(
    messageId: string,
    promptLog: BridgeLogger,
    reason: WorkspaceSetupReason = "background",
  ): void {
    if (this.completionPromptIds.has(messageId)) return;
    if (!this.exists(this.deps.readyPath)) return;
    this.sendCompleteOnce(messageId, promptLog, this.startedAtByPromptId.get(messageId) ?? this.now(), reason);
  }

  /**
   * Poll until the workspace is no longer pending, aborted, or the deadline
   * passes. Returns the outcome; callers decide whether to throw or continue.
   * `getSignal` is read on every iteration so a swapped/late-aborted controller
   * (e.g. the bridge's `serverAbort`) is observed dynamically, matching the
   * original inline `this.serverAbort.signal.aborted` check.
   */
  private async awaitReady(getSignal: () => AbortSignal, deadline: number): Promise<"ready" | "timeout" | "aborted"> {
    while (this.exists(this.deps.pendingPath) && !this.exists(this.deps.readyPath)) {
      if (getSignal().aborted) return "aborted";
      if (this.now() >= deadline) return "timeout";
      await this.sleep(WORKSPACE_SETUP_POLL_INTERVAL_MS);
    }
    return "ready";
  }

  /** Background watcher: never throws; emits a timeout signal but keeps dispatch moving. */
  watchCompletion(messageId: string, promptLog: BridgeLogger, startedAt: number): void {
    void (async () => {
      const deadline = startedAt + this.deps.timeoutMs;
      const outcome = await this.awaitReady(this.deps.getBackgroundAbortSignal, deadline);
      if (outcome === "aborted") return;
      if (outcome === "timeout") {
        promptLog.warn(
          phaseLogFields("prompt.dispatch", {
            step: "workspace_setup",
            phase_status: "timeout",
            pendingPath: this.deps.pendingPath,
            readyPath: this.deps.readyPath,
            timeout_ms: this.deps.timeoutMs,
          }),
          "Workspace dependency setup timed out while running in the background",
        );
        this.deps.sendPromptActivity(messageId, "prompt_preparing", "workspace_setup_timeout");
        this.deps.sendAgentProgress(messageId, "workspace_setup_delayed", "Workspace setup delayed", {
          terminal: true,
        });
        return;
      }
      if (this.exists(this.deps.readyPath)) {
        this.sendCompleteOnce(messageId, promptLog, startedAt, "background");
      }
    })().catch((error: unknown) => {
      promptLog.warn({ error: String(error) }, "Workspace setup background completion watcher failed");
    });
  }

  noteInBackgroundAt(messageId: string, promptLog: BridgeLogger, startedAt: number): void {
    this.startedAtByPromptId.set(messageId, startedAt);
    if (!this.isPending()) {
      this.flushCompletionIfReady(messageId, promptLog, "background");
      return;
    }

    promptLog.info(
      phaseLogFields("prompt.dispatch", {
        step: "workspace_setup",
        phase_status: "background",
        pendingPath: this.deps.pendingPath,
        readyPath: this.deps.readyPath,
      }),
      "Workspace dependency setup is running in the background; prompt dispatch will continue",
    );
    this.deps.sendPromptActivity(messageId, "prompt_preparing", "workspace_setup");
    this.deps.sendAgentProgress(messageId, "preparing_workspace", "Preparing workspace");
    this.watchCompletion(messageId, promptLog, startedAt);
  }

  /** Foreground wait: throws on abort or timeout so the dependency command does not run early. */
  async waitBeforeDependencyCommand(
    messageId: string,
    promptLog: BridgeLogger,
    signal: AbortSignal,
    purpose: WorkspaceSetupWaitPurpose = "dependency_command",
    startedAt: number = this.now(),
  ): Promise<void> {
    if (!this.isPending()) {
      if (this.exists(this.deps.readyPath)) {
        this.sendCompleteOnce(messageId, promptLog, startedAt, purpose);
      }
      return;
    }

    const deadline = startedAt + this.deps.timeoutMs;
    const waitingMessage =
      purpose === "initial_prompt"
        ? "Waiting for workspace dependency setup before the initial prompt"
        : "Waiting for workspace dependency setup before dependency-sensitive command";
    const timeoutMessage =
      purpose === "initial_prompt"
        ? "Workspace dependency setup timed out before the initial prompt"
        : "Workspace dependency setup timed out before dependency-sensitive command";
    promptLog.info(
      phaseLogFields("prompt.dispatch", {
        step: "workspace_setup",
        phase_status: "started",
        pendingPath: this.deps.pendingPath,
        readyPath: this.deps.readyPath,
      }),
      waitingMessage,
    );
    this.deps.sendPromptActivity(messageId, "prompt_preparing", "workspace_setup");
    this.deps.sendAgentProgress(messageId, "preparing_workspace", "Preparing workspace");

    const outcome = await this.awaitReady(() => signal, deadline);
    if (outcome === "aborted") {
      throw new Error("Prompt stopped while waiting for workspace dependency setup");
    }
    if (outcome === "timeout") {
      promptLog.error(
        phaseLogFields("prompt.dispatch", {
          step: "workspace_setup",
          phase_status: "timeout",
          pendingPath: this.deps.pendingPath,
          readyPath: this.deps.readyPath,
          timeout_ms: this.deps.timeoutMs,
        }),
        timeoutMessage,
      );
      this.deps.sendPromptActivity(messageId, "prompt_preparing", "workspace_setup_timeout");
      this.deps.sendAgentProgress(messageId, "workspace_setup_delayed", "Workspace setup delayed", {
        terminal: true,
      });
      throw new Error(`Workspace dependency setup timed out after ${this.deps.timeoutMs}ms`);
    }

    this.sendCompleteOnce(messageId, promptLog, startedAt, purpose);
  }
}
