/**
 * Canonical command, status, and shared value types used by sandbox-bridge and
 * control-plane-worker. Legacy bridge outbound event variants live in
 * shared/events/bridge.ts while the websocket transport migrates to
 * shared/events/schema.ts.
 */

import type { AgentRole, HarnessKind, RuntimeStartupProfile, VerificationRuntimeMode } from "../agent/schema.js";
import type { SerializedCorrelation } from "../correlation.js";
import type { PlatformLlmCapabilityManifest } from "../llm/platform-llm-contract.js";
import type { TracingState } from "../observability/trace.js";
import type { AgentTimelineEntry } from "./agent-timeline.js";
import type { ERROR_CODES } from "./error-codes.js";

// Error classification codes, derived from the runtime ERROR_CODES array so
// type membership and the isErrorCode check can never drift: a code missing
// from the array used to type-check via `satisfies` while isErrorCode
// silently coerced it to "unknown" (ARC-1622). Type-only import, so this
// stays a runtime-free module.
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorDetails = {
  message: string;
  name?: string;
  stack?: string;
  errno?: string;
  code?: string;
  syscall?: string;
  hostname?: string;
  address?: string;
  port?: number;
  providerID?: string;
  statusCode?: number;
  isRetryable?: boolean;
  responseBodyPreview?: string;
  cause?: ErrorDetails;
  raw?: string;
};

export type ClientErrorCause = Pick<
  ErrorDetails,
  | "message"
  | "name"
  | "errno"
  | "code"
  | "syscall"
  | "hostname"
  | "address"
  | "port"
  | "providerID"
  | "statusCode"
  | "isRetryable"
>;

export type ClientErrorDetails = ClientErrorCause & {
  cause?: ClientErrorCause;
};

export type VerificationArtifact = {
  artifactId?: string;
  type: "screenshot" | "video" | "log" | "report";
  label: string;
  filename?: string;
  url: string;
  renderMode?: "inline" | "link";
  inlineText?: {
    content: string;
    truncated: boolean;
    originalBytes: number;
  };
};

// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export type VerificationVerdict = "CONFIRMED" | "REFUTED" | "INCONCLUSIVE";
export type VerificationAgentVerdict = "CONCLUSIVE" | "INCONCLUSIVE";
export type VerificationNeedsWorkLabel = "verification-gap";

export type VerifierCheckStatus = "passed" | "failed" | "skipped";

/**
 * Self-reported per-surface result from the QA Tester agent's own reasoning.
 * Descriptive scorecard only: it does not drive verdict/review-loop routing and is
 * rendered comment-only (it does not feed `VerificationSummary`). Distinct from the
 * pipeline-collected `PrReadinessCheck`/`VerificationSummary` command evidence.
 * Canonical names + render order: ci, lint, typecheck, tests, runtime, ui,
 * backend, dao, infra, docs; free-form allowed as fallback.
 */
export type VerifierCheck = {
  name: string;
  status: VerifierCheckStatus;
  detail?: string;
};

export type PublishableEvidenceRef = {
  path: string;
  label: string;
  reason: string;
};

export type VerifierTerminalResult = {
  verdict: VerificationAgentVerdict;
  verifiedHeadSha: string;
  computedAgainstHeadSha?: string;
  needsWorkLabel?: VerificationNeedsWorkLabel;
  summary: string;
  evidence: string[];
  evidenceRefs?: VerificationEvidenceRef[];
  publishableEvidence?: PublishableEvidenceRef[];
  checks?: VerifierCheck[];
  blockers: string[];
  /**
   * ARC-1330 §17-A run-identity carry/echo: the monotonic `verification_run_id` token the FSM stamped
   * on the active run when it spawned this child (`request_verification`/`redispatch_verification`). It is
   * passed INTO the verification child at spawn and echoed back here so the spine can run-scope verdict
   * freshness: it maps this verdict to a `verification.*` event with `runId := verificationRunId`, and
   * freshness = `event.runId == record.verification_run_id`. A verdict from a SUPERSEDED run (the H→H′→H
   * ABA ghost) therefore fails the match and is discarded — never a stale-pass false accept (gate class B4).
   * Optional/additive: legacy verifiers that don't echo it mint no spine verdict (fails toward NOT-fresh).
   */
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  verificationRunId?: number;
};

export type VerificationEvidenceRef = {
  type: "screenshot" | "video" | "command" | "log" | "report" | "artifact";
  label: string;
  artifactId?: string;
  status?: "passed" | "failed" | "skipped" | "uploaded" | "partial";
  url?: string;
  command?: string;
  summary?: string;
  failureOutput?: string;
};

import type { VercelDeployPreview } from "../integrations/vercel-deploy-preview.js";

export type { VercelDeployPreview };

export type VerificationPrContext = {
  prUrl: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed" | "merged";
  draft: boolean;
  // GitHub's authoritative merge-gate verdict and applied labels. mergeable /
  // mergeStateStatus may be null while GitHub computes them asynchronously.
  mergeable: boolean | null;
  mergeStateStatus: string | null;
  labels: string[];
  headRef: string;
  headSha: string;
  headRepoOwner?: string | null;
  headRepoName?: string | null;
  baseRef: string;
  authorLogin: string | null;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
  commits: Array<{
    sha: string;
    message: string;
    authorLogin: string | null;
  }>;
  checksSummary: string | null;
  vercelDeployPreview: VercelDeployPreview | null;
  recentDiscussion: Array<{
    kind: "comment" | "review";
    authorLogin: string | null;
    body: string;
    createdAt: string | null;
  }>;
  fetchWarnings: string[];
};

export type VerificationParentPrompt = {
  promptId: string;
  prompt: string;
  status: string;
  createdAt?: string;
};

export type ReviewLoopPromptSourceKind = "bot" | "human" | "mixed" | "merge_conflict";

export type DockerComposeRuntimeEntry = {
  type: "compose";
  files: string[];
  service: string;
  profiles?: string[];
};

export type DockerfileRuntimeEntry = {
  type: "dockerfile";
  context: string;
  dockerfile: string;
  service: string;
};

export type DockerRuntimeEntry = DockerComposeRuntimeEntry | DockerfileRuntimeEntry;

/**
 * Optional zero-setup source for a declared credential: when no explicit
 * test-credential or repo env value is stored, the control plane resolves the
 * business's own integration-backed runtime value. OpenAI and Anthropic
 * resolve from the workspace BYOK provider key (the key its agent sessions
 * already use). Neon provisions one writable branch per session and injects
 * that branch connection URI. An explicitly stored value always wins where a
 * stored secret path exists, so customers can split keys for usage tracking by
 * setting one.
 */
export type PreviewContractCredentialSource = "business_openai_key" | "business_anthropic_key" | "business_neon_branch";

export type PreviewContractE2ECredentialDeclaration = {
  /** Stored credential name in business_test_credentials. */
  name: string;
  /** Env var the decrypted value is exposed as inside the testCommand subprocess. */
  envVar: string;
  source?: PreviewContractCredentialSource;
};

export type PreviewContractE2EConfig = {
  testCommand: string;
  seedCommand?: string;
  resetCommand?: string;
  credentials?: PreviewContractE2ECredentialDeclaration[];
};

export type PreviewContractAuthConfig = {
  /** Repo-owned command that writes Playwright storage state to ARCANIST_AUTH_STATE_PATH. */
  command: string;
  /** App-relative route used to validate that the produced auth state is accepted. */
  validatePath?: string;
  credentials?: PreviewContractE2ECredentialDeclaration[];
};

export type PreviewContractAdditionalPort = {
  /** Compose service to publish. Defaults to the primary entry.service. */
  service?: string;
  hostPort: number;
  containerPort?: number;
};

export type PreviewContractGeneratedComposeEnv = Record<
  string,
  {
    type: "hex";
    bytes: number;
  }
>;

export type PreviewContract = {
  cwd: string;
  kind: "web";
  runner: "docker";
  entry: DockerRuntimeEntry;
  url: {
    hostPort: number;
    path?: string;
  };
  portMapping?: {
    containerPort?: number;
  };
  /** Extra browser-reachable service ports required by the app, such as a separate API service. */
  additionalPorts?: PreviewContractAdditionalPort[];
  composeEnv?: Record<string, string>;
  generatedComposeEnv?: PreviewContractGeneratedComposeEnv;
  env?: Record<string, string>;
  ready?: {
    path?: string;
    timeoutSeconds?: number;
  };
  open?: {
    path?: string;
  };
  auth?: PreviewContractAuthConfig;
  e2e?: PreviewContractE2EConfig;
};

export type AppRuntimeProfileSource = "config_docker" | "onboarding" | "none";

export type AppRuntimeProfileDiagnosticCode =
  | "docker_compose_missing"
  | "dockerfile_missing"
  | "invalid_entry"
  | "invalid_config_json"
  | "invalid_cwd"
  | "invalid_compose_file"
  | "invalid_env"
  | "invalid_path"
  | "invalid_port_mapping"
  | "no_runtime_profile"
  | "non_reserved_port"
  | "unsupported_runner"
  | "unsupported_strategy"
  | "missing_e2e_test_command"
  | "invalid_e2e_command"
  | "invalid_e2e_credential"
  | "missing_e2e_credential_value"
  | "invalid_auth_config"
  | "missing_auth_credential_value";

export type AppRuntimeProfileDiagnostic = {
  code: AppRuntimeProfileDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  field?: string;
  value?: string | number | boolean | null;
};

export type RepoImageLookupMissReason = "no_image" | "version_mismatch" | "branch_mismatch" | "hash_mismatch";

export type RepoImageStartupFallbackReason = "invalid_image" | "provider_load_failed";

export type RuntimeReport = {
  provider?: SandboxRuntimeProvider | null;
  backend?: SandboxRuntimeBackend | null;
  sandboxId?: string | null;
  templateId?: string | null;
  /** Legacy pre-E2B runtime fields retained for historical records during migration. */
  modalEnvironment?: string | null;
  modalSandboxId?: string | null;
  modalTaskId?: string | null;
  modalImageId?: string | null;
  dockerEnabled?: boolean | null;
  dockerDaemonStartMs?: number | null;
  /**
   * ARC-1512: identity of the sandbox-bridge bundle actually running. `sha256` is the
   * injected bundle's sha (control plane) or a self-hash of the running file, or
   * `"unknown"` when neither could be resolved. `source` distinguishes a control-plane
   * injected bundle from the baked base-snapshot bundle.
   */
  bridgeBundleSha256?: string | null;
  bridgeBundleSource?: BridgeBundleSource | null;
  reportedAt: number;
};

export type BridgeBundleSource = "injected" | "baked";

export type BridgeBundleIdentity = {
  bridgeBundleSha256: string;
  bridgeBundleSource: BridgeBundleSource;
};

export type SandboxRuntimeProvider = "e2b" | "freestyle";

export type SandboxRuntimeBackend = "e2b_cloud" | "freestyle";

export type SandboxRuntimeState = "running" | "paused" | "killed";

export type ObservabilityReadiness = {
  /** Backward-compatible alias for traceExportConfigured. */
  traceExport: boolean;
  traceExportConfigured?: boolean;
  ddLogs: boolean;
  tracingState: TracingState;
};

export type RuntimeProvenance = {
  bootMode?: "fresh_clone" | "fresh_user_request" | "repo_image" | "session_snapshot" | null;
  modalEnvironment?: string | null;
  modalObjectId?: string | null;
  sandboxImageVersion?: string | null;
  dockerEnabled?: boolean;
  dockerDaemonStartMs?: number | null;
  appRuntimeProfileSource?: AppRuntimeProfileSource | null;
  appRuntimeProfileDiagnostics?: AppRuntimeProfileDiagnostic[];
  repoImagePrimaryBootEnabled?: boolean;
  repoImagePrimaryBootBlockedReason?: "missing_sandbox_image_version" | null;
  repoImageLookupResult?: "hit" | "miss" | null;
  repoImageMissReason?: RepoImageLookupMissReason | null;
  repoImageId?: string | null;
  repoImageSha?: string | null;
  repoImageStartupFallback?: RepoImageStartupFallbackReason | null;
  sessionSnapshotImageId?: string | null;
  runtime?: RuntimeReport | null;
  sandboxLayerSelection?: {
    decision: "selected" | "not_selected" | "provider_artifact_missing_fallback";
    tier?: "repo_local" | "repo_assignment" | "business_default" | null;
    resourceProfileKey?: string | null;
    misses?: Array<{ tier: string; code: string; sourceId?: string }> | null;
    fallbackRuntimeTemplateId?: string | null;
    fallbackReason?: string | null;
  } | null;
  sandboxLayer?: {
    sourceId: string;
    commitSha: string;
    sourceContentHash: string;
    baseTemplateRef: string;
    baseVersion: string;
    resourceProfileKey: string;
    provider: "e2b";
    providerArtifactRef: string;
    buildId: string;
  } | null;
  updatedAt: number;
};

export type ExecutionVerification = {
  verified: boolean;
  explanation?: string;
  status?: "passed" | "failed" | "manual_review_required" | "warn";
  mode?: "browser" | "scenario" | "tests";
  verdict?: VerificationVerdict;
  claim?: string;
  evidence?: VerificationEvidenceRef[];
  caveats?: string[];
  notes?: string[];
  publishMode?: PublishMode;
  manualReviewReason?: string;
  publishWarnReasons?: string[];
  steps?: string[];
  artifacts?: VerificationArtifact[];
  previewContract?: PreviewContract;
  visualAssertion?: string;
  runtimeEvidenceRequired?: boolean;
  runtimeEvidenceSatisfied?: boolean;
};

/**
 * The three publication outcomes the post-execution pipeline can decide. Kept as
 * a named alias so the bridge (decision producer) and the control plane
 * (authoritative re-derivation) share one definition. Note `skip_publish` is NOT
 * here: it is a manual/control-plane `requestedMode` only and is never emitted by
 * the sandbox in `post_execution.publishMode`.
 */
export type PublishMode = "normal" | "draft";

/**
 * Closed set of deterministic pre-publish gates the sandbox serializes
 * per-gate so the control plane can re-fold the publish mode from inputs rather
 * than trusting the sandbox's final fold. Visual evidence is intentionally not a
 * discrete gate here: only configured `.cycloid.json` `verify.test` commands
 * are represented as post-execution publish gates.
 *
 * Customer-owned command validation lives under `.cycloid.json` `verify.test`.
 */
export const PUBLISH_GATE_NAMES = ["tests"] as const;
export type PublishGateName = (typeof PUBLISH_GATE_NAMES)[number];

/**
 * Per-gate decision in serialized (wire) form. The publish MODE is fully
 * determined by these decisions (precedence `draft > normal`); `reason`
 * is descriptive only (telemetry / mismatch context), not authority-bearing.
 */
export type GateDecision = "pass" | "draft" | "skipped";

export type SerializedGateResult = {
  decision: GateDecision;
  reason?: string;
};

/**
 * Complete over the closed gate set: every {@link PublishGateName} has an entry,
 * so "absent" / "skipped" / "ran-and-passed" are never ambiguous. A gate that did
 * not run is `{ decision: "skipped" }`, never omitted.
 */
export type GateResults = Record<PublishGateName, SerializedGateResult>;

export type PrReadinessCheck = "tests" | "lint" | "typecheck";

export type PrReadinessCommand = {
  command: string;
  status: "completed" | "error" | "skipped";
  /**
   * Numeric process exit code when it is available. Codex currently exposes
   * terminal tool status for agent shell commands, not the underlying numeric
   * process code, so those entries intentionally use null.
   */
  exitCode: number | null;
  source: "agent" | "post_execution";
  check?: PrReadinessCheck;
  checks?: PrReadinessCheck[];
  hasOutput: boolean;
  summary?: string;
  /**
   * Redacted tail of failed command stderr/output for reviewer-facing PR
   * comments. Omitted for successful and skipped commands.
   */
  failureOutput?: string;
  skipReason?: string;
};

export type PrReadinessEvidence = {
  changedFiles: string[];
  diffStats: {
    raw?: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  commandsRun: PrReadinessCommand[];
  checksDetected: Record<PrReadinessCheck, boolean>;
  skippedChecks: Array<{
    check: PrReadinessCheck;
    reason: string;
  }>;
  filesMentionedInFinalAnswer: string[];
  agentTimeline?: AgentTimelineEntry[];
  evidenceBundle?: {
    originalPrompt?: string;
    finalSummary?: string;
    agentFinalMessage?: string;
    sessionUrl?: string;
    issueUrl?: string;
    /**
     * Cleaned narratives from PRIOR prompts in the same multi-prompt session,
     * in chronological order. Prepended to the current turn's narrative by
     * `buildCleanNarrative` so the PR body describes the whole PR, not just the
     * latest follow-up. Empty/absent for single-prompt sessions (ARC-1143).
     */
    priorNarratives?: string[];
  };
};

// Diagnostic entry from post-edit checks
export type DiagnosticEntry = {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  source: string;
};

// Uploaded file/image shapes (canonical definitions — import from here, never redefine)
export type UploadedFile = { name: string; content: string };
export type UploadedImage = { name: string; mediaType: string; data: string };

// Options for handlePrompt — extracted from the "prompt" SandboxCommand fields
export type HandlePromptOptions = {
  messageId: string;
  content: string;
  branchNameHint?: string;
  /**
   * User ID of the actor who submitted this prompt. Missing or null means the
   * bridge should fall back to session-owner identity behavior.
   */
  actorUserId?: string | null;
  model?: string;
  agent?: string;
  agentRole?: AgentRole;
  agentProfile?: string;
  harnessKind?: HarnessKind;
  runtimeStartupProfile?: RuntimeStartupProfile;
  verificationRuntimeMode?: VerificationRuntimeMode;
  targetPrUrl?: string | null;
  adoptedExternalPr?: boolean;
  verificationPrContext?: VerificationPrContext;
  verificationSetupWarnings?: string[];
  verificationParentPrompts?: VerificationParentPrompt[];
  skills?: string[];
  gitAuthor?: { name: string; email: string };
  files?: string[];
  uploadedFiles?: UploadedFile[];
  uploadedImages?: UploadedImage[];
  reasoningEffort?: string;
  correlation?: SerializedCorrelation;
  platformLlmCapabilities?: PlatformLlmCapabilityManifest;
  repoMemories?: RepoMemoryContext[];
  planContext?: PlanContext;
  reviewLoopMode?: boolean;
  epochId?: string;
  sourceKind?: ReviewLoopPromptSourceKind;
};

export type PlanContext = {
  planPromptId: string;
  valid: boolean;
  excerpt: string;
  artifactId: string | null;
  missingReason: string | null;
  revision?: number;
  userEdited?: boolean;
};

export type RepoMemoryContext = {
  id: string;
  content: string;
  context_hint: string;
  type: string;
  memory_type?: string;
  action_type?: string | null;
  level?: string;
  primitive?: string;
  status?: string;
  confidence?: string;
  authority?: string;
  enforcement?: string;
  triggers?: {
    tools: string[];
    path_globs: string[];
    command_patterns: string[];
    forbidden_patterns: string[];
    mcp_tools: string[];
  } | null;
  applies_to?: string[];
  tags?: string[];
  scope: string;
  referenced_files: string | null;
  created_at?: string;
  updated_at?: string;
};

// Commands received from control plane
export type SandboxCommand =
  | ({ type: "prompt" } & HandlePromptOptions)
  | { type: "stop"; requestId?: string; messageId?: string }
  | { type: "respond"; answer: string; requestId?: string }
  | {
      type: "spawn_info";
      spawnDurationMs: number;
      // Spawn-latency instrumentation (optional so older sandbox bridges and
      // mixed-deploy windows tolerate a payload without these fields).
      spawnPath?: "cold";
      e2bCreateMs?: number | null;
      bridgeLaunchMs?: number | null;
      runtimeBackend?: string;
    }
  // Application-level liveness echo. The session DO replies to a bridge
  // heartbeat (which carries `echoNonce`) with this typed frame so the bridge
  // can prove the DO *application* layer is alive and processing -- the raw
  // protocol pong only proves the Cloudflare edge / DO auto-responder answered.
  | { type: "heartbeat_echo"; echoNonce: string };

export type SandboxAckMessage = {
  type: "ack";
  ackId: string;
};

export type SandboxSessionMessage = {
  type: "sandbox_session";
  sessionKey: string;
  connectionGeneration: number;
  nextAuthToken: string;
  /** Control-plane worker's bridge protocol version. Optional so new bridges
   * can connect to old workers during deploy skew. */
  bridgeProtocolVersion?: number;
  /** Per-session HMAC key for the bridge's durable outbox. Stable across
   * reconnects (so a restarted bridge can verify records it wrote earlier) and
   * never exposed to the sandbox environment, so a same-user agent cannot forge
   * outbox records. Optional for deploy-skew tolerance: when absent the bridge
   * runs without durable crash-recovery rather than trusting unsigned records. */
  outboxSigningKey?: string;
  /** Opaque Cloudflare Worker version id; optional for deploy-skew compatibility. */
  workerVersionId?: string;
};

export type SandboxAuthErrorMessage = {
  type: "auth_error";
  reason: string;
};

export type SandboxSocketMessage = SandboxCommand | SandboxAckMessage | SandboxSessionMessage | SandboxAuthErrorMessage;
