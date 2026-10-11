export type AgentMode = "primary" | "internal";

// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export type AgentRole = "implementation" | "verification" | "review";
export type HarnessKind = "codex-session" | "claude-session";
export type RuntimeStartupProfile = "implementation_default" | "verification_ready_runtime";
export type VerificationRuntimeMode = "none" | "app_runtime";

export type AgentConfig = {
  name: string;
  description: string;
  mode: AgentMode;
};

export type AgentRuntimeMetadata = {
  agentRole: AgentRole;
  agentProfile: string;
  harnessKind: HarnessKind;
  runtimeStartupProfile: RuntimeStartupProfile;
  verificationRuntimeMode: VerificationRuntimeMode;
  targetPrUrl?: string | null;
};
