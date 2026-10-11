# Testing

Core obligations live in [docs/conventions.md](conventions.md). Use this doc to choose the right suite, run commands, or mirror existing test helpers.

## Pick the right suite

| Change type                                      | Primary suite                                                                                                                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New route, auth change, webhook flow             | `tests/smoke/` plus route-specific worker tests                                                                                                                              |
| DAO or service logic                             | `tests/test_cloudflare/`                                                                                                                                                     |
| Bridge logic, protection rules, token/cost logic | `tests/test_agent/` or `tests/test_sandbox-bridge/`                                                                                                                          |
| UI rendering helpers or API response shaping     | `tests/test_ui/`                                                                                                                                                             |
| Shared source-of-truth modules                   | `tests/test_agent/shared-types.test.ts` or the matching shared test                                                                                                          |
| Model support/capability changes                 | `tests/test_cloudflare/model-coverage.test.ts`, `tests/test_cloudflare/model-reasoning.test.ts`, and focused bridge/config tests when agent options depend on the capability |
| Cross-module side effects                        | an integration or smoke test, not only unit tests                                                                                                                            |
| CI workflow structure or guard tests             | `tests/test_agent/` (e.g., `*-workflow.test.ts`)                                                                                                                             |

## E2E means a Cycloid session

If the user asks to test or verify e2e/end-to-end, run an actual Cycloid session through the path under test. Unit, integration, smoke, and `npm run test:e2e` runs are supplemental only.

Report the session ID/URL, prompt or action, environment/code version, outcome, and any blocker that prevented a real session.

Default to local dev for that session when local can exercise the behavior under test. Do not escalate to QA just because the change is high blast radius. Use QA only when the behavior depends on deployed Cloudflare semantics, stable HTTPS callbacks, browser OAuth, webhooks, or a teammate-shareable deployed repro.

This file is the canonical source of truth for choosing a test environment. Use [docs/qa-environment.md](qa-environment.md) for QA-specific deploy, usage, and debugging once QA is the chosen environment.

Use prod canary only when neither local dev nor QA can provide the signal: migrations that need real row counts, auth router changes, E2B provider-pressure changes that only show up under production load, or UI runtime changes that need real browser diversity. For prod rollout and production operations, see [docs/production.md](production.md).

Manual E2E test plans in PRs must be literal scripts: setup commands, numbered steps, exact prompts or inputs, wait cues, and explicit expected results.

For sandbox-bridge protocol-adaptation changes, also refresh or validate the pinned Codex protocol fixtures in `tests/test_sandbox-bridge/fixtures/codex-protocol/<CODEX_CLI_VERSION>/` and keep the event-translation guardrail suites green: `tests/test_sandbox-bridge/codex-stdio.test.ts` (raw-fallback classification), `event-translator-golden.test.ts`, `event-emission-order.test.ts`, and the focused `event-translator.test.ts`. For claude_code changes the equivalents are `tests/test_sandbox-bridge/fixtures/claude-protocol/<version>/` with `claude-event-translator-golden.test.ts`, `claude-session.test.ts`, `claude-tool-safety.test.ts`, and `claude-rollout.test.ts`.

For prompt-assembly changes (system context, behavioral guidance, or injected instruction layers), also run the prompt golden suite (`tests/test_sandbox-bridge/prompt-golden/`) and regenerate with `UPDATE_PROMPT_GOLDENS=1 npx vitest run tests/test_sandbox-bridge/prompt-golden` when the change is intentional. The suite pins assembled system context text to committed `.golden.txt` files so prompt-affecting diffs surface as reviewable CI output.

### Verifying app runtime onboarding

Confirm `.cycloid.json` has a Docker profile and `appRuntime.entry.service` matches a Compose service key. Verify the session records the profile source and injects the preview contract. Browser/runtime evidence is user-directed for non-UI changes; UI-touching diffs prefer static screenshots when they are strong evidence of the changed visible state, and the QA loop must accept targeted tests, browser automation, runtime logs, or requested WebM walkthroughs when a screenshot would not prove the behavior. Missing or invalid runtime config must fail closed with diagnostics.

For repeated E2E validation of high-risk session changes, keep local dev as the default when it exercises the code path. Use QA only when local evidence is weak because behavior depends on deployed infrastructure or callback stability:

```bash
ARCANIST_TOKEN=<local token> npm run verify:e2b-session -- \
  --base-url http://localhost:<api-port> \
  --repo-owner <owner> \
  --repo-name <repo>
```

When QA is actually required, see [docs/qa-environment.md](qa-environment.md) for setup and failure attribution.

### QA PR smoke test

For local E2B prerequisites, template builds, and smoke commands, see [docs/e2b-local-setup.md](e2b-local-setup.md).

After deploying sandbox or bridge changes to QA, verify the session can complete a small repo edit and open a PR:

```bash
npm run verify:e2b-session -- \
  --base-url https://qa.app.trycycloid.com \
  --repo-owner <owner> \
  --repo-name <repo>
```

The script creates a session, sends a README checkpoint prompt, waits for the prompt to complete, and passes only when the session exposes a GitHub PR URL. It uses normal CLI-token-accessible APIs and does not inspect sandbox internals.

Production PR smoke tests are automated by `.github/workflows/prod-e2b-verifier.yml` after successful control-plane deploys. The workflow uses the `ARCANIST_PROD_VERIFIER_TOKEN` GitHub secret, uploads `artifacts/prod-pr-smoke-*.json`, and posts pass/fail to Slack via `SLACK_WEBHOOK_URL`. For ad-hoc production verification, see [docs/prod-pr-creation-smoke.md](prod-pr-creation-smoke.md).

When the change affects sandbox-image contents, sandbox bridge code, bundled MCP apps, or shared code that runs inside the sandbox, rebuild the E2B template locally before merge and verify the template registers successfully:

```bash
bash scripts/e2b-template-build.sh --tag "<your-tag>" --include-repo-spec-templates
```

Always include `--include-repo-spec-templates`; `trycycloid/cycloid` requires a resource-spec alias (`-mem8192-cpu4`) that the single-template build omits, and a missing alias causes late sandbox spawn failures. (`--tag` builds that exact name verbatim; resource-mode builds like `--prod`/`--qa`/`--dev` append the `-mem<MB>-cpu<N>` suffix the worker resolves to.)

For a three-repo performance baseline, run:

```bash
npm run baseline:e2b -- \
  --repo small=<owner/repo> \
  --repo medium=<owner/repo> \
  --repo large=<owner/repo>
```

### Runtime Onboarding Smoke Tests

The runtime onboarding API starts a normal repo session with a validated preview-contract override. Treat the returned session URL, runtime provenance, and injected preview contract as the smoke-test evidence trail.

### Verifying Slack-originated sessions

For Slack install state, `team_id` token routing, scope split, and magic-link security checks, use [docs/slack.md](slack.md).
For default channel choice, environment mapping, and when agents should stop asking which test channel to use, follow [docs/slack-testing.md](slack-testing.md).
If the requested QA test needs one synthetic internal Slack message to exercise production or QA behavior, send the smallest qualifying message in the documented default internal channel without asking first. Stop only if the action would be destructive, customer-visible, Slack Connect/shared-space visible, or blocked by missing access.

Use the Slack app that matches the environment:

- production: `@Cycloid`
- local dev: `@Cycloid (DEV)`
- QA: `@Cycloid`

## Common commands

```bash
# Run all tests
npm test

# Run changed lint, affected tests, and affected typechecks before finishing a diff that touches asserted values; `--changed` reruns tests importing changed modules
npm run verify:changed

# Run the full local check suite when the changed-path heuristic is too narrow
npm run verify:all

# Run one file
npx vitest run tests/test_cloudflare/settings-db.test.ts

# Run tests by name
npx vitest run -t "failed edit"

# Verbose vitest output
npx vitest run --reporter=verbose

# Browser dependencies for Playwright
npx playwright install chromium

# Browser smoke suite
npm run test:e2e

# Unauthenticated public-exposure regression checks
npm run test:unauth-exposure

# Build the local E2B sandbox template tag
npm run build:e2b-template -- --dev

# Build a QA E2B sandbox template tag for the checked-out commit
bash scripts/e2b-template-build.sh --qa

# Point the HTTP checks at a local Vite dev server
npm run security:unauth-exposure -- --dist dist/ui --base-url http://localhost:5181 --skip-root-headers
```

Vitest loads `tests/setup/vitest-network-guard.ts` for repo tests. Non-local outbound HTTP is blocked by default, including swallowed failures. If a test needs provider behavior, stub the exact request in the suite or a shared helper.

## Unauthenticated exposure checks

`npm run test:unauth-exposure` builds the UI, inspects the built public assets, and runs the focused worker route tests in `tests/test_cloudflare/unauthenticated-exposure.test.ts`.

Use `npm run security:unauth-exposure -- --dist dist/ui --base-url <url>` for a low-volume HTTP smoke check against a local preview, staging URL, or production-equivalent deploy. It verifies unauthenticated API route boundaries, public bridge/artifact fail-closed behavior for random session IDs, and root security headers. For a Vite-only local dev server instead of the Pages worker, pass `--skip-root-headers` because Vite does not apply the production worker header policy.

`npm run verify:ui` runs the asset inspection with `--strict-assets`, which rejects public source maps, logged-out modulepreloads, representative sensitive strings, provider token prefixes, and unallowlisted `VITE_*` source keys.
Add `--strict-api-metadata` for `/api/version` commit/environment checks, `--strict-metadata-routes` for `robots.txt` and `security.txt` SPA-fallback checks, and `--require-csp` once the CSP rollout is complete.

## High-value test rules

- Prove risky assumptions with the fastest local or disposable verifier before depending on a production deploy.
- Lint before pushing. The pre-push hook lints changed TypeScript files; fix the errors instead of bypassing the hook.
- No live network in automated tests. Only loopback/local addresses are allowed by default; third-party APIs, Slack, OpenAI, Linear, GitHub, and production app URLs must be mocked or stubbed.
- For each new or changed function, endpoint, parser, or shared helper, enumerate reachable code paths before writing tests and cover them by default: success, missing or empty input/config, invalid formats, fallback choices, auth/access denials, and each distinct error or return shape.
- Branching routes need one test per status/behavior branch.
- Pure parsing or transformation logic should get focused unit tests close to the matching suite.
- If a wiring regression would be invisible because each side is mocked in the other's tests, add an integration or smoke test.
- Do not write mock-only tests that prove only that your mock was called.
- When adding retry logic, cover both the retry-succeeds path and the retries-exhausted path as separate tests.
- UI runtime testing is recommended for changes that touch UI rendering logic, `apps/ui/src/api/`, or data types consumed by the UI. Run the dev server, exercise the affected page with realistic data, and check the browser console.
- Filesystem-scanning / aggregate tests (e.g. `tests/test_scripts/frontend-audit.test.ts`) have no import edge to the files they scan, so `vitest --changed` never selects them. Force-run them via an in-job change detector in the workflow that already triggers on the scanned paths (the audit runs in `frontend-build.yml` under `ui_changed`), not via workflow-level `paths:` on a required check (a `paths`-filtered required workflow can leave its status pending on unrelated PRs). The change detector must also match the test and the scanner's own files so a self-edit is gated.

## Existing helpers and patterns

### D1 and worker fakes

Use `FakeD1` and `createWorkerEnv()` from `tests/smoke/helpers.ts` for D1-backed tests. Prefer the existing fake over inventing local mocks unless the test only needs a tiny surface.

### Webhook fixtures

GitHub webhook tests share HMAC signing and request helpers in `tests/test_cloudflare/github-webhook-fixtures.ts`. Reuse them instead of duplicating signature logic.

### Module-scoped state

If a module-scoped cache, limiter, or registry is exercised by tests, it needs a reset path and the tests should call it in `beforeEach`.

### Cloudflare-worker imports

Tests that import worker code should mock Cloudflare-specific modules at the top of the file before importing the source module.

## Suite lookup

| Suite                        | What it guards                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `tests/smoke/`               | End-to-end worker request/response flows with in-memory fakes                     |
| `tests/test_cloudflare/`     | Worker units: routes, services, session logic, DAOs                               |
| `tests/test_agent/`          | Agent config, protection rules, token accounting, diagnostics, CI workflow guards |
| `tests/test_sandbox-bridge/` | Bridge event loop, prompt loop, PR orchestration, QA testing                      |
| `tests/test_sandbox-e2b/`    | E2B start-bridge script and template Dockerfile behavior                          |
| `tests/test_workerd/`        | Runtime-semantics smoke tests under workerd: DO SQLite, D1, and queue dispatch    |
| `tests/test_ui/`             | UI helpers, components, browser smoke coverage                                    |
| `tests/test_shared/`         | Shared module contracts                                                           |
| `tests/test_cli/`            | CLI command surface and auth flows                                                |
| `tests/test_scripts/`        | Dev scripts and tooling (TS tests + Python helpers)                               |
