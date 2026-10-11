import type { AgentRuntimeBackend } from "./agent-runtime-backend.js";
import { PR_PERSONAS } from "./pr-personas.js";
import type {
  AgentConfig,
  AgentRole,
  AgentRuntimeMetadata,
  RuntimeStartupProfile,
  VerificationRuntimeMode,
} from "./schema.js";

export const DEFAULT_AGENT_NAME = "build";
export const VERIFY_AGENT_NAME = "verify";
export const ONBOARD_AGENT_NAME = "onboard";
export const PLAN_AGENT_NAME = "plan";
export const REVIEW_AGENT_NAME = "review";
export const REVIEW_AGENT_DISPLAY_NAME = `${PR_PERSONAS.zeus.name} · Code review`;
export const REVIEW_AGENT_ROLE: Extract<AgentRole, "review"> = "review";
export const PR_REVIEW_MIN_CONFIDENCE = 3;
export type TurnMode = "plan" | "execute";
export const QA_TESTER_AGENT_PROFILE = VERIFY_AGENT_NAME;
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export const QA_TESTER_AGENT_ROLE: Extract<AgentRole, "verification"> = "verification";
export const QA_TESTER_RUNTIME_STARTUP_PROFILE: Extract<RuntimeStartupProfile, "verification_ready_runtime"> =
  "verification_ready_runtime";

// Migration-only compatibility helpers: PR 4 source code says QA Tester while
// persisted/runtime contracts still use verification/verify strings.
export function isQaTesterAgentRole(value: unknown): value is Extract<AgentRole, "verification"> {
  return value === QA_TESTER_AGENT_ROLE;
}

export function isCodeReviewerAgentRole(value: unknown): value is Extract<AgentRole, "review"> {
  return value === REVIEW_AGENT_ROLE;
}

export function isCodeReviewerSession(meta: { agentRole?: string | null; agentProfile?: string | null }): boolean {
  return isCodeReviewerAgentRole(meta.agentRole) || meta.agentProfile === REVIEW_AGENT_NAME;
}

export function isReadOnlyAgentRole(value: unknown): value is Extract<AgentRole, "verification" | "review"> {
  return isQaTesterAgentRole(value) || isCodeReviewerAgentRole(value);
}

export type ReviewVerificationExemptReason = "verification_session" | "review_session" | "onboarding_session";

/**
 * Session types that never participate in Cycloid verification (VA) or the review loop (RLA),
 * regardless of the caller's autoVerify preference.
 */
export function reviewVerificationExemptReason(meta: {
  agentRole?: string | null;
  agentProfile?: string | null;
  agentRuntimeBackend?: AgentRuntimeBackend | string | null;
}): ReviewVerificationExemptReason | null {
  // Profile fallback preserves reviewer identity for sessions persisted before
  // the distinct `review` role existed.
  if (isCodeReviewerSession(meta)) return "review_session";
  if (isQaTesterAgentRole(meta.agentRole)) return "verification_session";
  if (meta.agentProfile === ONBOARD_AGENT_NAME) return "onboarding_session";
  return null;
}

export const BUILTIN_AGENTS: Record<string, AgentConfig> = {
  build: {
    name: "build",
    description: "The default Cycloid coding agent.",
    mode: "primary",
  },
  verify: {
    name: VERIFY_AGENT_NAME,
    description: "Cycloid QA Tester agent for checking existing pull requests.",
    mode: "primary",
  },
  onboard: {
    name: ONBOARD_AGENT_NAME,
    description: "Cycloid agent that onboards a repository onto Cycloid.",
    // Internal: activated only by the session-create `onboarding` flag, never
    // selectable as a per-prompt agent (it would inject the onboarding
    // playbook and force-draft publishes on sessions that are not onboarding).
    mode: "internal",
  },
  plan: {
    name: PLAN_AGENT_NAME,
    description: "Internal read-only Cycloid planning pass.",
    mode: "internal",
  },
  review: {
    name: REVIEW_AGENT_NAME,
    description: `${REVIEW_AGENT_DISPLAY_NAME}.`,
    mode: "internal",
  },
};

export type PublicQaRequestNormalizationResult = { ok: true; qaRequested: boolean } | { ok: false; error: string };

function hasOwn(input: object, key: "qa" | "verify"): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export function normalizePublicQaRequest(input?: {
  qa?: unknown;
  verify?: unknown;
}): PublicQaRequestNormalizationResult {
  if (!input) return { ok: true, qaRequested: false };

  const hasQa = hasOwn(input, "qa");
  const hasVerify = hasOwn(input, "verify");

  if (hasVerify) {
    return { ok: false, error: "verify is no longer supported; use qa instead" };
  }
  if (hasQa && typeof input.qa !== "boolean") {
    return { ok: false, error: `qa must be a boolean, got: ${String(input.qa)}` };
  }

  return { ok: true, qaRequested: input.qa === true };
}

export function requiresQaTargetPrUrl(input?: { qa?: boolean; targetPrUrl?: string | null }): boolean {
  return input?.qa === true && (!input.targetPrUrl || input.targetPrUrl.trim().length === 0);
}

/**
 * QA sessions against a repo with a resolved App Runtime Profile must use the
 * bridge-owned runtime boot: repo secrets travel only inside the resolved
 * preview contract (ARCANIST_PREVIEW_CONTRACT_JSON), which is stripped from
 * agent shells, so an agent/launcher-initiated `cycloid-app start` falls back
 * to the committed .cycloid.json and boots without composeEnv credentials.
 * An explicit non-"none" declaration always wins; non-QA sessions are never
 * escalated here.
 */
export function resolveEffectiveVerificationRuntimeMode(input: {
  agentRole: unknown;
  agentProfile?: unknown;
  declaredMode: VerificationRuntimeMode | null | undefined;
  hasAppRuntimeContract: boolean;
}): VerificationRuntimeMode {
  const declared = input.declaredMode ?? "none";
  if (declared !== "none") return declared;
  if (input.agentProfile === REVIEW_AGENT_NAME) return "none";
  if (isQaTesterAgentRole(input.agentRole) && input.hasAppRuntimeContract) return "app_runtime";
  return "none";
}

export function turnModeForAgentProfile(agentProfile: string): TurnMode {
  return agentProfile === PLAN_AGENT_NAME ? "plan" : "execute";
}

export function resolveAgentRuntimeMetadata(input?: {
  qa?: boolean;
  onboarding?: boolean;
  targetPrUrl?: string | null;
}): AgentRuntimeMetadata {
  if (input?.qa === true) {
    return {
      agentRole: QA_TESTER_AGENT_ROLE,
      agentProfile: QA_TESTER_AGENT_PROFILE,
      harnessKind: "codex-session",
      runtimeStartupProfile: QA_TESTER_RUNTIME_STARTUP_PROFILE,
      verificationRuntimeMode: "none",
      targetPrUrl: input.targetPrUrl ?? null,
    };
  }
  if (input?.onboarding === true) {
    return {
      agentRole: "implementation",
      agentProfile: ONBOARD_AGENT_NAME,
      harnessKind: "codex-session",
      runtimeStartupProfile: "implementation_default",
      verificationRuntimeMode: "none",
      targetPrUrl: input.targetPrUrl ?? null,
    };
  }
  return {
    agentRole: "implementation",
    agentProfile: DEFAULT_AGENT_NAME,
    harnessKind: "codex-session",
    runtimeStartupProfile: "implementation_default",
    verificationRuntimeMode: "none",
    targetPrUrl: input?.targetPrUrl ?? null,
  };
}

/** Returns agent names valid for API callers (excludes internal agents). */
export function getValidAgentNames(resolvedAgents?: Record<string, AgentConfig>): Set<string> {
  const agents = resolvedAgents ?? BUILTIN_AGENTS;
  return new Set(
    Object.entries(agents)
      .filter(([, a]) => a.mode !== "internal")
      .map(([name]) => name),
  );
}
