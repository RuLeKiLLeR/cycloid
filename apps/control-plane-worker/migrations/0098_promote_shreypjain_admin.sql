-- Ensure shreypjain is an admin of his own isolated business.
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-shreypjain', 'shreypjain', 0, unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
SELECT 'biz-shreypjain', id, 'admin', unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE github_id = 47904393
  AND business_id = 'biz-shreypjain'
ON CONFLICT (user_id) DO UPDATE SET
  role = 'admin',
  updated_at = excluded.updated_at
WHERE business_members.business_id = 'biz-shreypjain';
