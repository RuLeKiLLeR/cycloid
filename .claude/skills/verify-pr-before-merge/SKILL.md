---
name: verify-pr-before-merge
description: Verify behavior introduced by an unmerged GitHub PR or local-only changes before merge by preparing a clean verification worktree, setting up the matching E2B control-plane test environment, starting a full Cycloid CLI session, and reporting pass/fail with evidence. Use when asked to validate, smoke-test, or end-to-end verify a PR or unpublished local work that has not been merged or deployed to production.
user_invocable: true
argument: PR URL, PR number, or local
---

# Verify PR Before Merge

Validate an unmerged PR or local-only changes against the exact code under review, not `main` or production. Goal: an evidence-backed pass/fail from a full CLI-created or CLI-driven Cycloid session after preparing the code in the E2B-backed test environment.

## Input

User may provide a PR URL, PR number, or ask to verify local-only changes. If no PR is provided, first try the PR for the current branch via `gh pr view`. If no PR exists and the checkout has local commits, staged, or unstaged changes, continue in local-only mode. Stop and ask for the PR only when there is no PR and no local-only work to verify.

Do not ask for a generic expected-behavior line. Derive the behavior from the PR title, body, diff, changed files, tests, comments, local commits, staged diff, and unstaged diff. Ask only when the behavior is materially ambiguous.

Local-only mode verifies a reproduced local delta in a clean worktree. It cannot prove behavior depending on a remote sandbox checking out unpublished repo changes unless those changes are pushed to a fetchable branch or baked into the E2B template under test.

If you are already running inside a Cycloid verification session (`ARCANIST_AGENT_ROLE=verification`), do not follow this skill's session-creation steps. QA verifiers must not create nested Cycloid sessions via `cycloid sessions create`, raw `/api/sessions` calls, or `cycloid.spawn_child_session` unless they have an authenticated programmatic read path for the spawned session state/transcript. Use direct local/sandbox evidence instead, or report a verification gap when a nested session would be the only remaining proof route.

## Step 1: Determine Verification Mode

PR mode (PR provided or discoverable):

```bash
gh pr view <PR> --json number,title,body,url,baseRefName,headRefName,headRefOid,baseRefOid,headRepository,headRepositoryOwner,mergeStateStatus,state,files,commits
gh pr diff <PR>
gh pr checks <PR> --json name,state,bucket,workflow,link,completedAt
```

Local-only mode (no PR, local work exists):

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

- the behavior introduced by the PR or local delta
- files and surfaces affected: sandbox, sandbox-bridge, control plane, CLI, UI, workflows, infra, or docs
- the exact PR head branch and SHA, or local source branch, source SHA, and dirty/staged patch state
- the smallest Cycloid CLI prompt that exercises the behavior
- expected success and failure signals in session events, E2B runtime state, PR checks, local commands, or observability

If the change touches E2B, sandbox behavior, deploy flow, auth, runtime behavior, workflow files, or observability, read the relevant repo docs before testing. For control-plane plus E2B verification, always read `docs/e2b-local-setup.md` and `docs/testing.md`. Read `docs/qa-environment.md` only if the behavior may actually require QA.

If the change affects Slack behavior, also read `docs/slack-testing.md` and default to a real Slack verification in an internal non-customer sandbox/test channel when one is available. Only ask the user to choose a channel if no suitable internal test channel is accessible, write permission is missing, or the action would be externally visible in a customer/shared space.

For review-loop rendering, follow [docs/review-loop.md](docs/review-loop.md) for the gating and verification requirements. The CLI token cannot toggle Automatic review handling; enable it in the UI. Do not verify via an `@cycloid` mention: that uses the separate `github_pr_mention_diff_hunk` renderer instead of the deterministic worklist path.

## Step 2: Create a Clean Verification Worktree

Always default to a fresh worktree from `origin/main` to avoid validating unrelated dirty state.

PR mode:

```bash
git fetch origin main
WORKTREE="../cycloid-pr-<number>-verify"
git worktree add "$WORKTREE" origin/main
cd "$WORKTREE"
gh pr checkout <PR>
bash scripts/worktree-setup.sh
```

If `gh pr checkout <PR>` fails because the PR branch is already checked out in another worktree, do not reuse that dirty worktree. Check out the PR head detached in the fresh worktree instead:

```bash
gh pr checkout <PR> --detach
```

Detached checkout is acceptable only as a read-only fallback. If a failing PR check is reasonable to fix, create or switch to a local branch in the verification worktree before editing so the workflow can repair the PR instead of stopping at a generic failure. After the repair, commit and push the updated branch back to the PR head ref before re-checking GitHub status or running a branch-pinned session. Record whether the worktree stayed detached or switched to a local branch for fixes, plus the branch/ref pushed.

Local-only mode: reproduce the local branch commits and dirty changes in a clean worktree. From the source checkout:

```bash
git fetch origin main
SOURCE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SOURCE_SHA="$(git rev-parse HEAD)"
VERIFY_LABEL="local-${SOURCE_BRANCH//[^A-Za-z0-9._-]/-}-$(git rev-parse --short HEAD)"
WORKTREE="../cycloid-${VERIFY_LABEL}-verify"
COMMITS_PATCH="$(mktemp -t cycloid-local-commits.XXXXXX.patch)"
DIRTY_PATCH="$(mktemp -t cycloid-local-dirty.XXXXXX.patch)"
STAGED_PATCH="$(mktemp -t cycloid-local-staged.XXXXXX.patch)"

git diff --binary origin/main...HEAD > "$COMMITS_PATCH"
git diff --binary > "$DIRTY_PATCH"
git diff --cached --binary > "$STAGED_PATCH"

git worktree add "$WORKTREE" origin/main
cd "$WORKTREE"
test ! -s "$COMMITS_PATCH" || git apply "$COMMITS_PATCH"
test ! -s "$DIRTY_PATCH" || git apply "$DIRTY_PATCH"
test ! -s "$STAGED_PATCH" || git apply --cached "$STAGED_PATCH" || {
  echo "Failed to reproduce staged changes in verification worktree" >&2
  exit 1
}
bash scripts/worktree-setup.sh
```

If patch application fails, stop and report the conflict. Do not hand-merge verification patches unless the user explicitly asks; that can change the code being verified.

After checkout or patch reproduction, record:

- mode: PR or local-only changes
- worktree path
- current branch
- `git rev-parse HEAD`
- `git status --short --branch`
- for PR mode, the PR head SHA
- for local-only mode, the source checkout path, source branch, source SHA, and whether commits, staged changes, or unstaged changes were included

In PR mode, the tested SHA must match the PR head SHA from Step 1. If not, stop and fix the checkout before proceeding.

In local-only mode, the verification worktree should normally remain based on `origin/main` with reproduced patches. Confirm the reproduced diff matches the source diff before proceeding:

```bash
git diff --stat origin/main
git diff --cached --stat origin/main
```

## Step 3: Run Pre-Deploy Verification

Run local verification relevant to the change before deploying:

```bash
npm run typecheck
```

Also run targeted tests for changed code, chosen from PR files, local changed files, and nearby tests. If the change touches GitHub workflow YAML, `npm run typecheck` must exercise the workflow YAML checker.

In PR mode, check GitHub Actions:

```bash
gh pr checks <PR> --watch
```

Do not proceed to an end-to-end pass while required checks are failing. Inspect the failing required checks and decide whether the failure is reasonable to fix in the current task. When it is a normal repo-owned issue (backend tests, typecheck, lint, or workflow YAML on the PR branch), fix it by default instead of stopping at a generic "PR is not ready to merge" report. After the fix, rerun the relevant local commands, commit it and push the updated branch back to the PR head ref when PR mode is using a worktree branch or detached fallback, then re-check GitHub status against the updated remote SHA. Only stop and report fail immediately when the required check failure is unreasonable to fix in this flow (missing external credentials, flaky or unavailable third-party systems, unrelated broad CI breakage, or a change that would materially exceed the verification scope); in that case, name the exact failing checks, link them, and explain why the fix was unreasonable.

In local-only mode, skip GitHub Actions (no PR ref). Report that GitHub checks were not available and rely on local commands plus the Cycloid session evidence.

## Step 4: Prepare the E2B Pre-Merge Test Environment

Default to local control plane plus E2B for pre-merge verification. Use QA only when the behavior needs deployed Cloudflare semantics, stable HTTPS callbacks, browser OAuth, webhooks, or teammate-accessible verification. Historical non-E2B runtimes are out of scope unless the change explicitly targets compatibility cleanup and the user explicitly requests that path.

Do not escalate to QA just because the changed area is high blast radius. If local dev can run the risky code path through a real Cycloid session, local dev is the default.

Confirm local E2B configuration in `apps/control-plane-worker/.dev.vars`:

```bash
test -n "$(sed -n 's/^E2B_API_KEY=//p' apps/control-plane-worker/.dev.vars)" || {
  echo "E2B_API_KEY is missing from apps/control-plane-worker/.dev.vars" >&2
  exit 1
}
grep -E '^(E2B_RUNTIME_ENABLED|E2B_SANDBOX_TEMPLATE)=' apps/control-plane-worker/.dev.vars
```

Required local values:

- `E2B_API_KEY` must be present
- `E2B_RUNTIME_ENABLED=true`
- `E2B_SANDBOX_TEMPLATE` must point at the template under test

Build an E2B template from the verification worktree when the change affects sandbox-image contents, E2B template source, sandbox bridge code, MCP bundles, or shared code used inside the sandbox:

```bash
TEMPLATE="cycloid-sandbox-verify-<pr-or-local-label>-$(git rev-parse --short HEAD)"
BUILD_LOG="$(mktemp -t cycloid-e2b-template-build.XXXXXX.log)"
bash scripts/e2b-template-build.sh --tag "$TEMPLATE" --include-repo-spec-templates | tee "$BUILD_LOG"
```

Set `E2B_SANDBOX_TEMPLATE=$TEMPLATE` in the worktree's local `.dev.vars` before starting or restarting `npm run dev:full`. Do not commit `.dev.vars`.

Always include repo-spec templates in this flow, even when the current PR does not appear to touch resource sizing. Some repos, including `trycycloid/cycloid`, use hardcoded non-default sandbox resource specs, and the control plane derives template aliases such as `-mem8192-cpu4` at runtime. Building only the base alias causes a late sandbox spawn failure during verification.

After any rebuild, record the emitted template aliases from `BUILD_LOG`. Every line beginning with `E2B_SANDBOX_TEMPLATE=` or `E2B_REPO_SANDBOX_TEMPLATE=` is verification evidence proving which aliases were published.

If the change does not affect sandbox artifacts, use the existing local personal template after confirming it is recent enough for the behavior under test. Record that no rebuild was needed and why.

Before starting any live session, do a repo-template preflight for the repo under test. If the target repo has a repo-specific sandbox resource variant, verify the published alias exists in the build output or rebuild with `--include-repo-spec-templates` before proceeding. Do not assume the base template tag is sufficient just because `E2B_SANDBOX_TEMPLATE` is set.

Local-only mode: remote sandbox checkout can only fetch remote refs. Local-only sandbox, bridge, MCP, or shared-code changes must be included in the E2B template, or verification cannot prove those sandbox-executed changes. Control-plane, UI, and CLI changes can still be exercised by running those services from the verification worktree.

Start local Cycloid from the verification worktree:

```bash
npm run dev:full
```

If the command needs to run in the background, keep the session open and poll until the API is healthy:

```bash
curl -fsS http://localhost:<api-port>/api/health
```

Ensure the sandbox can call back into the local control plane. Read `CONTROL_PLANE_URL` from `apps/control-plane-worker/.dev.vars` and verify it reaches the active local API:

```bash
curl -fsS "$CONTROL_PLANE_URL/api/health"
```

If the tunnel is offline or points at the wrong process, restart it to the active API port, then re-check health. Do not commit `.dev.vars` changes.

When the session target repo is known before the live run, confirm the local control plane can derive the expected runtime template alias for that repo:

```bash
TARGET_REPO="<owner>/<repo>"
grep -E '^(E2B_SANDBOX_TEMPLATE|E2B_REPO_SANDBOX_TEMPLATE)=' "$BUILD_LOG" 2>/dev/null || true
```

If the target repo is covered by a repo-specific resource spec and the matching `E2B_REPO_SANDBOX_TEMPLATE=<owner>/<repo>:...` line is absent, stop and rebuild the template with `--include-repo-spec-templates` before creating a session.

For QA verification instead of local E2B:

1. Push the PR branch or a temporary verification branch for local-only changes.
2. Run `Deploy Control Plane Worker (QA)` for that ref.
3. Run `Deploy E2B Sandbox (QA)` for the same ref if sandbox artifacts changed.
4. Run `Deploy Frontend (QA)` for the same ref if UI changed.
5. Verify against `https://qa.app.trycycloid.com`.

Do not use a legacy non-E2B runtime for normal repo-session verification unless the change explicitly targets historical compatibility cleanup and the user asked for that path. If such a runtime is used, state why E2B is insufficient before running it.

Record:

- local API URL and public callback URL
- E2B template name, template ID, build ID, and whether it was rebuilt
- local or QA environment used
- E2B config source (`.dev.vars` locally or QA Worker vars/secrets)
- any deviation from the E2B path, with reason

Do not merge the PR and do not verify against production unless the user explicitly asks.

## Step 5: Kick Off a Full Cycloid CLI Session

In PR mode, the session must run against the PR head branch. Prefer CLI end-to-end if the CLI supports branch selection. If not, create only the branch-pinned session through the local control-plane API, then use the CLI for session execution and observation.

In local-only mode, choose the session branch based on what is being verified:

- if the change only affects local control plane, UI, or CLI behavior, create the session against a normal remote branch such as `main` while running local services from the verification worktree
- if sandbox-executed code must include local-only changes, first bake those changes into the E2B template or push a temporary fetchable verification branch, then record which path was used
- do not claim a local-only session tested unpublished sandbox checkout changes unless the evidence shows they were included through the template or a fetchable branch

Cycloid's local session creation API currently uses the field name `baseBranch` as the first checkout branch when spawning a sandbox. For PR-mode fallback only, set `baseBranch` to the PR head branch and verify the resulting session state reports that PR head value. Do not use this fallback session to create or publish a PR, because later PR creation paths also interpret `baseBranch` as the GitHub merge target.

Do not create the session until the E2B template preflight is complete. A missing repo-specific alias is a setup failure, not a verification result. Rebuild first, then start a fresh session.

For local-only mode, set:

```bash
VERIFY_REF="local:<source-branch>@<source-sha>"
VERIFY_LABEL="local-<source-branch>-<short-sha>"
SESSION_BRANCH="<fetchable-branch-or-main>"
```

For the PR-mode branch-pinned fallback, set `REPO_URL` and `SESSION_BRANCH`, then run `bash scripts/debug/branch-pinned-session.sh`. The helper resolves the local owner, creates the session with `baseBranch` pinned to the requested branch, and prints the session ID.

If the resolved owner is not the eval owner and sandbox spawn fails because provider or GitHub credentials are missing, seed the required local integrations for that owner. Do not silently switch back to `1001` to make the run pass.

Then use the CLI to send and watch the prompt:

```bash
ARCANIST_API_URL=http://localhost:<api-port> \
ARCANIST_TOKEN="$ADMIN_TOKEN" \
npx cycloid sessions send "$SESSION_ID" "<verification prompt>" --json

ARCANIST_API_URL=http://localhost:<api-port> \
ARCANIST_TOKEN="$ADMIN_TOKEN" \
npx cycloid sessions watch "$SESSION_ID" --poll-interval 2000
```

If the CLI can create the branch-pinned session directly, use that instead and record the exact command.

The prompt should be small and targeted: exercise the behavior from the PR or local delta, not simply ask the agent to inspect the code. Wait until the session becomes `idle`, `closed`, or reaches a clear terminal failure. Do not report pass while the prompt is running.

## Step 6: Collect Evidence

Collect session evidence through the CLI or local API:

```bash
ARCANIST_API_URL=http://localhost:<api-port> ARCANIST_TOKEN="$ADMIN_TOKEN" npx cycloid sessions get "$SESSION_ID" --json
ARCANIST_API_URL=http://localhost:<api-port> ARCANIST_TOKEN="$ADMIN_TOKEN" npx cycloid sessions events "$SESSION_ID" --json --limit 1000
ARCANIST_API_URL=http://localhost:<api-port> ARCANIST_TOKEN="$ADMIN_TOKEN" npx cycloid sessions transcript "$SESSION_ID"
```

Collect runtime state when sandbox behavior matters:

```bash
curl -fsS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:<api-port>/api/sessions/$SESSION_ID/sandbox-state"

E2B_API_KEY=<key> npm run debug:e2b:sandbox -- list \
  --state running,paused \
  --metadata runtime_provider=e2b,session_id=$SESSION_ID

E2B_API_KEY=<key> npm run debug:e2b:sandbox -- status <runtime_sandbox_id>
```

Filter for the session ID, prompt ID, runtime sandbox ID, template ID, source branch/SHA, verification ref, and expected log markers. Capture enough output to show the behavior occurred or failed.

For Braintrust or Datadog evidence, use the direct observability paths that can see the environment being tested: D1 session/`prompt_runs` records, rendered transcript, Braintrust REST/BTQL or sandbox `braintrust.query_sql`, current local Datadog MCP tools when present, and sandbox Datadog dynamic tools such as `search_datadog_logs` or `get_datadog_trace`. Local sessions are often invisible to deployed observability, and local/test tracing may be disabled. Missing telemetry is acceptable only when CLI replay events, local API state, and E2B runtime evidence prove the behavior.

## Step 7: Decide Pass or Fail

Pass in PR mode only if all are true:

- the checked-out worktree SHA matches the PR head SHA
- required local verification and GitHub checks pass
- the E2B template used by the session matches the PR artifact requirements
- a fresh Cycloid CLI-driven session runs against the PR head branch
- the local API fallback, when used, reports `baseBranch` equal to the PR head branch and does not attempt PR creation or publishing
- the session evidence shows the PR behavior occurred
- no session event, E2B runtime state, check, or command output contradicts the expected outcome

Pass in local-only mode only if all are true:

- the verification worktree reproduces the intended local commits, staged changes, and unstaged changes from the source checkout
- required local verification passes
- unavailable GitHub checks are explicitly reported as skipped because there is no PR ref
- the E2B template or fetchable branch path includes any local-only code that must run inside the sandbox
- a fresh Cycloid CLI-driven session exercises the local delta through local services, the rebuilt template, or the fetchable branch path
- the report clearly states `VERIFY_REF` and the session branch used
- no session event, E2B runtime state, check, or command output contradicts the expected outcome

Fail if any are true:

- the session tested `main`, production, or an unknown SHA when a PR head or local delta was required
- the local API fallback records an unexpected `baseBranch` value or the session creates/publishes a PR
- required checks or local verification fail
- E2B template build fails when a rebuild is required
- the session uses the wrong E2B template, unknown runtime provider, or non-E2B runtime for normal repo-session verification
- local-only sandbox-executed changes are neither baked into the E2B template nor available on a fetchable branch
- the verification runs a legacy non-E2B runtime without a historical-compatibility change or explicit user request
- the CLI session cannot be created, started, watched, or brought to terminal state
- the session does not exercise the PR behavior or local delta
- evidence is missing or contradicts the expected behavior

Do not stop at a generic verification failure when the verified branch is broken in a reasonable, repo-owned way. In PR mode, fix normal failing required checks by default (especially backend test, typecheck, lint, and workflow failures), then rerun the relevant verification and continue the end-to-end pass. In local-only mode, fix local breakages that block meaningful verification when the repair is in scope. Only skip fixing when the repair is unreasonable, blocked by missing access or external system state, or would require a broad out-of-scope refactor; then report the exact blocker, what you tried, and why the repair was unreasonable in this run.

See [the shared Skill Feedback Loop guidance](docs/skill-shared.md#skill-feedback-loop).

## Report Format

Report the conclusion and evidence. Include:

- `Conclusion`: pass or fail
- `Mode`: PR or local-only changes
- `PR`: number, URL, base branch, head branch, and tested SHA; use `n/a` for local-only mode
- `Local source`: source checkout path, branch, SHA, commits included, staged changes included, and unstaged changes included; use `n/a` for PR mode
- `Worktree`: path, branch, and cleanliness
- `Checks`: GitHub checks and local commands run
- `Runtime`: local E2B or QA, template name, template ID/build ID when available, and config source
- `Session`: CLI/API commands used, session ID, prompt ID, runtime provider, sandbox status, branch/baseBranch, `VERIFY_REF` when local-only, and final session status
- `Evidence`: replay events, transcript excerpts, E2B runtime state, MCP/Braintrust/Datadog IDs if used
- `Discrepancies`: missing telemetry, skipped checks, deviations from CLI-only flow, local-only sandbox limitations, or risks
- `Skill gaps`: friction events and proposed fixes per the Skill Feedback Loop section; omit when there was none

For a pass, cite the positive evidence proving the behavior. For a fail, cite the failing or missing evidence that blocks confidence.
