import type {
  ExecutionVerification,
  PreviewContract,
  PublishableEvidenceRef,
  VerificationArtifact,
  VerificationVerdict,
} from "../../../../../shared/types/sandbox.js";
import {
  bindPublishableEvidenceToArtifacts,
  buildExecutionVerificationPayload,
  extractVisualAssertion,
  normalizeEvidencePathKey,
  publishableEvidencePathKeys,
  type RuntimeEvidenceRequirement,
} from "../runtime-evidence.js";
import { type ArtifactFailure } from "./artifact-collector.js";
import type { PublishDecision } from "./publish-gates.js";

/**
 * Per-call options for {@link finalizeVerification}. Each verifier path supplies
 * only its branch-specific fields; `useCurrentPublishDecision` selects the folded
 * `PublishDecision` instead of explicit publish overrides. These are optional by
 * design: `post_execution` is a cross-process wire contract, so a missing field
 * reads as "old payload" and falls back.
 */
export interface FinalizeVerificationOptions {
  responseTextForAssertion: string;
  forcedVerdict?: VerificationVerdict;
  claimOverride?: string;
  includeFailureContext?: boolean;
  postExecutionOutcome?: "success" | "error";
  publishMode?: NonNullable<ExecutionVerification["publishMode"]>;
  publishWarnReasons?: string[];
  manualReviewReason?: string;
  useCurrentPublishDecision?: boolean;
  explanationOverride?: string;
  caveats?: string[];
  notes?: string[];
  publishableEvidenceRefs?: readonly PublishableEvidenceRef[];
}

const RUNTIME_DIAGNOSTIC_WITHHELD_MESSAGE =
  "Detailed runtime diagnostics were withheld because they may contain sensitive startup or application log data.";

function looksLikeSensitiveRuntimeDiagnostic(value: string): boolean {
  return (
    /\b(?:Browser logs|Call log|docker compose logs|Startup log tail|Cleanup output|Captured stderr\/output)\b/i.test(
      value,
    ) ||
    /\b(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|AUTHORIZATION|COOKIE)\s*[:=]/i.test(value) ||
    value.split("\n").length >= 4
  );
}

function sanitizeVerificationPayloadMessages(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => (looksLikeSensitiveRuntimeDiagnostic(value) ? RUNTIME_DIAGNOSTIC_WITHHELD_MESSAGE : value)),
    ),
  );
}

function selectedPublishableEvidenceFilenames(refs: readonly PublishableEvidenceRef[] | undefined): Set<string> | null {
  if (!refs) return null;
  return new Set(refs.flatMap((ref) => publishableEvidencePathKeys(ref)).filter(Boolean));
}

/**
 * Bridge-supplied ports for the finalizer. Extends the minimal verification
 * context with the live preview-contract read, artifact upload, and
 * failure-context caveat builder.
 */
export interface FinalizeVerificationContext {
  timePostExecutionStep: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  readPreviewContract: () => PreviewContract | undefined;
  collectVerificationArtifacts: (
    visualAssertion: string | undefined,
    options: { onArtifactFailure?: (failure: ArtifactFailure) => void },
  ) => Promise<VerificationArtifact[]>;
  buildFailureCaveats: (baseCaveats?: string[]) => string[];
}

/**
 * Finalizes the QA verifier-session payload after the verifier has produced its
 * terminal result. Implementation-session post-execution builds only publish
 * gate/manual-review metadata and does not use this artifact path.
 */
export async function finalizeVerification(
  publishDecision: PublishDecision,
  ctx: FinalizeVerificationContext,
  options: FinalizeVerificationOptions,
): Promise<{
  artifacts: VerificationArtifact[];
  payload: ExecutionVerification | undefined;
  previewContract?: PreviewContract;
}> {
  const runtimeEvidenceRequirement: RuntimeEvidenceRequirement = { required: false };
  const previewContract = ctx.readPreviewContract();
  const artifactFailures: ArtifactFailure[] = [];
  const artifacts = await ctx.timePostExecutionStep("post_execution.artifact_upload", () =>
    ctx.collectVerificationArtifacts(extractVisualAssertion(options.responseTextForAssertion), {
      onArtifactFailure: (failure) => artifactFailures.push(failure),
    }),
  );
  const boundPublishableEvidence = options.publishableEvidenceRefs
    ? bindPublishableEvidenceToArtifacts(options.publishableEvidenceRefs, artifacts)
    : undefined;
  const artifactsForPayload = boundPublishableEvidence?.artifacts ?? artifacts;
  const missingPublishableUploads = boundPublishableEvidence?.missingRefs ?? [];
  const effectiveCaveatsFromOptions = sanitizeVerificationPayloadMessages(options.caveats ?? []);
  const effectiveNotes = sanitizeVerificationPayloadMessages(options.notes ?? []);
  const effectivePublishMode = options.useCurrentPublishDecision ? publishDecision.publishMode : options.publishMode;
  const effectivePublishWarnReasons = options.useCurrentPublishDecision
    ? publishDecision.publishWarnReasons
    : options.publishWarnReasons;
  const effectiveManualReviewReason = options.useCurrentPublishDecision
    ? publishDecision.manualReviewReason
    : options.manualReviewReason;
  const selectedFilenames = selectedPublishableEvidenceFilenames(options.publishableEvidenceRefs);
  const relevantArtifactFailures = selectedFilenames
    ? artifactFailures.filter((failure) => selectedFilenames.has(normalizeEvidencePathKey(failure.filename)))
    : artifactFailures;
  const publishableUploadCaveats = sanitizeVerificationPayloadMessages([
    ...missingPublishableUploads.map((ref) => `Selected publishable evidence was not uploaded: ${ref.label}.`),
    ...relevantArtifactFailures.map(
      (failure) => `Verification artifact upload failed: ${failure.filename}: ${failure.reason}`,
    ),
  ]);
  const effectiveCaveats = options.includeFailureContext
    ? ctx.buildFailureCaveats([
        ...(artifactsForPayload.length === 0 ? ["No runtime artifacts were captured before session termination."] : []),
        ...publishableUploadCaveats,
        ...effectiveCaveatsFromOptions,
      ])
    : options.postExecutionOutcome === "error"
      ? ctx.buildFailureCaveats([
          "Verifier artifact finalization did not complete normally.",
          ...publishableUploadCaveats,
          ...effectiveCaveatsFromOptions,
        ])
      : [...publishableUploadCaveats, ...effectiveCaveatsFromOptions];
  const payload = buildExecutionVerificationPayload({
    runtimeEvidenceRequirement,
    publishMode: effectivePublishMode,
    publishWarnReasons: effectivePublishWarnReasons,
    manualReviewReason: effectiveManualReviewReason,
    artifacts: artifactsForPayload,
    previewContract,
    visualAssertion: extractVisualAssertion(options.responseTextForAssertion),
    verdict: options.forcedVerdict ?? publishDecision.verificationVerdictOverride,
    claim: options.claimOverride,
    caveats: effectiveCaveats,
    notes: effectiveNotes,
    explanationOverride: options.explanationOverride ?? publishDecision.verificationExplanationOverride,
    ...(boundPublishableEvidence ? { artifactEvidence: boundPublishableEvidence.evidence } : {}),
  });
  return { artifacts, payload, previewContract };
}
