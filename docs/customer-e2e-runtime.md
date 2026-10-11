# End-to-end runtime

How to opt your repo into agent-driven end-to-end verification: the agent boots your app inside the sandbox, drives it through a real browser (or runs your own test suite), and can attach screenshots and videos as PR evidence.

This is **opt-in**. If your repo doesn't declare `appRuntime.e2e` in `.cycloid.json`, nothing changes — the agent still does code review, tests, and static checks as before.

## When to use it

Turn this on for repos where you want the agent to verify UI behavior in addition to code: dashboards, admin tools, internal CRUDs, content sites. The agent boots your dockerized app, logs in with credentials you provide, exercises the flow it just changed, and attaches screenshots to the PR.

Skip this for libraries, backends with no UI, or anything without a `Dockerfile` + a way to start it.

## What you need

1. A working `Dockerfile` and `docker-compose.yml` (or stack of compose files) that can boot your app from a clean checkout
2. An `.cycloid.json` declaring `appRuntime` (existing) plus `appRuntime.e2e` (new — see below)
3. Repository environment variables configured in **Settings → Repository secrets** for any app secrets your runtime needs

## The contract

Add `appRuntime.auth` when protected-route screenshots require login. Add `appRuntime.e2e` when you also want Cycloid to run your repo-owned test suite.

```json
{
  "appRuntime": {
    "kind": "web",
    "runner": "docker",
    "entry": {
      "type": "compose",
      "files": ["docker-compose.yml"],
      "service": "web"
    },
    "url": { "hostPort": 3000, "path": "/" },
    "ready": { "path": "/api/health", "timeoutSeconds": 900 },
    "auth": {
      "command": "npm run cycloid:auth",
      "validatePath": "/dashboard",
      "credentials": [
        { "name": "test_user_email", "envVar": "E2E_USER_EMAIL" },
        { "name": "test_user_password", "envVar": "E2E_USER_PASSWORD" }
      ]
    },
    "e2e": {
      "testCommand": "npm run test:e2e",
      "seedCommand": "npm run db:seed:test",
      "resetCommand": "npm run db:reset",
      "credentials": [
        { "name": "test_user_email", "envVar": "E2E_USER_EMAIL" },
        { "name": "test_user_password", "envVar": "E2E_USER_PASSWORD" }
      ]
    }
  }
}
```

| Field                  | Required                        | Notes                                                                                                                                                                                                           |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.command`         | yes (when `auth` block present) | Shell command that signs in to the running app and writes Playwright storage state to `ARCANIST_AUTH_STATE_PATH`. It can use UI login, API login, DB seed, or app-specific cookie setup.                        |
| `auth.validatePath`    | no                              | App-relative route Cycloid opens with the produced storage state to prove auth worked. Use a stable protected route such as `/dashboard`. It is not the route Cycloid must screenshot for every task.           |
| `auth.credentials[]`   | no                              | Same credential declaration shape and storage path as `e2e.credentials[]`. Use this for login users/passwords required by `auth.command`.                                                                       |
| `e2e.testCommand`      | yes (when `e2e` block present)  | Shell command the agent runs to exercise the suite — e.g. `npm run test:e2e`, `pytest tests/e2e`, `bin/rails test:e2e`                                                                                          |
| `e2e.seedCommand`      | no                              | Run by `cycloid-app seed` and at the start of `cycloid-app reset`                                                                                                                                               |
| `e2e.resetCommand`     | no                              | Run by `cycloid-app reset` to restore DB / app state between attempts                                                                                                                                           |
| `e2e.credentials[]`    | no                              | See **Test credentials** below                                                                                                                                                                                  |
| `ready.timeoutSeconds` | no                              | How long to wait for the app to come up after `docker compose up`. Default **900** (15 min) — accommodates a cold image build. Override smaller (e.g. `30`) if your app starts fast and you want to fail loudly |

## Test credentials

For normal app secrets, add your repo `.env` values in **Settings → Repository secrets** for that repo. Cycloid stores the values encrypted, never returns them from the API, and passes them to Docker runtime startup through `composeEnv`. Personal secrets (from **Settings → Personal secrets**) are merged first; repo secrets override personal secrets on key collision.

Repo environment variables are app-runtime inputs. They are merged into Docker Compose for `cycloid-app start`, and they can satisfy `auth.credentials[]` / `e2e.credentials[]` declarations by matching `envVar`. They are not broadly exposed to the agent shell; only operational names explicitly allowlisted for agent use, currently `NGROK_DOMAIN`, `NGROK_AUTHTOKEN`, and `NGROK_AUTH_TOKEN`, are copied there.

`appRuntime.e2e.credentials[]` is optional. Use it only for secrets that should be explicit fail-closed declarations. If an `envVar` is present in the stored repo `.env`, that value satisfies the declaration; a value stored through the test-credentials API wins over the repo `.env`.

Each `credentials[]` entry pairs a stored secret name with the env var the agent will see:

- `name` — your label for the secret. Pattern: `[a-zA-Z0-9_.-]{1,64}`
- `envVar` — the env var injected into the running app. Pattern: `[A-Z_][A-Z0-9_]{0,127}`
- `source` (optional) — `business_openai_key`, `business_anthropic_key`, or `business_neon_branch`: with no explicit value stored, the credential resolves from the matching business integration. OpenAI and Anthropic use the workspace BYOK provider key the sessions already run on. Neon creates one writable database branch per session and injects that branch connection URI. An explicitly stored value always wins where a stored secret path exists, so a dedicated key can still be set for usage tracking.

**Reserved env-var prefixes** (collide with platform secrets, rejected at validation):
`CYCLOID_*`, `BRIDGE_*`, `CODEX_*`, `GH_*`, `GITHUB_*`, `OPENAI_*`, `SANDBOX_*`, `SESSION_*`, `TOKEN_*`

Exception: `ARCANIST_LOGIN_USERNAME` and `ARCANIST_LOGIN_PASSWORD` are accepted in `auth.credentials[]` and `e2e.credentials[]`.

**Reserved exact names**: `PORT`, `HOST`, `PATH`, `HOME`, `USER`, `SHELL`, `PWD`, `NODE_ENV`

Set values via the Cycloid API:

```bash
curl -X PUT \
  "$ARCANIST_API/api/businesses/<biz>/repos/<owner>/<repo>/test-credentials/<name>" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"value":"<secret>"}'
```

Values are encrypted at rest with AES-GCM and decrypted only inside the sandbox at session start.

If a session declares a credential whose value isn't set in test credentials or repo `.env`, the session **fails closed** at start with a clear error — it does not run the agent against an app missing required env vars.

## Supported auth setup

`auth.command` is repo-owned. Cycloid does not guess your login flow; it only runs the command, validates the storage state, and reuses it for screenshots and walkthrough video. Your command may use Playwright UI login, an API login call, test-only seed data, or direct cookie setup, as long as it writes a valid Playwright storage state file.

## Not supported

Any of these in your login flow will block the agent and the session will report no progress:

- 2FA / MFA / TOTP / SMS codes
- SSO / OAuth (Google, GitHub, Okta, Azure AD)
- Magic links sent to email
- CAPTCHAs / "I am not a robot" challenges
- Passwordless / WebAuthn / hardware-key flows

If your app's only login path uses any of the above, create a non-interactive test auth path inside `auth.command`. If the command cannot produce valid auth state, Cycloid reports an explicit caveat and treats protected-route visual evidence as inconclusive.

## What happens when the runtime can't start

- **Missing `Dockerfile` / compose files** → `cycloid-app start` exits non-zero, the agent surfaces the error in the session UI, and proceeds with code-only review (no E2E)
- **Compose stack times out** (didn't reach `ready.path` within `timeoutSeconds`) → same — error surfaced, agent falls back to code-only review
- **Declared credential not registered** → session fails closed at start with `Cannot start session: missing E2E credentials [...]`
- **Validation errors** in `.cycloid.json` → diagnostics surface in the repo preview (visible from the dashboard) before any session runs

## Limits during alpha

- One running session per repo at a time. Concurrent sessions on the same repo aren't yet hardened — start them serially.
- Credentials rotated mid-session keep the old value for the running session; new sessions pick up the new value.
- Agent-captured screenshots (PNG) are shown in the session transcript. Screenshots are embedded inline in the PR body via Cycloid-managed GitHub release assets; when release publishing is unavailable or risky (e.g. release/tag workflows detected), they fall back to bullet links — inline for public repos using signed Cycloid URLs, or sign-in-required links for private repos. Verification comments use the same fallback: screenshots that cannot be published to GitHub releases are preserved as link-only artifacts (`renderMode: "link"`) instead of being dropped. Playwright video evidence is WebM-only (`.webm`, `video/webm`), capped at 50 MB, and linked from the PR body without inline players. Filenames containing markdown-special characters render as text, not HTML.

See also [`docs/sandbox-architecture.md`](sandbox-architecture.md) for the underlying sandbox lifecycle and the `appRuntime` schema this builds on.
