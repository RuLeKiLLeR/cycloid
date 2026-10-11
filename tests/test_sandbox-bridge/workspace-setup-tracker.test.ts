// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it, vi } from "vitest";

import { WorkspaceSetupTracker } from "../../apps/sandbox-bridge/src/services/workspace-setup-tracker.js";

const PENDING = "/wk/pending";
const READY = "/wk/ready";
const FAILED = "/wk/failed";
const SETUP_TIMINGS = "/wk/setup-timings";

function makeTracker(opts: { onSleep?: (files: Set<string>) => void; timeoutMs?: number; setupTimings?: string } = {}) {
  const files = new Set<string>();
  let clock = 0;
  const activities: Array<{ promptId: string; phase: string; detail?: string }> = [];
  const progresses: Array<{ promptId: string; step: string; label: string; opts?: unknown }> = [];
  const logFields: Array<Record<string, unknown>> = [];
  const abort = new AbortController();
  const record = (fields: Record<string, unknown>) => logFields.push(fields);
  const log = {
    info: (fields) => record(fields),
    warn: (fields) => record(fields),
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  // The timing breadcrumb is just another tracked file; readFileSync returns the
  // current content. Absent unless opts.setupTimings is set, exercising the
  // missing-file path by default. setSetupTimings() lets a test make the
  // breadcrumb appear mid-session to exercise the absent-then-present retry.
  let setupTimings = opts.setupTimings;
  if (setupTimings !== undefined) files.add(SETUP_TIMINGS);
  const setSetupTimings = (content: string) => {
    setupTimings = content;
    files.add(SETUP_TIMINGS);
  };
  const tracker = new WorkspaceSetupTracker({
    pendingPath: PENDING,
    readyPath: READY,
    failedPath: FAILED,
    setupTimingsPath: SETUP_TIMINGS,
    timeoutMs: opts.timeoutMs ?? 5_000,
    sendPromptActivity: (promptId, phase, detail) => activities.push({ promptId, phase, detail }),
    sendAgentProgress: (promptId, step, label, o) => progresses.push({ promptId, step, label, opts: o }),
    getBackgroundAbortSignal: () => abort.signal,
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string) => {
      if (p === SETUP_TIMINGS && setupTimings !== undefined) return setupTimings;
      throw new Error(`unexpected readFileSync ${p}`);
    },
    sleep: async () => {
      clock += 1_000;
      opts.onSleep?.(files);
    },
    now: () => clock,
  });
  return {
    tracker,
    files,
    activities,
    progresses,
    logFields,
    log,
    backgroundAbort: abort,
    setSetupTimings,
    details: () => activities.map((a) => a.detail),
    steps: () => progresses.map((p) => p.step),
    completionFields: () => logFields.find((f) => f.step === "workspace_setup"),
    completionFieldsAll: () => logFields.filter((f) => f.step === "workspace_setup"),
    timingLines: () => logFields.filter((f) => f.step === "workspace_setup_timing"),
  };
}

describe("WorkspaceSetupTracker.isPending", () => {
  it("is pending only when the pending marker exists without the ready marker", () => {
    const h = makeTracker();
    expect(h.tracker.isPending()).toBe(false);
    h.files.add(PENDING);
    expect(h.tracker.isPending()).toBe(true);
    h.files.add(READY);
    expect(h.tracker.isPending()).toBe(false);
  });
});

describe("WorkspaceSetupTracker.waitBeforeDependencyCommand", () => {
  it("completes immediately when ready is already present", async () => {
    const h = makeTracker();
    h.files.add(READY);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    expect(h.details()).toContain("workspace_setup_complete");
  });

  it("waits for the ready marker to appear, then completes", async () => {
    const h = makeTracker({ onSleep: (files) => files.add(READY) });
    h.files.add(PENDING);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    expect(h.details()).toEqual(["workspace_setup", "workspace_setup_complete"]);
  });

  it("throws and emits a timeout signal when ready never appears", async () => {
    const h = makeTracker({ timeoutMs: 1_000 });
    h.files.add(PENDING);
    await expect(h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal)).rejects.toThrow(
      "Workspace dependency setup timed out",
    );
    expect(h.details()).toContain("workspace_setup_timeout");
  });

  it("throws a stop error when the signal is aborted", async () => {
    const h = makeTracker();
    h.files.add(PENDING);
    const ac = new AbortController();
    ac.abort();
    await expect(h.tracker.waitBeforeDependencyCommand("m1", h.log, ac.signal)).rejects.toThrow(
      "Prompt stopped while waiting for workspace dependency setup",
    );
  });

  it("emits completion only once across repeated calls", async () => {
    const h = makeTracker();
    h.files.add(READY);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    expect(h.details().filter((d) => d === "workspace_setup_complete")).toHaveLength(1);
  });
});

describe("WorkspaceSetupTracker background watcher", () => {
  it("emits completion from the background watcher when ready appears", async () => {
    const h = makeTracker({ onSleep: (files) => files.add(READY) });
    h.files.add(PENDING);
    h.tracker.noteInBackgroundAt("m1", h.log, 0);
    await vi.waitFor(
      () => {
        expect(h.details()).toContain("workspace_setup_complete");
      },
      { timeout: 2000, interval: 10 },
    );
  });

  it("emits a timeout signal without throwing when the background watcher times out", async () => {
    const h = makeTracker({ timeoutMs: 1_000 });
    h.files.add(PENDING);
    // noteInBackgroundAt kicks off the fire-and-forget watcher; it must not reject.
    h.tracker.noteInBackgroundAt("m1", h.log, 0);
    await vi.waitFor(
      () => {
        expect(h.details()).toContain("workspace_setup_timeout");
      },
      { timeout: 2000, interval: 10 },
    );
    expect(h.logFields).toContainEqual(
      expect.objectContaining({
        event: "prompt.dispatch",
        step: "workspace_setup",
        phase_status: "timeout",
        timeout_ms: 1_000,
      }),
    );
  });

  it("stops silently when the background abort signal fires", async () => {
    const h = makeTracker();
    h.files.add(PENDING);
    h.backgroundAbort.abort();
    h.tracker.noteInBackgroundAt("m1", h.log, 0);
    await new Promise((r) => setImmediate(r));
    expect(h.details()).not.toContain("workspace_setup_complete");
    expect(h.details()).not.toContain("workspace_setup_timeout");
  });
});

describe("WorkspaceSetupTracker.flushCompletionIfReady", () => {
  it("completes when ready, and is a no-op when not ready", () => {
    const h = makeTracker();
    h.tracker.flushCompletionIfReady("m1", h.log);
    expect(h.details()).not.toContain("workspace_setup_complete");
    h.files.add(READY);
    h.tracker.flushCompletionIfReady("m1", h.log);
    expect(h.details()).toContain("workspace_setup_complete");
  });
});

describe("WorkspaceSetupTracker setup-timing breadcrumb", () => {
  it("emits a dedicated workspace_setup_timing line when completion fires (background path)", async () => {
    const h = makeTracker({ setupTimings: "setup_kind=pnpm\nsetup_ms=4200\n" });
    h.files.add(READY);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    expect(h.timingLines()).toHaveLength(1);
    expect(h.timingLines()[0]).toMatchObject({
      event: "prompt.dispatch",
      step: "workspace_setup_timing",
      setup_kind: "pnpm",
      setup_execution_ms: 4200,
    });
  });

  it("emits the timing even when setup failed", async () => {
    const h = makeTracker({ setupTimings: "setup_kind=repo_setup_script\nsetup_ms=1500\n" });
    h.files.add(READY);
    h.files.add(FAILED);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    expect(h.completionFields()).toMatchObject({ phase_status: "failed" });
    expect(h.timingLines()[0]).toMatchObject({ setup_kind: "repo_setup_script", setup_execution_ms: 1500 });
  });

  it("emits the timing for an already-ready path without going through the tracker (setup.sh / warm skip)", () => {
    // The synchronous setup.sh and warm node_modules-skip paths are ready before
    // the first prompt, so the bridge calls emitSetupTimingOnce directly rather
    // than engaging the pending/completion flow.
    const h = makeTracker({ setupTimings: "setup_kind=npm_skip_existing\nsetup_ms=0\n" });
    h.tracker.emitSetupTimingOnce(h.log);
    expect(h.timingLines()).toHaveLength(1);
    expect(h.timingLines()[0]).toMatchObject({ setup_kind: "npm_skip_existing", setup_execution_ms: 0 });
  });

  it("logs the timing at most once per session across repeated calls and completion", async () => {
    const h = makeTracker({ setupTimings: "setup_kind=yarn\nsetup_ms=900\n" });
    h.tracker.emitSetupTimingOnce(h.log);
    h.tracker.emitSetupTimingOnce(h.log);
    h.files.add(READY);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    expect(h.timingLines()).toHaveLength(1);
  });

  it("emits no timing line when the breadcrumb is absent", async () => {
    const h = makeTracker();
    h.files.add(READY);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    expect(h.timingLines()).toHaveLength(0);
    // The completion log itself still fires, just without the timing fields.
    expect(h.completionFields()).toMatchObject({ phase_status: "completed" });
    expect(h.completionFields()).not.toHaveProperty("setup_kind");
  });

  it("does not permanently memoize an absent breadcrumb: a later call recovers the timing", () => {
    // First read races the breadcrumb write (file not yet visible); a later call
    // must still pick it up rather than caching the miss.
    const h = makeTracker();
    h.tracker.emitSetupTimingOnce(h.log);
    expect(h.timingLines()).toHaveLength(0);

    h.setSetupTimings("setup_kind=npm\nsetup_ms=8800\n");
    h.tracker.emitSetupTimingOnce(h.log);
    expect(h.timingLines()).toHaveLength(1);
    expect(h.timingLines()[0]).toMatchObject({ setup_kind: "npm", setup_execution_ms: 8800 });
  });

  it("ignores a malformed breadcrumb (non-numeric ms) without throwing or emitting", () => {
    const h = makeTracker({ setupTimings: "setup_kind=pnpm\nsetup_ms=not-a-number\n" });
    h.tracker.emitSetupTimingOnce(h.log);
    expect(h.timingLines()).toHaveLength(0);
  });
});

describe("WorkspaceSetupTracker failure marker", () => {
  it("reports failure when ready and the failed marker are both present", async () => {
    const h = makeTracker();
    h.files.add(READY);
    h.files.add(FAILED);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    expect(h.details()).toContain("workspace_setup_failed");
    expect(h.details()).not.toContain("workspace_setup_complete");
    expect(h.steps()).toContain("workspace_setup_failed");
    expect(h.steps()).not.toContain("workspace_ready");
  });

  it("reports completion when ready is present without the failed marker", async () => {
    const h = makeTracker();
    h.files.add(READY);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    expect(h.details()).toContain("workspace_setup_complete");
    expect(h.details()).not.toContain("workspace_setup_failed");
  });

  it("surfaces a setup-script failure that appears while waiting", async () => {
    const h = makeTracker({ onSleep: (files) => files.add(READY) });
    h.files.add(PENDING);
    // start-bridge writes the failed marker before the ready marker, so by the
    // time ready appears the failure is already observable.
    h.files.add(FAILED);
    await h.tracker.waitBeforeDependencyCommand("m1", h.log, new AbortController().signal);
    expect(h.details()).toEqual(["workspace_setup", "workspace_setup_failed"]);
  });

  it("reports failure from the background watcher when ready+failed appear", async () => {
    const h = makeTracker({
      onSleep: (files) => {
        files.add(FAILED);
        files.add(READY);
      },
    });
    h.files.add(PENDING);
    h.tracker.noteInBackgroundAt("m1", h.log, 0);
    await new Promise((r) => setImmediate(r));
    expect(h.details()).toContain("workspace_setup_failed");
  });
});
