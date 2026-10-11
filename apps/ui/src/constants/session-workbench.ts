// Session workbench statics: inspector panel geometry/persistence and the
// Runtime tab's activity tail. Constants live here per docs/conventions.md;
// never inline them in components.

/** Default inspector width (px). Snapped to the 4px baseline grid. */
export const SESSION_INSPECTOR_DEFAULT_WIDTH = 360;
export const SESSION_INSPECTOR_MIN_WIDTH = 280;
export const SESSION_INSPECTOR_MAX_WIDTH = 560;
/** Thread floor while the desktop inspector is open. */
export const SESSION_THREAD_MIN_WIDTH = 512;
/** Keyboard resize increment for the inspector separator. */
export const SESSION_INSPECTOR_KEYBOARD_STEP = 16;
export const SESSION_INSPECTOR_WIDTH_KEY = "cycloid-session-inspector-width";
export const SESSION_INSPECTOR_COLLAPSED_KEY = "cycloid-session-inspector-collapsed";
export const SESSION_INSPECTOR_EXPANDED_KEY = "cycloid-session-inspector-expanded";
/** Wide-layout width (px): 2x the max drag width, clamped by the viewport fraction below. */
export const SESSION_INSPECTOR_EXPANDED_WIDTH = 1120;
/** Viewport share the expanded inspector may claim so the thread stays visible. */
export const SESSION_INSPECTOR_EXPANDED_VIEWPORT_FRACTION = 0.66;

/**
 * Active artifact tab is persisted per session so switching sessions cannot
 * leak a tab selection. Full key: `${prefix}${sessionId}`.
 */
/**
 * Artifact-tab ids. The inspector's tab registry derives its union from this
 * map. Verification/check evidence lives inside the Report tab (its
 * "Verification" section), so the tab set fits the default inspector width.
 */
export const SESSION_ARTIFACT_TAB_IDS = {
  summary: "summary",
  runtime: "runtime",
  changes: "changes",
  report: "report",
  pr: "pr",
} as const;

/**
 * Fixed inspector tabs, in stable display order. The PR tab is appended
 * conditionally. Labels use the design contract's compact artifact nouns
 * ("Run", "Files") so the full set fits the default 360px inspector.
 */
export const SESSION_ARTIFACT_FIXED_TABS = [
  { id: SESSION_ARTIFACT_TAB_IDS.summary, label: "Summary" },
  { id: SESSION_ARTIFACT_TAB_IDS.runtime, label: "Run" },
  { id: SESSION_ARTIFACT_TAB_IDS.changes, label: "Files" },
  { id: SESSION_ARTIFACT_TAB_IDS.report, label: "Report" },
] as const;

export const SESSION_ARTIFACT_DEFAULT_TAB_ID = SESSION_ARTIFACT_TAB_IDS.summary;
/** PR tab label when the PR number cannot be parsed (e.g. publish error, no URL yet). */
export const SESSION_ARTIFACT_PR_TAB_FALLBACK_LABEL = "PR";

/**
 * Placeholder sandbox id the control plane broadcasts on `sandbox_ready` /
 * synthesized heartbeats when the real id could not be resolved
 * (`incomingSandboxId || "unknown"` in ws-manager.ts). Never display it.
 */
export const SANDBOX_ID_UNKNOWN_SENTINEL = "unknown";

/** Max entries surfaced by the Runtime tab's recent-activity tail. */
export const RUNTIME_LOG_TAIL_LIMIT = 8;

/** Max compaction/fill-warning entries listed under the Runtime tab's context readout. */
export const RUNTIME_CONTEXT_EVENT_LIMIT = 6;

/**
 * Classifies a shell tool call as a test run for the Runtime tab's activity
 * tail. Matches the common JS/TS/Python/Go/Rust/Ruby test invocations that
 * appear in tool-call summaries.
 */
export const RUNTIME_TEST_COMMAND_PATTERN =
  /\b(vitest|jest|pytest|playwright|cypress|rspec|phpunit|go test|cargo test|npm (?:run )?test|npx test|yarn test|pnpm test)\b/i;
