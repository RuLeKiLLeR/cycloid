-- ARC-1330 Wave 11 D-54: drop pr_mergeability_attempts (migrations 0139 + 0197).
-- The one KEEP from this table -- the ARC-1302 "our own server-side update-branch queued" marker
-- (update_branch_queued_at) -- now lives on the FSM spine (pr_coordination, migration 0214). W11-V9
-- (#6474) dual-wrote the marker onto pr_coordination at the review-loop sweep caller and made the
-- head-change carry-forward gate prefer the spine value; D-54 removes the legacy fallback so the spine
-- is the sole source (SF22).
--
-- The per-(session_id, pr_url, head_sha) attempt counter (attempt_count / last_attempt_at) that used
-- to gate the update-branch cooldown + retry cap is FOLDED, not re-homed (design v4 §4/§14: only
-- update_branch_queued_at survives; the counter is a dropped "per-PR record attribute + CAS"). The
-- sweep now keys the "already queued, don't re-issue" cooldown and the "base-merge stuck, surface to
-- the owner" give-up off the spine marker (a per-head signal that clears when the head advances), and
-- dedups the rebase / branch-update notices off the epoch blocked-state. No index to drop (PK only).
--
-- All code references were removed before this destructive migration.
--
-- SF22 self-sufficiency (review finding on #6521): before dropping, backfill any queued marker that
-- V9's dual-write missed (pre-V9 in-flight rows). The join keys on the EXACT (session_id, pr_url,
-- head_sha), so this copies only markers whose head is still the live spine head -- the at-risk class
-- whose next advance must read as our own base-merge. Markers on already-advanced heads have no
-- matching spine row by construction and are dead (the head they guarded is gone); they drop with
-- the table. Idempotent: only fills NULLs.
UPDATE pr_coordination
SET update_branch_queued_at = (
  SELECT m.update_branch_queued_at
  FROM pr_mergeability_attempts m
  WHERE m.session_id = pr_coordination.session_id
    AND m.pr_url = pr_coordination.pr_url
    AND m.head_sha = pr_coordination.head_sha
    AND m.update_branch_queued_at IS NOT NULL
)
WHERE update_branch_queued_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM pr_mergeability_attempts m
    WHERE m.session_id = pr_coordination.session_id
      AND m.pr_url = pr_coordination.pr_url
      AND m.head_sha = pr_coordination.head_sha
      AND m.update_branch_queued_at IS NOT NULL
  );

DROP TABLE IF EXISTS pr_mergeability_attempts;
