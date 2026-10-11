# Prod PR smoke test

Manual or scripted e2e check that production Cycloid can create a session, complete a small repo edit, push it, and
produce a PR URL. This smoke is about PR creation, not E2B diagnostics.

## Run

```bash
ARCANIST_TOKEN=<prod token> npm run smoke:prod:pr-creation -- \
  --runs 3 \
  --summary-out tmp/prod-pr-smoke.md \
  --json-out tmp/prod-pr-smoke.json
```

Claude verification v2 smoke, manual/ad-hoc only:

```bash
ARCANIST_TOKEN=<prod verifier token> npm run smoke:prod:claude-verify -- \
  --summary-out tmp/prod-claude-verify-smoke.md \
  --json-out tmp/prod-claude-verify-smoke.json
```

Precondition: the verifier token's business/user must have an Anthropic BYOK key provisioned. Production
`claude_code` fails closed without a user or business Anthropic key, so a missing key is a credential failure, not a
verification signal.

Defaults:

- API: `https://app.trycycloid.com`
- Repo: `https://github.com/jeman-verification/verification-prod`
- Polling: every 30s for up to 25 min per session
- Cleanup: prod control plane closes PRs for sessions titled `Prod PR smoke test ...` on this repo after PR creation

## Pass Criteria

Per run:

- session is created in prod
- prompt completes far enough for post-exec publish
- `/api/sessions/:id/view` returns a non-empty `prUrl`
- the prod control plane closes the created smoke PR

For `smoke:prod:claude-verify`, `/api/sessions/:id/view` must also return a non-empty `verificationResult`.

If a run fails, use the session URL from the summary, then inspect session events, Datadog, GitHub, or E2B only as
targeted debugging.
