import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import {
  type ParsedVerifierTerminalResult,
  parseVerifierTerminalResult,
} from "../../../../shared/agent/verification-result.js";
import {
  QA_RUNTIME_LEARNINGS_FENCE,
  QA_RUNTIME_LEARNINGS_MAX_ENTRIES,
} from "../../../../shared/constants/qa-runtime-memory.js";
import type { BridgeEvent } from "../../../../shared/events/bridge.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import {
  buildVerificationPhaseNoteRecord,
  buildVerificationPipelineInconclusiveResult,
  parseVerificationPhaseArtifactOutput,
  upsertVerificationPhaseArtifactRecord,
  VERIFICATION_ACCEPTABLE_EVIDENCE_TYPES,
  VERIFICATION_JUDGE_NEEDS_WORK_LABELS,
  VERIFICATION_JUDGE_PROOF_STATUSES,
  VERIFICATION_LAUNCH_AUTH_STATUSES,
  VERIFICATION_LAUNCH_ENVIRONMENT_KINDS,
  VERIFICATION_LAUNCH_PROOF_ASSESSMENT_STATUSES,
  VERIFICATION_LAUNCH_TARGET_SOURCE_REFS,
  VERIFICATION_OPERATED_PROOF_SOURCES,
  VERIFICATION_OPERATED_PROOF_STATUSES,
  VERIFICATION_OPERATOR_EVIDENCE_TYPES,
  VERIFICATION_READINESS_CHECK_KINDS,
  VERIFICATION_READINESS_CHECK_STATUSES,
  VERIFICATION_SCENARIO_STEP_STATUSES,
  VERIFICATION_SETUP_ATTEMPT_RESULTS,
  type VerificationPhaseArtifactRecord,
  type VerificationPhaseInvocation,
  type VerificationPhaseName,
  type VerificationPhaseSkipTerminal,
  type VerificationPipelineOutcome,
} from "../../../../shared/verification/phase-artifacts.js";
import {
  PERFORMANCE_COMPARISON_MATRIX_COLUMNS,
  PHASE_EVIDENCE_DIR,
  PHASE_NOTES_DIR,
  RECORDER_NO_ADD_CLAUSE,
  RUNTIME_EVIDENCE_DIR,
} from "../constants/bridge.js";

export type VerificationPhasePromptInput = {
  invocation: VerificationPhaseInvocation;
  priorArtifacts: VerificationPhaseArtifactRecord[];
  selectedRoute?: VerificationPhaseRoute;
  plannedPhases?: readonly VerificationPhaseName[];
  completedPhases?: readonly VerificationPhaseName[];
  plannerRecommendedSkip?: boolean;
  contextBundle?: string;
};

export type VerificationPhaseRoute = "planner-judge" | "full";

export type VerificationPlannerDecision = {
  output: string;
  selectedRoute: VerificationPhaseRoute;
  plannerRecommendedSkip: boolean;
  appRuntimeRequired: boolean;
};

export type VerificationPhaseDefinition = {
  phase: VerificationPhaseName;
  buildPrompt(input: VerificationPhasePromptInput): string;
};

/**
 * The planner is intentionally free-form, so runtime startup uses one explicit
 * decision line instead of guessing from broad words such as "browser" or
 * "runtime" elsewhere in its reasoning. Structured legacy planner artifacts
 * remain supported while the free-form pipeline rolls out the marker.
 */
export function plannerRequiresAppRuntime(output: string): boolean {
  const parsed = parseVerificationPhaseArtifactOutput(output);
  if (parsed.ok && parsed.artifact && typeof parsed.artifact === "object" && !Array.isArray(parsed.artifact)) {
    const appRuntime = (parsed.artifact as Record<string, unknown>).appRuntime;
    if (appRuntime && typeof appRuntime === "object" && !Array.isArray(appRuntime)) {
      const needed = (appRuntime as Record<string, unknown>).needed;
      if (typeof needed === "boolean") return needed;
    }
  }
  const marker = output.match(/^\s*App runtime:\s*(required|not-required)\s*\.?\s*$/im)?.[1]?.toLowerCase();
  return marker === "required";
}

type VerificationPhaseTelemetryLevel = "info" | "warn";

export type VerificationPhaseTelemetryEvent = Record<string, unknown> & {
  event:
    | "verification_phase.route_selected"
    | "verification_phase.phase_completed"
    | "verification_phase.phase_failed"
    | "verification_phase.judge_repair"
    | "verification_phase.skipped"
    | "verification_phase.pipeline_terminal";
  run_id: string;
  session_id: string;
  prompt_id: string;
  route: VerificationPhaseRoute;
  planned_phase_count: number;
  completed_phase_count: number;
  artifact_count: number;
  planner_recommended_skip: boolean;
};

const FULL_VERIFICATION_PHASE_SEQUENCE = [
  "verification-planner",
  "verification-launcher",
  "verification-operator",
  "verification-judge",
] as const satisfies readonly VerificationPhaseName[];

function phasesForRoute(route: VerificationPhaseRoute): VerificationPhaseName[] {
  if (route === "planner-judge") return ["verification-planner", "verification-judge"];
  return [...FULL_VERIFICATION_PHASE_SEQUENCE];
}

function allowedValues(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(", ");
}

const PRIOR_PHASE_HANDOFF_MAX_CHARS = 6_000;
const PRIOR_PHASE_FALLBACK_EXCERPT_CHARS = 1_500;
const NON_JUDGE_HANDOFF_FIELDS = [
  "Route impact:",
  "Required proof:",
  "Satisfied proof:",
  "Failed/blocked/missing proof:",
  "Evidence refs:",
  "Exact command/file refs:",
  "Runtime handles:",
  "Operated journey trace:",
  "Performance comparison:",
  "Blockers and attempts:",
  "Residual risks:",
] as const;

type EvidencePhase = "launcher" | "operator";
type NonJudgePhaseName = Exclude<VerificationPhaseName, "verification-judge">;

function capExcerpt(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  return `${output.slice(0, maxChars)}\n[excerpt truncated]`;
}

function extractHandoffSectionWithMetadata(output: string): {
  text: string;
  truncated: boolean;
  contentChars: number;
} | null {
  const handoffMatch = /^##\s+Handoff\s*$/im.exec(output);
  if (!handoffMatch || handoffMatch.index === undefined) return null;
  const start = handoffMatch.index;
  const rest = output.slice(start);
  const nextHeadingMatch = /\n##\s+(?!Handoff\s*$).+/i.exec(rest.slice(handoffMatch[0].length));
  const handoff = (
    nextHeadingMatch ? rest.slice(0, handoffMatch[0].length + (nextHeadingMatch.index ?? 0)) : rest
  ).trim();
  return {
    text: capExcerpt(handoff, PRIOR_PHASE_HANDOFF_MAX_CHARS),
    truncated: handoff.length > PRIOR_PHASE_HANDOFF_MAX_CHARS,
    contentChars: Math.min(handoff.length, PRIOR_PHASE_HANDOFF_MAX_CHARS),
  };
}

function extractHandoffSection(output: string): string | null {
  return extractHandoffSectionWithMetadata(output)?.text ?? null;
}

function phaseOutputTelemetry(phase: VerificationPhaseName, rawOutput: string, output: string) {
  const handoff = extractHandoffSectionWithMetadata(output);
  const rawHandoff = extractHandoffSectionWithMetadata(rawOutput);
  const handoffTruncated =
    handoff !== null && (handoff.truncated || (rawHandoff !== null && rawHandoff.text !== handoff.text));
  const fallbackExcerptUsed = phase !== "verification-judge" && handoff === null;
  return {
    raw_output_chars: rawOutput.length,
    capped_output_chars: output.length,
    handoff_present: handoff !== null,
    handoff_truncated: handoffTruncated,
    fallback_excerpt_used: fallbackExcerptUsed,
    handoff_chars: handoff?.contentChars ?? 0,
    fallback_excerpt_chars: fallbackExcerptUsed ? Math.min(output.length, PRIOR_PHASE_FALLBACK_EXCERPT_CHARS) : 0,
  };
}

function formatPriorPhaseNotes(records: readonly VerificationPhaseArtifactRecord[]): string {
  if (records.length === 0) return "No prior phase notes.";
  return records
    .map((record) => {
      const output = record.note?.output ?? JSON.stringify(record.artifact);
      const handoff = extractHandoffSection(output);
      const excerpt = handoff
        ? handoff
        : [
            "### Fallback excerpt",
            "No `## Handoff` section was found; using a bounded excerpt.",
            "",
            capExcerpt(output, PRIOR_PHASE_FALLBACK_EXCERPT_CHARS),
          ].join("\n");
      return [`## ${record.phase}`, `Attempt: ${record.attempt}`, "", excerpt].join("\n");
    })
    .join("\n\n");
}

function formatRouteContext(input: VerificationPhasePromptInput): string[] {
  if (!input.selectedRoute && !input.plannedPhases?.length && !input.completedPhases?.length) return [];
  const plannedPhases = input.plannedPhases?.length ? input.plannedPhases : FULL_VERIFICATION_PHASE_SEQUENCE;
  const omittedPhases = FULL_VERIFICATION_PHASE_SEQUENCE.filter((phase) => !plannedPhases.includes(phase));
  return [
    "# Route context",
    `Selected route: ${input.selectedRoute ?? "full"}`,
    `Planned phase sequence: ${plannedPhases.join(" -> ")}`,
    `Completed phases: ${input.completedPhases?.length ? input.completedPhases.join(" -> ") : "none"}`,
    `Omitted phases: ${omittedPhases.length ? omittedPhases.join(" -> ") : "none"}`,
    `Planner recommended skip: ${input.plannerRecommendedSkip ? "yes" : "no"}`,
  ];
}

function freeFormReturnInstruction(phase: VerificationPhaseName): string {
  if (phase === "verification-judge") {
    return "Return exactly one terminal fenced JSON block: `cycloid-verification-result` for QA testing, or `verification-skipped` when no QA result should be published.";
  }
  const evidencePhase: EvidencePhase = phase === "verification-launcher" ? "launcher" : "operator";
  const preambleInstruction =
    phase === "verification-planner"
      ? "Keep anything above it brief and limited to evidence pointers."
      : `Keep anything above it brief and limited to evidence pointers or the optional \`${QA_RUNTIME_LEARNINGS_FENCE}\` block required elsewhere in this prompt.`;
  const bulkEvidenceInstruction =
    phase === "verification-planner"
      ? "Do not include bulk evidence in the note."
      : `Put bulk logs and supporting evidence in files under \`${PHASE_EVIDENCE_DIR}/${evidencePhase}/\`.`;
  return `Make the required \`## Handoff\` section your primary deliverable. ${preambleInstruction} ${bulkEvidenceInstruction}`;
}

function qaOnlySafetyInstruction(): string {
  return "Use QA only when local or sandbox evidence cannot prove the selected route; do not escalate to QA just because risk is high. Never create or enqueue Cycloid sessions from within QA (for example `cycloid sessions create`, raw `/api/sessions`, or `cycloid.spawn_child_session`) unless the verifier already has an authenticated, programmatic transcript/state read path for them; otherwise use direct local/sandbox proof or report a verification-gap blocker.";
}

function phaseEvidenceInstruction(phase: EvidencePhase): string[] {
  const lines = [
    "# Evidence files",
    "",
    `Evidence files: put raw/supporting evidence under \`${PHASE_EVIDENCE_DIR}/${phase}/\`. Phase notes are internal handoff/debug files under \`${PHASE_NOTES_DIR}/\`.`,
  ];
  if (phase === "operator") {
    lines.push(
      "For command output evidence, preserve the exact output block that proves the failure, quoted verbatim, plus the exact relevant passing summary block, command invocation metadata, and raw-log refs when available.",
      `Write concise artifacts that should appear in the managed QA comment directly under \`${RUNTIME_EVIDENCE_DIR}/\`. Keep raw/debug/intermediate files under \`${PHASE_EVIDENCE_DIR}/${phase}/\`.`,
      "A successful desktop.screenshot proof capture and desktop.record_stop automatically stage their screenshot/WebM artifacts for publication.",
      `For concise non-desktop evidence left under \`${PHASE_EVIDENCE_DIR}/${phase}/\`, the judge can select it through \`publishableEvidence\` for safe promotion into \`${RUNTIME_EVIDENCE_DIR}/\`.`,
    );
  }
  return lines;
}

function judgeEvidenceInstruction(): string[] {
  return [
    "# Evidence files",
    "",
    `The runner uploads every safe, supported artifact already staged under \`${RUNTIME_EVIDENCE_DIR}/\`, including desktop screenshots and completed recordings.`,
    `Use \`publishableEvidence\` only to select additional concise evidence under \`${PHASE_EVIDENCE_DIR}/\` that should be safely promoted. Automatically staged desktop evidence does not need to be enumerated and remains publishable when additional evidence is selected.`,
    `Leave raw/debug/intermediate files in \`${PHASE_EVIDENCE_DIR}/\`.`,
    `Do not treat \`${PHASE_NOTES_DIR}/\` files as PR comment evidence; they are internal debugging and handoff context.`,
  ];
}

function qaRuntimeLearningsInstruction(): string[] {
  return [
    "# QA runtime learnings",
    "",
    `When this run surfaced durable, repo-general runtime setup knowledge (startup commands, env vars, ready checks, seed/reset behavior, ports, auth quirks) that future QA runs on this repo would otherwise rediscover, emit one fenced \`${QA_RUNTIME_LEARNINGS_FENCE}\` JSON block just before the \`## Handoff\` section: an array of at most ${QA_RUNTIME_LEARNINGS_MAX_ENTRIES} objects with fields \`kind\` (\`gotcha\` or \`procedure\`), \`claim\` (one sentence), \`detail\` (exact steps or failure mode), \`evidence\` (what proved it this run), and optional \`supersedesMemoryIds\` (ids from the \`# QA runtime memory\` section this run proved wrong or obsolete).`,
    "Only report learnings that hold for the repo regardless of this PR and are not already covered by the injected `# QA runtime memory` section. Omit the block entirely when there is nothing new.",
  ];
}

function handoffInstruction(phase: NonJudgePhaseName): string[] {
  return [
    "# Handoff contract",
    "",
    `The handoff is required and is the primary deliverable for ${phase}. End the note with this exact section and use \`N/A\` for fields that do not apply.`,
    "## Handoff",
    ...NON_JUDGE_HANDOFF_FIELDS,
  ];
}

function writePhaseNoteFile(input: {
  phaseNotesDir: string;
  phase: VerificationPhaseName;
  output: string;
  createdAt: string;
}): void {
  mkdirSync(input.phaseNotesDir, { recursive: true });
  writeFileSync(
    join(input.phaseNotesDir, `${input.phase}.md`),
    [`# ${input.phase}`, "", `Created: ${input.createdAt}`, "", input.output].join("\n"),
    "utf8",
  );
}

export type VerificationPhaseInvoke = (input: {
  invocation: VerificationPhaseInvocation;
  prompt: string;
}) => Promise<string>;

export class VerificationPhaseTimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutKind = "phase-timeout",
  ) {
    super(message);
    this.name = "VerificationPhaseTimeoutError";
  }
}

export class VerificationPhaseArtifactStore {
  private records: VerificationPhaseArtifactRecord[] = [];

  all(): VerificationPhaseArtifactRecord[] {
    return [...this.records];
  }

  write(record: VerificationPhaseArtifactRecord): VerificationPhaseArtifactRecord[] {
    this.records = upsertVerificationPhaseArtifactRecord(this.records, record);
    return this.all();
  }
}

export function buildVerificationPlannerPrompt(input: VerificationPhasePromptInput): string {
  return [
    `Verification phase: ${input.invocation.phase}`,
    `Verification run: ${input.invocation.runId}`,
    `Target PR: ${input.invocation.targetPrUrl}`,
    `Target head SHA: ${input.invocation.headSha}`,
    ...formatRouteContext(input),
    "",
    "You are the Phase 1 QA planner. Decide whether QA testing should run, what user scenario or downstream workflow changed, whether runtime evidence is needed, and the proof contract later phases must satisfy.",
    "",
    "Do not start app/runtime services, browsers, sandboxes, dev servers, tests, or external side effects in this phase. Inspect only the bounded context supplied here and any already-available diff/file evidence in that context.",
    "",
    "Remote GitHub CI/check-run state is outside the verification proof contract. Do not require CI status, do not wait for remote checks, and do not treat pending, failed, cancelled, missing, or successful remote CI/check state as proof or as a blocker. If later phases need command evidence, require a local/sandbox command run instead.",
    "",
    "Start with acceptance criteria and QA scenarios, not evidence taxonomy: who is the actor, what flow changed, what should now work, what should not regress, and what would a human QA tester do to prove it works or fails.",
    "",
    "Be claim-oriented, not classification-oriented. Required proof must be stated as claims that scenario execution can satisfy or refute. Do not emit broad labels as proof.",
    "",
    "Recommend `Decision: skip verification` only when concrete changed_file, diff, or check evidence proves the PR has no behavior, runtime, auth, session, sandbox, config, dependency, prompt/agent, or side-effect risk. This is advisory; the judge makes the terminal skipped decision.",
    "",
    "Default to requiring behavior proof for feature additions and bug fixes. Static tests can reduce risk but should not remove the need for runtime, API, CLI, library, data-path, or user-path proof when the PR changes behavior a user or downstream system can trigger, observe, or depend on.",
    "",
    "Mark runtime or user-path proof as required when changed files, parent prompts, repo docs, app runtime config, route names, or PR discussion show user-visible/app behavior, session/runtime behavior, auth/settings behavior, PR publication workflow, sandbox/session workflow, API/runtime behavior, or any behavior a user or downstream system can trigger. Do not choose `planner-judge` for those cases unless the bounded context already contains direct runtime/user-path evidence for the exact changed behavior and no launcher/operator work would add confidence.",
    "",
    "For bug fixes, prefer before/after proof when feasible: reproduce or document the broken path on the previous state, then show the fixed behavior on the PR head. Do not make base reproduction a hard prerequisite for QA testing. If before evidence may be difficult, still require PR-head proof of the fixed behavior.",
    "",
    `For performance improvement PRs, require comparative proof for the same changed happy path or representative workload on base and PR head. The proof contract must name the metric, acceptable measurement method, base/head targets, and a required markdown matrix with columns ${PERFORMANCE_COMPARISON_MATRIX_COLUMNS}; \`Result\` must call out improved, regressed, unchanged, or blocked. Do not accept PR-head-only timing as proof of a performance improvement.`,
    "",
    "For feature additions, require PR-head happy-path proof through the changed surface: app/browser when the feature can be exercised in a runnable app, otherwise API, CLI, library, data-path, or focused command proof.",
    "",
    "App/browser runtime can be skipped when the repo or change has no runnable app path. Behavior proof is still required through the relevant non-app surface unless the change is clearly non-behavioral: docs, comments, tests-only, dead-code cleanup, formatting, type-only refactors, or isolated internal code with no product path.",
    "",
    "If QA testing should run, write the required proof as clear claims tied to concrete scenario steps, and note whether app runtime, API/runtime, CLI/library, data-path, auth, browser, sandbox/session, side-effect, before/after evidence, or performance comparison evidence may be needed.",
    "",
    "State the app-runtime decision on its own exact line: `App runtime: required` only when the launcher should boot the declared preview app, otherwise `App runtime: not-required`. Do not use `required` merely for CLI, library, data-path, API-only, or static proof.",
    "",
    "Choose the QA route and state it in plain text, for example `Route: full`. Use `planner-judge` when the bounded context already proves merge readiness or no further proof is needed. Use `full` when runtime, user-path, API, CLI, library, data-path, or additional check evidence would materially change confidence. When the route is ambiguous, choose `full`.",
    "",
    qaOnlySafetyInstruction(),
    "",
    `Use only these exact acceptableEvidenceTypes values: ${allowedValues(VERIFICATION_ACCEPTABLE_EVIDENCE_TYPES)}.`,
    "",
    "# Checklist",
    "- Acceptance criteria / user scenarios: actor, changed flow, expected result, and failure/regression case when cheap.",
    "- Decision: run or skip, with concrete evidence.",
    "- Route: planner-judge or full; default full when uncertain.",
    "- Required proof: claim, why required, acceptable evidence, and scenario steps when app runtime, API, CLI, library, data-path, or user-path proof is needed.",
    "- Runtime need: whether app runtime, API/runtime, CLI/library, data-path, auth, browser, sandbox/session, side-effect, before/after proof, or performance comparison proof is needed and why.",
    "- App runtime marker: exactly `App runtime: required` or `App runtime: not-required`.",
    "- Performance comparison: for performance PRs, metric, happy path/workload, before/after measurement method, expected improvement, and regression checks.",
    "- Narrow route handoff: for planner-judge, state the selected route, intentionally skipped phases, why they are skipped, evidence available, and evidence explicitly not required.",
    "- Residual risks: non-blocking uncertainty to preserve for later phases.",
    "",
    "For skip, write `Decision: skip verification`, choose `Route: planner-judge`, and cite the concrete evidence. Do not present planner skip as terminal. Never recommend skip when runtime, user-path, API, CLI, library, data-path, or side-effect behavior proof may be required.",
    "",
    "# Prior phase handoffs",
    formatPriorPhaseNotes(input.priorArtifacts),
    ...(input.contextBundle ? ["", "# Context bundle", input.contextBundle] : []),
    "",
    ...handoffInstruction("verification-planner"),
    "",
    freeFormReturnInstruction("verification-planner"),
  ].join("\n");
}

export function buildVerificationLauncherPrompt(input: VerificationPhasePromptInput): string {
  return [
    `Verification phase: ${input.invocation.phase}`,
    `Verification run: ${input.invocation.runId}`,
    `Target PR: ${input.invocation.targetPrUrl}`,
    `Target head SHA: ${input.invocation.headSha}`,
    ...formatRouteContext(input),
    "",
    "You are the Phase 2 QA launcher. Turn the effective proof contract into ready-to-use runtime contexts and concrete scenario handles for the operator.",
    "",
    "This is the first phase allowed to start app/runtime/auth/browser/sandbox/tunnel setup. The planner may request runtime proof, but it must not start runtime.",
    "",
    "Your scope is readiness only: prepare handles, authenticate or prove public access, poll health, record setup attempts, and report setup blockers. Do not test product behavior, reproduce the final bug outcome, edit tracked files, repair code, commit, push, submit, or open PRs.",
    "",
    "Prepare launch targets from structured proof scenarios. Include actor/precondition support, entry URL or API entrypoint, auth state, seed/reset steps, base/head targets when useful, scenario step IDs when feasible, and operator entry notes specific enough that the operator can continue without rediscovering URLs, auth state, runtime IDs, sandbox IDs, session IDs, or data setup.",
    "",
    "For bug-fix proof, prepare both base and PR-head targets when feasible. If base setup fails, is stale, or appears to point at the wrong checkout, record that blocker and still prepare the PR-head target. Do not let base setup failure prevent head runtime setup.",
    "",
    "For performance improvement proof, prepare comparable base and PR-head targets for the same happy path or representative workload. Keep data set, auth state, runtime mode, command flags, warmup/repeat count, and environment as comparable as the repo allows; if any axis differs, record it as comparison caveat or blocker. Do not prepare only the PR-head target for a claimed performance improvement unless base is unavailable after concrete attempts.",
    "",
    "When runtime is needed, assume a usable authenticated environment is required unless the proof target is genuinely public. `authenticated` auth requires a non-secret evidenceRef. Use `blocked` only after concrete attempts.",
    "",
    "If prior notes describe a feature addition, bug fix, auth/session/runtime behavior, workflow change, UI change, or user-facing behavior that needs app/runtime proof, prepare runtime even if the planner did not explicitly request it.",
    "",
    "If the selected route, planner handoff, parent prompts, changed files, repo docs, or app runtime context conflict, use the stricter effective proof contract. When any of those inputs show runtime/user-path proof is required, prepare runtime or record the concrete setup blocker; do not preserve a planner-judge shortcut by omission.",
    "",
    "Treat missing proof-route instructions for behavioral changes as a gap to resolve, not as permission to skip behavior proof.",
    "",
    qaOnlySafetyInstruction(),
    "",
    ...phaseEvidenceInstruction("launcher"),
    "",
    `Store runtime setup, readiness, auth, health, seed, or session-state diagnostics under \`${PHASE_EVIDENCE_DIR}/launcher/\`.`,
    "",
    `Use only these exact launchTargets[].sourceRef values: ${allowedValues(VERIFICATION_LAUNCH_TARGET_SOURCE_REFS)}.`,
    `Use only these exact launchTargets[].environment.kind values: ${allowedValues(VERIFICATION_LAUNCH_ENVIRONMENT_KINDS)}.`,
    `Use only these exact readiness.checks[].kind values: ${allowedValues(VERIFICATION_READINESS_CHECK_KINDS)}.`,
    `Use only these exact readiness.checks[].status values: ${allowedValues(VERIFICATION_READINESS_CHECK_STATUSES)}.`,
    `Use only these exact auth.status values: ${allowedValues(VERIFICATION_LAUNCH_AUTH_STATUSES)}.`,
    `Use only these exact setupAttempts[].result values: ${allowedValues(VERIFICATION_SETUP_ATTEMPT_RESULTS)}.`,
    `Use only these exact proofAssessments[].status values: ${allowedValues(VERIFICATION_LAUNCH_PROOF_ASSESSMENT_STATUSES)}.`,
    "",
    ...qaRuntimeLearningsInstruction(),
    "",
    "# Prior phase handoffs",
    formatPriorPhaseNotes(input.priorArtifacts),
    ...(input.contextBundle ? ["", "# Context bundle", input.contextBundle] : []),
    "",
    "# Checklist",
    "- Runtime need: whether prior notes require app runtime, API/runtime, CLI/library, data-path, auth, browser, sandbox/session, or side-effect setup.",
    "- Scenario handles: actor, entry URL or API entrypoint, auth state, seed/reset steps, and preconditions.",
    "- Launch targets: base/head/source, URL/API URL, auth state, runtime IDs, sandbox IDs, and session IDs.",
    "- Readiness: health/auth/seed/session checks, statuses, evidence refs, and exact attempts.",
    "- Base handling: base blocker if unavailable, while still preparing PR-head when feasible.",
    "- Performance comparison setup: base/head target parity, metric command or happy-path steps, repeat/warmup plan, and caveats.",
    "- Operator entry: precise handles and steps needed to continue.",
    "- Blockers: setup/auth/readiness blockers and attempts.",
    "",
    ...handoffInstruction("verification-launcher"),
    "",
    freeFormReturnInstruction("verification-launcher"),
  ].join("\n");
}

export function buildVerificationOperatorPrompt(input: VerificationPhasePromptInput): string {
  return [
    `Verification phase: ${input.invocation.phase}`,
    `Verification run: ${input.invocation.runId}`,
    `Target PR: ${input.invocation.targetPrUrl}`,
    `Target head SHA: ${input.invocation.headSha}`,
    ...formatRouteContext(input),
    "",
    "You are the Phase 3 QA operator. Use launcher-provided handles to execute the planned scenario first, then record direct runtime, user-path, system-path, sandbox/session, side-effect, or API evidence for what happened.",
    "",
    "Be scenario-first: perform the changed happy path through the relevant surface. When cheap and safe, also try one failure, edge, permission, empty-state, or regression case that a human QA tester would naturally check. Use API responses, logs, database reads, focused tests, and shell commands as support or fallback, not as substitutes for an operable app user journey.",
    "",
    "# Computer-use operating interface",
    "",
    "Default to operating the app through the desktop/VNC first-party tools when a proof involves user-visible behavior in a runnable app. Use `desktop.observe` to inspect the current display. Pass launcher-provided operator-entry or runtime HTTP(S) URLs through the `url` field of `desktop.open_app`; it resolves Chromium and opens a ready-to-use, focused browser window. Use `desktop.click`/`desktop.type`/`desktop.hotkey`/`desktop.scroll`/`desktop.drag` to operate like a user, reserve `desktop.focus_window` for switching among already-open windows, and use `desktop.screenshot` after meaningful state changes.",
    "",
    "Do not substitute legacy browser automation or raw browser-control screenshots for runnable user-visible desktop proof. If the desktop tools are unavailable or insufficient, the blocker must name the failed desktop attempts.",
    "",
    "For operated UI flows, interactions, animations, or state transitions where video materially strengthens proof, use `desktop.record_start` before the changed interaction and `desktop.record_stop` after the changed state is visible. Start recording only after setup, login, auth entry, token entry, and unrelated navigation are complete.",
    "",
    "The desktop tools are first-party QA instrumentation, not customer-repo dependencies. Never add desktop/VNC/recording tooling to the customer repository, package manifests, lockfiles, scripts, dev dependencies, Dockerfiles, or install commands.",
    RECORDER_NO_ADD_CLAUSE,
    "",
    "If the desktop tools fail or are not useful for the proof, first record the exact unavailable tool and failure, then use the strongest fallback against the same launcher-provided URL/auth state. Do not replace an operable desktop user path with `curl`, direct database reads, logs, or API-only checks just because they are easier.",
    "",
    "Treat APIs, logs, database reads, shell commands, and session/sandbox state as supporting or fallback evidence for user-visible proof. Use them as the primary route only when the app path cannot be operated after concrete attempts, or when the proof target is explicitly non-visual/system/API behavior.",
    "",
    "For each operated proof, record a user-like action trace: actor, starting URL, auth context, preconditions or seed/reset state, actions taken, visible observations, waits/retries, and evidence refs created after the interaction. The trace should let the judge see that the operator used the product rather than only inspected internals.",
    "",
    "For UI/app proofs, capture a concise screenshot trail through the operated path so a reviewer can see how you reached the verified state without needing parent-session context. Screenshots are mandatory for changed frontend screens and states. Recordings are mandatory for changed frontend interactions and operated flows. After setup/auth/unrelated navigation is complete, take screenshots at the flow entry point, after each meaningful navigation or state transition, and at the final changed or verified state.",
    "",
    "Name path screenshots in sequence with the scenario and step they prove, such as `checkout-01-cart.png`, `checkout-02-shipping-selected.png`, and `checkout-03-confirmation.png`, then reference them in evidenceRefs. Avoid flooding duplicates, and do not publish screenshots of secret entry, auth token entry, login/setup-only pages, or unrelated pages.",
    "",
    "Use launch targets, operator-entry URLs, auth/readiness notes, runtime IDs, sandbox IDs, session IDs, and base/head contexts from the launcher handoff. Do not rediscover startup details or broadly relaunch the environment. Light recovery is allowed only for reload, provided auth refresh, or a narrow health re-check; record failed recovery as a blocker.",
    "",
    "Execute required runtime, API, CLI, library, user, and system paths from structured proof scenarios. Page load, login, or health alone is not behavior proof unless the proof is explicitly runtime-readiness and the launcher did not already satisfy it.",
    "",
    "If the effective proof contract requires runtime or user-path evidence and you cannot gather it after concrete attempts, record the missing operated proof as `Failed/blocked/missing proof:` and as a blocker in the handoff. Do not substitute static review, generic screenshots, API/log/database reads, or passing commands for an operable runtime/user journey when the app path is required and runnable.",
    "",
    "Record evidence for the judge; do not decide the terminal verdict in this operator phase. The Phase 4 judge must still return CONCLUSIVE or INCONCLUSIVE after reviewing your evidence. Do not treat screenshots as proof unless they show the changed behavior. Prefer API responses, logs, session events, sandbox state, database reads, or concrete side effects for non-visual claims.",
    "",
    "If the PR changes behavior that a user can see or perform inside the app, capture visual evidence of the changed happy path or changed state. Screenshots must show the actual changed behavior, not generic app load, login, or unrelated pages. If the PR has no user-visible app behavior change, use command, API, log, or session evidence instead.",
    "",
    "For user-visible proofs, capture post-interaction `desktop.screenshot` evidence whenever the operated app reaches the changed state. Add one short `desktop.record_start`/`desktop.record_stop` walkthrough for changed frontend interactions, operated flows, animations, or state transitions when video materially improves proof. Video is additive evidence, not a substitute for screenshots, tests, logs, API responses, data-path proof, or other evidence the changed surface requires. Name artifacts for the scenario and state they prove, then reference them in evidenceRefs.",
    "",
    "If a user-visible behavior changed but cannot be captured visually, explain why and provide stronger alternate evidence such as API responses, session events, runtime logs, or focused command output.",
    "",
    "For feature additions, exercise the happy path through the relevant changed surface and capture evidence. Use the running app when the feature has an app path; otherwise use API, CLI, library, data-path, or focused command proof. Before/after evidence is preferred for bug fixes when feasible, but always collect available PR-head proof. If base or previous-state runtime is unavailable, invalid, stale, or blocked, record the exact blocker and continue with the PR-head proof path.",
    "",
    `For performance improvement PRs, run the same changed happy path or representative workload against both base and PR-head targets when launcher provides them. Capture comparable measurements, raw output refs, environment caveats, and a markdown matrix with columns ${PERFORMANCE_COMPARISON_MATRIX_COLUMNS}; \`Result\` must call out improved, regressed, unchanged, or blocked. Preserve the matrix in the \`Performance comparison:\` handoff field. Do not report a performance win from a PR-head-only run.`,
    "",
    "Do not stop evidence collection because before evidence is unavailable. Missing base evidence is judge context, not a reason to skip head proof.",
    "",
    `When the PR-head changed behavior can be shown in the app, capture desktop screenshots and, where useful, desktop walkthrough video of the changed happy path, fixed state, or changed interaction, likely first under \`${PHASE_EVIDENCE_DIR}/operator/\` or the desktop tool evidence path. Prefer capturing visual evidence over omitting it when the behavior is user-visible in a runnable app. For non-app changes, capture the strongest command, API, log, session, data, or test evidence instead.`,
    "",
    qaOnlySafetyInstruction(),
    "",
    ...phaseEvidenceInstruction("operator"),
    "",
    "For before/after bug proof, use the same flow for base and head contexts when launcher provides both. Record separate base and head evidence refs. If before evidence is unavailable after concrete attempts, preserve the base blocker, then continue with available PR-head proof instead of faking or skipping it.",
    "",
    "You may add proof only when runtime observation reveals a necessary missing claim for the original behavior. Operator proof amendments are required proof for the judge, must cite runtime evidence, and should be attempted immediately when possible.",
    "",
    "Never edit tracked source, update fixtures, accept generated source changes, commit, push, submit, create PRs, or repair implementation code. If tracked source or git state changes, report mutationGuard.mutatedTrackedSource and blockers.",
    "",
    `Use only these exact proofResults[].source values: ${allowedValues(VERIFICATION_OPERATED_PROOF_SOURCES)}.`,
    `Use only these exact proofResults[].status and proofAmendments[].status values: ${allowedValues(VERIFICATION_OPERATED_PROOF_STATUSES)}.`,
    `Use only these exact scenarioTrace[].status values: ${allowedValues(VERIFICATION_SCENARIO_STEP_STATUSES)}.`,
    `Use only these exact evidenceRefs[].type values: ${allowedValues(VERIFICATION_OPERATOR_EVIDENCE_TYPES)}.`,
    `Use only these exact proofAmendments[].proof.acceptableEvidenceTypes values: ${allowedValues(VERIFICATION_ACCEPTABLE_EVIDENCE_TYPES)}.`,
    "",
    ...qaRuntimeLearningsInstruction(),
    "",
    "# Prior phase handoffs",
    formatPriorPhaseNotes(input.priorArtifacts),
    ...(input.contextBundle ? ["", "# Context bundle", input.contextBundle] : []),
    "",
    "# Checklist",
    "- Scenario executed: actor, preconditions, entry point, changed happy path, and cheap failure/edge/regression case when attempted.",
    "- Paths exercised: scenario steps, user/system/API/runtime actions, and observed behavior.",
    "- PR-head proof: available happy-path, fixed-state, interaction, API, session, or runtime evidence.",
    "- Before/after proof: base evidence when feasible; otherwise exact base blocker plus head proof.",
    "- Performance comparison: before/after matrix for performance PRs, with improved and regressed rows called out.",
    "- Visual evidence: screenshots/videos when changed behavior can be shown in the app.",
    "- Proof status: satisfied, failed, blocked, missing, not-run, or amended.",
    "- Evidence refs: artifact paths, command output snippets, logs, events, screenshots, or recordings.",
    "- Mutation guard: tracked-source/git-state check and any blocker.",
    "",
    ...handoffInstruction("verification-operator"),
    "",
    freeFormReturnInstruction("verification-operator"),
  ].join("\n");
}

export function buildVerificationJudgePrompt(input: VerificationPhasePromptInput): string {
  return [
    `Verification phase: ${input.invocation.phase}`,
    `Verification run: ${input.invocation.runId}`,
    `Target PR: ${input.invocation.targetPrUrl}`,
    `Target head SHA: ${input.invocation.headSha}`,
    ...formatRouteContext(input),
    "",
    "You are the Phase 4 QA judge. Decide final QA testing outcome from the prior phase handoffs and bounded excerpts.",
    "",
    "The judge artifact is the only verdict authority. Do not emit a nested verifierResult. Do not run commands, launch apps, operate the browser, repair code, edit tracked source, commit, push, submit, or open PRs.",
    "",
    "CONCLUSIVE means exactly one thing: the requested behavior works. If you conclusively proved the behavior is broken, that is INCONCLUSIVE with needsWorkLabel=verification-gap and a blocker describing the proven failure - never CONCLUSIVE.",
    "",
    "Return CONCLUSIVE only when the prior notes show the requested behavior works from QA evidence: required proof is satisfied with useful direct evidence, no product/runtime/behavior blocker remains, and the verdict was computed against the target head SHA.",
    "",
    "First reconstruct the effective proof contract from the planner handoff, launcher handoff, operator handoff, route context, changed-file/parent-prompt context, repo runtime context, and any proof amendments. When those inputs imply runtime or user-path proof was required, require operated runtime/user-path evidence even if the selected route was `planner-judge` or the planner omitted the requirement.",
    "",
    "For UI/app behavior, reject CONCLUSIVE unless prior notes show an actual operated user journey: actor/auth context, entry point, actions taken, visible result, and changed-state evidence after the interaction. Static review, passing tests, API-only checks, or generic screenshots are not enough when a runnable app path exists.",
    "",
    "Return INCONCLUSIVE for missing, failed, blocked, contradicted, or too-weak proof. Use needsWorkLabel=verification-gap for every INCONCLUSIVE QA result.",
    "",
    "Explain which prior notes and evidence support the verdict. If proof is missing, failed, contradicted, or blocked, return INCONCLUSIVE with actionable blockers.",
    "",
    "Remote GitHub CI/check-run state is outside your scope. Do not use pending, failed, cancelled, missing, or successful remote CI/check state as evidence or as a blocker. Only judge local/sandbox commands that prior phases actually ran, plus direct runtime/API/CLI/library/data-path/user-path evidence.",
    "",
    "Do not accept static checks passed as sufficient for feature additions, bug fixes, auth/session/runtime changes, workflow changes, UI changes, CLI/library behavior, API behavior, or user-facing behavior.",
    "",
    "If those changes lack behavior proof through the relevant surface, return INCONCLUSIVE with a verification-gap blocker. App/browser proof may be absent when the repo or change has no runnable app path, but API, CLI, library, data-path, runtime, session, or focused command proof may still be required.",
    "",
    "Before/after evidence strengthens bug-fix QA testing but is not mandatory in every case. If base evidence is unavailable, evaluate the available PR-head evidence honestly.",
    "",
    "For performance improvement PRs, reject CONCLUSIVE unless prior notes include comparable base and PR-head measurements for the same changed happy path or representative workload, plus a markdown matrix with `Before PR` and `After PR` columns whose `Result` calls out improved, regressed, unchanged, or blocked. A PR-head-only run, generic benchmark claim, or unmatched base/head workload is INCONCLUSIVE with needsWorkLabel=verification-gap unless the PR discussion explicitly removed performance-proof requirements.",
    "",
    "Evaluate the route that actually ran. Do not penalize missing launcher/operator phases when the selected route was planner-judge and the prior evidence is sufficient for that route. If the selected route skipped behavior proof that the notes show was actually needed, return INCONCLUSIVE and explain the QA gap.",
    "",
    "Planner skip recommendations are advisory. You are the only phase allowed to convert them into terminal skipped QA. If a planner-judge route has a valid no-further-proof rationale, you may return a `verification-skipped` terminal block. If skipped behavior proof was actually required, return INCONCLUSIVE with needsWorkLabel `verification-gap`.",
    "",
    qaOnlySafetyInstruction(),
    "",
    ...judgeEvidenceInstruction(),
    "",
    "Be selective with text and log evidence. Prefer focused passing local/sandbox tests, typecheck/lint/build output when actually run by the verifier, runtime/API/session proof of changed behavior, and exact failing blocks for blockers.",
    "",
    "For operated UI/app flows, prefer a concise path sequence of screenshots that makes the operator journey understandable without parent-session context: flow entry, meaningful intermediate navigation or state transitions, and final changed or verified state. Capture enough screenshots to explain how the operator reached the result, while avoiding duplicate frames, auth/token entry, login/setup-only pages, and unrelated pages. For changed frontend screens/states, expect screenshots. For changed frontend interactions/flows, expect screenshots plus a recording.",
    "",
    "For operated UI/app flows, expect screenshots plus one short recording for changed frontend interactions, animations, multi-step flows, time-based UI behavior, or state transitions. Video is additive evidence; do not reject screenshot evidence merely because video exists, and do not treat video as permission to omit required screenshots, tests, logs, API responses, data-path proof, or command evidence.",
    "",
    "Missing video is a named evidence gap for interaction-heavy or time-based UI proof when no acceptable omission reason is documented. Acceptable omission reasons include no user-visible/app-operable surface, static visible state already proven by screenshots plus stronger evidence, runtime/desktop unavailable after concrete repair attempts, recording risk around secrets/OAuth/private customer data/destructive state, or desktop recording failure after a real attempt. Missing video is not an automatic failure for non-visual/API-only work.",
    "",
    `Do not publish recordings of setup, login, auth entry, token entry, or unrelated pages. Leave desktop recording manifests, debug logs, frame temp files, and storage-state details private in \`${PHASE_EVIDENCE_DIR}/operator/\` unless a specific concise file directly proves a merge-critical claim.`,
    "",
    "Include screenshots and videos when they directly show the changed happy path, fixed state, changed interaction, or useful before/after app behavior. For non-visual changes, prefer focused command output, API responses, logs, session events, data-path proof, or tests that directly support the claim.",
    "",
    "When the run verified a performance improvement, include the before/after matrix or a concise reference to it in `summary` or `evidence`; the operator should already have staged the supporting report/log under the runtime evidence directory.",
    "",
    `Keep generic setup/debug logs, long raw command outputs, and low-signal intermediate files in \`${PHASE_EVIDENCE_DIR}/\`.`,
    "",
    `The managed QA comment uses artifacts from \`${RUNTIME_EVIDENCE_DIR}/\`: screenshots/videos of changed happy paths when applicable, focused failing output blocks, focused passing proof summaries, API/CLI/library/session/runtime/data-path proof snippets, and judge summary/verdict evidence.`,
    "",
    `Use only these exact proof status words when discussing coverage: ${allowedValues(VERIFICATION_JUDGE_PROOF_STATUSES)}.`,
    `Use only these exact needsWorkLabel values on INCONCLUSIVE: ${allowedValues(VERIFICATION_JUDGE_NEEDS_WORK_LABELS)}.`,
    "",
    "# Prior phase handoffs",
    formatPriorPhaseNotes(input.priorArtifacts),
    ...(input.contextBundle ? ["", "# Context bundle", input.contextBundle] : []),
    "",
    "# Required terminal result shape",
    "For CONCLUSIVE or INCONCLUSIVE QA testing verdicts, return exactly one fenced `cycloid-verification-result` JSON block. Do not return prose outside the fenced block.",
    "A plain ```json fence is rejected; the fence tag must be `cycloid-verification-result`.",
    "```cycloid-verification-result",
    JSON.stringify({
      verdict: "CONCLUSIVE|INCONCLUSIVE",
      verifiedHeadSha: input.invocation.headSha,
      computedAgainstHeadSha: input.invocation.headSha,
      needsWorkLabel: "verification-gap",
      summary: "human-readable final verification summary",
      evidence: ["short evidence citation for final surface"],
      publishableEvidence: [
        {
          path: `${PHASE_EVIDENCE_DIR}/operator/focused-proof.log`,
          label: "focused-proof.log",
          reason: "Focused passing proof output",
        },
      ],
      blockers: ["actionable blocker for implementation or verification"],
    }),
    "```",
    "",
    "Omit `needsWorkLabel` and use an empty blockers array on CONCLUSIVE. Include at least one blocker for every unresolved proof on INCONCLUSIVE.",
    "",
    "# Required terminal skip shape",
    "Return this instead of `cycloid-verification-result` only when you decide verification should be terminally skipped:",
    "```verification-skipped",
    JSON.stringify({
      kind: "verification-skipped",
      headSha: input.invocation.headSha,
      summary: "Docs-only PR; no additional proof would add confidence.",
      evidence: ["Only README changed", "No runtime/config/source files changed"],
    }),
    "```",
    "",
    freeFormReturnInstruction("verification-judge"),
  ].join("\n");
}

export function buildVerificationPhaseInput(input: {
  invocation: VerificationPhaseInvocation;
  priorArtifacts: VerificationPhaseArtifactRecord[];
  selectedRoute?: VerificationPhaseRoute;
  plannedPhases?: readonly VerificationPhaseName[];
  completedPhases?: readonly VerificationPhaseName[];
  plannerRecommendedSkip?: boolean;
  contextBundle?: string;
}): VerificationPhasePromptInput {
  return {
    invocation: input.invocation,
    priorArtifacts: input.priorArtifacts,
    ...(input.selectedRoute ? { selectedRoute: input.selectedRoute } : {}),
    ...(input.plannedPhases ? { plannedPhases: input.plannedPhases } : {}),
    ...(input.completedPhases ? { completedPhases: input.completedPhases } : {}),
    ...(input.plannerRecommendedSkip !== undefined ? { plannerRecommendedSkip: input.plannerRecommendedSkip } : {}),
    ...(input.contextBundle ? { contextBundle: input.contextBundle } : {}),
  };
}

function countStringArrayField(value: unknown): number {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).length
    : 0;
}

function countVerificationEvidenceRefs(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const artifact = value as Record<string, unknown>;
  let count = countStringArrayField(artifact.evidenceRefs) + countStringArrayField(artifact.evidence);
  for (const collectionName of ["proofCoverage", "proofResults", "proofAssessments", "launchTargets"] as const) {
    const collection = artifact[collectionName];
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      count += countStringArrayField((entry as Record<string, unknown>).evidenceRefs);
      count += countStringArrayField((entry as Record<string, unknown>).evidenceRefIds);
    }
  }
  return count;
}

function countVerificationBlockers(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const blockers = (value as Record<string, unknown>).blockers;
  return Array.isArray(blockers) ? blockers.length : 0;
}

function countPublishableEvidenceRefs(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const refs = (value as Record<string, unknown>).publishableEvidence;
  return Array.isArray(refs) ? refs.length : 0;
}

export function buildVerificationPhaseArtifactEvent(input: {
  record: VerificationPhaseArtifactRecord;
  sandboxId: string;
  timestamp?: number;
}): Extract<BridgeEvent, { type: "verification_phase_artifact" }> {
  const computedAgainstHeadSha =
    typeof input.record.artifact.computedAgainstHeadSha === "string"
      ? input.record.artifact.computedAgainstHeadSha
      : undefined;
  return {
    type: "verification_phase_artifact",
    runId: input.record.runId,
    record: input.record,
    intermediate: true,
    verificationPhase: input.record.phase,
    artifactType: input.record.artifactType,
    attempt: input.record.attempt,
    validationStatus: "accepted",
    evidenceRefCount: countVerificationEvidenceRefs(input.record.artifact),
    blockerCount: countVerificationBlockers(input.record.artifact),
    ...(computedAgainstHeadSha ? { computedAgainstHeadSha } : {}),
    messageId: input.record.promptId,
    sandboxId: input.sandboxId,
    timestamp: input.timestamp ?? Date.now(),
  };
}

const MAX_PHASE_NOTE_CHARS = 120_000;

function capPhaseOutput(output: string): string {
  if (output.length <= MAX_PHASE_NOTE_CHARS) return output;
  return `${output.slice(0, MAX_PHASE_NOTE_CHARS)}\n[phase output truncated]`;
}

function plannerRecommendsSkip(output: string): boolean {
  return /\bDecision:\s*skip verification\b/i.test(output);
}

function plannerRequiresDownstreamProof(output: string): boolean {
  const normalized = output.toLowerCase();
  const outOfScopeRuntime =
    /\bruntime (?:evidence|proof|handles?) (?:is |are )?(?:explicitly )?(?:out of scope|not required|not needed|n\/a)\b/.test(
      normalized,
    ) || /\bno (?:runtime|user-path|behavior|behaviour) proof (?:is )?(?:required|needed)\b/.test(normalized);
  const requiredProofPattern =
    /\b(?:runtime|user-path|user path|app\/browser|browser|auth|session|sandbox|side-effect|api\/runtime|api|cli|library|data-path|behavior|behaviour) (?:proof|evidence|path|journey|flow|setup) (?:is |may be |was |must be )?(?:required|needed|necessary)\b/;
  const requiredFieldPattern =
    /\b(?:Required proof|Runtime need|Failed\/blocked\/missing proof):[^\n]*(?:runtime|user-path|user path|app\/browser|browser|auth|session|sandbox|side-effect|api\/runtime|api|cli|library|data-path|behavior|behaviour)/i;
  return (requiredProofPattern.test(normalized) || requiredFieldPattern.test(output)) && !outOfScopeRuntime;
}

export function inferRouteFromPlanner(output: string): VerificationPhaseRoute {
  if (plannerRequiresDownstreamProof(output)) return "full";
  if (/\bRoute:\s*planner-judge\b/i.test(output)) return "planner-judge";
  if (/\bRoute:\s*full\b/i.test(output)) return "full";

  const normalized = output.toLowerCase();
  if (/\bplanner\s*(?:->|to)\s*judge\b/.test(normalized)) return "planner-judge";
  if (/\bfull route\b|\bfull verification\b/.test(normalized)) return "full";
  return "full";
}

function summarizeMalformedJudgeOutput(output: string): string {
  return (
    output
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/```[\s\S]*?```/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join("\n")
      .slice(0, 1_000) || "Verification judge did not return a parseable terminal result."
  );
}

function malformedJudgeResult(output: string, headSha: string, error: string): ParsedVerifierTerminalResult {
  return {
    malformed: true,
    error,
    result: {
      verdict: "INCONCLUSIVE",
      verifiedHeadSha: headSha,
      needsWorkLabel: "verification-gap",
      summary: summarizeMalformedJudgeOutput(output),
      evidence: [],
      blockers: [`QA Tester output was malformed: ${error}`],
    },
  };
}

function parseJudgeTerminalResult(output: string, headSha: string): ParsedVerifierTerminalResult {
  if (!/```cycloid-verification-result\s*[\s\S]*?```/i.test(output)) {
    return malformedJudgeResult(output, headSha, "missing fenced cycloid-verification-result JSON block");
  }
  return parseVerifierTerminalResult(output, headSha);
}

type ParsedJudgeTerminalOutput =
  | { kind: "result"; parsed: ParsedVerifierTerminalResult }
  | { kind: "skip"; skip: VerificationPhaseSkipTerminal }
  | { kind: "malformed"; parsed: ParsedVerifierTerminalResult };

function parseJudgeSkipTerminal(output: string, fallbackHeadSha: string): VerificationPhaseSkipTerminal | null {
  const match = /```verification-skipped\s*([\s\S]*?)```/i.exec(output);
  const body = match?.[1]?.trim();
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== "verification-skipped") return null;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!summary) return null;
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
    : [];
  const headSha = typeof record.headSha === "string" && record.headSha.trim() ? record.headSha.trim() : fallbackHeadSha;
  return {
    reason: summary,
    evidence,
    ...(headSha ? { headSha } : {}),
  };
}

function parseJudgeTerminalOutput(output: string, headSha: string): ParsedJudgeTerminalOutput {
  const skip = parseJudgeSkipTerminal(output, headSha);
  if (skip) return { kind: "skip", skip };
  const parsed = parseJudgeTerminalResult(output, headSha);
  return parsed.malformed ? { kind: "malformed", parsed } : { kind: "result", parsed };
}

function formatJudgeRepairPrompt(input: {
  output: string;
  parseError: string;
  selectedRoute: VerificationPhaseRoute;
  plannedPhases: readonly VerificationPhaseName[];
  completedPhases: readonly VerificationPhaseName[];
  plannerRecommendedSkip: boolean;
  headSha: string;
}): string {
  const intentionallySkippedPhases = FULL_VERIFICATION_PHASE_SEQUENCE.filter(
    (phase) => !input.plannedPhases.includes(phase),
  );
  return [
    "Your prior verification judge response did not contain a parseable terminal result.",
    `Parse failure: ${input.parseError}`,
    "",
    "# Route summary",
    `Selected route: ${input.selectedRoute}`,
    `Planned phase sequence: ${input.plannedPhases.join(" -> ")}`,
    `Completed phases: ${input.completedPhases.length ? input.completedPhases.join(" -> ") : "none"}`,
    `Intentionally skipped phases: ${intentionallySkippedPhases.length ? intentionallySkippedPhases.join(" -> ") : "none"}`,
    `Planner recommended skip: ${input.plannerRecommendedSkip ? "yes" : "no"}`,
    "",
    "Evaluate the route that actually ran. Do not invent missing launcher/operator requirements when the selected route intentionally skipped them and the prior handoffs support judge-only verification. If the handoffs show behavior proof was actually needed, return INCONCLUSIVE with a verification-gap blocker.",
    "",
    "CONCLUSIVE means exactly one thing: the requested behavior works. If you conclusively proved the behavior is broken, that is INCONCLUSIVE with needsWorkLabel=verification-gap and a blocker describing the proven failure - never CONCLUSIVE.",
    "",
    "Remote GitHub CI/check-run state is outside your scope. Do not use it as evidence or as a blocker; work only from direct behavior evidence and local/sandbox commands prior phases actually ran.",
    "",
    "# Original judge output",
    capExcerpt(input.output, 8_000),
    "",
    "# Required response",
    "Return only one terminal fenced JSON block. Use `cycloid-verification-result` for CONCLUSIVE/INCONCLUSIVE, or `verification-skipped` when you decide verification should be terminally skipped. Do not include prose outside the fence.",
    "QA verification shape:",
    "```cycloid-verification-result",
    JSON.stringify({
      verdict: "CONCLUSIVE|INCONCLUSIVE",
      verifiedHeadSha: input.headSha,
      computedAgainstHeadSha: input.headSha,
      needsWorkLabel: "verification-gap",
      summary: "human-readable final verification summary",
      evidence: ["short evidence citation for final surface"],
      publishableEvidence: [
        {
          path: `${PHASE_EVIDENCE_DIR}/operator/focused-proof.log`,
          label: "focused-proof.log",
          reason: "Focused passing proof output",
        },
      ],
      blockers: ["actionable blocker for implementation or verification"],
    }),
    "```",
    "",
    "Skipped shape:",
    "```verification-skipped",
    JSON.stringify({
      kind: "verification-skipped",
      headSha: input.headSha,
      summary: "Docs-only PR; no additional proof would add confidence.",
      evidence: ["Only README changed", "No runtime/config/source files changed"],
    }),
    "```",
  ].join("\n");
}

export class VerificationPhaseRunner {
  constructor(
    private readonly input: {
      runId: string;
      sessionId: string;
      promptId: string;
      targetPrUrl: string;
      headSha: string;
      sandboxId: string;
      definitions: VerificationPhaseDefinition[];
      invokePhase: VerificationPhaseInvoke;
      sendEvent: (event: Extract<BridgeEvent, { type: "verification_phase_artifact" }>) => void;
      recordTelemetry?: (
        event: VerificationPhaseTelemetryEvent,
        message: string,
        level: VerificationPhaseTelemetryLevel,
      ) => void;
      onPlannerDecision?: (decision: VerificationPlannerDecision) => void | Promise<void>;
      contextBundle?: string;
      store?: VerificationPhaseArtifactStore;
      phaseNotesDir?: string;
    },
  ) {}

  async run(): Promise<VerificationPipelineOutcome> {
    const store = this.input.store ?? new VerificationPhaseArtifactStore();
    const definitions = new Map(this.input.definitions.map((definition) => [definition.phase, definition]));
    let selectedRoute: VerificationPhaseRoute = "full";
    let plannedPhases = phasesForRoute(selectedRoute);
    let plannerRecommendedSkip = false;

    for (let phaseIndex = 0; phaseIndex < plannedPhases.length; phaseIndex += 1) {
      const phase = plannedPhases[phaseIndex]!;
      if (store.all().some((record) => record.phase === phase)) continue;
      const definition = definitions.get(phase);
      if (!definition) {
        this.recordTelemetry(
          store,
          selectedRoute,
          plannedPhases,
          plannerRecommendedSkip,
          {
            event: "verification_phase.phase_failed",
            phase,
            attempt: 0,
            reason_code: "missing_definition",
          },
          `Verification phase ${phase} failed before dispatch`,
          "warn",
        );
        return this.inconclusive(store.all(), `Missing verification phase definition for ${phase}.`);
      }

      const invocation: VerificationPhaseInvocation = {
        runId: this.input.runId,
        phase,
        targetPrUrl: this.input.targetPrUrl,
        headSha: this.input.headSha,
        attempt: 0,
        inputArtifactRefs: store.all().map((record) => `${record.phase}:${record.attempt}`),
        ...(this.input.contextBundle ? { contextBundleRef: "inline-context-bundle" } : {}),
        outputFence: "free-form",
      };
      const prompt = definition.buildPrompt(
        buildVerificationPhaseInput({
          invocation,
          priorArtifacts: store.all(),
          selectedRoute,
          plannedPhases,
          completedPhases: store.all().map((record) => record.phase),
          plannerRecommendedSkip,
          contextBundle: this.input.contextBundle,
        }),
      );
      let rawOutput: string;
      try {
        rawOutput = await this.input.invokePhase({ invocation, prompt });
      } catch (error) {
        if (error instanceof VerificationPhaseTimeoutError) {
          this.recordTelemetry(
            store,
            selectedRoute,
            plannedPhases,
            plannerRecommendedSkip,
            {
              event: "verification_phase.phase_failed",
              phase,
              attempt: invocation.attempt,
              reason_code: "timeout",
              timeout_kind: error.timeoutKind,
              error: error.message,
            },
            `Verification phase ${phase} timed out`,
            "warn",
          );
          return this.inconclusive(
            store.all(),
            `Verification phase ${phase} timed out (${error.timeoutKind}): ${error.message}`,
          );
        }
        this.recordTelemetry(
          store,
          selectedRoute,
          plannedPhases,
          plannerRecommendedSkip,
          {
            event: "verification_phase.phase_failed",
            phase,
            attempt: invocation.attempt,
            reason_code: "invoke_failed",
            error: stringifyError(error),
          },
          `Verification phase ${phase} failed before producing notes`,
          "warn",
        );
        return this.inconclusive(
          store.all(),
          `Verification phase ${phase} failed before producing notes: ${stringifyError(error)}`,
        );
      }

      const output = capPhaseOutput(rawOutput);
      const createdAt = new Date().toISOString();
      const record = buildVerificationPhaseNoteRecord({
        runId: this.input.runId,
        sessionId: this.input.sessionId,
        promptId: this.input.promptId,
        phase,
        attempt: 0,
        targetPrUrl: this.input.targetPrUrl,
        headSha: this.input.headSha,
        output,
        createdAt,
      });
      writePhaseNoteFile({
        phaseNotesDir: this.input.phaseNotesDir ?? PHASE_NOTES_DIR,
        phase,
        output: record.note?.output ?? output,
        createdAt,
      });
      store.write(record);
      this.input.sendEvent(buildVerificationPhaseArtifactEvent({ record, sandboxId: this.input.sandboxId }));
      this.recordTelemetry(
        store,
        selectedRoute,
        plannedPhases,
        plannerRecommendedSkip,
        {
          event: "verification_phase.phase_completed",
          phase,
          attempt: invocation.attempt,
          artifact_type: record.artifactType,
          evidence_ref_count: countVerificationEvidenceRefs(record.artifact),
          blocker_count: countVerificationBlockers(record.artifact),
          ...phaseOutputTelemetry(phase, rawOutput, output),
        },
        `Verification phase ${phase} completed`,
        "info",
      );

      if (phase === "verification-planner") {
        const requiresDownstreamProof = plannerRequiresDownstreamProof(output);
        plannerRecommendedSkip = plannerRecommendsSkip(output) && !requiresDownstreamProof;
        selectedRoute = plannerRecommendedSkip ? "planner-judge" : inferRouteFromPlanner(output);
        plannedPhases = phasesForRoute(selectedRoute);
        this.recordTelemetry(
          store,
          selectedRoute,
          plannedPhases,
          plannerRecommendedSkip,
          {
            event: "verification_phase.route_selected",
            phase,
            selected_route: selectedRoute,
            skipped_phase_count: FULL_VERIFICATION_PHASE_SEQUENCE.filter(
              (candidate) => !plannedPhases.includes(candidate),
            ).length,
          },
          "Verification phase route selected",
          "info",
        );
        await this.input.onPlannerDecision?.({
          output,
          selectedRoute,
          plannerRecommendedSkip,
          appRuntimeRequired: !plannerRecommendedSkip && selectedRoute === "full" && plannerRequiresAppRuntime(output),
        });
      }
      if (phase === "verification-judge") {
        const parsed = parseJudgeTerminalOutput(output, this.input.headSha);
        if (parsed.kind === "result") {
          this.recordPipelineTerminal(
            store,
            selectedRoute,
            plannedPhases,
            plannerRecommendedSkip,
            "final",
            parsed.parsed.result,
          );
          return { kind: "final", result: parsed.parsed.result, artifacts: store.all() };
        }
        if (parsed.kind === "skip") {
          this.recordSkip(store, selectedRoute, plannedPhases, plannerRecommendedSkip, record, parsed.skip);
          return { kind: "skip", skipArtifact: record, skip: parsed.skip, artifacts: store.all() };
        }

        this.recordTelemetry(
          store,
          selectedRoute,
          plannedPhases,
          plannerRecommendedSkip,
          {
            event: "verification_phase.judge_repair",
            phase,
            attempt: 0,
            outcome: "attempted",
            reason_code: "malformed_output",
            parse_error: parsed.parsed.error ?? "missing_or_malformed_terminal_verdict",
          },
          "Verification judge repair requested",
          "warn",
        );
        const repairInvocation: VerificationPhaseInvocation = {
          ...invocation,
          attempt: 1,
          inputArtifactRefs: store.all().map((storedRecord) => `${storedRecord.phase}:${storedRecord.attempt}`),
          outputFence: "cycloid-verification-result",
        };
        const repairPrompt = formatJudgeRepairPrompt({
          output,
          parseError: parsed.parsed.error ?? "missing or malformed terminal verdict",
          selectedRoute,
          plannedPhases,
          completedPhases: store.all().map((storedRecord) => storedRecord.phase),
          plannerRecommendedSkip,
          headSha: this.input.headSha,
        });
        let rawRepairOutput: string;
        try {
          rawRepairOutput = await this.input.invokePhase({ invocation: repairInvocation, prompt: repairPrompt });
        } catch {
          this.recordTelemetry(
            store,
            selectedRoute,
            plannedPhases,
            plannerRecommendedSkip,
            {
              event: "verification_phase.judge_repair",
              phase,
              attempt: repairInvocation.attempt,
              outcome: "invoke_failed",
              reason_code: "invoke_failed",
            },
            "Verification judge repair failed before producing notes",
            "warn",
          );
          this.recordPipelineTerminal(
            store,
            selectedRoute,
            plannedPhases,
            plannerRecommendedSkip,
            "final",
            parsed.parsed.result,
          );
          return { kind: "final", result: parsed.parsed.result, artifacts: store.all() };
        }
        const repairOutput = capPhaseOutput(rawRepairOutput);

        const repairCreatedAt = new Date().toISOString();
        const repairRecord = buildVerificationPhaseNoteRecord({
          runId: this.input.runId,
          sessionId: this.input.sessionId,
          promptId: this.input.promptId,
          phase,
          attempt: 1,
          targetPrUrl: this.input.targetPrUrl,
          headSha: this.input.headSha,
          output: repairOutput,
          createdAt: repairCreatedAt,
        });
        writePhaseNoteFile({
          phaseNotesDir: this.input.phaseNotesDir ?? PHASE_NOTES_DIR,
          phase,
          output: repairRecord.note?.output ?? repairOutput,
          createdAt: repairCreatedAt,
        });
        store.write(repairRecord);
        this.input.sendEvent(
          buildVerificationPhaseArtifactEvent({ record: repairRecord, sandboxId: this.input.sandboxId }),
        );
        this.recordTelemetry(
          store,
          selectedRoute,
          plannedPhases,
          plannerRecommendedSkip,
          {
            event: "verification_phase.phase_completed",
            phase,
            attempt: repairInvocation.attempt,
            artifact_type: repairRecord.artifactType,
            evidence_ref_count: countVerificationEvidenceRefs(repairRecord.artifact),
            blocker_count: countVerificationBlockers(repairRecord.artifact),
            ...phaseOutputTelemetry(phase, rawRepairOutput, repairOutput),
          },
          `Verification phase ${phase} repair attempt completed`,
          "info",
        );

        const repaired = parseJudgeTerminalOutput(repairOutput, this.input.headSha);
        if (repaired.kind === "skip") {
          this.recordTelemetry(
            store,
            selectedRoute,
            plannedPhases,
            plannerRecommendedSkip,
            {
              event: "verification_phase.judge_repair",
              phase,
              attempt: repairInvocation.attempt,
              outcome: "succeeded_skip",
              reason_code: "none",
            },
            "Verification judge repair succeeded with skip",
            "info",
          );
          this.recordSkip(store, selectedRoute, plannedPhases, plannerRecommendedSkip, repairRecord, repaired.skip);
          return { kind: "skip", skipArtifact: repairRecord, skip: repaired.skip, artifacts: store.all() };
        }
        if (repaired.kind === "result") {
          this.recordTelemetry(
            store,
            selectedRoute,
            plannedPhases,
            plannerRecommendedSkip,
            {
              event: "verification_phase.judge_repair",
              phase,
              attempt: repairInvocation.attempt,
              outcome: "succeeded_result",
              reason_code: "none",
            },
            "Verification judge repair succeeded with terminal result",
            "info",
          );
          this.recordPipelineTerminal(
            store,
            selectedRoute,
            plannedPhases,
            plannerRecommendedSkip,
            "final",
            repaired.parsed.result,
          );
          return { kind: "final", result: repaired.parsed.result, artifacts: store.all() };
        }
        this.recordTelemetry(
          store,
          selectedRoute,
          plannedPhases,
          plannerRecommendedSkip,
          {
            event: "verification_phase.judge_repair",
            phase,
            attempt: repairInvocation.attempt,
            outcome: "malformed",
            reason_code: "malformed_output",
            parse_error: repaired.parsed.error ?? "missing_or_malformed_terminal_verdict",
          },
          "Verification judge repair remained malformed",
          "warn",
        );
        this.recordPipelineTerminal(
          store,
          selectedRoute,
          plannedPhases,
          plannerRecommendedSkip,
          "final",
          repaired.parsed.result,
        );
        return { kind: "final", result: repaired.parsed.result, artifacts: store.all() };
      }
    }

    this.recordTelemetry(
      store,
      selectedRoute,
      plannedPhases,
      plannerRecommendedSkip,
      {
        event: "verification_phase.pipeline_terminal",
        terminal_kind: "inconclusive",
        reason_code: "missing_judge_verdict",
      },
      "Verification phase pipeline ended without a judge verdict",
      "warn",
    );
    return this.inconclusive(store.all(), "Verification phase pipeline ended without a judge verdict.");
  }

  private inconclusive(
    artifacts: VerificationPhaseArtifactRecord[],
    blocker: string,
  ): Extract<VerificationPipelineOutcome, { kind: "inconclusive" }> {
    return {
      kind: "inconclusive",
      result: buildVerificationPipelineInconclusiveResult({
        headSha: this.input.headSha,
        summary: "Verification phase pipeline could not produce a final judge verdict.",
        blocker,
      }),
      artifacts,
    };
  }

  private recordSkip(
    store: VerificationPhaseArtifactStore,
    selectedRoute: VerificationPhaseRoute,
    plannedPhases: readonly VerificationPhaseName[],
    plannerRecommendedSkip: boolean,
    record: VerificationPhaseArtifactRecord,
    skip: VerificationPhaseSkipTerminal,
  ): void {
    this.recordTelemetry(
      store,
      selectedRoute,
      plannedPhases,
      plannerRecommendedSkip,
      {
        event: "verification_phase.skipped",
        phase: record.phase,
        attempt: record.attempt,
        evidence_count: skip.evidence.length,
        has_head_sha: Boolean(skip.headSha),
      },
      "Verification phase pipeline returned a skipped terminal",
      "info",
    );
    this.recordPipelineTerminal(store, selectedRoute, plannedPhases, plannerRecommendedSkip, "skip", {
      verdict: "SKIPPED",
      evidence: skip.evidence,
      blockers: [],
    });
  }

  private recordPipelineTerminal(
    store: VerificationPhaseArtifactStore,
    selectedRoute: VerificationPhaseRoute,
    plannedPhases: readonly VerificationPhaseName[],
    plannerRecommendedSkip: boolean,
    terminalKind: "final" | "skip" | "inconclusive",
    result: unknown,
  ): void {
    const record =
      result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
    this.recordTelemetry(
      store,
      selectedRoute,
      plannedPhases,
      plannerRecommendedSkip,
      {
        event: "verification_phase.pipeline_terminal",
        terminal_kind: terminalKind,
        verdict: typeof record.verdict === "string" ? record.verdict : "unknown",
        needs_work_label: typeof record.needsWorkLabel === "string" ? record.needsWorkLabel : "none",
        evidence_count: countStringArrayField(record.evidence),
        blocker_count: countVerificationBlockers(record),
        publishable_evidence_count: countPublishableEvidenceRefs(record),
      },
      "Verification phase pipeline reached a terminal outcome",
      terminalKind === "final" || terminalKind === "skip" ? "info" : "warn",
    );
  }

  private recordTelemetry(
    store: VerificationPhaseArtifactStore,
    selectedRoute: VerificationPhaseRoute,
    plannedPhases: readonly VerificationPhaseName[],
    plannerRecommendedSkip: boolean,
    event: Omit<
      VerificationPhaseTelemetryEvent,
      | "run_id"
      | "session_id"
      | "prompt_id"
      | "route"
      | "planned_phase_count"
      | "completed_phase_count"
      | "artifact_count"
      | "planner_recommended_skip"
    >,
    message: string,
    level: VerificationPhaseTelemetryLevel,
  ): void {
    this.input.recordTelemetry?.(
      {
        ...event,
        run_id: this.input.runId,
        session_id: this.input.sessionId,
        prompt_id: this.input.promptId,
        route: selectedRoute,
        planned_phase_count: plannedPhases.length,
        completed_phase_count: store.all().length,
        artifact_count: store.all().length,
        planner_recommended_skip: plannerRecommendedSkip,
      } as VerificationPhaseTelemetryEvent,
      message,
      level,
    );
  }
}
