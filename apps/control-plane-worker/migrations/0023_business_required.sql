-- Make business_id NOT NULL on users.
-- D1 doesn't support ALTER COLUMN, so we recreate the users table.
-- Four tables reference users(id) via FK: auth_sessions, user_settings,
-- business_members, user_integrations. We back them up, drop them,
-- recreate users, then restore them.

-- Step 1: Ensure arcanist and friends businesses exist (no-op in prod, needed for fresh local dev)
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-arcanist', 'Arcanist', 1, unixepoch() * 1000, unixepoch() * 1000);
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-friends', 'Friends', 1, unixepoch() * 1000, unixepoch() * 1000);

-- Step 2: Assign orphan users to friends business
UPDATE users SET business_id = 'biz-friends', updated_at = unixepoch() * 1000
WHERE business_id IS NULL;

-- Step 3: Ensure all users have a business_members row
INSERT OR IGNORE INTO business_members (business_id, user_id, role, created_at, updated_at)
SELECT business_id, id, 'member', unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE id NOT IN (SELECT user_id FROM business_members);

-- Step 4: Back up everything
CREATE TABLE _bak_users AS SELECT * FROM users;
CREATE TABLE _bak_auth_sessions AS SELECT * FROM auth_sessions;
CREATE TABLE _bak_user_settings AS SELECT * FROM user_settings;
CREATE TABLE _bak_business_members AS SELECT * FROM business_members;
CREATE TABLE _bak_user_integrations AS SELECT * FROM user_integrations;

-- Step 5: Drop FK-referencing tables, then users
DROP TABLE auth_sessions;
DROP TABLE user_settings;
DROP TABLE business_members;
DROP TABLE user_integrations;
DROP TABLE users;

-- Step 6: Recreate users with business_id NOT NULL
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id INTEGER UNIQUE NOT NULL,
    login TEXT NOT NULL,
    name TEXT,
    email TEXT,
    avatar_url TEXT,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_users_github_id ON users(github_id);

-- Step 7: Restore users data
INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
SELECT id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at
FROM _bak_users;

-- Step 8: Recreate dependent tables and restore data
CREATE TABLE auth_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
INSERT INTO auth_sessions SELECT * FROM _bak_auth_sessions;

CREATE TABLE user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    theme TEXT DEFAULT 'system',
    notifications_enabled INTEGER DEFAULT 1,
    default_model TEXT,
    custom_instructions TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    default_repo TEXT
);
INSERT INTO user_settings SELECT * FROM _bak_user_settings;

CREATE TABLE business_members (
    business_id TEXT NOT NULL REFERENCES businesses(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (business_id, user_id),
    UNIQUE (user_id)
);
CREATE INDEX idx_business_members_user ON business_members(user_id);
INSERT INTO business_members SELECT * FROM _bak_business_members;

CREATE TABLE user_integrations (
    user_id INTEGER NOT NULL REFERENCES users(id),
    integration_id TEXT NOT NULL CHECK(integration_id IN ('github', 'linear', 'slack', 'grafana', 'anthropic', 'openai')),
    oauth_access_token TEXT,
    oauth_refresh_token TEXT,
    oauth_expires_at INTEGER,
    api_key TEXT,
    external_user_id TEXT,
    service_url TEXT,
    encrypted INTEGER NOT NULL DEFAULT 0,
    connected_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, integration_id)
);
CREATE INDEX idx_user_integrations_integration ON user_integrations(integration_id);
CREATE UNIQUE INDEX idx_user_integrations_external_user
    ON user_integrations(integration_id, external_user_id)
    WHERE external_user_id IS NOT NULL;
INSERT INTO user_integrations SELECT * FROM _bak_user_integrations;

-- Step 9: Clean up backup tables
DROP TABLE _bak_users;
DROP TABLE _bak_auth_sessions;
DROP TABLE _bak_user_settings;
DROP TABLE _bak_business_members;
DROP TABLE _bak_user_integrations;
