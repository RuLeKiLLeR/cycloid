-- Split biz-friends into per-user businesses so each friend is isolated.
-- Must run before the repo authorization code change is deployed.

-- Step 1: Create per-friend businesses (shared_sessions=0 since each has one user)
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-shreypjain', 'shreypjain', 0, unixepoch() * 1000, unixepoch() * 1000);
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-ssreeni1', 'ssreeni1', 0, unixepoch() * 1000, unixepoch() * 1000);
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-geneparmigiana', 'geneparmigiana', 0, unixepoch() * 1000, unixepoch() * 1000);
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-jagritc', 'jagritc', 0, unixepoch() * 1000, unixepoch() * 1000);
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-varun901', 'varun901', 0, unixepoch() * 1000, unixepoch() * 1000);
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-samyu', 'samyu', 0, unixepoch() * 1000, unixepoch() * 1000);
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-kirubarajan', 'kirubarajan', 0, unixepoch() * 1000, unixepoch() * 1000);
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-mshkodra', 'mshkodra', 0, unixepoch() * 1000, unixepoch() * 1000);
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-pranaykotian', 'pranaykotian', 0, unixepoch() * 1000, unixepoch() * 1000);

-- Step 2: Reassign each friend's user row to their new business
UPDATE users SET business_id = 'biz-shreypjain', updated_at = unixepoch() * 1000
WHERE LOWER(login) = 'shreypjain' AND business_id = 'biz-friends';
UPDATE users SET business_id = 'biz-ssreeni1', updated_at = unixepoch() * 1000
WHERE LOWER(login) = 'ssreeni1' AND business_id = 'biz-friends';
UPDATE users SET business_id = 'biz-geneparmigiana', updated_at = unixepoch() * 1000
WHERE LOWER(login) = 'geneparmigiana' AND business_id = 'biz-friends';
UPDATE users SET business_id = 'biz-jagritc', updated_at = unixepoch() * 1000
WHERE LOWER(login) = 'jagritc' AND business_id = 'biz-friends';
UPDATE users SET business_id = 'biz-varun901', updated_at = unixepoch() * 1000
WHERE LOWER(login) = 'varun901' AND business_id = 'biz-friends';
UPDATE users SET business_id = 'biz-samyu', updated_at = unixepoch() * 1000
WHERE LOWER(login) = 'samyu' AND business_id = 'biz-friends';
UPDATE users SET business_id = 'biz-kirubarajan', updated_at = unixepoch() * 1000
WHERE LOWER(login) = 'kirubarajan' AND business_id = 'biz-friends';
UPDATE users SET business_id = 'biz-mshkodra', updated_at = unixepoch() * 1000
WHERE LOWER(login) = 'mshkodra' AND business_id = 'biz-friends';
UPDATE users SET business_id = 'biz-pranaykotian', updated_at = unixepoch() * 1000
WHERE LOWER(login) = 'pranaykotian' AND business_id = 'biz-friends';

-- Step 3: Reassign business_members rows to match
UPDATE business_members SET business_id = 'biz-shreypjain', updated_at = unixepoch() * 1000
WHERE business_id = 'biz-friends' AND user_id IN (SELECT id FROM users WHERE LOWER(login) = 'shreypjain');
UPDATE business_members SET business_id = 'biz-ssreeni1', updated_at = unixepoch() * 1000
WHERE business_id = 'biz-friends' AND user_id IN (SELECT id FROM users WHERE LOWER(login) = 'ssreeni1');
UPDATE business_members SET business_id = 'biz-geneparmigiana', updated_at = unixepoch() * 1000
WHERE business_id = 'biz-friends' AND user_id IN (SELECT id FROM users WHERE LOWER(login) = 'geneparmigiana');
UPDATE business_members SET business_id = 'biz-jagritc', updated_at = unixepoch() * 1000
WHERE business_id = 'biz-friends' AND user_id IN (SELECT id FROM users WHERE LOWER(login) = 'jagritc');
UPDATE business_members SET business_id = 'biz-varun901', updated_at = unixepoch() * 1000
WHERE business_id = 'biz-friends' AND user_id IN (SELECT id FROM users WHERE LOWER(login) = 'varun901');
UPDATE business_members SET business_id = 'biz-samyu', updated_at = unixepoch() * 1000
WHERE business_id = 'biz-friends' AND user_id IN (SELECT id FROM users WHERE LOWER(login) = 'samyu');
UPDATE business_members SET business_id = 'biz-kirubarajan', updated_at = unixepoch() * 1000
WHERE business_id = 'biz-friends' AND user_id IN (SELECT id FROM users WHERE LOWER(login) = 'kirubarajan');
UPDATE business_members SET business_id = 'biz-mshkodra', updated_at = unixepoch() * 1000
WHERE business_id = 'biz-friends' AND user_id IN (SELECT id FROM users WHERE LOWER(login) = 'mshkodra');
UPDATE business_members SET business_id = 'biz-pranaykotian', updated_at = unixepoch() * 1000
WHERE business_id = 'biz-friends' AND user_id IN (SELECT id FROM users WHERE LOWER(login) = 'pranaykotian');
