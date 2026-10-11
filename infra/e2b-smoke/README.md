# E2B Smoke Terraform

Cycloid owns the smoke-stack rollout inputs here, while the Terraform source
stays pinned to an E2B infra commit via `source.json`.

Use `cycloid-lean.tfvars` with the existing E2B AWS Terraform state. Do not
copy the full E2B infra repository into Cycloid unless we need source changes
that cannot be expressed as variables.

Files:

- `source.json` pins the E2B infra repository and provider AWS path. Prefer
  upstream E2B commits; use the org-owned `trycycloid/infra` fork only for
  minimal patches that upstream does not expose yet.
- `target.json` names the Cycloid smoke target, AWS account, region, backend
  config, var file, and default plan file.
- `backend.hcl` contains only the Terraform backend config for the existing E2B
  smoke state.
- `cycloid-lean.tfvars` contains only Cycloid's E2B smoke sizing and runtime
  overrides.

Current target:

- AWS account `666177270058`
- region `us-east-1`
- domain `cycloid-e2b-dev.com`
- prefix `arc-e2b-smoke-`
- state bucket `666177270058-terraform-state`
- state key `terraform/orchestration/state`

Use the wrapper so upstream E2B `Makefile` changes do not affect the Cycloid
rollout flow:

```bash
npm run smoke:e2b:terraform -- fetch
npm run smoke:e2b:terraform -- status
npm run smoke:e2b:terraform -- init
npm run smoke:e2b:terraform -- plan
npm run smoke:e2b:terraform -- show
npm run smoke:e2b:terraform -- apply
```

## Teardown

Use Terraform destroy when retiring the smoke stack. This removes the billable
AWS resources managed by the E2B provider state for the target above, including
EC2/autoscaling groups, NAT gateway, ALB, VPC endpoints, ECR repositories, S3
buckets, Secrets Manager secrets, ACM certificate, and DNS records.

```bash
npm run smoke:e2b:terraform -- fetch
npm run smoke:e2b:terraform -- status
npm run smoke:e2b:terraform -- init
npm run smoke:e2b:terraform -- destroy-plan --plan-file /tmp/e2b-smoke-destroy.tfplan
npm run smoke:e2b:terraform -- show --plan-file /tmp/e2b-smoke-destroy.tfplan
npm run smoke:e2b:terraform -- destroy --plan-file /tmp/e2b-smoke-destroy.tfplan
```

Before `destroy`, review `show` and confirm:

- expected account/backend are `666177270058` and
  `666177270058-terraform-state`
- every destroyed AWS resource uses the `arc-e2b-smoke-` prefix, the
  `cycloid-e2b-dev.com` domain, or the smoke backend target
- the plan does not touch the root Cycloid `cycloid-infra` Terraform Cloud
  workspace
- S3 bucket object deletion is expected; `destroy-plan` passes
  `-var=allow_force_destroy=true` without storing that setting in the shared
  tfvars file

By default, `fetch` materializes the pinned E2B checkout at
`infra/e2b-smoke/.source`, which is gitignored. Set `E2B_INFRA_DIR` or pass
`--source-dir` only when reusing an existing checkout.

If Terraform's S3 backend reports `NoCredentialProviders` even though
`aws sts get-caller-identity` works, export concrete credentials from the
working profile before running `init`:

```bash
eval "$(aws configure export-credentials --profile "${AWS_PROFILE:-default}" --format env)"
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1

aws sts get-caller-identity
```

The account must be `666177270058`.

Before `apply`, review `show` and confirm:

- no destroy or replace actions
- target resources use the `arc-e2b-smoke-` prefix
- expected account/backend are `666177270058` and
  `666177270058-terraform-state`
- changes are limited to expected E2B smoke sizing/runtime updates
- no unexpected VPC, DB, bucket, certificate, domain, or template recreation

To update E2B infra, check out the new commit, update `source.json`, run
`status`, then review a fresh `plan` before applying. Use
`--allow-ref-mismatch` only for temporary inspection before updating the pin.
