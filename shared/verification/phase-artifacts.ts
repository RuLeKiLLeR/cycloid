import type { VerifierTerminalResult } from "../types/sandbox.js";

export const VERIFICATION_PHASE_NAMES = [
  "verification-planner",
  "verification-launcher",
  "verification-operator",
  "verification-judge",
] as const;

export type VerificationPhaseName = (typeof VERIFICATION_PHASE_NAMES)[number];

export const VERIFICATION_PHASE_ARTIFACT_TYPES = {
  "verification-planner": "VerificationPlannerArtifact",
  "verification-launcher": "VerificationLauncherArtifact",
  "verification-operator": "VerificationOperatorArtifact",
  "verification-judge": "VerificationJudgeArtifact",
} as const satisfies Record<VerificationPhaseName, string>;

export type VerificationPhaseArtifactType =
  (typeof VERIFICATION_PHASE_ARTIFACT_TYPES)[keyof typeof VERIFICATION_PHASE_ARTIFACT_TYPES];

export const VERIFICATION_PHASE_ARTIFACT_FENCE = "cycloid-verification-phase-artifact";

export type VerificationPhaseTarget = {
  targetPrUrl?: string;
  prUrl?: string;
  headSha?: string;
  baseSha?: string;
};

export type VerificationPhaseInvocation = {
  runId: string;
  phase: VerificationPhaseName;
  targetPrUrl: string;
  headSha: string;
  attempt: number;
  inputArtifactRefs: string[];
  contextBundleRef?: string;
  outputFence: string;
};

export type VerificationPhaseArtifactStatus = "completed" | "skipped" | "blocked";
export type VerificationProofStatus =
  | "satisfied"
  | "unsatisfied-needs-launcher"
  | "unsatisfied-needs-operator"
  | "failed"
  | "blocked"
  | "missing"
  | "contradicted"
  | "skipped"
  | "needs-runtime"
  | "pending";

export const VERIFICATION_JUDGE_PROOF_STATUSES = ["satisfied", "failed", "blocked", "missing", "contradicted"] as const;
export type VerificationJudgeProofStatus = (typeof VERIFICATION_JUDGE_PROOF_STATUSES)[number];

export type VerificationProofScenarioStep = {
  id: string;
  action: string;
  expectedObservation?: string;
};

export const VERIFICATION_EVIDENCE_CITATION_SOURCES = [
  "pr_title",
  "pr_body",
  "changed_file",
  "diff",
  "parent_prompt",
  "check",
  "repo_config",
  "runtime_hint",
  "source_code",
  "repo_instruction",
  "agent_profile",
  "package_script",
  "ci_config",
  "check_output",
  "ci_status",
  "nearby_test",
  "migration_or_schema",
  "auth_boundary",
  "prompt_or_runtime_config",
  "diff_inspection",
] as const;

type FlexibleVerificationTaxonomyValue<T extends string> = T | (string & Record<never, never>);

export type VerificationEvidenceCitationSource = FlexibleVerificationTaxonomyValue<
  (typeof VERIFICATION_EVIDENCE_CITATION_SOURCES)[number]
>;

export type VerificationEvidenceCitation = {
  source: VerificationEvidenceCitationSource;
  reference: string;
  summary: string;
};

export type VerificationEvidenceDomain =
  | "static"
  | "runtime-readiness"
  | "interactive-flow"
  | "auth-or-integration"
  | "sandbox-or-session"
  | "side-effect"
  | "diff-inspection";

export const VERIFICATION_ACCEPTABLE_EVIDENCE_TYPES = [
  "test-output",
  "typecheck-output",
  "lint-output",
  "build-output",
  "ci-status",
  "config-validation",
  "migration-validation",
  "prompt-golden",
  "api-response",
  "request-response-log",
  "http-response-capture",
  "check-run-summary",
  "visual-artifact",
  "interaction-recording",
  "cua-observation",
  "runtime-log",
  "session-event",
  "sandbox-state",
  "database-read",
  "kv-state-capture",
  "pr-side-effect",
  "diff-inspection",
  "diff-hunk",
  "source-snippet",
  "command-output",
  "report",
] as const;

export type VerificationAcceptableEvidenceType = FlexibleVerificationTaxonomyValue<
  (typeof VERIFICATION_ACCEPTABLE_EVIDENCE_TYPES)[number]
>;

export type VerificationProofScenario = {
  actor: string;
  preconditions: string[];
  steps: VerificationProofScenarioStep[];
  expectedObservations: string[];
  negativeChecks?: string[];
  sameFlowGroupId?: string;
};

export type VerificationRequiredProof = {
  id: string;
  claim: string;
  whyRequired: string;
  evidenceDomain: VerificationEvidenceDomain;
  evidenceStandard: string;
  acceptableEvidenceTypes: VerificationAcceptableEvidenceType[];
  proofScenario?: VerificationProofScenario;
  mustUseSameFlowAsUser?: boolean;
  beforeAfter?: {
    required: boolean;
    beforeClaim?: string;
    afterClaim?: string;
    sameFlowGroupId?: string;
  };
};

export type VerificationLaunchSummaryStatus = "ready" | "partial" | "blocked" | "skipped";
export const VERIFICATION_LAUNCH_TARGET_SOURCE_REFS = ["head", "base", "fixture", "external"] as const;
export type VerificationLaunchTargetSourceRef = (typeof VERIFICATION_LAUNCH_TARGET_SOURCE_REFS)[number];
export const VERIFICATION_LAUNCH_ENVIRONMENT_KINDS = [
  "local-web",
  "qa-web",
  "sandbox-session",
  "mobile",
  "desktop",
  "api-only",
] as const;
export type VerificationLaunchEnvironmentKind = (typeof VERIFICATION_LAUNCH_ENVIRONMENT_KINDS)[number];
export const VERIFICATION_READINESS_CHECK_KINDS = ["health", "auth", "seed", "runtime-log", "session-state"] as const;
export type VerificationReadinessCheckKind = FlexibleVerificationTaxonomyValue<
  (typeof VERIFICATION_READINESS_CHECK_KINDS)[number]
>;
export const VERIFICATION_READINESS_CHECK_STATUSES = ["passed", "failed", "blocked"] as const;
export type VerificationReadinessCheckStatus = (typeof VERIFICATION_READINESS_CHECK_STATUSES)[number];
export const VERIFICATION_LAUNCH_AUTH_STATUSES = ["authenticated", "public", "blocked", "not-needed"] as const;
export type VerificationLaunchAuthStatus = (typeof VERIFICATION_LAUNCH_AUTH_STATUSES)[number];
export const VERIFICATION_SETUP_ATTEMPT_RESULTS = ["passed", "failed", "blocked"] as const;
export type VerificationSetupAttemptResult = (typeof VERIFICATION_SETUP_ATTEMPT_RESULTS)[number];
export const VERIFICATION_LAUNCH_PROOF_ASSESSMENT_STATUSES = [
  "satisfied-readiness",
  "unsatisfied-needs-operator",
  "failed",
  "blocked",
] as const;
export type VerificationLaunchProofAssessmentStatus = (typeof VERIFICATION_LAUNCH_PROOF_ASSESSMENT_STATUSES)[number];

export type VerificationReadinessCheck = {
  id: string;
  kind: VerificationReadinessCheckKind;
  status: VerificationReadinessCheckStatus;
  summary: string;
  evidenceRef?: string;
};

export type VerificationLaunchTarget = {
  id: string;
  purpose: string;
  sourceRef: VerificationLaunchTargetSourceRef;
  requiredForProofIds: string[];
  supportsScenarioStepIds?: string[];
  environment: {
    kind: VerificationLaunchEnvironmentKind;
    url?: string;
    apiUrl?: string;
    stablePorts?: number[];
    runtimeId?: string;
    sandboxId?: string;
    sessionId?: string;
  };
  readiness: {
    status: "ready" | "failed" | "partial" | "not-needed";
    checks: VerificationReadinessCheck[];
  };
  auth: {
    status: VerificationLaunchAuthStatus;
    userHint?: string;
    evidenceRef?: string;
    blocker?: string;
  };
  operatorEntry: {
    primaryUrl?: string;
    notes: string[];
  };
};

export type VerificationSetupAttempt = {
  targetId: string;
  action: string;
  result: VerificationSetupAttemptResult;
  summary: string;
  outputRef?: string;
  mutatedTrackedSource?: boolean;
};

export type VerificationLaunchProofAssessment = {
  proofId: string;
  status: VerificationLaunchProofAssessmentStatus;
  launchTargetIds: string[];
  evidenceRefs: string[];
  explanation: string;
};

export type VerificationLaunchBlocker = {
  targetId?: string;
  proofIds: string[];
  blocker: string;
  attempts: string[];
};

export type VerificationLauncherArtifact = MinimalVerificationPhaseArtifact & {
  artifactType: "VerificationLauncherArtifact";
  phase: "verification-launcher";
  summary: {
    status: VerificationLaunchSummaryStatus;
    explanation: string;
  };
  effectiveRuntimeNeeded: boolean;
  launchTargets: VerificationLaunchTarget[];
  setupAttempts: VerificationSetupAttempt[];
  proofAssessments: VerificationLaunchProofAssessment[];
  blockers: VerificationLaunchBlocker[];
  residualRisks: string[];
};

export type VerificationOperatorSummaryStatus = "satisfied" | "failed" | "partial" | "blocked" | "skipped";
export const VERIFICATION_OPERATED_PROOF_SOURCES = ["planner", "operator-amendment"] as const;
export type VerificationOperatedProofSource = (typeof VERIFICATION_OPERATED_PROOF_SOURCES)[number];
export const VERIFICATION_OPERATED_PROOF_STATUSES = ["satisfied", "failed", "blocked", "not-run"] as const;
export type VerificationOperatedProofStatus = (typeof VERIFICATION_OPERATED_PROOF_STATUSES)[number];
export const VERIFICATION_SCENARIO_STEP_STATUSES = ["performed", "blocked", "skipped"] as const;
export type VerificationScenarioStepStatus = (typeof VERIFICATION_SCENARIO_STEP_STATUSES)[number];
export const VERIFICATION_OPERATOR_EVIDENCE_TYPES = [
  "visual-artifact",
  "interaction-recording",
  "cua-observation",
  "api-response",
  "runtime-log",
  "session-event",
  "sandbox-state",
  "database-read",
  "pr-side-effect",
  "command-output",
  "report",
] as const;
export type VerificationOperatorEvidenceType = FlexibleVerificationTaxonomyValue<
  (typeof VERIFICATION_OPERATOR_EVIDENCE_TYPES)[number]
>;

export type VerificationScenarioStepTrace = {
  stepId: string;
  action: string;
  status: VerificationScenarioStepStatus;
  observation: string;
  evidenceRefIds: string[];
};

export type VerificationOperatedProofResult = {
  proofId: string;
  source: VerificationOperatedProofSource;
  status: VerificationOperatedProofStatus;
  launchTargetIds: string[];
  claim: string;
  steps: string[];
  scenarioTrace?: VerificationScenarioStepTrace[];
  observedBehavior: string;
  evidenceRefIds: string[];
  explanation: string;
};

export type VerificationOperatorEvidenceRef = {
  id: string;
  type: VerificationOperatorEvidenceType;
  label: string;
  location?: string;
  launchTargetId?: string;
  summary: string;
};

export type VerificationOperatorProofAmendment = {
  proof: VerificationRequiredProof;
  reason: string;
  evidenceRefIds: string[];
  introducedBy: "verification-operator";
  status: VerificationOperatedProofStatus;
};

export type VerificationOperatorMutationGuard = {
  checked: boolean;
  mutatedTrackedSource: boolean;
  summary: string;
};

export type VerificationOperatorBlocker = {
  proofIds: string[];
  launchTargetIds: string[];
  blocker: string;
  attempts: string[];
};

export type VerificationOperatorArtifact = MinimalVerificationPhaseArtifact & {
  artifactType: "VerificationOperatorArtifact";
  phase: "verification-operator";
  summary: {
    status: VerificationOperatorSummaryStatus;
    explanation: string;
  };
  operatedProofIds: string[];
  proofResults: VerificationOperatedProofResult[];
  evidenceRefs: VerificationOperatorEvidenceRef[];
  proofAmendments: VerificationOperatorProofAmendment[];
  blockers: VerificationOperatorBlocker[];
  mutationGuard?: VerificationOperatorMutationGuard;
  residualRisks: string[];
};

export type VerificationJudgeProofCoverage = {
  proofId: string;
  status: VerificationJudgeProofStatus;
  sourcePhases: VerificationPhaseName[];
  evidenceRefs: string[];
  assessment: string;
};

export const VERIFICATION_JUDGE_NEEDS_WORK_LABELS = ["verification-gap"] as const;
export type VerificationJudgeNeedsWorkLabel = (typeof VERIFICATION_JUDGE_NEEDS_WORK_LABELS)[number];

export type VerificationJudgeBlocker = {
  proofIds: string[];
  blocker: string;
  sourcePhase: VerificationPhaseName;
  evidenceRefs: string[];
};

export type VerificationJudgeArtifact = MinimalVerificationPhaseArtifact & {
  artifactType: "VerificationJudgeArtifact";
  phase: "verification-judge";
  verdict: "CONCLUSIVE" | "INCONCLUSIVE";
  verifiedHeadSha: string;
  computedAgainstHeadSha: string;
  summary: string;
  proofCoverage: VerificationJudgeProofCoverage[];
  evidence: string[];
  blockers: VerificationJudgeBlocker[];
  needsWorkLabel?: VerificationJudgeNeedsWorkLabel;
  residualRisks: string[];
};

export type EffectiveVerificationProof = VerificationRequiredProof & {
  sourcePhases: VerificationPhaseName[];
  status: VerificationProofStatus;
  evidenceRefs: string[];
  blocker?: string;
};

export type EffectiveVerificationProofContract =
  { ok: true; proofs: EffectiveVerificationProof[] } | { ok: false; error: string };

export type MinimalVerificationPhaseArtifact = {
  schemaVersion: 1;
  artifactType: VerificationPhaseArtifactType;
  phase: VerificationPhaseName;
  target: VerificationPhaseTarget;
  status?: VerificationPhaseArtifactStatus;
  summary?: unknown;
  evidenceRefs?: unknown;
  blockers?: unknown;
  [key: string]: unknown;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function judgeProofStatus(value: unknown): value is VerificationJudgeProofStatus {
  return typeof value === "string" && VERIFICATION_JUDGE_PROOF_STATUSES.includes(value as VerificationJudgeProofStatus);
}

function evidenceDomain(value: unknown): value is VerificationEvidenceDomain {
  return (
    value === "static" ||
    value === "runtime-readiness" ||
    value === "interactive-flow" ||
    value === "auth-or-integration" ||
    value === "sandbox-or-session" ||
    value === "side-effect" ||
    value === "diff-inspection"
  );
}

function acceptableEvidenceType(value: unknown): value is VerificationAcceptableEvidenceType {
  return nonEmptyString(value);
}

function evidenceCitationSource(value: unknown): value is VerificationEvidenceCitation["source"] {
  return nonEmptyString(value);
}

function evidenceCitationArray(
  value: unknown,
  options: { requireNonEmpty: boolean },
): value is VerificationEvidenceCitation[] {
  return (
    Array.isArray(value) &&
    (!options.requireNonEmpty || value.length > 0) &&
    value.every((entry) => isEvidenceCitation(entry))
  );
}

function isEvidenceCitation(value: unknown): value is VerificationEvidenceCitation {
  if (!isRecord(value)) return false;
  return evidenceCitationSource(value.source) && nonEmptyString(value.reference) && nonEmptyString(value.summary);
}

function citationArray(value: unknown): value is VerificationEvidenceCitation[] {
  return evidenceCitationArray(value, { requireNonEmpty: true });
}

function launcherSummaryStatus(value: unknown): value is VerificationLaunchSummaryStatus {
  return value === "ready" || value === "partial" || value === "blocked" || value === "skipped";
}

function launcherTargetSourceRef(value: unknown): value is VerificationLaunchTargetSourceRef {
  return (
    typeof value === "string" &&
    VERIFICATION_LAUNCH_TARGET_SOURCE_REFS.includes(value as VerificationLaunchTargetSourceRef)
  );
}

function launcherEnvironmentKind(value: unknown): value is VerificationLaunchEnvironmentKind {
  return (
    typeof value === "string" &&
    VERIFICATION_LAUNCH_ENVIRONMENT_KINDS.includes(value as VerificationLaunchEnvironmentKind)
  );
}

function launcherReadinessKind(value: unknown): value is VerificationReadinessCheckKind {
  return nonEmptyString(value);
}

function launcherReadinessStatus(value: unknown): value is VerificationReadinessCheckStatus {
  return (
    typeof value === "string" &&
    VERIFICATION_READINESS_CHECK_STATUSES.includes(value as VerificationReadinessCheckStatus)
  );
}

function launcherAuthStatus(value: unknown): value is VerificationLaunchAuthStatus {
  return typeof value === "string" && VERIFICATION_LAUNCH_AUTH_STATUSES.includes(value as VerificationLaunchAuthStatus);
}

function launcherSetupResult(value: unknown): value is VerificationSetupAttemptResult {
  return (
    typeof value === "string" && VERIFICATION_SETUP_ATTEMPT_RESULTS.includes(value as VerificationSetupAttemptResult)
  );
}

function launcherProofAssessmentStatus(value: unknown): value is VerificationLaunchProofAssessmentStatus {
  return (
    typeof value === "string" &&
    VERIFICATION_LAUNCH_PROOF_ASSESSMENT_STATUSES.includes(value as VerificationLaunchProofAssessmentStatus)
  );
}

function operatorSummaryStatus(value: unknown): value is VerificationOperatorSummaryStatus {
  return (
    value === "satisfied" || value === "failed" || value === "partial" || value === "blocked" || value === "skipped"
  );
}

function operatedProofSource(value: unknown): value is VerificationOperatedProofSource {
  return (
    typeof value === "string" && VERIFICATION_OPERATED_PROOF_SOURCES.includes(value as VerificationOperatedProofSource)
  );
}

function operatedProofStatus(value: unknown): value is VerificationOperatedProofStatus {
  return (
    typeof value === "string" && VERIFICATION_OPERATED_PROOF_STATUSES.includes(value as VerificationOperatedProofStatus)
  );
}

function scenarioStepStatus(value: unknown): value is VerificationScenarioStepStatus {
  return (
    typeof value === "string" && VERIFICATION_SCENARIO_STEP_STATUSES.includes(value as VerificationScenarioStepStatus)
  );
}

function operatorEvidenceType(value: unknown): value is VerificationOperatorEvidenceType {
  return nonEmptyString(value);
}

function isProofScenario(value: unknown): value is VerificationProofScenario {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.actor)) return false;
  if (!stringArray(value.preconditions)) return false;
  if (!Array.isArray(value.steps) || value.steps.length === 0) return false;
  if (
    value.steps.some(
      (step) =>
        !isRecord(step) ||
        !nonEmptyString(step.id) ||
        !nonEmptyString(step.action) ||
        (step.expectedObservation !== undefined && typeof step.expectedObservation !== "string"),
    )
  ) {
    return false;
  }
  if (!stringArray(value.expectedObservations) || value.expectedObservations.length === 0) return false;
  if (value.negativeChecks !== undefined && !stringArray(value.negativeChecks)) return false;
  if (value.sameFlowGroupId !== undefined && !nonEmptyString(value.sameFlowGroupId)) return false;
  return true;
}

function proofNeedsScenario(proof: VerificationRequiredProof): boolean {
  return (
    proof.evidenceDomain === "runtime-readiness" ||
    proof.evidenceDomain === "interactive-flow" ||
    proof.evidenceDomain === "auth-or-integration" ||
    proof.evidenceDomain === "sandbox-or-session" ||
    proof.evidenceDomain === "side-effect"
  );
}

function isRequiredProof(value: unknown): value is VerificationRequiredProof {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.id)) return false;
  if (!nonEmptyString(value.claim)) return false;
  if (!nonEmptyString(value.whyRequired)) return false;
  if (!evidenceDomain(value.evidenceDomain)) return false;
  if (!nonEmptyString(value.evidenceStandard)) return false;
  if (
    !Array.isArray(value.acceptableEvidenceTypes) ||
    value.acceptableEvidenceTypes.length === 0 ||
    value.acceptableEvidenceTypes.some((entry) => !acceptableEvidenceType(entry))
  ) {
    return false;
  }
  if (value.proofScenario !== undefined && !isProofScenario(value.proofScenario)) return false;
  if (value.mustUseSameFlowAsUser !== undefined && typeof value.mustUseSameFlowAsUser !== "boolean") return false;
  if (value.beforeAfter !== undefined) {
    if (!isRecord(value.beforeAfter)) return false;
    if (typeof value.beforeAfter.required !== "boolean") return false;
    if (value.beforeAfter.beforeClaim !== undefined && typeof value.beforeAfter.beforeClaim !== "string") return false;
    if (value.beforeAfter.afterClaim !== undefined && typeof value.beforeAfter.afterClaim !== "string") return false;
    if (value.beforeAfter.sameFlowGroupId !== undefined && typeof value.beforeAfter.sameFlowGroupId !== "string") {
      return false;
    }
  }
  return true;
}

function validateRequiredProof(value: unknown): string | null {
  if (!isRequiredProof(value)) return "required proof object is invalid";
  if (proofNeedsScenario(value) && !value.proofScenario) {
    return `proof ${value.id} must include a proofScenario for ${value.evidenceDomain} proof`;
  }
  if (value.beforeAfter?.required === true || value.mustUseSameFlowAsUser === true) {
    if (!nonEmptyString(value.beforeAfter?.sameFlowGroupId) && !nonEmptyString(value.proofScenario?.sameFlowGroupId)) {
      return `proof ${value.id} before/after proof requires a same-flow mapping`;
    }
  }
  return null;
}

function isJudgeCoverage(value: unknown): value is VerificationJudgeProofCoverage {
  if (!isRecord(value)) return false;
  if (!nonEmptyString(value.proofId)) return false;
  if (!judgeProofStatus(value.status)) return false;
  if (!Array.isArray(value.sourcePhases) || value.sourcePhases.some((phase) => !isVerificationPhaseName(phase))) {
    return false;
  }
  if (!stringArray(value.evidenceRefs)) return false;
  if (!nonEmptyString(value.assessment)) return false;
  return true;
}

function judgeNeedsWorkLabel(value: unknown): value is VerificationJudgeNeedsWorkLabel {
  return (
    typeof value === "string" && VERIFICATION_JUDGE_NEEDS_WORK_LABELS.includes(value as VerificationJudgeNeedsWorkLabel)
  );
}

function isJudgeBlocker(value: unknown): value is VerificationJudgeBlocker {
  if (!isRecord(value)) return false;
  if (!stringArray(value.proofIds) || value.proofIds.length === 0) return false;
  if (!nonEmptyString(value.blocker)) return false;
  if (!isVerificationPhaseName(value.sourcePhase)) return false;
  if (!stringArray(value.evidenceRefs)) return false;
  return true;
}

function validateProofArray(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `${field} must be an array when present`;
  const seen = new Set<string>();
  for (const entry of value) {
    const error = validateRequiredProof(entry);
    if (error) return `${field} must contain required proof objects: ${error}`;
    if (seen.has(entry.id)) return `${field} contains duplicate proof id ${entry.id}`;
    seen.add(entry.id);
  }
  return null;
}

export type VerificationPhaseArtifactRecord = {
  runId: string;
  sessionId: string;
  promptId: string;
  phase: VerificationPhaseName;
  artifactType: VerificationPhaseArtifactType;
  attempt: number;
  artifact: MinimalVerificationPhaseArtifact;
  note?: VerificationPhaseNote;
  createdAt: string;
};

export type VerificationPhaseNote = {
  phase: VerificationPhaseName;
  output: string;
  createdAt: string;
};

export type VerificationPhaseSkipTerminal = {
  reason: string;
  evidence: string[];
  headSha?: string;
};

export type VerificationPipelineOutcome =
  | { kind: "final"; result: VerifierTerminalResult; artifacts: VerificationPhaseArtifactRecord[] }
  | {
      kind: "skip";
      skipArtifact: VerificationPhaseArtifactRecord;
      skip: VerificationPhaseSkipTerminal;
      artifacts: VerificationPhaseArtifactRecord[];
    }
  | { kind: "inconclusive"; result: VerifierTerminalResult; artifacts: VerificationPhaseArtifactRecord[] };

export type VerificationPhaseValidationResult =
  { ok: true; artifact: MinimalVerificationPhaseArtifact } | { ok: false; error: string };

export type ParsedVerificationPhaseOutput = { ok: true; artifact: unknown } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVerificationPhaseName(value: unknown): value is VerificationPhaseName {
  return typeof value === "string" && VERIFICATION_PHASE_NAMES.includes(value as VerificationPhaseName);
}

function isVerificationPhaseArtifactType(value: unknown): value is VerificationPhaseArtifactType {
  return (
    typeof value === "string" &&
    Object.values(VERIFICATION_PHASE_ARTIFACT_TYPES).includes(value as VerificationPhaseArtifactType)
  );
}

export function artifactTypeForVerificationPhase(phase: VerificationPhaseName): VerificationPhaseArtifactType {
  return VERIFICATION_PHASE_ARTIFACT_TYPES[phase];
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  void value;
  void allowed;
  return [];
}

type StringAliasMap<T extends string = string> = Record<string, T>;

const VERIFICATION_ARTIFACT_TYPE_VALUES = Object.values(
  VERIFICATION_PHASE_ARTIFACT_TYPES,
) as readonly VerificationPhaseArtifactType[];
const EVIDENCE_DOMAIN_VALUES = [
  "static",
  "runtime-readiness",
  "interactive-flow",
  "auth-or-integration",
  "sandbox-or-session",
  "side-effect",
  "diff-inspection",
] as const satisfies readonly VerificationEvidenceDomain[];
const PHASE_ARTIFACT_STATUSES = ["completed", "skipped", "blocked"] as const;
const LAUNCHER_SUMMARY_STATUSES = ["ready", "partial", "blocked", "skipped"] as const;
const LAUNCHER_READINESS_STATUSES = ["ready", "failed", "partial", "not-needed"] as const;
const OPERATOR_SUMMARY_STATUSES = ["satisfied", "failed", "partial", "blocked", "skipped"] as const;
const JUDGE_VERDICTS = ["CONCLUSIVE", "INCONCLUSIVE"] as const;

function enumKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, "+")
    .replace(/\band\b/g, "+")
    .replace(/[^a-z0-9+]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-+]+|[-+]+$/g, "");
}

function aliasMap<T extends string>(entries: readonly (readonly [string, T])[]): StringAliasMap<T> {
  const aliases: StringAliasMap<T> = {};
  for (const [alias, canonical] of entries) aliases[enumKey(alias)] = canonical;
  return aliases;
}

const PHASE_NAME_ALIASES = aliasMap<VerificationPhaseName>([
  ["planner", "verification-planner"],
  ["launcher", "verification-launcher"],
  ["evidence runner", "verification-launcher"],
  ["operator", "verification-operator"],
  ["judge", "verification-judge"],
]);

const ARTIFACT_TYPE_ALIASES = aliasMap<VerificationPhaseArtifactType>([
  ["planner", "VerificationPlannerArtifact"],
  ["verification-planner", "VerificationPlannerArtifact"],
  ["launcher", "VerificationLauncherArtifact"],
  ["verification-launcher", "VerificationLauncherArtifact"],
  ["operator", "VerificationOperatorArtifact"],
  ["verification-operator", "VerificationOperatorArtifact"],
  ["judge", "VerificationJudgeArtifact"],
  ["verification-judge", "VerificationJudgeArtifact"],
]);

const EVIDENCE_SOURCE_ALIASES = aliasMap<VerificationEvidenceCitationSource>([
  ["pr", "pr_body"],
  ["pull request", "pr_body"],
  ["pull-request", "pr_body"],
  ["pr title", "pr_title"],
  ["pr body", "pr_body"],
  ["source", "source_code"],
  ["source file", "source_code"],
  ["source-file", "source_code"],
  ["code", "source_code"],
  ["repo instruction", "repo_instruction"],
  ["repo instructions", "repo_instruction"],
  ["agent profile", "agent_profile"],
  ["package json", "repo_config"],
  ["repo config", "repo_config"],
  ["workflow", "ci_config"],
  ["github workflow", "ci_config"],
  ["ci workflow", "ci_config"],
  ["check run", "check"],
  ["check-run", "check"],
  ["github check", "check"],
  ["github checks", "ci_status"],
  ["pr checks", "ci_status"],
  ["test file", "nearby_test"],
  ["nearby tests", "nearby_test"],
  ["schema", "migration_or_schema"],
  ["migration", "migration_or_schema"],
  ["auth", "auth_boundary"],
  ["runtime config", "prompt_or_runtime_config"],
  ["prompt config", "prompt_or_runtime_config"],
  ["diff hunk", "diff_inspection"],
  ["pr diff", "diff"],
]);

const ACCEPTABLE_EVIDENCE_TYPE_ALIASES = aliasMap<VerificationAcceptableEvidenceType>([
  ["test", "test-output"],
  ["tests", "test-output"],
  ["unit-test", "test-output"],
  ["unit tests", "test-output"],
  ["vitest", "test-output"],
  ["typecheck", "typecheck-output"],
  ["tsc", "typecheck-output"],
  ["lint", "lint-output"],
  ["eslint", "lint-output"],
  ["format", "lint-output"],
  ["build", "build-output"],
  ["ci", "ci-status"],
  ["ci check", "ci-status"],
  ["check run", "check-run-summary"],
  ["check summary", "check-run-summary"],
  ["config", "config-validation"],
  ["config check", "config-validation"],
  ["migration", "migration-validation"],
  ["prompt", "prompt-golden"],
  ["golden", "prompt-golden"],
  ["api", "api-response"],
  ["http response", "http-response-capture"],
  ["http request", "http-response-capture"],
  ["request response", "request-response-log"],
  ["network log", "request-response-log"],
  ["screenshot", "visual-artifact"],
  ["screen capture", "visual-artifact"],
  ["video", "interaction-recording"],
  ["recording", "interaction-recording"],
  ["cua", "cua-observation"],
  ["runtime", "runtime-log"],
  ["log", "runtime-log"],
  ["session", "session-event"],
  ["sandbox", "sandbox-state"],
  ["db", "database-read"],
  ["database", "database-read"],
  ["kv", "kv-state-capture"],
  ["pr", "pr-side-effect"],
  ["diff", "diff-inspection"],
  ["source", "source-snippet"],
  ["source code", "source-snippet"],
  ["source file", "source-snippet"],
  ["source-file", "source-snippet"],
  ["command", "command-output"],
  ["terminal output", "command-output"],
]);

const EVIDENCE_DOMAIN_ALIASES = aliasMap<VerificationEvidenceDomain>([
  ["runtime", "runtime-readiness"],
  ["runtime ready", "runtime-readiness"],
  ["ui", "interactive-flow"],
  ["browser", "interactive-flow"],
  ["interaction", "interactive-flow"],
  ["auth", "auth-or-integration"],
  ["integration", "auth-or-integration"],
  ["sandbox", "sandbox-or-session"],
  ["session", "sandbox-or-session"],
  ["side effect", "side-effect"],
  ["diff", "diff-inspection"],
  ["code inspection", "diff-inspection"],
]);

const PHASE_STATUS_ALIASES = aliasMap<(typeof PHASE_ARTIFACT_STATUSES)[number]>([
  ["complete", "completed"],
  ["done", "completed"],
  ["finished", "completed"],
  ["skip", "skipped"],
  ["not needed", "skipped"],
]);

const LAUNCHER_SUMMARY_STATUS_ALIASES = aliasMap<(typeof LAUNCHER_SUMMARY_STATUSES)[number]>([
  ["pass", "ready"],
  ["passed", "ready"],
  ["success", "ready"],
  ["ok", "ready"],
  ["running", "ready"],
  ["some", "partial"],
  ["incomplete", "partial"],
  ["fail", "blocked"],
  ["failed", "blocked"],
  ["not run", "skipped"],
  ["not-needed", "skipped"],
]);

const LAUNCHER_READINESS_STATUS_ALIASES = aliasMap<(typeof LAUNCHER_READINESS_STATUSES)[number]>([
  ["pass", "ready"],
  ["passed", "ready"],
  ["success", "ready"],
  ["ok", "ready"],
  ["done", "ready"],
  ["fail", "failed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["some", "partial"],
  ["incomplete", "partial"],
  ["not needed", "not-needed"],
  ["not-needed", "not-needed"],
]);

const LAUNCH_TARGET_SOURCE_ALIASES = aliasMap<VerificationLaunchTargetSourceRef>([
  ["pr", "head"],
  ["target", "head"],
  ["current", "head"],
  ["before", "base"],
  ["baseline", "base"],
  ["main", "base"],
  ["mock", "fixture"],
  ["third party", "external"],
]);

const LAUNCH_ENVIRONMENT_KIND_ALIASES = aliasMap<VerificationLaunchEnvironmentKind>([
  ["web", "local-web"],
  ["browser", "local-web"],
  ["frontend", "local-web"],
  ["local", "local-web"],
  ["qa", "qa-web"],
  ["sandbox", "sandbox-session"],
  ["session", "sandbox-session"],
  ["api", "api-only"],
  ["backend", "api-only"],
]);

const READINESS_KIND_ALIASES = aliasMap<VerificationReadinessCheckKind>([
  ["http", "health"],
  ["http health", "health"],
  ["ping", "health"],
  ["login", "auth"],
  ["fixture", "seed"],
  ["fixtures", "seed"],
  ["log", "runtime-log"],
  ["logs", "runtime-log"],
  ["session", "session-state"],
]);

const CHECK_STATUS_ALIASES = aliasMap<VerificationReadinessCheckStatus>([
  ["pass", "passed"],
  ["success", "passed"],
  ["ok", "passed"],
  ["done", "passed"],
  ["fail", "failed"],
  ["failure", "failed"],
  ["error", "failed"],
]);

const AUTH_STATUS_ALIASES = aliasMap<VerificationLaunchAuthStatus>([
  ["logged in", "authenticated"],
  ["logged-in", "authenticated"],
  ["signed in", "authenticated"],
  ["signed-in", "authenticated"],
  ["none", "public"],
  ["unauthenticated", "public"],
  ["not needed", "not-needed"],
  ["not-needed", "not-needed"],
  ["fail", "blocked"],
  ["failed", "blocked"],
  ["error", "blocked"],
]);

const SETUP_RESULT_ALIASES = aliasMap<VerificationSetupAttemptResult>([
  ["pass", "passed"],
  ["success", "passed"],
  ["ok", "passed"],
  ["done", "passed"],
  ["fail", "failed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["not run", "blocked"],
  ["not-run", "blocked"],
  ["skip", "blocked"],
  ["skipped", "blocked"],
]);

const LAUNCH_PROOF_STATUS_ALIASES = aliasMap<VerificationLaunchProofAssessmentStatus>([
  ["pass", "satisfied-readiness"],
  ["passed", "satisfied-readiness"],
  ["success", "satisfied-readiness"],
  ["ready", "satisfied-readiness"],
  ["satisfied", "satisfied-readiness"],
  ["needs operator", "unsatisfied-needs-operator"],
  ["operator", "unsatisfied-needs-operator"],
  ["fail", "failed"],
  ["failure", "failed"],
  ["not ready", "blocked"],
  ["not-run", "blocked"],
]);

const OPERATED_PROOF_SOURCE_ALIASES = aliasMap<VerificationOperatedProofSource>([
  ["operator", "operator-amendment"],
  ["operator amendment", "operator-amendment"],
  ["planner proof", "planner"],
]);

const OPERATED_PROOF_STATUS_ALIASES = aliasMap<VerificationOperatedProofStatus>([
  ["pass", "satisfied"],
  ["passed", "satisfied"],
  ["success", "satisfied"],
  ["ok", "satisfied"],
  ["done", "satisfied"],
  ["fail", "failed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["not run", "not-run"],
  ["not-run", "not-run"],
  ["skip", "not-run"],
  ["skipped", "not-run"],
]);

const OPERATOR_SUMMARY_STATUS_ALIASES = aliasMap<(typeof OPERATOR_SUMMARY_STATUSES)[number]>([
  ["pass", "satisfied"],
  ["passed", "satisfied"],
  ["success", "satisfied"],
  ["ok", "satisfied"],
  ["done", "satisfied"],
  ["fail", "failed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["some", "partial"],
  ["incomplete", "partial"],
  ["not run", "skipped"],
  ["not-run", "skipped"],
  ["skip", "skipped"],
  ["skipped", "skipped"],
]);

const SCENARIO_STEP_STATUS_ALIASES = aliasMap<VerificationScenarioStepStatus>([
  ["done", "performed"],
  ["pass", "performed"],
  ["passed", "performed"],
  ["success", "performed"],
  ["not run", "skipped"],
  ["not-run", "skipped"],
  ["skip", "skipped"],
]);

const JUDGE_PROOF_STATUS_ALIASES = aliasMap<VerificationJudgeProofStatus>([
  ["pass", "satisfied"],
  ["passed", "satisfied"],
  ["success", "satisfied"],
  ["ok", "satisfied"],
  ["ready", "satisfied"],
  ["fail", "failed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["not satisfied", "missing"],
  ["unsatisfied", "missing"],
  ["unresolved", "missing"],
  ["not run", "missing"],
  ["not-run", "missing"],
  ["pending", "missing"],
  ["inconsistent", "contradicted"],
]);

const JUDGE_NEEDS_WORK_LABEL_ALIASES = aliasMap<VerificationJudgeNeedsWorkLabel>([
  ["needs work", "verification-gap"],
  ["verification", "verification-gap"],
  ["missing evidence", "verification-gap"],
  ["evidence gap", "verification-gap"],
]);

const JUDGE_VERDICT_ALIASES = aliasMap<(typeof JUDGE_VERDICTS)[number]>([
  ["ready", "CONCLUSIVE"],
  ["ready to merge", "CONCLUSIVE"],
  ["merge ready", "CONCLUSIVE"],
  ["passed", "CONCLUSIVE"],
  ["pass", "CONCLUSIVE"],
  ["not ready", "INCONCLUSIVE"],
  ["needs work", "INCONCLUSIVE"],
  ["blocked", "INCONCLUSIVE"],
  ["failed", "INCONCLUSIVE"],
  ["fail", "INCONCLUSIVE"],
]);

function normalizeEnumString<T extends string>(
  value: unknown,
  allowed: readonly T[],
  aliases: StringAliasMap = {},
  fallback?: T,
): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if ((allowed as readonly string[]).includes(trimmed)) return trimmed;
  const key = enumKey(trimmed);
  const alias = aliases[key];
  if (alias) return alias;
  const normalizedMatch = allowed.find((entry) => enumKey(entry) === key);
  return normalizedMatch ?? fallback ?? trimmed;
}

function cloneJsonLike(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => cloneJsonLike(entry));
  if (!isRecord(value)) return value;
  const cloned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) cloned[key] = cloneJsonLike(entry);
  return cloned;
}

function firstPresent(value: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

function normalizeAliasedField(value: Record<string, unknown>, field: string, aliases: readonly string[]): void {
  if (value[field] !== undefined) return;
  const aliasValue = firstPresent(value, aliases);
  if (aliasValue !== undefined) value[field] = aliasValue;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function normalizeStringArrayValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => normalizeString(entry)).filter((entry): entry is string => Boolean(entry));
    return entries.length > 0 ? entries : undefined;
  }
  const single = normalizeString(value);
  return single ? [single] : undefined;
}

function normalizeBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const key = enumKey(value);
  if (key === "true" || key === "yes" || key === "needed" || key === "required") return true;
  if (key === "false" || key === "no" || key === "not-needed" || key === "unneeded") return false;
  return undefined;
}

function slugFromText(value: string): string {
  const slug = enumKey(value).replace(/\+/g, "-");
  return slug || "proof";
}

function normalizeCitationEntry(
  value: unknown,
  fallbackSource: VerificationEvidenceCitationSource,
  index: number,
): VerificationEvidenceCitation | null {
  if (typeof value === "string") {
    const summary = normalizeString(value);
    if (!summary) return null;
    return {
      source: fallbackSource,
      reference: `${fallbackSource}-${index + 1}`,
      summary,
    };
  }
  if (!isRecord(value)) return null;
  const sourceValue =
    firstPresent(value, ["source", "kind", "type", "origin", "evidenceSource", "evidence_source"]) ?? fallbackSource;
  const source = normalizeEnumString(
    sourceValue,
    VERIFICATION_EVIDENCE_CITATION_SOURCES,
    EVIDENCE_SOURCE_ALIASES,
  ) as VerificationEvidenceCitationSource;
  const reference =
    normalizeString(
      firstPresent(value, [
        "reference",
        "ref",
        "path",
        "file",
        "filename",
        "location",
        "url",
        "href",
        "id",
        "name",
        "title",
        "command",
        "check",
      ]),
    ) ?? `${source}-${index + 1}`;
  const summary =
    normalizeString(
      firstPresent(value, ["summary", "description", "detail", "details", "reason", "text", "claim", "value", "note"]),
    ) ?? reference;
  return { source, reference, summary };
}

function normalizeCitationList(
  value: unknown,
  fallbackSource: VerificationEvidenceCitationSource,
): VerificationEvidenceCitation[] | undefined {
  if (value === undefined) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  const citations = entries
    .map((entry, index) => normalizeCitationEntry(entry, fallbackSource, index))
    .filter((entry): entry is VerificationEvidenceCitation => entry !== null);
  return citations.length > 0 ? citations : undefined;
}

function normalizeCitationField(
  value: Record<string, unknown>,
  field: string,
  fallbackSource: VerificationEvidenceCitationSource,
): void {
  const citations = normalizeCitationList(value[field], fallbackSource);
  if (citations) value[field] = citations;
}

function ensureCitationField(
  value: Record<string, unknown>,
  field: string,
  fallbackSource: VerificationEvidenceCitationSource,
  reference: string,
  summary: string,
): void {
  normalizeCitationField(value, field, fallbackSource);
  if (Array.isArray(value[field]) && value[field].length > 0) return;
  value[field] = [{ source: fallbackSource, reference, summary }];
}

function normalizeField<T extends string>(
  value: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  aliases?: StringAliasMap,
  fallback?: T,
): void {
  if (value[field] !== undefined) value[field] = normalizeEnumString(value[field], allowed, aliases, fallback);
}

function normalizeStringArrayField<T extends string>(
  value: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  aliases?: StringAliasMap,
): void {
  const entries = normalizeStringArrayValue(value[field]);
  if (!entries) return;
  value[field] = entries.map((entry) => normalizeEnumString(entry, allowed, aliases));
}

function normalizePlainStringArrayField(value: Record<string, unknown>, field: string): void {
  const entries = normalizeStringArrayValue(value[field]);
  if (entries) value[field] = entries;
}

function normalizeRecords(value: unknown, normalizer: (record: Record<string, unknown>) => void): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (isRecord(entry)) normalizer(entry);
  }
}

function inferEvidenceDomain(value: Record<string, unknown>): VerificationEvidenceDomain {
  const evidenceTypes = normalizeStringArrayValue(value.acceptableEvidenceTypes)?.map((entry) => enumKey(entry)) ?? [];
  const joinedTypes = evidenceTypes.join(" ");
  if (joinedTypes.includes("visual") || joinedTypes.includes("interaction") || joinedTypes.includes("cua")) {
    return "interactive-flow";
  }
  if (joinedTypes.includes("pr-side-effect") || joinedTypes.includes("database") || joinedTypes.includes("kv")) {
    return "side-effect";
  }
  if (
    joinedTypes.includes("api") ||
    joinedTypes.includes("runtime") ||
    joinedTypes.includes("session") ||
    joinedTypes.includes("sandbox")
  ) {
    return "runtime-readiness";
  }
  if (isRecord(value.proofScenario)) return "runtime-readiness";
  return "static";
}

function normalizeProofScenarioStep(value: unknown, index: number, proofId: string): VerificationProofScenarioStep {
  if (typeof value === "string") {
    return { id: `${proofId}-step-${index + 1}`, action: value };
  }
  const record = isRecord(value) ? value : {};
  const id =
    normalizeString(firstPresent(record, ["id", "stepId", "step_id", "name"])) ?? `${proofId}-step-${index + 1}`;
  const action =
    normalizeString(firstPresent(record, ["action", "step", "description", "instruction", "do", "text"])) ?? id;
  const expectedObservation = normalizeString(
    firstPresent(record, ["expectedObservation", "expected_observation", "expected", "observation", "result"]),
  );
  return { id, action, ...(expectedObservation ? { expectedObservation } : {}) };
}

function normalizeProofScenarioField(value: Record<string, unknown>): void {
  normalizeAliasedField(value, "proofScenario", ["scenario", "proof_scenario", "userFlow", "user_flow", "flow"]);
  const proofId = String(value.id ?? "proof");
  if (!isRecord(value.proofScenario)) {
    if (proofNeedsScenario(value as VerificationRequiredProof)) {
      value.proofScenario = {
        actor: "verifier",
        preconditions: [],
        steps: [
          {
            id: `${proofId}-step-1`,
            action: `Prove: ${String(value.claim ?? proofId)}`,
            expectedObservation: String(value.evidenceStandard ?? value.claim ?? proofId),
          },
        ],
        expectedObservations: [String(value.evidenceStandard ?? value.claim ?? proofId)],
      };
    }
    return;
  }
  const scenario = value.proofScenario;
  if (!nonEmptyString(scenario.actor)) scenario.actor = "verifier";
  scenario.preconditions = normalizeStringArrayValue(scenario.preconditions) ?? [];
  const rawSteps = Array.isArray(scenario.steps)
    ? scenario.steps
    : normalizeStringArrayValue(firstPresent(scenario, ["step", "actions", "action"]));
  const steps = (
    Array.isArray(rawSteps) && rawSteps.length > 0 ? rawSteps : [`Prove: ${String(value.claim ?? proofId)}`]
  ).map((entry, index) => normalizeProofScenarioStep(entry, index, proofId));
  scenario.steps = steps;
  const expectedObservations =
    normalizeStringArrayValue(
      firstPresent(scenario, ["expectedObservations", "expected_observations", "expected", "observations"]),
    ) ??
    steps
      .map((step) => step.expectedObservation)
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  scenario.expectedObservations =
    expectedObservations.length > 0 ? expectedObservations : [String(value.evidenceStandard ?? value.claim ?? proofId)];
  const negativeChecks = normalizeStringArrayValue(firstPresent(scenario, ["negativeChecks", "negative_checks"]));
  if (negativeChecks) scenario.negativeChecks = negativeChecks;
  const sameFlowGroupId = normalizeString(firstPresent(scenario, ["sameFlowGroupId", "same_flow_group_id"]));
  if (sameFlowGroupId) scenario.sameFlowGroupId = sameFlowGroupId;
}

function normalizeBeforeAfterField(value: Record<string, unknown>): void {
  normalizeAliasedField(value, "beforeAfter", ["before_after", "beforeAfterProof", "before_after_proof"]);
  if (!isRecord(value.beforeAfter)) return;
  const beforeAfter = value.beforeAfter;
  const required = normalizeBooleanValue(beforeAfter.required);
  if (required !== undefined) beforeAfter.required = required;
  if (beforeAfter.required !== true) return;
  if (beforeAfter.beforeClaim !== undefined && typeof beforeAfter.beforeClaim !== "string") {
    beforeAfter.beforeClaim = normalizeString(beforeAfter.beforeClaim) ?? "";
  }
  if (beforeAfter.afterClaim !== undefined && typeof beforeAfter.afterClaim !== "string") {
    beforeAfter.afterClaim = normalizeString(beforeAfter.afterClaim) ?? "";
  }
  const scenario = isRecord(value.proofScenario) ? value.proofScenario : null;
  const sameFlowGroupId =
    normalizeString(firstPresent(beforeAfter, ["sameFlowGroupId", "same_flow_group_id"])) ??
    (scenario ? normalizeString(firstPresent(scenario, ["sameFlowGroupId", "same_flow_group_id"])) : undefined) ??
    `${String(value.id ?? "proof")}-same-flow`;
  beforeAfter.sameFlowGroupId = sameFlowGroupId;
  if (scenario && !nonEmptyString(scenario.sameFlowGroupId)) scenario.sameFlowGroupId = sameFlowGroupId;
}

function normalizeProof(value: unknown): void {
  if (!isRecord(value)) return;
  normalizeAliasedField(value, "whyRequired", ["why", "reason", "rationale", "why_required"]);
  normalizeAliasedField(value, "evidenceStandard", [
    "standard",
    "evidenceRequired",
    "evidence_required",
    "proofStandard",
    "proof_standard",
    "acceptanceCriteria",
    "acceptance_criteria",
  ]);
  normalizeAliasedField(value, "acceptableEvidenceTypes", [
    "acceptableEvidence",
    "acceptable_evidence",
    "evidenceTypes",
    "evidence_types",
    "evidenceType",
    "evidence_type",
  ]);
  if (!nonEmptyString(value.id)) {
    const claimText = normalizeString(firstPresent(value, ["claim", "summary", "description", "proof"]));
    value.id = claimText ? slugFromText(claimText).slice(0, 80) : "proof";
  }
  if (!nonEmptyString(value.claim)) {
    value.claim =
      normalizeString(firstPresent(value, ["summary", "description", "proof", "target"])) ?? String(value.id);
  }
  if (!nonEmptyString(value.whyRequired)) value.whyRequired = String(value.claim);
  if (!nonEmptyString(value.evidenceStandard)) value.evidenceStandard = String(value.whyRequired);
  normalizeStringArrayField(
    value,
    "acceptableEvidenceTypes",
    VERIFICATION_ACCEPTABLE_EVIDENCE_TYPES,
    ACCEPTABLE_EVIDENCE_TYPE_ALIASES,
  );
  if (!Array.isArray(value.acceptableEvidenceTypes) || value.acceptableEvidenceTypes.length === 0) {
    value.acceptableEvidenceTypes = ["test-output"];
  }
  normalizeField(value, "evidenceDomain", EVIDENCE_DOMAIN_VALUES, EVIDENCE_DOMAIN_ALIASES);
  if (!evidenceDomain(value.evidenceDomain)) value.evidenceDomain = inferEvidenceDomain(value);
  normalizeProofScenarioField(value);
  normalizeBeforeAfterField(value);
}

function normalizeOperatorProofAmendment(value: unknown): void {
  if (!isRecord(value)) return;
  normalizeProof(value.proof);
  normalizeField(value, "status", VERIFICATION_OPERATED_PROOF_STATUSES, OPERATED_PROOF_STATUS_ALIASES);
  normalizePlainStringArrayField(value, "evidenceRefIds");
  value.introducedBy = "verification-operator";
}

function normalizePlannerArtifact(value: Record<string, unknown>): void {
  normalizeField(value, "decision", ["run", "skip"] as const, {
    ...aliasMap<"run" | "skip">([
      ["verify", "run"],
      ["verification required", "run"],
      ["needed", "run"],
      ["not needed", "skip"],
      ["no verification", "skip"],
      ["no-op", "skip"],
    ]),
  });
  if (value.decision === undefined && Array.isArray(value.requiredProof)) value.decision = "run";
  normalizeRecords(value.requiredProof, normalizeProof);
  if (isRecord(value.appRuntime)) {
    const needed = normalizeBooleanValue(value.appRuntime.needed);
    if (needed !== undefined) value.appRuntime.needed = needed;
    normalizeAliasedField(value.appRuntime, "reason", ["why", "rationale", "summary"]);
    if (!nonEmptyString(value.appRuntime.reason)) value.appRuntime.reason = String(value.verificationReason ?? "");
    ensureCitationField(value.appRuntime, "evidence", "diff", "planner-app-runtime", String(value.appRuntime.reason));
  } else if (value.decision === "run") {
    const proofs = Array.isArray(value.requiredProof) ? value.requiredProof : [];
    const runtimeNeeded = proofs.some((proof) => {
      if (!isRecord(proof)) return false;
      return proof.evidenceDomain !== "static" && proof.evidenceDomain !== "diff-inspection";
    });
    value.appRuntime = {
      needed: runtimeNeeded,
      reason: runtimeNeeded
        ? "Inferred from non-static required proof."
        : "Inferred from static or diff-inspection required proof.",
      evidence: [
        {
          source: "diff",
          reference: "planner-requiredProof",
          summary: "Runtime need was inferred from the planner proof contract.",
        },
      ],
    };
  }
  normalizeCitationField(value, "evidence", "diff");
  if (value.decision === "run" && !Array.isArray(value.residualRisks)) value.residualRisks = [];
}

function normalizeLauncherArtifact(value: Record<string, unknown>): void {
  if (isRecord(value.summary))
    normalizeField(value.summary, "status", LAUNCHER_SUMMARY_STATUSES, LAUNCHER_SUMMARY_STATUS_ALIASES);
  normalizeRecords(value.launchTargets, (target) => {
    normalizeField(target, "sourceRef", VERIFICATION_LAUNCH_TARGET_SOURCE_REFS, LAUNCH_TARGET_SOURCE_ALIASES);
    normalizePlainStringArrayField(target, "requiredForProofIds");
    normalizePlainStringArrayField(target, "supportsScenarioStepIds");
    if (isRecord(target.environment)) {
      normalizeField(
        target.environment,
        "kind",
        VERIFICATION_LAUNCH_ENVIRONMENT_KINDS,
        LAUNCH_ENVIRONMENT_KIND_ALIASES,
      );
      if (target.environment.stablePorts !== undefined && !Array.isArray(target.environment.stablePorts)) {
        const rawPorts = normalizeStringArrayValue(target.environment.stablePorts) ?? [];
        target.environment.stablePorts = rawPorts.map((port) => Number(port)).filter((port) => Number.isInteger(port));
      }
    }
    if (isRecord(target.readiness)) {
      normalizeField(target.readiness, "status", LAUNCHER_READINESS_STATUSES, LAUNCHER_READINESS_STATUS_ALIASES);
      normalizeRecords(target.readiness.checks, (check) => {
        normalizeField(check, "kind", VERIFICATION_READINESS_CHECK_KINDS, READINESS_KIND_ALIASES);
        normalizeField(check, "status", VERIFICATION_READINESS_CHECK_STATUSES, CHECK_STATUS_ALIASES);
      });
    }
    if (isRecord(target.auth))
      normalizeField(target.auth, "status", VERIFICATION_LAUNCH_AUTH_STATUSES, AUTH_STATUS_ALIASES);
    if (isRecord(target.operatorEntry)) normalizePlainStringArrayField(target.operatorEntry, "notes");
  });
  normalizeRecords(value.setupAttempts, (entry) =>
    normalizeField(entry, "result", VERIFICATION_SETUP_ATTEMPT_RESULTS, SETUP_RESULT_ALIASES),
  );
  normalizeRecords(value.proofAssessments, (entry) => {
    normalizeField(entry, "status", VERIFICATION_LAUNCH_PROOF_ASSESSMENT_STATUSES, LAUNCH_PROOF_STATUS_ALIASES);
    normalizePlainStringArrayField(entry, "launchTargetIds");
    normalizePlainStringArrayField(entry, "evidenceRefs");
  });
  normalizeRecords(value.blockers, (entry) => {
    normalizePlainStringArrayField(entry, "proofIds");
    normalizePlainStringArrayField(entry, "attempts");
  });
  if (!Array.isArray(value.residualRisks)) value.residualRisks = [];
}

function normalizeOperatorArtifact(value: Record<string, unknown>): void {
  if (isRecord(value.summary))
    normalizeField(value.summary, "status", OPERATOR_SUMMARY_STATUSES, OPERATOR_SUMMARY_STATUS_ALIASES);
  normalizePlainStringArrayField(value, "operatedProofIds");
  normalizeRecords(value.proofResults, (entry) => {
    normalizeField(entry, "source", VERIFICATION_OPERATED_PROOF_SOURCES, OPERATED_PROOF_SOURCE_ALIASES);
    normalizeField(entry, "status", VERIFICATION_OPERATED_PROOF_STATUSES, OPERATED_PROOF_STATUS_ALIASES);
    normalizePlainStringArrayField(entry, "launchTargetIds");
    normalizePlainStringArrayField(entry, "steps");
    normalizePlainStringArrayField(entry, "evidenceRefIds");
    normalizeRecords(entry.scenarioTrace, (trace) =>
      normalizeField(trace, "status", VERIFICATION_SCENARIO_STEP_STATUSES, SCENARIO_STEP_STATUS_ALIASES),
    );
    normalizeRecords(entry.scenarioTrace, (trace) => normalizePlainStringArrayField(trace, "evidenceRefIds"));
  });
  normalizeRecords(value.evidenceRefs, (entry) =>
    normalizeField(entry, "type", VERIFICATION_OPERATOR_EVIDENCE_TYPES, ACCEPTABLE_EVIDENCE_TYPE_ALIASES),
  );
  normalizeRecords(value.proofAmendments, (entry) => {
    normalizeOperatorProofAmendment(entry);
  });
  normalizeRecords(value.blockers, (entry) => {
    normalizePlainStringArrayField(entry, "proofIds");
    normalizePlainStringArrayField(entry, "launchTargetIds");
    normalizePlainStringArrayField(entry, "attempts");
  });
  if (!Array.isArray(value.residualRisks)) value.residualRisks = [];
}

function normalizeJudgeArtifact(value: Record<string, unknown>): void {
  normalizeField(value, "verdict", JUDGE_VERDICTS, JUDGE_VERDICT_ALIASES);
  normalizeRecords(value.proofCoverage, (entry) => {
    normalizeField(entry, "status", VERIFICATION_JUDGE_PROOF_STATUSES, JUDGE_PROOF_STATUS_ALIASES);
    normalizeStringArrayField(entry, "sourcePhases", VERIFICATION_PHASE_NAMES, PHASE_NAME_ALIASES);
    normalizePlainStringArrayField(entry, "evidenceRefs");
  });
  normalizeRecords(value.blockers, (entry) =>
    normalizeField(entry, "sourcePhase", VERIFICATION_PHASE_NAMES, PHASE_NAME_ALIASES),
  );
  normalizeRecords(value.blockers, (entry) => {
    normalizePlainStringArrayField(entry, "proofIds");
    normalizePlainStringArrayField(entry, "evidenceRefs");
  });
  normalizePlainStringArrayField(value, "evidence");
  normalizeField(
    value,
    "needsWorkLabel",
    VERIFICATION_JUDGE_NEEDS_WORK_LABELS,
    JUDGE_NEEDS_WORK_LABEL_ALIASES,
    "verification-gap",
  );
}

export function normalizeVerificationPhaseArtifactValue(value: unknown): unknown {
  const normalized = cloneJsonLike(value);
  if (!isRecord(normalized)) return normalized;
  if (normalized.schemaVersion === "1") normalized.schemaVersion = 1;
  normalizeField(normalized, "phase", VERIFICATION_PHASE_NAMES, PHASE_NAME_ALIASES);
  if (normalized.artifactType === undefined && isVerificationPhaseName(normalized.phase)) {
    normalized.artifactType = artifactTypeForVerificationPhase(normalized.phase);
  }
  normalizeField(normalized, "artifactType", VERIFICATION_ARTIFACT_TYPE_VALUES, ARTIFACT_TYPE_ALIASES);
  normalizeField(normalized, "status", PHASE_ARTIFACT_STATUSES, PHASE_STATUS_ALIASES);
  if (normalized.phase === "verification-planner") normalizePlannerArtifact(normalized);
  if (normalized.phase === "verification-launcher") normalizeLauncherArtifact(normalized);
  if (normalized.phase === "verification-operator") normalizeOperatorArtifact(normalized);
  if (normalized.phase === "verification-judge") normalizeJudgeArtifact(normalized);
  return normalized;
}

function validatePlannerTarget(value: Record<string, unknown>): string | null {
  if (!isRecord(value.target)) return "target must be an object";
  const target = value.target;
  const prUrl = typeof target.prUrl === "string" ? target.prUrl : target.targetPrUrl;
  if (!nonEmptyString(prUrl)) return "planner target requires prUrl";
  if (!nonEmptyString(target.headSha)) return "planner target requires headSha";
  if (target.baseSha !== undefined && typeof target.baseSha !== "string") return "target.baseSha must be a string";
  return null;
}

function validatePlannerAppRuntime(value: unknown): string | null {
  if (!isRecord(value)) return "planner appRuntime must be an object";
  if (typeof value.needed !== "boolean") return "planner appRuntime.needed must be a boolean";
  if (!nonEmptyString(value.reason)) return "planner appRuntime.reason is required";
  if (!citationArray(value.evidence)) return "planner appRuntime.evidence must contain evidence citations";
  return null;
}

function validatePlannerArtifact(value: Record<string, unknown>): string | null {
  const commonAllowed = ["schemaVersion", "artifactType", "phase", "target", "decision", "status", "summary"];
  const skipAllowed = [...commonAllowed, "reason", "evidence", "residualRisk"];
  const runAllowed = [...commonAllowed, "verificationReason", "appRuntime", "requiredProof", "residualRisks"];
  if (value.decision === "skip") {
    const extra = unknownKeys(value, skipAllowed);
    if (extra.length > 0) return `planner artifact contains unknown field ${extra[0]}`;
    if (!nonEmptyString(value.reason)) return "planner skip decisions require a concrete reason";
    if (!citationArray(value.evidence)) return "planner skip decisions require evidence citations";
    if (!nonEmptyString(value.residualRisk)) return "planner skip decisions require residualRisk";
    const hasConcreteEvidence = value.evidence.some(
      (entry) => entry.source === "changed_file" || entry.source === "diff" || entry.source === "check",
    );
    if (!hasConcreteEvidence) return "planner skip evidence must cite changed_file, diff, or check evidence";
    if (value.requiredProof !== undefined) return "planner skip decisions must not include requiredProof";
    return null;
  }
  if (value.decision === "run") {
    const extra = unknownKeys(value, runAllowed);
    if (extra.length > 0) return `planner artifact contains unknown field ${extra[0]}`;
    if (!nonEmptyString(value.verificationReason)) return "planner run decisions require verificationReason";
    const runtimeError = validatePlannerAppRuntime(value.appRuntime);
    if (runtimeError) return runtimeError;
    const proofError = validateProofArray(value.requiredProof, "requiredProof");
    if (proofError) return proofError;
    if (!Array.isArray(value.requiredProof) || value.requiredProof.length === 0) {
      return "planner run decisions require at least one requiredProof";
    }
    if (!stringArray(value.residualRisks)) return "planner run decisions require residualRisks";
    return null;
  }
  return "planner decision must be run or skip";
}

function validateLauncherReadinessCheck(value: unknown): string | null {
  if (!isRecord(value)) return "readiness check must be an object";
  if (!nonEmptyString(value.id)) return "readiness check id is required";
  if (!launcherReadinessKind(value.kind)) return `readiness check ${value.id} kind is unsupported`;
  if (!launcherReadinessStatus(value.status)) return `readiness check ${value.id} status is unsupported`;
  if (!nonEmptyString(value.summary)) return `readiness check ${value.id} summary is required`;
  if (value.evidenceRef !== undefined && typeof value.evidenceRef !== "string") {
    return `readiness check ${value.id} evidenceRef must be a string`;
  }
  return null;
}

function validateLauncherTarget(value: unknown): string | null {
  if (!isRecord(value)) return "launch target must be an object";
  if (!nonEmptyString(value.id)) return "launch target id is required";
  if (!nonEmptyString(value.purpose)) return `launch target ${value.id} purpose is required`;
  if (!launcherTargetSourceRef(value.sourceRef)) return `launch target ${value.id} sourceRef is unsupported`;
  if (!stringArray(value.requiredForProofIds) || value.requiredForProofIds.length === 0) {
    return `launch target ${value.id} requiredForProofIds must be non-empty strings`;
  }
  if (value.supportsScenarioStepIds !== undefined && !stringArray(value.supportsScenarioStepIds)) {
    return `launch target ${value.id} supportsScenarioStepIds must be strings`;
  }
  if (!isRecord(value.environment)) return `launch target ${value.id} environment must be an object`;
  if (!launcherEnvironmentKind(value.environment.kind)) {
    return `launch target ${value.id} environment.kind is unsupported`;
  }
  if (value.environment.url !== undefined && typeof value.environment.url !== "string") {
    return `launch target ${value.id} environment.url must be a string`;
  }
  if (value.environment.apiUrl !== undefined && typeof value.environment.apiUrl !== "string") {
    return `launch target ${value.id} environment.apiUrl must be a string`;
  }
  if (
    value.environment.stablePorts !== undefined &&
    (!Array.isArray(value.environment.stablePorts) ||
      value.environment.stablePorts.some((port) => !Number.isInteger(port)))
  ) {
    return `launch target ${value.id} environment.stablePorts must be integers`;
  }
  for (const field of ["runtimeId", "sandboxId", "sessionId"] as const) {
    if (value.environment[field] !== undefined && typeof value.environment[field] !== "string") {
      return `launch target ${value.id} environment.${field} must be a string`;
    }
  }
  if (!isRecord(value.readiness)) return `launch target ${value.id} readiness must be an object`;
  if (
    value.readiness.status !== "ready" &&
    value.readiness.status !== "failed" &&
    value.readiness.status !== "partial" &&
    value.readiness.status !== "not-needed"
  ) {
    return `launch target ${value.id} readiness.status is unsupported`;
  }
  if (!Array.isArray(value.readiness.checks)) return `launch target ${value.id} readiness.checks must be an array`;
  for (const check of value.readiness.checks) {
    const error = validateLauncherReadinessCheck(check);
    if (error) return error;
  }
  if (value.readiness.status === "ready" && value.readiness.checks.length === 0) {
    return `launch target ${value.id} ready target requires readiness evidence`;
  }
  if (!isRecord(value.auth)) return `launch target ${value.id} auth must be an object`;
  if (!launcherAuthStatus(value.auth.status)) return `launch target ${value.id} auth.status is unsupported`;
  if (value.auth.userHint !== undefined && typeof value.auth.userHint !== "string") {
    return `launch target ${value.id} auth.userHint must be a string`;
  }
  if (value.auth.evidenceRef !== undefined && typeof value.auth.evidenceRef !== "string") {
    return `launch target ${value.id} auth.evidenceRef must be a string`;
  }
  if (value.auth.blocker !== undefined && typeof value.auth.blocker !== "string") {
    return `launch target ${value.id} auth.blocker must be a string`;
  }
  if (value.auth.status === "authenticated" && !nonEmptyString(value.auth.evidenceRef)) {
    return `launch target ${value.id} authenticated auth requires evidenceRef`;
  }
  if (!isRecord(value.operatorEntry)) return `launch target ${value.id} operatorEntry must be an object`;
  if (value.operatorEntry.primaryUrl !== undefined && typeof value.operatorEntry.primaryUrl !== "string") {
    return `launch target ${value.id} operatorEntry.primaryUrl must be a string`;
  }
  if (!stringArray(value.operatorEntry.notes)) {
    return `launch target ${value.id} operatorEntry.notes must be strings`;
  }
  if (
    value.readiness.status === "ready" &&
    !nonEmptyString(value.operatorEntry.primaryUrl) &&
    value.operatorEntry.notes.length === 0
  ) {
    return `launch target ${value.id} ready target requires an operator entry`;
  }
  return null;
}

function validateLauncherSetupAttempt(value: unknown): string | null {
  if (!isRecord(value)) return "setup attempt must be an object";
  if (!nonEmptyString(value.targetId)) return "setup attempt targetId is required";
  if (!nonEmptyString(value.action)) return `setup attempt ${value.targetId} action is required`;
  if (!launcherSetupResult(value.result)) return `setup attempt ${value.targetId} result is unsupported`;
  if (!nonEmptyString(value.summary)) return `setup attempt ${value.targetId} summary is required`;
  if (value.outputRef !== undefined && typeof value.outputRef !== "string") {
    return `setup attempt ${value.targetId} outputRef must be a string`;
  }
  if (value.mutatedTrackedSource !== undefined && typeof value.mutatedTrackedSource !== "boolean") {
    return `setup attempt ${value.targetId} mutatedTrackedSource must be a boolean`;
  }
  if (value.result === "passed" && value.mutatedTrackedSource === true) {
    return `setup attempt ${value.targetId} cannot pass after mutating tracked source`;
  }
  return null;
}

function validateLauncherProofAssessment(value: unknown): string | null {
  if (!isRecord(value)) return "launch proof assessment must be an object";
  if (!nonEmptyString(value.proofId)) return "launch proof assessment proofId is required";
  if (!launcherProofAssessmentStatus(value.status)) {
    return `launch proof assessment ${value.proofId} status is unsupported`;
  }
  if (!stringArray(value.launchTargetIds)) {
    return `launch proof assessment ${value.proofId} launchTargetIds must be strings`;
  }
  if (!stringArray(value.evidenceRefs)) {
    return `launch proof assessment ${value.proofId} evidenceRefs must be strings`;
  }
  if (!nonEmptyString(value.explanation)) {
    return `launch proof assessment ${value.proofId} explanation is required`;
  }
  if (value.status === "satisfied-readiness" && value.evidenceRefs.length === 0) {
    return `launch proof assessment ${value.proofId} satisfied-readiness requires evidenceRefs`;
  }
  return null;
}

function validateLauncherBlocker(value: unknown): string | null {
  if (!isRecord(value)) return "launch blocker must be an object";
  if (value.targetId !== undefined && typeof value.targetId !== "string") {
    return "launch blocker targetId must be a string";
  }
  if (!stringArray(value.proofIds) || value.proofIds.length === 0) {
    return "launch blocker proofIds must be non-empty strings";
  }
  if (!nonEmptyString(value.blocker)) return "launch blocker blocker is required";
  if (!stringArray(value.attempts) || value.attempts.length === 0) {
    return "launch blocker attempts must be non-empty strings";
  }
  return null;
}

function validateLauncherArtifact(value: Record<string, unknown>): string | null {
  const allowed = [
    "schemaVersion",
    "artifactType",
    "phase",
    "target",
    "status",
    "summary",
    "effectiveRuntimeNeeded",
    "launchTargets",
    "setupAttempts",
    "proofAssessments",
    "blockers",
    "residualRisks",
    "evidenceRefs",
    "sourceMutations",
  ];
  const extra = unknownKeys(value, allowed);
  if (extra.length > 0) return `launcher artifact contains unknown field ${extra[0]}`;
  if (!isRecord(value.summary)) return "launcher summary must be an object";
  if (!launcherSummaryStatus(value.summary.status)) return "launcher summary.status is unsupported";
  if (!nonEmptyString(value.summary.explanation)) return "launcher summary.explanation is required";
  if (typeof value.effectiveRuntimeNeeded !== "boolean") return "launcher effectiveRuntimeNeeded must be a boolean";
  if (!Array.isArray(value.launchTargets)) return "launcher launchTargets must be an array";
  for (const target of value.launchTargets) {
    const error = validateLauncherTarget(target);
    if (error) return error;
  }
  if (!Array.isArray(value.setupAttempts)) return "launcher setupAttempts must be an array";
  for (const attempt of value.setupAttempts) {
    const error = validateLauncherSetupAttempt(attempt);
    if (error) return error;
  }
  if (!Array.isArray(value.proofAssessments)) return "launcher proofAssessments must be an array";
  for (const assessment of value.proofAssessments) {
    const error = validateLauncherProofAssessment(assessment);
    if (error) return error;
  }
  if (!Array.isArray(value.blockers)) return "launcher blockers must be an array";
  for (const blocker of value.blockers) {
    const error = validateLauncherBlocker(blocker);
    if (error) return error;
  }
  if (!stringArray(value.residualRisks)) return "launcher residualRisks must be an array of strings";
  if (value.effectiveRuntimeNeeded && value.launchTargets.length === 0 && value.blockers.length === 0) {
    return "launcher runtime-needed artifact requires launchTargets or blockers";
  }
  if (value.summary.status === "skipped" && value.effectiveRuntimeNeeded) {
    return "launcher skipped summary requires effectiveRuntimeNeeded false";
  }
  return null;
}

function validateOperatorEvidenceRef(value: unknown): string | null {
  if (!isRecord(value)) return "operator evidence ref must be an object";
  if (!nonEmptyString(value.id)) return "operator evidence ref id is required";
  if (!operatorEvidenceType(value.type)) return `operator evidence ref ${value.id} type is unsupported`;
  if (!nonEmptyString(value.label)) return `operator evidence ref ${value.id} label is required`;
  if (value.location !== undefined && typeof value.location !== "string") {
    return `operator evidence ref ${value.id} location must be a string`;
  }
  if (value.launchTargetId !== undefined && typeof value.launchTargetId !== "string") {
    return `operator evidence ref ${value.id} launchTargetId must be a string`;
  }
  if (!nonEmptyString(value.summary)) return `operator evidence ref ${value.id} summary is required`;
  return null;
}

function validateOperatorScenarioTrace(value: unknown): string | null {
  if (!isRecord(value)) return "operator scenario trace must be an object";
  if (!nonEmptyString(value.stepId)) return "operator scenario trace stepId is required";
  if (!nonEmptyString(value.action)) return `operator scenario trace ${value.stepId} action is required`;
  if (!scenarioStepStatus(value.status)) return `operator scenario trace ${value.stepId} status is unsupported`;
  if (!nonEmptyString(value.observation)) return `operator scenario trace ${value.stepId} observation is required`;
  if (!stringArray(value.evidenceRefIds)) {
    return `operator scenario trace ${value.stepId} evidenceRefIds must be strings`;
  }
  if (value.status === "performed" && value.evidenceRefIds.length === 0) {
    return `operator scenario trace ${value.stepId} performed step requires evidenceRefIds`;
  }
  return null;
}

function validateOperatedProofResult(value: unknown): string | null {
  if (!isRecord(value)) return "operator proof result must be an object";
  if (!nonEmptyString(value.proofId)) return "operator proof result proofId is required";
  if (!operatedProofSource(value.source)) return `operator proof result ${value.proofId} source is unsupported`;
  if (!operatedProofStatus(value.status)) return `operator proof result ${value.proofId} status is unsupported`;
  if (!stringArray(value.launchTargetIds))
    return `operator proof result ${value.proofId} launchTargetIds must be strings`;
  if (!nonEmptyString(value.claim)) return `operator proof result ${value.proofId} claim is required`;
  if (!stringArray(value.steps)) {
    return `operator proof result ${value.proofId} steps must be strings`;
  }
  if (value.steps.length === 0 && value.status !== "not-run") {
    return `operator proof result ${value.proofId} steps must be non-empty strings`;
  }
  if (!nonEmptyString(value.observedBehavior)) {
    return `operator proof result ${value.proofId} observedBehavior is required`;
  }
  if (!stringArray(value.evidenceRefIds)) {
    return `operator proof result ${value.proofId} evidenceRefIds must be strings`;
  }
  if (!nonEmptyString(value.explanation)) return `operator proof result ${value.proofId} explanation is required`;
  if (value.status === "satisfied" && value.evidenceRefIds.length === 0) {
    return `operator proof result ${value.proofId} satisfied proof requires evidenceRefIds`;
  }
  if (value.status === "failed" && !nonEmptyString(value.observedBehavior)) {
    return `operator proof result ${value.proofId} failed proof requires observedBehavior`;
  }
  if (value.scenarioTrace !== undefined) {
    if (!Array.isArray(value.scenarioTrace)) {
      return `operator proof result ${value.proofId} scenarioTrace must be an array`;
    }
    for (const trace of value.scenarioTrace) {
      const error = validateOperatorScenarioTrace(trace);
      if (error) return error;
    }
  }
  return null;
}

function isOperatorProofAmendment(value: unknown): value is VerificationOperatorProofAmendment {
  if (!isRecord(value)) return false;
  if (validateRequiredProof(value.proof) !== null) return false;
  if (!nonEmptyString(value.reason)) return false;
  if (!stringArray(value.evidenceRefIds)) return false;
  if (value.introducedBy !== "verification-operator") return false;
  if (!operatedProofStatus(value.status)) return false;
  return true;
}

function validateOperatorProofAmendment(value: unknown): string | null {
  if (!isOperatorProofAmendment(value)) return "operator proof amendment is invalid";
  if (value.evidenceRefIds.length === 0) {
    return `operator proof amendment ${value.proof.id} requires runtime evidenceRefIds`;
  }
  return null;
}

function validateOperatorBlocker(value: unknown): string | null {
  if (!isRecord(value)) return "operator blocker must be an object";
  if (!stringArray(value.proofIds) || value.proofIds.length === 0) {
    return "operator blocker proofIds must be non-empty strings";
  }
  if (!stringArray(value.launchTargetIds)) return "operator blocker launchTargetIds must be strings";
  if (!nonEmptyString(value.blocker)) return "operator blocker blocker is required";
  if (!stringArray(value.attempts) || value.attempts.length === 0) {
    return "operator blocker attempts must be non-empty strings";
  }
  return null;
}

function validateOperatorArtifact(value: Record<string, unknown>): string | null {
  const allowed = [
    "schemaVersion",
    "artifactType",
    "phase",
    "target",
    "status",
    "summary",
    "operatedProofIds",
    "proofResults",
    "evidenceRefs",
    "proofAmendments",
    "blockers",
    "mutationGuard",
    "residualRisks",
    "sourceMutations",
  ];
  const extra = unknownKeys(value, allowed);
  if (extra.length > 0) return `operator artifact contains unknown field ${extra[0]}`;
  if (!isRecord(value.summary)) return "operator summary must be an object";
  if (!operatorSummaryStatus(value.summary.status)) return "operator summary.status is unsupported";
  if (!nonEmptyString(value.summary.explanation)) return "operator summary.explanation is required";
  if (!stringArray(value.operatedProofIds)) return "operator operatedProofIds must be strings";
  if (!Array.isArray(value.evidenceRefs)) return "operator evidenceRefs must be an array";
  const evidenceIds = new Set<string>();
  for (const evidenceRef of value.evidenceRefs) {
    const error = validateOperatorEvidenceRef(evidenceRef);
    if (error) return error;
    if (isRecord(evidenceRef)) {
      const evidenceId = String(evidenceRef.id);
      if (evidenceIds.has(evidenceId)) return `operator evidenceRefs contains duplicate id ${evidenceId}`;
      evidenceIds.add(evidenceId);
    }
  }
  if (!Array.isArray(value.proofResults)) return "operator proofResults must be an array";
  const resultProofIds = new Set<string>();
  for (const result of value.proofResults) {
    const error = validateOperatedProofResult(result);
    if (error) return error;
    if (!isRecord(result)) continue;
    const proofId = String(result.proofId);
    if (resultProofIds.has(proofId)) return `operator proofResults contains duplicate proof ${proofId}`;
    resultProofIds.add(proofId);
    const refs = Array.isArray(result.evidenceRefIds) ? result.evidenceRefIds : [];
    for (const evidenceRefId of refs) {
      if (!evidenceIds.has(String(evidenceRefId))) {
        return `operator proof result ${proofId} references unknown evidence ${String(evidenceRefId)}`;
      }
    }
    const traces = Array.isArray(result.scenarioTrace) ? result.scenarioTrace : [];
    for (const trace of traces) {
      if (!isRecord(trace)) continue;
      const traceRefs = Array.isArray(trace.evidenceRefIds) ? trace.evidenceRefIds : [];
      for (const evidenceRefId of traceRefs) {
        if (!evidenceIds.has(String(evidenceRefId))) {
          return `operator scenario trace ${String(trace.stepId)} references unknown evidence ${String(evidenceRefId)}`;
        }
      }
    }
  }
  for (const proofId of value.operatedProofIds) {
    if (!resultProofIds.has(proofId)) return `operator operated proof ${proofId} is missing proofResults entry`;
  }
  if (!Array.isArray(value.proofAmendments)) return "operator proofAmendments must be an array";
  const amendmentProofIds = new Set<string>();
  for (const amendment of value.proofAmendments) {
    const error = validateOperatorProofAmendment(amendment);
    if (error) return error;
    if (!isRecord(amendment) || !isRecord(amendment.proof)) continue;
    const proofId = String(amendment.proof.id);
    if (amendmentProofIds.has(proofId)) return `operator proofAmendments contains duplicate proof ${proofId}`;
    amendmentProofIds.add(proofId);
    for (const evidenceRefId of amendment.evidenceRefIds as string[]) {
      if (!evidenceIds.has(evidenceRefId)) {
        return `operator proof amendment ${proofId} references unknown evidence ${evidenceRefId}`;
      }
    }
  }
  if (!Array.isArray(value.blockers)) return "operator blockers must be an array";
  for (const blocker of value.blockers) {
    const error = validateOperatorBlocker(blocker);
    if (error) return error;
  }
  for (const result of value.proofResults) {
    if (!isRecord(result)) continue;
    if (result.status !== "blocked" && result.status !== "not-run") continue;
    const proofId = String(result.proofId);
    if (result.status === "not-run" && !value.operatedProofIds.includes(proofId)) continue;
    const hasBlocker = value.blockers.some(
      (blocker) => isRecord(blocker) && Array.isArray(blocker.proofIds) && blocker.proofIds.includes(proofId),
    );
    if (!hasBlocker) return `operator proof result ${proofId} ${result.status} proof requires blocker attempts`;
  }
  if (value.mutationGuard !== undefined) {
    if (!isRecord(value.mutationGuard)) return "operator mutationGuard must be an object";
    if (typeof value.mutationGuard.checked !== "boolean") return "operator mutationGuard.checked must be a boolean";
    if (typeof value.mutationGuard.mutatedTrackedSource !== "boolean") {
      return "operator mutationGuard.mutatedTrackedSource must be a boolean";
    }
    if (!nonEmptyString(value.mutationGuard.summary)) return "operator mutationGuard.summary is required";
  }
  if (!stringArray(value.residualRisks)) return "operator residualRisks must be an array of strings";
  if (value.summary.status === "satisfied") {
    const unresolved = value.proofResults.find(
      (result) =>
        isRecord(result) && (result.status === "failed" || result.status === "blocked" || result.status === "not-run"),
    );
    if (unresolved && isRecord(unresolved)) {
      return `operator satisfied summary cannot include ${String(unresolved.status)} proof ${String(unresolved.proofId)}`;
    }
  }
  if (value.summary.status === "skipped" && (value.operatedProofIds.length > 0 || value.proofResults.length > 0)) {
    return "operator skipped summary cannot include operated proof results";
  }
  return null;
}

const JUDGE_ARTIFACT_FIELDS = new Set([
  "schemaVersion",
  "artifactType",
  "phase",
  "target",
  "verdict",
  "verifiedHeadSha",
  "computedAgainstHeadSha",
  "summary",
  "proofCoverage",
  "evidence",
  "blockers",
  "needsWorkLabel",
  "residualRisks",
]);

function validateJudgeArtifact(value: Record<string, unknown>): string | null {
  const unknownField = Object.keys(value).find((field) => !JUDGE_ARTIFACT_FIELDS.has(field));
  if (unknownField) return `judge artifact contains unknown field ${unknownField}`;
  const targetError = validatePlannerTarget(value);
  if (targetError) return targetError.replace("planner", "judge");
  if (value.verdict !== "CONCLUSIVE" && value.verdict !== "INCONCLUSIVE") {
    return "judge verdict must be CONCLUSIVE or INCONCLUSIVE";
  }
  if (!nonEmptyString(value.verifiedHeadSha)) return "judge verifiedHeadSha is required";
  if (!nonEmptyString(value.computedAgainstHeadSha)) return "judge computedAgainstHeadSha is required";
  const target = isRecord(value.target) ? value.target : {};
  const targetHeadSha = typeof target.headSha === "string" ? target.headSha : "";
  if (targetHeadSha && value.computedAgainstHeadSha !== targetHeadSha) {
    return "judge computedAgainstHeadSha must match target.headSha";
  }
  if (!nonEmptyString(value.summary)) return "judge summary is required";
  if (!Array.isArray(value.proofCoverage) || value.proofCoverage.some((entry) => !isJudgeCoverage(entry))) {
    return "judge proofCoverage must contain judge proof coverage objects";
  }
  if (!stringArray(value.evidence)) return "judge evidence must be an array of strings";
  if (!Array.isArray(value.blockers) || value.blockers.some((entry) => !isJudgeBlocker(entry))) {
    return "judge blockers must contain judge blocker objects";
  }
  if (value.needsWorkLabel !== undefined && !judgeNeedsWorkLabel(value.needsWorkLabel)) {
    return "judge needsWorkLabel is unsupported";
  }
  if (value.verdict === "CONCLUSIVE" && value.needsWorkLabel !== undefined) {
    return "judge CONCLUSIVE verdict must not include needsWorkLabel";
  }
  if (value.verdict === "CONCLUSIVE" && value.blockers.length > 0) {
    return "judge CONCLUSIVE verdict must not include blockers";
  }
  if (value.verdict === "INCONCLUSIVE" && value.needsWorkLabel === undefined) {
    return "judge INCONCLUSIVE verdict must include needsWorkLabel";
  }
  if (!stringArray(value.residualRisks)) return "judge residualRisks must be an array of strings";
  return null;
}

export function makeMinimalVerificationPhaseArtifact(input: {
  phase: VerificationPhaseName;
  targetPrUrl: string;
  headSha: string;
  baseSha?: string;
  status?: MinimalVerificationPhaseArtifact["status"];
  summary?: MinimalVerificationPhaseArtifact["summary"];
  blockers?: unknown;
  [key: string]: unknown;
}): MinimalVerificationPhaseArtifact {
  const { phase, targetPrUrl, headSha, baseSha, status, summary, blockers, ...rest } = input;
  return {
    schemaVersion: 1,
    artifactType: artifactTypeForVerificationPhase(phase),
    phase,
    target: { targetPrUrl, prUrl: targetPrUrl, headSha, ...(baseSha ? { baseSha } : {}) },
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
    ...(blockers !== undefined ? { blockers } : {}),
    ...rest,
  };
}

export function validateMinimalVerificationPhaseArtifact(
  input: unknown,
  expectedPhase?: VerificationPhaseName,
): VerificationPhaseValidationResult {
  const value = normalizeVerificationPhaseArtifactValue(input);
  if (!isRecord(value)) return { ok: false, error: "artifact must be an object" };
  if (value.schemaVersion !== 1) return { ok: false, error: "schemaVersion must be 1" };
  if (!isVerificationPhaseName(value.phase)) return { ok: false, error: "phase is not a verification phase" };
  if (expectedPhase && value.phase !== expectedPhase) {
    return { ok: false, error: `artifact phase ${value.phase} does not match expected ${expectedPhase}` };
  }
  if (!isVerificationPhaseArtifactType(value.artifactType)) {
    return { ok: false, error: "artifactType is not a canonical verification artifact type" };
  }
  const expectedType = artifactTypeForVerificationPhase(value.phase);
  if (value.artifactType !== expectedType) {
    return { ok: false, error: `artifactType ${value.artifactType} does not match phase ${value.phase}` };
  }
  if (!isRecord(value.target)) return { ok: false, error: "target must be an object" };
  if (value.phase === "verification-planner") {
    const targetError = validatePlannerTarget(value);
    if (targetError) return { ok: false, error: targetError };
  }
  if (value.phase === "verification-launcher" || value.phase === "verification-operator") {
    const targetError = validatePlannerTarget(value);
    if (targetError) return { ok: false, error: targetError.replace("planner", value.phase.split("-")[1] ?? "phase") };
  }
  if (value.target.targetPrUrl !== undefined && typeof value.target.targetPrUrl !== "string") {
    return { ok: false, error: "target.targetPrUrl must be a string when present" };
  }
  if (value.target.prUrl !== undefined && typeof value.target.prUrl !== "string") {
    return { ok: false, error: "target.prUrl must be a string when present" };
  }
  if (value.target.headSha !== undefined && typeof value.target.headSha !== "string") {
    return { ok: false, error: "target.headSha must be a string when present" };
  }
  if (
    value.status !== undefined &&
    value.status !== "completed" &&
    value.status !== "skipped" &&
    value.status !== "blocked"
  ) {
    return { ok: false, error: "status must be completed, skipped, or blocked when present" };
  }
  if (
    value.summary !== undefined &&
    value.phase !== "verification-launcher" &&
    value.phase !== "verification-operator" &&
    typeof value.summary !== "string"
  ) {
    return { ok: false, error: "summary must be a string when present" };
  }
  if (
    value.phase !== "verification-operator" &&
    value.evidenceRefs !== undefined &&
    (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((entry) => typeof entry !== "string"))
  ) {
    return { ok: false, error: "evidenceRefs must be an array of strings when present" };
  }
  if (
    value.phase !== "verification-launcher" &&
    value.phase !== "verification-operator" &&
    value.phase !== "verification-judge" &&
    value.blockers !== undefined &&
    (!Array.isArray(value.blockers) || value.blockers.some((entry) => typeof entry !== "string"))
  ) {
    return { ok: false, error: "blockers must be an array of strings when present" };
  }
  if (value.phase === "verification-planner") {
    const plannerError = validatePlannerArtifact(value);
    if (plannerError) return { ok: false, error: plannerError };
  }
  if (value.phase === "verification-launcher") {
    const launcherError = validateLauncherArtifact(value);
    if (launcherError) return { ok: false, error: launcherError };
  }
  if (value.phase === "verification-operator") {
    const operatorError = validateOperatorArtifact(value);
    if (operatorError) return { ok: false, error: operatorError };
  }
  if (value.phase === "verification-judge") {
    const judgeError = validateJudgeArtifact(value);
    if (judgeError) return { ok: false, error: judgeError };
  }
  return { ok: true, artifact: value as MinimalVerificationPhaseArtifact };
}

function proofDefinitionKey(proof: VerificationRequiredProof): string {
  return JSON.stringify({
    claim: proof.claim,
    whyRequired: proof.whyRequired,
    evidenceDomain: proof.evidenceDomain,
    evidenceStandard: proof.evidenceStandard,
    acceptableEvidenceTypes: proof.acceptableEvidenceTypes,
    proofScenario: proof.proofScenario ?? null,
    mustUseSameFlowAsUser: proof.mustUseSameFlowAsUser ?? null,
    beforeAfter: proof.beforeAfter ?? null,
  });
}

function addProof(
  map: Map<string, EffectiveVerificationProof>,
  proof: VerificationRequiredProof,
  sourcePhase: VerificationPhaseName,
): string | null {
  const existing = map.get(proof.id);
  if (existing) {
    if (proofDefinitionKey(existing) !== proofDefinitionKey(proof)) {
      return `proof ${proof.id} has conflicting definitions`;
    }
    if (!existing.sourcePhases.includes(sourcePhase)) existing.sourcePhases.push(sourcePhase);
    return null;
  }
  map.set(proof.id, {
    ...proof,
    sourcePhases: [sourcePhase],
    status:
      proof.evidenceDomain === "static" || proof.evidenceDomain === "diff-inspection" ? "pending" : "needs-runtime",
    evidenceRefs: [],
  });
  return null;
}

function applyLauncherAssessments(map: Map<string, EffectiveVerificationProof>, assessments: unknown): string | null {
  if (assessments === undefined) return null;
  if (!Array.isArray(assessments)) return "verification-launcher proof assessments must be an array";
  for (const assessment of assessments) {
    const error = validateLauncherProofAssessment(assessment);
    if (error) return error;
    if (!isRecord(assessment)) return "verification-launcher proof assessments are invalid";
    const typed = assessment as VerificationLaunchProofAssessment;
    const proof = map.get(typed.proofId);
    if (!proof) return `verification-launcher assessed unknown proof ${typed.proofId}`;
    if (!proof.sourcePhases.includes("verification-launcher")) proof.sourcePhases.push("verification-launcher");
    if (typed.status === "satisfied-readiness") proof.status = "satisfied";
    if (typed.status === "unsatisfied-needs-operator") proof.status = "unsatisfied-needs-operator";
    if (typed.status === "failed") proof.status = "failed";
    if (typed.status === "blocked") proof.status = "blocked";
    proof.evidenceRefs = [...new Set([...proof.evidenceRefs, ...typed.evidenceRefs])];
    if ((typed.status === "failed" || typed.status === "blocked") && typed.explanation) {
      proof.blocker = typed.explanation;
    }
  }
  return null;
}

function applyOperatorResults(map: Map<string, EffectiveVerificationProof>, results: unknown): string | null {
  if (results === undefined) return null;
  if (!Array.isArray(results)) return "verification-operator proof results must be an array";
  for (const result of results) {
    const error = validateOperatedProofResult(result);
    if (error) return error;
    if (!isRecord(result)) return "verification-operator proof results are invalid";
    const typed = result as VerificationOperatedProofResult;
    const proof = map.get(typed.proofId);
    if (!proof) return `verification-operator assessed unknown proof ${typed.proofId}`;
    if (!proof.sourcePhases.includes("verification-operator")) proof.sourcePhases.push("verification-operator");
    proof.status = typed.status === "not-run" ? "blocked" : typed.status;
    proof.evidenceRefs = [...new Set([...proof.evidenceRefs, ...typed.evidenceRefIds])];
    if (typed.status === "failed" || typed.status === "blocked" || typed.status === "not-run") {
      proof.blocker = typed.explanation;
    }
  }
  return null;
}

export function buildEffectiveVerificationProofContract(
  artifacts: readonly VerificationPhaseArtifactRecord[],
): EffectiveVerificationProofContract {
  const proofMap = new Map<string, EffectiveVerificationProof>();
  for (const record of artifacts) {
    const artifact = record.artifact;
    if (record.phase === "verification-planner" && artifact.decision === "run") {
      const proofs = Array.isArray(artifact.requiredProof) ? artifact.requiredProof : [];
      for (const proof of proofs) {
        const proofError = validateRequiredProof(proof);
        if (proofError) return { ok: false, error: `planner requiredProof contains invalid proof: ${proofError}` };
        const error = addProof(proofMap, proof, "verification-planner");
        if (error) return { ok: false, error };
      }
    }
    if (record.phase === "verification-operator") {
      const amendments = Array.isArray(artifact.proofAmendments) ? artifact.proofAmendments : [];
      for (const amendment of amendments) {
        if (!isOperatorProofAmendment(amendment)) {
          return { ok: false, error: "verification-operator proofAmendments contain invalid amendment" };
        }
        const error = addProof(proofMap, amendment.proof, record.phase);
        if (error) return { ok: false, error };
        const proof = proofMap.get(amendment.proof.id);
        if (proof && amendment.status !== "not-run") {
          proof.status = amendment.status;
          proof.evidenceRefs = [...new Set([...proof.evidenceRefs, ...amendment.evidenceRefIds])];
          if (amendment.status === "failed" || amendment.status === "blocked") proof.blocker = amendment.reason;
        }
      }
    }
    if (record.phase === "verification-launcher") {
      const error = applyLauncherAssessments(proofMap, artifact.proofAssessments);
      if (error) return { ok: false, error };
    }
    if (record.phase === "verification-operator") {
      const error = applyOperatorResults(proofMap, artifact.proofResults);
      if (error) return { ok: false, error };
    }
  }
  return { ok: true, proofs: [...proofMap.values()] };
}

export function validateLauncherArtifactAgainstProofContract(
  artifact: MinimalVerificationPhaseArtifact,
  contract: EffectiveVerificationProofContract,
): string | null {
  if (artifact.phase !== "verification-launcher") return null;
  if (!contract.ok) return contract.error;
  const knownProofIds = new Set(contract.proofs.map((proof) => proof.id));
  const targets = Array.isArray(artifact.launchTargets) ? artifact.launchTargets : [];
  for (const target of targets) {
    if (!isRecord(target)) continue;
    const targetId = String(target.id ?? "");
    const proofIds = Array.isArray(target.requiredForProofIds) ? target.requiredForProofIds : [];
    for (const proofId of proofIds) {
      if (!knownProofIds.has(String(proofId))) {
        return `launch target ${targetId} references unknown proof ${String(proofId)}`;
      }
      const proof = contract.proofs.find((candidate) => candidate.id === proofId);
      if (proof?.proofScenario) {
        const supportsScenarioStepIds = Array.isArray(target.supportsScenarioStepIds)
          ? target.supportsScenarioStepIds
          : [];
        const operatorEntry = isRecord(target.operatorEntry) ? target.operatorEntry : {};
        const notes = Array.isArray(operatorEntry.notes) ? operatorEntry.notes : [];
        if (supportsScenarioStepIds.length === 0 && !nonEmptyString(operatorEntry.primaryUrl) && notes.length === 0) {
          return `launch target ${targetId} must identify how structured scenario proof ${proofId} can be entered`;
        }
      }
    }
  }
  const assessments = Array.isArray(artifact.proofAssessments) ? artifact.proofAssessments : [];
  for (const assessment of assessments) {
    if (!isRecord(assessment)) continue;
    if (!knownProofIds.has(String(assessment.proofId))) {
      return `launcher proof assessment references unknown proof ${String(assessment.proofId)}`;
    }
  }
  const blockers = Array.isArray(artifact.blockers) ? artifact.blockers : [];
  for (const blocker of blockers) {
    if (!isRecord(blocker)) continue;
    const proofIds = Array.isArray(blocker.proofIds) ? blocker.proofIds : [];
    for (const proofId of proofIds) {
      if (!knownProofIds.has(String(proofId))) {
        return `launcher blocker references unknown proof ${String(proofId)}`;
      }
    }
  }
  for (const proof of contract.proofs) {
    if (proof.evidenceDomain !== "runtime-readiness" && proof.status !== "unsatisfied-needs-launcher") continue;
    const assessment = assessments.find((entry) => isRecord(entry) && entry.proofId === proof.id) as
      Record<string, unknown> | undefined;
    if (!assessment) return `launcher-needed proof ${proof.id} requires a launcher proof assessment`;
    if (
      assessment.status !== "satisfied-readiness" &&
      assessment.status !== "unsatisfied-needs-operator" &&
      assessment.status !== "blocked" &&
      assessment.status !== "failed"
    ) {
      return `launcher-needed proof ${proof.id} requires satisfied, operator-forwarded, blocked, or failed launcher assessment`;
    }
  }
  return null;
}

function operatorDomainProofNeedsResult(proof: EffectiveVerificationProof): boolean {
  return (
    proof.status === "unsatisfied-needs-operator" ||
    proof.status === "needs-runtime" ||
    (proof.status === "pending" &&
      (proof.evidenceDomain === "interactive-flow" ||
        proof.evidenceDomain === "auth-or-integration" ||
        proof.evidenceDomain === "sandbox-or-session" ||
        proof.evidenceDomain === "side-effect"))
  );
}

function launcherTargetSourceById(artifacts: readonly VerificationPhaseArtifactRecord[]): Map<string, string> {
  const targetSources = new Map<string, string>();
  for (const record of artifacts) {
    if (record.phase !== "verification-launcher") continue;
    const targets = Array.isArray(record.artifact.launchTargets) ? record.artifact.launchTargets : [];
    for (const target of targets) {
      if (!isRecord(target) || !nonEmptyString(target.id) || !nonEmptyString(target.sourceRef)) continue;
      targetSources.set(target.id, target.sourceRef);
    }
  }
  return targetSources;
}

export function validateOperatorArtifactAgainstProofContract(
  artifact: MinimalVerificationPhaseArtifact,
  contract: EffectiveVerificationProofContract,
  priorArtifacts: readonly VerificationPhaseArtifactRecord[] = [],
): string | null {
  if (artifact.phase !== "verification-operator") return null;
  if (!contract.ok) return contract.error;
  const knownProofIds = new Set(contract.proofs.map((proof) => proof.id));
  const amendmentProofIds = new Set<string>();
  const amendments = Array.isArray(artifact.proofAmendments) ? artifact.proofAmendments : [];
  for (const amendment of amendments) {
    if (!isOperatorProofAmendment(amendment)) return "operator proofAmendments contain invalid amendment";
    if (knownProofIds.has(amendment.proof.id))
      return `operator proof amendment duplicates existing proof ${amendment.proof.id}`;
    if (amendmentProofIds.has(amendment.proof.id)) {
      return `operator proofAmendments contains duplicate proof ${amendment.proof.id}`;
    }
    amendmentProofIds.add(amendment.proof.id);
  }
  const allProofIds = new Set([...knownProofIds, ...amendmentProofIds]);
  const evidenceRefs = Array.isArray(artifact.evidenceRefs) ? artifact.evidenceRefs : [];
  const evidenceById = new Map<string, VerificationOperatorEvidenceRef>();
  for (const evidenceRef of evidenceRefs) {
    if (isRecord(evidenceRef) && nonEmptyString(evidenceRef.id)) {
      evidenceById.set(evidenceRef.id, evidenceRef as VerificationOperatorEvidenceRef);
    }
  }
  const targetSources = launcherTargetSourceById(priorArtifacts);
  const proofResults = Array.isArray(artifact.proofResults) ? artifact.proofResults : [];
  const resultsByProof = new Map<string, VerificationOperatedProofResult>();
  for (const result of proofResults) {
    if (!isRecord(result)) continue;
    const proofId = String(result.proofId ?? "");
    if (!allProofIds.has(proofId)) return `operator proof result references unknown proof ${proofId}`;
    const typedResult = result as VerificationOperatedProofResult;
    resultsByProof.set(proofId, typedResult);
    for (const launchTargetId of typedResult.launchTargetIds) {
      if (!targetSources.has(String(launchTargetId))) {
        return `operator proof result ${proofId} references unknown launcher target ${String(launchTargetId)}`;
      }
    }
    if (typedResult.status === "satisfied" && typedResult.launchTargetIds.length === 0) {
      return `operator proof result ${proofId} satisfied proof requires launcher-provided handles`;
    }
    const proof = contract.proofs.find((candidate) => candidate.id === proofId);
    if (proof?.proofScenario && typedResult.status === "satisfied") {
      if (!Array.isArray(typedResult.scenarioTrace) || typedResult.scenarioTrace.length === 0) {
        return `operator proof result ${proofId} satisfied structured scenario proof requires scenarioTrace`;
      }
      const tracedSteps = new Set(typedResult.scenarioTrace.map((trace) => trace.stepId));
      const missingStep = proof.proofScenario.steps.find((step) => !tracedSteps.has(step.id));
      if (missingStep) return `operator proof result ${proofId} scenarioTrace is missing step ${missingStep.id}`;
    }
    if (proof?.beforeAfter?.required === true && typedResult.status === "satisfied") {
      const resultEvidence = typedResult.evidenceRefIds
        .map((evidenceRefId) => evidenceById.get(evidenceRefId)?.launchTargetId)
        .filter((launchTargetId): launchTargetId is string => typeof launchTargetId === "string");
      const sources = new Set(resultEvidence.map((launchTargetId) => targetSources.get(launchTargetId)));
      if (!sources.has("base") || !sources.has("head")) {
        return `operator proof result ${proofId} before/after proof requires separate base and head evidence`;
      }
    }
  }
  const operatedProofIds = Array.isArray(artifact.operatedProofIds) ? artifact.operatedProofIds : [];
  for (const proofId of operatedProofIds) {
    if (!allProofIds.has(String(proofId)))
      return `operator operatedProofIds references unknown proof ${String(proofId)}`;
    if (!resultsByProof.has(String(proofId)))
      return `operator operated proof ${String(proofId)} is missing proofResults entry`;
  }
  for (const proof of contract.proofs) {
    if (!operatorDomainProofNeedsResult(proof)) continue;
    if (!resultsByProof.has(proof.id)) return `operator proofResults missing required proof ${proof.id}`;
  }
  const blockers = Array.isArray(artifact.blockers) ? artifact.blockers : [];
  for (const blocker of blockers) {
    if (!isRecord(blocker)) continue;
    const proofIds = Array.isArray(blocker.proofIds) ? blocker.proofIds : [];
    for (const proofId of proofIds) {
      if (!allProofIds.has(String(proofId))) return `operator blocker references unknown proof ${String(proofId)}`;
    }
    const launchTargetIds = Array.isArray(blocker.launchTargetIds) ? blocker.launchTargetIds : [];
    for (const launchTargetId of launchTargetIds) {
      if (!targetSources.has(String(launchTargetId))) {
        return `operator blocker references unknown launcher target ${String(launchTargetId)}`;
      }
    }
  }
  return null;
}

export function validateJudgeProofCoverage(
  artifact: MinimalVerificationPhaseArtifact,
  contract: EffectiveVerificationProofContract,
): string | null {
  if (artifact.phase !== "verification-judge") return null;
  if (!contract.ok) return contract.error;
  const shapeError = validateJudgeArtifact(artifact);
  if (shapeError) return shapeError;
  const coverage = artifact.proofCoverage;
  if (!Array.isArray(coverage)) return "judge proofCoverage is required";
  if (coverage.length !== contract.proofs.length) {
    return "judge proofCoverage must include exactly one record per effective proof";
  }
  const seen = new Set<string>();
  for (const entry of coverage) {
    if (!isJudgeCoverage(entry)) return "judge proofCoverage contains invalid coverage";
    if (seen.has(entry.proofId)) return `judge proofCoverage contains duplicate proof ${entry.proofId}`;
    seen.add(entry.proofId);
    const proof = contract.proofs.find((candidate) => candidate.id === entry.proofId);
    if (!proof) return `judge proofCoverage contains unknown proof ${entry.proofId}`;
    if (entry.status === "satisfied" && entry.evidenceRefs.length === 0) {
      return `judge proofCoverage satisfied proof ${entry.proofId} without evidenceRefs`;
    }
    if (entry.status === "satisfied" && proof.status !== "satisfied") {
      return `judge proofCoverage cannot satisfy proof ${entry.proofId} because effective proof status is ${proof.status}`;
    }
    if (entry.status === "satisfied") {
      const knownEvidenceRefs = new Set(proof.evidenceRefs);
      const unknownEvidenceRef = entry.evidenceRefs.find((evidenceRef) => !knownEvidenceRefs.has(evidenceRef));
      if (unknownEvidenceRef) {
        return `judge proofCoverage proof ${entry.proofId} cites unknown evidence ref ${unknownEvidenceRef}`;
      }
    }
    if (entry.status === "satisfied" && proof.proofScenario) {
      const missingStep = proof.proofScenario.steps.find((step) => {
        if (entry.assessment.includes(step.id)) return false;
        return !entry.evidenceRefs.some((evidenceRef) => evidenceRef.includes(step.id));
      });
      if (missingStep) {
        return `judge proofCoverage satisfied structured scenario proof ${entry.proofId} without scenario-step evidence ${missingStep.id}`;
      }
    }
  }
  const missing = contract.proofs.find((proof) => !seen.has(proof.id));
  if (missing) return `judge proofCoverage is missing proof ${missing.id}`;

  const blockers = Array.isArray(artifact.blockers) ? artifact.blockers : [];
  const knownProofIds = new Set(contract.proofs.map((proof) => proof.id));
  for (const blocker of blockers) {
    if (!isJudgeBlocker(blocker)) return "judge blockers contain invalid blocker";
    for (const proofId of blocker.proofIds) {
      if (!knownProofIds.has(proofId)) return `judge blocker references unknown proof ${proofId}`;
    }
  }

  const nonSatisfiedCoverage = coverage.filter((entry): entry is VerificationJudgeProofCoverage => {
    return isJudgeCoverage(entry) && entry.status !== "satisfied";
  });
  if (artifact.verdict === "CONCLUSIVE" && nonSatisfiedCoverage.length > 0) {
    return `judge CONCLUSIVE verdict includes unresolved proof ${nonSatisfiedCoverage[0]?.proofId}`;
  }
  if (artifact.verdict === "INCONCLUSIVE" && nonSatisfiedCoverage.length > 0 && blockers.length === 0) {
    return "judge INCONCLUSIVE verdict with unresolved proof must include blockers";
  }
  return null;
}

export function parseVerificationPhaseArtifactOutput(rawOutput: string): ParsedVerificationPhaseOutput {
  const fencePattern = new RegExp("```" + VERIFICATION_PHASE_ARTIFACT_FENCE + "\\s*([\\s\\S]*?)```", "gi");
  const matches = [...rawOutput.matchAll(fencePattern)];
  if (matches.length > 0) {
    let lastParseError = "";
    for (const match of matches.reverse()) {
      const json = match[1]?.trim() ?? "";
      if (!json) {
        lastParseError = "phase artifact fence was empty";
        continue;
      }
      try {
        return { ok: true, artifact: normalizeVerificationPhaseArtifactValue(JSON.parse(json) as unknown) };
      } catch (error) {
        lastParseError = `phase artifact JSON was malformed: ${String(error)}`;
      }
    }
    return {
      ok: false,
      error: lastParseError || `expected a parseable ${VERIFICATION_PHASE_ARTIFACT_FENCE} JSON fence`,
    };
  }
  const json = rawOutput.trim();
  if (!json.startsWith("{") || !json.endsWith("}")) {
    return { ok: false, error: `expected a ${VERIFICATION_PHASE_ARTIFACT_FENCE} JSON fence` };
  }
  try {
    return { ok: true, artifact: normalizeVerificationPhaseArtifactValue(JSON.parse(json) as unknown) };
  } catch (error) {
    return { ok: false, error: `phase artifact JSON was malformed outside fence: ${String(error)}` };
  }
}

export function parseVerificationLauncherArtifactOutput(
  rawOutput: string,
): { ok: true; artifact: VerificationLauncherArtifact } | { ok: false; error: string } {
  const parsed = parseVerificationPhaseArtifactOutput(rawOutput);
  if (!parsed.ok) return parsed;
  const validation = validateMinimalVerificationPhaseArtifact(parsed.artifact, "verification-launcher");
  if (!validation.ok) return validation;
  return { ok: true, artifact: validation.artifact as VerificationLauncherArtifact };
}

export function parseVerificationOperatorArtifactOutput(
  rawOutput: string,
): { ok: true; artifact: VerificationOperatorArtifact } | { ok: false; error: string } {
  const parsed = parseVerificationPhaseArtifactOutput(rawOutput);
  if (!parsed.ok) return parsed;
  const validation = validateMinimalVerificationPhaseArtifact(parsed.artifact, "verification-operator");
  if (!validation.ok) return validation;
  return { ok: true, artifact: validation.artifact as VerificationOperatorArtifact };
}

const REDACTED_VERIFICATION_ARTIFACT_VALUE = "[REDACTED_VERIFICATION_SECRET]";
const SECRET_FIELD_PATTERN =
  /(^|[_-])(authorization|cookie|session_cookie|access_token|refresh_token|api_key|secret|password|oauth_token|bearer)([_-]|$)/i;
const SECRET_CAMEL_FIELD_PATTERN =
  /^(authorization|cookie|accessToken|refreshToken|apiKey|secret|password|oauthToken|bearerToken)$/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\b(?:access_token|refresh_token|api_key|secret|password|cookie)=([^&\s]+)/gi,
];

function redactVerificationArtifactString(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED_VERIFICATION_ARTIFACT_VALUE),
    value,
  );
}

function redactVerificationArtifactValue(value: unknown, fieldName?: string): unknown {
  if (fieldName && (SECRET_FIELD_PATTERN.test(fieldName) || SECRET_CAMEL_FIELD_PATTERN.test(fieldName))) {
    return REDACTED_VERIFICATION_ARTIFACT_VALUE;
  }
  if (typeof value === "string") return redactVerificationArtifactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactVerificationArtifactValue(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactVerificationArtifactValue(entry, key)]),
  );
}

export function redactVerificationPhaseArtifactForPersistence(
  artifact: MinimalVerificationPhaseArtifact,
): MinimalVerificationPhaseArtifact {
  return redactVerificationArtifactValue(artifact) as MinimalVerificationPhaseArtifact;
}

export function redactVerificationPhaseOutputForPersistence(output: string): string {
  return redactVerificationArtifactString(output);
}

export function buildVerificationPhaseArtifactRecord(input: {
  runId: string;
  sessionId: string;
  promptId: string;
  phase: VerificationPhaseName;
  attempt: number;
  artifact: MinimalVerificationPhaseArtifact;
  createdAt?: string;
}): VerificationPhaseArtifactRecord {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    promptId: input.promptId,
    phase: input.phase,
    artifactType: artifactTypeForVerificationPhase(input.phase),
    attempt: input.attempt,
    artifact: redactVerificationPhaseArtifactForPersistence(input.artifact),
    note: input.createdAt
      ? { phase: input.phase, output: JSON.stringify(input.artifact), createdAt: input.createdAt }
      : undefined,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function buildVerificationPhaseNoteRecord(input: {
  runId: string;
  sessionId: string;
  promptId: string;
  phase: VerificationPhaseName;
  attempt: number;
  output: string;
  targetPrUrl: string;
  headSha: string;
  createdAt?: string;
}): VerificationPhaseArtifactRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const output = redactVerificationPhaseOutputForPersistence(input.output);
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    promptId: input.promptId,
    phase: input.phase,
    artifactType: artifactTypeForVerificationPhase(input.phase),
    attempt: input.attempt,
    artifact: redactVerificationPhaseArtifactForPersistence({
      schemaVersion: 1,
      artifactType: artifactTypeForVerificationPhase(input.phase),
      phase: input.phase,
      target: { prUrl: input.targetPrUrl, headSha: input.headSha },
      rawOutput: output,
    } as MinimalVerificationPhaseArtifact),
    note: { phase: input.phase, output, createdAt },
    createdAt,
  };
}

const MAX_STORED_PHASE_NOTE_OUTPUT_CHARS = 8_000;

function compactStoredPhaseOutput(output: string): string {
  if (output.length <= MAX_STORED_PHASE_NOTE_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_STORED_PHASE_NOTE_OUTPUT_CHARS)}\n[phase output truncated for durable storage]`;
}

export function compactVerificationPhaseArtifactRecordForDurableStorage(
  record: VerificationPhaseArtifactRecord,
): VerificationPhaseArtifactRecord {
  const artifact =
    typeof record.artifact.rawOutput === "string"
      ? {
          ...record.artifact,
          rawOutput: compactStoredPhaseOutput(record.artifact.rawOutput),
        }
      : record.artifact;
  return {
    ...record,
    artifact,
    note: record.note
      ? {
          ...record.note,
          output: compactStoredPhaseOutput(record.note.output),
        }
      : undefined,
  };
}

export function upsertVerificationPhaseArtifactRecord(
  records: readonly VerificationPhaseArtifactRecord[],
  record: VerificationPhaseArtifactRecord,
): VerificationPhaseArtifactRecord[] {
  const next = records.filter(
    (existing) =>
      !(existing.runId === record.runId && existing.phase === record.phase && existing.attempt === record.attempt),
  );
  next.push(record);
  return next.sort((a, b) => {
    const phaseDelta = VERIFICATION_PHASE_NAMES.indexOf(a.phase) - VERIFICATION_PHASE_NAMES.indexOf(b.phase);
    if (phaseDelta !== 0) return phaseDelta;
    return a.attempt - b.attempt;
  });
}

export function buildVerificationPipelineInconclusiveResult(input: {
  headSha: string;
  summary: string;
  blocker: string;
}): VerifierTerminalResult {
  return {
    verdict: "INCONCLUSIVE",
    verifiedHeadSha: input.headSha,
    needsWorkLabel: "verification-gap",
    summary: input.summary,
    evidence: [],
    blockers: [input.blocker],
  };
}
