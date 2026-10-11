# Agent Local Verification Quickstart

## Choose

- Static/unit/docs only: do not start the app.
- Browser/API check: `npm run dev:full`.
- Real Cycloid session: `npm run dogfood:e2e`.

## Real Session

Before starting a sandbox verification session for this repo, confirm the shell that starts the dogfood runtime has `DOGFOOD_GITHUB_TOKEN` for the dogfood GitHub user. Workstation local dev should use `GITHUB_USER_TOKEN` or local `gh auth` instead; `DOGFOOD_GITHUB_TOKEN` is for verification sessions where this repo runs inside a Cycloid sandbox.

```bash
npm run dogfood:e2e
```

Wait for:

```text
dogfood ready
```

Use the printed `UI`, `API`, `CONTROL_PLANE_URL`, `AUTH_STATE`, and `REPOS`.
Preflight has already checked the exact E2B template for the default repo.

## Sandbox Runtime

```bash
cycloid-app start
cycloid-app auth
cycloid-app run <verification command>
```

`cycloid-app` should wait for the dogfood-ready stack and provide browser auth state.

## Stop Rule

If preflight fails, stop and report the failed checklist.

Do not manually edit D1, hand-build `.dev.vars`, restart ngrok repeatedly, or guess E2B credentials.
