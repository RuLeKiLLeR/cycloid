---
last_verified: 2026-06-20
---

# Slack Local Dev Debugging

Use this when local `@Cycloid (DEV)` Slack testing receives events but does not reply or start a session.

## Known-Good Local Shape

- Slack Events Request URL points at the local API tunnel:
  `https://<ngrok-domain>/api/webhooks/slack/events`
- `npm run dev:full` is running from the intended worktree.
- `apps/control-plane-worker/.dev.vars` contains active, uncommented Slack values:
  - `SLACK_SIGNING_SECRET`
  - `SLACK_BOT_TOKEN`
  - `SLACK_WORKSPACE_TEAM_ID`
  - `SLACK_BOT_USER_ID`
- Local D1 has an active `slack_workspaces` row for the same `team_id`.
- The local Slack user is linked through `user_integrations.external_user_id`.

## Failures And Fixes

### Slack Request URL Fails Challenge Verification

Slack UI says:

```text
Your URL didn't respond with the value of the challenge parameter.
```

Check local API logs for:

```text
POST /api/webhooks/slack/events 401 Unauthorized
```

Likely causes:

- `SLACK_SIGNING_SECRET` is missing from `.dev.vars`.
- The line is commented out as `# SLACK_SIGNING_SECRET=...`.
- The secret belongs to production `Cycloid`, not `Cycloid (DEV)`.
- Local dev was not restarted after editing `.dev.vars`.

Fix:

```text
SLACK_SIGNING_SECRET=<Cycloid DEV signing secret>
```

Do not include quotes or angle brackets. Restart `npm run dev:full`, then retry Slack URL verification.

### Slack Event Arrives But Bot Does Not Reply

Logs show:

```text
Slack webhook signature verified.
Slack webhook skipped: workspace bot token unavailable
```

Likely causes:

- `SLACK_BOT_TOKEN` is missing or commented out.
- `SLACK_WORKSPACE_TEAM_ID` or `SLACK_BOT_USER_ID` is missing.
- The local workspace install was not seeded into D1.

Fix `.dev.vars`:

```text
SLACK_BOT_TOKEN=xoxb-...
SLACK_WORKSPACE_TEAM_ID=T...
SLACK_BOT_USER_ID=U...
```

Then seed local D1:

```bash
cd "$(git rev-parse --show-toplevel)"

ADMIN="$(sed -n 's/^ARCANIST_ADMIN_TOKEN=//p' apps/control-plane-worker/.dev.vars | tr -d '\r')"

curl -sS -X POST "http://localhost:3000/api/internal/slack/workspaces/seed" \
  -H "Authorization: Bearer ${ADMIN}" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected response includes the Slack `teamId` and bot `userId`.

Confirm:

```bash
cd apps/control-plane-worker

npx wrangler d1 execute DB --local --command "
SELECT team_id, bot_user_id, business_id, uninstalled_at
FROM slack_workspaces;
"
```

### Seed Route Returns Unauthorized Or Invalid Headers

If the seed call returns:

```text
{"ok":false,"error":"Unauthorized"}
```

make sure the admin token was read from the same worktree where `dev:full` is running.

If curl says:

```text
ERROR: The headers sent by your client are not valid.
```

remove Windows carriage returns:

```bash
ADMIN="$(sed -n 's/^ARCANIST_ADMIN_TOKEN=//p' apps/control-plane-worker/.dev.vars | tr -d '\r')"
```

### Slack User Is Not Connected

Logs show:

```text
Slack webhook could not resolve the Slack actor to a connected Cycloid user.
Slack user not connected
```

For local-only testing, link the Slack user id to the seeded local Cycloid user:

```bash
cd "$(git rev-parse --show-toplevel)/apps/control-plane-worker"

npx wrangler d1 execute DB --local --command "
INSERT INTO user_integrations (
  user_id,
  integration_id,
  oauth_access_token,
  oauth_refresh_token,
  oauth_expires_at,
  api_key,
  external_user_id,
  service_url,
  encrypted,
  last_validated_at,
  last_validation_status,
  last_validation_reason_code,
  connected_at,
  updated_at
) VALUES (
  '<local_user_id>',
  'slack',
  NULL,
  NULL,
  NULL,
  NULL,
  '<slack_user_id>',
  NULL,
  0,
  unixepoch() * 1000,
  'validated',
  NULL,
  unixepoch() * 1000,
  unixepoch() * 1000
)
ON CONFLICT(user_id, integration_id) DO UPDATE SET
  external_user_id = excluded.external_user_id,
  last_validated_at = excluded.last_validated_at,
  last_validation_status = excluded.last_validation_status,
  updated_at = excluded.updated_at;
"
```

Set the workspace business id when testing business-scoped Slack behavior:

```bash
npx wrangler d1 execute DB --local --command "
UPDATE slack_workspaces
SET business_id = '<business_id>'
WHERE team_id = '<slack_team_id>';
"
```

### Message Is Skipped As Not An App Mention

Logs show:

```text
Skipping Slack new-session event: not app_mention
```

This means the event reached Cycloid but did not arrive as an `app_mention` trigger. Send a fresh top-level message that explicitly mentions the dev app:

```text
@Cycloid (DEV) repo=trycycloid/cycloid say hello
```

Do not rely on edited messages or copied mention text while debugging.

## Success Signals

Normal Slack mention startup is working when logs show:

```text
Slack webhook signature verified.
Slack webhook resolved the workspace and actor context.
Parsed message
Adding eyes reaction (new session)
Slack webhook created a session and enqueued the bootstrap prompt.
```

Capture the created session id from the final log line and verify it in the local UI.
