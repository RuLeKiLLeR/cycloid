ALTER TABLE pr_review_trigger_claims ADD COLUMN claim_token TEXT;
ALTER TABLE pr_review_trigger_claims ADD COLUMN status TEXT NOT NULL DEFAULT 'in_flight';
ALTER TABLE pr_review_trigger_claims ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'webhook';

UPDATE pr_review_trigger_claims
SET claim_token = 'comment:' || trigger_comment_id
WHERE claim_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pr_review_trigger_claims_claim_token_idx
  ON pr_review_trigger_claims (pr_url, claim_token);
