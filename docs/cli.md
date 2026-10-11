# Cycloid CLI

Command-line interface for creating, observing, and controlling Cycloid sessions.

Published on npm: [@trycycloid/cli](https://www.npmjs.com/package/@trycycloid/cli)

Customer-facing docs ship in [apps/cli/README.md](../apps/cli/README.md), published on the npm package page. This file is the internal reference, additionally covering internal-only commands, publishing, and local development. Keep both in sync; `tests/test_cli/docs.test.ts` guards command sections in each against live `--help` output.

Sandbox template authoring and build flow are covered in [sandbox-templates.md](sandbox-templates.md).

## Agent quick reference

Use canonical `sessions` subcommands.

```bash
export ARCANIST_TOKEN=arc_... # write-scoped for create/send/stop
cycloid auth whoami --json
SESSION_ID=$(cycloid sessions create https://github.com/trycycloid/cycloid "Print the first 10 lines of README.md and stop. Do not make code changes or open a PR." --json | jq -r .sessionId)
cycloid sessions events "$SESSION_ID" --follow --json
```

For exit-code-only automation: `cycloid sessions create <repo> "<prompt>" --wait --json`.

`auth` error `You do not have access to this repository on GitHub` means the token/user lacks repo access; fix login/repo connection or use an accessible repo.

## Install

```bash
npm install -g @trycycloid/cli
```

## Authentication

Generate a CLI token in the UI at **Settings > CLI Tokens**, then:

```bash
cycloid auth login
# paste your arc_... token when prompted; the CLI masks input with `*`
```

Token config is stored at `~/.cycloid/config.json`. Multiple active tokens per user are supported; revoke independently when a device or workflow no longer needs access.

For routine production debugging, create a read-scoped token. Use a write-scoped token only to create sessions, send prompts, or stop runs.

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

`--token` and `--api-url` are for one-off invocations. Prefer `ARCANIST_TOKEN` over `--token` for persistent use; CLI flags can appear in shell history and process lists.

All API URLs are validated before authenticated requests. Non-local hosts must use HTTPS, and API URLs must not embed credentials; use `--token` or `ARCANIST_TOKEN` for authentication.
Each HTTP request times out after `ARCANIST_HTTP_TIMEOUT_MS` milliseconds, default `30000`.
The value must be between `1000` and `600000`; invalid values fail closed instead of falling back silently.

### How the CLI picks its environment

`cycloid auth login` writes only the global config at `~/.cycloid/config.json`.
That global config should normally point at production.

In a git repo, the CLI also looks for `.cycloid-cli.json` from the current directory up to the git root.
The nearest file wins, and discovery stops at the git root; files above the repo are ignored.
Outside a git repo, project discovery is skipped.

Project config is for local development only.
The file must contain both `apiUrl` and `token`, and `apiUrl` must be loopback (`localhost`, `127.0.0.1`, or `::1`).
If a project file exists but is malformed, incomplete, or non-loopback, the CLI fails closed instead of falling through to production.
When a project file is active, partial env or flag overrides are rejected; set both `ARCANIST_API_URL` and `ARCANIST_TOKEN`, pass both `--api-url` and `--token`, or set neither.

`bash scripts/worktree-setup.sh` creates `.cycloid-cli.json` automatically after assigning `.worktree-ports`.
It mints or reuses a write-scoped local D1 CLI token and stores the raw token in `.cycloid-local-token`; both files are gitignored and written mode `0600`.
When project config is used, human-readable commands print `using .cycloid-cli.json -> http://localhost:<port>` to stderr.
`--json` suppresses that notice.

To run a production command from inside a local worktree, use the literal repo script path:

```bash
scripts/arc-prod auth whoami --json
scripts/arc-prod sessions list
```

`scripts/arc-prod` reads both `apiUrl` and `token` from the existing global config and sets `ARCANIST_API_URL` plus `ARCANIST_TOKEN` for that one command.
It does not create a second production token store.

## Global Flags

```bash
cycloid --json
cycloid --quiet
cycloid --api-url http://localhost:3000
cycloid --token arc_...
cycloid --no-color
```

When `--json` is active, successful output is machine-readable and newline-terminated. Errors are written to stderr as:

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

Mutation commands send an `Idempotency-Key` header. The CLI does not auto-retry mutation endpoints; the caller must explicitly retry with the same `--idempotency-key`. `--idempotency-key` is available on `sessions create`, `sessions send`, `tokens create`, and `sandbox build`; `sessions create` derives endpoint-scoped header values from the caller-provided key for its session and prompt requests. `tokens create` and `sandbox build` use auto-random keys by default, so only an explicit key makes cross-invocation retries safe.

## Adding CLI Commands

The CLI is primarily driven by local coding agents. When adding or changing command surface, optimize for a caller that discovers behavior from `--help`, parses stdout, and recovers from failures without reading source.

- Prefer canonical nested commands over aliases. Do not document or add top-level shortcuts unless they are intentionally supported forever.
- Every command with `--json` must document its exact success shape in `addHelpText("after", ...)` and in this file. Keep stdout as one JSON value or documented NDJSON; write warnings, progress, and errors to stderr.
- Do not add free-form hints, banners, or prose fields to stable JSON payloads unless the field is part of the contract. Put guidance in help text and human-readable output.
- Async create/start commands should return durable handles immediately (`sessionId`, `promptId`, URLs) and show the follow command in human mode. If a `--wait --json` mode exists, include best-effort final result fields when cheap, without failing an otherwise successful run when result lookup fails.
- Streaming JSON must declare whether it is a single JSON object or NDJSON, the line shape, and the event names agents should key on. Do not imply lifecycle phases are emitted when the stream actually emits SSE event names.
- Treat enum-like server strings as open sets unless the client owns and validates the full set. Document known values as examples, not exhaustive unions.
- Auth and permission failures must use the shared JSON error envelope, actionable hints, and stable exit codes. Do not rely on `auth whoami --json` as a fixed precheck shape unless that command is explicitly tightened.
- Mutation commands must be retry-safe with idempotency keys when duplicate execution would be harmful. Do not hide expensive, destructive, or customer-visible behavior behind silent defaults.
- Tests for new command surface must cover human output, JSON output, error exit behavior, docs/help text, and docs-vs-help flag parity. If a command adds machine-readable output that `tests/test_cli/docs.test.ts` cannot infer, add explicit help-text or shape assertions.

## Commands

### `cycloid auth login`

```bash
cycloid auth login
printf "arc_..." | cycloid auth login --token-stdin
cycloid auth login --api-url http://localhost:3000
```

### `cycloid auth whoami`

```bash
cycloid auth whoami
ARCANIST_TOKEN=arc_... cycloid auth whoami --json
```

JSON mode prints the raw `/api/auth/whoami` API response (passthrough, not a fixed client-side shape). Fields currently include `userId`, `email`, `tokenId`, `tokenScope`, and `authMode`.

### `cycloid codex login`

Authenticates a Codex/ChatGPT subscription and stores it for your Codex sessions, then activates it (turns on "use subscription auth for OpenAI sessions"). Runs the Codex CLI device-authorization login locally under a temporary `CODEX_HOME`, then uploads the resulting `auth.json` to Cycloid over the same endpoint the Settings UI uses. The credential is stored encrypted per user and is never written to your default `~/.codex`. If activation fails the credential is still saved; run `cycloid codex use on`.

Requires a write-scoped token and a workspace with Codex subscription auth enabled (see `cycloid codex status`).

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
cycloid sessions create https://github.com/trycycloid/cycloid "fix the login bug"
cycloid sessions create trycycloid/cycloid "continue this work" --start-branch wip/resume-me
cycloid sessions create trycycloid/cycloid "finish this PR" --continue-pr https://github.com/trycycloid/cycloid/pull/123
printf "add tests" | cycloid sessions create trycycloid/cycloid --prompt-stdin --json
printf "add tests" | cycloid sessions create trycycloid/cycloid --prompt-stdin --wait
cycloid sessions create trycycloid/cycloid - --model gpt-5.4
cycloid sessions create trycycloid/cycloid "port to claude" --backend claude_code --model claude-opus-4-8
cycloid sessions create trycycloid/cycloid "refactor auth" --reasoning-effort xhigh
cycloid sessions create trycycloid/cycloid "verify this automatically" --auto-verify
cycloid sessions create trycycloid/cycloid "fix release branch" --base-branch release/2026-06
cycloid sessions create trycycloid/cycloid "review the trace" --uploaded-file trace.txt
cycloid sessions create trycycloid/cycloid "verify the deployed change" --cold
cycloid sessions create trycycloid/cycloid "retry-safe create" --idempotency-key 1f0e6f1a-...
```

`--backend` picks the agent runtime backend: `codex` (default) or `claude_code`. `--model` must be valid for the chosen backend — codex runs OpenAI models (`gpt-5.4` default, `gpt-5.5`), `claude_code` runs Anthropic models (`claude-opus-4-8` default, `claude-sonnet-4-6`, `claude-fable-5`) — and the CLI rejects a mismatch before any network call. When `--model` is omitted the backend default is used. `claude_code` sessions require a business or user Anthropic API key configured in Settings.

`--wait` blocks until the created prompt finishes. Human-readable mode streams session activity until the session becomes idle and prints the PR/branch line when available; JSON mode waits quietly and prints the create payload only after the prompt completes successfully. With `--wait`, the command exits non-zero if the prompt finishes with `status: failed`, making it suitable for cron or schedulers that alert on command failure. Use `--poll-interval <ms>` to tune completion polling.

Use `--auto-verify` to opt the created session into automatic QA verification after PR creation. Auto verification is default-off at session create unless another surface explicitly enables it.

Use `--base-branch <branch>` to target a non-default base branch. The CLI only validates the branch value is non-empty; branch existence is checked later by the session runtime.

Use `--start-branch <branch>` to resume an existing branch with its history instead of forking a fresh branch off base (the sandbox checks out that branch; pushes update it). The control plane verifies the branch exists on the remote, failing closed with a clear error if not. Distinct from `--base-branch`, which stays the PR merge target.

Use `--continue-pr <url>` to continue an open same-repo pull request. The control plane checks out the PR head branch before the prompt runs. `--continue-mode update-pr` updates the referenced PR; `--continue-mode new-pr` starts from that PR head but leaves publish free to open a fresh PR. `auto` is the default and currently resolves to same-PR update for supported open same-repo PRs.

Repeatable `--uploaded-file <path>` flags attach local UTF-8 text files to the created prompt through the same `uploadedFiles` API payload used by the web UI. File names come from the local basename; directory components are not sent.

`--cold` is a deprecated no-op kept for backward compatibility. Sessions always start from a fresh sandbox (the warm pool was removed), so the flag has no effect.

`--idempotency-key <uuid>` is for manually retrying a create request that may have reached the server.
The CLI derives separate session and prompt idempotency keys from the provided value.

Use `--onboarding` to create an onboarding session: the agent authors the repo's `.cycloid.json`, `.cycloid/` runtime files, `CYCLOID.md`, and conditionally `.cycloid/sandbox.yaml` + `.cycloid/sandbox.layer.Dockerfile` (when the base sandbox lacks a needed toolchain), proves what it can inside its sandbox, and opens the setup PR ready for review. Team use; not part of the external API surface.

JSON mode returns `{sessionId, sessionUrl?, repoUrl, model?, agentRuntimeBackend?, reasoningEffort?, autoVerify?, baseBranch?, startBranch?, continuePrUrl?, continueMode?, onboarding?, promptId?}`. `sessionUrl` is emitted only when the server returns it; `agentRuntimeBackend` only when `--backend` is passed; other optional flags echo the request and are not server confirmations. With `--wait`, JSON mode also includes best-effort result fields when available: `prUrl?`, `publishedBranch?`, `lastBranch?`.

### `cycloid sessions qa <pr-url>`

Starts a QA verification session for an existing GitHub pull request.

```bash
cycloid sessions qa https://github.com/trycycloid/cycloid/pull/123
cycloid sessions qa https://github.com/trycycloid/cycloid/pull/123 --model gpt-5.4
cycloid sessions qa https://github.com/trycycloid/cycloid/pull/123 --backend claude_code --model claude-opus-4-8
cycloid sessions qa https://github.com/trycycloid/cycloid/pull/123 --reasoning-effort xhigh
cycloid sessions qa https://github.com/trycycloid/cycloid/pull/123 --wait
cycloid sessions qa https://github.com/trycycloid/cycloid/pull/123 --idempotency-key 1f0e6f1a-...
```

The PR URL must be `https://github.com/<owner>/<repo>/pull/<number>`.
The CLI derives the repo from that URL, creates a QA session with `qa: true` and `targetPrUrl`, then enqueues the verifier prompt (skipped when the server signals `promptAlreadyEnqueued`).
Inspect progress with the session URL or the session events stream.

`--backend` picks the agent runtime backend: `codex` (default), `claude_code`, or `opencode`.
`--model` must be valid for the chosen backend, and the CLI rejects mismatches before any network call.
When `--model` is omitted, the backend default is used.

`--wait` blocks until the enqueued QA prompt finishes and exits non-zero if the prompt fails.
Human-readable mode streams session activity and prints the target PR when the prompt settles.
JSON mode waits quietly and prints the create payload after the prompt completes successfully.
Use `--poll-interval <ms>` to tune completion polling.

`--idempotency-key <uuid>` is for manually retrying a QA request that may have reached the server.
The CLI derives separate session and prompt idempotency keys from the provided value.
If session creation succeeds but prompt enqueue fails, retry the same command with the same `--idempotency-key` so the create request replays the existing session and the CLI can retry prompt enqueue.

JSON mode returns `{sessionId, sessionUrl?, repoUrl, targetPrUrl, model?, agentRuntimeBackend?, reasoningEffort?, promptId?}`.
`promptId` is absent when the coordinator already enqueued the verifier prompt (no duplicate send); `sessionUrl` is emitted only when the server returns it; `agentRuntimeBackend` only when `--backend` is passed.
Active-verifier and per-PR run-limit conflicts both return the shared `conflict` error envelope and exit code `4`; active-verifier errors include the existing session handle when the server returns it.

### Cron-friendly runs

To run a prompt every 15 minutes and alert only when the prompt itself fails, use `sessions create --wait` so the CLI exit code reflects the prompt outcome:

```cron
*/15 * * * * printf 'summarize new Sentry regressions' | \
  ARCANIST_TOKEN=arc_... \
  cycloid sessions create trycycloid/cycloid --prompt-stdin --wait \
  || osascript -e 'display notification "Cycloid scheduled run failed" with title "Cycloid cron"'
```

For cron, prefer `ARCANIST_TOKEN` or a logged-in `~/.cycloid/config.json` over passing `--token` on the command line.

To capture the PR URL after a successful run, read the best-effort result fields from `create --wait --json`:

```bash
RESULT=$(cycloid sessions create trycycloid/cycloid "fix the flaky test" --wait --json)
PR_URL=$(jq -r '.prUrl // empty' <<<"$RESULT")
SESSION_ID=$(jq -r '.sessionId' <<<"$RESULT")
[ -n "$PR_URL" ] || { echo "PR URL not ready for $SESSION_ID" >&2; exit 1; }
```

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

### `cycloid sessions list`

```bash
cycloid sessions list
cycloid sessions list --status idle --limit 20 --json
cycloid sessions list --search "architect agent" --repo trycycloid/cycloid
cycloid sessions list --scope business --cursor <cursor>
cycloid sessions list --all --json
```

JSON mode returns `{sessions, nextCursor}`.
`--all` follows cursors until completion and returns `nextCursor: null`.

Search is metadata-only: generated titles and repo metadata.

### `cycloid sessions search <query>`

```bash
cycloid sessions search "architect agent"
cycloid sessions search "mcp debugging" --repo trycycloid/cycloid --json
cycloid sessions search "repo access" --status idle --scope business --repo trycycloid/cycloid --limit 20 --cursor <cursor>
cycloid sessions search "repo access" --all --json
```

Search uses the same metadata-only index and filters as `sessions list`: `--status`, `--scope`, `--repo`, `--limit`, `--cursor`, and `--all`.

### `cycloid sessions get <session-id>`

```bash
cycloid sessions get abc123
cycloid sessions get abc123 --json
```

Human-readable output includes `PR: <url> (<branch>)` when the session has opened a PR, or `Branch: <branch>` when a produced branch is known but no PR URL is present yet. If publishing is still settling, rerun `sessions get`; JSON mode returns the raw session payload, with result fields at `.session.prUrl`, `.session.publishedBranch`, `.session.lastBranch`.

### `cycloid sessions events <session-id>`

Reads canonical replay events from `/api/sessions/:id/events/history`. Cursors are sequence-based.

```bash
cycloid sessions events abc123 --json
cycloid sessions events abc123 --after-sequence 50 --limit 250 --json
cycloid sessions events abc123 --after 50 --limit 250 --json
cycloid sessions events abc123 --before-sequence 100 --poll-interval 500 --json
cycloid sessions events abc123 --before 100 --poll-interval 500 --json
cycloid sessions events abc123 --prompt-id p-123 --json
cycloid sessions events abc123 --follow --json
```

`--after` and `--before` are aliases for `--after-sequence` and `--before-sequence`.

JSON mode without `--follow` returns one JSON object from `/events/history`: `{events: [...], ...}`. Canonical events carry `phase`.

Follow mode emits NDJSON, one `{sequence, type, data}` object per line. Actionable follow-mode signals:

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

Watches session activity until the session becomes idle.

```bash
cycloid sessions watch abc123
cycloid sessions watch abc123 --poll-interval 500
```

Agents should prefer `cycloid sessions events --follow --json`.

### `cycloid sessions usage <session-id>`

```bash
cycloid sessions usage abc123
cycloid sessions usage abc123 --json
```

### `cycloid repos list`

Lists repositories accessible to the authenticated user.

```bash
cycloid repos list
cycloid repos list --json
```

JSON mode returns `{repos, ssoOrgs}`.
`ssoOrgs` identifies GitHub organizations whose repos may be withheld by SSO authorization.

### `cycloid repos branches [repo]`

Lists branches for a repository.
When `repo` is omitted, the CLI uses the current git `origin` remote.

```bash
cycloid repos branches trycycloid/cycloid
cycloid repos branches https://github.com/trycycloid/cycloid --json
```

JSON mode returns `{branches}`.

### `cycloid repos skills [repo]`

Lists skills declared by a repository.
When `repo` is omitted, the CLI uses the current git `origin` remote.

```bash
cycloid repos skills trycycloid/cycloid
cycloid repos skills https://github.com/trycycloid/cycloid --json
```

JSON mode returns `{skills}`.

### `cycloid models list`

Lists available session-start models.

```bash
cycloid models list
cycloid models list --json
```

JSON mode returns `{models}`.
Each model includes `id`, `backend`, `backends`, and `default`.

### `cycloid automations create <repo-url> [prompt]`

Creates a scheduled automation for a GitHub repo. Create/delete require a write-scoped token; read-scoped tokens can list. The server validates repo access, normalizes cron expressions, dedupes retries by repo+cron+prompt, and caps each business at 20 enabled rules.

```bash
cycloid automations create trycycloid/cycloid "summarize new regressions" --cron "*/15 * * * *"
cycloid automations create trycycloid/cycloid "audit N+1s" --cron "0 13 * * 5" --model gpt-5.5
printf "summarize new regressions" | cycloid automations create trycycloid/cycloid --prompt-stdin --cron "*/15 * * * *" --json
cycloid automations create https://github.com/trycycloid/cycloid - --cron "0 14 * * 1-5" --name "Weekday summary"
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

### `cycloid sandbox build [source-repo]`

Internal-only: builds repo-sourced sandbox layers.

```bash
cycloid sandbox build trycycloid/cycloid --target-repo trycycloid/cycloid --business biz_123 --wait --follow --poll-interval 1000
cycloid sandbox build trycycloid/cycloid --manifest .cycloid/sandbox.yaml --ref main --idempotency-key 1f0e6f1a-... --json
```

JSON mode without `--wait` or `--follow` returns one object: `{ok, buildRequest}`.
With `--wait` and without `--follow`, JSON mode returns two objects: the initial `{ok, buildRequest}` then the terminal `{ok, buildRequest}`.
With `--follow`, JSON mode emits NDJSON lines: `{type:"logs", logs:[...]}` for non-empty log batches during polling and `{type:"build", buildRequest:{...}}` as the terminal line.

### `cycloid sandbox logs <build-id>`

Internal-only: reads sandbox layer build logs.

```bash
cycloid sandbox logs build_123 --business biz_123 --follow --poll-interval 1000
cycloid sandbox logs build_123 --after-sequence 10 --limit 20 --json
```

JSON mode without `--follow` returns one object: `{ok, logs}`.
With `--follow`, JSON mode emits NDJSON lines for non-empty batches: `{type:"logs", logs:[...]}`.

### `cycloid egress source set <source-repo>`

Internal-only: sets the source repo for `.cycloid/egress-allowlist.txt`.

```bash
cycloid egress source set trycycloid/cycloid --business biz_123
```

### `cycloid egress source get`

Internal-only: prints the configured egress allowlist source repo.

```bash
cycloid egress source get --business biz_123
```

### `cycloid egress add <domains...>`

Internal-only: opens or updates a PR adding domains to the egress allowlist source file.

```bash
cycloid egress add api.example.com assets.example.com --business biz_123 --reason "integration smoke"
```

### `cycloid egress sync`

Internal-only: applies the merged egress allowlist source file to runtime policy.

```bash
cycloid egress sync --business biz_123
```

### `cycloid egress validate [path]`

Internal-only: validates a local egress allowlist source file.

```bash
cycloid egress validate .cycloid/egress-allowlist.txt
```

### `cycloid tokens revoke <id>`

```bash
cycloid tokens revoke 42
cycloid tokens revoke 42 --yes --json
```

Under `--json`, `--yes` is required.

### `cycloid test-creds list <repo>`

Internal-only: manages repo-scoped E2E test credentials referenced by `appRuntime.e2e.credentials` in `.cycloid.json`. Not part of the customer-facing README.

```bash
cycloid test-creds list trycycloid/cycloid --business biz-1
```

`--business <id>` is required on every `test-creds` subcommand.

### `cycloid test-creds set <repo> <name>`

Sets or rotates a credential value. `<name>` must match a `credentials[].name` entry in `.cycloid.json`. Provide the value with `--value-stdin` or `--value-file`; `--value` is unsafe on shared shells because flag values appear in shell history and process lists. Never inline real credentials in docs or scripts.

```bash
printf '%s' "$E2E_PASS" | cycloid test-creds set trycycloid/cycloid test_user_password --business biz-1 --value-stdin
cycloid test-creds set trycycloid/cycloid test_user_email --business biz-1 --value-file ./email.txt
```

### `cycloid test-creds delete <repo> <name>`

```bash
cycloid test-creds delete trycycloid/cycloid test_user_password --business biz-1 --yes
```

### `cycloid egress source set <repo>`

Configures the workspace's egress allowlist source repo. The source file lives at `.cycloid/egress-allowlist.txt` on the repo's default branch.

```bash
cycloid egress source set acme/policy --business biz-1
cycloid egress source set https://github.com/acme/policy --json
```

### `cycloid egress source get`

Shows the configured egress allowlist source repo and current resolved domains.

```bash
cycloid egress source get --business biz-1
cycloid egress source get --json
```

### `cycloid egress add <domain...>`

Opens or updates a PR adding the specified domains to the egress allowlist source file. Domains are normalized and deduplicated.

```bash
cycloid egress add api.acme.test registry.acme.test --business biz-1
cycloid egress add api.acme.test --reason "onboarding" --json
```

### `cycloid egress sync`

Applies the merged egress allowlist source file to the runtime D1 business policy. Run after the source file PR merges.

```bash
cycloid egress sync --business biz-1
cycloid egress sync --json
```

### `cycloid egress validate [path]`

Validates a local egress allowlist source file. Defaults to `.cycloid/egress-allowlist.txt` in the current directory.

```bash
cycloid egress validate
cycloid egress validate custom-egress.txt --json
```

## Local development

```bash
npm run build -w @trycycloid/cli
./apps/cli/dist/index.js --help
```

## Publishing

```bash
cd apps/cli && npm publish --access public
```

Requires npm login as the `parappally` account (owner of `@trycycloid` org). 2FA required.

## How it works

- Auth: Bearer token with `arc_` prefix, resolved via SHA-256 hash lookup in D1.
- API: uses `/api/sessions`, session subroutes, `/api/auth/whoami`, and `/api/cli-tokens`.
- Config: `~/.cycloid/config.json` stores `apiUrl` and `token`.
- User agent: requests include `User-Agent: cycloid-cli/<version>`.

## Agent Checklist

New or changed commands should be:

- non-interactive by default, with flags over prompts
- discoverable through layered `--help` examples
- usable with stdin where prompt text is accepted
- safe under `--json`, including JSON-formatted errors
- explicit about idempotency and destructive confirmation
- covered by focused CLI tests for parsing, output shape, and error mapping

## Troubleshooting

- **401 on login verification**: token may be invalid or expired. Regenerate in the UI.
- **`command not found`**: run `npm install -g @trycycloid/cli`.
- **401 on a previously working token**: the token may have expired or been revoked in Settings. Regenerate a token and log in again.
