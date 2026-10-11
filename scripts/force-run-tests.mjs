#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = "tests/force-run.json";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const listOnly = process.argv.includes("--list");
  const base = git(["merge-base", "origin/main", "HEAD"]).trim();
  if (!base) {
    console.error("error: could not find merge-base with origin/main");
    console.error("Run: git fetch origin main");
    process.exit(1);
  }

  const changedFiles = getChangedFiles(base);
  const tests = selectForcedTests(changedFiles, loadManifest(), getRepoFiles());

  if (listOnly) {
    console.log(tests.join("\n"));
    process.exit(0);
  }

  if (tests.length === 0) {
    console.log("No forced tests for changed files.");
    process.exit(0);
  }

  console.log(`Running forced tests:\n${tests.map((test) => `- ${test}`).join("\n")}`);
  const child = spawn("npx", ["vitest", "run", ...tests], { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

export function loadManifest(path = MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function getChangedFiles(baseCommit) {
  const files = [
    ...gitLines(["diff", "--name-only", "--no-renames", baseCommit]),
    ...gitLines(["diff", "--cached", "--name-only", "--no-renames", baseCommit]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ];
  return [...new Set(files)].filter(Boolean);
}

export function getRepoFiles() {
  return [...gitLines(["ls-files"]), ...gitLines(["ls-files", "--others", "--exclude-standard"])].filter(
    (file, index, files) => file && files.indexOf(file) === index,
  );
}

export function selectForcedTests(changedFiles, manifest, repoFiles) {
  const selected = new Set();

  for (const entry of manifest) {
    const sourceMatchers = entry.source.map(globToRegExp);
    if (!changedFiles.some((file) => sourceMatchers.some((matcher) => matcher.test(file)))) {
      continue;
    }

    for (const testGlob of entry.tests) {
      for (const file of resolveGlob(testGlob, repoFiles)) {
        selected.add(file);
      }
    }
  }

  return [...selected].sort();
}

export function resolveGlob(glob, repoFiles = getRepoFiles()) {
  const matcher = globToRegExp(glob);
  return repoFiles.filter((file) => matcher.test(file)).sort();
}

export function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (glob.startsWith("**/", index)) {
      pattern += "(?:.*/)?";
      index += 2;
    } else if (glob.startsWith("**", index)) {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

function gitLines(args) {
  return git(args)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}
