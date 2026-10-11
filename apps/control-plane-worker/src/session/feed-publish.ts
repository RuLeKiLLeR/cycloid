// Fire-and-forget transport from a mutation site to the per-business feed DO
// (ARC-1322). Every list-relevant mutation calls `publishListDelta` *after* its
// durable D1 write / existing per-session broadcast, so a delta can never
// describe state the database has not persisted.
//
// This helper never throws and never blocks: a missed nudge is recovered by the
// frontend's reconnect/poll, so there is deliberately no `withDORetry` here —
// retrying would only risk the hot mutation path. A no-op when the optional
// `SESSION_FEED` binding or the `businessId` is absent.

import type { FeedDelta } from "../../../../shared/types/session-feed.js";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger({ bindings: { component: "feed-publish" } });

export function publishListDelta(env: Env, businessId: string | null | undefined, delta: FeedDelta): void {
  if (!env.SESSION_FEED || !businessId) return;

  try {
    log.debug(
      { event: "feed_publish", source: delta.source, sessionId: delta.sessionId, businessId, type: delta.type },
      "Publishing feed delta",
    );
    const stub = env.SESSION_FEED.get(env.SESSION_FEED.idFromName(businessId));
    void stub
      .fetch("https://internal/feed/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(delta),
      })
      .catch((error: unknown) => {
        log.warn(
          { event: "feed_publish_failed", sessionId: delta.sessionId, businessId, error: String(error) },
          "Feed publish fetch failed",
        );
      });
  } catch (error) {
    // Defensive: idFromName / get / JSON.stringify must never fail a caller.
    log.warn(
      { event: "feed_publish_threw", sessionId: delta.sessionId, businessId, error: String(error) },
      "Feed publish threw",
    );
  }
}
