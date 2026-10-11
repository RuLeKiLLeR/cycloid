# User access

Every user belongs to a business. Access is provisioned by a Cycloid-team admin approving a self-serve signup. An unknown GitHub login lands in `pending_signups` and sees `/pending` until approved; no per-user hardcoded map, no customer-admin approval.

## Adding a new user

Users add themselves; the Cycloid team approves:

1. User signs in with GitHub at the app URL. Unknown GitHub user ID: `auth/routes.ts` writes a `pending_signups` row and shows `/pending`.
2. A Cycloid-team admin (an `admin` member of the Cycloid business) approves via the admin pending-signups API/UI (`routes/admin-approvals.ts`).
3. Approval (`services/admin-approvals.ts`) assigns the user to a **new** business (creates it) or an **existing** one, inserting `users` + `business_members` rows atomically.

A GitHub identity is pinned to its business on first approval: a later login claiming a different business is rejected with 403 (`BusinessMismatchError`).

## Repo access

Two checks:

1. **GitHub App installation** -- the Cycloid GitHub App must be installed on the repo's org/owner, verified via the `github_installations` table.
2. **User OAuth token** -- the user's GitHub OAuth token calls `GET /repos/{owner}/{repo}`. If the user can see the repo on GitHub, they can use it in Cycloid. No hardcoded mapping.

API token users (`canAccessAllSessions`) bypass the user token check.

## Businesses

| ID   | Name     | Purpose                                               |
| ---- | -------- | ----------------------------------------------------- |
| UUID | Cycloid  | Internal team                                         |
| UUID | Armory   | Customer                                              |
| UUID | Per-user | Individual external testers (one business per person) |

`ARCANIST_BUSINESS_ID` is a constant in the same file. Business ids are opaque UUIDs; use `businesses.name` for display text.

## Warm starts

Per-repo prebaked snapshots are active (E2B via E2B_REPO_SNAPSHOT_MAP_JSON, Freestyle via FREESTYLE_REPO_SNAPSHOT_MAP_JSON). Session startup tries, in order: reuse a paused runtime, then a configured prebaked repo snapshot, then fresh clone.

Warm-start configuration is not part of customer access. Do not add repo allowlists for onboarding.

## App runtime access

Browser evidence is enabled by checked-in `.cycloid.json`, not user access maps, repo allowlists, or pre-built images. Help the customer choose `entry.files`, `entry.service`, `url.hostPort`, and `ready.path`, then run a runtime smoke test.

## Onboarding checklist

1. Customer's admin installs the Cycloid GitHub App on their org
2. Users sign in with GitHub -> unknown logins land in `pending_signups`
3. A Cycloid-team admin approves the first user as a **new** business, the rest into that same business (`services/admin-approvals.ts`)
4. Promote their admin user by setting `business_members.role = 'admin'` directly in D1 (no API endpoint yet)
5. Add `.cycloid.json` for repos needing runtime preview support
6. Verify the repo starts in an E2B-backed Cycloid session

No migration or code change needed to add a business or user; business creation happens through the approval flow.

## How it works

During GitHub OAuth callback (`auth/routes.ts`), the immutable GitHub user ID is looked up via `getUserByGithubId`. Known users resume with their stored `business_id`. Unknown users get a `pending_signups` row and `/pending`; admin approval later creates the `users` + `business_members` rows.

Session creation and repo changes verify the user's GitHub token can access the target repo via the GitHub API. API token users bypass this check.
