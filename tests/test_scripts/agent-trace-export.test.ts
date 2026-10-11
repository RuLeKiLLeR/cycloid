import { describe, expect, it } from "vitest";

import { buildTrace, detectFormat, parseTranscript } from "../../scripts/agent-trace-export/build-trace";
import { parseClaudeTranscript, stringifyClaudeContent } from "../../scripts/agent-trace-export/parse-claude";
import { extractCodexCommand, parseCodexRollout } from "../../scripts/agent-trace-export/parse-codex";
import {
  deepRedact,
  redactAndTruncate,
  redactSecrets,
  scanForSecrets,
  truncateOutput,
} from "../../scripts/agent-trace-export/redact";
import { resolveOverrides } from "../../scripts/export-agent-traces";

// --- Codex rollout fixture (OpenAI Responses item format, as on disk) ---
const codexRollout: unknown[] = [
  {
    type: "session_meta",
    timestamp: "2026-06-23T19:59:13.417Z",
    payload: { model_provider: "openai", cwd: "/repo", base_instructions: "You are a coding agent." },
  },
  { type: "turn_context", timestamp: "2026-06-23T19:59:14.000Z", payload: { model: "gpt-5.5" } },
  {
    type: "event_msg",
    timestamp: "2026-06-23T19:59:15.000Z",
    payload: { type: "user_message", message: "fix the bug" },
  },
  {
    type: "response_item",
    timestamp: "2026-06-23T19:59:20.000Z",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "call_1",
      arguments: JSON.stringify({ cmd: "rg --files-with-matches TODO" }),
    },
  },
  {
    type: "response_item",
    timestamp: "2026-06-23T19:59:21.000Z",
    payload: { type: "function_call_output", call_id: "call_1", output: "src/a.ts\nsrc/b.ts\n" },
  },
  {
    type: "response_item",
    timestamp: "2026-06-23T19:59:22.000Z",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "call_2",
      arguments: JSON.stringify({ cmd: "grep -n foo src/a.ts" }),
    },
  },
  {
    type: "response_item",
    timestamp: "2026-06-23T19:59:23.000Z",
    payload: { type: "function_call_output", call_id: "call_2", output: "12: foo()\n" },
  },
  {
    type: "response_item",
    timestamp: "2026-06-23T19:59:24.000Z",
    payload: {
      type: "function_call",
      name: "apply_patch",
      call_id: "call_3",
      arguments: JSON.stringify({ patch: "*** edit" }),
    },
  },
  {
    type: "response_item",
    timestamp: "2026-06-23T19:59:25.000Z",
    payload: { type: "function_call_output", call_id: "call_3", output: "applied" },
  },
  {
    type: "event_msg",
    timestamp: "2026-06-23T19:59:26.000Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
        model_context_window: 200000,
      },
    },
  },
  { type: "event_msg", timestamp: "2026-06-23T19:59:27.000Z", payload: { type: "task_complete" } },
];

// --- Claude project transcript fixture (as on disk) ---
const claudeTranscript: unknown[] = [
  { type: "user", timestamp: "2026-06-23T20:00:00.000Z", message: { role: "user", content: "investigate the error" } },
  {
    type: "assistant",
    timestamp: "2026-06-23T20:00:05.000Z",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000, output_tokens: 50 },
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "grep -rn boom src" } }],
    },
  },
  {
    type: "user",
    timestamp: "2026-06-23T20:00:07.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "src/x.ts:9: boom\n", is_error: false }],
    },
  },
  {
    type: "assistant",
    timestamp: "2026-06-23T20:00:10.000Z",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 120, cache_read_input_tokens: 5200, cache_creation_input_tokens: 0, output_tokens: 30 },
      content: [
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Edit",
          input: { file_path: "src/x.ts", old_string: "boom", new_string: "ok" },
        },
      ],
    },
  },
  {
    type: "user",
    timestamp: "2026-06-23T20:00:12.000Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "applied", is_error: false }],
    },
  },
];

describe("redaction", () => {
  it("scrubs secret-shaped tokens", () => {
    expect(redactSecrets("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123")).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
    );
    expect(redactSecrets("Authorization: Bearer eyJhbGciOi.payloadpart.signaturepart")).toContain("[REDACTED]");
    expect(redactSecrets("ANTHROPIC_API_KEY=sk-ant-abcdef1234567890abcdef")).not.toContain(
      "sk-ant-abcdef1234567890abcdef",
    );
  });

  it("keeps the label and the separator when redacting an assignment", () => {
    const out = redactSecrets("API_KEY=supersecretvalue123");
    expect(out).toBe("API_KEY=[REDACTED]");
    expect(out).not.toContain("supersecretvalue123");
  });

  // The secret battery is the core safety guarantee: every realistic secret
  // shape Cycloid could surface in tool output must be scrubbed. The literal
  // bodies below are fabricated, not real credentials.
  const SECRET_BATTERY: Array<[string, string]> = [
    ["OpenAI sk-", "sk-abcdefghijklmnop1234567890ABCD"],
    ["OpenAI project", "sk-proj-abcdefghijklmnop1234567890"],
    ["Anthropic", "sk-ant-api03-abcdefghijklmnop1234567890"],
    ["Stripe live (underscore)", "sk_live_abcdefghijklmnop12345678"],
    ["Stripe pub test", "pk_test_abcdefghijklmnop12345678"],
    ["GitHub classic PAT", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub fine-grained PAT", "github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz0123456789"],
    ["Slack bot", "xoxb-1234567890-ABCDEFGHIJKLMNOP"],
    ["Slack app", "xapp-1-A012345-abcdefghijkl"],
    ["Google API key", "AIzaSyAbcdefghijklmnop1234567890XYZ"],
    ["E2B key", "e2b_abcdefghijklmnop1234567890"],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36"],
  ];

  it.each(SECRET_BATTERY)("scrubs %s from free text", (_label, secret) => {
    const out = redactSecrets(`prefix ${secret} suffix`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts PEM private key blocks entirely", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234abcd\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(`key:\n${pem}\ndone`);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA1234abcd");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts credentials embedded in clone URLs", () => {
    const out = redactSecrets(
      "git clone https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r.git",
    );
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("redacts bare Bearer tokens without an Authorization label", () => {
    const out = redactSecrets("curl -H 'Bearer abcdefghijklmnop1234567890ABCDEF'");
    expect(out).not.toContain("abcdefghijklmnop1234567890ABCDEF");
  });

  it("scanForSecrets flags an un-redacted secret and passes a clean string", () => {
    expect(scanForSecrets("token sk-abcdefghijklmnop1234567890ABCD here").length).toBeGreaterThan(0);
    expect(scanForSecrets("just normal log output, 12 files changed")).toEqual([]);
    // A redacted assignment must NOT self-flag.
    expect(scanForSecrets("API_KEY=[REDACTED]")).toEqual([]);
  });

  it("deepRedact scrubs strings at every depth of an object", () => {
    const obj = {
      a: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      b: { c: ["ok", "sk-ant-api03-abcdefghijklmnop1234567890"] },
      n: 5,
    };
    const out = deepRedact(obj);
    expect(JSON.stringify(out)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(JSON.stringify(out)).not.toContain("sk-ant-api03-abcdefghijklmnop1234567890");
    expect(out.n).toBe(5);
  });

  it("deepRedact passes non-plain objects (Date) through unchanged, not collapsed to {}", () => {
    const d = new Date("2026-06-23T00:00:00.000Z");
    const out = deepRedact({ when: d, note: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    expect(out.when).toBeInstanceOf(Date);
    expect((out.when as Date).getTime()).toBe(d.getTime());
    expect(out.note).toBe("[REDACTED]");
  });

  it("leaves non-secret text untouched", () => {
    const text = "ran 12 tests, all passed";
    expect(redactSecrets(text)).toBe(text);
  });

  it("truncates large output head+tail with a marker", () => {
    const big = "A".repeat(5000) + "ZZZEND";
    const out = truncateOutput(big, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.startsWith("A")).toBe(true);
    expect(out).toContain("truncated");
    expect(out.endsWith("ZZZEND")).toBe(true);
  });

  it("does not truncate short output", () => {
    expect(redactAndTruncate("short", { maxOutputChars: 1000 })).toBe("short");
  });
});

describe("codex command extraction", () => {
  it("reads exec_command cmd", () => {
    expect(extractCodexCommand(JSON.stringify({ cmd: "ls -la" })).command).toBe("ls -la");
  });
  it("joins shell command arrays", () => {
    expect(extractCodexCommand(JSON.stringify({ command: ["git", "status"] })).command).toBe("git status");
  });
  it("falls back to raw string args", () => {
    expect(extractCodexCommand("not json").command).toBe("not json");
  });
});

describe("parseCodexRollout", () => {
  const parsed = parseCodexRollout(codexRollout);

  it("captures real tool output (not a status string)", () => {
    const bash = parsed.tools.find((t) => t.input.command === "rg --files-with-matches TODO");
    expect(bash?.output).toBe("src/a.ts\nsrc/b.ts\n");
    expect(bash?.output).not.toBe("completed");
    expect(bash?.outputEstimatedTokens).toBeGreaterThan(0);
    expect(bash?.durationMs).toBe(1000);
  });

  it("derives counts and identity", () => {
    expect(parsed.harnessKind).toBe("codex-session");
    expect(parsed.provider).toBe("openai");
    expect(parsed.model).toBe("gpt-5.5");
    expect(parsed.toolCallCount).toBe(3);
    expect(parsed.editCount).toBe(1); // apply_patch
    expect(parsed.ripgrepSearchCommandCount).toBe(1);
    expect(parsed.grepSearchCommandCount).toBe(1);
    expect(parsed.complete).toBe(true);
    expect(parsed.success).toBe(true);
    expect(parsed.outcome).toBe("success");
  });

  it("reads token usage and context window", () => {
    expect(parsed.actualInputTokens).toBe(1000);
    expect(parsed.actualOutputTokens).toBe(200);
    expect(parsed.contextWindow).toBe(200000);
    expect(parsed.peakTotalTokens).toBe(1200);
  });
});

describe("parseClaudeTranscript", () => {
  const parsed = parseClaudeTranscript(claudeTranscript);

  it("captures real tool output correlated by tool_use_id", () => {
    const bash = parsed.tools.find((t) => t.name === "tool:bash");
    expect(bash?.output).toBe("src/x.ts:9: boom\n");
    expect(bash?.durationMs).toBe(2000);
    expect(bash?.outputEstimatedTokens).toBeGreaterThan(0);
  });

  it("derives counts and identity", () => {
    expect(parsed.harnessKind).toBe("claude-session");
    expect(parsed.provider).toBe("anthropic");
    expect(parsed.model).toBe("claude-opus-4-8");
    expect(parsed.toolCallCount).toBe(2);
    expect(parsed.editCount).toBe(1); // Edit
    expect(parsed.grepSearchCommandCount).toBe(1);
    expect(parsed.outcome).toBe("success");
  });

  it("stringifies array tool_result content", () => {
    expect(
      stringifyClaudeContent([
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ]),
    ).toBe("line1\nline2");
  });
});

describe("end-to-end secret containment through buildTrace", () => {
  it("scrubs a secret in a Codex tool COMMAND INPUT (not just output)", () => {
    const leaky: unknown[] = [
      { type: "session_meta", timestamp: "2026-06-23T19:59:13.417Z", payload: { model_provider: "openai" } },
      {
        type: "response_item",
        timestamp: "2026-06-23T19:59:20.000Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "c1",
          arguments: JSON.stringify({
            cmd: "curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' https://api",
          }),
        },
      },
      {
        type: "response_item",
        timestamp: "2026-06-23T19:59:21.000Z",
        payload: { type: "function_call_output", call_id: "c1", output: "ok" },
      },
    ];
    const trace = buildTrace(parseCodexRollout(leaky), { sessionId: "s1" });
    // The whole assembled trace must be free of the secret - command input included.
    expect(JSON.stringify(trace)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(scanForSecrets(JSON.stringify(trace))).toEqual([]);
  });

  it("scrubs a secret leaked through a user turn prompt", () => {
    const leaky: unknown[] = [
      { type: "session_meta", timestamp: "2026-06-23T19:59:13.417Z", payload: { model_provider: "openai" } },
      {
        type: "event_msg",
        timestamp: "2026-06-23T19:59:15.000Z",
        payload: { type: "user_message", message: "use key sk-ant-api03-abcdefghijklmnop1234567890" },
      },
    ];
    const trace = buildTrace(parseCodexRollout(leaky), { sessionId: "s1" });
    expect(JSON.stringify(trace)).not.toContain("sk-ant-api03-abcdefghijklmnop1234567890");
  });
});

describe("failure-case handling", () => {
  const failing: unknown[] = [
    { type: "user", timestamp: "2026-06-23T20:00:00.000Z", message: { content: "do it" } },
    {
      type: "assistant",
      timestamp: "2026-06-23T20:00:01.000Z",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }],
      },
    },
    {
      type: "user",
      timestamp: "2026-06-23T20:00:02.000Z",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "command failed: exit 1", is_error: true }],
      },
    },
  ];

  it("preserves an errored tool result in output but does NOT flip session outcome", () => {
    const parsed = parseClaudeTranscript(failing);
    // A routine tool-level error is not a failed session.
    expect(parsed.outcome).toBe("success");
    expect(parsed.tools[0].output).toBe("command failed: exit 1");
  });

  it("takes session outcome=error from overrides (Cycloid metadata)", () => {
    const parsed = parseClaudeTranscript(failing);
    const trace = buildTrace(parsed, { sessionId: "s1", outcome: "error", success: false, complete: true });
    expect(trace.outcome).toBe("error");
    expect(trace.success).toBe(false);
    expect(trace.tools[0].output).toBe("command failed: exit 1");
  });
});

describe("format detection + buildTrace", () => {
  it("detects codex vs claude", () => {
    expect(detectFormat(codexRollout)).toBe("codex");
    expect(detectFormat(claudeTranscript)).toBe("claude");
  });

  it("redacts secrets in tool output through the full parse", () => {
    const leaky: unknown[] = [
      { type: "session_meta", timestamp: "2026-06-23T19:59:13.417Z", payload: { model_provider: "openai" } },
      {
        type: "response_item",
        timestamp: "2026-06-23T19:59:20.000Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "c1",
          arguments: JSON.stringify({ cmd: "env" }),
        },
      },
      {
        type: "response_item",
        timestamp: "2026-06-23T19:59:21.000Z",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
        },
      },
    ];
    const parsed = parseTranscript(leaky, "codex");
    expect(parsed.tools[0].output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  });

  it("builds the full 22-field trace shape with overrides", () => {
    const parsed = parseCodexRollout(codexRollout);
    const trace = buildTrace(parsed, {
      sessionId: "trace-1",
      repo: "trycycloid/cycloid",
      env: "production",
      agent: "build",
      branch: "main",
    });

    expect(Object.keys(trace).sort()).toEqual(
      [
        "agent",
        "agentRole",
        "branch",
        "complete",
        "contextFillPercent",
        "durationMs",
        "editCount",
        "env",
        "grepSearchCommandCount",
        "harnessKind",
        "model",
        "outcome",
        "provider",
        "questionCount",
        "repo",
        "ripgrepSearchCommandCount",
        "sessionId",
        "success",
        "toolCallCount",
        "tokenBreakdown",
        "tools",
        "turns",
      ].sort(),
    );
    expect(trace.repo).toBe("trycycloid/cycloid");
    expect(trace.model).toBe("gpt-5.5"); // from transcript when not overridden
    expect(trace.contextFillPercent).toBeCloseTo(1200 / 200000, 6);
    // measuredTotal is the sum of decomposed components (all 0 here), and the
    // full measured input surfaces as unmeasuredTokens.
    expect(trace.tokenBreakdown.measuredTotal).toBe(0);
    expect(trace.tokenBreakdown.unmeasuredTokens).toBe(1000);
    expect(trace.tools.every((t) => typeof t.output === "string")).toBe(true);
    expect(trace.tools.some((t) => t.output.length > 0)).toBe(true);
  });
});

describe("resolveOverrides", () => {
  it("gives unique positional ids when no meta is provided", () => {
    const ids = resolveOverrides(undefined, 3).map((o) => o.sessionId);
    expect(ids).toEqual(["trace-1", "trace-2", "trace-3"]);
  });

  it("keeps per-entry ids for an array meta", () => {
    const ids = resolveOverrides([{ sessionId: "a" }, { sessionId: "b" }], 2).map((o) => o.sessionId);
    expect(ids).toEqual(["a", "b"]);
  });

  it("does NOT reuse one sessionId when a single object is broadcast to N inputs", () => {
    const ids = resolveOverrides({ sessionId: "sess", repo: "r" }, 3).map((o) => o.sessionId);
    expect(new Set(ids).size).toBe(3); // unique, not all "sess"
    expect(ids).toEqual(["sess-1", "sess-2", "sess-3"]);
  });

  it("broadcasts other fields while keeping ids unique", () => {
    const out = resolveOverrides({ repo: "trycycloid/cycloid", env: "production" }, 2);
    expect(out.every((o) => o.repo === "trycycloid/cycloid" && o.env === "production")).toBe(true);
    expect(out.map((o) => o.sessionId)).toEqual(["trace-1", "trace-2"]);
  });
});
