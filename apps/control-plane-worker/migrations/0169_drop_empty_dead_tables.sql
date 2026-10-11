-- Drop empty, FK-standalone tables for abandoned features. Each has zero rows
-- in prod and zero application readers (verified by whole-repo audit), and no
-- other table holds a foreign key referencing it, so the drop is non-destructive
-- and order-independent.
--
--   managed_user_provider_credentials -- 0066 managed credentials, superseded
--   codegraph_builds                  -- 0041 codegraph, discontinued
--   codegraph_observations            -- codegraph, discontinued
--   incident_analyzer_configs         -- 0115 incident analyzer, never shipped
--
-- The benchmark and remaining incident/repo_images tables still hold historical
-- rows and drop separately in 0170 after a D1 export.
DROP TABLE IF EXISTS managed_user_provider_credentials;
DROP TABLE IF EXISTS codegraph_builds;
DROP TABLE IF EXISTS codegraph_observations;
DROP TABLE IF EXISTS incident_analyzer_configs;
