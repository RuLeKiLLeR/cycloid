-- Slack-channel delivery for scheduled automations (ARC-1195).
-- Adds the delivery target (Slack team + channel) and last-delivery status.
-- All columns nullable and back-compatible: a rule with no channel simply
-- skips Slack delivery, and delivery status is observability-only.
ALTER TABLE scheduled_rules ADD COLUMN slack_team_id TEXT;
ALTER TABLE scheduled_rules ADD COLUMN slack_channel_id TEXT;
ALTER TABLE scheduled_rules ADD COLUMN last_delivered_at INTEGER;
ALTER TABLE scheduled_rules ADD COLUMN last_delivery_error TEXT;
