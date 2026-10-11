/**
 * Deterministic live-narration constants (slack/narration.ts).
 *
 * Copy principle: narration lines are outcomes, not mechanics — non-engineers
 * are the audience, and raw command lines must never land on the card.
 */

/**
 * Event types that never produce a narration line. Includes plumbing events
 * (heartbeats, usage/token accounting, retry/compaction chatter) plus text
 * deltas, which the web transcript renders but the card must not.
 */
export const NARRATION_SKIP_EVENT_TYPES = new Set([
  "heartbeat",
  "usage",
  "memory_usage",
  "memory_recall_usage",
  "retry_status",
  "compaction_start",
  "compaction_complete",
  "sandbox_compaction_start",
  "sandbox_compaction_complete",
  "estimated_input_composition",
  "token",
  "text",
  "reasoning",
]);

/** Hard cap for a rendered narration line (context-block text stays one line). */
export const NARRATION_MAX_LINE_LENGTH = 100;

/** SessionDO storage key for the narration throttle/dedup state. */
export const NARRATION_THROTTLE_STATE_STORAGE_KEY = "slack_narration_throttle_state";

/**
 * Tool names whose summaries are safe, deterministic activity descriptions
 * (file paths / search patterns) and already read first-person
 * ("Reading src/foo.ts", "Searching for …"). Everything else falls back to a
 * generic line so arbitrary tool input never reaches the card.
 */
export const NARRATION_SUMMARY_SAFE_TOOLS = new Set(["read", "write", "edit", "glob", "grep"]);

/** First tokens that identify a command as a test run. */
export const NARRATION_TEST_COMMAND_TOKENS = new Set([
  "vitest",
  "jest",
  "pytest",
  "mocha",
  "rspec",
  "phpunit",
  "playwright",
  "ava",
  "tape",
  "ctest",
]);

/** First tokens that identify a command as a build/compile step. */
export const NARRATION_BUILD_COMMAND_TOKENS = new Set([
  "make",
  "tsc",
  "webpack",
  "esbuild",
  "rollup",
  "vite",
  "gradle",
  "gradlew",
  "mvn",
]);

/**
 * Package-manager / launcher tokens whose FOLLOWING token carries the intent
 * (`npm test`, `npx vitest`, `cargo build`, `go test`, `docker build`, …).
 */
export const NARRATION_COMMAND_LAUNCHER_TOKENS = new Set([
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "bunx",
  "cargo",
  "go",
  "docker",
]);

/** Fixed labels for classified commands — never the raw command line. */
export const NARRATION_COMMAND_LABELS = {
  tests: "Running tests",
  build: "Running a build",
  script: "Running a script",
} as const;

/**
 * Agent-timeline milestones worth narrating. Unlisted event types return no
 * line (tool_call narration covers the underlying activity in more detail).
 */
export const NARRATION_TIMELINE_MILESTONE_LABELS: Readonly<Record<string, string>> = {
  "prompt.started": "Getting started",
  "context.selected": "Inspecting the repo",
  "files.inspected": "Inspecting the repo",
  "files.edited": "Applying edits",
  "git.commit": "Committing changes",
  "git.push": "Pushing changes",
  "pr.open": "Opening a pull request",
};
