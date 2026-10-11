import { requestJson } from "./client";

/** Derived review bucket for a published PR (from the FSM projection, not GitHub). */
export type PrInboxBucket =
  "draft" | "needs_review" | "changes_requested" | "checks_failing" | "approved" | "open" | "closed";

export type PrInboxLaneFilter = "all" | "open" | "closed" | "none";

export type PrInboxLinkedTicket = {
  source: "slack";
  channel: string;
  threadTs: string | null;
};

export type PrInboxCycloidDone = {
  state: "working" | "done";
  outcome: "success" | "needs_attention" | null;
  reasons: string[];
};

export type PrInboxItem = {
  sessionId: string;
  prUrl: string | null;
  prNumber: number | null;
  /** Cycloid session title (closest persisted proxy; not the live GitHub PR title). */
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  headBranch: string | null;
  draft: boolean | null;
  /** Raw FSM state. */
  state: string;
  bucket: PrInboxBucket;
  phase: string;
  /** Sidebar pill projection. */
  feChip: string;
  labels: string[];
  stageSection: string;
  cycloidDone: PrInboxCycloidDone;
  model: string | null;
  agentRuntimeBackend: string | null;
  initiationMode: "user" | "child" | "automation";
  /** Slack-only; null for Jira/Linear/GitHub-issue links (not persisted). */
  linkedTicket: PrInboxLinkedTicket | null;
  /** ISO-8601 string; sort + cursor key. */
  updatedAt: string;
};

export type PrInboxPage = {
  items: PrInboxItem[];
  nextCursor: string | null;
  totalCount: number;
  bucketCounts: Record<PrInboxBucket, number>;
};

export type FetchPrInboxParams = {
  repo?: string | null;
  bucket?: PrInboxBucket | null;
  lane?: PrInboxLaneFilter | null;
  search?: string | null;
  cursor?: string | null;
  limit?: number | null;
};

export async function fetchPrInbox(params: FetchPrInboxParams = {}): Promise<PrInboxPage> {
  const query = new URLSearchParams();
  if (params.repo) query.set("repo", params.repo);
  if (params.bucket) query.set("bucket", params.bucket);
  if (params.lane) query.set("lane", params.lane);
  if (params.search) query.set("search", params.search);
  if (params.cursor) query.set("cursor", params.cursor);
  if (params.limit != null) query.set("limit", String(params.limit));
  const qs = query.toString();
  const url = qs ? `/api/pr-inbox?${qs}` : "/api/pr-inbox";
  const response = await requestJson<{ ok: true; data: PrInboxPage }>(url, undefined, "Failed to fetch PR inbox");
  return response.data;
}
