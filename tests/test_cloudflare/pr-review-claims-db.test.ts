import { beforeEach, describe, expect, it } from "vitest";

import {
  associatePrReviewTriggerSession,
  claimPrReviewTrigger,
  completePrReviewTrigger,
  getPrReviewTriggerClaim,
  releasePrReviewTrigger,
} from "../../apps/control-plane-worker/src/session/pr-review-claims-db";
import { createControlPlaneD1 } from "./helpers/seed-db";

const PR_URL = "https://github.com/acme/repo/pull/123";
const NOW = 1_800_000_000_000;
const STALE_AFTER_MS = 30 * 60 * 1000;

let db: D1Database;

beforeEach(() => {
  db = createControlPlaneD1().d1;
});

describe("PR review trigger claims DAO", () => {
  it("lets the first claim win and rejects contention", async () => {
    await expect(
      claimPrReviewTrigger(db, { prUrl: PR_URL, triggerCommentId: 10, now: NOW, staleAfterMs: STALE_AFTER_MS }),
    ).resolves.toEqual({ won: true });
    await expect(
      claimPrReviewTrigger(db, { prUrl: PR_URL, triggerCommentId: 11, now: NOW + 1, staleAfterMs: STALE_AFTER_MS }),
    ).resolves.toEqual({ won: false });
  });

  it("does not overtake a completed claim, even after the stale window", async () => {
    await claimPrReviewTrigger(db, {
      prUrl: PR_URL,
      triggerCommentId: 10,
      now: NOW - STALE_AFTER_MS - 1,
      staleAfterMs: STALE_AFTER_MS,
    });
    await associatePrReviewTriggerSession(db, { prUrl: PR_URL, triggerCommentId: 10, sessionId: "old-session" });
    await completePrReviewTrigger(db, { prUrl: PR_URL, claimToken: "comment:10" });

    await expect(
      claimPrReviewTrigger(db, { prUrl: PR_URL, triggerCommentId: 11, now: NOW, staleAfterMs: STALE_AFTER_MS }),
    ).resolves.toEqual({ won: false });
    await expect(getPrReviewTriggerClaim(db, { prUrl: PR_URL })).resolves.toEqual({
      prUrl: PR_URL,
      claimedAt: NOW - STALE_AFTER_MS - 1,
      triggerCommentId: 10,
      claimToken: "comment:10",
      status: "completed",
      triggerSource: "webhook",
      sessionId: "old-session",
    });
  });

  it("associates the spawned session only with the matching claim", async () => {
    await claimPrReviewTrigger(db, { prUrl: PR_URL, triggerCommentId: 10, now: NOW });

    await expect(
      associatePrReviewTriggerSession(db, { prUrl: PR_URL, triggerCommentId: 11, sessionId: "wrong-session" }),
    ).resolves.toEqual({ updated: false });
    await expect(
      associatePrReviewTriggerSession(db, { prUrl: PR_URL, triggerCommentId: 10, sessionId: "review-session" }),
    ).resolves.toEqual({ updated: true });
    await expect(getPrReviewTriggerClaim(db, { prUrl: PR_URL })).resolves.toMatchObject({
      triggerCommentId: 10,
      sessionId: "review-session",
      status: "in_flight",
    });
    await expect(completePrReviewTrigger(db, { prUrl: PR_URL, claimToken: "comment:10" })).resolves.toEqual({
      updated: true,
    });
  });

  it("lets a stale in-flight attempt be overtaken without cross-association", async () => {
    await claimPrReviewTrigger(db, {
      prUrl: PR_URL,
      claimToken: "old",
      triggerCommentId: 10,
      now: NOW - STALE_AFTER_MS - 1,
    });
    await expect(
      claimPrReviewTrigger(db, { prUrl: PR_URL, claimToken: "new", triggerCommentId: 11, now: NOW }),
    ).resolves.toEqual({ won: true });
    await expect(
      associatePrReviewTriggerSession(db, { prUrl: PR_URL, claimToken: "old", sessionId: "old-session" }),
    ).resolves.toEqual({ updated: false });
    await expect(
      associatePrReviewTriggerSession(db, { prUrl: PR_URL, claimToken: "new", sessionId: "new-session" }),
    ).resolves.toEqual({ updated: true });
  });

  it("does not let an old trigger release a newer claim", async () => {
    await claimPrReviewTrigger(db, { prUrl: PR_URL, triggerCommentId: 10, now: NOW - STALE_AFTER_MS - 1 });
    await claimPrReviewTrigger(db, { prUrl: PR_URL, triggerCommentId: 11, now: NOW });

    await releasePrReviewTrigger(db, { prUrl: PR_URL, triggerCommentId: 10 });
    await expect(getPrReviewTriggerClaim(db, { prUrl: PR_URL })).resolves.toMatchObject({ triggerCommentId: 11 });

    await releasePrReviewTrigger(db, { prUrl: PR_URL, triggerCommentId: 11 });
    await expect(getPrReviewTriggerClaim(db, { prUrl: PR_URL })).resolves.toBeNull();
  });
});
