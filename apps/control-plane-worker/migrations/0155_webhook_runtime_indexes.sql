-- Move the last runtime-DDL-only schema objects into migrations so the
-- per-isolate ensureWebhookSchema()/ensureVerificationSchedulerSchema()
-- hot-path DDL can be deleted. Both indexes already exist in prod/QA via the
-- runtime DDL, so this is a no-op there; fresh environments get them here.
-- verification_session_requests needs no backfill: prod and QA were verified
-- (PRAGMA table_info) to already match 0140's full column set.

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_webhook_refs_one_per_github_issue
  ON session_webhook_refs(source, external_ref)
  WHERE source = 'github_issue';

CREATE INDEX IF NOT EXISTS idx_webhook_idempotency_source_time
  ON webhook_idempotency(source, received_at);
