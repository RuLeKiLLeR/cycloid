# Cycloid CLI

Command-line interface for [Cycloid](https://www.trycycloid.com): create coding agent sessions, follow their output, and manage access tokens from your terminal or automation.

## Install

```bash
npm install -g @trycycloid/cli
```

Requires Node.js 22 or newer.

## Quick start

```bash
cycloid auth login                 # paste a token from Settings > CLI Tokens
cycloid sessions create https://github.com/your-org/your-repo "fix the login bug"
```

```bash
export ARCANIST_TOKEN=arc_...       # write-scoped for create/send/stop
SESSION_ID=$(cycloid sessions create your-org/your-repo "add tests for the auth module" --json | jq -r .sessionId)
cycloid sessions events "$SESSION_ID" --follow --json
```

## Authentication

Generate a CLI token in the Cycloid UI at **Settings > CLI Tokens**, then:

```bash
cycloid auth login
# paste your arc_... token when prompted; input is masked
```

Token config is stored at `~/.cycloid/config.json`. Multiple active tokens per user are supported; revoke tokens independently when a device or workflow no longer needs access.

Use a read-scoped token for inspection and debugging; use a write-scoped token only to create sessions, send prompts, or stop runs.

You can also pipe the token via stdin:

```bash
printf "arc_..." | cycloid auth login --token-stdin
```

Auth and API URL precedence:

```text
flag > environment > project .cycloid-cli.json > ~/.cycloid/config.json
```

Supported environment variables:

```bash
export ARCANIST_TOKEN=arc_...
export ARCANIST_API_URL=https://api.trycycloid.com
export ARCANIST_HTTP_TIMEOUT_MS=30000
```

`--token` and `--api-url` are available for one-off invocations. Prefer `ARCANIST_TOKEN` over `--token` for persistent use; CLI flags can appear in shell history and process lists.
Each HTTP request times out after `ARCANIST_HTTP_TIMEOUT_MS` milliseconds, default `30000`.
The value must be between `1000` and `600000`; invalid values fail closed instead of falling back silently.

Non-local API URLs must use HTTPS and must not embed credentials.

### Project-local targeting

`cycloid auth login` writes only the global config at `~/.cycloid/config.json`.
In a git repo, the CLI also looks for `.cycloid-cli.json` from the current directory up to the git root.
The nearest file wins, files above the git root are ignored, and discovery is skipped outside git repos.

Project files are accepted only for loopback local development targets.
They must contain both `apiUrl` and `token`, and `apiUrl` must be `localhost`, `127.0.0.1`, or `::1`.
Malformed, incomplete, or non-loopback project files fail closed instead of falling through to the global config.
When a project file is active, env or flag overrides must provide both API URL and token together.

Cycloid development worktrees created with `bash scripts/worktree-setup.sh` create `.cycloid-cli.json` automatically.
From inside those worktrees, use `scripts/arc-prod <command>` to run one command against production using the existing global config.

## Global flags

```bash
cycloid --json
cycloid --quiet
cycloid --api-url https://api.trycycloid.com
cycloid --token arc_...
cycloid --no-color
```

## JSON output, errors, and exit codes

With `--json`, successful command output is machine-readable and newline-terminated. Errors are written to stderr as:

```json
{
  "error": {
    "code": "auth",
    "message": "Not logged in.",
    "hint": "Run `cycloid auth login` or set `ARCANIST_TOKEN`.",
    "data": { "serverCode": "token_revoked" }
  }
}
```

`error.data` is omitted when there is no structured recovery data.
Stable fields are `serverCode` for server-provided error codes and `sessionId`/`sessionUrl` when `sessions create` created the session but failed to enqueue the prompt.

Exit codes:

```text
0   ok
1   user/input error
2   auth error (401/403)
3   not found (404)
4   conflict (409)
10  server or network error
130 interrupted
```

Mutation commands send an `Idempotency-Key` header. The CLI does not auto-retry mutation endpoints; retry explicitly with the same `--idempotency-key` when a request may have already reached the server. `--idempotency-key` is available on `sessions create`, `sessions send`, `tokens create`, and `sandbox build`. `tokens create` and `sandbox build` use auto-random keys by default, so only an explicit key makes cross-invocation retries safe.

## Commands

### `cycloid auth login`

```bash
cycloid auth login
printf "arc_..." | cycloid auth login --token-stdin
cycloid auth login --api-url https://api.trycycloid.com
```

### `cycloid auth whoami`

```bash
cycloid auth whoami
ARCANIST_TOKEN=arc_... cycloid auth whoami --json
```

JSON mode prints the raw `/api/auth/whoami` API response. Fields currently include `userId`, `email`, `tokenId`, `tokenScope`, and `authMode`.

### `cycloid codex login`

Authenticates a Codex/ChatGPT subscription and stores it for your Codex sessions, then activates it (turns on "use subscription auth for OpenAI sessions"). Runs the Codex CLI device-authorization login locally under a temporary `CODEX_HOME`, then uploads the resulting `auth.json` to Cycloid (encrypted, per user). The credential is never written to your default `~/.codex`. Requires a write-scoped token and a workspace with Codex subscription auth enabled. If activation fails the credential is still saved; run `cycloid codex use on`.

```bash
cycloid codex login
cycloid codex login --codex-path /usr/local/bin/codex
```

`--codex-path <path>` overrides the `codex` executable used (default: `codex` on `PATH`, or `ARCANIST_CODEX_BIN`).

### `cycloid codex use <on|off>`

Turns using your saved Codex subscription auth for OpenAI sessions on or off, without changing the stored credential. `cycloid codex login` turns it on automatically; use this to toggle it later.

```bash
cycloid codex use on
cycloid codex use off
```

### `cycloid codex status`

Shows whether your workspace is eligible for Codex subscription auth and whether an `auth.json` is currently saved.

```bash
cycloid codex status
cycloid codex status --json
```

JSON mode returns `{eligible, credential: {isSet, lastValidationStatus?, lastValidationReasonCode?}}`.

### `cycloid codex logout`

Deactivates the selector and removes the stored Codex subscription auth for your user (write-scoped token).

```bash
cycloid codex logout
```

### `cycloid sessions create <repo-url> [prompt]`

Creates a new session and sends the initial prompt.

```bash
cycloid sessions create https://github.com/your-org/your-repo "fix the login bug"
cycloid sessions create your-org/your-repo "continue this work" --start-branch wip/resume-me
cycloid sessions create your-org/your-repo "finish this PR" --continue-pr https://github.com/your-org/your-repo/pull/123
printf "add tests" | cycloid sessions create your-org/your-repo --prompt-stdin --json
printf "add tests" | cycloid sessions create your-org/your-repo --prompt-stdin --wait
cycloid sessions create your-org/your-repo - --model gpt-5.5
cycloid sessions create your-org/your-repo "port to claude" --backend claude_code --model claude-opus-4-8
cycloid sessions create your-org/your-repo "refactor auth" --reasoning-effort xhigh
cycloid sessions create your-org/your-repo "verify this automatically" --auto-verify
cycloid sessions create your-org/your-repo "fix release branch" --base-branch release/2026-06
cycloid sessions create your-org/your-repo "review the trace" --uploaded-file trace.txt
cycloid sessions create your-org/your-repo "verify the deployed change" --cold
cycloid sessions create your-org/your-repo "retry-safe create" --idempotency-key 1f0e6f1a-...
```

`--backend` picks the agent runtime backend: `codex` (default) or `claude_code`. `--model` must be valid for the chosen backend — codex runs OpenAI models (`gpt-5.4` default, `gpt-5.5`), `claude_code` runs Anthropic models (`claude-opus-4-8` default, `claude-sonnet-4-6`, `claude-fable-5`) — and the CLI rejects a mismatch before any network call. `claude_code` sessions require an Anthropic API key configured in Settings.

`--wait` blocks until the created prompt finishes, prints the resulting PR/branch line in human-readable mode when it is already available, and exits non-zero if the prompt finishes with `status: failed`, making it suitable for cron or other schedulers that alert on command failure. JSON mode waits quietly and prints the create payload after the prompt completes successfully. `--poll-interval <ms>` tunes the completion check frequency.

Use `--auto-verify` to opt the created session into automatic QA verification after PR creation. Auto verification is default-off at session create unless another surface explicitly enables it.

Use `--base-branch <branch>` to target a non-default base branch. The CLI only validates that the branch value is non-empty; branch existence is checked later by the session runtime.

Use `--start-branch <branch>` to resume an existing branch with its history instead of forking a fresh branch off base; the control plane verifies the branch exists on the remote and fails closed if it does not.

Use `--continue-pr <url>` to continue an open same-repo pull request. The control plane checks out the PR head branch before the prompt runs. `--continue-mode update-pr` updates the referenced PR; `--continue-mode new-pr` starts from that PR head but leaves publish free to open a fresh PR. `auto` is the default and currently resolves to same-PR update for supported open same-repo PRs.

Repeatable `--uploaded-file <path>` flags attach local UTF-8 text files to the prompt. Uploaded file names come from the local basename; directory components are not sent.

`--cold` is a deprecated no-op retained for backward compatibility. Sessions always start from a fresh sandbox (the warm sandbox pool was removed), so the flag has no effect.

`--idempotency-key <uuid>` is for manually retrying a create request that may have reached the server.
The CLI derives separate session and prompt idempotency keys from the provided value.

`--onboarding` creates an onboarding session: the agent authors the repo's `.cycloid.json`, `.cycloid/` runtime files, `CYCLOID.md`, and conditionally `.cycloid/sandbox.yaml` + `.cycloid/sandbox.layer.Dockerfile` (when the base sandbox lacks a needed toolchain), proves what it can inside its sandbox, and opens the setup PR ready for review. The onboarding behavior is driven by the bridge's canonical onboarding playbook, not the prompt, so `--onboarding` needs no prompt: `cycloid sessions create <repo> --onboarding --wait`. Any prompt supplied alongside `--onboarding` is ignored. Team use; not part of the external API surface.

JSON mode returns `{sessionId, sessionUrl?, repoUrl, model?, agentRuntimeBackend?, reasoningEffort?, autoVerify?, baseBranch?, startBranch?, continuePrUrl?, continueMode?, onboarding?, promptId?}`. `sessionUrl` is emitted only when the server returns it; `agentRuntimeBackend` only when `--backend` is passed. With `--wait`, JSON mode also includes best-effort result fields when available: `prUrl?`, `publishedBranch?`, and `lastBranch?`.

### `cycloid sessions qa <pr-url>`

Starts a QA verification session for an existing GitHub pull request.

```bash
cycloid sessions qa https://github.com/your-org/your-repo/pull/123
cycloid sessions qa https://github.com/your-org/your-repo/pull/123 --model gpt-5.4
cycloid sessions qa https://github.com/your-org/your-repo/pull/123 --backend claude_code --model claude-opus-4-8
cycloid sessions qa https://github.com/your-org/your-repo/pull/123 --reasoning-effort xhigh
cycloid sessions qa https://github.com/your-org/your-repo/pull/123 --wait
cycloid sessions qa https://github.com/your-org/your-repo/pull/123 --idempotency-key 1f0e6f1a-...
```

The PR URL must be `https://github.com/<owner>/<repo>/pull/<number>`.
The CLI derives the repo from that URL, creates a QA session with `qa: true` and `targetPrUrl`, then enqueues the verifier prompt (skipped when the server signals `promptAlreadyEnqueued`).
Inspect progress with the session URL or the session events stream.

`--backend` picks the agent runtime backend: `codex` (default), `claude_code`, or `opencode`.
`--model` must be valid for the chosen backend, and the CLI rejects mismatches before any network call.
When `--model` is omitted, the backend default is used.

`--wait` blocks until the enqueued QA prompt finishes and exits non-zero if the prompt fails.
JSON mode waits quietly and prints the create payload after the prompt completes successfully.
`--poll-interval <ms>` tunes completion polling.

`--idempotency-key <uuid>` is for manually retrying a QA request that may have reached the server.
The CLI derives separate session and prompt idempotency keys from the provided value.
If session creation succeeds but prompt enqueue fails, retry the same command with the same `--idempotency-key`.

JSON mode returns `{sessionId, sessionUrl?, repoUrl, targetPrUrl, model?, agentRuntimeBackend?, reasoningEffort?, promptId?}`.
`promptId` is absent when the coordinator already enqueued the verifier prompt (no duplicate send). Active-verifier and per-PR run-limit conflicts both use exit code `4`; active-verifier errors include the existing session handle when the server returns it.

### `cycloid sessions send <session-id> [prompt]`

Sends a follow-up message to an existing session.

```bash
cycloid sessions send abc123 "also update the tests"
cycloid sessions send abc123 "use this failure log" --uploaded-file failure.log
printf "summarize current status" | cycloid sessions send abc123 --prompt-stdin --json
cycloid sessions send abc123 "retry-safe send" --idempotency-key 1f0e6f1a-...
cycloid sessions send abc123 "also update the tests" --wait --poll-interval 1000 --json
```

Repeatable `--uploaded-file <path>` flags attach local UTF-8 text files to the follow-up prompt. `--idempotency-key <uuid>` is for manually retrying a send that may have reached the server. `--wait` blocks until the sent prompt finishes; use `--poll-interval <ms>` to tune completion polling.

JSON mode returns `{sessionId, promptId?}`.
With `--wait`, JSON mode also includes best-effort result fields when available: `prUrl?`, `publishedBranch?`, `lastBranch?`.

### `cycloid sessions respond <session-id> [answer]`

Answers a pending `question` event from `sessions events --follow`.
Pass the `questionId` from the question event so the answer is durable and safe across reconnects.

```bash
cycloid sessions respond abc123 "Use PostgreSQL" --question-id q_123
printf "Use PostgreSQL" | cycloid sessions respond abc123 --question-id q_123 --answer-stdin --json
```

JSON mode returns the raw respond payload plus `sessionId`.
If the session is no longer waiting for input, the command exits with conflict and points back to `sessions events --follow --json`.

### `cycloid sessions stop <session-id>`

Stops the active run for a session. Idempotent: if no sandbox is active, the server returns `already_stopped`.

```bash
cycloid sessions stop abc123
cycloid sessions stop abc123 --json
```

JSON mode returns `{sessionId, status}`. `status` is the server stop status or, on a 409 stop-block, the block reason; it is an open set. Known values include `stopping`, `stopped`, `already_stopped`, `not_stoppable`, and lifecycle phase names.

### `cycloid sessions get <session-id>`

```bash
cycloid sessions get abc123
cycloid sessions get abc123 --json
```

Human-readable output includes `PR: <url> (<branch>)` when the session has opened a PR, or `Branch: <branch>` when a produced branch is known but no PR URL is present yet. If publishing is still settling, rerun `sessions get`; JSON mode returns the raw session payload, with result fields at `.session.prUrl`, `.session.publishedBranch`, and `.session.lastBranch`.

### `cycloid sessions list`

```bash
cycloid sessions list
cycloid sessions list --status idle --limit 20 --json
cycloid sessions list --search "architect agent" --repo your-org/your-repo
cycloid sessions list --scope business --cursor <cursor>
cycloid sessions list --all --json
```

JSON mode returns `{sessions, nextCursor}`.
`--all` follows cursors until completion and returns `nextCursor: null`.
Search is metadata-only: generated titles and repo metadata.

### `cycloid sessions search <query>`

```bash
cycloid sessions search "architect agent"
cycloid sessions search "mcp debugging" --repo your-org/your-repo --json
cycloid sessions search "repo access" --status idle --scope business --limit 20 --cursor <cursor>
cycloid sessions search "repo access" --all --json
```

Uses the same metadata-only index and filters as `sessions list`: `--status`, `--scope`, `--repo`, `--limit`, `--cursor`, and `--all`.

### `cycloid sessions events <session-id>`

Reads canonical session replay events. Cursors are sequence-based.

```bash
cycloid sessions events abc123 --json
cycloid sessions events abc123 --after-sequence 50 --limit 250 --json
cycloid sessions events abc123 --before-sequence 100 --poll-interval 500 --json
cycloid sessions events abc123 --prompt-id p-123 --json
cycloid sessions events abc123 --follow --json
```

`--after` and `--before` are aliases for `--after-sequence` and `--before-sequence`.

JSON mode without `--follow` returns one JSON object from `/events/history`: `{events: [...], ...}`. Canonical events carry `phase`.

Follow mode emits NDJSON, one `{sequence, type, data}` object per line, until the session becomes idle. Actionable follow-mode signals:

- PR opened or updated: `pr_created` / `pr_updated`; URL at `data.prUrl`.
- Waiting for human input: `question`; question text at `data.question`.
- Terminal: `prompt_completed`, `prompt_failed`, and `session_idle`. Follow JSON mode suppresses lifecycle `status` frames, so key on these event names rather than `waiting_for_input`.

### `cycloid sessions transcript <session-id>`

Renders a session transcript from the stored session export.

```bash
cycloid sessions transcript abc123
cycloid sessions transcript abc123 --json
cycloid sessions transcript abc123 --last 20
```

`--last <n>` renders only the last `n` stored transcript events after fetching the session export.

### `cycloid sessions watch <session-id>`

Watches session activity until the session becomes idle. For machine-readable streaming, prefer `cycloid sessions events --follow --json`.

```bash
cycloid sessions watch abc123
cycloid sessions watch abc123 --poll-interval 500
```

### `cycloid sessions usage <session-id>`

```bash
cycloid sessions usage abc123
cycloid sessions usage abc123 --json
```

### `cycloid repos list`

```bash
cycloid repos list
cycloid repos list --json
```

JSON mode returns `{repos, ssoOrgs}`.

### `cycloid repos branches [repo]`

```bash
cycloid repos branches trycycloid/cycloid
cycloid repos branches https://github.com/trycycloid/cycloid --json
```

JSON mode returns `{branches}`.

### `cycloid repos skills [repo]`

```bash
cycloid repos skills trycycloid/cycloid
cycloid repos skills https://github.com/trycycloid/cycloid --json
```

JSON mode returns `{skills}`.

### `cycloid models list`

```bash
cycloid models list
cycloid models list --json
```

JSON mode returns `{models}`.

### `cycloid automations create <repo-url> [prompt]`

Creates a scheduled automation for a GitHub repo. Create/delete require a write-scoped CLI token; read-scoped tokens can list automations. The server validates repo access, normalizes cron expressions, dedupes retries by repo+cron+prompt, and caps each business at 20 enabled rules.

```bash
cycloid automations create your-org/your-repo "summarize new regressions" --cron "*/15 * * * *"
cycloid automations create your-org/your-repo "audit N+1s" --cron "0 13 * * 5" --model gpt-5.5
printf "summarize new regressions" | cycloid automations create your-org/your-repo --prompt-stdin --cron "*/15 * * * *" --json
cycloid automations create https://github.com/your-org/your-repo - --cron "0 14 * * 1-5" --name "Weekday summary"
```

Use `--model <model>` to pin the model for sessions started by the automation. Backend is derived from the model; non-codex backends such as Claude or opencode are limited to Cycloid team businesses. When `--model` is omitted the codex backend default is used.

JSON mode prints the created rule. Human-readable mode prints the rule ID, repo, normalized cron, and next fire time.

### `cycloid automations list`

```bash
cycloid automations list
cycloid automations list --limit 20 --json
cycloid automations list --cursor <cursor>
cycloid automations list --all --json
```

Default output reads one page. `--all` follows pagination until completion. JSON mode returns `{items, nextCursor}`.

### `cycloid automations delete <id>`

Deletes a scheduled automation. Interactive mode prompts for confirmation; pass `--yes` for non-interactive use. `--json` requires `--yes`.

```bash
cycloid automations delete rule_123
cycloid automations delete rule_123 --yes --json
```

### `cycloid tokens list`

```bash
cycloid tokens list
cycloid tokens list --limit 10 --json
cycloid tokens list --cursor <cursor> --json
cycloid tokens list --all --json
```

`--all` follows cursors until completion and returns `nextCursor: null` in JSON mode.

### `cycloid tokens create`

Creates a CLI token and prints the plaintext token exactly once.

```bash
cycloid tokens create --scope read
cycloid tokens create --scope read --expires-in-days 30 --json
cycloid tokens create --scope read --idempotency-key 1f0e6f1a-...
```

JSON mode returns `{ok, token, id, scope}`.
The plaintext token is shown only once.
Use `--idempotency-key <uuid>` when manually retrying a token create whose first response may have been lost; duplicate keys return `duplicate_request` rather than replaying the raw token.
Read-scoped tokens cannot create write-scoped tokens; the server enforces that and returns 403.

### `cycloid tokens revoke <id>`

```bash
cycloid tokens revoke 42
cycloid tokens revoke 42 --yes --json
```

Under `--json`, `--yes` is required.

## Automation recipes

Run a prompt on a schedule and alert only when the prompt itself fails — `sessions create --wait` makes the exit code reflect the prompt outcome:

```cron
*/15 * * * * printf 'summarize new error-tracker regressions' | \
  ARCANIST_TOKEN=arc_... \
  cycloid sessions create your-org/your-repo --prompt-stdin --wait \
  || notify-send "Cycloid scheduled run failed"
```

Chain commands with `--json` and `jq`:

```bash
SESSION_ID=$(cycloid sessions create your-org/your-repo "audit dependency licenses" --json | jq -r .sessionId)
cycloid sessions events "$SESSION_ID" --follow --json | jq -r 'select(.type == "assistant_message")'
```

Verify a freshly deployed change with a guaranteed-fresh sandbox:

```bash
cycloid sessions create your-org/your-repo "verify the new rate limiter is active" --cold --wait
```

For cron, prefer `ARCANIST_TOKEN` or a logged-in `~/.cycloid/config.json` over passing `--token` on the command line.

To capture the PR URL after a successful run, read the best-effort result fields from `create --wait --json`:

```bash
RESULT=$(cycloid sessions create your-org/your-repo "fix the flaky test" --wait --json)
PR_URL=$(jq -r '.prUrl // empty' <<<"$RESULT")
SESSION_ID=$(jq -r '.sessionId' <<<"$RESULT")
[ -n "$PR_URL" ] || { echo "PR URL not ready for $SESSION_ID" >&2; exit 1; }
```

## Troubleshooting

- **401 on login verification**: token may be invalid or expired. Regenerate in **Settings > CLI Tokens**.
- **401 on a previously working token**: the token may have expired or been revoked in Settings. Regenerate and log in again.
- **`You do not have access to this repository on GitHub`**: the token's user lacks repo access; fix the GitHub connection or use an accessible repo.
- **`command not found`**: run `npm install -g @trycycloid/cli`.
