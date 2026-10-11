# QA environment

A deployed, production-like control-plane stack for testing branches on stable HTTPS callbacks without touching production or depending on a developer's local ngrok tunnel.

For integration-by-integration QA parity status and known gaps, see [docs/qa-prod-parity.md](qa-prod-parity.md). For the parity stance (what counts as parity, and the rule that QA must not read prod OAuth values), see [docs/qa-environment-parity.md](qa-environment-parity.md).

## How QA differs from local and production

| Axis               | Local dev                             | QA                                                   | Production                                           |
| ------------------ | ------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Control plane      | `wrangler dev` + ngrok                | Cloudflare Worker `cycloid-control-plane-qa`         | Cloudflare Worker `cycloid-control-plane-production` |
| Callback stability | Tunnel, drops on laptop sleep         | Stable HTTPS                                         | Stable HTTPS                                         |
| API URL            | `localhost:3000` (worktree-offset)    | `https://qa.trycycloid.com`                          | `https://api.trycycloid.com`                         |
| Frontend URL       | `localhost:5173` (worktree-offset)    | `https://qa.app.trycycloid.com`                      | `https://app.trycycloid.com`                         |
| D1 / KV / queues   | Local wrangler simulator              | Dedicated QA bindings                                | Production bindings                                  |
| Secrets path       | `apps/control-plane-worker/.dev.vars` | SSM `/cycloid/qa/*`                                  | SSM `/cycloid/*`                                     |
| GitHub App         | Prod app (dev worktree)               | QA-only app                                          | Prod app                                             |
| Sandbox runtime    | Local E2B template / local dev        | E2B template via `deploy-e2b-sandbox-qa.yml`         | E2B template via `deploy-e2b-sandbox.yml`            |
| Lifecycle FSM      | Unconditionally live                  | Unconditionally live                                 | Unconditionally live                                 |
| Who runs it        | Any developer                         | Anyone via `workflow_dispatch`; `main` via prod gate | Merge to `main`                                      |

## Testing a feature branch in QA

`your-feature` is your branch name.

1. Push your branch:

```bash
git push -u origin your-feature
```

2. Deploy the worker. Actions -> **Deploy Control Plane Worker (QA)** -> Run workflow. Leave "Use workflow from" at `main` and put `your-feature` in the `ref` input field. CLI equivalent:

```bash
gh workflow run deploy-control-plane-qa.yml -R trycycloid/cycloid \
  --ref main -f ref=your-feature
```

The two refs differ: `--ref main` controls which workflow YAML loads and which OIDC `sub` claim AWS sees. The `ref` input is what `actions/checkout` deploys.

3. Deploy the frontend if your change touches `apps/ui/`, `shared/`, or bundled env:

```bash
gh workflow run deploy-frontend-qa.yml -R trycycloid/cycloid \
  --ref main -f ref=your-feature
```

4. Deploy the E2B sandbox if your change touches `apps/sandbox-bridge`, `apps/sandbox-e2b`, bundled sandbox apps, or `shared/**` code used in the sandbox:

```bash
gh workflow run deploy-e2b-sandbox-qa.yml -R trycycloid/cycloid \
  --ref main -f ref=your-feature
```

5. Test in the browser at `https://qa.app.trycycloid.com` in a fresh or incognito window. Sign in with GitHub; your account must be approved for QA just like production access.

6. Watch telemetry while testing:

- Datadog logs: `env:qa script:cycloid-control-plane-qa` on `https://us5.datadoghq.com`
- Sentry: `environment:qa`
- Cloudflare dashboard: Workers & Pages -> `cycloid-control-plane-qa` -> Logs

## Slack callback model

Slack QA parity is documented in [docs/qa-prod-parity.md](qa-prod-parity.md). The current status is `parity` with live-verified Slack OAuth config, workspace install, linked QA user, and runtime tool evidence.

## Integration fixture status

Current QA has deployable code paths for registry integrations. GitHub, Slack, and Linear have documented live QA fixtures; other integration proof is local test coverage unless a row below says otherwise.

| Integration        | QA fixture status                                                                                        | Verification path                                                                                           | Next action                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| GitHub             | QA GitHub App installed on repos under active verification.                                              | Browser login, repo access, PR creation, webhook dispatch tests.                                            | Keep the QA app installed on repos under active verification.                              |
| Linear             | QA Linear OAuth config, user connection, and runtime tool evidence are in place.                         | QA preflight, Linear browser connection, and Linear runtime tool smoke.                                     | Keep QA Linear evidence current through preflight and Linear runtime tool smoke.           |
| Jira               | No QA Jira Cloud site fixture is documented.                                                             | Local spawn-runtime token, site, webhook-label, and missing-site tests only.                                | Add a disposable Jira Cloud site or documented mocked fixture.                             |
| Notion             | No QA Notion workspace fixture is documented.                                                            | Local spawn-runtime token injection tests only.                                                             | Add a disposable Notion workspace or documented mocked fixture.                            |
| PagerDuty          | No QA PagerDuty service fixture is documented.                                                           | Local webhook-handler tests only.                                                                           | Add a disposable PagerDuty service or documented mocked fixture.                           |
| Sentry             | QA frontend source maps and worker errors use `environment:qa`; no customer Sentry tool fixture exists.  | QA deploy telemetry plus local business-managed runtime credential tests.                                   | Add a QA Sentry organization/project fixture for the runtime tool path.                    |
| Datadog            | QA worker logs go to Cycloid Datadog US5; `qa:seed` can seed a customer-tool fixture once QA keys exist. | `/api/internal/qa/integration-health` plus local business-managed runtime credential tests.                 | Add a QA Datadog org/API-key fixture for `search_datadog_logs` and `get_datadog_trace`.    |
| Cloudflare D1 tool | QA platform D1/KV/queues exist; `qa:seed` can seed a customer D1 tool fixture once QA D1 values exist.   | `/api/internal/qa/integration-health` plus local business-managed runtime credential tests.                 | Add a disposable D1 database fixture for the agent `query_d1` path.                        |
| Braintrust         | QA has `BRAINTRUST_API_KEY` for Cycloid telemetry; `qa:seed` can seed a customer-tool fixture.           | `/api/internal/qa/integration-health` plus local business-managed runtime credential tests.                 | Add a QA Braintrust project fixture for list/query/permalink/schema tool checks.           |
| Terraform Cloud    | No QA Terraform Cloud organization/workspace fixture is documented.                                      | Local business-managed runtime credential tests and `npm run smoke:e2b:terraform` for sandbox use.          | Add a disposable Terraform Cloud workspace fixture or documented mocked plan verification. |
| OpenAI             | `npm run qa:seed` provisions a validated QA business OpenAI credential from `ARCANIST_OPENAI_API_KEY`.   | `tests/test_cloudflare/qa-seed.test.ts`, local provider credential tests, and `npm run smoke:qa:dummy-app`. | Keep QA keys QA-scoped with spend caps.                                                    |
| Anthropic          | No Claude Code QA provider credential fixture is documented.                                             | Local provider credential and spawn-runtime tests only.                                                     | Add a QA Anthropic credential path and Claude Code smoke.                                  |
| Baseten            | No QA Baseten provider credential fixture is documented.                                                 | Local provider credential and spawn-runtime tests only.                                                     | Add a QA Baseten credential path for `kimi-k2.7-code`.                                     |
| Codex subscription | No QA Codex subscription auth fixture is documented.                                                     | Local spawn-runtime auth-json tests only.                                                                   | Add a QA Codex subscription verification path with non-customer auth material.             |
| E2B                | QA E2B templates are built by `deploy-e2b-sandbox-qa.yml`.                                               | `npm run verify:e2b-session -- --base-url https://qa.app.trycycloid.com ...`.                               | Keep worker and E2B template keys pointed at the same E2B team.                            |

## QA seed and smoke status

`npm run qa:seed` posts to `/api/internal/qa/seed` with `ARCANIST_ADMIN_TOKEN`. The worker refuses to run it unless `WORKER_ENV=qa`, then idempotently seeds:

- the fixed Cycloid QA business and admin owner from `QA_OWNER_*`
- the QA GitHub installation from `QA_INSTALLATION_ID`
- a validated business-scoped OpenAI credential from `ARCANIST_OPENAI_API_KEY`
- dummy-app login env from `ARCANIST_LOGIN_USERNAME`, `ARCANIST_LOGIN_PASSWORD`, `ARCANIST_LOGIN_PAGE`, and `ARCANIST_AUTHENTICATED_PAGE`
- optional Cloudflare D1, Datadog, and Braintrust business-managed fixture credentials when their QA env sets are complete

Run it after QA worker deploys or after rotating seed secrets:

```bash
ARCANIST_ADMIN_TOKEN=<qa admin token> npm run qa:seed
```

The optional first fixture hooks use these QA-only SSM-backed values:

- Cloudflare D1: `QA_CLOUDFLARE_D1_API_TOKEN`, `QA_CLOUDFLARE_D1_ACCOUNT_ID`, `QA_CLOUDFLARE_D1_DATABASE_ID`
- Datadog: `QA_DATADOG_API_KEY`, `QA_DATADOG_APP_KEY`, `QA_DATADOG_SITE`
- Braintrust: `QA_BRAINTRUST_API_KEY`, optional `QA_BRAINTRUST_API_URL`

For existing QA environments, `qa:seed` can reuse already-synced platform secrets where the value is equivalent:

- `QA_DATADOG_API_KEY` falls back to `DD_API_KEY`
- `QA_DATADOG_APP_KEY` falls back to `DD_APP_KEY`
- `QA_DATADOG_SITE` defaults to `us5.datadoghq.com`
- `QA_BRAINTRUST_API_KEY` falls back to `BRAINTRUST_API_KEY`
- `QA_BRAINTRUST_API_URL` defaults to `https://api.braintrust.dev`

Cloudflare D1 still requires the QA-specific `QA_CLOUDFLARE_D1_*` values because there is no equivalent platform secret to copy.

Check safe non-secret fixture state with:

```bash
ARCANIST_ADMIN_TOKEN=<qa admin token> npm run qa:integration-health
```

Statuses are `configured`, `missing`, or `invalid_config`. The command calls `/api/internal/qa/integration-health`; that endpoint does not perform live third-party API probes and does not return secret values.

Require the first business-managed fixture set before treating those integrations as operationally ready:

```bash
ARCANIST_ADMIN_TOKEN=<qa admin token> npm run qa:integration-health -- --require=cloudflare,datadog,braintrust
```

If you need the raw safe response for a PR or handoff, add `--json`.

After creating real QA-owned external resources, populate the Terraform-managed `/cycloid/qa/*` placeholders through the AWS console, deploy the QA worker so SSM syncs them into Worker secrets, run `npm run qa:seed`, then run the required health command above. Keep parity rows `partial` until this command is green and a runtime smoke has exercised the matching agent tool.

`npm run smoke:qa:dummy-app` wraps `verify:e2b-session` against `https://qa.app.trycycloid.com` and `trycycloid/dummy-docker-app`. A passing run must print the session ID and PR URL; without both, do not cite the smoke as QA proof.

Production smoke scripts (`smoke:prod:pr-creation`, `smoke:prod:claude-verify`) are not QA smoke runners; use `smoke:qa:dummy-app` for QA verification. See [docs/prod-pr-creation-smoke.md](prod-pr-creation-smoke.md) for production smoke details.

## Observability proof paths

QA observability proof is split by sink:

- Datadog platform telemetry: deploy/browser/session actions should emit logs with `env:qa script:cycloid-control-plane-qa` in US5.
- Sentry frontend telemetry: QA frontend deploy uploads source maps under the deployed SHA and QA browser errors filter by `environment:qa`.
- Runtime integration credentials: Datadog, Sentry, Braintrust, Terraform, and Cloudflare D1 runtime env injection is covered by `tests/test_cloudflare/integration-runtime.test.ts`.
- Sandbox telemetry links: Datadog log URLs are built by `apps/sandbox-bridge/src/utils/datadog-logs-url.ts` and covered by its tests.

## Common gotchas

- **`Configure AWS credentials` fails with `sts:AssumeRoleWithWebIdentity` denied**: you dispatched with `--ref your-feature` or picked your branch in "Use workflow from". Re-dispatch with `--ref main -f ref=your-feature`.
- **Two people testing different branches**: QA is one shared environment; latest successful deploy wins. Coordinate before overwriting someone else's branch.
- **Worker changes did not take effect**: re-run **Deploy Control Plane Worker (QA)**. `wrangler.toml` env vars are applied only on deploy.
- **Session spawn fails with `404: template 'cycloid-sandbox-qa-mem4096-cpu2' not found`**: run **Deploy E2B Sandbox (QA)**. The worker points at the stable stem `cycloid-sandbox-qa`, and the E2B workflow registers the suffixed template tiers.
- **`Sync QA secrets from SSM` fails with `Binding name '<NAME>' already in use [code: 10053]`**: the live worker has a plaintext var where SSM now syncs a secret, or vice versa. Delete the stale binding from the QA worker, then rerun the deploy.
- **Login loops**: confirm the QA GitHub App callback URL is `https://qa.app.trycycloid.com/auth/callback`; the cookie must land on `qa.app.trycycloid.com`.
- **"Not authorized" / "Access unavailable" after OAuth**: your GitHub login is not approved into a business. Unknown logins land in `pending_signups`; approval is a Cycloid-admin action.
- **Stale repo list after adding repos to the QA GitHub App**: the `installation_repositories` webhook should invalidate repo caches automatically. If the webhook was missed or delayed, use `/api/repos?refresh=1` or delete the `repos:<userId>` KV entry in QA.
- **Stale UI after frontend deploy**: hard-refresh once. HTML shells are `no-cache`; hashed assets are immutable.
- **Data in QA disappeared**: QA data is expendable. Someone likely re-seeded data, deployed a destructive migration, or manually cleaned rows.

## Initial setup

### 1. Provision Cloudflare resources

```bash
cd apps/control-plane-worker
npx wrangler d1 create cycloid-control-plane-qa
npx wrangler kv namespace create REPOS_CACHE --env qa
npx wrangler kv namespace create RATE_LIMITS --env qa
npx wrangler kv namespace create DERIVED_MODELS --env qa
npx wrangler queues create cycloid-traces-qa
npx wrangler queues create cycloid-traces-dlq-qa
npx wrangler queues create cycloid-memory-analysis-qa
npx wrangler queues create cycloid-memory-refine-qa
npx wrangler queues create cycloid-memory-refine-dlq-qa
npx wrangler queues create cycloid-sandbox-layer-builds-qa
```

Copy each returned ID into the matching `REPLACE_WITH_QA_*` placeholder in `apps/control-plane-worker/wrangler.toml` under `[env.qa]`. The QA deploy workflow refuses to run while any placeholder remains.

### 2. Register the QA-only GitHub App

Register a new GitHub App `Cycloid QA` with:

- Callback URL: `https://qa.app.trycycloid.com/auth/callback`
- Webhook URL: `https://qa.trycycloid.com/webhooks/github`
- Permissions matching the prod Cycloid app
- Installation on whichever repos are actively under QA verification

Note the App ID, Client ID, Client Secret, Webhook Secret, Installation ID, and PEM private key for SSM.

### 3. Populate `/cycloid/qa/*` SSM parameters

Terraform declares the parameter names via `infra/qa.tf`. After Terraform creates placeholders, populate real values through the AWS console.

Required values:

- `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `SANDBOX_CALLBACK_SECRET`
- `SANDBOX_RUNTIME_CLEANUP_SECRET`
- `E2B_API_KEY`
- `ARCANIST_ADMIN_TOKEN`, `CI_AUTOMATION_TOKEN`
- `ARCANIST_OPENAI_API_KEY`
- `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`; callback URL is the Worker var `https://qa.app.trycycloid.com/auth/notion/callback`
- `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`; callback URL is the Worker var `https://qa.app.trycycloid.com/auth/jira/callback`
- `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET`; callback URL is the Worker var `https://qa.app.trycycloid.com/auth/linear/callback`
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_LINK_SIGNING_KEY`; callback URLs are Worker vars `https://qa.app.trycycloid.com/auth/slack/callback` and `https://qa.app.trycycloid.com/auth/slack/install/callback`
- `SENTRY_DSN`, `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE`, `BRAINTRUST_API_KEY`, `S3_*`

### 4. Bind the custom domain

`qa.trycycloid.com` is bound to the QA worker via a `cloudflare_workers_custom_domain` resource after the first QA worker deploy exists. Cloudflare returns a misleading auth error if the domain resource targets a worker that has not been deployed yet.

Sequence:

1. Run `deploy-control-plane-qa.yml` once.
2. Add or apply the custom-domain Terraform resource after the worker exists.

## Routine deploy

QA has independent deploys for the worker, frontend, and sandbox template. Feature-branch QA deploys are manual: run the relevant workflows with the same `ref`.

Merges to `main` use `.github/workflows/qa-gated-prod-deploy.yml`: affected surfaces run reusable QA deploy jobs first, and production reusable deploy jobs run only after the QA jobs pass.

### Backend

**Deploy Control Plane Worker (QA)**:

- refuses to run while `wrangler.toml` contains QA placeholders
- syncs `/cycloid/qa/` SSM secrets to QA worker secrets
- runs D1 migrations against the QA DB
- deploys with `--env qa`

Worker-only changes do not require frontend or E2B deploys.

### Sandbox

**Deploy E2B Sandbox (QA)** builds the `cycloid-sandbox-qa` resource-profile templates and deploys the QA worker from the same ref. Run it for sandbox, bridge, bundled app, or sandbox-used shared changes.

The control-plane and E2B QA workflows share the `qa-deploy` concurrency group so their D1 migrations serialize.

### Frontend

**Deploy Frontend (QA)** builds `apps/ui` with QA Sentry/Datadog envs, uploads source maps, strips them from the Pages artifact, and deploys to `https://qa.app.trycycloid.com`.

## Keeping QA on `main`

QA has no scheduled auto-deploy. Every merge to `main` that touches a deploy surface runs `qa-gated-prod-deploy.yml`, which deploys QA before prod, so QA tracks `main` as changes ship. Commits behind `origin/main` (coalesced behind a newer merge) skip deploys entirely. After deploying a feature branch to QA (see above), redeploy the affected surfaces on `main` when you are done so QA does not keep serving branch code.

## Rotating the QA E2B key

The E2B template and worker `E2B_API_KEY` secret must point at the same E2B team.

1. Set `/cycloid/qa/E2B_API_KEY` in the AWS console.
2. Run **Deploy E2B Sandbox (QA)**. It reads the new SSM key, rebuilds the template in the matching team, updates the worker secret, and deploys the worker.

## Rollback

- **Bad QA deploy**: redeploy a known-good SHA via `workflow_dispatch`.
- **Bad QA migration**: write a forward migration. D1 migrations are append-only, same as prod.
- **Prod impact from QA**: should be impossible by construction. If prod noise lines up with QA, treat it as a bug.

## Known follow-ups

QA parity gaps and next actions are tracked in [docs/qa-prod-parity.md](qa-prod-parity.md).
