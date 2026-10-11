# Codex Subscription Auth

BYOS (bring-your-own-subscription) auth path for connecting a personal ChatGPT/Codex subscription to use subscription billing instead of OpenAI API-key billing for Codex sessions.

## Scope

- Available to businesses with `codex_byos_enabled=1` (per-business opt-in; seeded on Cycloid by default to preserve prior behavior).
- Per-user Codex `auth.json` only. Do not use shared accounts, pooled auth files, or credentials that are not your own.
- OpenAI/Codex models only. Non-OpenAI model selections fail closed when the selector is enabled.
- The selector is `user_settings.use_codex_subscription`, default off. If it is on and the credential is missing or unusable, spawn fails with auth instead of falling back to BYOK, managed virtual keys, local keys, or gateway auth.
- When the selector is on and a saved credential passes validation, the models endpoint returns `hasApiKey: true` for the OpenAI provider group, so the model picker shows OpenAI models as enabled without requiring a direct OpenAI API key. Toggling the selector, saving, or clearing auth JSON invalidates the models cache.

## Setup

1. Run `cycloid codex login` (or manually run `codex login --device-auth` locally and complete the browser/device login for your own ChatGPT account).
2. The CLI uploads the resulting `auth.json` to Cycloid settings automatically.
3. Enable `Use Codex subscription auth for OpenAI sessions`.

Alternatively, via the Settings UI:

1. Run `codex login --device-auth` locally and complete the browser/device login.
2. Copy the resulting local `~/.codex/auth.json` contents.
3. In Cycloid settings, save the file contents under `Codex subscription`.
4. Enable `Use Codex subscription auth for OpenAI sessions`.

The auth JSON is validated as a ChatGPT Codex auth file, stored encrypted in `user_integrations.api_key` with `integration_id='codex_subscription'` and `external_user_id='auth_json:{userId}'`. The raw JSON is transported to E2B only as `ARCANIST_CODEX_AUTH_JSON`; the bridge (`codex-server.ts`) writes it to `CODEX_HOME/auth.json` at startup, validates the auth file, unsets the transport variable from the child environment, and never injects gateway/API-key env.

## Deploy Notes

This path requires the E2B template containing the updated `start-bridge.sh`. Build/register the template before enabling the selector for real sessions; otherwise selected sessions fail closed at bootstrap.

Subscription sessions bypass OpenAI gateway accounting, budget enforcement, and BYOK spend summaries. Treat auth-file leaks like ChatGPT account compromise.
