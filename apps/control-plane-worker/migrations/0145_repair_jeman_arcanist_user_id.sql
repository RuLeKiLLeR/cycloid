-- Repair the production row created by the original 0143 migration.
-- Session owners must be positive integers, so move jeman-arcanist from the
-- temporary negative internal id to the stable positive GitHub-derived id.

UPDATE users
SET github_id = -71931994,
    login = 'jeman-arcanist-legacy-negative-id',
    updated_at = unixepoch() * 1000
WHERE id = -71931994
  AND github_id = 71931994
  AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = 71931994
  );

INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
SELECT
  71931994,
  71931994,
  'jeman-arcanist',
  name,
  email,
  avatar_url,
  business_id,
  created_at,
  unixepoch() * 1000
FROM users
WHERE id = -71931994
  AND github_id = -71931994
  AND NOT EXISTS (
    SELECT 1
    FROM users
    WHERE id = 71931994
  );

UPDATE auth_sessions SET user_id = 71931994 WHERE user_id = -71931994;
UPDATE business_members SET user_id = 71931994 WHERE user_id = -71931994;
UPDATE business_test_credentials SET rotated_by_user_id = 71931994 WHERE rotated_by_user_id = -71931994;
UPDATE child_session_limit_reservations SET spawned_by_user_id = 71931994 WHERE spawned_by_user_id = -71931994;
UPDATE cli_tokens SET user_id = 71931994 WHERE user_id = -71931994;
UPDATE env_blobs SET owner_user_id = 71931994 WHERE owner_user_id = -71931994;
UPDATE github_installation_repositories_cache SET user_id = 71931994 WHERE user_id = -71931994;
UPDATE impersonation_sessions SET actor_user_id = 71931994 WHERE actor_user_id = -71931994;
UPDATE impersonation_sessions SET target_user_id = 71931994 WHERE target_user_id = -71931994;
UPDATE incident_analyzer_configs SET configured_by_user_id = '71931994' WHERE configured_by_user_id = '-71931994';
UPDATE integration_lifecycle_events SET user_id = 71931994 WHERE user_id = -71931994;
UPDATE linear_webhook_installations SET connected_by_user_id = 71931994 WHERE connected_by_user_id = -71931994;
UPDATE managed_user_provider_credentials SET user_id = 71931994 WHERE user_id = -71931994;
UPDATE managed_user_provider_credentials SET assigned_by_user_id = 71931994 WHERE assigned_by_user_id = -71931994;
UPDATE memory_review_candidates SET resolved_by_user_id = 71931994 WHERE resolved_by_user_id = -71931994;
UPDATE openai_gateway_ledger SET owner_user_id = 71931994 WHERE owner_user_id = -71931994;
UPDATE openai_gateway_session_tokens SET owner_user_id = 71931994 WHERE owner_user_id = -71931994;
UPDATE openai_virtual_keys SET owner_user_id = '71931994' WHERE owner_user_id = '-71931994';
UPDATE pending_signups SET denied_by_user_id = 71931994 WHERE denied_by_user_id = -71931994;
UPDATE pr_review_response_epochs SET owner_user_id = 71931994 WHERE owner_user_id = -71931994;
UPDATE pr_review_status_comments SET owner_user_id = 71931994 WHERE owner_user_id = -71931994;
UPDATE prompt_runs SET owner_user_id = 71931994 WHERE owner_user_id = -71931994;
UPDATE scheduled_rules SET configured_by_user_id = '71931994' WHERE configured_by_user_id = '-71931994';
UPDATE session_completions SET owner_user_id = 71931994 WHERE owner_user_id = -71931994;
UPDATE session_evaluations SET owner_user_id = 71931994 WHERE owner_user_id = -71931994;
UPDATE session_feedback SET user_id = 71931994 WHERE user_id = -71931994;
UPDATE session_index SET owner_user_id = 71931994 WHERE owner_user_id = -71931994;
UPDATE session_index SET spawned_by_user_id = 71931994 WHERE spawned_by_user_id = -71931994;
UPDATE slack_channel_intake SET enabled_by_user_id = 71931994 WHERE enabled_by_user_id = -71931994;
UPDATE slack_repo_disambiguations SET actor_user_id = 71931994 WHERE actor_user_id = -71931994;
UPDATE slack_workspaces SET installed_by_user_id = 71931994 WHERE installed_by_user_id = -71931994;
UPDATE usage_records SET owner_user_id = 71931994 WHERE owner_user_id = -71931994;
UPDATE user_integration_health_checks SET user_id = 71931994 WHERE user_id = -71931994;
UPDATE user_integrations SET user_id = 71931994 WHERE user_id = -71931994;
UPDATE user_pr_review_bot_settings SET user_id = 71931994 WHERE user_id = -71931994;
UPDATE user_settings SET user_id = 71931994 WHERE user_id = -71931994;

DELETE FROM users
WHERE id = -71931994
  AND github_id = -71931994
  AND EXISTS (
    SELECT 1
    FROM users
    WHERE id = 71931994
      AND github_id = 71931994
  );
