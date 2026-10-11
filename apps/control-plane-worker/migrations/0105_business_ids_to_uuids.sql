DROP TRIGGER IF EXISTS trg_users_business_id_immutable;
DROP TRIGGER IF EXISTS trg_business_members_business_id_immutable;
DROP TRIGGER IF EXISTS trg_business_members_business_id_matches_user;

DROP TABLE IF EXISTS _business_id_uuid_map;
CREATE TABLE _business_id_uuid_map (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL UNIQUE
);

INSERT INTO _business_id_uuid_map (old_id, new_id) VALUES
  ('biz-arcanist', '295d2abc-d10b-4662-b84d-7bfa66242882'),
  ('biz-arcanist-qa', 'b004178c-58e4-421b-a6b9-43b410fc64ec'),
  ('biz-armory', '16c3b431-927c-487e-83b2-d8c59036b1f9'),
  ('biz-detail-dev', 'cb7d76a7-1189-4b00-83fc-023b6c6ddf53'),
  ('biz-geneparmigiana', '7a00684f-15ee-4871-83d3-3842909bd0da'),
  ('biz-jagritc', 'e78c5850-ca52-4f8b-aa54-cd8010c7f3ad'),
  ('biz-jaikondapalli', '667f14b1-8686-4246-8a5e-01eae3f24962'),
  ('biz-kirubarajan', '9a7d5cd6-bee7-4a71-a358-4ccae607c771'),
  ('biz-local-eval', '3d5e4bd3-404e-481e-9b11-996cd6633792'),
  ('biz-mshkodra', '081226aa-6b6b-49ce-9990-6d8744ed547d'),
  ('biz-pranaykotian', '85c3f196-2ed2-4535-af8e-e6187c2ea74f'),
  ('biz-samyu', '57485b0c-f7de-461a-8f9b-8b8c7d938264'),
  ('biz-shreypjain', '5b39b1cc-19ed-48c6-b015-38aa2eec9202'),
  ('biz-ssreeni1', '08da635b-26bc-4a09-a480-c1221c345eed'),
  ('biz-varun901', 'a6f6b912-dee9-4af2-94fd-7260271cff2b');

INSERT OR IGNORE INTO businesses (
  id,
  name,
  shared_sessions,
  created_at,
  updated_at,
  self_hosted_sandboxes_enabled
)
SELECT
  map.new_id,
  businesses.name,
  businesses.shared_sessions,
  businesses.created_at,
  businesses.updated_at,
  businesses.self_hosted_sandboxes_enabled
FROM businesses
INNER JOIN _business_id_uuid_map map ON map.old_id = businesses.id;

UPDATE users
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = users.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE business_members
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = business_members.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE business_integrations
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = business_integrations.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE business_integration_credentials
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = business_integration_credentials.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE business_integration_health_checks
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = business_integration_health_checks.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE business_test_credentials
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = business_test_credentials.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE codegraph_observations
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = codegraph_observations.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE env_blobs
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = env_blobs.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE integration_lifecycle_events
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = integration_lifecycle_events.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE linear_webhook_installations
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = linear_webhook_installations.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE prompt_runs
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = prompt_runs.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE session_completions
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = session_completions.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE session_index
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = session_index.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

UPDATE usage_records
SET business_id = (
  SELECT new_id FROM _business_id_uuid_map WHERE old_id = usage_records.business_id
)
WHERE business_id IN (SELECT old_id FROM _business_id_uuid_map);

DELETE FROM businesses
WHERE id IN (SELECT old_id FROM _business_id_uuid_map);

DROP TABLE _business_id_uuid_map;

CREATE TRIGGER IF NOT EXISTS trg_users_business_id_immutable
BEFORE UPDATE OF business_id ON users
FOR EACH ROW
WHEN NEW.business_id != OLD.business_id
BEGIN
  SELECT RAISE(FAIL, 'users.business_id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_business_members_business_id_immutable
BEFORE UPDATE OF business_id ON business_members
FOR EACH ROW
WHEN NEW.business_id != OLD.business_id
BEGIN
  SELECT RAISE(FAIL, 'business_members.business_id is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_business_members_business_id_matches_user
BEFORE INSERT ON business_members
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = NEW.user_id
    AND users.business_id != NEW.business_id
)
BEGIN
  SELECT RAISE(FAIL, 'business_members.business_id must match users.business_id');
END;
