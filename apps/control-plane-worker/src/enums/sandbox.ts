const SandboxBootMode = {
  FRESH_CLONE: "fresh_clone",
  REPO_IMAGE: "repo_image",
  SESSION_SNAPSHOT: "session_snapshot",
} as const;

export type SandboxBootMode = (typeof SandboxBootMode)[keyof typeof SandboxBootMode];

export const SandboxIdlePauseReason = {
  IDLE_AUTO_PAUSE: "idle_auto_pause",
  PLAN_APPROVAL_PARK: "plan_approval_park",
} as const;

export type SandboxIdlePauseReason = (typeof SandboxIdlePauseReason)[keyof typeof SandboxIdlePauseReason];
