---
name: alert-triage
description: Triage a Datadog monitor/alert URL, Sentry issue/alert URL, raw Datadog monitor id, or raw Sentry issue id. Use when asked whether an alert is actionable, when a Datadog or Sentry alert link is pasted, or when the alert should be tuned or deleted.
user_invocable: true
argument: required -- a Datadog monitor/alert URL, a Sentry issue/alert URL, or a raw monitor/issue id
---

# Alert Triage

Produce one evidence-backed verdict for exactly one alert:

- `ACTIONABLE`: an engineer must act on a real system problem.
- `NOT ACTIONABLE`: the alert is noise, so the alert must be tuned or deleted.

Stay read-only while investigating.
The only writes this skill may perform are a Datadog Terraform PR through Graphite after a `NOT ACTIONABLE` verdict, or a Sentry `update_issue` mutation after explicit per-invocation confirmation.

## Input

Read `$ARGUMENTS`.
Accept exactly one of:

- Datadog monitor or alert URL, including `https://us5.datadoghq.com/monitors/<id>` and links with `from_ts`, `to_ts`, or `event_ts`.
- Raw Datadog monitor id.
- Sentry issue or alert URL with org/project/issue context.
- Raw Sentry issue id when the current org/project is clear from the conversation.

Detect Datadog from a Datadog host or a numeric monitor id.
Detect Sentry from a Sentry host, issue path, or issue id.
If the source, org/project, or id is ambiguous, or if several ids are present, ask for clarification instead of guessing.

For Datadog, extract `monitors/<id>` plus `from_ts`, `to_ts`, and `event_ts` when present.
Use the link window as the investigation window.
If no window is present, use the alert event time when available; otherwise default to the last hour.

## Tool Preflight

Fail closed if the required telemetry integration is unavailable.

For Datadog, confirm these local MCP tools are present before investigating:

- `mcp__datadog-mcp__search_datadog_monitors`
- `mcp__datadog-mcp__analyze_datadog_logs`
- `mcp__datadog-mcp__search_datadog_logs`
- `mcp__datadog-mcp__search_datadog_events`
- `mcp__datadog-mcp__get_datadog_trace`
- `mcp__datadog-mcp__load_datadog_skill`
- `mcp__datadog-mcp__list_datadog_skills`

For Sentry, confirm these local MCP tools are present before investigating:

- `mcp__sentry__search_issues`
- `mcp__sentry__get_sentry_resource`
- `mcp__sentry__analyze_issue_with_seer`
- `mcp__sentry__search_events`

These tool names are for local Claude Code and Codex MCP runtimes.
Inside a Cycloid sandbox session, Datadog is exposed through bridge dynamic tools with different names: `get_monitors`, `search_datadog_logs`, `get_datadog_trace`, and `query_metrics`.
Use the available equivalent tools there, and still fail closed if the needed source cannot be queried.

## Datadog Investigation

Load the relevant Datadog domain skill first with `load_datadog_skill`.
Fetch the monitor by id with `search_datadog_monitors` and capture its name, query, message, state, thresholds, tags, and group-by dimensions.

Reconstruct the alert window from the link or event.
Run the monitor's own query over that window, broken down by the dimensions that explain the trigger.
For log monitors, use `analyze_datadog_logs` grouped by route, status, service, host, and any monitor-specific grouping that appears in the query.
Pull raw logs, traces, and deploy events only as needed to settle root cause.

Do not edit Datadog through the UI, API, or MCP.
Datadog monitor changes are Terraform-only in `infra/*.tf`.
Use `https://us5.datadoghq.com` for Cycloid telemetry.

## Sentry Investigation

Use `get_sentry_resource` or `search_issues` to fetch the issue identity, status, assignee, frequency, first seen, last seen, affected users, release correlation, and stacktrace.
Use `search_events` for representative events and release/user breakdowns.
Use `analyze_issue_with_seer` when it can cheaply clarify root cause.

Do not resolve, ignore, assign, or mutate Sentry by default.
`update_issue` is a live mutation and requires explicit confirmation for the specific invocation.

## Verdict Rubric

`ACTIONABLE` means a real system problem within engineer control needs a human action now:

- Code fix.
- Rollback or forward deploy.
- Capacity, quota, or dependency response.
- Security response.
- Genuine new regression that needs investigation.

`NOT ACTIONABLE` means the alert itself is wrong for the observed behavior:

- Expected or benign traffic, including client reconnect storms and expected 401s.
- User input errors or other normal customer behavior.
- Third-party flap where our system is handling failure correctly.
- Duplicate of another better alert.
- Threshold or window too tight for normal variance.
- Informational-only signal that nobody acts on.
- Stale alert for a removed feature or dead path.

For every `NOT ACTIONABLE` verdict, classify the follow-through:

- `TUNE`: adjust query, threshold, grouping, exclusion, or window.
- `DELETE`: remove the monitor or rule because it no longer earns its keep.

Prefer `TUNE` unless evidence shows the monitor is stale, duplicative, or permanently unowned.

## Datadog Follow-Through

When Datadog is `NOT ACTIONABLE`, locate the Terraform source before editing:

1. Search `infra/*.tf` for the exact monitor `name` string.
2. Require exactly one matching HCL monitor block.
3. If there are zero or multiple matches, stop and report the lookup failure instead of editing.
4. Echo the matched Terraform map key and file in the triage output.

Draft the smallest Terraform edit that matches the verdict:

- Add a precise exclusion clause for benign traffic.
- Adjust a threshold or window when variance is normal.
- Remove the monitor only when the `DELETE` evidence is strong.

Run:

```bash
terraform -chdir=infra fmt -recursive
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra validate -no-color
```

Commit with Graphite and open a ready-for-review PR.
Do not run `terraform apply`.
Return the `github.com` PR URL.

## Sentry Follow-Through

When Sentry is `NOT ACTIONABLE`, recommend the concrete Sentry-side rule change:

- Adjust alert threshold or window.
- Ignore, resolve, mute, or fingerprint the issue.
- Delete a stale or duplicate alert rule.

Apply `update_issue` only after explicit confirmation for that invocation.
Do not open a Terraform PR for Sentry.

## Output

Start with a terse triage card:

```markdown
Alert: <source> <id> - <name or issue title>
Root cause: <evidence-backed cause>
Verdict: ACTIONABLE | NOT ACTIONABLE
Action: <engineer action> | TUNE: <reason> | DELETE: <reason>
Evidence: <queries/results/traces/deploy events that settle the verdict>
Terraform: <file and map key, Datadog not-actionable only>
PR: <github.com URL, Datadog not-actionable only>
```

Keep evidence concrete.
Name the query, grouping, trace, event, release, or source file that settles the claim.
Label anything not verified.
