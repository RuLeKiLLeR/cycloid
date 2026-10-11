import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../..");

const PHASE_LOG_FILES = [
  join(REPO_ROOT, "apps/sandbox-bridge/src/bridge.ts"),
  join(REPO_ROOT, "apps/control-plane-worker/src/session/prompt-queue.ts"),
  join(REPO_ROOT, "apps/control-plane-worker/src/session/terminal-side-effects.ts"),
];

const BANNED_EVENT_PATTERNS = [
  /event:\s*["']sandbox\.spawn\.completed["']/,
  /event:\s*["']bridge\.reconnect["']/,
  /event:\s*["']bridge\.ws_(closed|error)["']/,
  /event:\s*["']bridge\.reconnect\.pending_completion_redelivery["']/,
  /event:\s*["']codex\.session_create\./,
  /event:\s*["']codex\.session_restore\./,
  /event:\s*["']codex\.event_subscribe\./,
  /event:\s*["']codex\.prompt_dispatch\./,
  /event:\s*["']prompt\.execution\.completed["']/,
  /event:\s*["']workspace_setup\.wait_/,
  /event:\s*["']prompt\.system_context\./,
  /event:\s*["']prompt\.braintrust_context\./,
  /event:\s*["']prompt\.terminal_side_effects\./,
  /event:\s*["']prompt\.durable_close\.complete["']/,
];

describe("canonical phase log guardrail", () => {
  it("keeps known phase-mirroring logs on canonical phase values", () => {
    const violations: string[] = [];

    for (const file of PHASE_LOG_FILES) {
      const source = readFileSync(file, "utf-8");
      for (const pattern of BANNED_EVENT_PATTERNS) {
        if (!pattern.test(source)) continue;
        violations.push(`${relative(REPO_ROOT, file)} matched ${pattern}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
