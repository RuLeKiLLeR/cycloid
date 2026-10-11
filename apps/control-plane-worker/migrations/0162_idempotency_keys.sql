-- Server-side honor of the CLI `Idempotency-Key` header on POST /api/sessions
-- and POST /api/sessions/:id/prompts. The CLI already sends the header but no
-- handler read it, so a retry on a lost response spawned a duplicate session
-- (full sandbox + cost) or a duplicate prompt (second agent run / second PR).
--
-- Claim-before-create state machine: a row is INSERTed `pending` before the
-- resource is created, CAS-committed with the resolved id once the resource
-- durably lands, and released (deleted) on a create failure so a later retry
-- re-claims instead of being poisoned. `resolved_id` is NULL while pending.
--
-- Scoped by `owner_user_id` (the authenticated caller), NOT global: a key
-- collision across users can never return another caller's `resolved_id`. The
-- prompt route folds the session id into `route` (e.g. `prompt:<sessionId>`)
-- so the same key on two sessions does not collide. `request_hash` is the
-- sha256 of the canonical request body, so a same-key/different-payload retry
-- is rejected rather than silently replayed.
--
-- Timestamps are INTEGER Unix milliseconds. Rows are tiny; no TTL/cleanup cron
-- ships with this migration (add later if growth matters).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  owner_user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resolved_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, key, route)
);
