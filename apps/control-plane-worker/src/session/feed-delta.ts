// Resolve the repo-access gate envelope for a feed delta from a session's
// Durable-Object SQLite row, then hand it to the fire-and-forget transport
// (ARC-1322).
//
// Mutation sites that run inside (or alongside) the SessionDO — status flips,
// the verification snapshot, PR notifications — already hold a `SqlStorage`
// handle and `env`. They build the type-specific payload and call this helper,
// which fills in `ownerUserId` / `repoOwner` / `repoName` (the gate keys) and
// the `businessId` routing key from the persisted session, keeping the
// resolution in exactly one place. Create / delete run off D1
// instead and publish directly (they hold the projection row, not DO SQLite).

import { displayStatusFromPhase } from "../../../../shared/session/display-status.js";
import type { FeedDelta, FeedDeltaInput } from "../../../../shared/types/session-feed.js";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { getSessionApiShapeById } from "./db";
import * as doDb from "./do-db.js";
import { publishListDelta } from "./feed-publish";

const log = createLogger({ bindings: { component: "feed-delta" } });

/**
 * Resolve the gate envelope + business routing key for `input.sessionId` from
 * the DO's `session` table and publish the completed delta. No-op when the
 * session row is absent (nothing to gate against).
 */
export function publishSessionFeedDelta(env: Env, sql: SqlStorage, input: FeedDeltaInput): void {
  const session = doDb.getSession(sql, input.sessionId);
  if (!session) return;
  const ext = doDb.getSessionExtended(sql, input.sessionId);
  const delta = {
    ...input,
    ownerUserId: session.ownerUserId,
    repoOwner: ext?.repoOwner ?? null,
    repoName: ext?.repoName ?? null,
  } as FeedDelta;
  publishListDelta(env, session.businessId, delta);
}

/**
 * Read the freshly-projected `session_index` row from D1 and publish a
 * `session_upserted` delta byte-identical to a fetched list row. For the
 * create / delete sites, which run off D1 (not DO SQLite). Never throws — a
 * failed feed publish must not fail the mutation it follows.
 */
export async function publishSessionUpsertedFromDb(
  env: Env,
  db: D1Database,
  sessionId: string,
  source: string,
): Promise<void> {
  try {
    const session = await getSessionApiShapeById(db, sessionId);
    if (!session) return;
    publishListDelta(env, session.businessId, {
      type: "session_upserted",
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      repoOwner: session.repoOwner ?? null,
      repoName: session.repoName ?? null,
      source,
      session,
    });
  } catch (error) {
    log.warn(
      { event: "feed_upsert_publish_failed", sessionId, source, error: String(error) },
      "Feed session_upserted publish failed",
    );
  }
}

/**
 * Read the freshly-closed session's gate envelope from D1 and publish a
 * `session_closed` delta so sidebars drop the archived row. `closeSessionState`
 * returns the DO core session row, which does NOT carry `repoOwner`/`repoName`,
 * so we read them from D1 here (publishing them as null would suppress the close
 * for non-owner teammates). No-op when the row is gone (it never had visible
 * work, so it was never in a sidebar). Never throws — a failed feed publish must
 * not fail the delete.
 */
export async function publishSessionClosedFromDb(
  env: Env,
  db: D1Database,
  sessionId: string,
  source: string,
): Promise<void> {
  try {
    const session = await getSessionApiShapeById(db, sessionId);
    if (!session) return;
    publishListDelta(env, session.businessId, {
      type: "session_closed",
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      repoOwner: session.repoOwner ?? null,
      repoName: session.repoName ?? null,
      source,
      phase: "archived",
      displayStatus: displayStatusFromPhase("archived"),
      closeReason: null,
    });
  } catch (error) {
    log.warn(
      { event: "feed_close_publish_failed", sessionId, source, error: String(error) },
      "Feed session_closed publish failed",
    );
  }
}
