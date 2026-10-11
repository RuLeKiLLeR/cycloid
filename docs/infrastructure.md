# Infrastructure

Terraform config lives in `infra/` and is applied by Terraform Cloud. Do not run `terraform apply` locally for production changes.

## Required commands before pushing Terraform edits

```bash
terraform -chdir=<root> fmt -recursive
terraform -chdir=<root> fmt -check -recursive
terraform -chdir=<root> validate -no-color
```

When Terraform Cloud credentials are available to a Cycloid session, live verification must use the first-party `terraform.plan` tool, which runs `terraform plan -no-color -input=false` from the bridge without exposing credentials to the agent shell. Do not run `terraform apply` locally for production infra; Terraform Cloud applies after merge.

## Source-of-truth rules

- Terraform-managed SSM entries for secrets and runtime values.
- Wrangler `[vars]` for public static worker config.
- GitHub ruleset `Protect main` is GitHub-managed; see [main-branch-protection.md](main-branch-protection.md) before editing main branch rules or required checks.
- Never store the same production value in both places.
- Terraform manages SSM parameter names and the Terraform-sourced values such as Turnstile keys.
- Most secret values under `aws_ssm_parameter.env` intentionally ignore live value drift; rotate those values out-of-band, then redeploy or sync dependent Worker secrets as documented in [security.md](security.md#secret-rotation).
- If one change adds infra and another deploy workflow depends on it, split into separate PRs: merge infra first, wait for Terraform Cloud to apply, then merge the dependent deploy change.

## Datadog monitor and metric modules

Log-derived metrics: `infra/datadog-log-metrics.tf` via `infra/modules/datadog-log-metric`. Metric and log alert monitors: `infra/datadog-monitors.tf` via `infra/modules/datadog-monitor`.

- Terraform owns all Datadog monitors, metrics, dashboards, and SLOs. Edit `infra/*.tf`, never the Datadog UI/API/MCP; out-of-band edits drift and revert on the next apply.
- Keep dashboard resources in their domain files, e.g. `infra/datadog-observability.tf` and `infra/datadog-agent-behavior.tf`.
- Add/update alert monitors through the `metric_alerts` or `log_alerts` maps; keep resource keys stable (Terraform `moved` blocks depend on them).
- For event-counter metrics that may have zero data points at monitor creation time (e.g., new metrics for rare events), set `validate = false` to skip Datadog's create-time query validation. Default is `true`.
- Add/update log-derived metrics through the `metrics` map, with `group_by` entries only for tags Datadog should index.
- Any duration/latency metric must declare its time unit via a `datadog_metric_metadata` resource (`unit = "millisecond"`, `"second"`, etc.) so Datadog auto-scales it to readable durations (e.g. `898000` ms renders as `~15 min`, not `898k`). Set the unit on the metric, not by hand-typing `(ms)` into widget titles or axis labels; widgets inherit the scaled unit. The emitted attribute name should keep its unit suffix (`@duration_ms`). Same rule for other dimensioned metrics: declare `unit` (`byte`, `request`, etc.) rather than abbreviating in labels.
- When moving an existing root Datadog resource into a module, add a Terraform `moved` block so the plan reports a state move instead of destroy/create.
- Every monitor must be actionable. When investigating one, if it is not (no clear response, noisy, duplicates another signal, or nobody acts on it), the finding is to recommend removing or tightening it (threshold, window, grouping, query), not just report the metric value.
- Critical monitors that require phone paging include `{{#is_alert}}${var.datadog_pager_handle}{{/is_alert}}` and `{{#is_recovery}}${var.datadog_pager_handle}{{/is_recovery}}` in the message so PagerDuty pages on alert/recovery while warnings stay Slack-only. Lower-severity monitors use `${var.datadog_slack_handle}` alone.

## Imports and identifiers

- For existing AWS resources, prefer declarative `import` blocks over manual `terraform import`.
- Read the actual `infra/*.tf` files and provider docs before referencing resources or attributes; do not guess names or IDs.

## Troubleshooting

- Terraform plan output is posted on the PR; read PR comments before guessing at a failure.
- Changes spanning infra plus a dependent deploy workflow follow the sequencing rule above.
- Validate Datadog dashboard query edits in the Datadog query editor before merge.

## Cloudflare control plane

The control-plane Worker is deployed with Wrangler, not Terraform. Webhook route behavior lives in worker code; provider dashboard URLs live with the provider, not in Terraform.

Production cold-start mitigation for browser traffic is owned in worker code: the 5-minute Cloudflare cron self-fetches `/api/health/warm` through `CONTROL_PLANE_URL` (falling back to `FRONTEND_URL`) using an automation bearer token, warming the public `fetch` path and touching D1/KV before the next interactive request. Retention-only GC pruners run on a separate hourly control-plane cron.

## Control-plane worker environment

Lifecycle FSM mode is no longer a wrangler flag.
The FSM is unconditionally live; reversal is `git revert` plus a forward migration, not a config change.
See [docs/fsm.md](fsm.md).
