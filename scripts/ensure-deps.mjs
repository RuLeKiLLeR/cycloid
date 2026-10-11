#!/usr/bin/env node
// Keep node_modules in sync with package-lock.json.
//
// Teammates' dependency changes arrive via `git pull` / `gt sync` as an updated
// package-lock.json, but nothing reinstalls them -- so node_modules silently
// drifts until a later `npm run typecheck` or test blows up with a cryptic
// "cannot find module" error (this is what happened with
// @cloudflare/vitest-pool-workers). This detects drift by comparing a hash of
// package-lock.json against a stamp written at the last successful install, and
// runs `npm ci` when they diverge. The stamp itself is (re)written by the
// prepare step (scripts/prepare-local.mjs) that every install runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCKFILE = join(ROOT, "package-lock.json");
// Lives under node_modules so a wiped/fresh node_modules has no stamp and is
// correctly treated as drifted (forcing an install).
export const STAMP_FILE = join(ROOT, "node_modules", ".deps-lock-hash");

export function hashLockfile(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Pure drift check.
 * @param {string | null} lock  package-lock.json contents, or null if it does not exist.
 * @param {string | null} stamp previously stored hash, or null if never stamped.
 */
export function needsInstall(lock, stamp) {
  if (lock === null) return false; // no lockfile -> nothing to enforce
  if (stamp === null) return true; // never installed / node_modules wiped
  return hashLockfile(lock) !== stamp.trim();
}

function readOrNull(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Record the current package-lock.json hash so future drift checks have a
 * baseline. Called from the prepare step that runs on every `npm install`.
 * No-op if the lockfile or node_modules is not present yet.
 */
export function writeStamp() {
  const lock = readOrNull(LOCKFILE);
  if (lock === null || !existsSync(join(ROOT, "node_modules"))) return;
  writeFileSync(STAMP_FILE, hashLockfile(lock));
}

function main() {
  const lock = readOrNull(LOCKFILE);
  const stamp = readOrNull(STAMP_FILE);
  if (!needsInstall(lock, stamp)) return;
  console.log("node_modules is out of sync with package-lock.json; running npm ci...");
  // npm ci (not npm install): a deterministic install straight from the lockfile
  // that never rewrites package-lock.json. A plain `npm install` could silently
  // "fix up" a lockfile that is actually out of sync with package.json and let
  // the push proceed on it; npm ci instead fails loudly -- the fail-closed
  // behavior we want in a pre-push guard.
  const result = spawnSync("npm", ["ci"], { stdio: "inherit", cwd: ROOT });
  if (result.error) throw result.error;
  // result.status is null when npm is killed by a signal; treat any non-zero or
  // non-completed exit as failure so pre-push stops instead of continuing on
  // still-broken node_modules.
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Only run side effects when invoked directly, so tests can import the helpers.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
