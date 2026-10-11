import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runMemoryHook, runMemoryHookFromStdin } from "../../apps/sandbox-bridge/src/services/memory-hook-runner";

let repoPath: string | null = null;

afterEach(() => {
  if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  repoPath = null;
  vi.unstubAllEnvs();
});

function writeBlockingMemory(): void {
  repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-hook-"));
  const dir = join(repoPath, ".cycloid", "memory", "engineering", "action", "triggers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth-dao-boundary.md"),
    [
      "---",
      "id: auth-dao-boundary",
      "vertical: engineering",
      "memory_type: action",
      "action_type: trigger",
      "level: gotcha",
      "primitive: trigger",
      "engineering_domains:",
      "  - data_persistence",
      "  - security",
      "status: active",
      "confidence: high",
      "authority: reviewed",
      "applies_to:",
      "  - apps/control-plane-worker/src/routes/**",
      "context_hint: Routes must call services instead of D1 directly",
      "source_pr_urls: []",
      "source_session_ids: []",
      "evidence: []",
      "enforcement: block",
      "triggers:",
      "  tools:",
      "    - apply_patch",
      "  path_globs:",
      "    - apps/control-plane-worker/src/routes/**",
      "  command_patterns: []",
      "  forbidden_patterns:",
      '    - "\\\\.prepare\\\\("',
      "  mcp_tools: []",
      "supersedes: []",
      "contradicts: []",
      "created_at: 2026-05-12",
      "updated_at: 2026-05-12",
      "---",
      "",
      "# Keep route handlers out of D1",
      "Move prepared statements into DAOs.",
    ].join("\n"),
    "utf-8",
  );
}

function writeVerificationMemory(): void {
  repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-hook-"));
  const dir = join(repoPath, ".cycloid", "memory", "engineering", "action", "procedures");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "session-state-verification.md"),
    [
      "---",
      "id: session-state-verification",
      "vertical: engineering",
      "memory_type: action",
      "action_type: procedure",
      "level: tactical",
      "primitive: procedure",
      "engineering_domains:",
      "  - testing",
      "status: active",
      "confidence: high",
      "authority: reviewed",
      "applies_to:",
      "  - apps/control-plane-worker/src/session/state.ts",
      "context_hint: Run focused verification when session state changes",
      "source_pr_urls: []",
      "source_session_ids: []",
      "evidence: []",
      "enforcement: warn",
      "triggers:",
      "  tools:",
      "    - apply_patch",
      "  path_globs:",
      "    - apps/control-plane-worker/src/session/state.ts",
      "  command_patterns: []",
      "  forbidden_patterns: []",
      "  mcp_tools: []",
      "supersedes: []",
      "contradicts: []",
      "created_at: 2026-05-12",
      "updated_at: 2026-05-12",
      "---",
      "",
      "# Verify Session State Changes",
      "After changing covered files, run focused tests or typecheck before stopping.",
    ].join("\n"),
    "utf-8",
  );
}

describe("memory hook runner", () => {
  it("returns an empty hook decision for malformed stdin JSON", async () => {
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    await runMemoryHookFromStdin(Readable.from(["{not-json"]) as NodeJS.ReadableStream, stdout);

    expect(output).toBe("{}\n");
  });

  it("returns an empty hook decision when memory loading throws", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-hook-"));
    mkdirSync(join(repoPath, ".cycloid"), { recursive: true });
    writeFileSync(join(repoPath, ".cycloid", "memory"), "not a directory", "utf-8");
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    await runMemoryHookFromStdin(
      Readable.from([JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: repoPath })]) as NodeJS.ReadableStream,
      stdout,
    );

    expect(output).toBe("{}\n");
  });

  it("uses REPO_PATH instead of a hook-provided cwd from another repo", async () => {
    repoPath = mkdtempSync(join(tmpdir(), "cycloid-memory-hook-trusted-"));
    const attackerRepo = mkdtempSync(join(tmpdir(), "cycloid-memory-hook-attacker-"));
    const attackerMemoryDir = join(attackerRepo, ".cycloid", "memory", "engineering", "action", "triggers");
    mkdirSync(attackerMemoryDir, { recursive: true });
    writeFileSync(
      join(attackerMemoryDir, "attacker.md"),
      [
        "---",
        "id: attacker-memory",
        "vertical: engineering",
        "memory_type: action",
        "action_type: trigger",
        "level: gotcha",
        "primitive: trigger",
        "status: active",
        "confidence: high",
        "authority: reviewed",
        "applies_to:",
        "  - README.md",
        "context_hint: External repo memory fixture",
        "source_pr_urls: []",
        "source_session_ids: []",
        "evidence: []",
        "enforcement: warn",
        "supersedes: []",
        "contradicts: []",
        "created_at: 2026-06-11",
        "updated_at: 2026-06-11",
        "---",
        "",
        "External repo memory fixture body.",
      ].join("\n"),
      "utf-8",
    );
    vi.stubEnv("REPO_PATH", repoPath);
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    try {
      await runMemoryHookFromStdin(
        Readable.from([
          JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            cwd: attackerRepo,
            prompt: "Please inspect README.md",
          }),
        ]) as NodeJS.ReadableStream,
        stdout,
      );
    } finally {
      rmSync(attackerRepo, { recursive: true, force: true });
    }

    expect(output).toBe("{}\n");
  });

  it("blocks mutating tool calls only when structured block criteria match", () => {
    writeBlockingMemory();

    expect(
      runMemoryHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "apply_patch",
          tool_input: {
            path: "apps/control-plane-worker/src/routes/sessions.ts",
            diff: "+ env.DB.prepare('select 1')",
          },
        },
        repoPath!,
      ),
    ).toMatchObject({ decision: "block", reason: expect.stringContaining("auth-dao-boundary") });

    const readOnlyDecision = runMemoryHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "bash",
        tool_input: { command: 'rg -n "prepare\\\\(" apps/control-plane-worker/src/routes/sessions.ts' },
      },
      repoPath!,
    );
    expect(readOnlyDecision.decision).toBeUndefined();
    expect(readOnlyDecision.hookSpecificOutput?.systemMessage).toContain("auth-dao-boundary");
  });

  it("does not match tools by substring", () => {
    writeBlockingMemory();
    // Memory triggers list "apply_patch"; a tool named "apply_patch_dry_run" must not match.
    const decision = runMemoryHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch_dry_run",
        tool_input: {
          path: "unrelated/path.ts",
          diff: "+ env.DB.prepare('select 1')",
        },
      },
      repoPath!,
    );
    expect(decision.decision).toBeUndefined();
    expect(decision.hookSpecificOutput).toBeUndefined();
  });

  it("warns for warn memories on matching PreToolUse triggers", () => {
    writeVerificationMemory();
    expect(
      runMemoryHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "apply_patch",
          tool_input: { path: "apps/control-plane-worker/src/session/state.ts", diff: "+ change" },
        },
        repoPath!,
      ).hookSpecificOutput?.systemMessage,
    ).toContain("session-state-verification");
  });

  it("adds prompt-start recall reminder without memory body content", () => {
    writeBlockingMemory();
    const additionalContext =
      runMemoryHook(
        { hook_event_name: "UserPromptSubmit", prompt: "Update apps/control-plane-worker/src/routes/sessions.ts" },
        repoPath!,
      ).hookSpecificOutput?.additionalContext ?? "";

    expect(additionalContext).toContain("Call cycloid.memory_context");
    expect(additionalContext).toContain("auth-dao-boundary");
    expect(additionalContext).not.toContain("Move prepared statements into DAOs.");
    expect(additionalContext).not.toContain("Routes must call services instead of D1 directly");
  });

  it("blocks Stop when transcript shows a structured block-memory violation", () => {
    writeBlockingMemory();
    const transcriptPath = join(repoPath!, "transcript.txt");
    writeFileSync(transcriptPath, "Applied patch: env.DB.prepare('select 1')", "utf-8");

    expect(runMemoryHook({ hook_event_name: "Stop", transcript_path: transcriptPath }, repoPath!)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("auth-dao-boundary"),
    });
  });

  it("adds PostToolUse recall reminder without memory body content", () => {
    writeBlockingMemory();

    const additionalContext =
      runMemoryHook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "bash",
          tool_input: { command: "npm run typecheck" },
          tool_output: "Error in apps/control-plane-worker/src/routes/sessions.ts: direct prepare call failed",
        },
        repoPath!,
      ).hookSpecificOutput?.additionalContext ?? "";

    expect(additionalContext).toContain("Call cycloid.memory_context");
    expect(additionalContext).toContain("auth-dao-boundary");
    expect(additionalContext).not.toContain("Move prepared statements into DAOs.");
    expect(additionalContext).not.toContain("Routes must call services instead of D1 directly");
  });

  it("catches missing verification for high-confidence covered file obligations", () => {
    writeVerificationMemory();
    const transcriptPath = join(repoPath!, "transcript.txt");
    writeFileSync(
      transcriptPath,
      "Applied patch to apps/control-plane-worker/src/session/state.ts\nNo tests were run.",
      "utf-8",
    );

    const additionalContext =
      runMemoryHook({ hook_event_name: "Stop", transcript_path: transcriptPath }, repoPath!).hookSpecificOutput
        ?.additionalContext ?? "";
    expect(additionalContext).toContain("session-state-verification");
    expect(additionalContext).toContain("Call cycloid.memory_context");
    expect(additionalContext).not.toContain("After changing covered files");

    writeFileSync(
      transcriptPath,
      "Applied patch to apps/control-plane-worker/src/session/state.ts\nnpx vitest run tests/test_cloudflare/session/state.test.ts",
      "utf-8",
    );

    expect(runMemoryHook({ hook_event_name: "Stop", transcript_path: transcriptPath }, repoPath!)).toEqual({});
  });
});
