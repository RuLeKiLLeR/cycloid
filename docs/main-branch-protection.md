# Main branch protection

GitHub repository ruleset `Protect main` (`13912458`) protects `refs/heads/main`.
It is managed in GitHub, not Terraform.
Any edit must use a read-modify-write `gh api` flow that preserves the full ruleset body.

## Current required checks

As of July 8, 2026, the required status checks are:

- `build`, pinned to GitHub Actions app id `15368`.
- `lint`, pinned to GitHub Actions app id `15368`.
- `check`, pinned to GitHub Actions app id `15368`.
- `test`, name-only.
- `workerd`, pinned to GitHub Actions app id `15368`.

The ruleset also contains `deletion` and `non_fast_forward` rules.
Those rules protect `main` from deletion and force-push and must survive every update.

`strict_required_status_checks_policy` is currently `false`.
Do not enable strict mode as part of routine required-check edits; Graphite stacks make strict mode expensive, and merge-skew control should be evaluated separately.

The ruleset currently leaves the `OrganizationAdmin` bypass actor in `always` mode as break-glass.
Do not change bypass behavior as part of a check-list update unless the task explicitly targets bypass policy.

## Update procedure

Preflight auth and admin access:

```bash
gh auth status
gh api repos/trycycloid/cycloid --jq '{viewer_permission:.permissions}'
```

Read the current ruleset and keep the file as the rollback snapshot:

```bash
gh api repos/trycycloid/cycloid/rulesets/13912458 \
  > /tmp/cycloid-protect-main-ruleset-before.json
```

Build the update payload from the fetched JSON.
Preserve `name`, `target`, `enforcement`, `conditions`, `rules`, and `bypass_actors`.
Strip read-only fields such as `id`, `node_id`, `_links`, `created_at`, `updated_at`, `source`, and `source_type`.
Mutate only `rules[].parameters.required_status_checks` for the `required_status_checks` rule.

For the July 8, 2026 `workerd` promotion, the mutating call was:

```bash
gh api --method PUT repos/trycycloid/cycloid/rulesets/13912458 \
  --input /tmp/cycloid-protect-main-ruleset-payload.json
```

Before running the `PUT`, print the payload diff against the rollback snapshot and confirm that the only semantic change is the intended required-check list edit.

## Verification

After any ruleset update, re-read the ruleset:

```bash
gh api repos/trycycloid/cycloid/rulesets/13912458
```

Verify all of these invariants:

- The intended required check is present with the expected `integration_id`.
- `strict_required_status_checks_policy` is unchanged unless strict mode was explicitly in scope.
- `deletion` and `non_fast_forward` are still present.
- `conditions.ref_name.include` is still `["refs/heads/main"]`.
- `bypass_actors` is unchanged unless bypass policy was explicitly in scope.

If the update is wrong, use the rollback snapshot to reconstruct the previous writable payload and immediately `PUT` it back with the same endpoint.
