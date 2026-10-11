import { describe, expect, it, vi } from "vitest";

import type { BridgeLogger } from "../../apps/sandbox-bridge/src/logger";
import { MemoryManager } from "../../apps/sandbox-bridge/src/memory-manager";
import type { Memory } from "../../apps/sandbox-bridge/src/services/memory-ranking";

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as unknown as BridgeLogger;

function blockerMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-no-forbidden",
    content: "Forbidden call guard.",
    context_hint: "Forbidden call guard.",
    type: "action",
    memory_type: "action",
    level: "gotcha",
    primitive: "trigger",
    status: "active",
    confidence: "high",
    authority: "reviewed",
    enforcement: "block",
    applies_to: ["src/**"],
    referenced_files: JSON.stringify(["src/**"]),
    triggers: { forbidden_patterns: ["forbiddenCall"] },
    scope: "repo",
    ...overrides,
  } as Memory;
}

function textDiff(path: string, line: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,1 +1,2 @@",
    " existing",
    `+${line}`,
    "",
  ].join("\n");
}

function makeManager(execAsync: ReturnType<typeof vi.fn>, baseBranch: string | null = "main") {
  const manager = new MemoryManager({
    getCwd: () => "/repo",
    getBaseBranch: () => baseBranch ?? undefined,
    execAsync: execAsync as never,
    log,
  });
  manager.orgMemories = [blockerMemory()];
  return manager;
}

describe("enforceBlockingMemoriesOnDiff batching", () => {
  it("enforces blockers from the loaded memory pool when no memories were ranked for injection", async () => {
    const combined = textDiff("src/blocked.ts", "forbiddenCall()");
    let diffCalls = 0;
    const execAsync = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] !== "diff") return "";
      diffCalls += 1;
      return diffCalls === 1 ? combined : "";
    });
    const manager = makeManager(execAsync);
    manager.orgMemories = [blockerMemory()];

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/blocked.ts"], log, "base-sha");

    expect(result).toMatchObject({ memoryId: "mem-no-forbidden" });
    expect(execAsync).toHaveBeenCalledWith(
      "git",
      ["diff", "base-sha", "--", "src/blocked.ts"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("spawns one diff for all matching files and reverses only the violating chunk", async () => {
    const combined = textDiff("src/safe.ts", "fine()") + textDiff("src/blocked.ts", "forbiddenCall()");
    const calls: Array<{ args: string[]; input?: string }> = [];
    let diffCallCount = 0;
    const execAsync = vi.fn(async (_cmd: string, args: string[], opts?: { input?: string }) => {
      calls.push({ args, input: opts?.input });
      if (args[0] === "diff") {
        diffCallCount += 1;
        return diffCallCount === 1 ? combined : "";
      }
      return "";
    });
    const manager = makeManager(execAsync);

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/safe.ts", "src/blocked.ts"], log, "base-sha");

    expect(result).toMatchObject({ memoryId: "mem-no-forbidden" });
    const initialDiffCalls = calls.filter((call) => call.args[0] === "diff" && call.args.length > 4);
    expect(initialDiffCalls).toHaveLength(1);
    expect(initialDiffCalls[0].args).toEqual(["diff", "base-sha", "--", "src/safe.ts", "src/blocked.ts"]);
    const applyCalls = calls.filter((call) => call.args[0] === "apply");
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].input).toBe(textDiff("src/blocked.ts", "forbiddenCall()"));
  });

  it("uses the unscoped diff form when no base ref is available", async () => {
    const execAsync = vi.fn(async (_cmd: string, args: string[]) => (args[0] === "diff" ? "" : ""));
    const manager = makeManager(execAsync, null);

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/a.ts", "src/b.ts"], log, null);

    expect(result).toBeNull();
    expect(execAsync).toHaveBeenCalledWith(
      "git",
      ["diff", "--", "src/a.ts", "src/b.ts"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("falls back to git restore when reversing a violating chunk fails", async () => {
    const combined = textDiff("src/blocked.ts", "forbiddenCall()");
    const calls: string[][] = [];
    let diffCalls = 0;
    const execAsync = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "diff") {
        diffCalls += 1;
        return diffCalls === 1 ? combined : "";
      }
      if (args[0] === "apply") throw new Error("apply failed");
      return "";
    });
    const manager = makeManager(execAsync);

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/blocked.ts"], log, "base-sha");

    expect(result).toMatchObject({
      memoryId: "mem-no-forbidden",
      status: "handled",
      revertedFiles: ["src/blocked.ts"],
    });
    expect(calls).toContainEqual(["restore", "--source", "base-sha", "--staged", "--worktree", "--", "src/blocked.ts"]);
  });

  it("falls back to per-file diffs when the combined diff spawn fails", async () => {
    const blocked = textDiff("src/blocked.ts", "forbiddenCall()");
    const calls: string[][] = [];
    let inspected = false;
    const execAsync = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "diff" && args.length === 4 && args.at(-1) === "src/blocked.ts" && inspected) return "";
      if (args[0] === "diff" && args.length === 4 && args.at(-1) === "src/blocked.ts") inspected = true;
      // Combined diff (two files after `--`) fails; per-file diffs succeed.
      if (args[0] === "diff" && args.length > 4) throw new Error("combined diff failed");
      if (args[0] === "diff" && args.at(-1) === "src/blocked.ts") return blocked;
      if (args[0] === "diff") return textDiff("src/safe.ts", "fine()");
      return "";
    });
    const manager = makeManager(execAsync);

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/safe.ts", "src/blocked.ts"], log, "base-sha");

    expect(result).toMatchObject({ memoryId: "mem-no-forbidden" });
    expect(calls).toContainEqual(["diff", "base-sha", "--", "src/safe.ts", "src/blocked.ts"]);
    expect(calls).toContainEqual(["diff", "base-sha", "--", "src/blocked.ts"]);
    const applyCalls = calls.filter((args) => args[0] === "apply");
    expect(applyCalls).toHaveLength(1);
  });

  it("returns null when the combined diff and every per-file fallback fail", async () => {
    const execAsync = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "diff") throw new Error("git diff failed");
      return "";
    });
    const manager = makeManager(execAsync);

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/blocked.ts"], log, "base-sha");

    expect(result).toBeNull();
    // 1 combined attempt + 1 per-file fallback, no apply/restore.
    expect(execAsync).toHaveBeenCalledTimes(2);
  });

  it("tries a three-way hunk reversal before whole-file restore", async () => {
    const combined = textDiff("src/blocked.ts", "forbiddenCall()");
    let diffCalls = 0;
    const calls: string[][] = [];
    const execAsync = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "diff") {
        diffCalls += 1;
        return diffCalls === 1 ? combined : "";
      }
      if (args[0] === "apply" && !args.includes("--3way")) throw new Error("plain apply failed");
      return "";
    });
    const manager = makeManager(execAsync);

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/blocked.ts"], log, "base-sha");

    expect(result).toMatchObject({ status: "handled", memoryId: "mem-no-forbidden", revertedFiles: [] });
    expect(calls).toContainEqual(["apply", "-R", "--whitespace=nowarn"]);
    expect(calls).toContainEqual(["apply", "-R", "--3way", "--whitespace=nowarn"]);
    expect(calls).not.toContainEqual(["restore", "--source", "base-sha", "--", "src/blocked.ts"]);
  });

  it("returns failure when hunk reversal and file restore both fail", async () => {
    const combined = textDiff("src/blocked.ts", "forbiddenCall()");
    const execAsync = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "diff") return combined;
      if (args[0] === "apply" || args[0] === "restore") throw new Error(`${args[0]} failed`);
      return "";
    });
    const manager = makeManager(execAsync);

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/blocked.ts"], log, "base-sha");

    expect(result).toEqual({
      status: "failed",
      memoryId: "mem-no-forbidden",
      reason: "Forbidden call guard.",
      file: "src/blocked.ts",
      detail: "Failed to reverse the violating hunk and failed to restore the file.",
    });
  });

  it("returns failure when restore succeeds but the forbidden pattern remains", async () => {
    const combined = textDiff("src/blocked.ts", "forbiddenCall()");
    const execAsync = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "diff") return combined;
      if (args[0] === "apply") throw new Error("apply failed");
      return "";
    });
    const manager = makeManager(execAsync);

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/blocked.ts"], log, "base-sha");

    expect(result).toEqual({
      status: "failed",
      memoryId: "mem-no-forbidden",
      reason: "Forbidden call guard.",
      file: "src/blocked.ts",
      detail: "Forbidden pattern still appears in the file diff after restore.",
    });
  });

  it("returns failure when hunk reversal succeeds but the forbidden pattern remains", async () => {
    const combined = textDiff("src/blocked.ts", "forbiddenCall()");
    let diffCalls = 0;
    const execAsync = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "diff") {
        diffCalls += 1;
        return diffCalls === 1 || args.includes("--cached") ? combined : "";
      }
      return "";
    });
    const manager = makeManager(execAsync);

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/blocked.ts"], log, "base-sha");

    expect(result).toEqual({
      status: "failed",
      memoryId: "mem-no-forbidden",
      reason: "Forbidden call guard.",
      file: "src/blocked.ts",
      detail: "Forbidden pattern still appears in the file diff after reversal.",
    });
    expect(execAsync).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--", "src/blocked.ts"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("reverts violations from every blocking memory, not just the first (ARC-1542)", async () => {
    // Two blockers scoped to different files with different forbidden patterns.
    const memoryA = blockerMemory({
      id: "mem-a",
      applies_to: ["src/a.ts"],
      referenced_files: JSON.stringify(["src/a.ts"]),
      triggers: { forbidden_patterns: ["forbiddenA"] },
    });
    const memoryB = blockerMemory({
      id: "mem-b",
      applies_to: ["src/b.ts"],
      referenced_files: JSON.stringify(["src/b.ts"]),
      triggers: { forbidden_patterns: ["forbiddenB"] },
    });
    const hunks: Record<string, string> = {
      "src/a.ts": textDiff("src/a.ts", "forbiddenA()"),
      "src/b.ts": textDiff("src/b.ts", "forbiddenB()"),
    };
    const calls: Array<{ args: string[]; input?: string }> = [];
    // Key the returned diff on the file arg, NOT a global call counter: each
    // blocker runs its own `git diff <base> -- <its file>`. A counter-based
    // mock would hand memory B an empty diff and hide the skipped-blocker bug.
    // Each file's hunk is consumed once (the initial base diff); the later
    // re-inspection diffs return clean so the reversed file passes inspection.
    const consumed = new Set<string>();
    const execAsync = vi.fn(async (_cmd: string, args: string[], opts?: { input?: string }) => {
      calls.push({ args, input: opts?.input });
      if (args[0] === "diff" && args.includes("--") && !args.includes("--cached")) {
        const file = args.at(-1) ?? "";
        if (hunks[file] && !consumed.has(file)) {
          consumed.add(file);
          return hunks[file];
        }
      }
      return "";
    });
    const manager = makeManager(execAsync);
    manager.orgMemories = [memoryA, memoryB];

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/a.ts", "src/b.ts"], log, "base-sha");

    // Single result surfaces the first blocker, but both files were reversed.
    expect(result).toMatchObject({ status: "handled", memoryId: "mem-a" });
    const applyInputs = calls.filter((call) => call.args[0] === "apply").map((call) => call.input);
    expect(applyInputs).toHaveLength(2);
    expect(applyInputs).toContain(hunks["src/a.ts"]);
    expect(applyInputs).toContain(hunks["src/b.ts"]);
  });

  it("short-circuits with status:failed and stops before later blockers when a hard-fail occurs (ARC-1542)", async () => {
    // Blocker A is handled cleanly; blocker B cannot be reverted or restored,
    // so enforcement must hard-fail immediately and never inspect blocker C.
    const memoryA = blockerMemory({
      id: "mem-a",
      applies_to: ["src/a.ts"],
      referenced_files: JSON.stringify(["src/a.ts"]),
      triggers: { forbidden_patterns: ["forbiddenA"] },
    });
    const memoryB = blockerMemory({
      id: "mem-b",
      applies_to: ["src/b.ts"],
      referenced_files: JSON.stringify(["src/b.ts"]),
      triggers: { forbidden_patterns: ["forbiddenB"] },
    });
    const memoryC = blockerMemory({
      id: "mem-c",
      applies_to: ["src/c.ts"],
      referenced_files: JSON.stringify(["src/c.ts"]),
      triggers: { forbidden_patterns: ["forbiddenC"] },
    });
    const hunks: Record<string, string> = {
      "src/a.ts": textDiff("src/a.ts", "forbiddenA()"),
      "src/b.ts": textDiff("src/b.ts", "forbiddenB()"),
    };
    const diffB = hunks["src/b.ts"];
    const inspectedFiles: string[] = [];
    const consumed = new Set<string>();
    const execAsync = vi.fn(async (_cmd: string, args: string[], opts?: { input?: string }) => {
      if (args[0] === "diff" && args.includes("--") && !args.includes("--cached")) {
        const file = args.at(-1) ?? "";
        inspectedFiles.push(file);
        if (hunks[file] && !consumed.has(file)) {
          consumed.add(file);
          return hunks[file];
        }
        return "";
      }
      // Blocker A reverses fine; blocker B's hunk reversal and file restore both fail.
      if (args[0] === "apply" && opts?.input === diffB) throw new Error("apply failed");
      if (args[0] === "restore" && args.includes("src/b.ts")) throw new Error("restore failed");
      return "";
    });
    const manager = makeManager(execAsync);
    manager.orgMemories = [memoryA, memoryB, memoryC];

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/a.ts", "src/b.ts", "src/c.ts"], log, "base-sha");

    expect(result).toEqual({
      status: "failed",
      memoryId: "mem-b",
      reason: "Forbidden call guard.",
      file: "src/b.ts",
      detail: "Failed to reverse the violating hunk and failed to restore the file.",
    });
    // Blocker C must never be inspected once B hard-fails.
    expect(inspectedFiles).not.toContain("src/c.ts");
  });

  it("checks the staged diff before declaring a restored file clean", async () => {
    const combined = textDiff("src/blocked.ts", "forbiddenCall()");
    let diffCalls = 0;
    const execAsync = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "diff") {
        diffCalls += 1;
        return diffCalls === 1 || args.includes("--cached") ? combined : "";
      }
      if (args[0] === "apply") throw new Error("apply failed");
      return "";
    });
    const manager = makeManager(execAsync);

    const result = await manager.enforceBlockingMemoriesOnDiff(["src/blocked.ts"], log, "base-sha");

    expect(result).toEqual({
      status: "failed",
      memoryId: "mem-no-forbidden",
      reason: "Forbidden call guard.",
      file: "src/blocked.ts",
      detail: "Forbidden pattern still appears in the file diff after restore.",
    });
    expect(execAsync).toHaveBeenCalledWith(
      "git",
      ["restore", "--source", "base-sha", "--staged", "--worktree", "--", "src/blocked.ts"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(execAsync).toHaveBeenCalledWith(
      "git",
      ["diff", "--cached", "--", "src/blocked.ts"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });
});
