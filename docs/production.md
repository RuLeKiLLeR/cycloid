# Production

Stack runs on Cloudflare (Workers, Pages, D1, KV, Durable Objects); AWS supplies SSM for secrets and IAM for CI/CD.

## Quick reference

| Resource        | Value                                                         |
| --------------- | ------------------------------------------------------------- |
| Domain          | `https://app.trycycloid.com`                                  |
| API domain      | `https://api.trycycloid.com` (control-plane Worker)           |
| Status page     | `https://status.trycycloid.com` (standalone Worker + KV)      |
| UI hosting      | Cloudflare Pages (`cycloid-ui` project)                       |
| Control plane   | Cloudflare Workers (`cycloid-control-plane-production`)       |
| Session data    | Durable Objects + D1 (authoritative session state and replay) |
| Terraform state | Terraform Cloud (`cycloid` / `cycloid-infra`)                 |

Cloudflare control-plane operations: [docs/infrastructure.md](infrastructure.md).

## Common operations

```bash
# Health check
curl -sf https://app.trycycloid.com

# Check Pages deployment status
npx wrangler pages deployment list --project-name=cycloid-ui

# Check Worker deployment
curl https://api.trycycloid.com/api/health

# Check status page
curl -sf https://status.trycycloid.com/
curl -sf https://status.trycycloid.com/api/status
```

The control plane keeps its fetch path warm by self-fetching `/api/health/warm` from the worker's 5-minute cron, preferring `CONTROL_PLANE_URL`, falling back to `FRONTEND_URL`. That endpoint requires automation bearer auth, touches D1/KV, and must stay lightweight.

## Deploy

Merge to `main` triggers `.github/workflows/qa-gated-prod-deploy.yml`.
That workflow detects affected UI, control-plane, and sandbox surfaces, calls reusable deploy cores for QA first, and only then calls the matching production deploy cores.
Commits behind `origin/main` (coalesced behind a newer merge) skip deploys entirely.

For UI deploys, the reusable UI core:

1. Vite builds UI assets
2. Sentry debug IDs are injected into built UI assets
3. Hashed non-map assets are uploaded to the R2 fallback bucket
4. UI source maps are uploaded to Sentry, then removed from `dist/ui/assets`
5. `wrangler pages deploy dist/ui/` uploads the map-free artifact to Cloudflare Pages
6. The deploy job polls `https://app.trycycloid.com` (up to 180 s) to confirm generated source map URLs return `403` or `404` with `cache-control: no-store`, and a representative JavaScript asset still returns `200`; polling accounts for Cloudflare edge propagation delay after a fresh Pages deploy
7. Sentry release jobs run for the control plane and sandbox bridge

UI source maps exist for Sentry only; they must not remain in the Pages artifact or be served by the Pages worker/R2 fallback.

There is no S3/CloudFront in the deploy pipeline.

## Status page

The status page is the standalone `cycloid-status` Worker. It reads only the `STATUS_FLAG`
KV namespace and stays isolated from the control plane so it can report control-plane or
session outages.

On-call runbook: [docs/status-page-runbook.md](status-page-runbook.md).

Allowed operators: Josiah Parappally and Shivam Pandey. Use a least-privilege Cloudflare API
token scoped to the status KV namespace, stored with operator credentials, and set
`CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID` before flipping.

```bash
# Mark degraded/down with a generic public message.
bash apps/status-worker/scripts/status-down.sh "Cycloid is currently degraded."

# Mark operational.
bash apps/status-worker/scripts/status-up.sh
```

Both scripts print the authenticated Cloudflare context, write the JSON flag through
Wrangler remote KV, and read the effective `current` value back. KV propagation can take about
60 seconds globally.

## Terraform Cloud (TFC)

Managed via [Terraform Cloud](https://app.terraform.io/app/cycloid/workspaces/cycloid-infra). PRs touching `infra/` trigger a plan; merges to `main` auto-apply.

- Organization: `cycloid`
- Workspace: `cycloid-infra`
- Working directory: `infra/`
- Auth: OIDC via `cycloid-tfc-role`

## Troubleshooting

- UI changes not visible:
  - confirm `deploy.yml` workflow succeeded in GitHub Actions
  - check Pages deployment: `npx wrangler pages deployment list --project-name=cycloid-ui`
  - Cloudflare Pages has no CDN cache to invalidate, but a fresh deploy can take up to ~90 s to propagate header rules through the edge; the verify gate polls until source-map and JS-asset assertions pass
- Deploy failed:
  - check GitHub Actions logs for the `deploy.yml` workflow
  - verify `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets are set in the repo
