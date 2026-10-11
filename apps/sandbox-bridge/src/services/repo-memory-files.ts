import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import {
  memoryDisplayTitle,
  parseMemoryFile,
  shouldIgnoreMemoryPath,
  toRuntimeMemory,
} from "../../../../shared/memory/parser.js";
import { wrapInstructionContent } from "../../../../shared/utils/prompt-safety.js";
import type { Memory } from "./memory-ranking.js";

export type LoadedRepoMemory = {
  memory: Memory;
  file: string;
  repoRelativePath: string;
  title: string;
};

export function listRepoMemoryFiles(repoPath: string): string[] {
  try {
    const repoRoot = realpathSync(repoPath);
    const memDir = join(repoRoot, ".cycloid", "memory");
    if (!existsSync(memDir)) return [];
    const memDirStat = lstatSync(memDir);
    if (!memDirStat.isDirectory() || memDirStat.isSymbolicLink()) return [];
    const memoryRoot = realpathSync(memDir);
    if (!isContainedPath(repoRoot, memoryRoot)) return [];
    return listMemoryFiles(memoryRoot, repoRoot, memoryRoot);
  } catch {
    return [];
  }
}

export function loadActiveRepoMemories(repoPath: string): LoadedRepoMemory[] {
  const memories: LoadedRepoMemory[] = [];
  const seenIds = new Set<string>();
  for (const file of listRepoMemoryFiles(repoPath)) {
    const parsed = parseMemoryFile(readFileSync(file, "utf-8"));
    if (!parsed || parsed.status !== "active" || seenIds.has(parsed.id)) continue;
    seenIds.add(parsed.id);
    memories.push({
      file,
      repoRelativePath: relative(repoPath, file).split("\\").join("/"),
      title: memoryDisplayTitle(parsed),
      memory: toRuntimeMemory({
        ...parsed,
        content: wrapInstructionContent(parsed.content, "repo_memory", file),
      }),
    });
  }
  return memories;
}

function listMemoryFiles(dir: string, repoRoot: string, memoryRoot: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      const realDir = realpathSync(fullPath);
      if (!isContainedPath(repoRoot, realDir) || !isContainedPath(memoryRoot, realDir)) continue;
      files.push(...listMemoryFiles(realDir, repoRoot, memoryRoot));
      continue;
    }
    if (entry.endsWith(".md") && !shouldIgnoreMemoryPath(fullPath)) {
      const realFile = realpathSync(fullPath);
      if (!isContainedPath(repoRoot, realFile) || !isContainedPath(memoryRoot, realFile)) continue;
      files.push(fullPath);
    }
  }
  return files;
}

function isContainedPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}
