-- Hard cut: existing Datadog integrations are API-key based (api_key + oauth_access_token
-- misused to store the application key). OAuth replaces both. Drop the rows so customers
-- reconnect via the OAuth flow.
DELETE FROM business_integration_credentials WHERE integration_id = 'datadog';

-- Cache DCR (Dynamic Client Registration) client_ids per Datadog site. Datadog's MCP
-- OAuth server issues a stable client_id per site on registration; we cache it so the
-- first customer on a site pays the registration cost and everyone else reuses it.
CREATE TABLE datadog_oauth_clients (
  site TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);
