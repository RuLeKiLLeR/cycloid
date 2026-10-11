-- ARC-1242: give the carry-forward wave cap its own progress-based counter instead of reusing
-- attempt_count. attempt_count is bumped on every claim (including reclaim/crash re-drives), so a
-- flaky drain could hit the wave cap before completing its genuine productive waves and park early
-- for human follow-up. This counter increments once per dispatch when the carried tail did NOT
-- shrink (no forward progress) and resets to 0 when it shrinks, so reclaim/crash cycles no longer
-- consume the budget — only consecutive non-progress does. Backfills to 0 (safe: at worst one extra
-- productive wave for any in-flight drain at deploy).
ALTER TABLE pr_review_response_epochs
  ADD COLUMN carry_forward_no_progress_count INTEGER NOT NULL DEFAULT 0;
