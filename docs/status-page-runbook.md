# Status Page Runbook

Use for customer-visible outages or `https://status.trycycloid.com/` failures.

## Facts

- Host: `https://status.trycycloid.com/`
- Worker: `cycloid-status`
- KV: `STATUS_FLAG/current`
- Operators: Josiah Parappally, Shivam Pandey
- Token: least-privilege Cloudflare token for the status KV namespace only
- Message: public, generic, no vendors/customers/internal route names
- KV propagation: about 60 s

The Worker must stay independent of the app fault domain: no D1, Durable Objects,
queues, app auth, or control-plane dependencies.

## Check

```bash
curl -sfS https://status.trycycloid.com/
curl -sfS https://status.trycycloid.com/api/status
curl -I https://status.trycycloid.com/
curl -I https://status.trycycloid.com/api/status
```

Healthy: JSON `state` is `up`. `updatedAt` is `null` only before first KV write;
otherwise it is a millisecond Unix timestamp.

## Flip Down

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
bash apps/status-worker/scripts/status-down.sh "Cycloid is currently degraded."

sleep 60
curl -sfS https://status.trycycloid.com/api/status
curl -sfS https://status.trycycloid.com/ | grep -E "Cycloid is down|degraded"
```

## Flip Up

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
bash apps/status-worker/scripts/status-up.sh

sleep 60
curl -sfS https://status.trycycloid.com/api/status
curl -sfS https://status.trycycloid.com/ | grep -F "All systems operational"
```

## Direct KV Fallback

Use only if scripts are unavailable.

```bash
put_status() {
  tmpfile="$(mktemp)"
  STATUS_STATE="$1" STATUS_MESSAGE="${2:-}" node --input-type=module - "$tmpfile" <<'NODE'
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], `${JSON.stringify({
  state: process.env.STATUS_STATE,
  message: process.env.STATUS_MESSAGE ?? "",
  updatedAt: Date.now(),
})}\n`);
NODE

  npx wrangler kv key put current --binding=STATUS_FLAG --remote --cwd apps/status-worker --path "$tmpfile"
  npx wrangler kv key get current --binding=STATUS_FLAG --remote --cwd apps/status-worker
  rm -f "$tmpfile"
}

put_status down "Cycloid is currently degraded."
put_status up
```

Missing KV means operational; do not delete `current` mid-incident unless that is
intended.

## Provider Checks

Cloudflare first when DNS, TLS, status page, app, API, Workers, Pages, KV, D1, or
Durable Objects look unhealthy.

- Status: `https://www.cloudflarestatus.com/`
- App: `curl -sfS https://app.trycycloid.com/`
- API: `curl -sfS https://api.trycycloid.com/api/health`
- Status Worker: `npx wrangler deployments list --name cycloid-status`
- Control plane: `npx wrangler deployments list --name cycloid-control-plane-production`
- UI: `npx wrangler pages deployment list --project-name=cycloid-ui`
- Infra: Terraform Cloud `cycloid/cycloid-infra`

E2B first when the app/API load but sessions fail to start, sandboxes disconnect,
templates fail, or agents cannot run commands.

- Status: `https://status.e2b.dev/`
- Deploy workflow: `Deploy E2B Sandbox`
- Logs: Datadog sandbox monitors and sandbox bridge logs
- Live proof when needed:

```bash
ARCANIST_TOKEN=... npm run verify:e2b-session -- \
  --base-url https://app.trycycloid.com
```

AWS first when deploys fail during OIDC, SSM, secret loading, or secret sync.

- Health: `https://health.aws.amazon.com/`
- Logs: GitHub Actions AWS OIDC/SSM/secret-sync steps
- Infra: Terraform Cloud `cycloid/cycloid-infra`
- Services: IAM, Systems Manager Parameter Store

Do not repair Terraform-managed resources in provider UIs unless explicitly
approved; reconcile any emergency manual change back into Terraform.

## Decision Map

- Status host NXDOMAIN: Cloudflare DNS/custom domain
- Status host 5xx: `cycloid-status`, KV, or Cloudflare edge
- App down: Cloudflare Pages, UI deploy, or app outage
- API health down: control-plane Worker, D1/KV/DO, or control-plane deploy
- App/API up but sessions fail: E2B, sandbox bridge, template, runtime path
- Deploy fails before Cloudflare deploy: AWS OIDC/SSM, GitHub Actions secrets, IAM

Provider pages can lag. If customers are impacted, keep the public page degraded
until Cycloid's customer path is healthy.
