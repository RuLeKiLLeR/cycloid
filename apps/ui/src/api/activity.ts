import { requestJson } from "./client";

export type ActivityWindowDays = 7 | 30;
export type ActivityScope = "user" | "organization";

export type ActivitySessionsBySource = {
  total: number;
  slack: number;
  automation: number;
  child: number;
  /** Catch-all bundling UI/API/Jira/Linear/GitHub — not "UI only" (source enum is not persisted). */
  user: number;
};

export type ActivityTotals = {
  sessions: number;
  sessionsWithPr: number;
  sessionsMerged: number;
  sessionsClosed: number;
  sessionsWithFeedback: number;
  feedbackTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicros: number;
  mergedAdditions: number;
  mergedDeletions: number;
  /** Merged sessions whose publish event included structured diff stats. */
  mergedLocSessions: number;
};

export type ActivitySession = {
  sessionId: string;
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  ownerLogin: string | null;
  createdAt: string;
  source: "slack" | "automation" | "child" | "user";
  promptCount: number;
  feedbackTurns: number;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  prUrl: string | null;
  prStatus: "open" | "merged" | "closed" | null;
  mergedAdditions: number | null;
  mergedDeletions: number | null;
};

export type ActivityEvent = {
  sessionId: string;
  /** FSM event kind, e.g. "publish.pr_opened". */
  event: string;
  fromState: string;
  toState: string;
  /** Epoch ms. */
  at: number;
  actor: string;
  repoOwner: string | null;
  repoName: string | null;
  title: string | null;
};

export type ActivityData = {
  windowDays: ActivityWindowDays;
  since: { iso: string; ms: number };
  scope: ActivityScope;
  canViewOrganization: boolean;
  sessionsBySource: ActivitySessionsBySource;
  totals: ActivityTotals;
  sessions: ActivitySession[];
  /** Newest first, capped at 50. Post-publish lifecycle transitions only. */
  recentEvents: ActivityEvent[];
};

export async function fetchActivity(
  windowDays: ActivityWindowDays = 7,
  scope: ActivityScope = "user",
): Promise<ActivityData> {
  const response = await requestJson<{ ok: true; data: ActivityData }>(
    `/api/activity?windowDays=${windowDays}&scope=${scope}`,
    undefined,
    "Failed to fetch activity",
  );
  return response.data;
}
