#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { writeStamp } from "./ensure-deps.mjs";
import { syncAgentSkills } from "./sync-agent-skills.mjs";
import { syncCodexConfig } from "./sync-codex-config.mjs";

syncAgentSkills();
syncCodexConfig();

// Stamp the installed lockfile hash so scripts/ensure-deps.mjs can later detect
// when node_modules has drifted from package-lock.json (e.g. after a pull/sync).
writeStamp();

const result = spawnSync("husky", {
  stdio: "inherit",
});

if (result.error && result.error.code === "ENOENT") {
  process.exit(0);
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}
