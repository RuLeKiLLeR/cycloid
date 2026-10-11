-- ARC-1330 lifecycle FSM — the per-PR-per-reviewer first-contact settle store (PR 22A,
-- v7 latency delta §B4/§B5/§B6 + the v8 per-kind-window pin). One row per
-- (session, PR, reviewer): the first-contact no-show LATCH that the `caught_up`
-- conjunction's "expected reviewers settled" conjunct reads (design §6/§9, PR 9
-- `CaughtUpStore.allReviewersSettled`). The SINGLE authoritative reviewer-settle set.
--
-- Lifecycle of one row (paid once, persisted across heads):
--   • ARMED ONCE at `init_record` (the `publish.pr_opened → REVIEW` transition) — a
--     `pending` row per expected reviewer, with `first_contact_armed_at` stamped, so the
--     first-contact clock runs concurrently with CI-settle / epoch-1 / QA (v8 pin). The
--     window is keyed by `reviewer_kind` at arm time: an installed review app (bot) gets a
--     short window (~2-3 min) and stays `pending` until the per-session DO alarm fires
--     (PR 43); a human gets window 0 and is armed straight to `no_show` (optimistic — a
--     human never gates the first `caught_up`; a late post re-opens via the §9 path, PR 18).
--   • SETTLED to `responded` (the reviewer posted, via the `review.received` producer) or
--     `no_show` (the window elapsed, via the DO alarm). STICKY / paid once: once a row
--     leaves `pending` it is frozen — later heads never re-arm it (kills the v6 "10 min
--     every epoch" waste) and a late `responded` after a `no_show` does not un-stick it.
--
-- `caught_up` requires zero `pending` rows for the PR (every expected reviewer settled).
-- Expected-set membership FAILS TOWARD NOT-WAITING: an unconfirmable reviewer is simply
-- never armed (no row), so it cannot block `caught_up`; it re-opens via §9 if it later posts.
--
-- Pure substrate: shadow/additive — no live surface reads or writes this yet (FSM_MODE
-- wiring lands in a later wave). `reviewer_kind` mirrors §18.2 `bot | human`; `settle`
-- mirrors `fsm/reviewer-settle.ts` `ReviewerSettleState`.
CREATE TABLE IF NOT EXISTS pr_review_reviewer_settle (
  session_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewer_kind TEXT NOT NULL DEFAULT 'bot' CHECK (reviewer_kind IN ('bot', 'human')),
  settle TEXT NOT NULL DEFAULT 'pending' CHECK (settle IN ('pending', 'responded', 'no_show')),
  first_contact_armed_at INTEGER,
  settled_at INTEGER,
  PRIMARY KEY (session_id, pr_url, reviewer_id)
);

CREATE INDEX IF NOT EXISTS idx_pr_review_reviewer_settle_settle
  ON pr_review_reviewer_settle (session_id, pr_url, settle);
