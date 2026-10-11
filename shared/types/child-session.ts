export type ChildSessionLifecycleState = "pending" | "running" | "completed" | "failed" | "canceled";

/**
 * Terminal lifecycle states from the parent agent's perspective. Used by the
 * parent's child-session header to stop polling once every child has settled.
 * `pending` and `running` are explicitly NOT terminal.
 */
export const TERMINAL_CHILD_STATUSES: ReadonlySet<ChildSessionLifecycleState> = new Set([
  "completed",
  "failed",
  "canceled",
]);

export interface CreateChildSessionRequest {
  prompt: string;
  repositoryId: string;
  title?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  parentPromptId?: string;
  qa?: boolean;
  targetPrUrl?: string;
}

export interface ChildSessionErrorCode {
  code:
    | "missing_field"
    | "invalid_input"
    | "invalid_repo"
    | "invalid_model"
    | "depth_limit_exceeded"
    | "max_children_per_prompt"
    | "max_children_per_session"
    | "concurrent_limit_exceeded"
    | "cross_repo_not_supported"
    | "unauthorized_repo"
    | "integration_gating_failed"
    | "parent_not_found"
    | "not_found"
    | "internal_error";
  message: string;
  details?: Record<string, unknown>;
}

export interface ChildSessionSummary {
  childSessionId: string;
  childSessionUrl: string;
  title: string | null;
  status: ChildSessionLifecycleState;
  prUrl: string | null;
  createdAt: number | null;
  completedAt: number | null;
  failureReason: string | null;
}
