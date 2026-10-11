-- Parentless PR verification coordinators use deterministic synthetic session_id
-- values (`pr-coord:<encoded-pr-url>`) so the existing session_id-keyed FSM CAS
-- can coordinate a human-authored PR without a real parent session.
--
-- Historical Arcanist session rows may duplicate pr_url, so uniqueness is scoped
-- only to synthetic coordinator rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_coordination_synthetic_pr_url
ON pr_coordination(pr_url)
WHERE pr_url IS NOT NULL
  AND session_id LIKE 'pr-coord:%';
