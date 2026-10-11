// @ts-nocheck -- sandbox-bridge is excluded from root tsconfig
import { describe, expect, it, vi } from "vitest";

import { OpencodeRuntimeAdapter } from "../../apps/sandbox-bridge/src/agent/opencode-runtime-adapter.js";
import { PromptLoopState } from "../../apps/sandbox-bridge/src/prompt-loop-state.js";
import { BasetenModel } from "../../shared/constants/models.js";

function makeLog() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return log;
}

function makeAdapter() {
  const adapter = new OpencodeRuntimeAdapter({
    getCwd: () => "/workspace",
    log: makeLog(),
    startupTimeoutMs: 1_000,
    withPromptActivityPulse: (_id, _phase, work) => work(),
    getSandboxToken: () => "tok-test",
    getRolloutUploadUrl: () => "https://cp.example.test/api/sessions/session-1/rollout",
  });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const postSessionIdPermissionsPermissionId = vi.fn().mockResolvedValue({ data: {} });
  adapter.session.client = { session: { promptAsync }, postSessionIdPermissionsPermissionId };
  adapter.activeSessionId = "session-1";
  return { adapter, promptAsync, postSessionIdPermissionsPermissionId };
}

function makeRequest(overrides = {}) {
  return {
    parts: [{ type: "text", text: "fix the bug" }],
    agent: "build",
    agentRole: "implementation",
    system: "Per-prompt context",
    ...overrides,
  };
}

function sentSystem(promptAsync) {
  return promptAsync.mock.calls[0][0].body.system;
}

function sentParts(promptAsync) {
  return promptAsync.mock.calls[0][0].body.parts;
}

function makeQuestionReplyDeps(overrides = {}) {
  return {
    sendEvent: vi.fn(),
    sandboxId: "sandbox-1",
    log: makeLog(),
    getPendingQuestion: vi.fn(() => null),
    setPendingQuestion: vi.fn(),
    isQuestionResolved: vi.fn(() => false),
    markQuestionResolved: vi.fn(),
    ...overrides,
  };
}

function makeTranslateDeps(log = makeLog()) {
  return {
    now: 1000,
    messageId: "msg-1",
    emit: vi.fn(),
    logToBt: vi.fn(),
    promptLog: log,
    markPromptStarted: vi.fn(),
    recordRawFallback: vi.fn(),
  };
}

function makePromptState() {
  return {
    abortReason: null,
    dispatchSucceeded: true,
    handledAutomaticallyBlockCount: 0,
    promptRetryCount: 0,
    promptRetryCountsByErrorCode: {},
  };
}

const toolTracker = { startSpan: vi.fn(), endSpan: vi.fn(), forceEndAll: vi.fn(), activeSpanCount: 0 };

describe("OpencodeRuntimeAdapter prompt assembly", () => {
  it("does not forward Codex reasoning summaries", async () => {
    const { adapter, promptAsync } = makeAdapter();

    await adapter.sendPrompt(makeRequest({ summary: "auto" }), {
      sessionId: "session-1",
      signal: new AbortController().signal,
    });

    expect(promptAsync.mock.calls[0][0].body).not.toHaveProperty("summary");
  });

  it("forwards image file parts to opencode instead of degrading them to text", async () => {
    const { adapter, promptAsync } = makeAdapter();

    await adapter.sendPrompt(
      makeRequest({
        parts: [
          { type: "text", text: "inspect this" },
          { type: "file", mime: "image/png", filename: "screen.png", url: "data:image/png;base64,QUJD" },
        ],
      }),
      { sessionId: "session-1", signal: new AbortController().signal },
    );

    expect(sentParts(promptAsync)).toEqual([
      { type: "text", text: "inspect this" },
      { type: "file", mime: "image/png", filename: "screen.png", url: "data:image/png;base64,QUJD" },
    ]);
  });

  it("fails closed when a prompt model override differs from the initialized runtime model", async () => {
    const { adapter } = makeAdapter();
    adapter.session.activeModelId = "retired-opencode-model";

    await expect(
      adapter.sendPrompt(makeRequest({ model: BasetenModel.KimiK27Code }), {
        sessionId: "session-1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("does not match initialized runtime model");
  });

  // These assert `.rejects` (not synchronous `.toThrow`): sendPrompt is async so
  // validation failures surface as a rejected promise, which is what lets
  // runDispatchPhase's `.catch()` close the event stream.
  it("fails closed for unsupported image MIME types", async () => {
    const { adapter } = makeAdapter();

    await expect(
      adapter.sendPrompt(
        makeRequest({
          parts: [
            { type: "file", mime: "image/svg+xml", filename: "diagram.svg", url: "data:image/svg+xml;base64,PHN2Zy8+" },
          ],
        }),
        { sessionId: "session-1", signal: new AbortController().signal },
      ),
    ).rejects.toThrow("Opencode image input does not support MIME type 'image/svg+xml'");
  });

  it("fails closed for a data-URL MIME that mismatches the declared part MIME", async () => {
    const { adapter } = makeAdapter();

    await expect(
      adapter.sendPrompt(
        makeRequest({
          parts: [{ type: "file", mime: "image/png", filename: "screen.png", url: "data:image/jpeg;base64,QUJD" }],
        }),
        { sessionId: "session-1", signal: new AbortController().signal },
      ),
    ).rejects.toThrow("MIME mismatch for 'screen.png': part declares 'image/png' but data URL is 'image/jpeg'");
  });

  it("fails closed for oversized inline images", async () => {
    const { adapter } = makeAdapter();
    const oversizedBase64 = "A".repeat(28 * 1024 * 1024);

    await expect(
      adapter.sendPrompt(
        makeRequest({
          parts: [
            { type: "file", mime: "image/png", filename: "large.png", url: `data:image/png;base64,${oversizedBase64}` },
          ],
        }),
        { sessionId: "session-1", signal: new AbortController().signal },
      ),
    ).rejects.toThrow("above the 20971520 byte limit");
  });

  it("injects first-party dynamic tool guidance when tools are provisioned", async () => {
    const previous = {
      DD_API_KEY: process.env.DD_API_KEY,
      DD_APP_KEY: process.env.DD_APP_KEY,
      DD_SITE: process.env.DD_SITE,
    };
    process.env.DD_API_KEY = "dd-api";
    process.env.DD_APP_KEY = "dd-app";
    process.env.DD_SITE = "datadoghq.com";
    try {
      const { adapter, promptAsync } = makeAdapter();

      await adapter.sendPrompt(makeRequest(), { sessionId: "session-1", signal: new AbortController().signal });

      const system = sentSystem(promptAsync);
      expect(system).toContain("# First-party dynamic tools");
      expect(system).toContain("datadog.search_datadog_logs");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("prepends implementation static guidance before per-prompt context", async () => {
    const { adapter, promptAsync } = makeAdapter();

    await adapter.sendPrompt(makeRequest(), { sessionId: "session-1", signal: new AbortController().signal });

    const system = sentSystem(promptAsync);
    expect(system).toContain("# Git restrictions");
    expect(system).toContain("handled automatically");
    expect(system).toContain("Per-prompt context");
    expect(system.indexOf("# Sandbox environment")).toBeLessThan(system.indexOf("Per-prompt context"));
  });

  it("sends implementation static guidance even when per-prompt context is empty", async () => {
    const { adapter, promptAsync } = makeAdapter();

    await adapter.sendPrompt(makeRequest({ system: "" }), {
      sessionId: "session-1",
      signal: new AbortController().signal,
    });

    const system = sentSystem(promptAsync);
    expect(system).toContain("# Git restrictions");
    expect(system).toContain("handled automatically");
  });

  it("uses verification static guidance without implementation git restrictions", async () => {
    const { adapter, promptAsync } = makeAdapter();

    await adapter.sendPrompt(makeRequest({ agent: "verify", agentRole: "verification", system: "" }), {
      sessionId: "session-1",
      signal: new AbortController().signal,
    });

    const system = sentSystem(promptAsync);
    expect(system).toContain("# Sandbox environment");
    expect(system).not.toContain("# Git restrictions");
    expect(system).not.toContain("handled automatically");
  });

  it("approves opencode permission requests from question replies", async () => {
    const { adapter, postSessionIdPermissionsPermissionId } = makeAdapter();
    const deps = makeQuestionReplyDeps();

    adapter.respondToQuestion(deps, "Approve once", "perm-1");
    await vi.waitFor(() => {
      expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
        path: { id: "session-1", permissionID: "perm-1" },
        body: { response: "once" },
      });
    });
    expect(deps.markQuestionResolved).toHaveBeenCalledWith("perm-1");
  });

  it("rejects opencode permission requests from negative question replies", async () => {
    const { adapter, postSessionIdPermissionsPermissionId } = makeAdapter();

    adapter.respondToQuestion(makeQuestionReplyDeps(), "no, do not run it", "perm-1");
    await vi.waitFor(() => {
      expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
        path: { id: "session-1", permissionID: "perm-1" },
        body: { response: "reject" },
      });
    });
  });

  it("fails closed on an ambiguous permission reply (rejects, does not approve)", async () => {
    const { adapter, postSessionIdPermissionsPermissionId } = makeAdapter();

    adapter.respondToQuestion(makeQuestionReplyDeps(), "maybe later", "perm-1");
    await vi.waitFor(() => {
      expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
        path: { id: "session-1", permissionID: "perm-1" },
        body: { response: "reject" },
      });
    });
  });

  it("marks the question resolved synchronously, before the permission POST settles", () => {
    const { adapter, postSessionIdPermissionsPermissionId } = makeAdapter();
    // A never-settling POST: the dedup marker must be set up front so a
    // redelivered answer arriving mid-flight is suppressed.
    postSessionIdPermissionsPermissionId.mockReturnValue(new Promise(() => {}));
    const deps = makeQuestionReplyDeps();

    adapter.respondToQuestion(deps, "Approve once", "perm-1");

    expect(deps.markQuestionResolved).toHaveBeenCalledWith("perm-1");
  });

  it("ignores redelivered opencode permission replies", () => {
    const { adapter, postSessionIdPermissionsPermissionId } = makeAdapter();

    adapter.respondToQuestion(makeQuestionReplyDeps({ isQuestionResolved: vi.fn(() => true) }), "Approve", "perm-1");

    expect(postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
  });

  it("auto-replies to opencode permission.asked using the active session path", async () => {
    const { adapter, postSessionIdPermissionsPermissionId } = makeAdapter();

    await adapter.translateEvent(
      {
        type: "permission.asked",
        data: {
          id: "perm-1",
          sessionID: "session-1",
          permission: "bash",
          patterns: ["npm test"],
          always: [],
        },
      },
      makeTranslateDeps(),
      new PromptLoopState(),
      makePromptState(),
      toolTracker,
    );

    expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
      path: { id: "session-1", permissionID: "perm-1" },
      body: { response: "once" },
    });
  });

  it("auto-replies to child-session opencode permissions on the child session path", async () => {
    const { adapter, postSessionIdPermissionsPermissionId } = makeAdapter();

    await adapter.translateEvent(
      {
        type: "permission.asked",
        data: {
          id: "perm-child-1",
          sessionID: "child-session-1",
          permission: "bash",
          patterns: ["npm test"],
          always: [],
        },
      },
      makeTranslateDeps(),
      new PromptLoopState(),
      makePromptState(),
      toolTracker,
    );

    expect(postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
      path: { id: "child-session-1", permissionID: "perm-child-1" },
      body: { response: "once" },
    });
  });

  it("logs and aborts when an opencode permission auto-reply POST fails", async () => {
    const { adapter, postSessionIdPermissionsPermissionId } = makeAdapter();
    const log = makeLog();
    const promptState = makePromptState();
    postSessionIdPermissionsPermissionId.mockRejectedValueOnce(new Error("post failed"));

    const outcome = await adapter.translateEvent(
      {
        type: "permission.asked",
        data: {
          id: "perm-1",
          sessionID: "session-1",
          permission: "bash",
          patterns: ["npm test"],
          always: [],
        },
      },
      makeTranslateDeps(log),
      new PromptLoopState(),
      promptState,
      toolTracker,
    );

    expect(outcome).toEqual({ control: "break" });
    expect(promptState.abortReason).toBe("Failed to reply to opencode permission request");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "opencode.permission.auto_reply_failed", permissionId: "perm-1" }),
      "Failed to auto-reply to opencode permission request",
    );
  });

  it("logs and aborts when an opencode permission auto-reply POST hangs past the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, postSessionIdPermissionsPermissionId } = makeAdapter();
      const log = makeLog();
      const promptState = makePromptState();
      let rejectPost: (error: Error) => void = () => {};
      postSessionIdPermissionsPermissionId.mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectPost = reject;
        }),
      );

      const outcomePromise = adapter.translateEvent(
        {
          type: "permission.asked",
          data: {
            id: "perm-1",
            sessionID: "session-1",
            permission: "bash",
            patterns: ["npm test"],
            always: [],
          },
        },
        makeTranslateDeps(log),
        new PromptLoopState(),
        promptState,
        toolTracker,
      );

      await vi.advanceTimersByTimeAsync(10_000);
      const outcome = await outcomePromise;

      expect(outcome).toEqual({ control: "break" });
      expect(promptState.abortReason).toBe("Failed to reply to opencode permission request");
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "opencode.permission.reply_timeout",
          permissionId: "perm-1",
          timeout_ms: 10_000,
        }),
        "Opencode permission reply timed out",
      );
      rejectPost(new Error("late post failure"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });
});
