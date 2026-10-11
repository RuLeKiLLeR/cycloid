import type { DisplayStatus } from "../../../../../shared/session/display-status.js";
import { displayStatusFromSession } from "../../../../../shared/session/display-status.js";
import type { UiLifecycleStage } from "../../../../../shared/session/lifecycle-stage.js";
import type {
  CycloidDoneOutcome,
  CycloidDoneState,
  VerificationResult,
  VerificationState,
} from "../../../../../shared/session/phase.js";
import type { QaRunView } from "../../../../../shared/types/qa-run.js";
import {
  SESSION_ARTIFACT_DEFAULT_TAB_ID,
  SESSION_ARTIFACT_FIXED_TABS,
  SESSION_ARTIFACT_PR_TAB_FALLBACK_LABEL,
  SESSION_ARTIFACT_TAB_IDS,
} from "../../constants/session-workbench";
import { isFileChangeTool } from "../../constants/tools";
import type { ActivityEvent, FinalizingStep, Phase } from "../../types";
import type { PhaseState } from "../ui";

/**
 * Canonical async-workbench lifecycle used by the left context rail's
 * `PhaseTimeline`. This is a presentation-only projection of the session's real
 * lifecycle fields (`phase`, `uiLifecycleStage`, `prUrl`, verification) — it is
 * NOT a new FSM and never drives any state transition.
 */
// Stage labels share the status chip's vocabulary (getCanonicalSessionStatus)
// so the timeline and the chip never describe the same moment with two word
// families — the chip says "Working", so the stage does too.
export const WORKBENCH_PHASES = [
  { key: "created", label: "Created" },
  { key: "planning", label: "Planning" },
  { key: "building", label: "Working" },
  { key: "verifying", label: "Verifying" },
  { key: "publishing", label: "Publishing" },
  { key: "review", label: "Reviewing" },
  { key: "done", label: "Completed" },
] as const;

export const WORKBENCH_PHASE_INDEX = {
  created: 0,
  planning: 1,
  building: 2,
  verifying: 3,
  publishing: 4,
  review: 5,
  done: 6,
} as const;

export type WorkbenchPhaseInput = {
  phase: Phase;
  closeReason?: string | null;
  uiLifecycleStage?: UiLifecycleStage;
  finalizingStep?: FinalizingStep;
  reviewLoopDoneState?: "working" | "done" | null;
  sandboxSubstate?: string | null;
  prUrl?: string | null;
  hasVerification?: boolean;
  promptCount?: number;
  observedEvents?: readonly ActivityEvent[];
};

/**
 * Map the session's real lifecycle signals onto a zero-based index into
 * `WORKBENCH_PHASES`. Highest reached stage wins so a completed session shows
 * every earlier phase as done. Returns the index the timeline renders as the
 * `current` step.
 */
export function deriveWorkbenchPhaseIndex(input: WorkbenchPhaseInput): number {
  const { phase, uiLifecycleStage, finalizingStep, reviewLoopDoneState, sandboxSubstate, promptCount } = input;
  const I = WORKBENCH_PHASE_INDEX;

  // Post-publish lifecycle stage is the strongest signal when present.
  switch (uiLifecycleStage) {
    case "merged":
      return I.done;
    case "closed":
    case "superseded":
      return I.done;
    case "merge_ready":
      return I.review;
    case "verifying":
      return input.prUrl ? I.review : I.verifying;
  }

  switch (phase) {
    case "completed":
    case "archived":
      return I.done;
    case "review_listening":
      return I.review;
    case "finalizing":
      if (finalizingStep === "post_execution") return I.verifying;
      if (finalizingStep === "publishing") return I.publishing;
      return I.building;
    case "failed":
    case "blocked":
      // Show how far it got before stalling.
      return promptCount && promptCount > 0 ? I.building : I.created;
    case "waiting_for_input":
      return I.building;
    case "running":
      if (sandboxSubstate === "creating") return promptCount && promptCount > 0 ? I.building : I.planning;
      return I.building;
    case "stopped":
      return promptCount && promptCount > 0 ? I.building : I.created;
    case "idle":
      return promptCount && promptCount > 0 ? I.building : I.created;
    default:
      return reviewLoopDoneState ? I.review : I.created;
  }
}

export function deriveWorkbenchPhaseStates(input: WorkbenchPhaseInput): PhaseState[] {
  const index = deriveWorkbenchPhaseIndex(input);
  const observedEventTypes = new Set(
    (input.observedEvents ?? [])
      .filter((event): event is Extract<ActivityEvent, { type: "agent_timeline" }> => event.type === "agent_timeline")
      .map((event) => event.eventType),
  );
  const observedProgressSteps = new Set(
    (input.observedEvents ?? [])
      .filter((event): event is Extract<ActivityEvent, { type: "agent_progress" }> => event.type === "agent_progress")
      .map((event) => event.step),
  );
  const observed = new Set<number>([WORKBENCH_PHASE_INDEX.created]);
  if (
    input.sandboxSubstate === "creating" ||
    [...observedProgressSteps].some((step) =>
      [
        "starting_agent",
        "preparing_workspace",
        "processing_attachments",
        "preparing_context",
        "waiting_for_model",
      ].includes(step),
    )
  ) {
    observed.add(WORKBENCH_PHASE_INDEX.planning);
  }
  if ((input.promptCount ?? 0) > 0 || input.phase === "running" || input.phase === "waiting_for_input") {
    observed.add(WORKBENCH_PHASE_INDEX.building);
  }
  if (
    input.finalizingStep === "post_execution" ||
    input.hasVerification ||
    observedEventTypes.has("verification.result") ||
    observedEventTypes.has("publish_gate.result")
  ) {
    observed.add(WORKBENCH_PHASE_INDEX.verifying);
  }
  if (
    input.finalizingStep === "publishing" ||
    Boolean(input.prUrl) ||
    observedEventTypes.has("git.push") ||
    observedEventTypes.has("pr.open")
  ) {
    observed.add(WORKBENCH_PHASE_INDEX.publishing);
  }
  if (input.phase === "review_listening" || input.reviewLoopDoneState || input.uiLifecycleStage === "merge_ready") {
    observed.add(WORKBENCH_PHASE_INDEX.review);
  }
  if (
    input.phase === "completed" ||
    input.phase === "archived" ||
    input.uiLifecycleStage === "merged" ||
    input.uiLifecycleStage === "closed" ||
    input.uiLifecycleStage === "superseded"
  ) {
    observed.add(WORKBENCH_PHASE_INDEX.done);
  }

  const states: PhaseState[] = WORKBENCH_PHASES.map((_, phaseIndex) =>
    observed.has(phaseIndex) && phaseIndex < index ? "done" : "pending",
  );
  const displayStatus = displayStatusFromSession(input);
  const settledStage =
    input.uiLifecycleStage === "merge_ready" ||
    input.uiLifecycleStage === "merged" ||
    input.uiLifecycleStage === "closed" ||
    input.uiLifecycleStage === "superseded";

  if (displayStatus === "completed" || settledStage) {
    // Settled sessions: every observed stage is done; the rest never happened
    // and never will (e.g. Publishing/Reviewing on a completed-without-PR
    // session), so they render as skipped, not pending.
    for (const [phaseIndex] of WORKBENCH_PHASES.entries()) {
      states[phaseIndex] = observed.has(phaseIndex) ? "done" : "skipped";
    }
  } else if (displayStatus === "failed") {
    states[index] = "failed";
  } else if (displayStatus === "stopped" || displayStatus === "archived" || displayStatus === "waiting_for_input") {
    states[index] = "paused";
  } else {
    states[index] = "current";
  }
  return states;
}

export type CanonicalSessionStatus = {
  label:
    | "Working"
    | "Needs you"
    | "Publishing"
    | "Reviewing"
    | "PR ready"
    | "QA running"
    | "Verifying"
    | "Merge ready"
    | "Merged"
    | "Closed"
    | "Superseded"
    | "Completed"
    | "Failed"
    | "Archived"
    | "Stopped";
  title: string;
  tone: "accent" | "warning" | "success" | "error" | "muted";
};

export type CanonicalSessionStatusInput = WorkbenchPhaseInput & {
  reviewLoopDoneState?: "working" | "done" | null;
  displayStatus?: DisplayStatus;
  verificationState?: VerificationState | null;
  verificationResult?: VerificationResult | null;
  qaRun?: QaRunView | null;
  cycloidDoneState?: CycloidDoneState | null;
  cycloidDoneOutcome?: CycloidDoneOutcome | null;
  userStopped?: boolean;
};

export function getCanonicalSessionStatus(input: CanonicalSessionStatusInput): CanonicalSessionStatus {
  const displayStatus = input.displayStatus ?? displayStatusFromSession(input);
  if (displayStatus === "waiting_for_input") {
    return { label: "Needs you", title: "Waiting for your answer", tone: "warning" };
  }
  if (input.phase === "blocked") {
    return { label: "Needs you", title: "Cycloid is blocked and needs your attention", tone: "warning" };
  }
  if (displayStatus === "failed") return { label: "Failed", title: "Session failed", tone: "error" };
  if (displayStatus === "archived") {
    return input.closeReason === "user_stopped"
      ? { label: "Stopped", title: "Session was stopped", tone: "muted" }
      : { label: "Archived", title: "Session is archived", tone: "muted" };
  }
  if (displayStatus === "stopped") {
    if (input.phase === "idle" && input.userStopped) {
      return { label: "Stopped", title: "Stopped — continue anytime", tone: "muted" };
    }
    return { label: "Stopped", title: "Session is not actively working", tone: "muted" };
  }

  const hasExplicitVerificationFields = input.verificationState !== undefined || input.verificationResult !== undefined;
  const mergeReady =
    displayStatus === "completed" &&
    input.reviewLoopDoneState === "done" &&
    input.cycloidDoneState === "done" &&
    input.cycloidDoneOutcome === "success";

  if (hasExplicitVerificationFields) {
    if (
      input.verificationState === "verification-pending" ||
      input.verificationState === "verification-in-progress" ||
      input.qaRun?.state === "verification-pending" ||
      input.qaRun?.state === "verification-in-progress"
    ) {
      return { label: "QA running", title: "QA testing is running", tone: "accent" };
    }
    const verificationAllowsMergeReady =
      input.verificationState === "verification-skipped" ||
      (input.verificationState === "verification-done" && input.verificationResult === "merge-ready");
    if (verificationAllowsMergeReady && mergeReady) {
      return { label: "Merge ready", title: "Review loop caught up and checks passed", tone: "success" };
    }
  }

  switch (hasExplicitVerificationFields ? undefined : input.uiLifecycleStage) {
    case "verifying":
      return { label: "Verifying", title: "Post-publish verification is running", tone: "accent" };
    case "merge_ready":
      return { label: "Merge ready", title: "Checks passed", tone: "success" };
    case "merged":
      return { label: "Merged", title: "Pull request was merged", tone: "success" };
    case "closed":
      return { label: "Closed", title: "Pull request was closed", tone: "muted" };
    case "superseded":
      return { label: "Superseded", title: "Session was superseded", tone: "muted" };
  }

  if (input.phase === "finalizing") {
    if (input.finalizingStep === "post_execution") {
      return { label: "Verifying", title: "Verification checks are running", tone: "accent" };
    }
    if (input.finalizingStep === "publishing") {
      return { label: "Publishing", title: "Changes are being published", tone: "accent" };
    }
  }
  if (input.phase === "review_listening" || input.reviewLoopDoneState === "working") {
    return { label: "Reviewing", title: "Review follow-ups are in progress", tone: "accent" };
  }
  if (input.prUrl && displayStatus === "completed") {
    // PR-E1 copy: once the done-state aggregate says merge-ready, the chip
    // title leads with the proof ("Checks passed"), not a neutral readout.
    return { label: "PR ready", title: mergeReady ? "Checks passed" : "Pull request is ready", tone: "success" };
  }
  if (displayStatus === "completed") {
    return { label: "Completed", title: "Session completed", tone: "success" };
  }
  if (displayStatus === "working") return { label: "Working", title: "Session is working", tone: "accent" };
  return { label: "Stopped", title: "Session is not actively working", tone: "muted" };
}

export type ArtifactTabId = (typeof SESSION_ARTIFACT_TAB_IDS)[keyof typeof SESSION_ARTIFACT_TAB_IDS];

export type ArtifactTab = {
  id: ArtifactTabId;
  label: string;
  /** Count rendered next to the label, or null when the tab carries no count. */
  badge: number | null;
};

/**
 * Parse the PR number out of a GitHub pull-request URL. Mirrors the shared
 * `/pull/<n>` extraction used by memory retrieval; returns null for anything
 * that is not a positive integer PR number.
 */
export function parsePrNumber(prUrl: string | null | undefined): number | null {
  if (!prUrl) return null;
  const match = prUrl.match(/\/pull\/(\d+)\b/i);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export type ArtifactTabsInput = {
  /** Touched-file count; badges the Changes tab when > 0. */
  changesCount: number;
  /** Session has PR-object data (URL, outcome, or publish error) — same signal PrSection renders from. */
  hasPr: boolean;
  prUrl: string | null;
};

/**
 * Build the inspector tab registry: the fixed workspace tabs (Summary, Runtime,
 * Changes, Report — always present, stable order, no mid-session layout shift)
 * plus a trailing PR tab once the session has a publish object. The PR tab is
 * labeled with the real PR number when the URL carries one. Verification/check
 * evidence renders inside the Report tab.
 */
export function buildArtifactTabs(input: ArtifactTabsInput): ArtifactTab[] {
  const tabs: ArtifactTab[] = SESSION_ARTIFACT_FIXED_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    badge: tab.id === SESSION_ARTIFACT_TAB_IDS.changes && input.changesCount > 0 ? input.changesCount : null,
  }));
  if (input.hasPr) {
    const prNumber = parsePrNumber(input.prUrl);
    tabs.push({
      id: SESSION_ARTIFACT_TAB_IDS.pr,
      label: prNumber !== null ? `PR #${prNumber}` : SESSION_ARTIFACT_PR_TAB_FALLBACK_LABEL,
      badge: null,
    });
  }
  return tabs;
}

/**
 * Resolve a URL-backed tab id against the rendered registry. A stale or
 * unknown value — e.g. "pr" for a session that no longer shows a
 * PR tab — falls back to Summary.
 */
export function resolveArtifactTab(stored: string | null, tabs: readonly ArtifactTab[]): ArtifactTabId {
  const match = tabs.find((tab) => tab.id === stored);
  return match ? match.id : SESSION_ARTIFACT_DEFAULT_TAB_ID;
}

/**
 * Display branch for a session: the branch the work started from, falling back
 * through base/last/published. Single source for the rail, summary, and
 * runtime readouts.
 */
export function sessionDisplayBranch(session: {
  startBranch?: string | null;
  baseBranch?: string | null;
  lastBranch?: string | null;
  publishedBranch?: string | null;
}): string | null {
  return (
    session.startBranch?.trim() ||
    session.baseBranch?.trim() ||
    session.lastBranch?.trim() ||
    session.publishedBranch?.trim() ||
    null
  );
}

/**
 * Parse a persisted inspector width. Non-numeric input falls back to the
 * default; numeric input is clamped into [min, max] so a stale value from an
 * older layout cannot render an unusable panel.
 */
export function parseStoredPanelWidth(
  raw: string | null,
  bounds: { min: number; max: number; fallback: number },
): number {
  const parsed = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
  if (Number.isNaN(parsed)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

export type ReportTexts = {
  /** First user prompt — the request. */
  requestText: string | null;
  /** Latest settled assistant message — the summary. */
  finalMessage: string | null;
};

type ReportPrompt = { promptId: string; prompt: string; result: string | Record<string, unknown> | null };

/**
 * Pull the request/summary pair for the report from data the page already
 * holds: the first prompt's text, and the newest settled result — a string
 * prompt result when present, otherwise the last streamed assistant text of
 * the newest prompt that produced any.
 */
export function deriveReportTexts(prompts: ReportPrompt[], transcripts: Map<string, ActivityEvent[]>): ReportTexts {
  const requestText = prompts[0]?.prompt.trim() || null;

  let finalMessage: string | null = null;
  for (let i = prompts.length - 1; i >= 0 && finalMessage === null; i--) {
    const prompt = prompts[i];
    if (!prompt) continue;
    if (typeof prompt.result === "string" && prompt.result.trim()) {
      finalMessage = prompt.result.trim();
      break;
    }
    const events = transcripts.get(prompt.promptId) ?? [];
    for (let j = events.length - 1; j >= 0; j--) {
      const evt = events[j];
      if (evt && evt.type === "text" && evt.text.trim()) {
        finalMessage = evt.text.trim();
        break;
      }
    }
  }

  return { requestText, finalMessage };
}

export type FileChange = {
  path: string;
  edits: number;
};

const FILE_PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath"] as const;

function extractFilePath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  for (const key of FILE_PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Derive a per-file change summary from the transcript events already streamed
 * into session state. This is deliberately a touched-file list: tool snippets
 * are not a diff and must not be presented as authoritative +/- line counts.
 */
export function deriveSessionChanges(promptOrder: string[], transcripts: Map<string, ActivityEvent[]>): FileChange[] {
  const byPath = new Map<string, FileChange>();

  const ensure = (path: string): FileChange => {
    let entry = byPath.get(path);
    if (!entry) {
      entry = { path, edits: 0 };
      byPath.set(path, entry);
    }
    return entry;
  };

  for (const promptId of promptOrder) {
    const events = transcripts.get(promptId);
    if (!events) continue;
    for (const evt of events) {
      if (evt.type === "tool_call" && isFileChangeTool(evt.tool)) {
        const path = extractFilePath(evt.input);
        if (!path) continue;
        const entry = ensure(path);
        entry.edits += 1;
      } else if (evt.type === "patch") {
        for (const file of evt.files) {
          if (typeof file === "string" && file.trim()) ensure(file.trim()).edits += 1;
        }
      }
    }
  }

  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}
