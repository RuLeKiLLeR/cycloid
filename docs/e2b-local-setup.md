# E2B Local Setup

For normal local Cycloid repo sessions after the E2B cutover. Evals are separate.

Use the right start path for the environment:

- **Developer workstation:** run `bash scripts/worktree-setup.sh`, then `npm run dev:full`. This starts the local control-plane API, UI, and ngrok callback tunnel from the worktree.
- **Cycloid sandbox app runtime:** run `/app/scripts/cycloid-app start`, then `/app/scripts/cycloid-app auth` when auth is configured. This starts the repo's declared Docker app runtime inside the sandbox; it does not create the ngrok callback tunnel by itself.
- **Sandbox verification session:** use `npm run dogfood:e2e` when running from a local checkout, or ensure the shell that starts the dogfood runtime has the required environment variables below, run `cycloid-app start`, and start the ngrok/control-plane tunnel before creating child E2B sessions.
- Rebuild the E2B template to see sandbox-image, bridge, or shared-code changes inside new sandboxes; `npm run dev:full` only restarts the local control plane/UI.

## Team Structure (Read First)

E2B scopes pools and authorization **per team, not per key**: any key on a team can kill any
sandbox on that team. So each environment has its own team (templates and keys are team-scoped):

| Team                | Env       | Keys                   |
| ------------------- | --------- | ---------------------- |
| `Cycloid`           | prod      | prod control-plane key |
| `Cycloid QA`        | QA        | QA control-plane key   |
| `Cycloid local dev` | local dev | per-developer keys     |

- Use only an `Cycloid local dev` key locally; never the prod/QA key.
- `build:e2b-template --dev` builds into the team owning `E2B_API_KEY`, so it must be a local-dev key or sessions hit `missing_template`.
- Never run a local reaper/cleanup against a prod/QA key (it would delete that env's live VMs).

### Get Onto The Local-Dev Team

1. A team owner invites your `@trycycloid.com` email (E2B → `Cycloid local dev` → Members).
2. Accept, then switch the active team to `Cycloid local dev`.
3. Create a personal API key under that team; use it as `E2B_API_KEY` in `.dev.vars`.

## Required Access

- Membership on the `Cycloid local dev` E2B team with a personal `E2B_API_KEY` created under it.
- Cycloid dev secrets in `apps/control-plane-worker/.dev.vars`.
- A claimed static ngrok domain in `NGROK_DOMAIN`.
- ngrok authentication via `NGROK_AUTHTOKEN`/`NGROK_AUTH_TOKEN` or an existing ngrok config file.
- A real GitHub user token with access to the target repo. For workstation local dev, set `GITHUB_USER_TOKEN` in `apps/control-plane-worker/.dev.vars` or authenticate `gh` locally. For sandbox verification sessions, the shell that starts the dogfood runtime must have `DOGFOOD_GITHUB_TOKEN`. GitHub App installation tokens alone cannot satisfy `/user/repos`.
- The Cycloid dev GitHub App installed on the target repo with contents and pull-request write permissions.
- Provider keys for the model path you use locally, usually `OPENAI_API_KEY`, `OPENAI_API_KEY_FOR_LOCAL_DEV`, `OPENAI_API_KEY_INTERNAL_REVIEW`, or `ARCANIST_OPENAI_API_KEY`.

For a writable smoke target, use a Cycloid-owned test repo where the dev GitHub App has contents and pull-request write permissions. Do not use a repo the dev GitHub App cannot push to; session creation can pass local repo-gate while the final GitHub push fails with 403.

## One-Time Worktree Setup

From the worktree:

```bash
bash scripts/worktree-setup.sh
```

Confirm `apps/control-plane-worker/.dev.vars` has:

```bash
E2B_API_KEY=<your key>
SANDBOX_RUNTIME_CLEANUP_SECRET=<local secret>
E2B_SANDBOX_TIMEOUT_MS=3600000
E2B_RUNTIME_RETENTION_HOURS=24
E2B_RUNTIME_LIVE_LEASE_MS=900000
E2B_RUNTIME_PROVIDER_REFRESH_INTERVAL_MS=1800000
E2B_RUNTIME_PROVIDER_TTL_MS=3600000
E2B_RUNTIME_CLEANUP_BATCH_LIMIT=25
NGROK_DOMAIN=<your static ngrok domain>
NGROK_AUTHTOKEN=<your ngrok token, unless already configured>
OPENAI_API_KEY=<your key>
```

Values:

- `E2B_API_KEY`: your personal E2B API key, created under the `Cycloid local dev` team (see Team Structure). A prod/QA key here will build your template into the wrong pool.
- `SANDBOX_RUNTIME_CLEANUP_SECRET`: arbitrary local-only bearer secret used by scheduled cleanup when asking the SessionDO whether an expired E2B runtime can be killed. Not from E2B. Generate once, e.g.:

  ```bash
  openssl rand -hex 32
  ```

  Put the string in `.dev.vars`; it only needs to stay stable while your local API process runs.

- `E2B_SANDBOX_TEMPLATE`: do not set manually for normal local work. `scripts/worktree-setup.sh` and `npm run dev:full` auto-fill it as `cycloid-sandbox-dev-$USER` when missing. Keep it only to intentionally override the local template. Do not use `arc-default-template` (prod) or a QA template locally.
- `NGROK_DOMAIN`: your single claimed static ngrok domain. `scripts/dev-tunnel.sh` reads it from `.dev.vars` when the shell env is unset and writes the active URL to `CONTROL_PLANE_URL`.
- `NGROK_AUTHTOKEN` / `NGROK_AUTH_TOKEN`: authenticates ngrok. This does not pick the public URL; `NGROK_DOMAIN` does that. Both are needed in a fresh sandbox that has no preexisting ngrok config.

`scripts/worktree-setup.sh` copies `.dev.vars` from the main checkout. If the main checkout has stale E2B values, fix them in the worktree copy before running sessions.

## Sandbox Verification Environment

When this repo is started inside an E2B sandbox for verification, the shell that runs `scripts/dogfood-runtime.sh` must already have the environment variables below. Do not rely on `apps/control-plane-worker/.dev.vars` being present or current inside the sandbox.

For `trycycloid/cycloid`, full local app E2E needs:

```bash
ARCANIST_ADMIN_TOKEN=<local admin bearer token>
E2B_API_KEY=<local-dev E2B key>
DOGFOOD_GITHUB_TOKEN=<GitHub user token with repo access>
GITHUB_APP_ID=<dev GitHub App id>
GITHUB_CLIENT_ID=<dev OAuth client id>
GITHUB_CLIENT_SECRET=<dev OAuth client secret>
GITHUB_PRIVATE_KEY=<dev GitHub App private key with escaped \n>
GITHUB_WEBHOOK_SECRET=<local secret>
NGROK_AUTHTOKEN=<ngrok token>
NGROK_DOMAIN=<claimed static ngrok domain>
OPENAI_API_KEY_FOR_LOCAL_DEV=<OpenAI key>
SANDBOX_CALLBACK_SECRET=<local secret>
SANDBOX_RUNTIME_CLEANUP_SECRET=<local secret>
TOKEN_ENCRYPTION_KEY=<32-byte hex encryption key>
```

The checked-in `docker-compose.yml` passes the dogfood values into the API container, and `scripts/dogfood-runtime.sh` prefers process env over `.dev.vars`. That startup shell is the sandbox path for admin auth, E2B, GitHub App config, GitHub user OAuth repo access, ngrok config, OpenAI local-dev model access, token encryption, and sandbox callback/cleanup secrets.

Sandbox verification startup must get GitHub user repo access from `DOGFOOD_GITHUB_TOKEN` in that shell environment. `GITHUB_USER_TOKEN` and authenticated `gh` are workstation-local fallbacks only; sandbox dogfood should use `DOGFOOD_GITHUB_TOKEN` because no interactive `gh auth` state should be required. `apps/control-plane-worker/scripts/seed-local.sh` can mint a local GitHub App installation-token fallback, but that fallback is not enough for the user repo-listing path.

`DOGFOOD_GITHUB_TOKEN` is only the user/repo-discovery side of the flow. The target repo must also have the dev Cycloid GitHub App installed with contents and pull-request permissions; clone, sandbox `gh`, push, and PR creation use repo-scoped GitHub App installation tokens, not the dogfood user's PAT.

Only `NGROK_DOMAIN`, `NGROK_AUTHTOKEN`, and `NGROK_AUTH_TOKEN` are also copied into the agent shell. That lets the verification agent run `scripts/dev-tunnel.sh` when it needs child-sandbox callbacks. Other repo secrets are app-runtime inputs, not general agent-shell env.

`NGROK_AUTHTOKEN` only authenticates ngrok; it does not start a tunnel. `NGROK_DOMAIN` only selects the static domain. `npm run dogfood:e2e` starts the tunnel and writes `CONTROL_PLANE_URL`; plain `cycloid-app start` starts the app runtime only, so full child E2B session tests still need the tunnel step.

## Build Your Local Template

Build a personal E2B template after pulling this branch, after changing `apps/sandbox-e2b`, `apps/sandbox-bridge`, shared bridge code, or anything that must exist inside the sandbox image:

```bash
npm run build:e2b-template -- --dev --include-repo-spec-templates
```

The command prints the template name (every tier carries a `-mem<MB>-cpu<N>` suffix):

```bash
E2B_SANDBOX_TEMPLATE=cycloid-sandbox-dev-<your-login>-mem4096-cpu2
```

`.dev.vars` holds the bare stem `cycloid-sandbox-dev-<your-login>` (the worker appends the suffix); no need to copy the printed name in — local setup/startup scripts write the stem automatically. The local dev server does not rebuild E2B templates — rerun the build command after sandbox-image changes.

E2B applies the template's resource profile to every sandbox created from that tag. The default tier is 2 vCPU and 4096 MB RAM; repo-specific tiers, such as `trycycloid/cycloid`, may require larger templates.

## Run Locally

For normal local repo sessions, start the local API, UI, and ngrok callback tunnel:

```bash
npm run dev:full
```

The script tunnels the API port, not the Vite UI port, then updates `CONTROL_PLANE_URL` in `.dev.vars` to the active ngrok URL. Keep it running while sessions execute. If `CONTROL_PLANE_URL` points at hosted prod or QA Cycloid, local session creation fails fast before spawning E2B.

When dogfooding Cycloid through `.cycloid.json`, the app runtime publishes both:

- UI: `5173`
- API callbacks: `3000`

Expose only the API through ngrok for E2B callbacks.

For sandbox verification E2E, use the wrapper:

```bash
npm run dogfood:e2e
```

For the short agent flow, see [agent-local-verification-quickstart.md](agent-local-verification-quickstart.md).

That command:

- materializes `.dev.vars` from runtime secrets and local defaults
- validates `.dev.vars` has E2B, GitHub App, model, and ngrok config
- starts ngrok against API port `3000`
- writes `CONTROL_PLANE_URL` through `scripts/dev-tunnel.sh`
- starts the dogfood API and UI with one shared local session token
- applies local D1 migrations and seeds dogfood/local users, model integrations, GitHub installations, and the `DOGFOOD_GITHUB_TOKEN` user credential
- verifies local `/api/health`, tunneled `/api/health`, tunneled sandbox WebSocket preflight, UI `/auth/status`, dogfood auth, provider availability, E2B auth, the resolved E2B template, seeded dogfood GitHub credential, and configured GitHub App repo access
- writes Playwright auth state to `/tmp/cycloid-auth/dogfood/storage-state.json`

Keep it running while local E2B dogfood sessions execute.

`dogfood:e2e` intentionally uses fixed local ports `3000` and `5173` because those are the ports published by the checked-in Cycloid app runtime contract. Stop any existing process on those ports before starting it.

If the reserved ngrok endpoint is already held by another local process, stop that process. For a disposable local test,
`ALLOW_EPHEMERAL_NGROK=1 npm run dogfood:e2e` uses a generated ngrok URL instead.

## Verify E2B Works

In another terminal:

```bash
source .worktree-ports 2>/dev/null || true
API_PORT="${API_PORT:-3000}"
ADMIN="$(sed -n 's/^ARCANIST_ADMIN_TOKEN=//p' apps/control-plane-worker/.dev.vars)"

ARCANIST_TOKEN="$ADMIN" npm run verify:e2b-session -- \
  --base-url "http://localhost:${API_PORT}" \
  --owner-user-id 1001 \
  --repo-owner trycycloid \
  --repo-name <writable-test-repo> \
  --json-out tmp/e2b-local-session-report.json
```

Passing evidence must include:

- `promptStatus: "completed"`
- a non-empty GitHub `prUrl`

## Debug And Cleanup

Inspect a session through Cycloid:

```bash
curl -H "Authorization: Bearer $ADMIN" \
  "http://localhost:${API_PORT}/api/sessions/<session_id>/sandbox-state"
```

Inspect provider state directly:

```bash
E2B_API_KEY=<key> npm run debug:e2b:sandbox -- list \
  --state running,paused \
  --metadata runtime_provider=e2b,session_id=<session_id>

E2B_API_KEY=<key> npm run debug:e2b:sandbox -- status <runtime_sandbox_id>
```

Use `pause` or `kill` through `npm run debug:e2b:sandbox` only for deliberate cleanup. Normal stop/resume goes through Cycloid session APIs.

## Common Failures

- `E2B_API_KEY is not configured`: add the key to `.dev.vars` and restart `npm run dev:full`.
- `missing_template` or template not found: run `npm run build:e2b-template -- --dev --include-repo-spec-templates`, then restart `npm run dogfood:e2e`.
- `localhost:3000 is already in use` or `localhost:5173 is already in use`: stop the existing API/UI process before running `npm run dogfood:e2e`.
- `Invalid PKCS8 input`: ensure `GITHUB_PRIVATE_KEY` is one line with escaped `\n` separators, or rerun local setup after pulling this fix; local seed/dogfood startup normalize the common space-flattened PEM form.
- Git push returns 403: the dev GitHub App is not installed on the target repo or lacks write access. `DOGFOOD_GITHUB_TOKEN` does not grant sandbox push permission; it only lets the local user list/select the repo.
- Sandbox callback or WebSocket never connects: restart `npm run dev:full` so ngrok rewrites `CONTROL_PLANE_URL`, confirm the tunnel targets the API port, then start a fresh session.
- `GitHub is not connected for this user`: set `DOGFOOD_GITHUB_TOKEN` to the dogfood user's GitHub token, then rerun `bash scripts/seed-local.sh` from `apps/control-plane-worker` or restart the dogfood runtime. `GITHUB_USER_TOKEN` or authenticated `gh` are workstation fallbacks. GitHub App secrets alone do not make `/user/repos` work.
- "Reconnecting" / `Network connection lost` on Mac Wi-Fi: [debugging.md](debugging.md#local-sessions-disconnect).
- E2B quota or rate limit: stop old local sessions or clean up retained E2B sandboxes. The current account may cap concurrent sandboxes.
