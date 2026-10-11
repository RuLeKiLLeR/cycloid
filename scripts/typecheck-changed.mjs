#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";

const CHECKS = {
  root: ["tsc", ["--noEmit"]],
  cli: ["npm", ["run", "-w", "@trycycloid/cli", "typecheck"]],
  control: ["npm", ["run", "-w", "@cycloid/control-plane-worker", "typecheck"]],
  ui: ["npm", ["run", "-w", "cycloid-ui", "typecheck"]],
  bridge: ["npm", ["run", "-w", "@cycloid/sandbox-bridge", "typecheck"]],
  status: ["npm", ["run", "-w", "@cycloid/status-worker", "typecheck"]],
  workflows: ["node", ["scripts/typecheck-workflows.mjs"]],
};

const APP_CHECKS = new Map([
  ["apps/cli/", "cli"],
  ["apps/control-plane-worker/", "control"],
  ["apps/ui/", "ui"],
  ["apps/sandbox-bridge/", "bridge"],
  ["tools/", "bridge"],
  ["apps/status-worker/", "status"],
]);

const ALL_TYPESCRIPT_CHECKS = ["root", "cli", "control", "ui", "bridge", "status"];
const WORKSPACE_PACKAGE_FILES = new Map([
  ["apps/cli/package.json", "cli"],
  ["apps/control-plane-worker/package.json", "control"],
  ["apps/ui/package.json", "ui"],
  ["apps/sandbox-bridge/package.json", "bridge"],
  ["apps/status-worker/package.json", "status"],
]);

const base = git(["merge-base", "origin/main", "HEAD"]).trim();
if (!base) {
  console.error("error: could not find merge-base with origin/main");
  console.error("Run: git fetch origin main");
  process.exit(1);
}

const changedFiles = getChangedFiles(base);
const checks = selectChecks(changedFiles);

if (checks.length === 0) {
  console.log("No changed files require TypeScript or workflow typechecks.");
  process.exit(0);
}

console.log(`Running changed typechecks: ${checks.join(", ")}`);
const failures = await runChecks(checks);
if (failures.length > 0) {
  console.error(`Changed typechecks failed: ${failures.join(", ")}`);
  process.exit(1);
}

function getChangedFiles(baseCommit) {
  const files = [
    ...gitLines(["diff", "--name-only", baseCommit]),
    ...gitLines(["diff", "--cached", "--name-only", baseCommit]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ];
  return [...new Set(files)].filter(Boolean);
}

function selectChecks(files) {
  const checks = new Set();

  for (const file of files) {
    if (file.startsWith(".github/workflows/")) {
      checks.add("workflows");
      continue;
    }

    if (isRepoWideTypecheckInput(file)) {
      for (const check of ALL_TYPESCRIPT_CHECKS) checks.add(check);
      continue;
    }

    const packageCheck = WORKSPACE_PACKAGE_FILES.get(file);
    if (packageCheck) {
      checks.add(packageCheck);
      continue;
    }

    const appCheck = findAppCheck(file);
    if (appCheck) {
      checks.add(appCheck);
      continue;
    }

    if (isRootTypecheckInput(file)) {
      checks.add("root");
    }
  }

  return [...checks];
}

function isRepoWideTypecheckInput(file) {
  return (
    file === "package.json" ||
    file === "package-lock.json" ||
    file === "tsconfig.json" ||
    file === "tools.toml" ||
    file.startsWith("shared/")
  );
}

function findAppCheck(file) {
  for (const [prefix, check] of APP_CHECKS) {
    if (file.startsWith(prefix)) return check;
  }
  return null;
}

function isRootTypecheckInput(file) {
  if (file.startsWith("apps/")) return true;
  return /\.(ts|tsx|mts|cts)$/.test(file);
}

async function runChecks(checks) {
  const results = await Promise.all(
    checks.map(
      (check) =>
        new Promise((resolve) => {
          const [command, args] = CHECKS[check];
          const child = spawn(command, args, { stdio: "inherit" });
          child.on("error", (error) => {
            console.error(`${check}: ${error.message}`);
            resolve(check);
          });
          child.on("exit", (code) => resolve(code === 0 ? null : check));
        }),
    ),
  );
  return results.filter(Boolean);
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
