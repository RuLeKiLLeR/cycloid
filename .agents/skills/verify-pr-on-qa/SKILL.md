---
name: verify-pr-on-qa
description: Use when the user explicitly asks to verify, smoke-test, or end-to-end test a PR, branch, or local change on Cycloid's shared QA environment (qa.app.trycycloid.com / qa.trycycloid.com), or names a QA deploy or QA session as the target. Requires explicit QA intent; generic pre-merge verification with no QA request belongs to verify-pr-before-merge.
user_invocable: true
argument: PR URL, PR number, branch, or local
---

# Verify PR on QA

Validate behavior on Cycloid's deployed QA stack, not local dev or production. QA is a single shared environment:

- API: `https://qa.trycycloid.com`
- UI: `https://qa.app.trycycloid.com`
- Datadog: `https://us5.datadoghq.com`, filter with `env:qa script:cycloid-control-plane-qa`

The goal is an evidence-backed pass/fail result for the exact ref deployed to QA.

## Input

The user may provide a PR URL, PR number, branch, SHA, or ask to verify local-only changes. If no target is provided, first try the PR for the current branch with `gh pr view`. If no PR exists, inspect the current branch and local status.

Do not ask for a generic expected-behavior line. Derive the behavior from the PR title, body, diff, changed files, tests, comments, local commits, staged diff, and unstaged diff. Ask only when the behavior is materially ambiguous.

QA can only deploy fetchable Git refs. Do not claim QA verified unpublished local changes unless they were committed and pushed to a temporary verification branch, or otherwise included in a deployed artifact. If dirty or staged local changes need to be committed for QA deployment, ask before creating and pushing a temporary verification commit.

## Hard Rules

- Do not verify against production for this skill.
- Do not use `https://app.trycycloid.com`; use QA URLs only.
- Do not dispatch QA workflows with `--ref <feature-branch>`. Always load workflow YAML from `main` and pass the target as the `ref` input.
- Do not mix deployed refs across QA control plane, frontend, and sandbox unless the test is explicitly about compatibility between versions. Record any mixed-ref state as a discrepancy.
- For session-based verification, `deploy-e2b-sandbox-qa.yml` is the only workflow that rebuilds the QA sandbox template tiers. If the change needs that template, run it last so the worker and template both come from `QA_REF`.
- QA is single-slot. Check for active QA deploys before dispatching and stop or coordinate if another unrelated verification is in progress.
- Do not merge the PR or deploy production unless the user explicitly asks.

## Step 1: Understand the Target

PR mode:

```bash
gh pr view <PR> --json number,title,body,url,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,mergeStateStatus,state,files,commits
gh pr diff <PR>
gh pr checks <PR> --json name,state,bucket,workflow,link,completedAt
```

Branch or local mode:

```bash
git fetch origin main
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --stat
git diff --cached --stat
git diff origin/main...HEAD
git diff
git diff --cached
```

Identify:

- the behavior being verified
- the target branch/ref and expected SHA
- changed surfaces: control plane, UI, sandbox/E2B, sandbox bridge, CLI, workflows, infra, docs, Slack, or observability
- the QA deploy workflows required
- the smallest real QA action that exercises the behavior
- expected success and failure signals in QA UI, API responses, session events, PR output, sandbox state, Datadog, Sentry, or Braintrust

Read `docs/qa-environment.md` and `docs/testing.md` before testing. If the change touches deploy flow, infra, sandbox images/templates, auth, runtime behavior, workflow files, or observability, also read the relevant repo docs from `AGENTS.md`.

For Slack behavior, read `docs/slack-testing.md`. Slack QA parity is documented in [docs/qa-prod-parity.md](docs/qa-prod-parity.md).

For review-loop rendering, follow [docs/review-loop.md](docs/review-loop.md) for the gating and verification requirements. On QA, the admin token can toggle Automatic review handling; confirm it is on before verifying.

## Step 2: Prepare a Fetchable QA Ref

For same-repo PRs, use the PR head branch. For fork PRs or branch-name ambiguity, prefer the PR ref:

```bash
QA_REF="refs/pull/<number>/head"
QA_EXPECTED_SHA="<headRefOid from gh pr view>"
```

For branch mode, confirm the ref is fetchable:

```bash
git ls-remote origin <branch-or-sha>
```

For local-only mode:

- if all changes are already committed on a pushed branch, use that branch
- if commits are local-only, push a temporary verification branch
- if there are staged or unstaged changes, ask before committing and pushing a temporary verification snapshot

Record the source checkout path, source branch, source SHA, pushed QA ref, and expected deployed SHA.

## Step 3: Run Pre-Deploy Checks

Run local verification relevant to the change before deploying:

```bash
npm run typecheck
```

Also run targeted tests for changed code, choosing the smallest meaningful commands from changed files and nearby tests.

For PR mode, required GitHub checks should be green before a QA pass:

```bash
gh pr checks <PR> --watch
```

If a required check fails for a normal repo-owned reason (typecheck, lint, backend tests, workflow YAML, or focused tests), fix it by default before deploying to QA. QA can only deploy fetchable refs, so a repair must be committed and pushed to the PR head branch; a scratch-worktree fix that is never pushed cannot be QA-verified. This intentionally changes the PR under test, so record every repair commit SHA in the report's `Checks` field — never alter the deployed ref silently. Stop and report only when the failure is unreasonable to fix in this flow, such as missing external credentials, unrelated broad CI breakage, unavailable third-party systems, or an out-of-scope refactor.

## Step 4: Choose QA Deployments

Use the same `QA_REF` for every deployed surface needed by the change.

Deploy control plane when changes touch:

- `apps/control-plane-worker/`
- `shared/` code consumed by the worker
- migrations, worker config, queues, D1/KV bindings, auth, session state, webhooks, observability, deploy workflow behavior

Deploy frontend when changes touch:

- `apps/ui/`
- UI-consumed `shared/` code
- UI build config, public assets, Sentry/source-map behavior, frontend routing

Deploy E2B sandbox when changes touch:

- `apps/sandbox-e2b/`
- `apps/sandbox-bridge/`
- sandbox Dockerfile/start scripts, bridge bundles, MCP bundles, Codex config templates, sandbox-executed shared code, or E2B template behavior

`E2B_SANDBOX_TEMPLATE` is the **stable** stem `cycloid-sandbox-qa`, pinned permanently in `wrangler.toml [env.qa.vars]` (the worker appends `-mem<MB>-cpu<N>` at spawn). No workflow pins it via `--var`. `deploy-e2b-sandbox-qa.yml` rebuilds and registers the suffixed template tiers from `QA_REF` and also redeploys the QA worker. A session-based verification must run `deploy-e2b-sandbox-qa.yml` from `QA_REF` when the change touches sandbox/bridge/shared/template behavior (only it rebuilds the template), or when the stable template has never been built in the current E2B QA team. For a control-plane-only change, `deploy-control-plane-qa.yml` alone leaves a spawn-capable QA. Step 5 covers the deploy order.

For CLI-only changes, run the local CLI from the verified checkout against QA and record the local CLI SHA. QA deploys alone do not prove unpublished CLI behavior.

## Step 5: Deploy to QA

Check for active QA deployments first:

```bash
gh run list -R trycycloid/cycloid --workflow deploy-control-plane-qa.yml --event workflow_dispatch --status in_progress --limit 5
gh run list -R trycycloid/cycloid --workflow deploy-frontend-qa.yml --event workflow_dispatch --status in_progress --limit 5
gh run list -R trycycloid/cycloid --workflow deploy-e2b-sandbox-qa.yml --event workflow_dispatch --status in_progress --limit 5
```

Re-run each check with `--status queued` as well — a `workflow_dispatch` run that is dispatched but not yet started is still an active QA deploy and can overwrite the environment mid-verification.

Deploy order:

- For a session-based verification that touches sandbox/bridge/shared/template behavior, `deploy-e2b-sandbox-qa.yml` from `QA_REF` is what rebuilds the template; make it the last worker-affecting deploy so the worker also runs `QA_REF` code. `E2B_SANDBOX_TEMPLATE` itself is the stable stem `cycloid-sandbox-qa` and is no longer pinned per-deploy, so a later control-plane deploy would still leave the worker on `main` code, not `QA_REF`.
- `deploy-control-plane-qa.yml` also runs the SSM secret sync, D1 migrations, and queue creation. Run it first, and only when the change needs those extra steps.
- Both QA worker deploys (`deploy-control-plane-qa.yml`, `deploy-e2b-sandbox-qa.yml`) share the `qa-deploy` concurrency group, so dispatching both serializes them rather than racing on D1 migrations. Order still matters for which worker code lands last — make the `QA_REF` deploy last.
- `deploy-frontend-qa.yml` is independent of the worker and can run at any time.
- The active-deploy check and the dispatch are not atomic. Re-run the check immediately before each dispatch and again right after; if a competing QA deploy appears, stop and coordinate. A shared single-slot QA has no lock, so also treat a competing mid-run deploy as a discrepancy (Step 8).

For a typical session-based verification, `deploy-e2b-sandbox-qa.yml` from `QA_REF` deploys both the worker code and the sandbox template by itself; add `deploy-control-plane-qa.yml` first only for migrations, new secrets, or new queues.

Dispatch only the workflows the change needs — these are individual commands, not a script to run top to bottom. Each uses `--ref main`, with the target in `-f ref="$QA_REF"`.

Control plane — run first, and only when the change needs migrations, new secrets, or new queues:

```bash
DISPATCH_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run deploy-control-plane-qa.yml -R trycycloid/cycloid --ref main -f ref="$QA_REF"
```

Frontend — only for UI changes; independent of the worker, so any time:

```bash
DISPATCH_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run deploy-frontend-qa.yml -R trycycloid/cycloid --ref main -f ref="$QA_REF"
```

Last worker-affecting deploy — run for a session-based verification when the change touches sandbox/bridge/shared/template behavior, or when the stable template has never been built:

```bash
DISPATCH_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run deploy-e2b-sandbox-qa.yml -R trycycloid/cycloid --ref main -f ref="$QA_REF"
```

Find the new workflow runs and wait for each to pass. `gh workflow run` does not print the run ID, so use the `DISPATCH_TS` captured just before the dispatch and identify the run by `createdAt` after that timestamp plus your own actor login. Expect exactly one matching new run per workflow: if none appeared yet, wait and re-query; if more than one appears, a competing deploy is in flight, so stop and coordinate.

```bash
gh run list -R trycycloid/cycloid --workflow <workflow-file> --event workflow_dispatch --branch main \
  --user "$(gh api user --jq .login)" --created ">=$DISPATCH_TS" \
  --json databaseId,status,conclusion,createdAt,url --limit 10
gh run watch <run-id> -R trycycloid/cycloid --exit-status
gh run view <run-id> -R trycycloid/cycloid --json databaseId,status,conclusion,url,createdAt,updatedAt
```

After deploy, confirm QA is reachable:

```bash
curl -fsS https://qa.trycycloid.com/api/health
curl -fsS https://qa.app.trycycloid.com
```

Confirm the QA worker is pinned to the stable session template when session verification depends on sandbox behavior:

```bash
gh run view <e2b-sandbox-run-id> -R trycycloid/cycloid --log | grep -E 'E2B_SANDBOX_TEMPLATE='
```

For a session-based verification, `E2B_SANDBOX_TEMPLATE` is the stable stem `cycloid-sandbox-qa` — it carries no SHA, so you cannot tie it to `QA_EXPECTED_SHA` by name. When the change touches sandbox/bridge/shared/template behavior, prove the template was rebuilt from `QA_REF` instead via the `deploy-e2b-sandbox-qa.yml` run: its `TEMPLATE_SHA` log line (`git rev-parse HEAD` of `QA_REF`) must equal `QA_EXPECTED_SHA`, and the run must have completed green after that ref's build step. For a control-plane-only change, confirm the `deploy-control-plane-qa.yml` run was from `QA_REF` and that a session still spawns (the stable template persists across it).

Record workflow names, run IDs, run URLs, target ref, expected SHA, completion status, and any deployed template name or SHA printed by the workflow logs.

## Step 6: Exercise the Behavior on QA

Use the smallest real QA action that proves the behavior.

For UI behavior, use a fresh or incognito browser session at `https://qa.app.trycycloid.com`, exercise the affected page, check the browser console, and capture screenshots when visual behavior matters.

For worker/API behavior, call QA API routes through `https://qa.trycycloid.com` or the QA UI proxy as appropriate. Include auth only from QA tokens or QA browser sessions.

For session, sandbox, bridge, or runtime behavior, run a real QA Cycloid session. Prefer a real user-initiated QA browser or CLI session when fixture business credentials matter. If using the headless smoke runner, treat it as evidence only when it produces a green verdict; `docs/qa-environment.md` documents a known admin-token fixture credential gap.

QA tokens are not in the repo or any local `.dev.vars`. `ARCANIST_TOKEN` is a QA user token: copy the `session_token` cookie from an authenticated `https://qa.app.trycycloid.com` browser session, or mint a QA CLI token. `ARCANIST_ADMIN_TOKEN` is the QA admin token in AWS SSM at `/cycloid/qa/ARCANIST_ADMIN_TOKEN`. Never use a prod (`/cycloid/*`) or local token against QA.

QA session spawn can fail before any PR behavior runs when QA secrets are missing or stale. `npm run qa:seed` provisions a validated QA business OpenAI credential from `ARCANIST_OPENAI_API_KEY`; if spawn returns `business_key_missing` / "No API key configured for OpenAI", rerun `qa:seed` after confirming the QA-scoped SSM secret is present, then re-run the verification.

Useful QA commands:

```bash
ARCANIST_TOKEN=<qa token> npm run verify:e2b-session -- \
  --base-url https://qa.app.trycycloid.com \
  --repo-owner trycycloid \
  --repo-name dummy-docker-app \
  --json-out /tmp/qa-e2b-session.json

ARCANIST_ADMIN_TOKEN=<qa admin token> QA_API_URL=https://qa.trycycloid.com \
  npm run smoke:qa:dummy-app -- \
  --json-out /tmp/qa-smoke.json
```

Do not report pass while a session or smoke run is still active. Wait until the session is idle, closed, or reaches a clear terminal failure.

## Step 7: Collect Evidence

Collect enough evidence to tie the behavior to the QA ref:

- workflow run IDs, URLs, and green conclusions
- target ref and expected SHA
- QA health checks
- UI URL and screenshots when UI changed
- session ID, session URL, prompt text/action, prompt ID, final status, PR URL if one was expected
- sandbox runtime provider, sandbox ID, template name, template ID, and lifecycle state when sandbox behavior matters
- Datadog QA logs or traces with `env:qa script:cycloid-control-plane-qa`, filtered by `session_id`, `prompt_id`, `request_id`, or expected event names
- Sentry `environment:qa` issues or absence of new errors when UI/runtime errors matter
- Braintrust IDs if the QA path emits them and they are relevant

If telemetry is missing, determine whether the environment normally emits it. Missing telemetry cannot support a pass unless session/API/browser evidence still proves the behavior.

## Step 8: Decide Pass or Fail

Pass only if all are true:

- the tested ref was fetchable and matches the expected SHA
- every relevant QA surface was deployed from that ref, or skipped with a valid reason
- relevant local checks and required PR checks passed
- QA deploy workflows completed successfully
- for a session-based verification, the QA worker resolves `E2B_SANDBOX_TEMPLATE` to the stable `cycloid-sandbox-qa` stem and a session actually spawns; when the change touches sandbox/bridge/shared/template behavior, the `deploy-e2b-sandbox-qa.yml` run that rebuilt the template was from `QA_REF` (its `TEMPLATE_SHA` = `QA_EXPECTED_SHA`)
- QA health checks passed after deploy
- a real QA action exercised the behavior
- evidence shows the expected behavior occurred
- no workflow output, session event, sandbox state, browser console error, Datadog/Sentry/Braintrust signal, or command output contradicts the expected outcome

Fail if any are true:

- QA tested production, local dev, `main`, or an unknown SHA when a PR/branch/local delta was required
- local-only changes were not committed and pushed before QA deployment
- deployed QA surfaces used inconsistent refs without an explicit compatibility reason
- for sandbox-affecting changes, the session template was not rebuilt from `QA_REF`, or a later worker deploy left QA on different worker code before evidence was collected
- required checks, local verification, or QA deploy workflows failed
- the session/smoke/browser/API action did not exercise the behavior
- the session could not be created, watched, or brought to terminal state
- sandbox behavior used the wrong runtime provider or template
- evidence is missing, stale, or contradicts the expected behavior
- another QA deployment overwrote the environment before evidence was collected

See [the shared Skill Feedback Loop guidance](docs/skill-shared.md#skill-feedback-loop).

## Report Format

Report:

- `Conclusion`: pass or fail
- `Target`: PR/branch/local mode, target ref, expected SHA, base branch, PR URL when applicable
- `Deployments`: QA workflows run, run IDs, URLs, conclusions, deployed surfaces, skipped surfaces with reasons
- `Checks`: local commands, targeted tests, and GitHub checks
- `Environment`: QA API/UI URLs, health checks, template name/ID when applicable
- `Exercise`: browser/API/CLI/session/smoke action used, prompt or input, session ID/URL, final state
- `Evidence`: workflow output, session events/transcript excerpts, PR URL, screenshots, Datadog/Sentry/Braintrust IDs, sandbox state
- `Discrepancies`: missing telemetry, mixed refs, smoke-run limitations, skipped checks, active QA conflicts, or other risks
- `Skill gaps`: friction events and proposed fixes per the Skill Feedback Loop section; omit when there was none

For a pass, cite the positive evidence that proves the behavior. For a fail, cite the failing or missing evidence that blocks confidence.
