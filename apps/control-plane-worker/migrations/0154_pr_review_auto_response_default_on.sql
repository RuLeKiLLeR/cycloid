-- Review loop (human review + CI-fix auto-response) becomes default-on.
-- Existing rows are backfilled to enabled: pre-revenue, 0 rows mix true
-- opt-outs with never-configured users and the settings toggle remains the
-- escape hatch. Application code now treats a missing settings row as enabled
-- and inserts 1 for new rows; the column's schema DEFAULT 0 from migration
-- 0084 is left untouched (deployed migrations are immutable).
UPDATE user_settings SET pr_review_auto_response_enabled = 1;
