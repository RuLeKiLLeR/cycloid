# Cycloid Business Membership Runbook

Use when adding an engineer to the internal Cycloid business or changing their role.

## Required inputs

- GitHub numeric user id, login, display name, and avatar URL.
- Target role: `member` for normal access, `admin` for business settings and integration management.
- Internal Cycloid business id: `295d2abc-d10b-4662-b84d-7bfa66242882`.

Get the GitHub user id:

```bash
gh api users/<login> --jq '{id, login, name, avatar_url}'
```

## Tables Modified

- `users`: authenticated GitHub identity + owning business. `github_id` is the stable external identity; `id` is the internal foreign key used by sessions, memberships, credentials, and settings.
- `business_members`: grants business access and stores the role (`member` for access, `admin` to configure business-level integrations such as Braintrust).
- `pending_signups`: remove any pending signup for the GitHub id after provisioning.

Do not update `users.business_id` for an existing user unless the migration explicitly moves them between businesses and temporarily handles the immutability triggers. For a new Cycloid user, insert directly with the Cycloid business id.

## Create the Migration

1. Add the next numbered SQL file under `apps/control-plane-worker/migrations/`.
2. Insert or update the `users` row by `github_id`.
3. Insert or update the `business_members` row by `user_id`.
4. Delete the matching `pending_signups` row.

Use a stable positive internal `users.id`; session owners must be positive integers. For one-off internal Cycloid users, using the GitHub id as the internal id keeps the migration deterministic. If the seed migration inserts into `business_members`, set the hidden `rowid` to the same stable positive value so local SQLite shims preserve `last_insert_rowid()` behavior in later tests.

Template for a new member:

```sql
INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
VALUES (
  <github_id>,
  <github_id>,
  '<login>',
  '<name>',
  NULL,
  '<avatar_url>',
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
SELECT <github_id>, '295d2abc-d10b-4662-b84d-7bfa66242882', id, 'member', unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE github_id = <github_id>
  AND business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
ON CONFLICT (user_id) DO UPDATE SET
  role = 'member',
  updated_at = excluded.updated_at
WHERE business_members.business_id = '295d2abc-d10b-4662-b84d-7bfa66242882';

DELETE FROM pending_signups WHERE github_id = <github_id>;
```

Template for promoting an existing Cycloid member:

```sql
UPDATE business_members
SET role = 'admin',
    updated_at = unixepoch() * 1000
WHERE business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
  AND user_id = (
    SELECT id
    FROM users
    WHERE github_id = <github_id>
      AND business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
  );
```

**When to use which template:** Prefer the "new member" template for fresh environments (QA, new local databases) where no prior user row exists. The "promote existing" template silently no-ops if the user row is missing. The "new member" template's `ON CONFLICT` handles both insert and promotion, making it safe for environments with or without prior user state.

## Apply and Verify

Local verification:

```bash
npm run db:migrate:local
npx vitest run tests/test_cloudflare/auth-business-immutability.test.ts tests/test_cloudflare/impersonation-db.test.ts tests/test_cloudflare/test-credentials-db.test.ts
```

Verify the row locally:

```bash
wrangler d1 execute cycloid-control-plane-production --local --command "
SELECT users.id, users.github_id, users.login, users.business_id, business_members.role
FROM users
JOIN business_members ON business_members.user_id = users.id
WHERE users.github_id = <github_id>
  AND users.business_id = '295d2abc-d10b-4662-b84d-7bfa66242882';
"
```

Expected: one row with the GitHub id, Cycloid business id, and requested role.

Production verification after deploy: run the same query without `--local` against production D1 only if you have production access and the deploy has completed.

## Common Failures

- Migration isolation fails: the PR mixes SQL migration files with app/test code. Split them, or keep the migration-only PR strictly to `apps/control-plane-worker/migrations/`, `drizzle/`, and docs.
- Backend tests fail with unexpected user ids: the seed migration inserted a `users.id` without a matching `business_members.rowid`. Use a stable positive id and matching membership rowid for seeded internal users.
- Backend tests fail around `last_insert_rowid()`: the migration inserted into a rowid table such as `business_members` and changed SQLite's hidden rowid state. Use an explicit hidden `rowid` that does not perturb later test rows.
- No `business_members` row appears: the `users` row did not match the expected `github_id` and Cycloid `business_id`, so the `INSERT ... SELECT` selected no rows. Query `users` first and confirm the business id.
- Role is not updated: `business_members` has a unique constraint on `user_id`. The conflict handler must update the existing row only when it belongs to the Cycloid business.
- Pending page still appears: confirm the `pending_signups` row for the GitHub id was deleted and that the user signs out and back in after the migration deploys.
