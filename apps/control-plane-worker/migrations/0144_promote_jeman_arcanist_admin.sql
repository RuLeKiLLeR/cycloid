-- Promote jeman-arcanist to admin of the internal Arcanist business.
UPDATE business_members
SET role = 'admin',
    updated_at = unixepoch() * 1000
WHERE business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
  AND user_id = (
    SELECT id
    FROM users
    WHERE github_id = 71931994
      AND business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
  );
