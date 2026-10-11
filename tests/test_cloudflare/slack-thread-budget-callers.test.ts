import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Structural enforcement for the thread-budget law: `postThreadReply` (a raw
 * chat.postMessage into a thread) may only be referenced by this allowlist.
 * New session-thread posts MUST go through `slack/thread-budget.ts`
 * (`postSessionThreadMessage`) so the ≤3-messages-per-session-thread budget is
 * enforced by structure, not caller discipline.
 *
 * The allowlisted callers are either the budget module itself or PRE-session
 * operational surfaces (no claimed session yet), which are explicitly exempt.
 */
const POST_THREAD_REPLY_ALLOWLIST = new Set([
  // Definition + the only legal session-thread posting path.
  "slack/notify.ts",
  "slack/thread-budget.ts",
  // Plan-ready approval is a pre-session DM thread and has no session budget.
  "slack/plan-approval-interactions.ts",
  // Pre-session operational replies (repo disambiguation, invalid repo,
  // continuation failures — the thread claim is released on these paths).
  "webhooks/shared.ts",
  // Pre-session responder plumbing; session-bound instances carry a
  // sessionBudget binding and route through the budget module instead.
  "webhooks/slack-thread-responder.ts",
  // Unlinked-account magic-link reply (no session exists).
  "webhooks/slack-events.ts",
  // Channel-automation delivery surface (not a claimed session thread).
  "automation/slack-channel-service.ts",
]);

const SRC_ROOT = join(__dirname, "..", "..", "apps", "control-plane-worker", "src");

function listTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("thread-budget structural enforcement", () => {
  it("postThreadReply has no callers outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
      if (!readFileSync(file, "utf8").includes("postThreadReply")) continue;
      if (!POST_THREAD_REPLY_ALLOWLIST.has(rel)) offenders.push(rel);
    }
    expect(
      offenders,
      "New session-thread posts must route through slack/thread-budget.ts (postSessionThreadMessage). " +
        "If this file is genuinely a PRE-session surface, add it to the allowlist with a justification.",
    ).toEqual([]);
  });

  it("allowlisted files still exist (no stale entries)", () => {
    for (const rel of POST_THREAD_REPLY_ALLOWLIST) {
      expect(() => statSync(join(SRC_ROOT, rel)), rel).not.toThrow();
    }
  });
});
