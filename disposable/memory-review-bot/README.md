# Disposable Memory Review Bot Tools

Disposable code used to evaluate and iterate on memory review bot behavior. Not part of the production code path; can be deleted, rewritten, or replaced when the evaluation approach changes.

Production code must never import, call, schedule, bundle, or otherwise depend on anything in this directory. Dependencies only flow the other way: disposable tooling may query production-shaped data or import production memory review bot code when a local harness needs to evaluate the real implementation.

Nothing outside `disposable/memory-review-bot` imports code from this directory. Production memory review bot code remains under `apps/control-plane-worker/src/memory-review-bot`, and fixture data remains under `docs/memory-new/review-bot-fixtures/tuning`.

## How It Works

- `cohorts.ts` builds aggregate generated-memory review reports for a scoped business or repo. Reads generated memories, recall telemetry, and review bot item rows to compute recall, usefulness, false-positive, root-cause, lifecycle, and coverage metrics.
- `report-memory-review-cohorts.ts` is a manual CLI for running the cohort report against a D1 database through the Cloudflare API.
- `memory-review-bot-cohorts.test.ts` verifies the disposable cohort reporting logic against an in-memory SQLite D1 shim.
- `eval-schema.ts` defines the fixture and reviewer I/O schema used by the model-evaluation harness.
- `eval-loader.ts` loads and validates the tuning fixtures from `docs/memory-new/review-bot-fixtures/tuning`, then maps expected labels into reviewer-shaped output.
- `eval-runner.ts` adapts fixtures into either the oracle baseline reviewer or the production reviewer. The production adapter is the only place this harness reaches into the real memory review bot implementation.
- `eval-scorers.ts` contains the scoring rules comparing reviewer output against fixture expectations.
- `evaluate-memory-review-bot.ts` is the local CLI wrapper for printing tuning and verify reports from the disposable harness.
- `memory-review-bot-evals.test.ts` wires the model-evaluation pieces together in Vitest so the harness can still be run manually.
- `vitest.config.ts` keeps disposable tests out of the repo's normal test discovery while allowing explicit local runs.

To run all disposable tests directly:

```sh
npx vitest run --config disposable/memory-review-bot/vitest.config.ts
```

To print a cohort report manually:

```sh
npx tsx disposable/memory-review-bot/report-memory-review-cohorts.ts --business-id <business-id>
```
