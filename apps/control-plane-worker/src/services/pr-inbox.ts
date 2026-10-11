// Cross-session PR inbox service (Wave-0 UX overhaul). Composes the FSM
// projection (`project`) over the joined inbox rows to derive a stable review
// "bucket" per PR, then owner-scopes, repo/bucket-filters, and pages. Read-only.
//
// Scope note: Wave 0 is OWNER-scoped (the caller's own sessions; an admin
// `canAccessAllSessions` caller sees all). Business-wide aggregation is
// deferred — it needs the shared-session per-repo access snapshot
// (`getSharedBusinessRepoAccessSnapshot`) to avoid leaking PRs across repos the
// caller cannot see. Documented as a gap, not faked.

import {
  PR_INBOX_BUCKETS,
  PR_INBOX_DEFAULT_LIMIT,
  PR_INBOX_MAX_LIMIT,
  PR_INBOX_MAX_SEARCH_TERMS,
  type PrInboxBucket,
  type PrInboxLaneFilter,
} from "../constants/control-room";
import { cycloidDoneOf, feChipOf, labelsOf, phaseOf, stageOf } from "../session/fsm/project";
import { FSM_STATES, type FsmRecord } from "../session/fsm/types";
import {
  decodePrInboxCursor,
  encodePrInboxCursor,
  listPrInboxRows,
  type ListPrInboxRowsInput,
  type PrInboxCursor,
  type PrInboxRow,
} from "../session/pr-inbox-db";
import type { AuthInfo } from "../types";

/** A parsed linked ticket. Only Slack is persisted on `session_index` today. */
export interface PrInboxLinkedTicket {
  source: "slack";
  channel: string;
  threadTs: string | null;
}

export interface PrInboxItem {
  sessionId: string;
  prUrl: string | null;
  prNumber: number | null;
  /** Session title — proxy for the PR title (live GitHub PR title is not persisted). */
  title: string | null;
  repoOwner: string | null;
  repoName: string | null;
  headBranch: string | null;
  draft: boolean | null;
  /** Raw FSM state (e.g. REVIEW, VERIFYING, MERGE_READY, NEEDS_YOU, MERGED). */
  state: string;
  bucket: PrInboxBucket;
  phase: string;
  feChip: string;
  labels: readonly string[];
  stageSection: string;
  cycloidDone: ReturnType<typeof cycloidDoneOf>;
  model: string | null;
  agentRuntimeBackend: string | null;
  initiationMode: string | null;
  linkedTicket: PrInboxLinkedTicket | null;
  updatedAt: string;
}

export interface PrInboxPage {
  items: PrInboxItem[];
  nextCursor: string | null;
  /** Number of rows matching the active repo/search/status/lane filters. */
  totalCount: number;
  /** Repo/search-matched counts before status and lane filters are applied. */
  bucketCounts: Record<PrInboxBucket, number>;
}

/**
 * Pure bucket derivation from the FSM record + the PR draft flag. Single source
 * of truth for the inbox taxonomy (the DAO does not re-encode it). Total over
 * every reachable post-publish state; unknown/other states fall to `open`.
 */
export function derivePrBucket(record: FsmRecord, prDraft: boolean | null): PrInboxBucket {
  if (prDraft === true) return "draft";
  switch (record.state) {
    case "MERGED":
    case "CLOSED":
      return "closed";
    case "MERGE_READY":
      return "approved";
    case "NEEDS_YOU":
      switch (record.blockedReason) {
        case "ci_fix_exhausted":
        case "ci_flapping":
          return "checks_failing";
        case "verification_noconverge":
        case "verification_unresolved":
        case "verification_run_limit":
        case "verification_stopped":
          return "changes_requested";
        default:
          // owner_approval / review_stuck / review_response_failed / internal_inconsistency / null
          return "needs_review";
      }
    case "REVIEW":
      return record.verdict === "app_breaks" ? "changes_requested" : "needs_review";
    case "VERIFYING":
      return "needs_review";
    default:
      // STOPPED / SUPERSEDED / FAILED / ARCHIVED / any pre-publish leftover with a pr_url.
      return "open";
  }
}

function parseLinkedTicket(callbackContextJson: string | null): PrInboxLinkedTicket | null {
  if (!callbackContextJson) return null;
  try {
    const parsed = JSON.parse(callbackContextJson) as { source?: string; channel?: string; threadTs?: string };
    if (parsed?.source === "slack" && typeof parsed.channel === "string") {
      return { source: "slack", channel: parsed.channel, threadTs: parsed.threadTs ?? null };
    }
  } catch {
    // Malformed context JSON is non-fatal — the row simply has no linked ticket.
  }
  return null;
}

function toItem(row: PrInboxRow, bucket: PrInboxBucket): PrInboxItem {
  const record = row.record as FsmRecord;
  return {
    sessionId: record.sessionId,
    prUrl: record.prUrl,
    prNumber: row.prNumber,
    title: row.title,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    headBranch: row.headBranch,
    draft: row.prDraft,
    state: record.state,
    bucket,
    phase: phaseOf(record.state),
    feChip: feChipOf(record.state),
    labels: labelsOf(record),
    stageSection: stageOf(record),
    cycloidDone: cycloidDoneOf(record),
    model: row.model,
    agentRuntimeBackend: row.agentRuntimeBackend,
    initiationMode: row.initiationMode,
    linkedTicket: parseLinkedTicket(row.callbackContextJson),
    updatedAt: row.updatedAt,
  };
}

/** A row whose `state` is not a known FSM state cannot be projected — skip it defensively. */
function isProjectableRow(row: PrInboxRow): boolean {
  return (FSM_STATES as readonly string[]).includes(row.record.state);
}

export interface ListPrInboxInput {
  auth: AuthInfo;
  repoSlug?: string | null;
  bucket?: PrInboxBucket | null;
  lane?: PrInboxLaneFilter | null;
  search?: string | null;
  /** Opaque cursor string from a prior page's `nextCursor` (decoded here, not in the route). */
  cursor?: string | null;
  limit?: number | null;
}

const DAO_PAGE_LIMIT = 200;

function normalizeSearchTerms(search: string | null | undefined): string[] {
  return search?.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, PR_INBOX_MAX_SEARCH_TERMS) ?? [];
}

function emptyBucketCounts(): Record<PrInboxBucket, number> {
  return Object.fromEntries(PR_INBOX_BUCKETS.map((bucket) => [bucket, 0])) as Record<PrInboxBucket, number>;
}

function matchesLane(bucket: PrInboxBucket, lane: PrInboxLaneFilter): boolean {
  if (lane === "all") return true;
  if (lane === "none") return false;
  return lane === "closed" ? bucket === "closed" : bucket !== "closed";
}

function isAfterCursor(row: PrInboxRow, cursor: ReturnType<typeof decodePrInboxCursor>): boolean {
  if (!cursor) return true;
  return (
    row.updatedAt < cursor.updatedAt || (row.updatedAt === cursor.updatedAt && row.record.sessionId < cursor.sessionId)
  );
}

/**
 * Owner-scoped inbox page. Search is pushed into the DAO, while bucket/lane
 * filtering and counts remain post-projection so the FSM taxonomy stays in one
 * place. The bounded DAO scan covers the full matching inbox before the public
 * cursor is applied, keeping counts and sparse bucket pages truthful.
 */
export async function listPrInbox(db: D1Database, input: ListPrInboxInput): Promise<PrInboxPage> {
  const targetLimit = Math.max(1, Math.min(input.limit ?? PR_INBOX_DEFAULT_LIMIT, PR_INBOX_MAX_LIMIT));
  const ownerUserId = input.auth.canAccessAllSessions ? null : input.auth.userId;
  const searchTerms = normalizeSearchTerms(input.search);
  const requestedCursor = decodePrInboxCursor(input.cursor);
  const lane = input.lane ?? "all";
  const bucketCounts = emptyBucketCounts();
  const matches: Array<{ item: PrInboxItem; row: PrInboxRow }> = [];
  let scanCursor: PrInboxCursor | null = null;

  for (;;) {
    const daoInput: ListPrInboxRowsInput = {
      ownerUserId,
      repoSlug: input.repoSlug ?? null,
      searchTerms,
      cursor: scanCursor,
      limit: DAO_PAGE_LIMIT,
    };
    const rows = await listPrInboxRows(db, daoInput);
    for (const row of rows) {
      if (!isProjectableRow(row)) continue;
      const bucket = derivePrBucket(row.record as FsmRecord, row.prDraft);
      bucketCounts[bucket] += 1;
      if (input.bucket && bucket !== input.bucket) continue;
      if (!input.bucket && !matchesLane(bucket, lane)) continue;
      matches.push({ item: toItem(row, bucket), row });
    }
    if (rows.length < DAO_PAGE_LIMIT) break;
    const lastRow = rows.at(-1);
    if (!lastRow) break;
    scanCursor = { updatedAt: lastRow.updatedAt, sessionId: lastRow.record.sessionId };
  }

  const remaining = matches.filter(({ row }) => isAfterCursor(row, requestedCursor));
  const page = remaining.slice(0, targetLimit);
  const last = page.at(-1);

  return {
    items: page.map(({ item }) => item),
    nextCursor: remaining.length > targetLimit && last ? encodePrInboxCursor(last.row) : null,
    totalCount: matches.length,
    bucketCounts,
  };
}
