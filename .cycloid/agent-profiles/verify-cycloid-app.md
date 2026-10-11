# Verify Cycloid App

Use when running as the verification agent for a Cycloid PR that may affect the UI, session flow, runtime, sandbox, PR publication, verification, or other user-visible behavior.

## Runtime

- Canonical local-stack details live in `docs/e2b-local-setup.md`.
- Start the sandbox app runtime with `/app/scripts/cycloid-app start`.
- Run `/app/scripts/cycloid-app auth` when auth is configured.
- Use `agent-browser` against the preview URL from the runtime context or `cycloid-app start`.
- Do not use external tunnel or ngrok backend URLs when the local full stack is available.
- For Cycloid-on-Cycloid child session tests, first confirm repo runtime env has `ARCANIST_ADMIN_TOKEN`, `E2B_API_KEY`, GitHub App credentials, a GitHub user repo token (`DOGFOOD_GITHUB_TOKEN` or `GITHUB_USER_TOKEN`), `OPENAI_API_KEY_FOR_LOCAL_DEV`, `SANDBOX_CALLBACK_SECRET`, `SANDBOX_RUNTIME_CLEANUP_SECRET`, `TOKEN_ENCRYPTION_KEY`, `NGROK_DOMAIN`, and `NGROK_AUTHTOKEN`/`NGROK_AUTH_TOKEN`.
- `cycloid-app start` does not create the callback tunnel. `NGROK_AUTHTOKEN` authenticates ngrok and `NGROK_DOMAIN` selects the static URL; both are needed in a fresh sandbox, and a tunnel still must be started so the local worker has `CONTROL_PLANE_URL`.

## First Decide What Changed

Inspect the PR summary, changed files, tests, and any runtime context. Classify the user-visible path before choosing the browser scenario:

- session creation or prompt execution
- transcript or event streaming
- runtime preview or app startup
- PR publication or verification evidence
- settings, auth, or repo configuration
- Slack or GitHub-originated workflow
- no user-visible surface

Choose the shortest real user journey that exercises the changed path. Use the default happy path only when the change affects normal session behavior or the changed path is unclear.

## Default Happy Path

1. Sign in.
2. Open the sessions UI.
3. Start a session on a test repo.
4. Use a small prompt such as `add an emoji to README`.
5. Watch the session until the relevant changed behavior appears.
6. Wait for completion or the expected intermediate state.
7. Inspect the resulting PR or output if the change affects publish or verification.

## Evidence

Take screenshots only at important states:

- entry state when it proves setup or route
- the changed feature state
- completion or result state
- error or blocker state, if blocked

Avoid screenshot spam. Prefer one clear screenshot per meaningful state. Use video when the behavior depends on interaction timing, streaming, or a multi-step flow.
