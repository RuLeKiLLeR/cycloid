// Reconstruct a PR's conversation from its captured pr_activity_events rows
// (migration 0248). Pure fold — no D1. Takes the output of `listPrActivityEvents`
// and folds the append-only event log into a readable current-state view while
// retaining the full per-subject history (so a caller can show either the latest
// text or the whole edit chain).
//
// Two tracks: the PR-level track (current title/body + a chronological state-change
// timeline from `pull_request` events, which have no subject id) and the subject
// track (comments/reviews grouped by `subject_id`, edits folded into the current
// body, deletes flagged without discarding captured prior bodies, review state
// updated on submitted/edited/dismissed).

import type { PrActivityEvent } from "./pr-activity-events-db";

export interface PrActivityHistoryEntry {
  action: string;
  body: string | null;
  actorLogin: string | null;
  occurredAt: number;
}

export interface ReconstructedPrSubject {
  subjectId: string;
  /** issue_comment | pull_request_review | pull_request_review_comment */
  eventType: string;
  author: { login: string | null; type: string | null };
  /** Latest non-null body seen for this subject. */
  currentBody: string | null;
  /** Latest review state (reviews only). */
  reviewState: string | null;
  filePath: string | null;
  line: number | null;
  deleted: boolean;
  firstSeenAt: number;
  lastActivityAt: number;
  /** Every captured event for this subject, in order. */
  history: PrActivityHistoryEntry[];
}

export interface PrStateChange {
  action: string;
  actorLogin: string | null;
  occurredAt: number;
}

export interface ReconstructedPrConversation {
  /** Latest captured PR title (from the whitelisted raw_json of the newest pull_request event). */
  title: string | null;
  /** Latest captured PR description. */
  body: string | null;
  /** Coarse current state derived from the newest state-changing pull_request action, or null. */
  state: "open" | "closed" | "draft" | null;
  /** pull_request actions in chronological order. */
  stateTimeline: PrStateChange[];
  /** Comment/review subjects, ordered by first appearance. */
  subjects: ReconstructedPrSubject[];
}

function titleFromRawJson(rawJson: string): string | null {
  try {
    const parsed = JSON.parse(rawJson) as { title?: unknown };
    return typeof parsed.title === "string" ? parsed.title : null;
  } catch {
    return null;
  }
}

function deriveState(action: string, previous: "open" | "closed" | "draft" | null): "open" | "closed" | "draft" | null {
  switch (action) {
    case "opened":
    case "reopened":
    case "ready_for_review":
      return "open";
    case "closed":
      return "closed";
    case "converted_to_draft":
      return "draft";
    // edited / synchronize / others do not change PR open/closed/draft state.
    default:
      return previous;
  }
}

/** Fold an ordered event log into a current-state + full-history view of a PR's conversation. */
export function reconstructPrConversation(events: PrActivityEvent[]): ReconstructedPrConversation {
  // Defensive re-sort: reconstruction folds in action-time order (the list DAO
  // already returns this order, but callers may pass an arbitrary array).
  const ordered = [...events].sort((a, b) => a.occurredAt - b.occurredAt || a.id - b.id);

  let title: string | null = null;
  let body: string | null = null;
  let state: "open" | "closed" | "draft" | null = null;
  const stateTimeline: PrStateChange[] = [];

  const subjectsById = new Map<string, ReconstructedPrSubject>();
  const subjectOrder: string[] = [];

  for (const event of ordered) {
    if (event.eventType === "pull_request") {
      // Every pull_request payload carries the current title/body; newest wins.
      title = titleFromRawJson(event.rawJson) ?? title;
      body = event.body ?? body;
      state = deriveState(event.action, state);
      stateTimeline.push({ action: event.action, actorLogin: event.actorLogin, occurredAt: event.occurredAt });
      continue;
    }

    const subjectId = event.subjectId;
    if (!subjectId) continue; // a non-PR event with no subject id — nothing to fold

    let subject = subjectsById.get(subjectId);
    if (!subject) {
      subject = {
        subjectId,
        eventType: event.eventType,
        author: { login: event.subjectAuthorLogin, type: event.subjectAuthorType },
        currentBody: null,
        reviewState: null,
        filePath: event.filePath,
        line: event.line,
        deleted: false,
        firstSeenAt: event.occurredAt,
        lastActivityAt: event.occurredAt,
        history: [],
      };
      subjectsById.set(subjectId, subject);
      subjectOrder.push(subjectId);
    }

    subject.lastActivityAt = event.occurredAt;
    if (event.subjectAuthorLogin) subject.author = { login: event.subjectAuthorLogin, type: event.subjectAuthorType };
    if (event.body !== null) subject.currentBody = event.body;
    if (event.reviewState) subject.reviewState = event.reviewState;
    if (event.filePath) subject.filePath = event.filePath;
    if (event.line !== null) subject.line = event.line;
    if (event.action === "deleted") subject.deleted = true;
    subject.history.push({
      action: event.action,
      body: event.body,
      actorLogin: event.actorLogin,
      occurredAt: event.occurredAt,
    });
  }

  return {
    title,
    body,
    state,
    stateTimeline,
    subjects: subjectOrder.map((id) => subjectsById.get(id) as ReconstructedPrSubject),
  };
}
