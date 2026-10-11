// PostExecutionRunner: the post-execution pipeline extracted from the Bridge class.
// See docs/bridge.md and docs/prompt-post-execution.md. Behavior is intentionally identical to
// the former Bridge.runPostExecution; only the host (a per-invocation injected context) changed.

import { isQaTesterAgentRole } from "../../../../../shared/agent/constants.js";
import { parseVerifierTerminalResult } from "../../../../../shared/agent/verification-result.js";
import { isRelevantCheckCommand } from "../../../../../shared/command-classification.js";
import type { BridgeEvent as SandboxEvent } from "../../../../../shared/events/bridge.js";
import type { PlatformLlmCallType, PlatformLlmPhase } from "../../../../../shared/llm/platform-llm-contract.js";
import type { PrTemplateFillLlmInput } from "../../../../../shared/llm/post-execution.js";
import { buildGateResults } from "../../../../../shared/post-execution.js";
import { sanitizeMalformedSearchBlockedText } from "../../../../../shared/transcript/malformed-search.js";
import type { AgentTimelineEntry, AgentTimelineStatus } from "../../../../../shared/types/agent-timeline.js";
import type {
  ExecutionVerification,
  PreviewContract,
  PrReadinessCommand,
  PrReadinessEvidence,
  PublishMode,
  VerificationArtifact,
  VerificationPrContext,
  VerifierTerminalResult,
} from "../../../../../shared/types/sandbox.js";
import { stringifyError } from "../../../../../shared/utils/errors.js";
import { CONFIGURED_TEST_FAILURE_EVENT } from "../../constants/observability.js";
import { type BridgeLogger } from "../../logger.js";
import { PromptLoopState } from "../../prompt-loop-state.js";
import { classifyError } from "../../utils/classify.js";
import { buildDatadogLogsUrl } from "../../utils/datadog-logs-url.js";
import {
  formatResourceKilledManualReviewReason,
  isResourceKilledCommandResult,
  type RepoTestResult,
} from "../../utils/diagnostics.js";
import { resolvePrePublishFixPlan, runConfiguredPrePublishFixCommand } from "../../utils/pre-publish-fix.js";
import {
  type ConfiguredTestCommand,
  resolvePrePublishTestPlan,
  runConfiguredPrePublishTestCommand,
} from "../../utils/pre-publish-tests.js";
import { hasConfiguredE2ERuntime } from "../../utils/preview-contract.js";
import { btMetadata, type BtSpan } from "../braintrust.js";
import { GitOperations } from "../git-ops.js";
import type { BridgeStructuredOutputClient } from "../platform-llm-client.js";
import {
  buildCleanNarrative,
  cleanNarrativeText,
  DEFAULT_PR_SUMMARY_FILL_TEMPLATE,
  renderPrEvidenceCommentFromReadiness,
} from "../pr.js";
import { buildPostExecutionCommandEvidence, buildPrReadinessEvidence } from "../pr-readiness.js";
import {
  CycloidJsonPrTemplateProvider,
  parseTemplateHeadings,
  type PrTemplateCandidate,
  RepoLocalPrTemplateProvider,
  resolvePrTemplateChain,
} from "../pr-template.js";
import { resolveOutputInstructions } from "../repo-output-instructions.js";
import { buildCommandVerificationEvidence, buildExecutionVerificationPayload } from "../runtime-evidence.js";
import { TimelineEmitter } from "../timeline-emitter.js";
import { WorkspaceSetupTracker } from "../workspace-setup-tracker.js";
import { buildPostExecutionEvent, type PostExecutionEventPartial } from "./event-builder.js";
import {
  buildFailureCaveats as buildFailureCaveatsForFailure,
  buildFailureClaim as buildFailureClaimForFailure,
  type PostExecutionFailureContext,
  resolveFailurePublishDecision as resolveFailurePublishDecisionForFailure,
} from "./failure-context.js";
import { buildPostExecutionEvidenceBundle, compactCommandOutputForReview } from "./format.js";
import { observePostExecution, type PostExecutionObservationUtility } from "./observability.js";
import {
  applyGateResult,
  initialPublishDecision,
  markGateFailedDraft,
  markGateResourceKilled,
} from "./publish-gates.js";
import {
  finalizeVerification,
  type FinalizeVerificationContext,
  type FinalizeVerificationOptions,
} from "./verification-finalizer.js";

const TIMELINE_STARTED = "started" satisfies AgentTimelineStatus;
const TIMELINE_COMPLETED = "completed" satisfies AgentTimelineStatus;
const TIMELINE_FAILED = "failed" satisfies AgentTimelineStatus;
const TIMELINE_SKIPPED = "skipped" satisfies AgentTimelineStatus;
const CONFIGURED_TEST_CORRECTION_MAX_ATTEMPTS = 1;

export interface PostExecutionCorrectionRequest {
  messageId: string;
  promptLog: BridgeLogger;
  prompt: string;
  signal: AbortSignal;
  agent?: string;
  model?: string;
  agentRole?: string;
  agentProfile?: string;
  loopState?: PromptLoopState;
}

export interface PostExecutionContext {
  config: {
    sandboxId: string;
    sessionId: string;
    controlPlaneUrl: string;
    publicAppUrl?: string;
    agentRole?: string;
    agentProfile?: string;
  };
  cwd: string;
  // serverAbort is an AbortController on the bridge; we expose its signal (the body reads
  // `promptSignal ?? serverAbortSignal`). It is never reassigned, so capturing it once is safe.
  serverAbortSignal: AbortSignal;
  gitOps: GitOperations;
  workspaceSetup: WorkspaceSetupTracker;
  /** Install repo-declared git hook managers once per session, before the first
   * commit, so the commit runs the customer's hooks (and fails closed on hook
   * errors). No-op when the repo declares no supported hook manager. */
  ensureHooksBootstrapped: (promptLog: BridgeLogger, messageId: string, signal: AbortSignal) => Promise<void>;
  timelineEmitter: TimelineEmitter;
  sendEvent: (event: SandboxEvent) => void;
  readPreviewContract: () => PreviewContract | undefined;
  collectVerificationArtifacts: (
    promptLog: BridgeLogger,
    messageId: string,
    visualAssertion?: string,
    options?: {
      onArtifactFailure?: (failure: { type: VerificationArtifact["type"]; filename: string; reason: string }) => void;
    },
  ) => Promise<VerificationArtifact[]>;
  getRepoSlug: () => string | undefined;
  // Prior-invocation serialization gate. Returns the previous post-execution promise so the
  // runner waits for it before touching git state (avoids concurrent git operations).
  getPendingPostExecution: () => Promise<void> | null;
  // Snapshotted at runner entry (before the prior-promise await) to preserve the bridge's
  // active prompt trace/span before `handlePrompt` teardown can clear them.
  getActivePromptTraceMeta: () => { promptId: string; agent: string; model: string } | null;
  getActiveBtPromptSpan: () => BtSpan | null;
  /** Obtain a platform-LLM broker client for a post-execution call type, bound
   * to the current prompt's capabilities. Returns undefined when the capability
   * was not granted. Supplied by the bridge; undefined in tests/standalone. */
  createPlatformLlmClient?: (
    callType: PlatformLlmCallType,
    phase: PlatformLlmPhase,
    signal?: AbortSignal,
  ) => BridgeStructuredOutputClient | undefined;
  /** Cumulative session context (ARC-1143): the session's original (first-prompt)
   * task and the cleaned narratives of PRIOR turns, snapshotted before this turn.
   * Lets a multi-prompt PR body describe the whole PR. Supplied by the bridge;
   * undefined in tests/standalone (single-prompt behaviour). */
  getCumulativeNarrative?: () => { originalTask: string | null; priorNarratives: string[] } | undefined;
  /** Record THIS turn's cleaned narrative so it becomes "prior" context for the
   * next prompt in the session (ARC-1143). No-op for empty narratives. */
  recordTurnNarrative?: (cleanNarrative: string) => void;
  /** Run one same-session correction turn during post-execution before the PR
   * event is emitted. Used only for a bounded configured-test feedback loop. */
  runPostExecutionCorrection?: (
    request: PostExecutionCorrectionRequest,
  ) => Promise<{ ok: boolean; responseText?: string }>;
}

export interface PostExecutionRunArgs {
  promptLog: BridgeLogger;
  messageId: string;
  promptContent: string;
  responseText: string;
  loopState?: PromptLoopState;
  agentTimeline?: AgentTimelineEntry[];
  promptSignal?: AbortSignal;
  promptMadeRepoProgress?: boolean;
  failureContext?: PostExecutionFailureContext;
  agentRole?: string;
  agentProfile?: string;
  targetPrUrl?: string | null;
  verificationPrContext?: VerificationPrContext;
  verificationPhaseSkip?: {
    reason: string;
    evidence: string[];
    headSha?: string;
  };
}

/**
 * Builds the input object for the pr_template_fill LLM call from the in-scope post-execution
 * evidence. Pure and exported for unit-testability — no side effects, no I/O.
 */
export function buildPrTemplateFillInput(args: {
  templateContent: string;
  evidence: PrReadinessEvidence;
  diffSummary: string;
  instructions?: string | null;
}): PrTemplateFillLlmInput {
  const changedLines = (args.evidence.diffStats?.insertions ?? 0) + (args.evidence.diffStats?.deletions ?? 0);
  const allHeadings = parseTemplateHeadings(args.templateContent).map((h) => h.text);
  const headings = allHeadings.length > 25 ? [] : allHeadings;
  const commands = args.evidence.commandsRun
    .filter(
      (c) =>
        c.source === "post_execution" &&
        (c.status === "completed" || c.status === "error") &&
        isRelevantCheckCommand(c.command),
    )
    .slice(0, 12)
    .map((c) => ({
      label: c.check ?? "Command",
      command: c.command,
      // A "completed" command can still carry a non-zero exit code (it ran but the
      // check failed); only label it "passed" when the exit code confirms success,
      // so the LLM never narrates a failed command as passing.
      status: (c.status === "completed" && (c.exitCode === 0 || c.exitCode == null) ? "passed" : "failed") as
        "passed" | "failed" | "skipped",
    }));
  return {
    headings,
    narrative: buildCleanNarrative(args.evidence).slice(0, 8_000),
    taskPrompt: (args.evidence.evidenceBundle?.originalPrompt ?? "").slice(0, 4_000),
    diffSummary: args.diffSummary.slice(0, 4_000),
    diffSizeBand: changedLines < 100 ? "small" : changedLines < 500 ? "medium" : "large",
    instructions: args.instructions ?? null,
    factPlacement: "body",
    commands,
  };
}

function buildConfiguredTestCorrectionPrompt(args: { command: ConfiguredTestCommand; result: RepoTestResult }): string {
  const command = args.result.command?.join(" ") || args.command.command;
  return [
    "A configured pre-publish test failed after your implementation, before the pull request was opened.",
    "",
    "Fix the underlying issue now. Preserve the existing implementation changes. Do not ask the user a question. After making the fix, rerun the failing command or the smallest relevant check you need.",
    "",
    `Configured command: ${command}`,
    `Why it ran: ${args.command.reason}`,
    `Failure summary: ${compactCommandOutputForReview(args.result.output)}`,
    ...(args.result.failureLogTail ? ["", "Failure log tail:", args.result.failureLogTail] : []),
  ].join("\n");
}

/**
 * Runs the post-execution pipeline (git staging, pre-publish gates, verifier artifact finalization,
 * and the terminal `post_execution` event) for a completed prompt. The bridge constructs one
 * runner per scheduled post-execution and injects its collaborators via `PostExecutionContext`.
 */
export class PostExecutionRunner {
  constructor(private readonly ctx: PostExecutionContext) {}

  async run(args: PostExecutionRunArgs): Promise<void> {
    const {
      promptLog,
      messageId,
      promptContent,
      responseText,
      loopState,
      agentTimeline = [],
      promptSignal,
      promptMadeRepoProgress = true,
      failureContext,
      agentRole,
      agentProfile,
      targetPrUrl,
      verificationPrContext,
      verificationPhaseSkip,
    } = args;
    const postExecutionStartTime = Date.now();
    const activePromptTraceMeta = this.ctx.getActivePromptTraceMeta();
    const postExecutionPromptTraceMeta = activePromptTraceMeta ? { ...activePromptTraceMeta } : null;
    const postExecutionBtParentSpan = this.ctx.getActiveBtPromptSpan();
    const postExecutionDurations: Record<string, { count: number; totalMs: number; maxMs: number; lastMs: number }> =
      {};
    let postExecutionDurationsLogged = false;
    const observe = (args: {
      utility: PostExecutionObservationUtility;
      event: string;
      message: string;
      fields?: Record<string, unknown>;
    }): void => {
      const repoSlug = this.ctx.getRepoSlug();
      observePostExecution(promptLog, {
        ...args,
        fields: {
          prompt_id: messageId,
          sessionId: this.ctx.config.sessionId,
          sandboxId: this.ctx.config.sandboxId,
          agentRole: agentRole ?? this.ctx.config.agentRole ?? "implementation",
          ...((agentProfile ?? this.ctx.config.agentProfile)
            ? { agentProfile: agentProfile ?? this.ctx.config.agentProfile }
            : {}),
          ...(repoSlug ? { repo: repoSlug } : {}),
          ...args.fields,
        },
      });
    };
    observe({
      utility: failureContext ? "degraded" : "progress",
      event: "post_execution.started",
      message: failureContext
        ? "Post-execution publish preparation started after abnormal prompt termination"
        : "Post-execution publish preparation started",
      fields: {
        hasFailureContext: Boolean(failureContext),
        ...(failureContext ? { failureKind: failureContext.kind } : {}),
        hasTargetPr: Boolean(targetPrUrl),
      },
    });
    const recordPostExecutionDuration = (stepName: string, durationMs: number): void => {
      const current = postExecutionDurations[stepName] ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
      current.count += 1;
      current.totalMs += durationMs;
      current.maxMs = Math.max(current.maxMs, durationMs);
      current.lastMs = durationMs;
      postExecutionDurations[stepName] = current;
    };
    const logPostExecutionDurations = (fields: Record<string, string | number | boolean | undefined> = {}): void => {
      if (postExecutionDurationsLogged) return;
      postExecutionDurationsLogged = true;
      promptLog.info(
        {
          event: "post_execution.durations",
          observabilityUtility: "progress",
          prompt_id: messageId,
          sessionId: this.ctx.config.sessionId,
          totalMs: Date.now() - postExecutionStartTime,
          spans: postExecutionDurations,
          ...fields,
        },
        "Post-execution durations",
      );
    };
    // Time a post-execution step and record its duration for the
    // `post_execution.durations` log. Keep the log field named `spans` for
    // compatibility with existing Datadog log queries.
    const timePostExecutionStep = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const stepStartedAt = Date.now();
      observe({
        utility: "trace",
        event: "post_execution.step",
        message: "Post-execution step started",
        fields: { step: name, phase_status: "started" },
      });
      try {
        const result = await fn();
        const durationMs = Date.now() - stepStartedAt;
        observe({
          utility: "progress",
          event: "post_execution.step",
          message: "Post-execution step completed",
          fields: { step: name, phase_status: "completed", duration_ms: durationMs },
        });
        return result;
      } catch (error) {
        const durationMs = Date.now() - stepStartedAt;
        observe({
          utility: "failure",
          event: "post_execution.step",
          message: "Post-execution step failed",
          fields: {
            step: name,
            phase_status: "failed",
            duration_ms: durationMs,
            error: stringifyError(error),
          },
        });
        throw error;
      } finally {
        recordPostExecutionDuration(name, Date.now() - stepStartedAt);
      }
    };
    let postExecutionOutcome: "success" | "error" = "success";
    let postExecutionErrorCode: string | undefined;
    const readinessCommands: PrReadinessCommand[] = [];
    const agentFinalMessage = loopState?.latestMessageResponseText() || loopState?.latestResponseText() || responseText;
    const hasMalformedSearchBlock = (loopState?.malformedSearchCommandCount ?? 0) > 0;
    const displayResponseText = hasMalformedSearchBlock
      ? sanitizeMalformedSearchBlockedText(responseText)
      : responseText;
    const displayAgentFinalMessage = hasMalformedSearchBlock
      ? sanitizeMalformedSearchBlockedText(agentFinalMessage)
      : agentFinalMessage;
    let commandTimelineRecorded = false;
    const recordCommandTimeline = (): void => {
      if (commandTimelineRecorded) return;
      commandTimelineRecorded = true;
      const entry = this.ctx.timelineEmitter.emitCommandTimeline(messageId, readinessCommands);
      if (entry) agentTimeline.push(entry);
    };
    const cumulative = this.ctx.getCumulativeNarrative?.();
    const evidenceBundle = buildPostExecutionEvidenceBundle({
      promptContent,
      finalSummary: displayResponseText,
      agentFinalMessage: displayAgentFinalMessage,
      controlPlaneUrl: this.ctx.config.controlPlaneUrl,
      publicAppUrl: this.ctx.config.publicAppUrl,
      sessionId: this.ctx.config.sessionId,
      sessionOriginalTask: cumulative?.originalTask ?? undefined,
      priorNarratives: cumulative?.priorNarratives,
    });
    // Failure-path publish policy lives in services/post-execution/failure-context.ts
    // (pure + unit-tested). These adapters bind the per-invocation failure context
    // and command list so the call sites below stay unchanged.
    const buildFailureClaim = (): string | undefined => buildFailureClaimForFailure(failureContext);
    const buildFailureCaveats = (baseCaveats: string[] = []): string[] =>
      buildFailureCaveatsForFailure(failureContext, readinessCommands, baseCaveats);
    const resolveFailurePublishDecision = () => resolveFailurePublishDecisionForFailure(failureContext);
    // ARC-1330 (PR 27): the `observedPromptProgress` signal serialized onto every post_execution
    // event as `promptIntendsChange`. It is computed mid-method (once the loop/diff state is known)
    // and assigned to this closure var there; the early prep-failed/no-diff terminals emit before it
    // is known and so carry the `false` default (no observed progress = "Answered", not a swallowed
    // change). Projection-only — it never gates publish (D3).
    let observedPromptProgressForEvent = false;
    // Single emit point for the post_execution event. Each terminal branch (prep-failed, no-diff,
    // failure-context, success) supplies only its per-branch fields; the shared envelope
    // (type/messageId/sandboxId/timestamp) is filled here so a new envelope field is added once.
    const emitPostExecution = (partial: PostExecutionEventPartial): void => {
      this.ctx.sendEvent(
        buildPostExecutionEvent(
          { messageId, sandboxId: this.ctx.config.sandboxId, timestamp: Date.now() },
          // Default the serialized progress signal; a branch may still override it explicitly.
          { promptIntendsChange: observedPromptProgressForEvent, ...partial },
        ),
      );
    };
    const emitTerminal = (args: {
      event: PostExecutionEventPartial;
      completed: Parameters<PostExecutionRunner["logPostExecutionCompleted"]>[1];
      durations: Record<string, string | number | boolean | undefined>;
    }): void => {
      observe({
        utility: args.completed.outcome === "error" ? "degraded" : "decision",
        event: "post_execution.terminal",
        message: "Post-execution terminal event prepared",
        fields: {
          outcome: args.completed.outcome,
          hasChanges: args.completed.hasChanges,
          ...(args.completed.noChangeReason ? { noChangeReason: args.completed.noChangeReason } : {}),
          pushed: "pushed" in args.event ? Boolean(args.event.pushed) : undefined,
          branchPresent: Boolean(args.completed.branch),
          commitPresent: Boolean(args.completed.commitSha),
          publishMode: args.completed.publishMode ?? args.event.publishMode,
          gateDecisions: args.completed.gateDecisions,
        },
      });
      emitPostExecution(args.event);
      this.logPostExecutionCompleted(promptLog, args.completed);
      logPostExecutionDurations(args.durations);
    };
    const effectiveAgentRole = agentRole ?? this.ctx.config.agentRole;
    // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
    const isQaTesterSession = isQaTesterAgentRole(effectiveAgentRole);
    const parsedVerifierResult = isQaTesterSession ? parseVerifierTerminalResult(displayAgentFinalMessage) : null;
    const parsedTerminalVerifierResult =
      parsedVerifierResult && !parsedVerifierResult.malformed ? parsedVerifierResult.result : undefined;
    const verifierValidationCaveats: string[] = [];
    const validateVerifierResult = (result: VerifierTerminalResult | undefined): VerifierTerminalResult | undefined => {
      if (!result || !isQaTesterSession) return result;
      const expectedBranch = verificationPrContext?.headRef?.trim() ?? "";
      if (!expectedBranch) {
        verifierValidationCaveats.push("Authoritative PR branch context was unavailable at post-execution validation.");
        observe({
          utility: "degraded",
          event: "post_execution.verifier_branch_validation",
          message: "Verifier branch validation could not run because PR branch context was missing",
          fields: { reason: "missing_expected_branch" },
        });
        return result;
      }
      let current: { branch?: string; commitSha?: string };
      try {
        current = this.ctx.gitOps.readCurrentGitState(promptLog);
      } catch (error) {
        const message = `Could not read current verifier git state: ${String(error)}`;
        verifierValidationCaveats.push(message);
        observe({
          utility: "degraded",
          event: "post_execution.verifier_branch_validation",
          message: "Verifier branch validation could not read current git state",
          fields: { reason: "git_state_read_failed", error: String(error) },
        });
        return result;
      }
      const currentBranch = current.branch ?? "";
      const currentHeadSha = current.commitSha ?? "";
      if (currentBranch === expectedBranch) {
        return { ...result, verifiedHeadSha: currentHeadSha || result.verifiedHeadSha };
      }
      verifierValidationCaveats.push(
        `Verifier branch validation warning: expected ${expectedBranch}, current checkout is ${currentBranch || "<unknown>"}.`,
      );
      observe({
        utility: "degraded",
        event: "post_execution.verifier_branch_validation",
        message: "Verifier branch validation found the checkout was not on the target PR branch",
        fields: {
          reason: "branch_mismatch",
          expectedBranch,
          currentBranch: currentBranch || "<unknown>",
          currentHeadSha,
        },
      });
      return result;
    };
    const qaTesterResult = validateVerifierResult(parsedTerminalVerifierResult);
    let verifierResultForEvent = qaTesterResult;
    const withVerifierResult = (partial: PostExecutionEventPartial): PostExecutionEventPartial => ({
      ...partial,
      ...(verifierResultForEvent ? { verifierResult: verifierResultForEvent } : {}),
    });
    if (isQaTesterSession && verificationPhaseSkip) {
      emitTerminal({
        event: {
          hasChanges: false,
          noChangeReason: "verification_phase_skip",
          verificationSkipped: verificationPhaseSkip,
        },
        completed: {
          messageId,
          outcome: "success",
          durationMs: Date.now() - postExecutionStartTime,
          hasChanges: false,
          noChangeReason: "verification_phase_skip",
        },
        durations: { outcome: "verification_phase_skip", has_changes: false },
      });
      return;
    }
    // Shared "commit/push then resolve git state" contract. Both the happy path and the
    // abnormal failure-context branch need to optionally commit+push and then fall back to
    // reading the current branch/commit when no push happened; keep that contract in one place
    // so the two paths cannot drift.
    const commitPushAndResolveGitState = async (opts: {
      commitMessage?: string;
      shouldCommit: boolean;
    }): Promise<{ branch?: string; commitSha?: string; pushed: boolean }> => {
      let resolvedBranch: string | undefined;
      let resolvedCommitSha: string | undefined;
      let pushed = false;
      if (opts.shouldCommit) {
        // Install repo-declared hooks before the first commit so the commit runs
        // the customer's hooks. Waits for dependency setup internally; no-op when
        // the repo declares no supported hook manager.
        await this.ctx.ensureHooksBootstrapped(promptLog, messageId, promptSignal ?? this.ctx.serverAbortSignal);
        this.ctx.workspaceSetup.flushCompletionIfReady(messageId, promptLog, "background");
        const pushResult = await timePostExecutionStep("post_execution.commit_push", () =>
          this.ctx.gitOps.commitAndPush(promptLog, messageId, opts.commitMessage),
        );
        if (pushResult) {
          pushed = true;
          resolvedBranch = pushResult.branch;
          resolvedCommitSha = pushResult.commitSha;
          if (pushResult.agentTimeline) agentTimeline.push(...pushResult.agentTimeline);
        }
      }
      // Fall back to reading current git state if push didn't happen.
      if (!resolvedBranch) {
        ({ branch: resolvedBranch, commitSha: resolvedCommitSha } = this.ctx.gitOps.readCurrentGitState(promptLog));
      }
      return { branch: resolvedBranch, commitSha: resolvedCommitSha, pushed };
    };
    const buildReadiness = (
      opts: {
        changedFiles?: string[];
        diffStat?: string;
        finalAnswer?: string;
        agentFinalMessage?: string;
      } = {},
    ): PrReadinessEvidence =>
      buildPrReadinessEvidence(
        {
          changedFiles: opts.changedFiles ?? [],
          diffStat: opts.diffStat,
          commandsRun: readinessCommands,
          finalAnswer: opts.finalAnswer ?? displayResponseText,
          evidenceBundle: {
            ...evidenceBundle,
            finalSummary: opts.finalAnswer ?? evidenceBundle.finalSummary,
            agentFinalMessage: opts.agentFinalMessage ?? evidenceBundle.agentFinalMessage,
          },
          agentTimeline,
        },
        promptLog,
      );
    const publishDecision = initialPublishDecision();
    const gateDecisions: Record<string, string> = {};
    const buildDecisionSignal = (
      publishMode: PublishMode,
    ): Pick<PostExecutionEventPartial, "publishMode" | "gateResults"> => ({
      publishMode,
      gateResults: buildGateResults(gateDecisions),
    });
    const finalizeVerificationCtx: FinalizeVerificationContext = {
      timePostExecutionStep,
      readPreviewContract: () => this.ctx.readPreviewContract(),
      collectVerificationArtifacts: (visualAssertion, collectOptions) =>
        this.ctx.collectVerificationArtifacts(promptLog, messageId, visualAssertion, collectOptions),
      buildFailureCaveats,
    };
    const buildImplementationPublishMetadata = (options: {
      publishMode?: NonNullable<ExecutionVerification["publishMode"]>;
      publishWarnReasons?: string[];
      manualReviewReason?: string;
      forcedVerdict?: ExecutionVerification["verdict"];
      claim?: string;
      caveats?: string[];
      explanationOverride?: string;
      includeGateEvidence?: boolean;
    }): ExecutionVerification | undefined =>
      buildExecutionVerificationPayload({
        runtimeEvidenceRequirement: { required: false },
        artifacts: [],
        publishMode: options.publishMode,
        publishWarnReasons: options.publishWarnReasons,
        manualReviewReason: options.manualReviewReason,
        verdict: options.forcedVerdict,
        claim: options.claim,
        caveats: options.caveats,
        explanationOverride: options.explanationOverride,
        commandEvidence: options.includeGateEvidence
          ? buildCommandVerificationEvidence(readinessCommands.filter((command) => command.source === "post_execution"))
          : undefined,
      });
    const finalizeVerifierVerification = async (
      options: Partial<FinalizeVerificationOptions> = {},
    ): Promise<{
      artifacts: VerificationArtifact[];
      payload: ExecutionVerification | undefined;
    }> => {
      try {
        const qaForcedVerdict =
          qaTesterResult?.verdict === "INCONCLUSIVE"
            ? "INCONCLUSIVE"
            : qaTesterResult
              ? undefined
              : options.forcedVerdict;
        const caveats = [...verifierValidationCaveats, ...(options.caveats ?? [])];
        const finalized = await finalizeVerification(publishDecision, finalizeVerificationCtx, {
          responseTextForAssertion: agentFinalMessage,
          publishableEvidenceRefs: qaTesterResult?.publishableEvidence,
          ...options,
          forcedVerdict: qaForcedVerdict,
          explanationOverride:
            qaTesterResult?.verdict === "INCONCLUSIVE" ? qaTesterResult.summary : options.explanationOverride,
          ...(caveats.length > 0 ? { caveats } : {}),
        });
        if (qaTesterResult && finalized.payload?.evidence) {
          verifierResultForEvent = { ...qaTesterResult, evidenceRefs: finalized.payload.evidence };
        }
        return finalized;
      } catch (error) {
        const message = stringifyError(error);
        observe({
          utility: "failure",
          event: "post_execution.verifier_artifact_finalization_failed",
          message: "Verifier artifact finalization failed",
          fields: { error: message },
        });
        const qaFallbackVerdict =
          qaTesterResult?.verdict === "INCONCLUSIVE"
            ? "INCONCLUSIVE"
            : qaTesterResult
              ? undefined
              : (options.forcedVerdict ?? "INCONCLUSIVE");
        return {
          artifacts: [],
          payload: buildExecutionVerificationPayload({
            runtimeEvidenceRequirement: { required: false },
            artifacts: [],
            verdict: qaFallbackVerdict,
            claim: buildFailureClaim(),
            caveats: buildFailureCaveats([
              ...verifierValidationCaveats,
              ...(options.caveats ?? []),
              `Verifier artifact finalization failed: ${message}`,
            ]),
            explanationOverride:
              qaTesterResult?.verdict === "INCONCLUSIVE"
                ? qaTesterResult.summary
                : (options.explanationOverride ?? publishDecision.verificationExplanationOverride),
          }),
        };
      }
    };
    // Wait for any prior post-execution to finish (avoids concurrent git operations).
    // At runner entry, getPendingPostExecution() returns the PREVIOUS invocation's promise
    // (captured by the caller before it assigned this run's promise).
    const priorPostExecution = this.ctx.getPendingPostExecution();
    if (priorPostExecution) {
      await timePostExecutionStep("post_execution.wait_previous", () => priorPostExecution);
    }

    const preparedDiff = await timePostExecutionStep("post_execution.prep", async () =>
      this.ctx.gitOps.stageAndComputeDiffs(promptLog),
    );
    if (!preparedDiff) {
      observe({
        utility: "degraded",
        event: "post_execution.prep_failed",
        message: "Post-execution prep failed; no pull request will be published",
        fields: { reason: "git_unavailable_or_hook_error" },
      });
      recordCommandTimeline();
      const prepFailedCaveat = "Git diff preparation failed, so changed-file evidence could not be proven.";
      const finalizedVerifierVerification = isQaTesterSession
        ? await finalizeVerifierVerification({
            forcedVerdict: "INCONCLUSIVE",
            claimOverride: buildFailureClaim(),
            caveats: [prepFailedCaveat],
          })
        : null;
      const prepFailedVerifierPayload = finalizedVerifierVerification?.payload;
      const prepFailedVerification =
        prepFailedVerifierPayload ??
        buildImplementationPublishMetadata({
          forcedVerdict: "INCONCLUSIVE",
          claim: buildFailureClaim(),
          caveats: buildFailureCaveats([prepFailedCaveat]),
          includeGateEvidence: true,
        });
      emitTerminal({
        event: withVerifierResult({
          hasChanges: false,
          noChangeReason: "prep_failed",
          prReadiness: buildReadiness(),
          ...(prepFailedVerification ? { verification: prepFailedVerification } : {}),
          // No PR is created on prep-failure and no pre-publish gates ran; emit
          // the running publish mode with an explicit all-skipped gate record so
          // the durable signal never misreports it.
          publishMode: publishDecision.publishMode,
          gateResults: buildGateResults({}),
        }),
        completed: {
          messageId,
          outcome: "error",
          durationMs: Date.now() - postExecutionStartTime,
          hasChanges: false,
          noChangeReason: "prep_failed",
          errorCode: "prep_failed",
        },
        durations: {
          outcome: "error",
          hasChanges: false,
          noChangeReason: "prep_failed",
          errorCode: "prep_failed",
          artifactsUploaded: finalizedVerifierVerification?.artifacts.length,
        },
      });
      return;
    }
    let postExecutionBtSpan: BtSpan | undefined;
    let prep = preparedDiff;
    const prTemplate = await timePostExecutionStep("post_execution.pr_template.resolve", () =>
      resolvePrTemplateChain([
        // Tier 1 (ARC-1126): explicit `.cycloid.json` `pr.templatePath`.
        new CycloidJsonPrTemplateProvider(this.ctx.cwd),
        // Tier 2: auto-discovered repo template (.github/pull_request_template.md, …).
        new RepoLocalPrTemplateProvider(this.ctx.cwd),
        // ARC-1124 insertion point: the tier-3 `pr_structure` MemoryPrTemplateProvider
        // plugs in HERE, between auto-discovery and the built-in default (the
        // `status: "none"` fallthrough handled below). Do NOT add it in ARC-1126.
      ]),
    );
    observe({
      utility: "decision",
      event: "pr_template.resolved",
      message:
        prTemplate.status === "found"
          ? "Resolved repository pull request template"
          : "No pull request template selected",
      fields: {
        status: prTemplate.status,
        ...(prTemplate.status === "found"
          ? { path: prTemplate.candidate.path, source: prTemplate.candidate.source }
          : { reason: prTemplate.reason }),
      },
    });
    const prSummaryInstructions = resolveOutputInstructions(this.ctx.cwd, "pr-summary", promptLog);

    let branch: string | undefined;
    let commitSha: string | undefined;
    let diffSummary: string | undefined = prep.diffSummary;
    let prBody: string | undefined;
    let verificationPayload: ExecutionVerification | undefined;
    let prReadiness: PrReadinessEvidence | undefined;
    let pushSucceeded = false;
    const observedPromptProgress =
      promptMadeRepoProgress || (loopState?.editCount ?? 0) > 0 || (loopState?.modifiedFiles.size ?? 0) > 0;
    // ARC-1330 (PR 27): from here on, every post_execution emit carries this as `promptIntendsChange`
    // (the FSM `prompt_intends_change` source). Assigned once; the emit chokepoint reads it.
    observedPromptProgressForEvent = observedPromptProgress;
    // Record this turn's narrative for the NEXT prompt's cumulative PR body (ARC-1143).
    // Gate on observedPromptProgress — the same signal that determines whether the turn
    // publishes a PR body (it feeds both the success and failure publish gates) — so a
    // turn that edited files but didn't "make repo progress" still contributes its
    // narrative. The getCumulativeNarrative() snapshot above ran first, so the current
    // turn is excluded from its own snapshot. No-change/investigation turns are skipped.
    if (observedPromptProgress) {
      this.ctx.recordTurnNarrative?.(cleanNarrativeText(displayAgentFinalMessage));
    }
    if (isQaTesterSession) {
      const readiness = buildReadiness({
        changedFiles: preparedDiff.publishFiles,
        diffStat: preparedDiff.diffSummary ?? preparedDiff.diffStat,
      });
      const qaOnlyViolationBlockers = [
        ...(preparedDiff.hasStagedFiles
          ? [
              preparedDiff.stagedFiles.length > 0
                ? `QA Tester session modified tracked files: ${preparedDiff.stagedFiles.join(", ")}.`
                : "QA Tester session modified tracked repository files.",
            ]
          : []),
      ];
      const qaOnlyViolationCaveats =
        qaOnlyViolationBlockers.length > 0
          ? [
              ...qaOnlyViolationBlockers,
              "QA Tester sessions must report failures and evidence without editing, committing, or pushing code.",
            ]
          : [];
      const qaOnlyFinalizeOptions: Partial<FinalizeVerificationOptions> =
        qaOnlyViolationCaveats.length > 0
          ? {
              caveats: qaOnlyViolationCaveats,
              ...(!qaTesterResult ? { forcedVerdict: "INCONCLUSIVE" as const } : {}),
            }
          : {};
      const finalizedVerifierVerification = await finalizeVerifierVerification(qaOnlyFinalizeOptions);
      if (qaOnlyViolationBlockers.length > 0) {
        observe({
          utility: "degraded",
          event: "post_execution.qa_only_violation",
          message: "QA Tester session modified repository state; changes will not be pushed",
          fields: { violationCount: qaOnlyViolationBlockers.length },
        });
        const fallbackQaOnlyVerifierResult: VerifierTerminalResult = {
          verdict: "INCONCLUSIVE",
          verifiedHeadSha: qaTesterResult?.verifiedHeadSha ?? "",
          summary: "QA Tester session attempted to modify repository state; QA-only changes were not pushed.",
          evidence: qaTesterResult?.evidence ?? [],
          ...(finalizedVerifierVerification.payload?.evidence
            ? { evidenceRefs: finalizedVerifierVerification.payload.evidence }
            : {}),
          blockers: [...qaOnlyViolationCaveats, ...(qaTesterResult?.blockers ?? [])],
        };
        const qaOnlyVerifierResult = qaTesterResult ?? fallbackQaOnlyVerifierResult;
        recordCommandTimeline();
        agentTimeline.push(
          this.ctx.timelineEmitter.emitVerificationTimeline(messageId, finalizedVerifierVerification.payload, "error"),
        );
        emitTerminal({
          event: {
            hasChanges: false,
            noChangeReason: "no_staged_files",
            prReadiness: readiness,
            ...(finalizedVerifierVerification.payload ? { verification: finalizedVerifierVerification.payload } : {}),
            verifierResult: qaOnlyVerifierResult,
            ...buildDecisionSignal(finalizedVerifierVerification.payload?.publishMode ?? "normal"),
          },
          completed: {
            messageId,
            outcome: "error",
            durationMs: Date.now() - postExecutionStartTime,
            hasChanges: false,
            noChangeReason: "no_staged_files",
          },
          durations: {
            outcome: "error",
            hasChanges: false,
            noChangeReason: "no_staged_files",
            artifactsUploaded: finalizedVerifierVerification.artifacts.length,
          },
        });
        return;
      }
      observe({
        utility: "decision",
        event: "post_execution.verifier_no_diff",
        message: "Verifier produced no repo changes; emitting verification result without commit",
      });
      recordCommandTimeline();
      agentTimeline.push(
        this.ctx.timelineEmitter.emitVerificationTimeline(messageId, finalizedVerifierVerification.payload, "success"),
      );
      emitTerminal({
        event: withVerifierResult({
          hasChanges: false,
          noChangeReason: "no_diff",
          prReadiness: readiness,
          ...(finalizedVerifierVerification.payload ? { verification: finalizedVerifierVerification.payload } : {}),
          ...buildDecisionSignal(finalizedVerifierVerification.payload?.publishMode ?? "normal"),
        }),
        completed: {
          messageId,
          outcome: "success",
          durationMs: Date.now() - postExecutionStartTime,
          hasChanges: false,
          noChangeReason: "no_diff",
        },
        durations: {
          outcome: "success",
          hasChanges: false,
          noChangeReason: "no_diff",
          artifactsUploaded: finalizedVerifierVerification.artifacts.length,
        },
      });
      return;
    }
    const promptHasPublishableChanges =
      preparedDiff.hasChanges && (observedPromptProgress || (!failureContext && preparedDiff.hasStagedFiles));
    if (!promptHasPublishableChanges) {
      observe({
        utility: "decision",
        event: "post_execution.no_diff",
        message: "No file changes after execution",
      });
      recordCommandTimeline();

      const noDiffVerificationPayload = failureContext
        ? buildImplementationPublishMetadata({
            forcedVerdict: "INCONCLUSIVE",
            claim: buildFailureClaim(),
            caveats: buildFailureCaveats(),
            explanationOverride: publishDecision.verificationExplanationOverride,
          })
        : undefined;

      emitTerminal({
        event: withVerifierResult({
          hasChanges: false,
          noChangeReason: "no_diff",
          prReadiness: buildReadiness({
            changedFiles: preparedDiff.publishFiles,
            diffStat: preparedDiff.diffSummary ?? preparedDiff.diffStat,
          }),
          ...(noDiffVerificationPayload ? { verification: noDiffVerificationPayload } : {}),
          ...buildDecisionSignal(noDiffVerificationPayload?.publishMode ?? "normal"),
        }),
        completed: {
          messageId,
          outcome: "success",
          durationMs: Date.now() - postExecutionStartTime,
          hasChanges: false,
          noChangeReason: "no_diff",
        },
        durations: {
          outcome: "success",
          hasChanges: false,
          noChangeReason: "no_diff",
        },
      });
      return;
    }
    if (failureContext) {
      const lightweightReadiness = buildReadiness({
        changedFiles: preparedDiff.publishFiles,
        diffStat: preparedDiff.diffSummary ?? preparedDiff.diffStat,
      });
      let failureBranch: string | undefined;
      let failureCommitSha: string | undefined;
      let failurePrBody: string | undefined;
      let failurePrTemplateFill: { template: PrTemplateCandidate; input: PrTemplateFillLlmInput } | undefined;
      let failurePushSucceeded = false;
      let failurePublishDecision = resolveFailurePublishDecision();
      let failureVerificationPayload: ExecutionVerification | undefined;
      const memoryEnforcementFailed = failureContext.errorCode === "memory_enforcement_failed";
      let failureHasChanges = !memoryEnforcementFailed && observedPromptProgress && preparedDiff.hasChanges;

      try {
        const failureGitState = await commitPushAndResolveGitState({
          commitMessage: "Apply changes",
          shouldCommit: preparedDiff.hasStagedFiles && failureHasChanges,
        });
        failurePushSucceeded = failureGitState.pushed;
        failureBranch = failureGitState.branch;
        failureCommitSha = failureGitState.commitSha;
        failureVerificationPayload = buildImplementationPublishMetadata({
          forcedVerdict: failurePublishDecision.verdict,
          claim: buildFailureClaim(),
          caveats: buildFailureCaveats(),
          publishMode: failurePublishDecision.publishMode,
          // Failure policy decides the mode, but any warn reasons folded BEFORE
          // the failure stay on the record instead of being silently dropped.
          publishWarnReasons: Array.from(
            new Set([...failurePublishDecision.publishWarnReasons, ...publishDecision.publishWarnReasons]),
          ),
          manualReviewReason: failurePublishDecision.manualReviewReason,
          includeGateEvidence: true,
        });
        if (failureHasChanges) {
          const failurePrTemplateCandidate =
            prTemplate.status === "found"
              ? prTemplate.candidate
              : prSummaryInstructions
                ? DEFAULT_PR_SUMMARY_FILL_TEMPLATE
                : null;
          failurePrTemplateFill = failurePrTemplateCandidate
            ? {
                template: failurePrTemplateCandidate,
                input: buildPrTemplateFillInput({
                  templateContent: failurePrTemplateCandidate.content,
                  evidence: lightweightReadiness,
                  diffSummary: preparedDiff.diffSummary ?? preparedDiff.diffStat ?? "",
                  instructions: prSummaryInstructions,
                }),
              }
            : undefined;
          failurePrBody = renderPrEvidenceCommentFromReadiness({
            evidence: lightweightReadiness,
            verification: failureVerificationPayload,
            prTemplate,
          });
        }
      } catch (error) {
        const errorMessage = stringifyError(error);
        observe({
          utility: "failure",
          event: "post_execution.failure_context_finalization_failed",
          message: "Abnormal post-execution finalization failed",
          fields: { error: errorMessage, failureKind: failureContext.kind },
        });
        failureHasChanges = false;
        failurePublishDecision = {
          publishMode: "draft",
          publishWarnReasons: [],
          verdict: "INCONCLUSIVE",
        };
        failureVerificationPayload = buildImplementationPublishMetadata({
          publishMode: "draft",
          forcedVerdict: "INCONCLUSIVE",
          claim: buildFailureClaim(),
          caveats: buildFailureCaveats([
            `Abnormal post-execution finalization failed before publishable changes could be proven: ${errorMessage}`,
          ]),
          explanationOverride: publishDecision.verificationExplanationOverride,
          includeGateEvidence: true,
        });
      }

      recordCommandTimeline();
      emitTerminal({
        event: withVerifierResult({
          hasChanges: failureHasChanges,
          ...(failureHasChanges
            ? {
                branch: failureBranch,
                commitSha: failureCommitSha,
                pushed: failurePushSucceeded,
                diffSummary: preparedDiff.diffSummary,
                prBody: failurePrBody,
                prTemplateFill: failurePrTemplateFill,
              }
            : { noChangeReason: "post_prep_failed" }),
          verification: failureVerificationPayload,
          prReadiness: lightweightReadiness,
          // The abnormal/failure path never publishes more permissively than draft.
          // The control plane passes a stricter sandbox mode through unchanged.
          ...buildDecisionSignal(failureVerificationPayload?.publishMode ?? failurePublishDecision.publishMode),
        }),
        completed: {
          messageId,
          outcome: "success",
          durationMs: Date.now() - postExecutionStartTime,
          hasChanges: failureHasChanges,
          noChangeReason: failureHasChanges ? undefined : "post_prep_failed",
        },
        durations: {
          outcome: "success",
          hasChanges: failureHasChanges,
          noChangeReason: failureHasChanges ? undefined : "post_prep_failed",
          failureKind: failureContext.kind,
          pushSucceeded: failurePushSucceeded,
        },
      });
      return;
    }
    try {
      try {
        postExecutionBtSpan = postExecutionBtParentSpan?.startSpan({
          name: "post_execution",
          event: {
            metadata: {
              eventType: "post_execution",
              ...btMetadata({
                sessionId: this.ctx.config.sessionId,
                promptId: messageId,
                sandboxId: this.ctx.config.sandboxId,
                agent: postExecutionPromptTraceMeta?.agent,
                model: postExecutionPromptTraceMeta?.model,
              }),
            },
          },
        });
      } catch (err) {
        observe({
          utility: "degraded",
          event: "post_execution.braintrust_span_failed",
          message: "Failed to start Braintrust post-execution span",
          fields: {
            error: stringifyError(err),
          },
        });
      }
      const testsGateDecisionPriority: Record<string, number> = {
        skipped: 0,
        passed: 1,
        resource_killed: 2,
        draft: 3,
      };
      const setTestsGateDecision = (decision: "skipped" | "passed" | "resource_killed" | "draft"): void => {
        const current = gateDecisions.tests;
        const currentPriority = current ? (testsGateDecisionPriority[current] ?? -1) : -1;
        if (testsGateDecisionPriority[decision] >= currentPriority) {
          gateDecisions.tests = decision;
        }
      };
      const recordTestCommand = (result: RepoTestResult): void => {
        if (result.skipped && result.ok) return;
        readinessCommands.push(
          buildPostExecutionCommandEvidence({
            command: result.command,
            ok: result.ok,
            output: result.ok ? result.output : (result.failureLogTail ?? result.output),
            exitCode: result.exitCode ?? null,
            skipped: result.skipped ?? false,
            skipReason: result.skipReason,
            check: "tests",
          }),
        );
      };
      const skippedPrePublishTestResult = (skipReason: string, ok = true): RepoTestResult => ({
        ok,
        output: skipReason,
        exitCode: null,
        skipped: true,
        skipReason,
        reason: skipReason,
      });
      const runPrePublishConfiguredFix = async (): Promise<void> => {
        agentTimeline.push(
          this.ctx.timelineEmitter.emitPublishGateTimeline(
            messageId,
            TIMELINE_STARTED,
            "Resolving configured pre-publish fix before creating the publish commit.",
            {
              gate: "fix",
              spanName: "post_execution.pre_publish_fix",
            },
          ),
        );

        const plan = await timePostExecutionStep("post_execution.pre_publish_fix.resolve", () =>
          Promise.resolve(resolvePrePublishFixPlan(this.ctx.cwd, prep.publishFiles)),
        );
        if (plan.skipped) {
          agentTimeline.push(
            this.ctx.timelineEmitter.emitPublishGateTimeline(
              messageId,
              plan.ok ? TIMELINE_SKIPPED : TIMELINE_FAILED,
              plan.ok
                ? "Skipped configured pre-publish fix before creating the publish commit."
                : "Configured pre-publish fix could not be resolved; continuing without auto-fix.",
              {
                gate: "fix",
                spanName: "post_execution.pre_publish_fix",
                reason: plan.skipReason,
                configured: plan.configured,
              },
            ),
          );
          observe({
            utility: plan.ok ? "trace" : "degraded",
            event: "post_execution.pre_publish_fix",
            message: plan.ok
              ? "Configured pre-publish fix skipped"
              : "Configured pre-publish fix resolution failed; continuing without auto-fix",
            fields: {
              outcome: plan.ok ? "skipped" : "resolve_failed",
              reason: plan.skipReason,
              configured: plan.configured,
            },
          });
          return;
        }

        await this.ctx.workspaceSetup.waitBeforeDependencyCommand(
          messageId,
          promptLog,
          promptSignal ?? this.ctx.serverAbortSignal,
        );

        const mutatedFiles = new Set<string>();
        for (const configuredCommand of plan.commands) {
          const startedAt = Date.now();
          agentTimeline.push(
            this.ctx.timelineEmitter.emitPublishGateTimeline(
              messageId,
              TIMELINE_STARTED,
              "Running configured pre-publish fix before creating the publish commit.",
              {
                gate: "fix",
                spanName: "post_execution.pre_publish_fix",
                command: configuredCommand.command,
                reason: configuredCommand.reason,
              },
            ),
          );

          const result = await timePostExecutionStep("post_execution.pre_publish_fix.run", () =>
            runConfiguredPrePublishFixCommand(this.ctx.cwd, configuredCommand, plan.timeoutMs),
          );
          if (result.ok) {
            for (const file of result.mutatedFiles) mutatedFiles.add(file);
          }
          const durationMs = Date.now() - startedAt;
          observe({
            utility: result.ok ? "progress" : "degraded",
            event: "post_execution.pre_publish_fix",
            message: result.ok
              ? "Configured pre-publish fix completed"
              : "Configured pre-publish fix failed open; continuing without auto-fix",
            fields: {
              outcome: result.ok ? (result.mutatedFiles.length > 0 ? "mutated" : "clean") : "failed_open",
              command: result.command,
              reason: result.reason,
              exitCode: result.exitCode,
              durationMs,
              mutatedFileCount: result.mutatedFiles.length,
              mutatedFiles: result.mutatedFiles,
              ...(result.failureLogTail ? { failureLogTail: result.failureLogTail } : {}),
            },
          });
          agentTimeline.push(
            this.ctx.timelineEmitter.emitPublishGateTimeline(
              messageId,
              result.ok ? TIMELINE_COMPLETED : TIMELINE_SKIPPED,
              result.ok
                ? "Configured pre-publish fix completed."
                : "Configured pre-publish fix failed open; continuing without auto-fix.",
              {
                gate: "fix",
                spanName: "post_execution.pre_publish_fix",
                command: result.command,
                exitCode: result.exitCode,
                durationMs,
                mutatedFileCount: result.mutatedFiles.length,
                mutatedFiles: result.mutatedFiles,
              },
            ),
          );
        }

        if (mutatedFiles.size === 0) return;
        const fixedPrep = await timePostExecutionStep("post_execution.pre_publish_fix.prep", () =>
          Promise.resolve(this.ctx.gitOps.stageAndComputeDiffs(promptLog)),
        );
        if (!fixedPrep) {
          throw new Error(
            `Configured pre-publish fix mutated tracked files but post-fix staging failed: ${Array.from(mutatedFiles).join(", ")}`,
          );
        }
        prep = fixedPrep;
        diffSummary = fixedPrep.diffSummary;
      };
      const runPrePublishConfiguredTests = async (): Promise<void> => {
        agentTimeline.push(
          this.ctx.timelineEmitter.emitPublishGateTimeline(
            messageId,
            TIMELINE_STARTED,
            "Resolving configured pre-publish tests before opening the pull request.",
            {
              gate: "tests",
              spanName: "post_execution.pre_publish_tests",
            },
          ),
        );

        let plan = await timePostExecutionStep("post_execution.pre_publish_tests.resolve", () =>
          Promise.resolve(resolvePrePublishTestPlan(this.ctx.cwd, prep.publishFiles)),
        );
        if (plan.skipped) {
          const skippedResult = skippedPrePublishTestResult(plan.skipReason, plan.ok);
          recordTestCommand(skippedResult);
          agentTimeline.push(
            this.ctx.timelineEmitter.emitPublishGateTimeline(
              messageId,
              plan.ok ? TIMELINE_SKIPPED : TIMELINE_FAILED,
              plan.ok
                ? "Skipped configured pre-publish tests before opening the pull request."
                : "Configured pre-publish tests could not be resolved; publishing PR for manual review.",
              {
                gate: "tests",
                spanName: "post_execution.pre_publish_tests",
                reason: plan.skipReason,
                configured: plan.configured,
              },
            ),
          );
          if (!plan.ok) {
            setTestsGateDecision("draft");
            applyGateResult(publishDecision, markGateFailedDraft(plan.skipReason, { verdict: "INCONCLUSIVE" }));
          }
          return;
        }

        await this.ctx.workspaceSetup.waitBeforeDependencyCommand(
          messageId,
          promptLog,
          promptSignal ?? this.ctx.serverAbortSignal,
        );

        // Diagnostics for a failing configured test. `failureLogTail` is redacted at capture time
        // and bounded downstream in failed-command readiness evidence. Datadog links remain
        // operator-only.
        const buildTestFailureLogFields = (result: RepoTestResult): Record<string, unknown> => {
          const datadogLogsUrl = buildDatadogLogsUrl({
            sessionId: this.ctx.config.sessionId,
            enabled: Boolean(process.env.DD_API_KEY),
            ddSite: process.env.DD_SITE,
            env: process.env.ARCANIST_RUNTIME_ENVIRONMENT,
            event: CONFIGURED_TEST_FAILURE_EVENT,
            nowMs: Date.now(),
          });
          return {
            ...(result.failureLogTail ? { failureLogTail: result.failureLogTail } : {}),
            ...(datadogLogsUrl ? { datadogLogsUrl } : {}),
          };
        };

        let correctionAttempts = 0;
        let configuredTestAttemptEvidenceStart = readinessCommands.length;
        for (let commandIndex = 0; commandIndex < plan.commands.length; commandIndex++) {
          const configuredCommand = plan.commands[commandIndex];
          agentTimeline.push(
            this.ctx.timelineEmitter.emitPublishGateTimeline(
              messageId,
              TIMELINE_STARTED,
              "Running configured pre-publish test before opening the pull request.",
              {
                gate: "tests",
                spanName: "post_execution.pre_publish_tests",
                command: configuredCommand.command,
                reason: configuredCommand.reason,
              },
            ),
          );

          const result = await timePostExecutionStep("post_execution.pre_publish_tests.run", () =>
            runConfiguredPrePublishTestCommand(this.ctx.cwd, configuredCommand, plan.timeoutMs),
          );
          recordTestCommand(result);
          if (result.ok) {
            setTestsGateDecision("passed");
            agentTimeline.push(
              this.ctx.timelineEmitter.emitPublishGateTimeline(
                messageId,
                TIMELINE_COMPLETED,
                "Configured pre-publish test passed.",
                {
                  gate: "tests",
                  spanName: "post_execution.pre_publish_tests",
                  ...(result.command ? { command: result.command.join(" ") } : {}),
                },
              ),
            );
            continue;
          }

          const canAttemptCorrection =
            correctionAttempts < CONFIGURED_TEST_CORRECTION_MAX_ATTEMPTS &&
            !isResourceKilledCommandResult(result) &&
            Boolean(this.ctx.runPostExecutionCorrection);
          if (canAttemptCorrection) {
            correctionAttempts++;
            agentTimeline.push(
              this.ctx.timelineEmitter.emitPublishGateTimeline(
                messageId,
                TIMELINE_STARTED,
                "Configured pre-publish test failed; asking the agent to fix it before publishing.",
                {
                  gate: "tests",
                  spanName: "post_execution.pre_publish_tests.correction",
                  ...(result.command ? { command: result.command.join(" ") } : {}),
                  ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}),
                },
              ),
            );
            observe({
              utility: "progress",
              event: "post_execution.pre_publish_tests.correction_started",
              message: "Configured pre-publish test failed; running one correction turn before publishing",
              fields: {
                command: result.command?.join(" "),
                ...buildTestFailureLogFields(result),
              },
            });

            const correction = await this.ctx.runPostExecutionCorrection!({
              messageId,
              promptLog,
              prompt: buildConfiguredTestCorrectionPrompt({ command: configuredCommand, result }),
              signal: promptSignal ?? this.ctx.serverAbortSignal,
              agent: postExecutionPromptTraceMeta?.agent,
              model: postExecutionPromptTraceMeta?.model,
              agentRole: agentRole ?? this.ctx.config.agentRole,
              agentProfile: agentProfile ?? this.ctx.config.agentProfile,
              loopState,
            });
            if (correction.ok) {
              const correctedPrep = await timePostExecutionStep(
                "post_execution.pre_publish_tests.correction_prep",
                () => Promise.resolve(this.ctx.gitOps.stageAndComputeDiffs(promptLog)),
              );
              if (correctedPrep) {
                prep = correctedPrep;
                diffSummary = correctedPrep.diffSummary;
                await runPrePublishConfiguredFix();
                const correctedGitState = await commitPushAndResolveGitState({
                  commitMessage: prep.hasStagedFiles ? "Apply changes" : undefined,
                  shouldCommit: prep.hasChanges,
                });
                branch = correctedGitState.branch ?? branch;
                commitSha = correctedGitState.commitSha ?? commitSha;
                if (!prep.hasChanges || correctedGitState.pushed) {
                  if (prep.hasChanges) pushSucceeded = correctedGitState.pushed;
                  readinessCommands.splice(configuredTestAttemptEvidenceStart);
                  plan = await timePostExecutionStep("post_execution.pre_publish_tests.resolve_after_correction", () =>
                    Promise.resolve(resolvePrePublishTestPlan(this.ctx.cwd, prep.publishFiles)),
                  );
                  if (plan.skipped) {
                    const skippedResult = skippedPrePublishTestResult(plan.skipReason, plan.ok);
                    recordTestCommand(skippedResult);
                    setTestsGateDecision(plan.ok ? "skipped" : "draft");
                    if (!plan.ok) {
                      applyGateResult(
                        publishDecision,
                        markGateFailedDraft(plan.skipReason, { verdict: "INCONCLUSIVE" }),
                      );
                    }
                    return;
                  }
                  agentTimeline.push(
                    this.ctx.timelineEmitter.emitPublishGateTimeline(
                      messageId,
                      TIMELINE_COMPLETED,
                      "Agent correction completed; rerunning configured pre-publish tests before publishing.",
                      {
                        gate: "tests",
                        spanName: "post_execution.pre_publish_tests.correction",
                      },
                    ),
                  );
                  observe({
                    utility: "progress",
                    event: "post_execution.pre_publish_tests.correction_completed",
                    message: "Agent correction completed; rerunning configured pre-publish tests",
                  });
                  commandIndex = -1;
                  configuredTestAttemptEvidenceStart = readinessCommands.length;
                  continue;
                }
                if (prep.hasChanges) pushSucceeded = false;
              }
            }

            agentTimeline.push(
              this.ctx.timelineEmitter.emitPublishGateTimeline(
                messageId,
                TIMELINE_FAILED,
                "Agent correction did not produce a publishable rerun; publishing PR for manual review.",
                {
                  gate: "tests",
                  spanName: "post_execution.pre_publish_tests.correction",
                },
              ),
            );
            observe({
              utility: "degraded",
              event: "post_execution.pre_publish_tests.correction_failed",
              message: "Agent correction did not produce a publishable rerun; publishing PR for manual review",
              fields: {
                correctionOk: correction.ok,
                hasResponseText: Boolean(correction.responseText),
              },
            });
          }

          if (isResourceKilledCommandResult(result)) {
            const resourceKilledReason = formatResourceKilledManualReviewReason("tests");
            setTestsGateDecision("resource_killed");
            applyGateResult(publishDecision, markGateResourceKilled(resourceKilledReason));
            agentTimeline.push(
              this.ctx.timelineEmitter.emitPublishGateTimeline(
                messageId,
                TIMELINE_COMPLETED,
                "Configured pre-publish test requires manual review because it was killed by resource limits.",
                {
                  gate: "tests",
                  spanName: "post_execution.pre_publish_tests",
                  manualReviewReason: resourceKilledReason,
                  ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}),
                },
              ),
            );
            observe({
              utility: "degraded",
              event: CONFIGURED_TEST_FAILURE_EVENT,
              message: "Configured pre-publish test was resource-killed; publishing PR for manual review",
              fields: {
                command: result.command?.join(" "),
                reason: resourceKilledReason,
                ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}),
                ...buildTestFailureLogFields(result),
              },
            });
            continue;
          }

          const reason = `Configured pre-publish test failed: ${compactCommandOutputForReview(result.output)}`;
          setTestsGateDecision("draft");
          applyGateResult(publishDecision, markGateFailedDraft(reason, { verdict: "INCONCLUSIVE" }));
          agentTimeline.push(
            this.ctx.timelineEmitter.emitPublishGateTimeline(
              messageId,
              TIMELINE_FAILED,
              "Configured pre-publish test failed; publishing PR for manual review.",
              {
                gate: "tests",
                spanName: "post_execution.pre_publish_tests",
                ...(result.command ? { command: result.command.join(" ") } : {}),
                ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}),
              },
            ),
          );
          observe({
            utility: "degraded",
            event: CONFIGURED_TEST_FAILURE_EVENT,
            message: "Configured pre-publish test failed; publishing PR for manual review",
            fields: {
              command: result.command?.join(" "),
              reason,
              ...buildTestFailureLogFields(result),
            },
          });
        }
      };

      // Active gate keys stay absent until that gate runs to a verdict.
      await runPrePublishConfiguredFix();
      const gitState = await commitPushAndResolveGitState({
        commitMessage: prep.hasStagedFiles ? "Apply changes" : undefined,
        shouldCommit: true,
      });
      pushSucceeded = gitState.pushed;
      branch = gitState.branch;
      commitSha = gitState.commitSha;

      await runPrePublishConfiguredTests();
      setTestsGateDecision("skipped");
    } catch (err) {
      postExecutionOutcome = "error";
      postExecutionErrorCode = classifyError(stringifyError(err));
      observe({
        utility: "failure",
        event: "post_execution.background_failed",
        message: "Post-execution background work failed",
        fields: { error: stringifyError(err), errorCode: postExecutionErrorCode },
      });
    } finally {
      const shouldAttachImplementationPublishMetadata =
        postExecutionOutcome === "error" ||
        publishDecision.publishMode !== "normal" ||
        publishDecision.publishWarnReasons.length > 0 ||
        Boolean(publishDecision.manualReviewReason);
      verificationPayload = shouldAttachImplementationPublishMetadata
        ? buildImplementationPublishMetadata({
            publishMode: publishDecision.publishMode,
            publishWarnReasons: publishDecision.publishWarnReasons,
            manualReviewReason: publishDecision.manualReviewReason,
            forcedVerdict:
              postExecutionOutcome === "error" ? "INCONCLUSIVE" : publishDecision.verificationVerdictOverride,
            caveats:
              postExecutionOutcome === "error"
                ? buildFailureCaveats(["Post-execution publish preparation did not complete normally."])
                : undefined,
            explanationOverride: publishDecision.verificationExplanationOverride,
            includeGateEvidence: true,
          })
        : undefined;
      recordCommandTimeline();
      const finalReadiness = buildReadiness({
        changedFiles: prep.publishFiles,
        diffStat: diffSummary ?? prep.diffStat,
        finalAnswer: displayResponseText,
      });
      prReadiness = finalReadiness;
      const generatedPrBody = prBody;
      const prTemplateFillCandidate =
        prTemplate.status === "found"
          ? prTemplate.candidate
          : prSummaryInstructions
            ? DEFAULT_PR_SUMMARY_FILL_TEMPLATE
            : null;
      const prTemplateFill = prTemplateFillCandidate
        ? {
            template: prTemplateFillCandidate,
            input: buildPrTemplateFillInput({
              templateContent: prTemplateFillCandidate.content,
              evidence: finalReadiness,
              diffSummary: diffSummary ?? prep.diffStat ?? "",
              instructions: prSummaryInstructions,
            }),
            ...(generatedPrBody ? { generatedBody: generatedPrBody } : {}),
          }
        : undefined;
      prBody = renderPrEvidenceCommentFromReadiness({
        evidence: finalReadiness,
        generatedBody: prBody,
        verification: verificationPayload,
        prTemplate,
      });
      postExecutionBtSpan?.end();

      const finalPublishMode = verificationPayload?.publishMode ?? publishDecision.publishMode ?? "normal";
      // Send post_execution so the DO can create/update PR and reset lastPushSucceeded
      emitTerminal({
        event: withVerifierResult({
          hasChanges: true,
          branch,
          commitSha,
          pushed: pushSucceeded,
          diffSummary,
          prBody,
          prTemplateFill,
          verification: verificationPayload,
          prReadiness,
          // `verificationPayload.publishMode` is the FINAL resolved mode; fall
          // back to the gate-folded decision, then normal.
          ...buildDecisionSignal(finalPublishMode),
        }),
        completed: {
          messageId,
          outcome: postExecutionOutcome,
          durationMs: Date.now() - postExecutionStartTime,
          hasChanges: true,
          errorCode: postExecutionErrorCode,
          branch,
          commitSha,
          runtimeEvidenceRequired: false,
          prBodyGenerated: Boolean(prBody),
          diffSummaryGenerated: Boolean(diffSummary),
          publishMode: publishDecision.publishMode,
          verdict: verificationPayload?.verdict,
          gateDecisions,
        },
        durations: {
          outcome: postExecutionOutcome,
          hasChanges: true,
          ...(postExecutionErrorCode ? { errorCode: postExecutionErrorCode } : {}),
        },
      });
    }
  }

  private logPostExecutionCompleted(
    promptLog: BridgeLogger,
    opts: {
      messageId: string;
      outcome: "success" | "error";
      durationMs: number;
      hasChanges: boolean;
      noChangeReason?: string;
      errorCode?: string;
      branch?: string;
      commitSha?: string;
      runtimeEvidenceRequired?: boolean;
      prBodyGenerated?: boolean;
      diffSummaryGenerated?: boolean;
      publishMode?: string;
      verdict?: string;
      gateDecisions?: Record<string, string>;
    },
  ): void {
    const e2eRuntime = hasConfiguredE2ERuntime();
    promptLog.info(
      {
        event: "post_execution.completed",
        observabilityUtility: opts.outcome === "error" ? "degraded" : "decision",
        prompt_id: opts.messageId,
        sessionId: this.ctx.config.sessionId,
        outcome: opts.outcome,
        duration_ms: opts.durationMs,
        hasChanges: opts.hasChanges,
        ...(opts.noChangeReason ? { noChangeReason: opts.noChangeReason } : {}),
        ...(opts.errorCode ? { error_code: opts.errorCode } : {}),
        ...(this.ctx.getRepoSlug() ? { repo: this.ctx.getRepoSlug() } : {}),
        ...(process.env.OWNER_USER_ID ? { ownerUserId: process.env.OWNER_USER_ID } : {}),
        ...(process.env.BUSINESS_ID ? { businessId: process.env.BUSINESS_ID } : {}),
        ...(e2eRuntime ? { e2e_runtime: true } : {}),
        branchPresent: Boolean(opts.branch),
        commitPresent: Boolean(opts.commitSha),
        runtimeEvidenceRequired: opts.runtimeEvidenceRequired ?? false,
        prBodyGenerated: opts.prBodyGenerated ?? false,
        diffSummaryGenerated: opts.diffSummaryGenerated ?? false,
        ...(opts.publishMode ? { publishMode: opts.publishMode } : {}),
        ...(opts.verdict != null ? { verdict: opts.verdict } : {}),
        ...(opts.gateDecisions ? { gateDecisions: opts.gateDecisions } : {}),
      },
      "Post-execution completed",
    );
  }
}
