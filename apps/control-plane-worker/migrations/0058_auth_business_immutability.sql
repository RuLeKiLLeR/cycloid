-- Backfill any drift so the invariant holds before triggers enforce it.
UPDATE business_members
SET business_id = (
      SELECT users.business_id
      FROM users
      WHERE users.id = business_members.user_id
    ),
    updated_at = unixepoch() * 1000
WHERE EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = business_members.user_id
    AND users.business_id != business_members.business_id
);

INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
SELECT users.business_id, users.id, 'member', unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE NOT EXISTS (
  SELECT 1
  FROM business_members
  WHERE business_members.user_id = users.id
);

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
