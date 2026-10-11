#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

function syncDirectory(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });

  for (const entry of readdirSync(targetDir)) {
    if (entry === "agents") continue;
    if (!existsSync(path.join(sourceDir, entry))) {
      rmSync(path.join(targetDir, entry), { recursive: true, force: true });
    }
  }

  for (const entry of readdirSync(sourceDir)) {
    if (entry === "agents") continue;
    const sourcePath = path.join(sourceDir, entry);
    const targetPath = path.join(targetDir, entry);
    if (statSync(sourcePath).isDirectory()) {
      syncDirectory(sourcePath, targetPath);
    } else {
      cpSync(sourcePath, targetPath);
    }
  }
}

export function syncAgentSkills(repoRoot = process.cwd()) {
  const sourceRoot = path.join(repoRoot, ".claude", "skills");
  const targetRoot = path.join(repoRoot, ".agents", "skills");
  if (!existsSync(sourceRoot)) {
    return { skipped: true };
  }

  mkdirSync(targetRoot, { recursive: true });
  for (const entry of readdirSync(targetRoot)) {
    if (entry === "agents") continue;
    if (!existsSync(path.join(sourceRoot, entry))) {
      rmSync(path.join(targetRoot, entry), { recursive: true, force: true });
    }
  }
  for (const entry of readdirSync(sourceRoot)) {
    if (entry === "agents") continue;
    syncDirectory(path.join(sourceRoot, entry), path.join(targetRoot, entry));
  }
  return { skipped: false };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncAgentSkills(process.argv[2] ?? process.cwd());
}
