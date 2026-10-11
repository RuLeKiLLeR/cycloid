# Deployments

## Deploy surfaces

| Surface            | Runtime                     | Trigger / workflow                                                                                | Notes                                                                                                                                        |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| UI                 | Cloudflare Pages            | `.github/workflows/qa-gated-prod-deploy.yml` -> `.github/workflows/deploy-ui-core.yml`            | Main merges call reusable QA deploy jobs first, then production Pages if QA passes                                                           |
| Control plane      | Cloudflare Worker + D1 + DO | `.github/workflows/qa-gated-prod-deploy.yml` -> `.github/workflows/deploy-control-plane-core.yml` | Main merges call reusable QA deploy jobs first, then ensure queues, sync secrets when needed, run migrations, and deploy Worker if QA passes |
| Status page        | Cloudflare Worker + KV      | `.github/workflows/deploy-status-worker.yml`                                                      | Standalone `cycloid-status` worker. Manual status flag in `STATUS_FLAG`; no control-plane bindings                                           |
| Control plane QA   | Cloudflare Worker + D1 + DO | `.github/workflows/deploy-control-plane-qa.yml`                                                   | Manual dispatch only. Isolated D1/KV/queues. See `docs/qa-environment.md`                                                                    |
| Sandbox            | E2B                         | `.github/workflows/qa-gated-prod-deploy.yml` -> `.github/workflows/deploy-e2b-sandbox-core.yml`   | Main merges call reusable QA deploy jobs first, then builds and registers the production E2B sandbox template if QA passes                   |
| Sandbox QA         | E2B                         | `.github/workflows/deploy-e2b-sandbox-qa.yml`                                                     | Manual dispatch only. Builds QA template and deploys QA worker override                                                                      |
| Prod PR smoke test | GitHub Actions              | `.github/workflows/prod-e2b-verifier.yml`                                                         | Deploy-triggered smoke with a 30-min cooldown, plus a sparse every-3h liveness heartbeat (no smoke). Uploads the PR-creation verifier report |
| CLI                | npm                         | `.github/workflows/publish-cli.yml`                                                               | Publishes `@trycycloid/cli`                                                                                                                  |
| Infra              | Terraform Cloud             | auto-apply on merge to `main`                                                                     | Managed from `infra/`                                                                                                                        |

## UI

- Cloudflare Pages serves the UI and proxies `/api/*` and `/auth/*` to the control-plane Worker.
- The UI build emits two HTML shells from the same commit: `index.html` (public login shell, must stay minimal) and `authenticated.html` (product app shell: sessions, settings, evals, repo flows, integrations UI).
- Pages worker document routing checks `/auth/me` server-side: authenticated document requests get `authenticated.html`; signed-out, failed, or unverifiable auth checks get `index.html`.
- The deploy workflow runs `npm run inspect:ui-public-artifact` after `npm run build:ui` to verify the public artifact does not reference authenticated route definitions or feature chunks before uploading assets or deploying Pages.
- UI rollback must roll back the whole Pages deployment to a single previous commit so `index.html`, `authenticated.html`, and their hashed assets stay in sync. Never roll back one shell.

## Control plane

On `main` pushes, `.github/workflows/qa-gated-prod-deploy.yml` detects affected surfaces and calls the reusable deploy cores as native workflow jobs.
If the triggering SHA is behind `origin/main` (coalesced behind a newer commit), all deploy jobs skip.
Affected surfaces deploy to QA first.
If any requested QA job fails, `qa-gate` blocks production.
On QA success, the same DAG runs matching production jobs for the same SHA.
When production sandbox and control-plane surfaces are both affected, the grouped DAG builds and smokes the E2B templates in parallel with the control-plane Worker deploy, then reruns sandbox base-template registration after both jobs finish.
The template-before-worker invariant for renamed or newly-added production template IDs is enforced before merge by the lint workflow's resolved template-set guard.
Normal sandbox-code deploys rebuild stable, already-known template IDs in place.
The QA grouped stage intentionally keeps its existing order because the QA sandbox core deploys the QA worker before registering QA templates.

On production control-plane deploy, the workflow:

1. ensures declared Cloudflare Queues exist
2. verifies bound Vectorize indexes exist (provisioned out-of-band; missing index fails fast)
3. reconciles SSM metadata and prepares one candidate Worker version with changed secrets
4. runs D1 migrations
5. validates and deploys the candidate with one `wrangler versions deploy` traffic switch

The candidate upload is unpublished, so an upload failure leaves production untouched.
The traffic switch is the only planned `SessionDO` eviction in a rollout.
Secret-only changes use the same candidate boundary and are never reported as a no-restart skip.
SSM `Version`/`LastModifiedDate` fingerprints are persisted only after a successful traffic switch.
Secret removals are emitted as bounded name-level reconciliation results for the documented manual deletion boundary.

QA handoff verification runs with `npx tsx scripts/verify-control-plane-deploy-handoff.ts --base-url=https://qa.app.trycycloid.com --deploy-url=<QA deploy probe URL> --artifact=test-results/control-plane-deploy-handoff.json`.
The harness always writes its artifact and stops the synthetic session in `finally`, including failed deploy and timeout cases.

During the reconnect grace window, a same-runtime sandbox that presents a fresh connection generation and a different opaque Worker version id is a planned control-plane handoff.
The DO persists the accepted version, runtime sandbox id, generation, and timestamp before clearing deadlines.
The active prompt and its disconnect retry budget survive that handoff; missing or invalid version metadata follows the existing reconnect path.
The bridge treats version ids as equality-only correlation values and keeps its watchdog active for a silent or unreachable DO.

Queue provisioning and Vectorize preflight run before the traffic switch because they do not restart SessionDOs; auth/config failures must fail fast before the candidate is activated.

Managed by Wrangler, not Terraform.

- The control-plane deploy workflow must trigger for `shared/**` changes: the Worker imports shared modules (e.g. model registry), so shared code can change API validation without touching `apps/control-plane-worker/**`.

## Status page

- `cycloid-status` is a standalone Worker for `status.trycycloid.com`; it must not bind D1, Durable Objects, queues, control-plane secrets, or control-plane services.
- The status is a manually written KV flag at `STATUS_FLAG/current`: `{ "state": "up" | "down", "message": string, "updatedAt": <unix-ms> }`. Missing key means operational.
- KV propagation and read-cache behavior means global flips can take about 60 seconds. Do not promise sub-minute global freshness.
- Public reachability requires a Cloudflare Workers Custom Domain for `status.trycycloid.com`, managed in `infra/` as a separate PR after the worker exists.

## Sandbox

- Production sandbox runtime deploys through E2B template builds. Local template builds:

```bash
npm run build:e2b-template
```

- Templates are named `<stem>-mem<MB>-cpu<N>` for every tier (default tier `<stem>-mem4096-cpu2`); prod stem is `arc-default-template`.
  The worker config (`E2B_SANDBOX_TEMPLATE`) holds the bare stem and `resolveRuntimeTemplateId` appends the suffix.
  When renaming a stem or changing the suffix scheme, **build the new template names before the control-plane worker flips to them** — a worker requesting a template that was never registered fails every spawn with a 404.
  Build via `Deploy E2B Sandbox` (`workflow_dispatch`) on the branch first, list every new template ID in `.github/e2b-prebuilt-prod-templates.txt`, then add the `e2b-template-prebuilt` PR label so the lint guard reruns and permits the merge.
- The sandbox deploy workflow must trigger for `shared/**` changes: sandbox-bridge and bundled MCP apps import shared modules directly, so shared code can change the sandbox runtime without touching `apps/sandbox*`.
- `npm run dev:full` does not apply sandbox or bridge code changes; an E2B template rebuild/deploy is required.
- Production E2B deploys smoke-test each generated resource-profile template, then register the current base template refs with the control plane. Registration retries repeated `404`, 5xx, or transport failures because the control-plane deploy can lag the sandbox deploy; if the route remains unavailable, the registration step soft-fails while the E2B deploy stays green. Layer builds use the existing environment fallback until the route is live and registration is rerun. Repo-sourced sandbox layer builds use the registry to record base provenance and detect stale active artifacts.
- In the grouped QA-gated production DAG, production template build/smoke and the control-plane Worker deploy both start after `qa-gate`.
  Base-template registration waits for both.
- Bridge bundle publish (ARC-1512): the sandbox deploy job ensures the `cycloid-bridge-bundles[-qa]` R2 bucket (`scripts/ensure-cloudflare-r2-buckets.sh`) then publishes the current gzipped `apps/sandbox-bridge/dist/bundle.js` via `scripts/publish-bridge-bundle.mjs` — a content-addressed `bridge/<sha256>.js.gz` blob plus a `bridge/current.json` pointer. `apps/sandbox-bridge/**` is a sandbox surface, so bridge-only merges trigger it; the control-plane deploy also runs the bucket ensure before `wrangler deploy` (the binding fails a deploy against a missing bucket). The publish step fails the deploy loudly (a deploy that ships without publishing re-creates the stale-bridge bug). The control plane injects the published bundle at session start (PR 2).
- After each successful prod deploy (and on manual dispatch), `prod-e2b-verifier.yml` runs `scripts/verify-e2b-session.ts` against production with `ARCANIST_PROD_VERIFIER_TOKEN`, uploads `artifacts/prod-pr-smoke-*.json`, and posts pass/fail status to Slack via `SLACK_WEBHOOK_URL`. A 30-min cooldown coalesces deploy bursts to one smoke; a sparse every-3h schedule tick runs the workflow as a cheap liveness signal (gated out of the smoke) so the dead-man switch does not false-alarm on quiet nights. Idle periods with no deploys run no smoke.

## Secrets

Secrets live under `/cycloid/*` in AWS SSM and sync during deploys:

- control-plane deploys sync Worker secrets to Cloudflare
- E2B control-plane secrets, including `E2B_API_KEY`, stay in SSM and sync to Cloudflare Worker secrets during control-plane deploys

Most SSM parameter names are Terraform-managed while their secret values are rotated out-of-band because `infra/ssm.tf` ignores live value drift.
After any out-of-band value rotation, run the normal dependent deploy or documented secret sync so Cloudflare Worker secrets receive the new value.
Turnstile keys are Terraform-sourced from the Cloudflare widget and follow the Terraform workflow.

## Sequencing hazards

- Split infra changes from deploy-workflow changes when the latter depends on the former.
- Follow [testing.md](testing.md) for rollout verification and E2E-session evidence when a change needs runtime validation.
