-- Durable Slack workspace (team) for a user's linked Slack identity. Slack user
-- ids are workspace-scoped, so any DM to a user needs the team their id is valid
-- in. The only prior record of that team was slack_link_token_consumptions, whose
-- rows carry the 10-minute magic-link token expiry and are pruned on every bind
-- (pruneExpiredSlackLinkConsumptions), so the team binding vanished ~10 minutes
-- after linking. This column persists it durably on the never-expiring link row.
-- Slack-only today; null for every other integration and for links bound before
-- this migration (those fall back to the ledger, then fail closed).
ALTER TABLE user_integrations ADD COLUMN external_team_id TEXT;
