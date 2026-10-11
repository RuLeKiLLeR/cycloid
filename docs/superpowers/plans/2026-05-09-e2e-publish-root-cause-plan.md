# E2E Publish Evidence and Draft UI Repair Plan

## Findings

- Documenso, Plane, and Directus completed the reproduction or code work, but PR body generation lost issue, session, command, and before/after evidence.
- Karakeep completed scoped verification, but a broad resource-killed typecheck blocked PR creation entirely.
- Recent PRs fixed isolated symptoms, but the shared root cause remained: publish, retry, polish, quality gates, and UI state were not driven by one durable evidence bundle.

## Plan

1. Build deterministic PR readiness evidence before LLM polish from the original prompt, final summary, command log, artifacts, session URL, issue URL, and changed files.
2. Preserve exact redacted command strings and classify common app-runtime command shapes such as `docker exec`, `docker compose exec`, `/app/scripts/cycloid-app run`, `pnpm --filter`, `pytest`, `biome`, and `prettier`.
3. Add `ExecutionVerification.publishMode` with `normal` and `draft`, plus `manualReviewReason` for draft/manual-review publication.
4. Treat missing evidence or quality-gate failures as draft/manual-review signals; resource-killed broad checks after scoped verification also create draft/manual-review PRs.
5. Preserve evidence sections across fallback body generation, PR polish, and publish retry paths.
6. Thread draft/manual-review metadata through PR creation, durable PR events, session view models, websocket snapshots, and UI state.
7. Render draft/manual-review PRs with a distinct `View Draft` CTA, a compact `manual review` badge, and the short review reason.

## Verification

- Focused sandbox-bridge readiness, diagnostics, runtime evidence, and PR body tests.
- Focused control-plane GitHub PR, PR body preservation, PR workflow, and session view tests.
- Focused UI session state, durable-event dispatch, subscription, and session detail action tests.
- `npx tsc --noEmit`.
- QA verification with real Cycloid sessions is required before production rollout because this touches bridge, control-plane, and UI publish behavior.
