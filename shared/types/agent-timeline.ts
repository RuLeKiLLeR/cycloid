export const AGENT_TIMELINE_EVENT_TYPES = [
  "prompt.started",
  "context.selected",
  "files.inspected",
  "tools.run",
  "files.edited",
  "commands.run",
  "publish_gate.result",
  "verification.result",
  "git.commit",
  "git.push",
  "pr.open",
] as const;

export const AGENT_TIMELINE_SOURCES = ["observed"] as const;
export const AGENT_TIMELINE_OBSERVERS = ["sandbox_bridge", "control_plane"] as const;
export const AGENT_TIMELINE_STATUSES = ["started", "completed", "failed", "skipped", "blocked"] as const;

export type AgentTimelineEventType = (typeof AGENT_TIMELINE_EVENT_TYPES)[number];
export type AgentTimelineSource = (typeof AGENT_TIMELINE_SOURCES)[number];
export type AgentTimelineObserver = (typeof AGENT_TIMELINE_OBSERVERS)[number];
export type AgentTimelineStatus = (typeof AGENT_TIMELINE_STATUSES)[number];

export type AgentTimelinePayload = {
  eventType: AgentTimelineEventType;
  source: AgentTimelineSource;
  observer: AgentTimelineObserver;
  summary: string;
  status?: AgentTimelineStatus;
  metadata?: Record<string, unknown>;
};

export type AgentTimelineEntry = AgentTimelinePayload & {
  promptId?: string;
  timestampMs?: number;
};
