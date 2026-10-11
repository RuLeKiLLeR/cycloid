#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const DEVELOPER_ABSOLUTE_PATH_PATTERN = /(?<![A-Za-z0-9:/])\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>)]*)?/g;

const ALLOWED_USER_SEGMENTS = new Set([
  "Shared",
  "app",
  "circleci",
  "coder",
  "codespace",
  "node",
  "runner",
  "sandbox",
  "ubuntu",
  "user",
  "vscode",
]);

const ALWAYS_EXCLUDED_FILE_PATTERNS = [
  /^package-lock\.json$/,
  /^tests\/fixtures\//,
  /^tests\/test_shared\/fixtures\//,
  /^tests\/test_sandbox-bridge\/fixtures\//,
];

function isBinaryContent(content) {
  return content.includes(0);
}

function getLineColumn(content, index) {
  let line = 1;
  let column = 1;

  for (let i = 0; i < index; i += 1) {
    if (content[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function getUserSegment(pathValue) {
  const parts = pathValue.split("/");
  return parts[2] ?? "";
}

function trimTrailingSentencePunctuation(pathValue) {
  return pathValue.replace(/[.,;:!?]+$/u, "");
}

export function isAllowedAbsolutePath(pathValue) {
  return ALLOWED_USER_SEGMENTS.has(getUserSegment(pathValue));
}

export function isScannedRepoFile(filePath) {
  if (!filePath || filePath.startsWith(".git/")) {
    return false;
  }

  return !ALWAYS_EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function findDeveloperAbsolutePaths(content, filePath = "<input>") {
  if (typeof content !== "string" && isBinaryContent(content)) {
    return [];
  }

  const text = typeof content === "string" ? content : content.toString("utf8");
  const findings = [];

  for (const match of text.matchAll(DEVELOPER_ABSOLUTE_PATH_PATTERN)) {
    const pathValue = trimTrailingSentencePunctuation(match[0]);
    if (isAllowedAbsolutePath(pathValue)) {
      continue;
    }

    const { line, column } = getLineColumn(text, match.index ?? 0);
    findings.push({
      filePath,
      line,
      column,
      path: pathValue,
    });
  }

  return findings;
}

function getTrackedFiles(repoRoot) {
  const result = spawnSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "git ls-files failed");
  }

  return result.stdout
    .split("\n")
    .map((filePath) => filePath.trim())
    .filter(Boolean);
}

export function scanRepoFiles(repoRoot, filePaths) {
  const findings = [];

  for (const filePath of filePaths) {
    if (!isScannedRepoFile(filePath)) {
      continue;
    }

    const absolutePath = join(repoRoot, filePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const content = readFileSync(absolutePath);
    findings.push(...findDeveloperAbsolutePaths(content, filePath));
  }

  return findings;
}

function formatFinding(finding) {
  return `${finding.filePath}:${finding.line}:${finding.column} ${finding.path}`;
}

export function formatFailureMessage(findings) {
  return [
    "Developer-specific absolute paths are not allowed in shared repo files.",
    "Use repo-relative paths, placeholders like /Users/<name>/..., or runtime-derived paths instead.",
    "",
    ...findings.map(formatFinding),
  ].join("\n");
}

function main() {
  const repoRoot = process.cwd();
  const findings = scanRepoFiles(repoRoot, getTrackedFiles(repoRoot));

  if (findings.length > 0) {
    console.error(formatFailureMessage(findings));
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
