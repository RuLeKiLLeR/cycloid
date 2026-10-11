-- Promote JagritC from the isolated tester business into the internal Arcanist business.
-- This is an explicit exception to the normal business immutability invariant.
DROP TRIGGER IF EXISTS trg_users_business_id_immutable;
DROP TRIGGER IF EXISTS trg_business_members_business_id_immutable;
DROP TRIGGER IF EXISTS trg_business_members_business_id_matches_user;

UPDATE users
SET business_id = 'biz-arcanist',
    updated_at = unixepoch() * 1000
WHERE github_id = '32455319'
  AND business_id = 'biz-jagritc';

UPDATE business_members
SET business_id = 'biz-arcanist',
    updated_at = unixepoch() * 1000
WHERE user_id = (
    SELECT id
    FROM users
    WHERE github_id = '32455319'
  )
  AND business_id = 'biz-jagritc';

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
