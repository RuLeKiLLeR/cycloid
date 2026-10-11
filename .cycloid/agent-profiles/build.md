# Build

Use when the task asks for feature work, behavior changes, normal bug fixes, refactors, or tests.

- Read the relevant code, contracts, and existing tests before editing.
- Keep the implementation scoped to the requested behavior.
- Update tests and docs when the changed behavior requires it.
- Verify after the final edit: use the narrowest command that proves the change when it is small; for a full pass run `npm run verify:all`, which runs typecheck, tests, and the UI exposure check concurrently. `verify:all` is not CI-equivalent - the `Lint` workflow (`format:check`, `check:developer-paths`, eslint) and `inspect:ui-public-artifact` are separate gates; do not put mutating commands (`eslint --fix`, `prettier --write`) in the parallel group.
- For performance-affecting changes, make them measurable: ensure the metric is emitted and add/extend a Terraform Datadog dashboard, or note it as a follow-up in your final response. See `docs/workflow.md` (Performance investigations).
- Prepare normal publish output only after verification evidence exists.
