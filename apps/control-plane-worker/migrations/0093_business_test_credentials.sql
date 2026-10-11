-- Per-repo test credentials referenced by appRuntime.e2e.credentials[].name
-- in `.arcanist.json`. Values are encrypted at rest using the same AES-GCM
-- helper as business_integration_credentials. Decrypted values are injected
-- into the sandbox via the declared envVar at session start; missing-but-declared
-- credentials fail closed (the session does not start).
CREATE TABLE IF NOT EXISTS business_test_credentials (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 1 CHECK(encrypted IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  rotated_by_user_id INTEGER REFERENCES users(id),
  PRIMARY KEY (business_id, repo_owner, repo_name, name)
);

CREATE INDEX IF NOT EXISTS idx_business_test_credentials_repo
  ON business_test_credentials (business_id, repo_owner, repo_name);
