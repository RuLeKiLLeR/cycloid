-- Add jeman-arcanist to the internal Arcanist business as a member.
-- Use the GitHub id as the stable positive internal user id; session owners must be positive integers.
INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
VALUES (
  71931994,
  71931994,
  'jeman-arcanist',
  'Jeman',
  NULL,
  'https://avatars.githubusercontent.com/u/71931994?v=4',
  '295d2abc-d10b-4662-b84d-7bfa66242882',
  unixepoch() * 1000,
  unixepoch() * 1000
)
ON CONFLICT (github_id) DO UPDATE SET
  login = excluded.login,
  name = excluded.name,
  avatar_url = excluded.avatar_url,
  updated_at = excluded.updated_at
WHERE users.business_id = '295d2abc-d10b-4662-b84d-7bfa66242882';

INSERT INTO business_members (rowid, business_id, user_id, role, created_at, updated_at)
SELECT 71931994, '295d2abc-d10b-4662-b84d-7bfa66242882', id, 'member', unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE github_id = 71931994
  AND business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
ON CONFLICT (user_id) DO UPDATE SET
  role = 'member',
  updated_at = excluded.updated_at
WHERE business_members.business_id = '295d2abc-d10b-4662-b84d-7bfa66242882';

DELETE FROM pending_signups WHERE github_id = 71931994;
