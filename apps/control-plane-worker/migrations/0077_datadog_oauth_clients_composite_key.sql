-- Rebuild the Datadog DCR client cache so separate callback origins can
-- coexist for the same Datadog site. Existing NULL redirect_uri rows are a
-- legacy cache with unknown registration metadata, so they are intentionally
-- dropped and will be re-registered on first use.
CREATE TABLE datadog_oauth_clients_next (
  site TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_id TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  PRIMARY KEY (site, redirect_uri)
);

INSERT OR IGNORE INTO datadog_oauth_clients_next (site, redirect_uri, client_id, registered_at)
SELECT site, redirect_uri, client_id, registered_at
FROM datadog_oauth_clients
WHERE redirect_uri IS NOT NULL;

DROP TABLE datadog_oauth_clients;

ALTER TABLE datadog_oauth_clients_next RENAME TO datadog_oauth_clients;
