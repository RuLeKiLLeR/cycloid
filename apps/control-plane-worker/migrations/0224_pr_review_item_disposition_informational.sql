-- Review-loop NOISE GATE (D4): add the `no_action_needed_informational` terminal disposition.
-- A purely-informational bot output (a known bot's "no findings" message / an empty commented review)
-- is auto-dispositioned at worklist ingest so it is counted as handled and NEVER prompted (the sweep's
-- noise gate — services/review-loop-sweep.ts). Like the other terminal stamps it is excluded from the
-- `caught_up` conjunction (countUndispositionedActionable counts only `none`), so a gated item neither
-- gates settle nor is released to dispatch.
--
-- SQLite cannot ALTER a CHECK constraint in place, so this rebuilds the table with the widened CHECK,
-- copies every row, and recreates the index. Append-only + data-preserving. Keep the column set / PK /
-- index IDENTICAL to 0216 apart from the widened CHECK. `disposition` mirrors fsm/types.ts `Disposition`
-- and pr-review-item-disposition-db.ts `ItemDisposition`.

CREATE TABLE pr_review_item_dispositions_new (
  session_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  source_id TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'none' CHECK (
    disposition IN ('none', 'fixed', 'replied', 'declined', 'no_action_needed_informational')
  ),
  basis TEXT,
  epoch_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, pr_url, source_id)
);

INSERT INTO pr_review_item_dispositions_new (
  session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at
)
SELECT session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at
FROM pr_review_item_dispositions;

DROP TABLE pr_review_item_dispositions;

ALTER TABLE pr_review_item_dispositions_new RENAME TO pr_review_item_dispositions;

CREATE INDEX IF NOT EXISTS idx_pr_review_item_dispositions_disposition
  ON pr_review_item_dispositions (session_id, pr_url, disposition);
