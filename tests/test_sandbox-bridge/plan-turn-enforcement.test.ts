import { describe, expect, it, vi } from "vitest";

import { CodexRuntimeAdapter } from "../../apps/sandbox-bridge/src/agent/agent-runtime-adapter.js";
import { ClaudeCodeRuntimeAdapter } from "../../apps/sandbox-bridge/src/agent/claude-runtime-adapter.js";
import { ClaudeSessionManager } from "../../apps/sandbox-bridge/src/services/claude-session.js";
import { codexTurnSandboxPolicyForTurnMode } from "../../apps/sandbox-bridge/src/services/codex-server.js";
import { resolveOpencodePermissionDecision } from "../../apps/sandbox-bridge/src/services/opencode-event-translator.js";
import {
  buildOpencodeAgentConfig,
  OPENCODE_HEADLESS_PERMISSIONS,
} from "../../apps/sandbox-bridge/src/services/opencode-session.js";
import { checkToolSafety } from "../../apps/sandbox-bridge/src/utils/protection.js";
import {
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
  CODEX_AGENT_RUNTIME_BACKEND,
  OPENCODE_AGENT_RUNTIME_BACKEND,
} from "../../shared/agent/agent-runtime-backend.js";
import { BACKEND_CAPABILITIES, backendSupports } from "../../shared/agent/backend-capabilities.js";
import { BUILTIN_AGENTS, PLAN_AGENT_NAME, turnModeForAgentProfile } from "../../shared/agent/constants.js";

function makeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return log;
}

function makeClaudeAdapter() {
  return new ClaudeCodeRuntimeAdapter({
    getCwd: () => "/workspace",
    log: makeLog(),
    getSandboxToken: () => "tok",
    getRolloutUploadUrl: () => "https://cp.test/api/sessions/s1/rollout",
  });
}

function makeCodexAdapter() {
  const adapter = new CodexRuntimeAdapter({
    createCodex: vi.fn(),
    getCwd: () => "/workspace",
    log: makeLog(),
    startupTimeoutMs: 1_000,
    stdioLineMaxBytes: 1024,
    stdioSessionMaxBytes: 1024,
    logResourceSnapshot: () => ({}),
    withPromptActivityPulse: (_id, _phase, work) => work(),
    getSandboxToken: () => "tok",
    getRolloutUploadUrl: () => "https://cp.test/api/sessions/s1/rollout",
  });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  adapter["session"].client = {
    session: {
      promptAsync,
    },
  } as never;
  return { adapter, promptAsync };
}

describe("plan turn enforcement", () => {
  it("declares plan-turn read-only support and explicit backend gaps", () => {
    expect(backendSupports(CLAUDE_CODE_AGENT_RUNTIME_BACKEND, "planTurnReadOnly")).toBe(true);
    expect(BACKEND_CAPABILITIES[CODEX_AGENT_RUNTIME_BACKEND].planTurnReadOnly).toEqual({ supported: true });
    expect(BACKEND_CAPABILITIES[OPENCODE_AGENT_RUNTIME_BACKEND].planTurnReadOnly).toEqual({ supported: true });
  });

  it("derives neutral turn mode from agent profile", () => {
    expect(turnModeForAgentProfile(PLAN_AGENT_NAME)).toBe("plan");
    expect(turnModeForAgentProfile("build")).toBe("execute");
    expect(turnModeForAgentProfile("verify")).toBe("execute");
  });

  it("Codex maps plan and execute turns to explicit native sandbox policies", () => {
    expect(codexTurnSandboxPolicyForTurnMode("plan")).toEqual({ type: "readOnly", networkAccess: false });
    expect(codexTurnSandboxPolicyForTurnMode("execute")).toEqual({ type: "dangerFullAccess" });
  });

  it("Codex adapter attaches read-only sandbox policy to every plan prompt body", async () => {
    const { adapter, promptAsync } = makeCodexAdapter();

    await adapter.sendPrompt(
      {
        parts: [{ type: "text", text: "inspect the repo" }],
        agent: PLAN_AGENT_NAME,
        agentRole: "implementation",
        turnMode: "plan",
      },
      { sessionId: "sess-1", signal: new AbortController().signal, promptLog: makeLog() },
    );

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        }),
      }),
    );
  });

  it("Codex adapter attaches danger-full-access sandbox policy to execute prompt bodies", async () => {
    const { adapter, promptAsync } = makeCodexAdapter();

    await adapter.sendPrompt(
      {
        parts: [{ type: "text", text: "edit README.md" }],
        agent: "build",
        agentRole: "implementation",
        turnMode: "execute",
      },
      { sessionId: "sess-1", signal: new AbortController().signal, promptLog: makeLog() },
    );

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          sandboxPolicy: { type: "dangerFullAccess" },
        }),
      }),
    );
  });

  it("Codex adapter forwards reasoning summaries and omits unset summaries", async () => {
    const { adapter, promptAsync } = makeCodexAdapter();

    await adapter.sendPrompt(
      {
        parts: [{ type: "text", text: "think through this" }],
        agent: "build",
        agentRole: "implementation",
        turnMode: "execute",
        summary: "auto",
      },
      { sessionId: "sess-1", signal: new AbortController().signal, promptLog: makeLog() },
    );
    expect(promptAsync.mock.calls[0][0].body.summary).toBe("auto");

    await adapter.sendPrompt(
      {
        parts: [{ type: "text", text: "do not summarize" }],
        agent: "build",
        agentRole: "implementation",
        turnMode: "execute",
      },
      { sessionId: "sess-1", signal: new AbortController().signal, promptLog: makeLog() },
    );
    expect(promptAsync.mock.calls[1][0].body).not.toHaveProperty("summary");
  });

  it("Claude Code gate rejects mutating tools in plan mode and allows execute mode", () => {
    expect(checkToolSafety("Write", { file_path: "README.md" }, { agentProfile: PLAN_AGENT_NAME })).toMatchObject({
      reasonKey: "plan_mode_read_only",
    });
    expect(checkToolSafety("bash", { command: "cat README.md" }, { agentProfile: PLAN_AGENT_NAME })).toBeNull();
    expect(checkToolSafety("bash", { command: "echo x > README.md" }, { agentProfile: PLAN_AGENT_NAME })).toMatchObject(
      {
        reasonKey: "plan_mode_read_only",
      },
    );
    expect(checkToolSafety("Write", { file_path: "README.md" }, { agentProfile: "build" })).toBeNull();
  });

  it("keeps the plan bash allowlist when no read-only OS sandbox is declared", () => {
    expect(checkToolSafety("bash", { command: "echo x > README.md" }, { agentProfile: PLAN_AGENT_NAME })).toMatchObject(
      {
        reasonKey: "plan_mode_read_only",
      },
    );
    expect(
      checkToolSafety(
        "bash",
        { command: "echo x > README.md" },
        { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: false },
      ),
    ).toMatchObject({
      reasonKey: "plan_mode_read_only",
    });
  });

  it("lets Codex plan bash rely on the native read-only sandbox for writes and benign reads", () => {
    const codexPlan = { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: true };

    expect(checkToolSafety("bash", { command: "echo x > README.md" }, codexPlan)).toBeNull();
    expect(checkToolSafety("bash", { command: "git diff -- README.md" }, codexPlan)).toBeNull();
    expect(checkToolSafety("bash", { command: "tree -L 2" }, codexPlan)).toBeNull();
    expect(
      checkToolSafety("bash", { command: "node -e \"require('fs').readFileSync('README.md')\"" }, codexPlan),
    ).toBeNull();
  });

  it("still blocks Codex plan protected reads hidden inside interpreters", () => {
    expect(
      checkToolSafety(
        "bash",
        { command: "node -e \"require('fs').readFileSync('.env')\"" },
        { agentProfile: PLAN_AGENT_NAME, hasReadOnlyOsSandbox: true },
      ),
    ).toMatchObject({
      reasonKey: "plan_mode_read_only",
    });
  });

  it("Claude Code adapter fails closed when turnMode diverges from the gated agent profile", async () => {
    const dispatch = vi.spyOn(ClaudeSessionManager.prototype, "dispatch").mockResolvedValue(undefined);

    await expect(
      makeClaudeAdapter().sendPrompt(
        {
          parts: [{ type: "text", text: "plan only" }],
          agent: PLAN_AGENT_NAME,
          agentRole: "implementation",
          turnMode: "execute",
        },
        { sessionId: "sess-1", signal: new AbortController().signal, promptLog: makeLog() },
      ),
    ).rejects.toThrow("Claude Code turnMode mismatch");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("Claude Code adapter dispatches when turnMode matches the plan agent profile", async () => {
    const dispatch = vi.spyOn(ClaudeSessionManager.prototype, "dispatch").mockResolvedValue(undefined);

    await makeClaudeAdapter().sendPrompt(
      {
        parts: [{ type: "text", text: "plan only" }],
        agent: PLAN_AGENT_NAME,
        agentRole: "implementation",
        turnMode: "plan",
      },
      { sessionId: "sess-1", signal: new AbortController().signal, promptLog: makeLog() },
    );

    expect(dispatch).toHaveBeenCalled();
  });

  it("OpenCode ask-loop gate rejects mutating bash in plan mode and allows execute mode", () => {
    const permission = {
      id: "perm-1",
      sessionID: "session-1",
      type: "bash",
      pattern: "echo x > README.md",
    };

    expect(resolveOpencodePermissionDecision(permission, { agentProfile: PLAN_AGENT_NAME })).toMatchObject({
      response: "reject",
      tool: "bash",
    });
    expect(resolveOpencodePermissionDecision(permission, { agentProfile: "build" })).toMatchObject({
      response: "once",
      tool: "bash",
    });
  });

  it("OpenCode plan agent out-restricts the global headless edit permission", () => {
    // OpenCode 1.17.11 merges native agent rules before user/global config and
    // per-agent config after it; this pins the Cycloid inputs that make that
    // merge order keep built-in edit/write/apply_patch tools off the plan agent.
    const agentConfig = buildOpencodeAgentConfig("baseten/moonshotai/Kimi-K2.7-Code", OPENCODE_HEADLESS_PERMISSIONS);

    expect(OPENCODE_HEADLESS_PERMISSIONS.edit).toBe("ask");
    expect(agentConfig[PLAN_AGENT_NAME]?.permission?.edit).toBe("deny");
    expect(agentConfig[PLAN_AGENT_NAME]?.permission).toEqual({
      ...OPENCODE_HEADLESS_PERMISSIONS,
      edit: "deny",
    });
    for (const name of Object.keys(BUILTIN_AGENTS)) {
      if (name === PLAN_AGENT_NAME) continue;
      expect(agentConfig[name]?.permission?.edit).toBe(OPENCODE_HEADLESS_PERMISSIONS.edit);
      expect(agentConfig[name]?.permission).toEqual(OPENCODE_HEADLESS_PERMISSIONS);
    }
  });
});
