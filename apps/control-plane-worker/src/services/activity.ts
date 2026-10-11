// Activity aggregation service. The route authorizes organization scope; this
// layer turns it into an always-business-bound DAO scope.

import { ACTIVITY_RECENT_EVENTS_LIMIT, type ActivityWindowDays, DAY_MS } from "../constants/control-room";
import {
  type ActivitySessionRow,
  type ActivityTotals,
  countSessionsBySource,
  getActivityTotals,
  listActivitySessions,
  listRecentLifecycleEvents,
  type SessionSourceCounts,
} from "../session/activity-db";
import type { AuthInfo } from "../types";

export interface ActivityLifecycleEvent {
  sessionId: string;
  event: string;
  fromState: string;
  toState: string;
  /** Epoch ms. */
  at: number;
  actor: string;
  repoOwner: string | null;
  repoName: string | null;
  title: string | null;
}

export interface ActivitySummary {
  windowDays: number;
  /** Inclusive lower bound of the window, in both timestamp encodings used by the underlying tables. */
  since: { iso: string; ms: number };
  scope: "user" | "organization";
  canViewOrganization: boolean;
  sessionsBySource: SessionSourceCounts;
  totals: ActivityTotals;
  sessions: ActivitySessionRow[];
  recentEvents: ActivityLifecycleEvent[];
}

export interface GetActivityInput {
  auth: AuthInfo;
  windowDays: ActivityWindowDays;
  scope: "user" | "organization";
  eventsLimit?: number;
}

export async function getActivity(db: D1Database, input: GetActivityInput): Promise<ActivitySummary> {
  const businessId = input.auth.user?.businessId;
  if (!businessId) throw new Error("Activity requires a business membership");
  const ownerUserId = input.scope === "user" ? input.auth.userId : null;
  const sinceMs = Date.now() - input.windowDays * DAY_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  const eventsLimit = Math.max(
    1,
    Math.min(input.eventsLimit ?? ACTIVITY_RECENT_EVENTS_LIMIT, ACTIVITY_RECENT_EVENTS_LIMIT),
  );

  const queryScope = { businessId, ownerUserId, sinceIso };
  const [sessionsBySource, totals, sessions, recentEvents] = await Promise.all([
    countSessionsBySource(db, queryScope),
    getActivityTotals(db, queryScope),
    listActivitySessions(db, { ...queryScope, limit: 100 }),
    listRecentLifecycleEvents(db, { ...queryScope, limit: eventsLimit }),
  ]);

  return {
    windowDays: input.windowDays,
    since: { iso: sinceIso, ms: sinceMs },
    scope: input.scope,
    canViewOrganization: input.auth.user?.businessRole === "admin",
    sessionsBySource,
    totals,
    sessions,
    recentEvents,
  };
}
