---
name: verify-deployed-pr
description: Verify behavior introduced by a GitHub PR after it has deployed by waiting for deployment, starting a fresh Cycloid CLI session, and using Cycloid session evidence plus Datadog observability to produce an evidence-backed pass/fail result. Use when asked to validate a deployed PR end to end rather than only inspect code or checks.
user_invocable: true
argument: PR URL or number
---

# Verify deployed PR behavior

Validate that a PR's behavior is present in the deployed environment via a real Cycloid session plus the resulting observability data.

## Input

The user provides a PR URL or number as `$ARGUMENTS`. If no PR is provided, use the PR for the current branch via `gh pr view`. If the PR cannot be found, stop and ask for the PR.

Do not ask the user for a generic "expected behavior" line. Derive the behavior to verify from the PR title, body, diff, changed files, and tests. Ask only when the PR context is unavailable or materially ambiguous.

## Step 1: Understand the PR

Fetch PR metadata and the diff:

```bash
gh pr view <PR> --json number,title,body,url,baseRefName,headRefName,mergeStateStatus,state,files,commits
gh pr diff <PR>
```

Identify:

- the behavior introduced by the PR
- the deployment surface it affects: UI, control plane, sandbox, CLI, infra, or a combination
- the smallest production Cycloid session prompt that should exercise the behavior against `trycycloid/cycloid`
- any observability signals that would prove the behavior occurred

If the PR touches deployment, infra, sandbox images/templates, auth, public UI runtime behavior, or observability plumbing, read the relevant repo docs before proceeding.

See [the shared Slack testing guidance](docs/skill-shared.md#slack-testing).

For review-loop rendering, follow [docs/review-loop.md](docs/review-loop.md) for the gating and verification requirements. The CLI token cannot toggle Automatic review handling; enable it in the UI.

If the PR changes the company-memory context selector (`apps/control-plane-worker/src/company-memory/context-*`, e.g. `selector_returned` events, `selectorLatencyMs`, or the selector timeout budget), note that `handleMemoryContextQueryForSession` is a sandbox-callback path: the selector only runs when the agent invokes the `memory_context` dynamic tool. A plain prose prompt usually will not fire it. Use a prompt that explicitly instructs the agent to invoke its `memory_context` tool (a follow-up `cycloid sessions send <id> "invoke your memory_context tool ..."` works), then query Datadog for `@event:memory_context.selector_returned` filtered to your `@sessionId`.

## Step 2: Wait for deployment

Wait for the relevant deployment to complete successfully before starting the verification session.

Use GitHub checks and workflows as the primary source:

```bash
gh pr checks <PR> --watch
gh run list --branch <head-or-main-branch> --limit 10
```

Use surface-specific checks when relevant:

- UI deploy: `npx wrangler pages deployment list --project-name=cycloid-ui`
- control plane: `curl https://app.trycycloid.com/api/health`
- general production health: `curl -sf https://app.trycycloid.com`

Do not merge the PR or trigger a deploy unless the user explicitly asked for that. If deployment is blocked or failed, stop and report the blocker with the failing workflow/check.

Record the deployed commit SHA, deploy workflow/check name, and completion time when available.

## Step 3: Create a Cycloid session from the CLI

Confirm the CLI command exists and is pointed at the intended environment. Production CLI sessions should use `https://app.trycycloid.com`.
Before running a production CLI command, check for `.cycloid-cli.json` in the current directory.
Worktree setup writes local API credentials there; if it exists, run the production command from the primary checkout or another directory without that file so local credentials cannot conflict with production environment variables.

Use `trycycloid/cycloid` as the default repository target for the verification session. Only choose a different repository when the PR behavior is specifically repo-dependent and cannot be exercised in `trycycloid/cycloid`; record that reason in the report.

Sessions always start from a fresh sandbox (the warm pool was removed), so every verification session proves the deployed sandbox image contains the change. Do not add the deprecated cold-start flag; it is a no-op retained only for backward compatibility.

Create the session with a prompt that exercises the PR behavior:

```bash
env -u ARCANIST_API_TOKEN ARCANIST_API_URL=https://app.trycycloid.com \
  cycloid --json sessions create https://github.com/trycycloid/cycloid "<verification prompt>"
```

If session-create returns `provider_key_not_validated`, the resolved agent model's provider is not validated for your CLI user (the default backend is `codex`/OpenAI). This is a per-user credential gate, not a deploy failure - retry with `--backend claude_code` (Anthropic), which is validated for the internal business. Any startable session exercises control-plane behavior like the memory selector, since that runs regardless of agent backend.

Capture the exact command, the printed session ID, and the UI URL. Then watch the session until it becomes idle or reaches the state needed for the verification:

```bash
env -u ARCANIST_API_TOKEN ARCANIST_API_URL=https://app.trycycloid.com \
  cycloid sessions watch <session-id>
```

If the session fails to start or the prompt fails to enqueue, report the CLI error and do not proceed as if verification ran.

## Step 4: Query observability

There are no first-party Cycloid session/observability MCP tools; gather evidence from the authoritative sources directly.
Use the Datadog, Braintrust REST/BTQL, D1, and session API workflow in `docs/debugging.md` for deeper raw inspection.

- **Session record + transcript**: the D1 session row plus its `prompt_runs` rows and the rendered session transcript are the authoritative record of what the session did. Pull them by session ID (`docs/debugging.md`, `docs/database.md`). Extract `bt_span_id` and `dd_trace_id` from the prompt rows when present.
- **Prompt runs**: use D1 `prompt_runs` plus the rendered session transcript for prompt/LLM run evidence; verify PR behavior from inputs, outputs, metadata, or tool traces stored there.
  When those sources do not expose the needed prompt-level inputs, outputs, or tool traces and `bt_span_id` is present, query Braintrust through REST/BTQL as documented in `debug-customer-session`.
- **Datadog** (Cycloid telemetry is on `https://us5.datadoghq.com`): use the current local Datadog MCP tools only when they are present (for example `mcp__datadog-mcp__get_datadog_trace` and `mcp__datadog-mcp__search_datadog_logs`). In a Cycloid sandbox session, use first-party dynamic tools such as `get_datadog_trace`, `search_datadog_logs`, and `query_metrics`. Useful event cross-checks:
  - `@event:prompt.execution.completed @prompt_id:<prompt_id>`
  - `service:cycloid-control-plane @event:prompt.trace.finalized @prompt_id:<prompt_id>`
  - `service:cycloid-control-plane @event:trace_queue_export_failed`

If Braintrust or Datadog data is unavailable, determine whether that is expected from the session's observability readiness (local/test sessions often have tracing disabled). Do not count missing telemetry as a pass unless the PR behavior can be proven through another authoritative source such as the session transcript, CLI replay events, or E2B runtime evidence.

## Step 5: Decide pass or fail

Pass only if all are true:

- the PR's relevant deployment completed
- a CLI-created Cycloid session exercised the behavior
- observability data ties the session and prompt to evidence of the behavior
- no logs, spans, or session events contradict the expected outcome

Fail if deployment failed, the CLI session could not run, the behavior did not appear, or required telemetry was unexpectedly missing.

## Report format

Report:

- PR and deployed commit SHA
- deployment status, workflow/check name, and timestamp
- CLI command used, session ID, and UI URL
- observability queries run (Datadog, Braintrust, D1/transcript)
- evidence found, with IDs such as prompt ID, `bt_span_id`, and `dd_trace_id`
- pass/fail conclusion
- discrepancies or follow-up work needed
- `Skill gaps`: friction events and proposed fixes per the Skill Feedback Loop section; omit when there was none

Do not stop after starting the session. The goal is deployed end-to-end verification backed by observability evidence.

See [the shared Skill Feedback Loop guidance](docs/skill-shared.md#skill-feedback-loop).
