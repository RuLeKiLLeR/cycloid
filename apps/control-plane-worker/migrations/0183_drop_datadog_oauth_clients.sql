-- Drop the abandoned Datadog OAuth cutover table. The OAuth-cutover feature
-- (0075/0076/0077) never shipped; the Datadog integration runtime is still
-- API-key based (src/integrations/runtime.ts). datadog_oauth_clients has zero
-- application readers and only ever cached DCR client_ids for the unshipped
-- flow, so there is no data to preserve. Destructive-change exception: proven
-- zero readers, no live feature. Do not edit 0075-0077 (deployed).
DROP TABLE IF EXISTS datadog_oauth_clients;
