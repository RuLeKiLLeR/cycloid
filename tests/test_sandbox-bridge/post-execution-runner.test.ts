// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
//
// Unit tests for PostExecutionRunner driven by FAKE collaborators (no AgentBridge). This is the
// concrete win of the extraction: the post-execution orchestration is testable without standing
// up a whole bridge. The harness side-effect import below installs the same module mocks
// (diagnostics, child_process, ws) the bridge suite relies on, so the imported services behave.
import "./helpers/bridge-test-harness.ts";

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PromptLoopState } from "../../apps/sandbox-bridge/src/prompt-loop-state.ts";
import { PostExecutionRunner } from "../../apps/sandbox-bridge/src/services/post-execution/post-execution-runner.ts";
import { createLogger, mocks, setupBridgeTestLifecycle } from "./helpers/bridge-test-harness.ts";

setupBridgeTestLifecycle();

let cwd: string;
const tmpDirs: string[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  cwd = mkdtempSync(join(tmpdir(), "post-exec-runner-"));
  tmpDirs.push(cwd);
});

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const CHANGED_DIFF = {
  hasChanges: true,
  hasStagedFiles: true,
  stagedFiles: ["src/app.ts"],
  publishFiles: ["src/app.ts"],
  diffSummary: "Updated app",
  diffStat: " 1 file changed, 1 insertion(+)",
  fullDiff: "diff --git a/src/app.ts b/src/app.ts",
};

/**
 * Builds a PostExecutionContext backed entirely by fakes. Returns the context, the captured
 * `post_execution` events, and the individual fakes so tests can assert calls/override behavior.
 */
function makeContext(overrides = {}) {
  const events = [];
  const gitOps = {
    stageAndComputeDiffs: vi.fn(() => ({ ...CHANGED_DIFF })),
    commitAndPush: vi.fn(async () => ({ branch: "cycloid/test-branch", commitSha: "abc123" })),
    commitAndPushCurrentBranch: vi.fn(async () => ({ ok: true, branch: "feature/pr-head", commitSha: "fix123" })),
    readCurrentGitState: vi.fn(() => ({ branch: "cycloid/test-branch", commitSha: "abc123" })),
  };
  const workspaceSetup = {
    flushCompletionIfReady: vi.fn(),
    isPending: vi.fn(() => false),
    waitBeforeDependencyCommand: vi.fn(async () => {}),
  };
  // Real emitters return well-formed AgentTimelineEntry objects that flow into buildReadiness;
  // a minimal non-"observed" entry passes normalizeAgentTimeline without being mistaken for
  // observed agent activity. emitCommandTimeline legitimately returns undefined (caller guards).
  const timelineEntry = (eventType) => ({ eventType, source: "post_execution", summary: "" });
  const timelineEmitter = {
    emitCommandTimeline: vi.fn(() => undefined),
    emitVerificationTimeline: vi.fn(() => timelineEntry("verification")),
    emitPublishGateTimeline: vi.fn(() => timelineEntry("publish_gate")),
  };
  const ctx = {
    config: {
      sandboxId: "sbx-1",
      sessionId: "sess-1",
      controlPlaneUrl: "https://cp.example",
      publicAppUrl: "https://app.example",
    },
    cwd,
    serverAbortSignal: new AbortController().signal,
    gitOps,
    workspaceSetup,
    ensureHooksBootstrapped: vi.fn(async () => {}),
    timelineEmitter,
    sendEvent: (event) => events.push(event),
    readPreviewContract: () => undefined,
    collectVerificationArtifacts: vi.fn(async () => []),
    getRepoSlug: () => "owner/repo",
    getPendingPostExecution: () => null,
    getActivePromptTraceMeta: () => null,
    getActiveBtPromptSpan: () => null,
    ...overrides,
  };
  return { ctx, events, gitOps, workspaceSetup, timelineEmitter };
}

function run(ctx, args = {}) {
  return new PostExecutionRunner(ctx).run({
    promptLog: createLogger(),
    messageId: "msg-1",
    promptContent: "Fix the bug",
    responseText: "Done",
    ...args,
  });
}

function findPostExecution(events) {
  return events.find((event) => event.type === "post_execution");
}

describe("PostExecutionRunner terminal branches", () => {
  it("prep-failed: emits an all-skipped no-change event and never commits", async () => {
    const { ctx, events } = makeContext({
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => undefined),
        commitAndPush: vi.fn(),
        readCurrentGitState: vi.fn(() => ({})),
      },
    });

    await run(ctx);

    const postExec = findPostExecution(events);
    expect(postExec).toBeDefined();
    expect(postExec.hasChanges).toBe(false);
    expect(postExec.noChangeReason).toBe("prep_failed");
    expect(postExec.publishMode).toBe("normal");
    expect(ctx.gitOps.commitAndPush).not.toHaveBeenCalled();
  });

  it("runs verify.fix after dependency readiness, re-preps mutations, then commits the fixed diff", async () => {
    writeFileSync(
      join(cwd, ".cycloid.json"),
      JSON.stringify({ verify: { fix: { command: "npm run fix", timeoutSeconds: 30 } } }),
    );
    const calls = [];
    const fixedDiff = {
      ...CHANGED_DIFF,
      stagedFiles: ["src/app.ts", "src/formatted.ts"],
      publishFiles: ["src/app.ts", "src/formatted.ts"],
      diffSummary: "Updated formatted app",
    };
    let stageCalls = 0;
    const { ctx, events } = makeContext({
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => {
          calls.push("stage");
          stageCalls++;
          return stageCalls === 1 ? { ...CHANGED_DIFF } : fixedDiff;
        }),
        commitAndPush: vi.fn(async () => {
          calls.push("commit");
          return { branch: "cycloid/test-branch", commitSha: "abc123" };
        }),
        commitAndPushCurrentBranch: vi.fn(async () => ({ ok: true, branch: "feature/pr-head", commitSha: "fix123" })),
        readCurrentGitState: vi.fn(() => ({ branch: "cycloid/test-branch", commitSha: "abc123" })),
      },
      workspaceSetup: {
        flushCompletionIfReady: vi.fn(),
        isPending: vi.fn(() => false),
        waitBeforeDependencyCommand: vi.fn(async () => {
          calls.push("wait");
        }),
      },
    });
    let gitStatusCalls = 0;
    mocks.mockExecFile.mockImplementation((cmd, args, _options, callback) => {
      if (cmd === "git" && Array.isArray(args) && args[0] === "status") {
        gitStatusCalls++;
        callback(null, gitStatusCalls === 1 ? "" : " M src/formatted.ts\n", "");
        return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
      }
      if (cmd === "/bin/bash") {
        callback(null, "formatted\n", "");
        return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
      }
      callback(null, "main\n", "");
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    });

    await run(ctx);

    expect(findPostExecution(events)?.error).toBeUndefined();
    expect(ctx.workspaceSetup.waitBeforeDependencyCommand).toHaveBeenCalledTimes(1);
    expect(ctx.gitOps.stageAndComputeDiffs).toHaveBeenCalledTimes(2);
    expect(ctx.gitOps.commitAndPush).toHaveBeenCalledWith(expect.anything(), "msg-1", "Apply changes");
    expect(calls).toEqual(["stage", "wait", "stage", "commit"]);
  });

  it("verification prep-failed: still uploads screenshots into the verification payload", async () => {
    const screenshot = {
      type: "screenshot",
      label: "prep-failed.png",
      url: "https://app.example/api/sessions/sess-1/artifacts/art-1/prep-failed.png",
    };
    const { ctx, events } = makeContext({
      config: {
        sandboxId: "sbx-1",
        sessionId: "sess-1",
        controlPlaneUrl: "https://cp.example",
        agentRole: "verification",
      },
      collectVerificationArtifacts: vi.fn(async () => [screenshot]),
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => undefined),
        commitAndPush: vi.fn(),
        commitAndPushCurrentBranch: vi.fn(),
        readCurrentGitState: vi.fn(() => ({ branch: "feature/pr-head", commitSha: "base123" })),
      },
    });

    await run(ctx, {
      agentRole: "verification",
      responseText: [
        "Captured screenshot but git prep failed.",
        "```cycloid-verification-result",
        JSON.stringify({
          verdict: "CONCLUSIVE",
          verifiedHeadSha: "base123",
          summary: "Verified.",
          evidence: ["Screenshot captured."],
          blockers: [],
        }),
        "```",
      ].join("\n"),
    });

    const postExec = findPostExecution(events);
    expect(ctx.gitOps.commitAndPush).not.toHaveBeenCalled();
    expect(ctx.gitOps.commitAndPushCurrentBranch).not.toHaveBeenCalled();
    expect(postExec).toMatchObject({
      hasChanges: false,
      noChangeReason: "prep_failed",
      verification: {
        verdict: "CONFIRMED",
        artifacts: [screenshot],
      },
    });
    expect(postExec.verification.caveats).toEqual(
      expect.arrayContaining(["Git diff preparation failed, so changed-file evidence could not be proven."]),
    );
  });

  it("verification phase skip: preserves legacy post_execution skip fields", async () => {
    const { ctx, events } = makeContext({
      config: {
        sandboxId: "sbx-1",
        sessionId: "sess-1",
        controlPlaneUrl: "https://cp.example",
        agentRole: "verification",
      },
    });

    await run(ctx, {
      agentRole: "verification",
      verificationPhaseSkip: {
        reason: "planner_skip",
        evidence: ["Planner found no runnable proof contract."],
        headSha: "abc123",
      },
    });

    const postExec = findPostExecution(events);
    expect(ctx.gitOps.stageAndComputeDiffs).not.toHaveBeenCalled();
    expect(postExec).toMatchObject({
      hasChanges: false,
      noChangeReason: "verification_phase_skip",
      verificationSkipped: {
        reason: "planner_skip",
        evidence: ["Planner found no runnable proof contract."],
        headSha: "abc123",
      },
    });
    expect(postExec).not.toHaveProperty("qaTestingSkipped");
  });

  it("no-diff: emits a no_diff no-change event and never commits", async () => {
    const { ctx, gitOps, events } = makeContext({
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => ({
          hasChanges: false,
          hasStagedFiles: false,
          stagedFiles: [],
          publishFiles: [],
          diffSummary: "",
          diffStat: "",
          fullDiff: "",
        })),
        commitAndPush: vi.fn(),
        readCurrentGitState: vi.fn(() => ({ branch: "main", commitSha: "deadbee" })),
      },
    });

    await run(ctx, { promptMadeRepoProgress: false });

    const postExec = findPostExecution(events);
    expect(postExec).toBeDefined();
    expect(postExec.hasChanges).toBe(false);
    expect(postExec.noChangeReason).toBe("no_diff");
    expect(ctx.gitOps.commitAndPush).not.toHaveBeenCalled();
  });

  it("no-diff: replaces malformed-search bash EOF text in evidence bundle", async () => {
    const loopState = new PromptLoopState();
    loopState.recordMalformedSearchCommandViolation();
    const { ctx, events } = makeContext({
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => ({
          hasChanges: false,
          hasStagedFiles: false,
          stagedFiles: [],
          publishFiles: [],
          diffSummary: "",
          diffStat: "",
          fullDiff: "",
        })),
        commitAndPush: vi.fn(),
        readCurrentGitState: vi.fn(() => ({ branch: "main", commitSha: "deadbee" })),
      },
    });

    await run(ctx, {
      promptMadeRepoProgress: false,
      loopState,
      responseText:
        "Ran the exact malformed command.\n\n/bin/bash: -c: line 1: unexpected EOF while looking for matching `''",
    });

    const postExec = findPostExecution(events);
    expect(postExec.prReadiness.evidenceBundle.finalSummary).toBe(
      "Cycloid blocked this malformed search command before execution.",
    );
    expect(JSON.stringify(postExec)).not.toContain("unexpected EOF");
  });

  it("success: commits/pushes and emits hasChanges=true with a server-authoritative publish mode", async () => {
    const promptLog = createLogger();
    const { ctx, events, gitOps } = makeContext();

    await run(ctx, { promptLog });

    const postExec = findPostExecution(events);
    expect(postExec).toBeDefined();
    expect(postExec.hasChanges).toBe(true);
    expect(postExec.pushed).toBe(true);
    expect(postExec.branch).toBe("cycloid/test-branch");
    expect(postExec.commitSha).toBe("abc123");
    // The minimal post-idle path does not synthesize verification; this case proves
    // the success path still commits/pushes and emits a decision signal.
    expect(postExec.publishMode).toBeDefined();
    expect(postExec.gateResults).toBeDefined();
    const completedLog = promptLog.info.mock.calls.find(
      ([fields]) => fields && fields.event === "post_execution.completed",
    );
    expect(completedLog).toBeDefined();
    expect(completedLog[0].publishMode).toBe(postExec.publishMode);
    expect(completedLog[0].verdict).toBeUndefined();
    expect(gitOps.commitAndPush).toHaveBeenCalledTimes(1);
  });

  it("bootstraps repo-declared hooks before committing", async () => {
    const order = [];
    const { ctx } = makeContext({
      ensureHooksBootstrapped: vi.fn(async () => {
        order.push("bootstrap");
      }),
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => ({ ...CHANGED_DIFF })),
        commitAndPush: vi.fn(async () => {
          order.push("commit");
          return { branch: "cycloid/test-branch", commitSha: "abc123" };
        }),
        readCurrentGitState: vi.fn(() => ({ branch: "cycloid/test-branch", commitSha: "abc123" })),
      },
    });

    await run(ctx);

    expect(ctx.ensureHooksBootstrapped).toHaveBeenCalledTimes(1);
    expect(ctx.gitOps.commitAndPush).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["bootstrap", "commit"]);
  });

  it("does not bootstrap hooks when there is nothing to commit", async () => {
    const { ctx } = makeContext({
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => undefined),
        commitAndPush: vi.fn(),
        readCurrentGitState: vi.fn(() => ({})),
      },
    });

    await run(ctx);

    expect(ctx.ensureHooksBootstrapped).not.toHaveBeenCalled();
  });

  it("success with no configured test command emits a skipped tests gate and still commits", async () => {
    const { ctx, events, gitOps } = makeContext();

    await run(ctx);

    const postExec = findPostExecution(events);
    expect(postExec).toBeDefined();
    expect(postExec.hasChanges).toBe(true);
    expect(gitOps.commitAndPush).toHaveBeenCalledTimes(1);
    expect(Object.keys(postExec.gateResults).sort()).toEqual(["tests"]);
    expect(postExec.gateResults.tests).toEqual({ decision: "skipped" });
    expect(postExec.publishMode).toBe("normal");
    expect(postExec.verification).toBeUndefined();
  });

  it("configured passing test emits a passed tests gate", async () => {
    writeFileSync(join(cwd, ".cycloid.json"), JSON.stringify({ verify: { test: "npm run test -- src/app.ts" } }));
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      callback(null, cmd === "/bin/bash" ? "ok\n" : "", "");
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    });
    const { ctx, events } = makeContext();

    await run(ctx);

    const postExec = findPostExecution(events);
    expect(postExec.gateResults.tests).toEqual({ decision: "pass" });
    expect(postExec.publishMode).toBe("normal");
    expect(postExec.prReadiness.commandsRun).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "npm run test -- src/app.ts",
          check: "tests",
          status: "completed",
        }),
      ]),
    );
  });

  it("configured mixed pass and failure keeps the tests gate in draft", async () => {
    writeFileSync(
      join(cwd, ".cycloid.json"),
      JSON.stringify({
        verify: {
          test: {
            command: "npm run test -- src/app.ts",
            rules: [{ paths: ["src/**"], command: "npm run lint -- src/app.ts" }],
          },
        },
      }),
    );
    mocks.mockExecFile.mockImplementation((cmd, args, _options, callback) => {
      if (cmd === "/bin/bash" && Array.isArray(args) && args[1] === "npm run test -- src/app.ts") {
        const err = Object.assign(new Error("Command failed"), { code: 1 });
        callback(err, "", "FAIL src/app.test.ts\nAssertionError: expected true to be false");
        return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
      }
      callback(null, cmd === "/bin/bash" ? "ok\n" : "", "");
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    });
    const { ctx, events } = makeContext();

    await run(ctx);

    const postExec = findPostExecution(events);
    expect(postExec.gateResults.tests).toEqual({ decision: "draft" });
    expect(postExec.publishMode).toBe("draft");
    expect(postExec.prReadiness.commandsRun.filter((command) => command.check === "tests")).toHaveLength(2);
  });

  it("configured failing test gets one correction turn and publishes normally when the rerun passes", async () => {
    writeFileSync(join(cwd, ".cycloid.json"), JSON.stringify({ verify: { test: "npm run test -- src/app.ts" } }));
    let testRuns = 0;
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === "/bin/bash") {
        testRuns++;
        if (testRuns === 1) {
          const err = Object.assign(new Error("Command failed"), { code: 1 });
          callback(err, "", "FAIL src/app.test.ts\nAssertionError: expected true to be false");
          return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
        }
      }
      callback(null, cmd === "/bin/bash" ? "ok\n" : "", "");
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    });
    const runPostExecutionCorrection = vi.fn(async () => ({ ok: true, responseText: "Fixed and verified." }));
    const { ctx, events, gitOps } = makeContext({ runPostExecutionCorrection });

    await run(ctx);

    const postExec = findPostExecution(events);
    expect(runPostExecutionCorrection).toHaveBeenCalledTimes(1);
    expect(runPostExecutionCorrection.mock.calls[0][0].prompt).toContain(
      "Configured command: npm run test -- src/app.ts",
    );
    expect(testRuns).toBe(2);
    expect(gitOps.stageAndComputeDiffs).toHaveBeenCalledTimes(2);
    expect(gitOps.commitAndPush).toHaveBeenCalledTimes(2);
    expect(postExec.gateResults.tests).toEqual({ decision: "pass" });
    expect(postExec.publishMode).toBe("normal");
    expect(postExec.verification).toBeUndefined();
    expect(postExec.prReadiness.commandsRun.filter((command) => command.check === "tests")).toEqual([
      expect.objectContaining({ command: "npm run test -- src/app.ts", status: "completed" }),
    ]);
  });

  it("configured failing test retries once and stays draft when the rerun still fails", async () => {
    writeFileSync(join(cwd, ".cycloid.json"), JSON.stringify({ verify: { test: "npm run test -- src/app.ts" } }));
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === "/bin/bash") {
        const err = Object.assign(new Error("Command failed"), { code: 1 });
        callback(err, "", "FAIL src/app.test.ts\nAssertionError: expected true to be false");
        return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
      }
      callback(null, "", "");
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    });
    const runPostExecutionCorrection = vi.fn(async () => ({ ok: true, responseText: "Tried a fix." }));
    const { ctx, events } = makeContext({ runPostExecutionCorrection });

    await run(ctx);

    const postExec = findPostExecution(events);
    expect(runPostExecutionCorrection).toHaveBeenCalledTimes(1);
    expect(postExec.gateResults.tests).toEqual({ decision: "draft" });
    expect(postExec.publishMode).toBe("draft");
    expect(postExec.verification).toEqual(
      expect.objectContaining({
        verdict: "INCONCLUSIVE",
        publishMode: "draft",
        publishWarnReasons: expect.arrayContaining([expect.stringContaining("Configured pre-publish test failed")]),
      }),
    );
    expect(postExec.prReadiness.commandsRun.filter((command) => command.check === "tests")).toHaveLength(1);
  });

  it("configured failing test stays draft and preserves evidence when correction prep fails", async () => {
    writeFileSync(join(cwd, ".cycloid.json"), JSON.stringify({ verify: { test: "npm run test -- src/app.ts" } }));
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === "/bin/bash") {
        const err = Object.assign(new Error("Command failed"), { code: 1 });
        callback(err, "", "FAIL src/app.test.ts\nAssertionError: expected true to be false");
        return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
      }
      callback(null, "", "");
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    });
    const runPostExecutionCorrection = vi.fn(async () => ({ ok: true, responseText: "Fixed." }));
    const { ctx, events, gitOps } = makeContext({ runPostExecutionCorrection });
    gitOps.stageAndComputeDiffs.mockReturnValueOnce({ ...CHANGED_DIFF }).mockReturnValueOnce(undefined);

    await run(ctx);

    const postExec = findPostExecution(events);
    expect(runPostExecutionCorrection).toHaveBeenCalledTimes(1);
    expect(postExec.gateResults.tests).toEqual({ decision: "draft" });
    expect(postExec.publishMode).toBe("draft");
    expect(postExec.prReadiness.commandsRun.filter((command) => command.check === "tests")).toEqual([
      expect.objectContaining({ command: "npm run test -- src/app.ts", status: "error" }),
    ]);
  });

  it("configured failing test stays draft when the correction push fails", async () => {
    writeFileSync(join(cwd, ".cycloid.json"), JSON.stringify({ verify: { test: "npm run test -- src/app.ts" } }));
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === "/bin/bash") {
        const err = Object.assign(new Error("Command failed"), { code: 1 });
        callback(err, "", "FAIL src/app.test.ts\nAssertionError: expected true to be false");
        return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
      }
      callback(null, "", "");
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    });
    const runPostExecutionCorrection = vi.fn(async () => ({ ok: true, responseText: "Fixed." }));
    const { ctx, events, gitOps } = makeContext({ runPostExecutionCorrection });
    gitOps.commitAndPush
      .mockResolvedValueOnce({ branch: "cycloid/test-branch", commitSha: "abc123" })
      .mockResolvedValueOnce(undefined);

    await run(ctx);

    const postExec = findPostExecution(events);
    expect(runPostExecutionCorrection).toHaveBeenCalledTimes(1);
    expect(gitOps.commitAndPush).toHaveBeenCalledTimes(2);
    expect(postExec.gateResults.tests).toEqual({ decision: "draft" });
    expect(postExec.publishMode).toBe("draft");
    expect(postExec.pushed).toBe(false);
    expect(postExec.prReadiness.commandsRun.filter((command) => command.check === "tests")).toEqual([
      expect.objectContaining({ command: "npm run test -- src/app.ts", status: "error" }),
    ]);
  });

  it("configured test failure uses the redacted failing tail in readiness evidence", async () => {
    writeFileSync(
      join(cwd, ".cycloid.json"),
      JSON.stringify({ verify: { test: "npm run test -- tests/failing.test.ts" } }),
    );
    mocks.mockExecFile.mockImplementation((...args: unknown[]) => {
      const cmd = args[0];
      const callback = args[args.length - 1];
      if (typeof callback === "function" && cmd === "/bin/bash") {
        const err = Object.assign(new Error("Command failed"), { code: 1 });
        (callback as Function)(err, "", "FAIL tests/failing.test.ts\nAssertionError: expected true to be false");
      } else if (typeof callback === "function") {
        (callback as Function)(null, "", "");
      }
      return { on: vi.fn(), kill: vi.fn(), pid: 12345 };
    });
    const { ctx, events } = makeContext();

    await run(ctx);

    const postExec = findPostExecution(events);
    const testCommand = postExec.prReadiness.commandsRun.find(
      (command) => command.source === "post_execution" && command.check === "tests",
    );
    expect(testCommand).toEqual(
      expect.objectContaining({
        command: "npm run test -- tests/failing.test.ts",
        status: "error",
        exitCode: 1,
        summary: "FAIL tests/failing.test.ts | AssertionError: expected true to be false",
        failureOutput: "FAIL tests/failing.test.ts\nAssertionError: expected true to be false",
      }),
    );
  });

  it("failure-context: applies the failure verdict/caveats and the failure publish decision", async () => {
    const { ctx, events, gitOps } = makeContext();

    await run(ctx, { failureContext: { kind: "aborted", reason: "user stopped the session" } });

    const postExec = findPostExecution(events);
    expect(postExec).toBeDefined();
    expect(postExec.hasChanges).toBe(true);
    expect(postExec.pushed).toBe(true);
    expect(postExec.verification.verdict).toBe("INCONCLUSIVE");
    expect(postExec.verification.publishMode).toBe("draft");
    expect(postExec.verification.caveats).toEqual(
      expect.arrayContaining([expect.stringContaining("Session stopped before post-execution publish preparation")]),
    );
  });

  it("failure-context: does not publish changes when memory enforcement failed", async () => {
    const { ctx, events, gitOps } = makeContext();

    await run(ctx, {
      failureContext: {
        kind: "prompt_error",
        reason: "Memory block enforcement failed",
        errorCode: "memory_enforcement_failed",
      },
    });

    const postExec = findPostExecution(events);
    expect(postExec).toBeDefined();
    expect(postExec.hasChanges).toBe(false);
    expect(postExec.noChangeReason).toBe("post_prep_failed");
    expect(postExec.verification.verdict).toBe("INCONCLUSIVE");
    expect(postExec.verification.publishMode).toBe("draft");
    expect(gitOps.commitAndPush).not.toHaveBeenCalled();
  });

  it("failure-context: labels post-prep finalization failure distinctly from prep failure", async () => {
    const promptLog = createLogger();
    const { ctx, events } = makeContext({
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => ({ ...CHANGED_DIFF })),
        commitAndPush: vi.fn(async () => {
          throw new Error("push unavailable");
        }),
        readCurrentGitState: vi.fn(() => ({ branch: "cycloid/test-branch", commitSha: "abc123" })),
      },
    });

    await run(ctx, {
      promptLog,
      failureContext: { kind: "aborted", reason: "user stopped the session" },
    });

    const postExec = findPostExecution(events);
    expect(ctx.gitOps.stageAndComputeDiffs).toHaveBeenCalledTimes(1);
    expect(postExec).toMatchObject({
      hasChanges: false,
      noChangeReason: "post_prep_failed",
      verification: {
        verdict: "INCONCLUSIVE",
        publishMode: "draft",
      },
    });
    expect(postExec.verification.caveats).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Abnormal post-execution finalization failed before publishable changes could be proven",
        ),
      ]),
    );
    const completedLog = promptLog.info.mock.calls.find(
      ([fields]) => fields && fields.event === "post_execution.completed",
    );
    expect(completedLog?.[0]).toMatchObject({ hasChanges: false, noChangeReason: "post_prep_failed" });
  });

  it("verification: blocks staged verifier edits instead of pushing fixes", async () => {
    const { ctx, events, gitOps } = makeContext({
      config: {
        sandboxId: "sbx-1",
        sessionId: "sess-1",
        controlPlaneUrl: "https://cp.example",
        agentRole: "verification",
      },
    });
    gitOps.readCurrentGitState.mockReturnValue({ branch: "feature/pr-head", commitSha: "base123" });

    await run(ctx, {
      agentRole: "verification",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      verificationPrContext: {
        prUrl: "https://github.com/acme/widgets/pull/12",
        owner: "acme",
        repo: "widgets",
        number: 12,
        title: "Fix auth",
        body: null,
        state: "open",
        draft: true,
        headRef: "feature/pr-head",
        headSha: "base123",
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRef: "main",
        authorLogin: "octocat",
        files: [],
        commits: [],
        checksSummary: null,
        vercelDeployPreview: null,
        recentDiscussion: [],
        fetchWarnings: [],
      },
      responseText: [
        "I accidentally fixed the typo and ran tests.",
        "```cycloid-verification-result",
        JSON.stringify({
          verdict: "CONCLUSIVE",
          verifiedHeadSha: "base123",
          summary: "Verified after an accidental local edit.",
          evidence: ["npm test passed"],
          blockers: [],
        }),
        "```",
      ].join("\n"),
    });

    const postExec = findPostExecution(events);
    expect(gitOps.commitAndPush).not.toHaveBeenCalled();
    expect(gitOps.commitAndPushCurrentBranch).not.toHaveBeenCalled();
    expect(postExec).toMatchObject({
      hasChanges: false,
      noChangeReason: "no_staged_files",
      publishMode: "normal",
    });
    expect(postExec.prBody).toBeUndefined();
    expect(postExec.verifierResult).toMatchObject({
      verdict: "CONCLUSIVE",
      verifiedHeadSha: "base123",
    });
    expect(postExec.verifierResult.blockers).toEqual([]);
    expect(postExec.verifierResult.evidence).toEqual(expect.arrayContaining(["npm test passed"]));
    expect(postExec.verification).toMatchObject({ verdict: "CONFIRMED" });
    expect(postExec.verification.caveats).toEqual(
      expect.arrayContaining([
        "QA Tester session modified tracked files: src/app.ts.",
        "QA Tester sessions must report failures and evidence without editing, committing, or pushing code.",
      ]),
    );
  });

  it("verification: ignores legacy verifierCommits reporting when the worktree is clean", async () => {
    const { ctx, events, gitOps } = makeContext({
      config: {
        sandboxId: "sbx-1",
        sessionId: "sess-1",
        controlPlaneUrl: "https://cp.example",
        agentRole: "verification",
      },
    });
    gitOps.stageAndComputeDiffs.mockReturnValue({
      hasChanges: true,
      hasStagedFiles: false,
      stagedFiles: [],
      publishFiles: ["src/app.ts"],
      diffSummary: "src/app.ts | 2 +-",
      diffStat: "",
      fullDiff: "diff --git a/src/app.ts b/src/app.ts",
    });
    gitOps.readCurrentGitState.mockReturnValue({ branch: "feature/pr-head", commitSha: "fix123" });

    await run(ctx, {
      agentRole: "verification",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      verificationPrContext: {
        prUrl: "https://github.com/acme/widgets/pull/12",
        owner: "acme",
        repo: "widgets",
        number: 12,
        title: "Fix auth",
        body: null,
        state: "open",
        draft: true,
        headRef: "feature/pr-head",
        headSha: "base123",
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRef: "main",
        authorLogin: "octocat",
        files: [],
        commits: [],
        checksSummary: null,
        vercelDeployPreview: null,
        recentDiscussion: [],
        fetchWarnings: [],
      },
      responseText: [
        "Committed a verifier fix and ran tests.",
        "```cycloid-verification-result",
        JSON.stringify({
          verdict: "CONCLUSIVE",
          verifiedHeadSha: "fix123",
          summary: "Fixed and verified.",
          evidence: ["npm test passed"],
          blockers: [],
          verifierCommits: [{ sha: "fix123", message: "Verifier local fix" }],
        }),
        "```",
      ].join("\n"),
    });

    const postExec = findPostExecution(events);
    expect(gitOps.commitAndPush).not.toHaveBeenCalled();
    expect(gitOps.commitAndPushCurrentBranch).not.toHaveBeenCalled();
    expect(postExec).toMatchObject({
      hasChanges: false,
      noChangeReason: "no_diff",
      publishMode: "normal",
    });
    expect(postExec.verifierResult).toMatchObject({
      verdict: "CONCLUSIVE",
      verifiedHeadSha: "fix123",
    });
    expect(postExec.verifierResult.blockers).toEqual([]);
  });

  it("verification: does not commit when the PR has changes but the verifier made no staged fixes", async () => {
    const screenshot = {
      artifactId: "art-1",
      type: "screenshot",
      label: "readme-title-emoji.png",
      filename: "readme-title-emoji.png",
      url: "https://app.example/api/sessions/sess-1/artifacts/art-1/readme-title-emoji.png",
    };
    const { ctx, events, gitOps } = makeContext({
      config: {
        sandboxId: "sbx-1",
        sessionId: "sess-1",
        controlPlaneUrl: "https://cp.example",
        agentRole: "verification",
      },
      collectVerificationArtifacts: vi.fn(async () => [screenshot]),
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => ({
          hasChanges: true,
          hasStagedFiles: false,
          stagedFiles: [],
          publishFiles: ["README.md"],
          diffSummary: "README.md | 2 +-",
          diffStat: "",
          fullDiff: "diff --git a/README.md b/README.md",
        })),
        commitAndPush: vi.fn(),
        commitAndPushCurrentBranch: vi.fn(),
        readCurrentGitState: vi.fn(() => ({ branch: "feature/pr-head", commitSha: "base123" })),
      },
    });

    await run(ctx, {
      agentRole: "verification",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      verificationPrContext: {
        prUrl: "https://github.com/acme/widgets/pull/12",
        owner: "acme",
        repo: "widgets",
        number: 12,
        title: "Fix auth",
        body: null,
        state: "open",
        draft: true,
        headRef: "feature/pr-head",
        headSha: "base123",
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRef: "main",
        authorLogin: "octocat",
        files: [],
        commits: [],
        checksSummary: null,
        vercelDeployPreview: null,
        recentDiscussion: [],
        fetchWarnings: [],
      },
      responseText: [
        "Verified the existing PR change and captured a screenshot.",
        "```cycloid-verification-result",
        JSON.stringify({
          verdict: "CONCLUSIVE",
          verifiedHeadSha: "base123",
          summary: "Verified without changes.",
          evidence: ["Screenshot captured."],
          blockers: [],
        }),
        "```",
      ].join("\n"),
    });

    const postExec = findPostExecution(events);
    expect(gitOps.commitAndPush).not.toHaveBeenCalled();
    expect(gitOps.commitAndPushCurrentBranch).not.toHaveBeenCalled();
    expect(postExec).toMatchObject({
      hasChanges: false,
      noChangeReason: "no_diff",
      publishMode: "normal",
      verifierResult: {
        verdict: "CONCLUSIVE",
        verifiedHeadSha: "base123",
        evidenceRefs: [
          expect.objectContaining({
            artifactId: "art-1",
            label: "readme-title-emoji.png",
            type: "screenshot",
            status: "uploaded",
            url: "https://app.example/api/sessions/sess-1/artifacts/art-1/readme-title-emoji.png",
          }),
        ],
      },
      verification: {
        artifacts: [screenshot],
        evidence: [
          expect.objectContaining({
            type: "screenshot",
            label: "readme-title-emoji.png",
            artifactId: "art-1",
            url: "https://app.example/api/sessions/sess-1/artifacts/art-1/readme-title-emoji.png",
            status: "uploaded",
          }),
        ],
      },
    });
    expect(postExec.verification.evidence).not.toEqual(expect.arrayContaining(["Screenshot captured."]));
  });

  it("verification: preserves an inconclusive QA verdict even when artifacts were uploaded", async () => {
    const screenshot = {
      type: "screenshot",
      label: "queued-state.png",
      url: "https://app.example/api/sessions/sess-1/artifacts/art-1/queued-state.png",
    };
    const { ctx, events, gitOps } = makeContext({
      config: {
        sandboxId: "sbx-1",
        sessionId: "sess-1",
        controlPlaneUrl: "https://cp.example",
        agentRole: "verification",
      },
      collectVerificationArtifacts: vi.fn(async () => [screenshot]),
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => ({
          hasChanges: true,
          hasStagedFiles: false,
          stagedFiles: [],
          publishFiles: ["apps/ui/src/components/SessionDetail.tsx"],
          diffSummary: "apps/ui/src/components/SessionDetail.tsx | 2 +-",
          diffStat: "",
          fullDiff: "diff --git a/apps/ui/src/components/SessionDetail.tsx b/apps/ui/src/components/SessionDetail.tsx",
        })),
        commitAndPush: vi.fn(),
        commitAndPushCurrentBranch: vi.fn(),
        readCurrentGitState: vi.fn(() => ({ branch: "feature/pr-head", commitSha: "base123" })),
      },
    });

    await run(ctx, {
      agentRole: "verification",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      verificationPrContext: {
        prUrl: "https://github.com/acme/widgets/pull/12",
        owner: "acme",
        repo: "widgets",
        number: 12,
        title: "Fix queued prompt UI",
        body: null,
        state: "open",
        draft: true,
        headRef: "feature/pr-head",
        headSha: "base123",
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRef: "main",
        authorLogin: "octocat",
        files: [],
        commits: [],
        checksSummary: null,
        vercelDeployPreview: null,
        recentDiscussion: [],
        fetchWarnings: [],
      },
      responseText: [
        "Captured artifacts, but the live app could not prove the queued session flow.",
        "```cycloid-verification-result",
        JSON.stringify({
          verdict: "INCONCLUSIVE",
          verifiedHeadSha: "base123",
          needsWorkLabel: "verification-gap",
          summary: "Queued prompt behavior was only proven in a controlled fixture.",
          evidence: ["Screenshot captured from controlled fixture."],
          blockers: ["Real PR-head app session could not be operated."],
        }),
        "```",
      ].join("\n"),
    });

    const postExec = findPostExecution(events);
    expect(gitOps.commitAndPush).not.toHaveBeenCalled();
    expect(gitOps.commitAndPushCurrentBranch).not.toHaveBeenCalled();
    expect(postExec).toMatchObject({
      hasChanges: false,
      noChangeReason: "no_diff",
      publishMode: "draft",
      verifierResult: {
        verdict: "INCONCLUSIVE",
        verifiedHeadSha: "base123",
        blockers: ["Real PR-head app session could not be operated."],
      },
      verification: {
        verified: false,
        verdict: "INCONCLUSIVE",
        status: "manual_review_required",
        publishMode: "draft",
        explanation: "Queued prompt behavior was only proven in a controlled fixture.",
        artifacts: [screenshot],
      },
    });
  });

  it("verification: reports inconclusive without pushing when staged verifier edits exist", async () => {
    const screenshot = {
      type: "screenshot",
      label: "push-denied.png",
      url: "https://app.example/api/sessions/sess-1/artifacts/art-1/push-denied.png",
    };
    const { ctx, events, gitOps } = makeContext({
      config: {
        sandboxId: "sbx-1",
        sessionId: "sess-1",
        controlPlaneUrl: "https://cp.example",
        agentRole: "verification",
      },
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => ({ ...CHANGED_DIFF })),
        commitAndPush: vi.fn(),
        commitAndPushCurrentBranch: vi.fn(async () => ({
          ok: false,
          branch: "feature/pr-head",
          commitSha: "local123",
          reason: "push_failed",
          error: "permission denied",
        })),
        readCurrentGitState: vi.fn(() => ({ branch: "feature/pr-head", commitSha: "local123" })),
      },
      collectVerificationArtifacts: vi.fn(async () => [screenshot]),
    });

    await run(ctx, {
      agentRole: "verification",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      verificationPrContext: {
        prUrl: "https://github.com/acme/widgets/pull/12",
        owner: "acme",
        repo: "widgets",
        number: 12,
        title: "Fix auth",
        body: null,
        state: "open",
        draft: true,
        headRef: "feature/pr-head",
        headSha: "base123",
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRef: "main",
        authorLogin: "octocat",
        files: [],
        commits: [],
        checksSummary: null,
        vercelDeployPreview: null,
        recentDiscussion: [],
        fetchWarnings: [],
      },
    });

    const postExec = findPostExecution(events);
    expect(gitOps.commitAndPush).not.toHaveBeenCalled();
    expect(gitOps.commitAndPushCurrentBranch).not.toHaveBeenCalled();
    expect(postExec).toMatchObject({
      hasChanges: false,
      noChangeReason: "no_staged_files",
    });
    expect(postExec.commitSha).toBeUndefined();
    expect(postExec.verifierResult).toMatchObject({
      verdict: "INCONCLUSIVE",
    });
    expect(postExec.verifierResult.verifiedHeadSha).toBe("");
    expect(postExec.verifierResult.blockers).toEqual(
      expect.arrayContaining([
        "QA Tester session modified tracked files: src/app.ts.",
        "QA Tester sessions must report failures and evidence without editing, committing, or pushing code.",
      ]),
    );
    expect(postExec.verification.artifacts).toEqual([screenshot]);
  });

  it("verification: preserves conclusive QA Tester output when the final checkout is not the PR head", async () => {
    const { ctx, events } = makeContext({
      config: {
        sandboxId: "sbx-1",
        sessionId: "sess-1",
        controlPlaneUrl: "https://cp.example",
        agentRole: "verification",
      },
      gitOps: {
        stageAndComputeDiffs: vi.fn(() => ({
          hasChanges: false,
          hasStagedFiles: false,
          stagedFiles: [],
          publishFiles: [],
        })),
        commitAndPush: vi.fn(),
        commitAndPushCurrentBranch: vi.fn(),
        readCurrentGitState: vi.fn(() => ({ branch: "main", commitSha: "base-main" })),
      },
    });

    await run(ctx, {
      agentRole: "verification",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      verificationPrContext: {
        prUrl: "https://github.com/acme/widgets/pull/12",
        owner: "acme",
        repo: "widgets",
        number: 12,
        title: "Fix auth",
        body: null,
        state: "open",
        draft: true,
        headRef: "feature/pr-head",
        headSha: "pr-head",
        headRepoOwner: "acme",
        headRepoName: "widgets",
        baseRef: "main",
        authorLogin: "octocat",
        files: [],
        commits: [],
        checksSummary: null,
        vercelDeployPreview: null,
        recentDiscussion: [],
        fetchWarnings: [],
      },
      responseText: [
        "Verification passed.",
        "```cycloid-verification-result",
        JSON.stringify({
          verdict: "CONCLUSIVE",
          verifiedHeadSha: "pr-head",
          needsWorkLabel: "verification-gap",
          summary: "Verified the PR.",
          evidence: ["npm test passed"],
          blockers: [],
        }),
        "```",
      ].join("\n"),
    });

    const postExec = findPostExecution(events);
    expect(postExec).toMatchObject({
      hasChanges: false,
      verifierResult: {
        verdict: "CONCLUSIVE",
        verifiedHeadSha: "pr-head",
        needsWorkLabel: "verification-gap",
      },
    });
    expect(postExec.verifierResult.summary).toBe("Verified the PR.");
    expect(postExec.verifierResult.blockers).toEqual([]);
    expect(postExec.verification).toMatchObject({ verdict: "CONFIRMED" });
    expect(postExec.verification.caveats).toEqual(
      expect.arrayContaining([
        "Verifier branch validation warning: expected feature/pr-head, current checkout is main.",
      ]),
    );
  });

  it("verification: blocks staged verifier edits before any fork-branch push", async () => {
    const { ctx, events, gitOps } = makeContext({
      config: {
        sandboxId: "sbx-1",
        sessionId: "sess-1",
        controlPlaneUrl: "https://cp.example",
        agentRole: "verification",
      },
    });

    await run(ctx, {
      agentRole: "verification",
      targetPrUrl: "https://github.com/acme/widgets/pull/12",
      verificationPrContext: {
        prUrl: "https://github.com/acme/widgets/pull/12",
        owner: "acme",
        repo: "widgets",
        number: 12,
        title: "Fix auth",
        body: null,
        state: "open",
        draft: true,
        headRef: "feature/pr-head",
        headSha: "base123",
        headRepoOwner: "contributor",
        headRepoName: "widgets-fork",
        baseRef: "main",
        authorLogin: "octocat",
        files: [],
        commits: [],
        checksSummary: null,
        vercelDeployPreview: null,
        recentDiscussion: [],
        fetchWarnings: [],
      },
    });

    const postExec = findPostExecution(events);
    expect(gitOps.commitAndPushCurrentBranch).not.toHaveBeenCalled();
    expect(postExec).toMatchObject({ hasChanges: false, noChangeReason: "no_staged_files" });
    expect(postExec.verifierResult).toMatchObject({
      verdict: "INCONCLUSIVE",
    });
    expect(postExec.verifierResult.blockers).toEqual(
      expect.arrayContaining([
        "QA Tester session modified tracked files: src/app.ts.",
        "QA Tester sessions must report failures and evidence without editing, committing, or pushing code.",
      ]),
    );
  });
});

describe("PostExecutionRunner serialization + snapshot semantics", () => {
  it("waits for the prior pending post-execution before staging git state", async () => {
    let releasePrior;
    const priorReleased = vi.fn();
    const prior = new Promise((resolve) => {
      releasePrior = () => {
        priorReleased();
        resolve();
      };
    });
    const order = [];
    const { ctx } = makeContext({
      getPendingPostExecution: () => prior,
      gitOps: {
        // undefined → clean prep-failed early return; exercises only the serialization guard.
        stageAndComputeDiffs: vi.fn(() => {
          order.push("stage");
          return undefined;
        }),
        commitAndPush: vi.fn(),
        readCurrentGitState: vi.fn(() => ({})),
      },
    });

    const runPromise = run(ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(priorReleased).not.toHaveBeenCalled();
    expect(order).toEqual([]);

    releasePrior();
    await runPromise;

    expect(priorReleased).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["stage"]);
  });

  it("snapshots the active BT span at entry and retains it across the prior-promise await", async () => {
    const childSpan = { end: vi.fn() };
    const parentSpan = { startSpan: vi.fn(() => childSpan) };
    let releasePrior;
    const prior = new Promise((resolve) => {
      releasePrior = () => resolve();
    });

    let traceMeta = { promptId: "msg-1", agent: "codex", model: "gpt-5.4" };
    let btSpan = parentSpan;
    const { ctx } = makeContext({
      getPendingPostExecution: () => prior,
      getActivePromptTraceMeta: () => traceMeta,
      getActiveBtPromptSpan: () => btSpan,
    });

    const runPromise = run(ctx);
    // Simulate handlePrompt teardown clearing the bridge fields while the runner is parked on
    // the prior promise. The entry snapshot must have already captured the parent span.
    await Promise.resolve();
    traceMeta = null;
    btSpan = null;
    releasePrior();
    await runPromise;

    expect(parentSpan.startSpan).toHaveBeenCalledTimes(1);
    expect(childSpan.end).toHaveBeenCalledTimes(1);
  });
});

describe("PostExecutionRunner telemetry", () => {
  it("includes the repo slug from getRepoSlug on the post_execution.completed log", async () => {
    const promptLog = createLogger();
    const { ctx } = makeContext({ getRepoSlug: () => "acme/widgets" });

    await run(ctx, { promptLog });

    const startedLog = promptLog.info.mock.calls.find(
      ([fields]) => fields && fields.event === "post_execution.started",
    );
    expect(startedLog).toBeDefined();
    expect(startedLog[0]).toMatchObject({
      observabilityUtility: "progress",
      repo: "acme/widgets",
      agentRole: "implementation",
    });
    const stepLog = promptLog.info.mock.calls.find(
      ([fields]) =>
        fields &&
        fields.event === "post_execution.step" &&
        fields.step === "post_execution.prep" &&
        fields.phase_status === "completed",
    );
    expect(stepLog).toBeDefined();
    expect(stepLog[0]).toMatchObject({ observabilityUtility: "progress", repo: "acme/widgets" });
    const terminalLog = promptLog.info.mock.calls.find(
      ([fields]) => fields && fields.event === "post_execution.terminal",
    );
    expect(terminalLog).toBeDefined();
    expect(terminalLog[0]).toMatchObject({ observabilityUtility: "decision", repo: "acme/widgets" });
    const completedLog = promptLog.info.mock.calls.find(
      ([fields]) => fields && fields.event === "post_execution.completed",
    );
    expect(completedLog).toBeDefined();
    expect(completedLog[0].repo).toBe("acme/widgets");
    expect(completedLog[0].observabilityUtility).toBe("decision");
  });

  it("preserves empty-string verdict values on post_execution.completed logs", () => {
    const promptLog = createLogger();
    const { ctx } = makeContext();

    new PostExecutionRunner(ctx).logPostExecutionCompleted(promptLog, {
      messageId: "msg-1",
      outcome: "success",
      durationMs: 1,
      hasChanges: true,
      verdict: "",
    });

    const completedLog = promptLog.info.mock.calls.find(
      ([fields]) => fields && fields.event === "post_execution.completed",
    );
    expect(completedLog).toBeDefined();
    expect(completedLog[0]).toHaveProperty("verdict", "");
  });
});
