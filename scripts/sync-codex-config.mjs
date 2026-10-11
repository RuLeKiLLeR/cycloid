#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PROJECT_MCP_SERVER_NAMES = new Set(["cycloid", "braintrust", "datadog", "linear", "sentry", "slack"]);

function parseMcpServerSection(line) {
  const trimmed = line.trim();
  const match = /^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\..+)?\]$/.exec(trimmed);
  if (!match) {
    return null;
  }

  return match[1] ?? match[2] ?? null;
}

export function listTomlMcpServers(content) {
  const names = new Set();

  for (const line of content.split("\n")) {
    const name = parseMcpServerSection(line);
    if (name) {
      names.add(name);
    }
  }

  return names;
}

export function pruneStaleProjectMcpServers(runtimeContent, exampleContent) {
  const exampleServers = listTomlMcpServers(exampleContent);
  const staleServers = new Set([...PROJECT_MCP_SERVER_NAMES].filter((serverName) => !exampleServers.has(serverName)));

  if (staleServers.size === 0) {
    return runtimeContent;
  }

  const runtimeHasTrailingNewline = runtimeContent.endsWith("\n");
  const keptLines = [];
  let skippedServer = null;

  for (const line of runtimeContent.split("\n")) {
    const sectionServer = parseMcpServerSection(line);

    if (skippedServer) {
      if (sectionServer === skippedServer) {
        continue;
      }
      if (line.trim().startsWith("[")) {
        skippedServer = null;
      } else {
        continue;
      }
    }

    if (!skippedServer && sectionServer && staleServers.has(sectionServer)) {
      skippedServer = sectionServer;
      continue;
    }

    keptLines.push(line);
  }

  const pruned = keptLines
    .join("\n")
    .replace(/\n{3,}$/u, "\n\n")
    .replace(/\n{3,}(?=\[)/gu, "\n\n");
  return runtimeHasTrailingNewline && !pruned.endsWith("\n") ? `${pruned}\n` : pruned;
}

export function syncCodexConfig(repoRoot = process.cwd()) {
  const codexDir = path.join(repoRoot, ".codex");
  const examplePath = path.join(codexDir, "config.example.toml");
  const runtimePath = path.join(codexDir, "config.toml");

  if (!existsSync(examplePath)) {
    return { seeded: false, pruned: false, runtimePath, skipped: true };
  }

  let seeded = false;
  if (!existsSync(runtimePath)) {
    copyFileSync(examplePath, runtimePath);
    seeded = true;
  }

  const exampleContent = readFileSync(examplePath, "utf8");
  const runtimeContent = readFileSync(runtimePath, "utf8");
  const prunedContent = pruneStaleProjectMcpServers(runtimeContent, exampleContent);
  const pruned = prunedContent !== runtimeContent;

  if (pruned) {
    writeFileSync(runtimePath, prunedContent);
  }

  return { seeded, pruned, runtimePath, skipped: false };
}

function main() {
  syncCodexConfig(process.argv[2] ?? process.cwd());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
