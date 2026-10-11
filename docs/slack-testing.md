---
last_verified: 2026-06-24
---

# Slack Testing

Default rules for testing Cycloid's Slack integration; routine verification needs no new alignment questions.

Local setup failure modes and fixes: [docs/slack-local-dev-debugging.md](slack-local-dev-debugging.md).

## Default Assumptions

- No customer-facing or Slack Connect channels for routine verification.
- Prefer an internal sandbox/test channel that already has the correct Cycloid app installed.
- If no channel is named, use an internal non-customer sandbox/test channel available to the operator account without asking.
- If deployed verification needs one synthetic `@Cycloid` message and no narrower internal sandbox exists, use `#team` (`C0AMX2CEDMY`) without asking.
- Ask the user for a channel only when no suitable internal test channel is accessible, write access is missing, or the action would post in a customer/shared space.

## Environment Mapping

| Environment | Slack app        | Cycloid URL                     | Default use                                                                   |
| ----------- | ---------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| Production  | `@Cycloid`       | `https://app.trycycloid.com`    | Production verification, deploy validation, real customer-path webhook checks |
| Local dev   | `@Cycloid (DEV)` | local control plane URL         | Local webhook and callback testing against local code                         |
| QA          | `@Cycloid`       | `https://qa.app.trycycloid.com` | QA verification with live-verified Slack OAuth config and workspace install   |

Slack QA parity is documented in [docs/qa-prod-parity.md](qa-prod-parity.md). The current status is `parity` with live-verified Slack OAuth config, workspace install, linked QA user, and runtime tool evidence.

## Known Workspace IDs

Current verified Slack workspace identifiers for routine Cycloid verification.

| Item                                  | Value                   | Verification source                                    |
| ------------------------------------- | ----------------------- | ------------------------------------------------------ |
| Local dev bot user ID                 | `U0ALK6K076E`           | Slack user profile for `Cycloid (DEV)` / `cycloid_dev` |
| Default internal verification channel | `#team` (`C0AMX2CEDMY`) | Recent internal Cycloid dev E2E checks ran here        |

Production bot handle is `@Cycloid`, but its Slack user ID is not yet pinned here (no reliable confirmed value from operator-accessible tooling). Capture it from the next confirmed production mention/reply and add it.

## Channel Selection Rules

Order:

1. Existing internal sandbox/test channel for Cycloid validation.
2. Existing private internal engineering/test channel with the app installed.
3. A DM or private test conversation owned by the operator account, only if channel-based behavior is not required.

Never default to: customer channels, incident channels with live responders, public announcement channels, Slack Connect channels.

## What To Use For Common Checks

### Slack webhook or session-start behavior

Use a real Slack message path; CLI-only sessions are not enough.

- Top-level app mention: normal Slack session creation.
- Thread app mention: thread-bound session creation and follow-up routing.
- Follow-up reply in an already bound thread: enqueue/follow-up behavior.
- `stop` in a bound thread: Slack stop handling.

### Sandbox or runtime behavior after Slack started the session

Use both:

- a real Slack-originated session to prove webhook/session wiring
- a real Cycloid session record plus observability evidence to prove downstream behavior

### Non-Slack control-plane or sandbox changes

Prefer CLI verification first. Use Slack only when the user asked for Slack-surface proof or the changed path is Slack-only.

## Driving Sessions With The Slack MCP

Default way for a coding agent to test the integration: post the trigger with the Slack MCP and read the bot's reply, no browser. Use Browser-Use Live Session Runs only for live-session eval reruns that need a real authenticated browser.

Pick the app per Environment Mapping (`@Cycloid (DEV)` hits local code via the tunnel; `@Cycloid` hits prod). Channel defaults and selection are under Default Assumptions / Channel Selection Rules; bot IDs are under Known Workspace IDs.

### Encode the mention, not the display name

Slack fires `app_mention` (and the thread-follow-up path) only when the raw text contains a real mention token `<@BOT_USER_ID>`. A human typing `@Cycloid` gets autocompleted into that token; MCP text is sent verbatim, so literal `@Cycloid` is plain text - no webhook, no session, silent no-op. Every MCP trigger must embed `<@BOT_USER_ID>` (the id from Known Workspace IDs). A mention only inside quoted/blockquote text does not count (`quoted_mention_only`, skipped).

### Recipe

1. Post the trigger with `slack_send_message` (`channel`, `text` starting with `<@BOT_USER_ID>`). Capture the returned `ts` (the parent/thread timestamp). For a thread-bound start, send it as a reply with `thread_ts` set to a seed message's `ts`.
2. Read the bot's reply with `slack_read_thread` (`channel`, `thread_ts`); pull the Cycloid session URL/ID from the ack. Use `slack_get_reactions` on the trigger `ts` for paths that react instead of replying.
3. A follow-up in a bound channel thread **requires** a fresh `<@BOT_USER_ID>` in the reply for active sessions (the #5664 follow-up-mention gate). Replies to stopped/archived sessions trigger wake-on-reply (see `docs/slack.md` Wake-on-reply). DM follow-ups are exempt: every DM message already addresses the bot. Reply with `slack_send_message` + `thread_ts`, again leading with the mention token for active sessions. `stop` is exempt: the handler strips the bot's own mention and matches the exact word `stop` before the gate, so both bare `stop` and `<@BOT_USER_ID> stop` close the session (the text must be exactly `stop` after stripping - `stop the run` is treated as a normal follow-up).

Use the prompts under Minimal Message Patterns, substituting `<@BOT_USER_ID>` for `@Cycloid`. Capture the Evidence Checklist for every run. For local events that arrive but produce no reply (`.dev.vars`, workspace seed, actor link, signature failures), see [docs/slack-local-dev-debugging.md](slack-local-dev-debugging.md).

### Negative paths

The MCP makes the skip cases cheap to prove - each should produce no session, confirmed by the worker log's `skipped` reason (`wrangler tail` for prod; worker logs are not in Datadog):

- External bot/app message (bot_id/app_id set) -> `external_bot_event`.
- Bare follow-up, no mention -> `followup_requires_mention`.
- Channel message, no mention -> `not_app_mention`.
- Mention only inside a quote -> `quoted_mention_only`.
- Non-trigger message from unconnected user -> `unconnected_non_trigger`.
- QA target PR outside the selected repo -> `target_pr_repo_mismatch`.

## Browser-Use Live Session Runs

Use this workflow when the goal is to rerun a live-session eval through Slack rather than a local eval script.

Default trigger surface:

- Browser profile: existing authenticated browser-use Slack session.
- Slack channel: `#shiv-testing` / `C0B868WEA3B`, unless the user names a different internal test channel.
- Slack app: `@Cycloid (DEV)` for local-dev runs.
- Prompt prefix: `@Cycloid (DEV) repo=trycycloid/cycloid ...`.

Coordinator steps:

1. Start the local server stack only if the run needs local API/UI/webhook behavior.
2. Verify the Slack tab is in the intended workspace/channel before posting.
3. Use browser-use to post the scenario prompts into Slack, not the eval script.
4. Verify Slack accepted the full prompt text before moving to the next scenario.
5. Capture the parent Slack timestamp, thread timestamp, and resulting Cycloid session id for each scenario.
6. Fan out result collection to subagents once sessions are launched.

Subagent pattern:

- Do not launch wide local batches through one browser-use Slack tab and one local tunnel. For local-dev runs, use small waves of 3-5 sessions and keep at most 5 active sessions until the callback path proves stable. Start the next wave only after Slack reactions and session refs exist for the prior wave; if telemetry auth-rate-limit noise appears, wait for completion or restart clean before launching more.
- Treat callback-path errors as run contamination, not memory quality signal. If Datadog shows E2B bridge calls to the local callback URL failing with TLS resets, `403`, or `429` for `/sandbox/repo-memory/recall`, rerun those scenarios after the tunnel quiets down.
- Telemetry-only callback failures (`/sandbox/telemetry/*`) can be noted but do not by themselves invalidate memory scoring. Recall callback failures (`/sandbox/repo-memory/recall`) do invalidate that scenario's memory result.
- If a local wide batch causes sustained callback `403`/`429` or sandbox auth-rate-limit noise, abandon the run, stop the local dev stack, and restart from a clean environment before rerunning scenarios.
- Cap result-collection workers to the number that can reliably query D1/session exports without causing avoidable `SQLITE_BUSY` noise.
- Assign each collector a disjoint scenario/session batch.
- Collect session export, D1 memory usage rows, selected memory text, PR URL, terminal state from `session_completions`, and any relevant Slack/thread evidence.
- For memory scoring, label every selected memory as `useful`, `neutral`, `bad`, or `unknown`. Report both impact false-positive definitions: `(neutral + bad) / known_selected` and `bad / known_selected`. Keep strict expected-ID precision as a diagnostic only.
- Result collectors must not mutate GitHub or Slack. PR cleanup, branch deletion, and Slack follow-ups are separate explicit steps.
- Treat `session_completions` plus session export as terminal-state authority when `session_index.runtime_state` is stale.

For memory live runs, score `repo_recall`, `company_recall`, and `company_bootstrap` separately. Bootstrap runs for production sessions with a business id.

## Evidence Checklist

Capture for any Slack verification:

- Slack channel ID
- parent message timestamp and thread timestamp when relevant
- message permalink
- session ID
- session URL
- prompt ID if available
- production or QA URL used
- relevant logs, events, or trace IDs

Pass only when the Slack action and the Cycloid session evidence agree.

## Minimal Message Patterns

Short, explicit prompts that make the path obvious and obviously synthetic. These show `@Cycloid` for a human typing in Slack; when posting via the Slack MCP, replace `@Cycloid` with the `<@BOT_USER_ID>` token (see Driving Sessions With The Slack MCP). For active sessions in channel threads, every entry except `stop` must carry the mention - a bound-thread follow-up without it is skipped (`followup_requires_mention`); DM follow-ups are exempt. Replies to stopped/archived sessions wake them (see Wake-on-reply in `docs/slack.md`). `stop` is the one universal mention-free control command:

- Top-level start: `@Cycloid repo=trycycloid/cycloid verify Slack session startup`
- Thread start: `@Cycloid repo=trycycloid/cycloid qa thread session startup`
- Follow-up: `@Cycloid check follow-up routing`
- Stop: `stop`

## Operator Behavior

- Make the smallest externally visible Slack action that exercises the path.
- Prefer one thread per QA run.
- Do not ask permission for a single synthetic message in the default internal QA channel when that message is the requested QA step.
- Do not ask the user to pick a channel unless the default assumptions above fail.
- If a check requires a specific workspace, channel policy, or install state not inferable from repo context, state that blocker explicitly.
