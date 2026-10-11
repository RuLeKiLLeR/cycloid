import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listRepoMemoryFiles, loadActiveRepoMemories } from "../../apps/sandbox-bridge/src/services/repo-memory-files";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeMemory(repoPath: string, id: string, body = "Use this repo-local memory."): string {
  const dir = join(repoPath, ".cycloid", "memory", "engineering", "action", "procedures");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.md`);
  writeFileSync(
    file,
    [
      "---",
      `id: ${id}`,
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
      "  - README.md",
      `context_hint: ${body}`,
      "source_pr_urls: []",
      "source_session_ids: []",
      "evidence: []",
      "enforcement: suggest",
      "supersedes: []",
      "contradicts: []",
      "created_at: 2026-06-11",
      "updated_at: 2026-06-11",
      "---",
      "",
      body,
    ].join("\n"),
    "utf-8",
  );
  return file;
}

describe("repo memory file loading", () => {
  it("loads active memories only from the repo-local memory root", () => {
    const repo = tempRoot("repo-memory-local-");
    const file = writeMemory(repo, "repo-local");

    expect(listRepoMemoryFiles(repo)).toEqual([realpathSync(file)]);
    expect(loadActiveRepoMemories(repo).map((entry) => entry.memory.id)).toEqual(["repo-local"]);
  });

  it("ignores symlinked memory files that point outside the repo", () => {
    const repo = tempRoot("repo-memory-symlink-file-");
    const outside = tempRoot("repo-memory-outside-");
    const outsideFile = writeMemory(outside, "outside-customer", "External repo memory fixture body.");
    const dir = join(repo, ".cycloid", "memory", "engineering", "action", "procedures");
    mkdirSync(dir, { recursive: true });
    symlinkSync(outsideFile, join(dir, "outside-customer.md"));

    expect(listRepoMemoryFiles(repo)).toEqual([]);
    expect(loadActiveRepoMemories(repo)).toEqual([]);
  });

  it("ignores symlinked memory directories that point outside the repo", () => {
    const repo = tempRoot("repo-memory-symlink-dir-");
    const outside = tempRoot("repo-memory-outside-");
    writeMemory(outside, "outside-customer", "External repo memory fixture body.");
    const dir = join(repo, ".cycloid", "memory");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(outside, ".cycloid", "memory", "engineering"), join(dir, "engineering"));

    expect(listRepoMemoryFiles(repo)).toEqual([]);
    expect(loadActiveRepoMemories(repo)).toEqual([]);
  });
});
