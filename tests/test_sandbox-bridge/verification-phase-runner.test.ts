import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import {
  buildVerificationJudgePrompt,
  buildVerificationLauncherPrompt,
  buildVerificationOperatorPrompt,
  buildVerificationPlannerPrompt,
  plannerRequiresAppRuntime,
  type VerificationPhaseDefinition,
  type VerificationPhaseInvoke,
  VerificationPhaseRunner,
  VerificationPhaseTimeoutError,
} from "../../apps/sandbox-bridge/src/services/verification-phase-runner";
import { QA_RUNTIME_LEARNINGS_FENCE } from "../../shared/constants/qa-runtime-memory";
import { VERIFICATION_PHASE_NAMES, type VerificationPhaseName } from "../../shared/verification/phase-artifacts";

const TARGET_PR_URL = "https://github.com/acme/repo/pull/1";
const HEAD_SHA = "abc123";
const HANDOFF_FIELDS = [
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

function definitions(): VerificationPhaseDefinition[] {
  return VERIFICATION_PHASE_NAMES.map((phase) => ({
    phase,
    buildPrompt:
      phase === "verification-planner"
        ? buildVerificationPlannerPrompt
        : phase === "verification-launcher"
          ? buildVerificationLauncherPrompt
          : phase === "verification-operator"
            ? buildVerificationOperatorPrompt
            : buildVerificationJudgePrompt,
  }));
}

function terminalJson(verdict: "CONCLUSIVE" | "INCONCLUSIVE", extra: Record<string, unknown> = {}): string {
  return [
    "```cycloid-verification-result",
    JSON.stringify({
      verdict,
      verifiedHeadSha: HEAD_SHA,
      summary: verdict === "CONCLUSIVE" ? "Ready to merge." : "Not ready to merge.",
      evidence: verdict === "CONCLUSIVE" ? ["operator evidence"] : [],
      blockers: verdict === "INCONCLUSIVE" ? ["operator blocker"] : [],
      ...extra,
    }),
    "```",
  ].join("\n");
}

function terminalSkip(summary = "Docs-only PR; no verification evidence would add confidence."): string {
  return [
    "```verification-skipped",
    JSON.stringify({
      kind: "verification-skipped",
      headSha: HEAD_SHA,
      summary,
      evidence: ["Only README changed", "No runtime/config/source files changed"],
    }),
    "```",
  ].join("\n");
}

function handoff(overrides: Partial<Record<(typeof HANDOFF_FIELDS)[number], string>> = {}): string {
  return ["## Handoff", ...HANDOFF_FIELDS.map((field) => `${field} ${overrides[field] ?? "N/A"}`)].join("\n");
}

function expectHandoffContract(prompt: string): void {
  expect(prompt).toContain("# Handoff contract");
  expect(prompt).toContain("The handoff is required and is the primary deliverable");
  expect(prompt).toContain("## Handoff");
  expect(prompt).toContain("Make the required `## Handoff` section your primary deliverable");
  expect(prompt).toContain("Keep anything above it brief and limited to evidence pointers");
  for (const field of HANDOFF_FIELDS) {
    expect(prompt).toContain(field);
  }
}

type PhaseOutput = string | Error | readonly (string | Error)[];

function runnerFor(
  outputs: Partial<Record<VerificationPhaseName, PhaseOutput>>,
  options: { phaseNotesDir?: string; onPlannerDecision?: (decision: unknown) => void } = {},
) {
  const sentEvents: unknown[] = [];
  const telemetryEvents: Array<Record<string, unknown> & { message: string; level: string }> = [];
  const calls: Array<{ phase: VerificationPhaseName; prompt: string; attempt: number }> = [];
  const invokePhase: VerificationPhaseInvoke = vi.fn(async ({ invocation, prompt }) => {
    calls.push({ phase: invocation.phase, prompt, attempt: invocation.attempt });
    const value = outputs[invocation.phase];
    if (value === undefined) throw new Error(`missing output for ${invocation.phase}`);
    const attemptValue = Array.isArray(value) ? (value[invocation.attempt] ?? value.at(-1)) : value;
    if (attemptValue instanceof Error) throw attemptValue;
    if (attemptValue === undefined)
      throw new Error(`missing output for ${invocation.phase} attempt ${invocation.attempt}`);
    return attemptValue;
  });
  const runner = new VerificationPhaseRunner({
    runId: "run-1",
    sessionId: "s-1",
    promptId: "p-1",
    targetPrUrl: TARGET_PR_URL,
    headSha: HEAD_SHA,
    sandboxId: "sbx-1",
    definitions: definitions(),
    invokePhase,
    sendEvent: (event) => sentEvents.push(event),
    recordTelemetry: (event, message, level) => telemetryEvents.push({ ...event, message, level }),
    contextBundle: "bounded context only",
    ...(options.onPlannerDecision ? { onPlannerDecision: options.onPlannerDecision } : {}),
    ...(options.phaseNotesDir ? { phaseNotesDir: options.phaseNotesDir } : {}),
  });
  return { runner, sentEvents, telemetryEvents, calls, invokePhase };
}

describe("VerificationPhaseRunner raw-note harness", () => {
  it("starts managed app runtime only from the planner's explicit marker", async () => {
    const decisions: unknown[] = [];
    const { runner } = runnerFor(
      {
        "verification-planner": "Route: full\nApp runtime: required",
        "verification-launcher": "Launcher note: app ready.",
        "verification-operator": "Operator note: path exercised.",
        "verification-judge": terminalJson("CONCLUSIVE"),
      },
      { onPlannerDecision: (decision) => decisions.push(decision) },
    );

    await runner.run();

    expect(decisions).toContainEqual(expect.objectContaining({ appRuntimeRequired: true, selectedRoute: "full" }));
    expect(plannerRequiresAppRuntime("App runtime: not-required\nruntime tests are needed")).toBe(false);
  });
  it("accepts free-form planner, launcher, and operator notes and passes them to judge", async () => {
    const { runner, calls, sentEvents, telemetryEvents } = runnerFor({
      "verification-planner": "Planner note: verify the changed billing flow. unique-planner-note",
      "verification-launcher": "Launcher note: app is running at http://127.0.0.1:5173. unique-launcher-note",
      "verification-operator": "Operator note: user completed the billing flow. unique-operator-note",
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    const outcome = await runner.run();

    expect(outcome).toMatchObject({
      kind: "final",
      result: { verdict: "CONCLUSIVE", evidence: ["operator evidence"], blockers: [] },
    });
    expect(calls.map((call) => call.phase)).toEqual([...VERIFICATION_PHASE_NAMES]);
    const judgePrompt = calls.find((call) => call.phase === "verification-judge")?.prompt ?? "";
    expect(judgePrompt).toContain("unique-planner-note");
    expect(judgePrompt).toContain("unique-launcher-note");
    expect(judgePrompt).toContain("unique-operator-note");
    expect(outcome.artifacts.every((record) => record.note?.output)).toBe(true);
    expect(sentEvents).toHaveLength(4);
    expect(telemetryEvents.filter((event) => event.event === "verification_phase.phase_completed")).toHaveLength(4);
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.route_selected",
        route: "full",
        selected_route: "full",
        planner_recommended_skip: false,
      }),
    );
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.pipeline_terminal",
        terminal_kind: "final",
        verdict: "CONCLUSIVE",
        evidence_count: 1,
      }),
    );
  });

  it("passes handoff sections instead of full raw notes to later phases", async () => {
    const { runner, calls, telemetryEvents } = runnerFor({
      "verification-planner": [
        "Planner note summary.",
        handoff({
          "Route impact:": "full route needed.",
          "Required proof:": "prove billing happy path.",
          "Evidence refs:": "/tmp/phase-evidence/planner/context.txt",
        }),
        "## Raw Logs",
        "do-not-pass-planner-raw-log-tail",
      ].join("\n"),
      "verification-launcher": handoff({
        "Runtime handles:": "head web http://127.0.0.1:5173.",
      }),
      "verification-operator": handoff({
        "Satisfied proof:": "billing happy path observed.",
      }),
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    await runner.run();

    const launcherPrompt = calls.find((call) => call.phase === "verification-launcher")?.prompt ?? "";
    expect(launcherPrompt).toContain("Route impact: full route needed.");
    expect(launcherPrompt).toContain("Required proof: prove billing happy path.");
    expect(launcherPrompt).not.toContain("do-not-pass-planner-raw-log-tail");
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.phase_completed",
        phase: "verification-planner",
        raw_output_chars: expect.any(Number),
        capped_output_chars: expect.any(Number),
        handoff_present: true,
        handoff_truncated: false,
        fallback_excerpt_used: false,
        handoff_chars: expect.any(Number),
        fallback_excerpt_chars: 0,
      }),
    );
  });

  it("falls back to a bounded excerpt when a phase omits the handoff section", async () => {
    const longPlannerNote = `fallback-start ${"x".repeat(2_000)} fallback-tail`;
    const { runner, calls, telemetryEvents } = runnerFor({
      "verification-planner": longPlannerNote,
      "verification-launcher": "Launcher note.",
      "verification-operator": "Operator note.",
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    await runner.run();

    const launcherPrompt = calls.find((call) => call.phase === "verification-launcher")?.prompt ?? "";
    expect(launcherPrompt).toContain("No `## Handoff` section was found");
    expect(launcherPrompt).toContain("fallback-start");
    expect(launcherPrompt).not.toContain("fallback-tail");
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.phase_completed",
        phase: "verification-planner",
        handoff_present: false,
        fallback_excerpt_used: true,
        handoff_chars: 0,
        fallback_excerpt_chars: 1_500,
      }),
    );
  });

  it("reports when a handoff exceeds the forwarding cap", async () => {
    const { runner, telemetryEvents } = runnerFor({
      "verification-planner": handoff({ "Required proof:": "x".repeat(7_000) }),
      "verification-launcher": handoff(),
      "verification-operator": handoff(),
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    await runner.run();

    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.phase_completed",
        phase: "verification-planner",
        handoff_present: true,
        handoff_truncated: true,
        fallback_excerpt_used: false,
        handoff_chars: 6_000,
      }),
    );
  });

  it("does not infer handoff truncation from model-authored sentinel text", async () => {
    const { runner, telemetryEvents } = runnerFor({
      "verification-planner": "## Handoff\n[excerpt truncated]",
      "verification-launcher": handoff(),
      "verification-operator": handoff(),
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    await runner.run();

    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.phase_completed",
        phase: "verification-planner",
        handoff_present: true,
        handoff_truncated: false,
      }),
    );
  });

  it("reports when the phase-output cap cuts a handoff", async () => {
    const { runner, telemetryEvents } = runnerFor({
      "verification-planner": `${"x".repeat(119_980)}\n## Handoff\nRequired proof: complete`,
      "verification-launcher": handoff(),
      "verification-operator": handoff(),
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    await runner.run();

    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.phase_completed",
        phase: "verification-planner",
        handoff_present: true,
        handoff_truncated: true,
      }),
    );
  });

  it("planner route planner-judge skips launcher and operator", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner": "Planner note: no additional checks would help.\nRoute: planner-judge",
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    const outcome = await runner.run();

    expect(outcome.kind).toBe("final");
    expect(calls.map((call) => call.phase)).toEqual(["verification-planner", "verification-judge"]);
    const judgePrompt = calls.find((call) => call.phase === "verification-judge")?.prompt ?? "";
    expect(judgePrompt).toContain("Selected route: planner-judge");
    expect(judgePrompt).toContain("Planned phase sequence: verification-planner -> verification-judge");
  });

  it("planner-judge route with valid static no-runtime rationale can be CONCLUSIVE", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner": [
        "Planner note: static evidence is sufficient for judge-only verification.",
        "Route: planner-judge",
        handoff({
          "Route impact:":
            "Selected route planner-judge; intentionally skipped verification-launcher and verification-operator because no additional checks or runtime proof add confidence.",
          "Required proof:": "Confirm changed files are release note text only.",
          "Satisfied proof:": "Context shows only README.md release note text changed.",
          "Failed/blocked/missing proof:": "N/A.",
          "Evidence refs:": "changed_file: README.md.",
          "Runtime handles:": "N/A; runtime evidence explicitly out of scope for this route.",
        }),
      ].join("\n"),
      "verification-judge": terminalJson("CONCLUSIVE", {
        evidence: ["Planner handoff shows only docs/readme.md changed."],
      }),
    });

    const outcome = await runner.run();

    expect(outcome.kind).toBe("final");
    expect(outcome.result.verdict).toBe("CONCLUSIVE");
    expect(calls.map((call) => call.phase)).toEqual(["verification-planner", "verification-judge"]);
    const judgePrompt = calls.find((call) => call.phase === "verification-judge")?.prompt ?? "";
    expect(judgePrompt).toContain("Selected route: planner-judge");
    expect(judgePrompt).toContain("intentionally skipped verification-launcher");
    expect(judgePrompt).toContain("runtime evidence explicitly out of scope");
  });

  it("upgrades planner-judge to full when the planner requires runtime proof", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner": [
        "Planner note: settings UI behavior changed.",
        "Decision: skip verification",
        "Route: planner-judge",
        handoff({
          "Route impact:":
            "Planner suggested planner-judge, but the changed settings UI requires app/browser runtime proof.",
          "Required proof:": "runtime proof required for the settings save user path.",
          "Failed/blocked/missing proof:": "runtime/user-path proof has not been gathered yet.",
        }),
      ].join("\n"),
      "verification-launcher": handoff({
        "Runtime handles:": "head web http://127.0.0.1:5173.",
      }),
      "verification-operator": handoff({
        "Satisfied proof:": "settings save user path passed.",
        "Operated journey trace:": "Actor opened /settings, clicked Save, and observed Saved.",
        "Evidence refs:": "/tmp/phase-evidence/operator/settings-save.png.",
      }),
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    const outcome = await runner.run();

    expect(outcome.kind).toBe("final");
    expect(calls.map((call) => call.phase)).toEqual([...VERIFICATION_PHASE_NAMES]);
    const launcherPrompt = calls.find((call) => call.phase === "verification-launcher")?.prompt ?? "";
    expect(launcherPrompt).toContain("Selected route: full");
    expect(launcherPrompt).toContain("Planner recommended skip: no");
    expect(launcherPrompt).toContain("runtime proof required for the settings save user path");
  });

  it("planner route full runs all phases", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner": "Planner note: behavior changed.\nRoute: full",
      "verification-launcher": "Launcher note: runtime ready.",
      "verification-operator": "Operator note: happy path passed.",
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    const outcome = await runner.run();

    expect(outcome.kind).toBe("final");
    expect(calls.map((call) => call.phase)).toEqual([...VERIFICATION_PHASE_NAMES]);
  });

  it("routes planner-judge shorthand and full route variants", async () => {
    const plannerToJudge = runnerFor({
      "verification-planner": "Planner note: use planner -> judge because no extra proof adds confidence.",
      "verification-judge": terminalJson("CONCLUSIVE"),
    });
    const fullRoute = runnerFor({
      "verification-planner": "Planner note: use the full route.",
      "verification-launcher": "Launcher note.",
      "verification-operator": "Operator note.",
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    await plannerToJudge.runner.run();
    await fullRoute.runner.run();

    expect(plannerToJudge.calls.map((call) => call.phase)).toEqual(["verification-planner", "verification-judge"]);
    expect(fullRoute.calls.map((call) => call.phase)).toEqual([...VERIFICATION_PHASE_NAMES]);
  });

  it("unrecognized route text defaults to the full route", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner": "Planner note: expected lightweight proof.",
      "verification-launcher": "Launcher note: auth runtime ready.",
      "verification-operator": "Operator note: auth path verified.",
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    const outcome = await runner.run();

    expect(outcome.kind).toBe("final");
    expect(calls.map((call) => call.phase)).toEqual([...VERIFICATION_PHASE_NAMES]);
    const launcherPrompt = calls.find((call) => call.phase === "verification-launcher")?.prompt ?? "";
    expect(launcherPrompt).toContain("Selected route: full");
  });

  it("judge prompt receives handoff details needed for proof assessment", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner": handoff({
        "Required proof:": "proof-1 requires runtime happy path.",
        "Route impact:": "full.",
      }),
      "verification-launcher": handoff({
        "Runtime handles:": "head web http://127.0.0.1:5173, session s-123.",
        "Blockers and attempts:": "base runtime unavailable after checkout health check.",
      }),
      "verification-operator": handoff({
        "Satisfied proof:": "head happy path passed.",
        "Evidence refs:": "/tmp/phase-evidence/operator/head-fixed-state.png.",
        "Exact command/file refs:": "screenshot file and session event event-1.",
        "Operated journey trace:": "Actor tester opened /settings, clicked Save, and observed Saved.",
      }),
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    await runner.run();

    const judgePrompt = calls.find((call) => call.phase === "verification-judge")?.prompt ?? "";
    expect(judgePrompt).toContain("Required proof: proof-1 requires runtime happy path.");
    expect(judgePrompt).toContain("Evidence refs: /tmp/phase-evidence/operator/head-fixed-state.png.");
    expect(judgePrompt).toContain("Operated journey trace: Actor tester opened /settings");
    expect(judgePrompt).toContain("Runtime handles: head web http://127.0.0.1:5173, session s-123.");
    expect(judgePrompt).toContain("Blockers and attempts: base runtime unavailable");
  });

  it("continues to operator and judge when base runtime setup fails but head proof is available", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner":
        "Planner note: bug fix should prefer before/after runtime proof, but head proof is required.",
      "verification-launcher":
        "Launcher note: base runtime failed because checkout was stale. PR-head runtime is ready at http://127.0.0.1:5173.",
      "verification-operator":
        "Operator note: PR-head fixed state captured at /tmp/phase-evidence/operator/head-fixed-state.png.",
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    const outcome = await runner.run();

    expect(outcome.kind).toBe("final");
    expect(calls.map((call) => call.phase)).toEqual([...VERIFICATION_PHASE_NAMES]);
    const operatorPrompt = calls.find((call) => call.phase === "verification-operator")?.prompt ?? "";
    expect(operatorPrompt).toContain("base runtime failed because checkout was stale");
    expect(operatorPrompt).toContain("PR-head runtime is ready");
    const judgePrompt = calls.find((call) => call.phase === "verification-judge")?.prompt ?? "";
    expect(judgePrompt).toContain("/tmp/phase-evidence/operator/head-fixed-state.png");
  });

  it("writes phase notes under the phase notes directory, separate from PR evidence", async () => {
    const phaseNotesDir = mkdtempSync(join(tmpdir(), "verification-phase-notes-"));
    try {
      const { runner } = runnerFor(
        {
          "verification-planner": [
            "Planner note: verify user-visible settings change.",
            handoff({ "Required proof:": "settings change works." }),
            "## Raw debug",
            "full-raw-note-tail-stays-persisted",
          ].join("\n"),
          "verification-launcher": "Launcher note: app ready.",
          "verification-operator": "Operator note: screenshot saved under /tmp/phase-evidence/operator/settings.png.",
          "verification-judge": terminalJson("CONCLUSIVE"),
        },
        { phaseNotesDir },
      );

      const outcome = await runner.run();

      expect(outcome.kind).toBe("final");
      for (const phase of VERIFICATION_PHASE_NAMES) {
        const notePath = join(phaseNotesDir, `${phase}.md`);
        expect(existsSync(notePath)).toBe(true);
        expect(readFileSync(notePath, "utf8")).toContain(`# ${phase}`);
      }
      expect(readFileSync(join(phaseNotesDir, "verification-planner.md"), "utf8")).toContain(
        "full-raw-note-tail-stays-persisted",
      );
    } finally {
      rmSync(phaseNotesDir, { recursive: true, force: true });
    }
  });

  it("keeps evidence-directory ownership in the judge prompt", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner": "Planner note: verification should run.",
      "verification-launcher": "Launcher note: app ready.",
      "verification-operator": "Operator note: visual evidence saved.",
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    await runner.run();

    const plannerPrompt = calls.find((call) => call.phase === "verification-planner")?.prompt ?? "";
    expect(plannerPrompt).toContain("what user scenario or downstream workflow changed");
    expect(plannerPrompt).toContain("Start with acceptance criteria and QA scenarios, not evidence taxonomy");
    expect(plannerPrompt).toContain("who is the actor, what flow changed");
    expect(plannerPrompt).toContain("what would a human QA tester do to prove it works or fails");
    expect(plannerPrompt).toContain("Default to requiring behavior proof for feature additions and bug fixes");
    expect(plannerPrompt).toContain("Mark runtime or user-path proof as required");
    expect(plannerPrompt).toContain("Do not choose `planner-judge` for those cases");
    expect(plannerPrompt).toContain("Remote GitHub CI/check-run state is outside the verification proof contract");
    expect(plannerPrompt).not.toContain("CI config");
    expect(plannerPrompt).toContain("runtime, API, CLI, library, data-path, or user-path proof");
    expect(plannerPrompt).toContain("For bug fixes, prefer before/after proof when feasible");
    expect(plannerPrompt).toContain("Do not make base reproduction a hard prerequisite");
    expect(plannerPrompt).toContain("still require PR-head proof of the fixed behavior");
    expect(plannerPrompt).toContain(
      "For feature additions, require PR-head happy-path proof through the changed surface",
    );
    expect(plannerPrompt).toContain(
      "App/browser runtime can be skipped when the repo or change has no runnable app path",
    );
    expect(plannerPrompt).toContain("Choose the QA route");
    expect(plannerPrompt).toContain("Route: full");
    expect(plannerPrompt).toContain(
      "Use `full` when runtime, user-path, API, CLI, library, data-path, or additional check evidence would materially change confidence",
    );
    expect(plannerPrompt).toContain("When the route is ambiguous, choose `full`");
    expect(plannerPrompt).toContain("Never create or enqueue Cycloid sessions from within QA");
    expect(plannerPrompt).toContain("cycloid.spawn_child_session");
    expect(plannerPrompt).toContain("Narrow route handoff");
    expect(plannerPrompt).toContain("Acceptance criteria / user scenarios");
    expect(plannerPrompt).toContain("failure/regression case when cheap");
    expect(plannerPrompt).toContain("intentionally skipped phases");
    expect(plannerPrompt).toContain("evidence explicitly not required");
    expect(plannerPrompt).toContain("Never recommend skip when runtime, user-path, API, CLI, library, data-path");
    expect(plannerPrompt).not.toContain("/tmp/phase-evidence/");
    expect(plannerPrompt).not.toContain("/tmp/cycloid-evidence/");
    expect(plannerPrompt).toContain("Do not include bulk evidence in the note");
    expect(plannerPrompt).not.toContain("# Suggested note structure");
    expect(plannerPrompt).not.toContain("VerificationPlannerArtifact");
    expectHandoffContract(plannerPrompt);

    const launcherPrompt = calls.find((call) => call.phase === "verification-launcher")?.prompt ?? "";
    expect(launcherPrompt).toContain("concrete scenario handles");
    expect(launcherPrompt).toContain("entry URL or API entrypoint");
    expect(launcherPrompt).toContain("seed/reset steps");
    expect(launcherPrompt).toContain("base/head targets when useful");
    expect(launcherPrompt).toContain("Scenario handles: actor");
    expect(launcherPrompt).toContain("prepare runtime even if the planner did not explicitly request it");
    expect(launcherPrompt).toContain("use the stricter effective proof contract");
    expect(launcherPrompt).toContain("do not preserve a planner-judge shortcut by omission");
    expect(launcherPrompt).toContain(
      "Treat missing proof-route instructions for behavioral changes as a gap to resolve",
    );
    expect(launcherPrompt).toContain("If base setup fails, is stale, or appears to point at the wrong checkout");
    expect(launcherPrompt).toContain("Do not let base setup failure prevent head runtime setup");
    expect(launcherPrompt).toContain("/tmp/phase-evidence/launcher/");
    expect(launcherPrompt).toContain(
      "Put bulk logs and supporting evidence in files under `/tmp/phase-evidence/launcher/`",
    );
    expect(launcherPrompt).toContain("optional `cycloid-qa-runtime-learnings` block");
    expect(launcherPrompt).toContain("/tmp/phase-notes/");
    expect(launcherPrompt).not.toContain("/tmp/cycloid-evidence/");
    expect(launcherPrompt).not.toContain("# Suggested note structure");
    expect(launcherPrompt).not.toContain("VerificationLauncherArtifact");
    expectHandoffContract(launcherPrompt);

    const operatorPrompt = calls.find((call) => call.phase === "verification-operator")?.prompt ?? "";
    expect(operatorPrompt).toContain("execute the planned scenario first");
    expect(operatorPrompt).toContain("Be scenario-first");
    expect(operatorPrompt).toContain("perform the changed happy path");
    expect(operatorPrompt).toContain("try one failure, edge, permission, empty-state, or regression case");
    expect(operatorPrompt).toContain("as support or fallback, not as substitutes for an operable app user journey");
    expect(operatorPrompt).toContain("# Computer-use operating interface");
    expect(operatorPrompt).toContain("through the `url` field of `desktop.open_app`");
    expect(operatorPrompt).toContain("Default to operating the app through the desktop/VNC first-party tools");
    expect(operatorPrompt).toContain("Use `desktop.observe` to inspect the current display");
    expect(operatorPrompt).toContain("`desktop.click`/`desktop.type`/`desktop.hotkey`");
    expect(operatorPrompt).toContain("Do not substitute legacy browser automation or raw browser-control screenshots");
    expect(operatorPrompt).toContain("the blocker must name the failed desktop attempts");
    expect(operatorPrompt).toContain("use `desktop.record_start` before the changed interaction");
    expect(operatorPrompt).toContain("`desktop.record_stop` after the changed state is visible");
    expect(operatorPrompt).toContain("Never add desktop/VNC/recording tooling to the customer repository");
    expect(operatorPrompt).toContain("capture post-interaction `desktop.screenshot` evidence whenever");
    expect(operatorPrompt).toContain("Video is additive evidence, not a substitute for screenshots");
    expect(operatorPrompt).toContain("first record the exact unavailable tool and failure");
    expect(operatorPrompt).toContain("Do not replace an operable desktop user path with `curl`");
    expect(operatorPrompt).toContain("supporting or fallback evidence for user-visible proof");
    expect(operatorPrompt).toContain("record a user-like action trace");
    expect(operatorPrompt).toContain("preconditions or seed/reset state");
    expect(operatorPrompt).toContain("used the product rather than only inspected internals");
    expect(operatorPrompt).toContain("/tmp/phase-evidence/operator/");
    expect(operatorPrompt).toContain(
      "Put bulk logs and supporting evidence in files under `/tmp/phase-evidence/operator/`",
    );
    expect(operatorPrompt).toContain("optional `cycloid-qa-runtime-learnings` block");
    expect(operatorPrompt).toContain("/tmp/phase-notes/");
    expect(operatorPrompt).toContain("capture visual evidence of the changed happy path or changed state");
    expect(operatorPrompt).toContain(
      "capture post-interaction `desktop.screenshot` evidence whenever the operated app reaches",
    );
    expect(operatorPrompt).toContain(
      "Add one short `desktop.record_start`/`desktop.record_stop` walkthrough for changed frontend interactions",
    );
    expect(operatorPrompt).toContain("not generic app load, login, or unrelated pages");
    expect(operatorPrompt).toContain("cannot be captured visually");
    expect(operatorPrompt).toContain(
      "For feature additions, exercise the happy path through the relevant changed surface",
    );
    expect(operatorPrompt).toContain("otherwise use API, CLI, library, data-path, or focused command proof");
    expect(operatorPrompt).toContain("Before/after evidence is preferred for bug fixes when feasible");
    expect(operatorPrompt).toContain("always collect available PR-head proof");
    expect(operatorPrompt).toContain("Missing base evidence is judge context");
    expect(operatorPrompt).toContain(
      "For non-app changes, capture the strongest command, API, log, session, data, or test evidence instead",
    );
    expect(operatorPrompt).toContain("If the effective proof contract requires runtime or user-path evidence");
    expect(operatorPrompt).toContain("Do not substitute static review, generic screenshots, API/log/database reads");
    expect(operatorPrompt).toContain("Record evidence for the judge");
    expect(operatorPrompt).toContain("The Phase 4 judge must still return CONCLUSIVE or INCONCLUSIVE");
    expect(operatorPrompt).not.toContain("Do not emit CONCLUSIVE or INCONCLUSIVE");
    expect(operatorPrompt).toContain("changed frontend interactions, operated flows, animations");
    expect(operatorPrompt).toContain("capture a concise screenshot trail through the operated path");
    expect(operatorPrompt).toContain("without needing parent-session context");
    expect(operatorPrompt).toContain("Screenshots are mandatory for changed frontend screens and states");
    expect(operatorPrompt).toContain("Recordings are mandatory for changed frontend interactions and operated flows");
    expect(operatorPrompt).toContain("flow entry point");
    expect(operatorPrompt).toContain("meaningful navigation or state transition");
    expect(operatorPrompt).toContain("Name path screenshots in sequence");
    expect(operatorPrompt).toContain("do not publish screenshots of secret entry");
    expect(operatorPrompt).toContain("desktop screenshots and, where useful, desktop walkthrough video");
    expect(operatorPrompt).toContain("Scenario executed: actor");
    expect(operatorPrompt).toContain("Write concise artifacts that should appear in the managed QA comment");
    expect(operatorPrompt).toContain("automatically stage their screenshot/WebM artifacts");
    expect(operatorPrompt).not.toContain("# Suggested note structure");
    expect(operatorPrompt).not.toContain("VerificationOperatorArtifact");
    expectHandoffContract(operatorPrompt);

    const judgePrompt = calls.find((call) => call.phase === "verification-judge")?.prompt ?? "";
    expect(judgePrompt).toContain("Decide final QA testing outcome");
    expect(judgePrompt).toContain("First reconstruct the effective proof contract");
    expect(judgePrompt).toContain("require operated runtime/user-path evidence");
    expect(judgePrompt).toContain("reject CONCLUSIVE unless prior notes show an actual operated user journey");
    expect(judgePrompt).toContain("actor/auth context, entry point, actions taken, visible result");
    expect(judgePrompt).toContain(
      "Static review, passing tests, API-only checks, or generic screenshots are not enough",
    );
    expect(judgePrompt).toContain("Remote GitHub CI/check-run state is outside your scope");
    expect(judgePrompt).not.toContain("Decide final merge readiness");
    expect(judgePrompt).toContain("managed QA comment uses artifacts from `/tmp/cycloid-evidence/`");
    expect(judgePrompt).toContain("Do not treat `/tmp/phase-notes/` files as PR comment evidence");
    expect(judgePrompt).toContain("runner uploads every safe, supported artifact already staged");
    expect(judgePrompt).toContain("Use `publishableEvidence` only to select additional concise evidence");
    expect(judgePrompt).toContain("Automatically staged desktop evidence does not need to be enumerated");
    expect(judgePrompt).toContain("Be selective with text and log evidence");
    expect(judgePrompt).toContain("Include screenshots and videos when they directly show");
    expect(judgePrompt).toContain("prefer a concise path sequence of screenshots");
    expect(judgePrompt).toContain("makes the operator journey understandable without parent-session context");
    expect(judgePrompt).toContain("entry, meaningful intermediate navigation or state transitions");
    expect(judgePrompt).toContain("avoiding duplicate frames, auth/token entry, login/setup-only pages");
    expect(judgePrompt).toContain("For changed frontend screens/states, expect screenshots");
    expect(judgePrompt).toContain("For changed frontend interactions/flows, expect screenshots plus a recording");
    expect(judgePrompt).toContain("expect screenshots plus one short recording for changed frontend interactions");
    expect(judgePrompt).toContain("Video is additive evidence");
    expect(judgePrompt).toContain("do not treat video as permission to omit required screenshots");
    expect(judgePrompt).toContain("Missing video is a named evidence gap");
    expect(judgePrompt).toContain("Acceptable omission reasons include");
    expect(judgePrompt).toContain("no user-visible/app-operable surface");
    expect(judgePrompt).toContain("static visible state already proven by screenshots plus stronger evidence");
    expect(judgePrompt).toContain("runtime/desktop unavailable after concrete repair attempts");
    expect(judgePrompt).toContain("recording risk around secrets/OAuth/private customer data/destructive state");
    expect(judgePrompt).toContain("desktop recording failure after a real attempt");
    expect(judgePrompt).toContain("not an automatic failure for non-visual/API-only work");
    expect(judgePrompt).toContain("Do not publish recordings of setup, login, auth entry");
    expect(judgePrompt).toContain("Leave desktop recording manifests, debug logs, frame temp files");
    expect(judgePrompt).toContain("changed happy path, fixed state, changed interaction");
    expect(judgePrompt).toContain("For non-visual changes, prefer focused command output");
    expect(judgePrompt).toContain("Keep generic setup/debug logs");
    expect(judgePrompt).toContain("Do not accept static checks passed as sufficient");
    expect(judgePrompt).toContain("lack behavior proof through the relevant surface");
    expect(judgePrompt).toContain("Before/after evidence strengthens bug-fix QA testing but is not mandatory");
    expect(judgePrompt).toContain("evaluate the available PR-head evidence honestly");
    expect(judgePrompt).toContain("Evaluate the route that actually ran");
    expect(judgePrompt).toContain("Do not penalize missing launcher/operator phases");
    expect(judgePrompt).toContain("selected route skipped behavior proof");
    expect(judgePrompt).toContain("# Required terminal result shape");
    expect(judgePrompt).toContain("return exactly one fenced `cycloid-verification-result` JSON block");
    expect(judgePrompt).toContain("A plain ```json fence is rejected");
    expect(judgePrompt).toContain("```cycloid-verification-result");
    expect(judgePrompt).toContain("CONCLUSIVE means exactly one thing");
    expect(judgePrompt).toContain("# Required terminal skip shape");
    expect(judgePrompt).toContain("```verification-skipped");
    expect(judgePrompt).not.toContain("# Preferred terminal result shape");
    expect(judgePrompt).toContain(
      '{"verdict":"CONCLUSIVE|INCONCLUSIVE","verifiedHeadSha":"abc123","computedAgainstHeadSha":"abc123"',
    );
    expect(judgePrompt).toContain('"needsWorkLabel"');
    expect(judgePrompt).toContain('"summary"');
    expect(judgePrompt).toContain('"evidence"');
    expect(judgePrompt).toContain('"blockers"');
    expect(judgePrompt).not.toContain('"schemaVersion"');
    expect(judgePrompt).not.toContain('"artifactType"');
    expect(judgePrompt).not.toContain('"proofCoverage"');
  });

  it("planner skip recommendation still runs judge and can terminally skip", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner": [
        "Decision: skip verification",
        "Route: planner-judge",
        handoff({
          "Route impact:": "Selected route planner-judge; launcher/operator intentionally omitted.",
          "Required proof:": "Confirm no product-path proof is needed.",
          "Satisfied proof:": "Only README changed.",
          "Evidence refs:": "changed_file: README.md.",
          "Runtime handles:": "N/A.",
        }),
      ].join("\n"),
      "verification-judge": terminalSkip("Judge accepted planner skip rationale."),
    });

    const outcome = await runner.run();

    expect(outcome.kind).toBe("skip");
    expect(outcome.skip.reason).toBe("Judge accepted planner skip rationale.");
    expect(calls.map((call) => call.phase)).toEqual(["verification-planner", "verification-judge"]);
    expect(calls.at(-1)?.phase).toBe("verification-judge");
    const judgePrompt = calls.find((call) => call.phase === "verification-judge")?.prompt ?? "";
    expect(judgePrompt).toContain("Planner recommended skip: yes");
    expect(judgePrompt).toContain("Omitted phases: verification-launcher -> verification-operator");
  });

  it("defaults unclear planner notes and ambiguous changes to the full route", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner": "Planner note: maybe low risk, but inspect the change.",
      "verification-launcher": "Launcher note: no runtime setup was needed.",
      "verification-operator": "Operator note: no runtime operation was needed.",
      "verification-judge": terminalJson("CONCLUSIVE", { evidence: ["operator notes"] }),
    });

    const outcome = await runner.run();

    expect(outcome.kind).toBe("final");
    expect(outcome.result.verdict).toBe("CONCLUSIVE");
    expect(calls.map((call) => call.phase)).toEqual([...VERIFICATION_PHASE_NAMES]);
    const judgePrompt = calls.find((call) => call.phase === "verification-judge")?.prompt ?? "";
    expect(judgePrompt).toContain("Selected route: full");
    expect(judgePrompt).toContain(
      "Planned phase sequence: verification-planner -> verification-launcher -> verification-operator -> verification-judge",
    );
  });

  it("keeps planner and launcher runtime checklist bullets surface-neutral", () => {
    const input = {
      invocation: {
        runId: "run-1",
        phase: "verification-planner" as const,
        targetPrUrl: TARGET_PR_URL,
        headSha: HEAD_SHA,
        attempt: 0,
        inputArtifactRefs: [],
        outputFence: "free-form" as const,
      },
      priorArtifacts: [],
    };

    const plannerPrompt = buildVerificationPlannerPrompt(input);
    const launcherPrompt = buildVerificationLauncherPrompt({
      ...input,
      invocation: { ...input.invocation, phase: "verification-launcher" },
    });

    expect(plannerPrompt).toContain(
      "whether app runtime, API/runtime, CLI/library, data-path, auth, browser, sandbox/session, side-effect, before/after proof, or performance comparison proof is needed",
    );
    expect(launcherPrompt).toContain(
      "whether prior notes require app runtime, API/runtime, CLI/library, data-path, auth, browser, sandbox/session, or side-effect setup",
    );
    expect(plannerPrompt).not.toContain("runtime/auth/browser/sandbox/session/before-after");
    expect(launcherPrompt).not.toContain("runtime/auth/browser/sandbox/session setup");
  });

  it("requires before/after matrices for performance improvement PRs", () => {
    const input = {
      invocation: {
        runId: "run-1",
        phase: "verification-planner" as const,
        targetPrUrl: TARGET_PR_URL,
        headSha: HEAD_SHA,
        attempt: 0,
        inputArtifactRefs: [],
        outputFence: "free-form" as const,
      },
      priorArtifacts: [],
    };

    const plannerPrompt = buildVerificationPlannerPrompt(input);
    const launcherPrompt = buildVerificationLauncherPrompt({
      ...input,
      invocation: { ...input.invocation, phase: "verification-launcher" },
    });
    const operatorPrompt = buildVerificationOperatorPrompt({
      ...input,
      invocation: { ...input.invocation, phase: "verification-operator" },
    });
    const judgePrompt = buildVerificationJudgePrompt({
      ...input,
      invocation: { ...input.invocation, phase: "verification-judge" },
    });

    for (const prompt of [plannerPrompt, operatorPrompt, judgePrompt]) {
      expect(prompt).toContain("performance improvement PR");
      expect(prompt).toContain("Before PR");
      expect(prompt).toContain("After PR");
      expect(prompt).toContain("improved, regressed, unchanged, or blocked");
    }
    expect(plannerPrompt).toContain("Do not accept PR-head-only timing");
    expect(launcherPrompt).toContain("comparable base and PR-head targets");
    expect(operatorPrompt).toContain("Do not report a performance win from a PR-head-only run.");
    expect(judgePrompt).toContain(
      "reject CONCLUSIVE unless prior notes include comparable base and PR-head measurements",
    );
    expect(operatorPrompt).toContain("Performance comparison:");
  });

  it("instructs launcher and operator (only) to emit the QA runtime learnings block", () => {
    const input = {
      invocation: {
        runId: "run-1",
        phase: "verification-planner" as const,
        targetPrUrl: TARGET_PR_URL,
        headSha: HEAD_SHA,
        attempt: 0,
        inputArtifactRefs: [],
        outputFence: "free-form" as const,
      },
      priorArtifacts: [],
    };

    const launcherPrompt = buildVerificationLauncherPrompt({
      ...input,
      invocation: { ...input.invocation, phase: "verification-launcher" },
    });
    const operatorPrompt = buildVerificationOperatorPrompt({
      ...input,
      invocation: { ...input.invocation, phase: "verification-operator" },
    });
    const plannerPrompt = buildVerificationPlannerPrompt(input);
    const judgePrompt = buildVerificationJudgePrompt({
      ...input,
      invocation: { ...input.invocation, phase: "verification-judge" },
    });

    for (const prompt of [launcherPrompt, operatorPrompt]) {
      expect(prompt).toContain("# QA runtime learnings");
      expect(prompt).toContain(QA_RUNTIME_LEARNINGS_FENCE);
      expect(prompt).toContain("supersedesMemoryIds");
      expect(prompt).toContain("Omit the block entirely when there is nothing new.");
    }
    expect(plannerPrompt).not.toContain(QA_RUNTIME_LEARNINGS_FENCE);
    expect(judgePrompt).not.toContain(QA_RUNTIME_LEARNINGS_FENCE);
  });

  it("does not retry or block on non-JSON phase output before judge", async () => {
    const { runner, calls } = runnerFor({
      "verification-planner": "not json",
      "verification-launcher": "- app booted\n- auth ready",
      "verification-operator": "screenshot: /tmp/evidence.png\nflow passed",
      "verification-judge": terminalJson("CONCLUSIVE"),
    });

    const outcome = await runner.run();

    expect(outcome.kind).toBe("final");
    expect(calls.map((call) => `${call.phase}:${call.attempt}`)).toEqual(
      VERIFICATION_PHASE_NAMES.map((phase) => `${phase}:0`),
    );
    expect(JSON.stringify(outcome)).not.toContain("malformed");
  });

  it("repairs vague judge output with one required terminal JSON retry", async () => {
    const { runner, calls, sentEvents, telemetryEvents } = runnerFor({
      "verification-planner": "Planner note: verification should run.",
      "verification-launcher": "Launcher note: app booted.",
      "verification-operator": "Operator note: changed page was not reachable.",
      "verification-judge": [
        "INCONCLUSIVE: not ready to merge because the changed page was not reachable.",
        terminalJson("INCONCLUSIVE", {
          needsWorkLabel: "verification-gap",
          summary: "Changed page was not reachable.",
          blockers: ["Changed page was not reachable."],
        }),
      ],
    });

    const outcome = await runner.run();

    expect(outcome).toMatchObject({
      kind: "final",
      result: {
        verdict: "INCONCLUSIVE",
        needsWorkLabel: "verification-gap",
        blockers: ["Changed page was not reachable."],
      },
    });
    expect(calls.filter((call) => call.phase === "verification-judge").map((call) => call.attempt)).toEqual([0, 1]);
    const repairPrompt = calls.find((call) => call.phase === "verification-judge" && call.attempt === 1)?.prompt ?? "";
    expect(repairPrompt).toContain("Parse failure: missing fenced cycloid-verification-result JSON block");
    expect(repairPrompt).toContain("# Route summary");
    expect(repairPrompt).toContain("Selected route: full");
    expect(repairPrompt).toContain("Intentionally skipped phases: none");
    expect(repairPrompt).toContain("Return only one terminal fenced JSON block");
    expect(sentEvents).toHaveLength(5);
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.judge_repair",
        outcome: "attempted",
        reason_code: "malformed_output",
      }),
    );
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.phase_completed",
        phase: "verification-judge",
        attempt: 1,
        raw_output_chars: expect.any(Number),
        capped_output_chars: expect.any(Number),
        handoff_present: false,
        handoff_truncated: false,
        fallback_excerpt_used: false,
        handoff_chars: 0,
        fallback_excerpt_chars: 0,
      }),
    );
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.judge_repair",
        outcome: "succeeded_result",
        reason_code: "none",
      }),
    );
    expect(
      outcome.artifacts.filter((record) => record.phase === "verification-judge").map((record) => record.attempt),
    ).toEqual([0, 1]);
  });

  it("returns deterministic INCONCLUSIVE when judge repair output is still malformed", async () => {
    const { runner, calls, telemetryEvents } = runnerFor({
      "verification-planner": "Planner note: verification should run.",
      "verification-launcher": "Launcher note.",
      "verification-operator": "Operator note.",
      "verification-judge": [
        "I looked at the notes and have some thoughts, but no verdict.",
        "Still no fenced terminal result.",
      ],
    });

    const outcome = await runner.run();

    expect(outcome).toMatchObject({
      kind: "final",
      result: {
        verdict: "INCONCLUSIVE",
        blockers: [expect.stringContaining("QA Tester output was malformed")],
      },
    });
    expect(calls.filter((call) => call.phase === "verification-judge").map((call) => call.attempt)).toEqual([0, 1]);
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.judge_repair",
        outcome: "malformed",
        reason_code: "malformed_output",
      }),
    );
  });

  it("keeps phase failures and timeouts as controlled INCONCLUSIVE outcomes", async () => {
    const failure = runnerFor({ "verification-planner": new Error("model process exited") });
    await expect(failure.runner.run()).resolves.toMatchObject({
      kind: "inconclusive",
      result: { blockers: [expect.stringContaining("failed before producing notes")] },
    });
    expect(failure.telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.phase_failed",
        phase: "verification-planner",
        reason_code: "invoke_failed",
      }),
    );

    const timeout = runnerFor({
      "verification-planner": new VerificationPhaseTimeoutError("planner exceeded limit", "phase-timeout"),
    });
    await expect(timeout.runner.run()).resolves.toMatchObject({
      kind: "inconclusive",
      result: { blockers: [expect.stringContaining("timed out")] },
    });
    expect(timeout.telemetryEvents).toContainEqual(
      expect.objectContaining({
        event: "verification_phase.phase_failed",
        phase: "verification-planner",
        reason_code: "timeout",
        timeout_kind: "phase-timeout",
      }),
    );
  });
});
