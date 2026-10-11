# Rollback runbook

Surfaces are independent; roll back only the broken one. After any rollback, confirm the relevant deploy workflow and production health checks are green.

## UI (Cloudflare Pages)

Pages keeps full deployment history; rollback is an instant pointer move.

1. Cloudflare dashboard → Workers & Pages → the Pages project → Deployments.
2. Find the last good deployment (each maps to a `main` commit) and click "Rollback to this deployment".

Rules:

- Roll back the WHOLE deployment, never one file. `index.html`, `authenticated.html`, and their hashed assets must come from a single commit ([deployments.md](deployments.md#ui)).
- UI and control plane deploy separately. If the bad change spans both (shared contract change), roll back both surfaces to the same commit.

## Control plane (Cloudflare Worker)

Wrangler versions every deploy:

```bash
cd apps/control-plane-worker
npx wrangler deployments list            # find the last good version id
npx wrangler rollback [<version-id>]     # instant pointer move, no rebuild
```

No `target_sha` rollback workflow exists yet.
Wrangler rollback takes a Worker version ID, while `wrangler deployments list --json` and `wrangler versions list --json` are not SHA-indexed.
`SENTRY_RELEASE` contains the deployed SHA only in `wrangler versions view <version-id> --json`, and the version list is limited to recent versions, so resolving a SHA requires an incomplete scan.
Keep this manual until deploys record durable SHA metadata or Wrangler exposes a searchable SHA mapping.

Caveats:

- Worker SECRETS are not versioned. If the bad deploy also changed secrets (SSM sync step), `git revert` the bad Worker commit on `main` AND revert the `infra/ssm.tf` change; let TFC apply the SSM revert first, then let `deploy-control-plane.yml` redeploy from the reverted `main` (do not use `wrangler rollback` here: the normal deploy re-syncs secrets, and `main` must not still carry the bad code when it runs).
- Durable Object storage and D1 are NOT rolled back — see D1 below.
- If dashboard/CLI rollback is unavailable: `git revert` the bad commit and let `deploy-control-plane.yml` redeploy from `main`. Also the only safe path when the bad change included a migration.
- If the bad commit ADDED a migration already applied in production, do NOT revert the migration file out of the checkout: D1 still records it as applied, so the post-deploy schema check (applied names vs the checkout's `migrations/*.sql`) would fail the rollback deploy. Keep the migration file (revert only the code) or ship a corrective forward migration.

## E2B sandbox template

Template builds are forward-only registrations of `arc-default-template` (default tier `arc-default-template-mem4096-cpu2`); new sessions pick up the last registration. To roll back:

1. `git revert` the offending sandbox/bridge/shared commit on `main`.
2. Let `deploy-e2b-sandbox.yml` rebuild and re-register the template (also re-runs the compat smoke against the rebuilt template).

No registry-side pointer to flip; rebuilding from the reverted commit IS the rollback. In-flight sessions keep their already-booted sandboxes (acceptable: pre-revenue, no compatibility window — see CLAUDE.md invariants).

## D1 (database)

Migrations are append-only and forward-only ([database.md](database.md)). No automatic down-migration.

- Prefer FORWARD fixes: ship a new migration that corrects the bad one.
- A bad migration usually fails the deploy before the Worker ships (the migrate step runs `wrangler d1 migrations apply` first; the post-deploy schema check compares applied `d1_migrations` names against the checkout); the Worker keeps running the previous version.
- Point-in-time restore (last resort, loses writes since the restore point): first export a current snapshot of the REMOTE database (`--remote` is required; without it wrangler exports the local dev SQLite file and the "backup" is worthless): `npx wrangler d1 export cycloid-control-plane-production --remote --output=backup.sql`. Then restore via D1 Time Travel: `npx wrangler d1 time-travel restore cycloid-control-plane-production --timestamp=<unix>`.
- Time Travel restores BOTH data and schema. If the restore point predates a migration the deployed Worker depends on, roll the Worker back to the matching version in the same operation (see control-plane section), or it will 500 against the restored schema.
- Sessions/DO state reference D1 rows; restoring to an earlier point orphans newer sessions. Acceptable pre-revenue; archive those sessions manually.

## CLI (npm)

`npm unpublish` is time-limited and disruptive; publish a patch from the reverted commit instead:

1. `git revert` the bad commit on `main`.
2. Bump `package.json` `version` to the next patch and commit — npm rejects re-publishing any existing version, so `publish-cli.yml` without the bump fails and leaves the bad version as `latest`.
3. Let `publish-cli.yml` publish the new version.

## Infra (Terraform Cloud)

Revert the `infra/` commit on `main`; TFC auto-applies. Never fix forward in the Datadog/AWS consoles — out-of-band edits drift and revert on the next apply ([infrastructure.md](infrastructure.md)).
