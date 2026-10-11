-- ARC-1330 lifecycle FSM — the per-item review disposition store (PR 22).
-- The SINGLE authoritative item set the `caught_up` conjunction reads (Locked
-- decision 1, design §13/SF15): one row per (session, PR, source item). A row is
-- minted UNDISPOSITIONED (`disposition = 'none'`) by `register_review` /
-- `inject_findings`, then stamped to a terminal disposition by the epoch terminals
-- (`epoch.committed → fixed`, `epoch.replied → replied`, `epoch.declined → declined`).
-- `caught_up` requires zero `none` rows for the PR (every actionable item dispositioned).
--
-- `epoch.declined` is produced by TRIAGE-WITH-BASIS — a classification that the item
-- needs no code change PLUS the agent's reasoned reply — never an unchecked self-signal
-- (design §13). The `basis` column carries that reasoning; the DAO refuses a `declined`
-- row with no basis so a fix agent cannot self-decline real reviews to reach MERGE_READY.
--
-- Pure substrate: shadow/additive — no live surface reads or writes this yet (FSM_MODE
-- wiring lands in a later wave). `disposition` mirrors `fsm/types.ts` `Disposition`.
CREATE TABLE IF NOT EXISTS pr_review_item_dispositions (
  session_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  source_id TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'none' CHECK (disposition IN ('none', 'fixed', 'replied', 'declined')),
  basis TEXT,
  epoch_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, pr_url, source_id)
);

CREATE INDEX IF NOT EXISTS idx_pr_review_item_dispositions_disposition
  ON pr_review_item_dispositions (session_id, pr_url, disposition);
