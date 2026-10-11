-- Add vrn21-arcanist to the internal Arcanist business as an admin.
-- Fresh environments like QA may not have the pre-existing user row that
-- 0161_promote_vrn21_arcanist_admin.sql assumes.
INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
VALUES (
  116856685,
  116856685,
  'vrn21-arcanist',
  'K V Varun Krishnan',
  'hello@vrn21.com',
  'https://avatars.githubusercontent.com/u/116856685?v=4',
  '295d2abc-d10b-4662-b84d-7bfa66242882',
  unixepoch() * 1000,
  unixepoch() * 1000
)
ON CONFLICT (github_id) DO UPDATE SET
  login = excluded.login,
  name = excluded.name,
  email = excluded.email,
  avatar_url = excluded.avatar_url,
  updated_at = excluded.updated_at
WHERE users.business_id = '295d2abc-d10b-4662-b84d-7bfa66242882';

INSERT INTO business_members (rowid, business_id, user_id, role, created_at, updated_at)
SELECT 116856685, '295d2abc-d10b-4662-b84d-7bfa66242882', id, 'admin', unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE github_id = 116856685
  AND business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
ON CONFLICT (user_id) DO UPDATE SET
  role = 'admin',
  updated_at = excluded.updated_at
WHERE business_members.business_id = '295d2abc-d10b-4662-b84d-7bfa66242882';

DELETE FROM pending_signups WHERE github_id = 116856685;
