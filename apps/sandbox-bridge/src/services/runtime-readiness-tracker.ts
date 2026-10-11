import { rmSync as nodeRmSync, writeFileSync as nodeWriteFileSync } from "fs";

/**
 * Cross-process readiness file the bridge writes while it boots the verification
 * preview runtime in the background. The `cycloid-app` wrapper (a separate
 * Python process the agent shells out) reads it to wait for the boot before
 * touching the live app, instead of failing fast against a not-yet-healthy app.
 *
 * This path MUST stay in sync with `RUNTIME_READINESS_PATH` in
 * `apps/sandbox-e2b/scripts/cycloid-app`.
 *
 * This is deliberately NOT the preview-contract file
 * (`/tmp/cycloid-preview-contract.json`): the wrapper parses that file as a
 * runtime contract, so a `{state:"starting"}` payload there would read as a
 * malformed contract. The resolved contract is written separately by
 * `cycloid-app start` on success; the agent picks it up on the join.
 */
export const RUNTIME_READINESS_PATH = "/tmp/cycloid-runtime-readiness.json";

/**
 * Secret-free trigger file an agent-shell `cycloid-app start` writes when it
 * has no resolved contract: the bridge (armed for non-QA sessions with a valid
 * contract) answers by running the managed credentialed boot and recording
 * readiness above. MUST stay in sync with `RUNTIME_BOOT_REQUEST_PATH` in
 * `apps/sandbox-e2b/scripts/cycloid-app`.
 */
export const RUNTIME_BOOT_REQUEST_PATH = "/tmp/cycloid-runtime-boot-request.json";

export type RuntimeReadinessState = "starting" | "ready" | "failed" | "timed_out" | "aborted";

export interface RuntimeReadinessRecord {
  state: RuntimeReadinessState;
  /** Stable identifier used to correlate every state transition for this boot. */
  attemptId?: string;
  /** Component that acquired ownership of the single in-flight boot. */
  owner?: "planner" | "agent_request";
  /** Prompt that caused the owner to acquire the boot, when available. */
  promptId?: string;
  /** Epoch ms the background boot was kicked off. */
  startedAt: number;
  /**
   * Absolute epoch ms ceiling for the boot, carried so a late wrapper join
   * cannot extend total startup past today's `cycloid-app start` deadline.
   */
  deadline: number;
  /** Present only on `failed`/`timed_out` so the wrapper can surface a reason. */
  error?: string;
}

export interface RuntimeReadinessTrackerDeps {
  path?: string;
  writeFileSync?: (path: string, data: string) => void;
  rmSync?: (path: string) => void;
}

/**
 * Owns the readiness file plus an in-process mirror of the same state. The
 * bridge is the sole writer; the wrapper is a reader. Terminal transitions are
 * no-ops once the state has been cleared (session stop / cleanup) so a boot that
 * resolves after teardown never resurrects a stale `ready`/`failed`.
 */
export class RuntimeReadinessTracker {
  private readonly path: string;
  private readonly write: (path: string, data: string) => void;
  private readonly remove: (path: string) => void;
  private current: RuntimeReadinessRecord | null = null;

  constructor(deps: RuntimeReadinessTrackerDeps = {}) {
    this.path = deps.path ?? RUNTIME_READINESS_PATH;
    this.write = deps.writeFileSync ?? ((path, data) => nodeWriteFileSync(path, data, "utf-8"));
    this.remove = deps.rmSync ?? ((path) => nodeRmSync(path, { force: true }));
  }

  getState(): RuntimeReadinessRecord | null {
    return this.current;
  }

  markStarting(
    startedAt: number,
    deadline: number,
    metadata: Pick<RuntimeReadinessRecord, "attemptId" | "owner" | "promptId"> = {},
  ): void {
    this.current = { state: "starting", startedAt, deadline, ...metadata };
    this.persist();
  }

  markReady(): void {
    this.transitionTerminal("ready");
  }

  markFailed(error: string): void {
    this.transitionTerminal("failed", error);
  }

  markTimedOut(error: string): void {
    this.transitionTerminal("timed_out", error);
  }

  markAborted(): void {
    this.transitionTerminal("aborted");
  }

  /** Remove the file and in-process state. Idempotent. */
  clear(): void {
    this.current = null;
    try {
      this.remove(this.path);
    } catch {
      // Best-effort: a missing file is the desired post-state.
    }
  }

  private transitionTerminal(state: RuntimeReadinessState, error?: string): void {
    // Only a boot that is still in `starting` can reach a terminal state. After
    // clear() (`current === null`) the boot is no longer ours to report on, and
    // once terminal the record is immutable until the next markStarting()/clear()
    // — so a stray second terminal call can't overwrite (e.g. a false `ready`
    // after `failed`).
    if (this.current?.state !== "starting") return;
    this.current = {
      state,
      ...(this.current.attemptId ? { attemptId: this.current.attemptId } : {}),
      ...(this.current.owner ? { owner: this.current.owner } : {}),
      ...(this.current.promptId ? { promptId: this.current.promptId } : {}),
      startedAt: this.current.startedAt,
      deadline: this.current.deadline,
      ...(error ? { error } : {}),
    };
    this.persist();
  }

  private persist(): void {
    if (!this.current) return;
    this.write(this.path, JSON.stringify(this.current));
  }
}
