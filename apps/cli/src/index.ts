#!/usr/bin/env node
import { createRequire } from "node:module";

import { Command } from "commander";

import { whoamiCommand } from "./commands/auth.js";
import { createAutomationCommand, deleteAutomationCommand, listAutomationsCommand } from "./commands/automations.js";
import { codexLoginCommand, codexLogoutCommand, codexStatusCommand, codexUseCommand } from "./commands/codex.js";
import { createCommand } from "./commands/create.js";
import {
  egressAddCommand,
  egressSourceGetCommand,
  egressSourceSetCommand,
  egressSyncCommand,
  egressValidateCommand,
} from "./commands/egress.js";
import { loginCommand } from "./commands/login.js";
import { messageCommand } from "./commands/message.js";
import { modelsListCommand } from "./commands/models.js";
import { qaCommand } from "./commands/qa.js";
import { repoBranchesCommand, repoSkillsCommand, reposListCommand } from "./commands/repos.js";
import { respondCommand } from "./commands/respond.js";
import {
  sandboxAssignDefaultCommand,
  sandboxAssignRepoCommand,
  sandboxBuildCommand,
  sandboxHistoryCommand,
  sandboxInitCommand,
  sandboxLogsCommand,
  sandboxRebuildStaleCommand,
  sandboxStatusCommand,
  sandboxUnassignDefaultCommand,
  sandboxUnassignRepoCommand,
  sandboxValidateCommand,
} from "./commands/sandbox.js";
import {
  getSessionCommand,
  listSessionsCommand,
  searchSessionsCommand,
  sessionEventsCommand,
  usageCommand,
} from "./commands/sessions.js";
import { stopCommand } from "./commands/stop.js";
import {
  deleteTestCredentialCommand,
  listTestCredentialsCommand,
  setTestCredentialCommand,
} from "./commands/test-creds.js";
import { createTokenCommand, listTokensCommand, revokeTokenCommand } from "./commands/tokens.js";
import { transcriptCommand } from "./commands/transcript.js";
import { watchCommand } from "./commands/watch.js";
import { DEFAULT_WATCH_POLL_INTERVAL_MS } from "./constants/watch.js";
import { CliError, EXIT_CODE_INTERRUPTED, formatJsonError, toCliError } from "./errors.js";
import { applyColorEnvironment, getRuntimeOptions } from "./runtime.js";
import { collectUploadedFileOption } from "./uploads.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const program = new Command()
  .name("cycloid")
  .description("Cycloid CLI")
  .version(version)
  .option("--json", "Output machine-readable JSON")
  .option("--quiet", "Suppress non-essential stderr output")
  .option("--api-url <url>", "Override API URL. Prefer ARCANIST_API_URL for persistent use")
  .option(
    "--token <token>",
    "Override API token. Prefer ARCANIST_TOKEN because flags can be visible in shell history and process lists",
  )
  .option("--no-color", "Disable color output")
  .exitOverride()
  .addHelpText(
    "after",
    `
Examples:
  cycloid auth login --token-stdin
  cycloid sessions create https://github.com/org/repo "fix bug" --json | jq -r .sessionId
  printf "fix bug" | cycloid sessions create https://github.com/org/repo --prompt-stdin --json
  cycloid sessions events <session-id> --follow --json

Exit codes:
  0 ok, 1 user/input, 2 auth, 3 not found, 4 conflict, 10 server/network, 130 interrupted
`,
  );

program.configureOutput({
  writeErr: (str) => process.stderr.write(str),
});

program.hook("preAction", (_thisCommand, actionCommand) => {
  applyColorEnvironment(getRuntimeOptions(actionCommand));
});

function addCreateOptions(cmd: Command): Command {
  return cmd
    .argument("<repo-url>", "Repository URL")
    .argument("[prompt]", "Prompt to send, or '-' to read stdin")
    .option("--model <model>", "Model to use")
    .option("--backend <backend>", "Agent runtime backend: codex (default), claude_code, or opencode")
    .option("--reasoning-effort <effort>", "Reasoning effort to use for models that support it")
    .option("--auto-verify", "Opt this session into automatic QA verification after PR creation")
    .option("--base-branch <branch>", "Base branch to create the session against (defaults to the repo default branch)")
    .option(
      "--start-branch <branch>",
      "Resume an existing branch with its history instead of forking a new one off base",
    )
    .option("--continue-pr <url>", "Continue from an existing same-repo pull request")
    .option("--continue-mode <mode>", "Continuation mode: auto (default), update-pr, or new-pr")
    .option("--prompt-stdin", "Read prompt from stdin")
    .option(
      "--uploaded-file <path>",
      "Attach a local text file to the prompt as uploadedFiles; repeat for multiple files",
      collectUploadedFileOption,
    )
    .option("--wait", "Wait for the created prompt to finish and exit non-zero if it fails")
    .option(
      "--poll-interval <ms>",
      "Polling interval in milliseconds while waiting",
      String(DEFAULT_WATCH_POLL_INTERVAL_MS),
    )
    .option("--idempotency-key <uuid>", "Request idempotency key for safe manual retries")
    .option("--cold", "Deprecated no-op; sessions always start from a fresh sandbox")
    .option("--onboarding", "Create an onboarding session that authors the repo's Cycloid configuration")
    .addHelpText(
      "after",
      `
Examples:
  cycloid sessions create https://github.com/org/repo "fix bug"
  cycloid sessions create https://github.com/org/repo "finish this PR" --continue-pr https://github.com/org/repo/pull/123
  cycloid sessions create https://github.com/org/repo "review this trace" --uploaded-file trace.txt
  printf "fix bug" | cycloid sessions create https://github.com/org/repo --prompt-stdin --json
  printf "fix bug" | cycloid sessions create https://github.com/org/repo --prompt-stdin --wait
  cycloid sessions create https://github.com/org/repo - --json | jq -r .sessionId | xargs -I{} cycloid sessions events {} --follow --json

JSON:
JSON mode returns {sessionId, sessionUrl?, repoUrl, model?, agentRuntimeBackend?, reasoningEffort?, autoVerify?, baseBranch?, startBranch?, continuePrUrl?, continueMode?, onboarding?, promptId?}
--wait --json also includes best-effort result fields when available: prUrl?, publishedBranch?, lastBranch?
  Follow async progress with: cycloid sessions events <session-id> --follow --json
`,
    );
}

function addSendOptions(cmd: Command): Command {
  return cmd
    .argument("<session-id>", "Session ID")
    .argument("[prompt]", "Prompt to send, or '-' to read stdin")
    .option("--prompt-stdin", "Read prompt from stdin")
    .option(
      "--uploaded-file <path>",
      "Attach a local text file to the prompt as uploadedFiles; repeat for multiple files",
      collectUploadedFileOption,
    )
    .option("--idempotency-key <uuid>", "Request idempotency key for safe manual retries")
    .option("--wait", "Wait for the sent prompt to finish")
    .option("--poll-interval <ms>", "Polling interval in milliseconds")
    .addHelpText(
      "after",
      `
Examples:
  cycloid sessions send <session-id> "also update tests"
  cycloid sessions send <session-id> "use this log" --uploaded-file failing.log
  printf "also update tests" | cycloid sessions send <session-id> --prompt-stdin --json
  cycloid sessions send <session-id> "also update tests" --wait --json

JSON:
JSON mode returns {sessionId, promptId?}
--wait --json also includes best-effort result fields when available: prUrl?, publishedBranch?, lastBranch?
`,
    );
}

function addQaOptions(cmd: Command): Command {
  return cmd
    .argument("<pr-url>", "GitHub pull request URL to QA")
    .option("--model <model>", "Model to use")
    .option("--backend <backend>", "Agent runtime backend: codex (default), claude_code, or opencode")
    .option("--reasoning-effort <effort>", "Reasoning effort to use for models that support it")
    .option("--wait", "Wait for the QA prompt to finish and exit non-zero if it fails")
    .option(
      "--poll-interval <ms>",
      "Polling interval in milliseconds while waiting",
      String(DEFAULT_WATCH_POLL_INTERVAL_MS),
    )
    .option("--idempotency-key <uuid>", "Request idempotency key for safe manual retries")
    .addHelpText(
      "after",
      `
Examples:
  cycloid sessions qa https://github.com/org/repo/pull/123
  cycloid sessions qa https://github.com/org/repo/pull/123 --model gpt-5.4 --wait
  cycloid sessions qa https://github.com/org/repo/pull/123 --idempotency-key 1f0e6f1a-...

JSON:
JSON mode returns {sessionId, sessionUrl?, repoUrl, targetPrUrl, model?, agentRuntimeBackend?, reasoningEffort?, promptId?}
  Inspect progress with the session URL or the session events stream.
`,
    );
}

const auth = program.command("auth").description("Authentication commands");
auth
  .command("login")
  .description("Authenticate with a personal access token")
  .option("--token-stdin", "Read token from stdin instead of interactive prompt")
  .option("--api-url <url>", "Set custom API URL")
  .addHelpText(
    "after",
    `
Examples:
  cycloid auth login
  printf "arc_..." | cycloid auth login --token-stdin
  ARCANIST_TOKEN=arc_... cycloid auth whoami --json
`,
  )
  .action((options, command) => loginCommand(options, command));
auth
  .command("whoami")
  .description("Print the authenticated user and token scope")
  .addHelpText(
    "after",
    `
Examples:
  cycloid auth whoami
  ARCANIST_TOKEN=arc_... cycloid auth whoami --json
`,
  )
  .action((options, command) => whoamiCommand(options, command));

const codex = program.command("codex").description("Codex subscription (bring-your-own-subscription) commands");
codex
  .command("login")
  .description("Authenticate a Codex/ChatGPT subscription and store it for your Codex sessions")
  .option("--codex-path <path>", "Path to the codex executable (default: codex on PATH, or ARCANIST_CODEX_BIN)")
  .addHelpText(
    "after",
    `
Runs the Codex CLI device-authorization login locally under a temporary CODEX_HOME, then uploads
the resulting auth.json to Cycloid (encrypted, per user) and activates it. Your workspace must have
Codex subscription auth enabled. The credential is never written to your default ~/.codex.

Examples:
  cycloid codex login
  cycloid codex login --codex-path /usr/local/bin/codex
`,
  )
  .action((options, command) => codexLoginCommand(options, command));
codex
  .command("use <state>")
  .description("Turn using your saved Codex subscription auth for OpenAI sessions on or off (state: on|off)")
  .action((state, options, command) => codexUseCommand(state, options, command));
codex
  .command("status")
  .description("Show whether your workspace is eligible and whether a Codex subscription auth is saved")
  .action((options, command) => codexStatusCommand(options, command));
codex
  .command("logout")
  .description("Deactivate the selector and remove the stored Codex subscription auth for your user")
  .action((options, command) => codexLogoutCommand(options, command));

const sessions = program.command("sessions").description("Session commands");
addCreateOptions(sessions.command("create").description("Create a session and send a prompt")).action(
  (repoUrl, prompt, options, command) => createCommand(repoUrl, prompt, options, command),
);
addSendOptions(sessions.command("send").description("Send a message to an existing session")).action(
  (sessionId, prompt, options, command) => messageCommand(sessionId, prompt, options, command),
);
addQaOptions(sessions.command("qa").description("Start a QA verification session for a GitHub pull request")).action(
  (prUrl, options, command) => qaCommand(prUrl, options, command),
);
sessions
  .command("respond")
  .description("Answer a pending session question")
  .argument("<session-id>", "Session ID")
  .argument("[answer]", "Answer text, or '-' to read stdin")
  .option("--answer-stdin", "Read answer from stdin")
  .requiredOption("--question-id <id>", "Question ID from the question event")
  .addHelpText(
    "after",
    `
Examples:
  cycloid sessions respond <session-id> "Use PostgreSQL" --question-id q_123
  printf "Use PostgreSQL" | cycloid sessions respond <session-id> --question-id q_123 --answer-stdin --json

JSON:
JSON mode returns the raw respond payload plus sessionId.
`,
  )
  .action((sessionId, answer, options, command) => respondCommand(sessionId, answer, options, command));
sessions
  .command("stop")
  .description("Stop the active run for a session")
  .argument("<session-id>", "Session ID")
  .addHelpText(
    "after",
    `
Examples:
  cycloid sessions stop <session-id>
  cycloid sessions stop <session-id> --json

JSON:
JSON mode returns {sessionId, status}
  status is the server stop status or 409 stop-block reason. Known values include stopping, stopped, already_stopped, not_stoppable, and lifecycle phase names.
`,
  )
  .action((sessionId, options, command) => stopCommand(sessionId, options, command));
sessions
  .command("get")
  .description("Get session details")
  .argument("<session-id>", "Session ID")
  .addHelpText(
    "after",
    `
Examples:
  cycloid sessions get <session-id>
  cycloid sessions get <session-id> --json

JSON:
JSON mode returns the raw session payload. Result fields are at .session.prUrl, .session.publishedBranch, and .session.lastBranch.
`,
  )
  .action((sessionId, options, command) => getSessionCommand(sessionId, options, command));
sessions
  .command("list")
  .description("List sessions")
  .option("--status <status>", "Filter by session status")
  .option("--scope <scope>", "Session scope: mine or business")
  .option("--search <query>", "Search session titles and repo metadata")
  .option("--repo <repo>", "Filter by repo metadata")
  .option("--limit <n>", "Maximum sessions to return")
  .option("--cursor <cursor>", "Pagination cursor")
  .option("--all", "Fetch all pages")
  .addHelpText(
    "after",
    `
Examples:
  cycloid sessions list
  cycloid sessions list --status idle --json
  cycloid sessions list --search "architect agent" --repo owner/repo
  cycloid sessions list --all --json

JSON:
JSON mode returns {sessions, nextCursor}. --all follows cursors until nextCursor is null.
`,
  )
  .action((options, command) => listSessionsCommand(options, command));
sessions
  .command("search")
  .description("Search sessions by title and repo metadata")
  .argument("<query>", "Search query")
  .option("--status <status>", "Filter by session status")
  .option("--scope <scope>", "Session scope: mine or business")
  .option("--repo <repo>", "Filter by repo metadata")
  .option("--limit <n>", "Maximum sessions to return")
  .option("--cursor <cursor>", "Pagination cursor")
  .option("--all", "Fetch all pages")
  .addHelpText(
    "after",
    `
Examples:
  cycloid sessions search "architect agent"
  cycloid sessions search "mcp debugging" --repo owner/repo --json
  cycloid sessions search "repo access" --all --json

JSON:
JSON mode returns {sessions, nextCursor}. --all follows cursors until nextCursor is null.
`,
  )
  .action((query, options, command) => searchSessionsCommand(query, options, command));
sessions
  .command("events")
  .description("Read or follow session replay events")
  .argument("<session-id>", "Session ID")
  .option("--after-sequence <n>", "Return events after this sequence")
  .option("--after <n>", "Alias for --after-sequence")
  .option("--before-sequence <n>", "Return events before this sequence")
  .option("--before <n>", "Alias for --before-sequence")
  .option("--prompt-id <id>", "Filter events by prompt ID")
  .option("--limit <n>", "Maximum events to return")
  .option("--follow", "Follow events until the session is idle")
  .option("--poll-interval <ms>", "Polling interval in milliseconds", String(DEFAULT_WATCH_POLL_INTERVAL_MS))
  .addHelpText(
    "after",
    `
Examples:
  cycloid sessions events <session-id> --json
  cycloid sessions events <session-id> --after-sequence 540 --limit 250 --json
  cycloid sessions events <session-id> --after 540 --limit 250 --json
  cycloid sessions events <session-id> --follow --json

JSON:
JSON mode without --follow returns one JSON object from /events/history: {events: [...], ...}; canonical events carry phase.
--follow --json emits NDJSON, one {sequence, type, data} object per line.
  Actionable follow types: pr_created/pr_updated use data.prUrl; question uses data.question; terminal types are prompt_completed, prompt_failed, and session_idle.
`,
  )
  .action((sessionId, options, command) => sessionEventsCommand(sessionId, options, command));
sessions
  .command("transcript")
  .description("Render a session transcript")
  .argument("<session-id>", "Session ID")
  .option("--last <n>", "Render only the last n transcript entries")
  .addHelpText(
    "after",
    `
Examples:
  cycloid sessions transcript <session-id>
  cycloid sessions transcript <session-id> --json
  cycloid sessions transcript <session-id> --last 20
`,
  )
  .action((sessionId, options, command) => transcriptCommand(sessionId, options, command));
sessions
  .command("watch")
  .description("Watch session activity until it becomes idle")
  .argument("<session-id>", "Session ID")
  .option("--poll-interval <ms>", "Polling interval in milliseconds", String(DEFAULT_WATCH_POLL_INTERVAL_MS))
  .addHelpText(
    "after",
    `
Examples:
  cycloid sessions watch <session-id>
  cycloid sessions watch <session-id> --json
`,
  )
  .action((sessionId, options, command) => watchCommand(sessionId, options, command));
sessions
  .command("usage")
  .description("Get token usage for a session")
  .argument("<session-id>", "Session ID")
  .addHelpText(
    "after",
    `
Examples:
  cycloid sessions usage <session-id>
  cycloid sessions usage <session-id> --json
`,
  )
  .action((sessionId, options, command) => usageCommand(sessionId, options, command));

const repos = program.command("repos").description("Repository discovery commands");
repos
  .command("list")
  .description("List accessible repositories")
  .addHelpText(
    "after",
    `
JSON:
JSON mode returns {repos, ssoOrgs}
`,
  )
  .action((options, command) => reposListCommand(options, command));
repos
  .command("branches")
  .description("List repository branches")
  .argument("[repo]", "Repository owner/name; defaults to current git remote")
  .addHelpText(
    "after",
    `
JSON:
JSON mode returns {branches}
`,
  )
  .action((repo, options, command) => repoBranchesCommand(repo, options, command));
repos
  .command("skills")
  .description("List repository skills")
  .argument("[repo]", "Repository owner/name; defaults to current git remote")
  .addHelpText(
    "after",
    `
JSON:
JSON mode returns {skills}
`,
  )
  .action((repo, options, command) => repoSkillsCommand(repo, options, command));

const models = program.command("models").description("Model discovery commands");
models
  .command("list")
  .description("List session-start models")
  .addHelpText(
    "after",
    `
JSON:
JSON mode returns {models}
`,
  )
  .action((options, command) => modelsListCommand(options, command));

const automations = program.command("automations").description("Automation commands");
automations
  .command("create")
  .description("Create a scheduled automation")
  .argument("<repo-url>", "Repository URL")
  .argument("[prompt]", "Prompt to run, or '-' to read stdin")
  .requiredOption("--cron <expr>", "Cron expression")
  .option("--name <name>", "Automation display name")
  .option(
    "--model <model>",
    "Model to pin for this automation's sessions (e.g. gpt-5.5, claude-opus-4-8). Defaults to the codex backend default.",
  )
  .option("--prompt-stdin", "Read prompt from stdin")
  .addHelpText(
    "after",
    `
Examples:
  cycloid automations create trycycloid/cycloid "summarize regressions" --cron "*/15 * * * *"
  cycloid automations create trycycloid/cycloid "audit N+1s" --cron "0 13 * * 5" --model gpt-5.5
  printf "summarize regressions" | cycloid automations create trycycloid/cycloid --prompt-stdin --cron "*/15 * * * *" --json
`,
  )
  .action((repoUrl, prompt, options, command) => createAutomationCommand(repoUrl, prompt, options, command));
automations
  .command("list")
  .description("List scheduled automations")
  .option("--limit <n>", "Maximum automations to return")
  .option("--cursor <cursor>", "Pagination cursor")
  .option("--all", "Fetch all pages")
  .addHelpText(
    "after",
    `
Examples:
  cycloid automations list
  cycloid automations list --limit 20 --json
  cycloid automations list --all --json
`,
  )
  .action((options, command) => listAutomationsCommand(options, command));
automations
  .command("delete")
  .description("Delete a scheduled automation")
  .argument("<id>", "Automation ID")
  .option("--yes", "Confirm deletion without prompting")
  .addHelpText(
    "after",
    `
Examples:
  cycloid automations delete auto_123
  cycloid automations delete auto_123 --yes --json
`,
  )
  .action((id, options, command) => deleteAutomationCommand(id, options, command));

const sandbox = program.command("sandbox").description("Sandbox layer commands");
sandbox
  .command("init")
  .description("Create sandbox layer source files")
  .action((options, command) => sandboxInitCommand(options, command));
sandbox
  .command("validate")
  .description("Validate local sandbox layer source files")
  .option("--manifest <path>", "Manifest path", ".cycloid/sandbox.yaml")
  .action((options, command) => sandboxValidateCommand(options, command));
sandbox
  .command("build")
  .description("Build a repo-sourced sandbox layer")
  .argument("[source-repo]", "Source repository owner/name; defaults to current git remote")
  .option("--manifest <path>", "Manifest path", ".cycloid/sandbox.yaml")
  .option("--ref <ref>", "Git ref to build")
  .option("--target-repo <repo>", "Target repository owner/name for resource-profile coverage")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .option("--wait", "Wait for the build to finish")
  .option("--follow", "Follow logs while waiting")
  .option("--poll-interval <ms>", "Polling interval in milliseconds")
  .option("--idempotency-key <uuid>", "Request idempotency key for safe manual retries")
  .addHelpText(
    "after",
    `
JSON:
  Without --wait and --follow, --json prints one object: {ok, buildRequest}
  With --wait and without --follow, --json prints two objects: initial {ok, buildRequest} then terminal {ok, buildRequest}
  With --follow, --json emits NDJSON:
    {type:"logs", logs:[...]}
    {type:"build", buildRequest:{...}}
`,
  )
  .action((sourceRepo, options, command) => sandboxBuildCommand(sourceRepo, options, command));
sandbox
  .command("status")
  .description("Show sandbox layer status")
  .argument("[repo]", "Repository owner/name; defaults to current git remote")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .action((repo, options, command) => sandboxStatusCommand(repo, options, command));
sandbox
  .command("history")
  .description("Show sandbox layer build history")
  .argument("[source-repo]", "Source repository owner/name; defaults to current git remote")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .option("--target-repo <repo>", "Target repository owner/name for resource-profile coverage")
  .option("--status <status>", "Filter by build status")
  .option("--limit <n>", "Maximum builds to return")
  .action((sourceRepo, options, command) => sandboxHistoryCommand(sourceRepo, options, command));
sandbox
  .command("logs")
  .description("Print sandbox layer build logs")
  .argument("<build-id>", "Build ID")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .option("--follow", "Follow logs")
  .option("--after-sequence <n>", "Return logs after this sequence")
  .option("--limit <n>", "Maximum log chunks to return")
  .option("--poll-interval <ms>", "Polling interval in milliseconds")
  .addHelpText(
    "after",
    `
JSON:
  Without --follow, --json prints one object: {ok, logs}
  With --follow, --json emits NDJSON lines for non-empty batches: {type:"logs", logs:[...]}
`,
  )
  .action((buildId, options, command) => sandboxLogsCommand(buildId, options, command));
sandbox
  .command("rebuild-stale")
  .description("Create stale sandbox template rebuild campaigns")
  .option("--business <id>", "Business ID to scan; defaults to authenticated user's business")
  .option("--all", "Scan all businesses")
  .option("--dry-run", "Preview stale rebuilds without queueing provider builds")
  .option("--yes", "Start a rebuild campaign")
  .option("--follow", "Follow campaign progress")
  .action((options, command) => sandboxRebuildStaleCommand(options, command));
const sandboxAssign = sandbox.command("assign").description("Assign sandbox layer sources");
sandboxAssign
  .command("default")
  .description("Set the business default sandbox layer source")
  .argument("<source-repo>", "Source repository owner/name")
  .option("--manifest <path>", "Manifest path", ".cycloid/sandbox.yaml")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .action((sourceRepo, options, command) => sandboxAssignDefaultCommand(sourceRepo, options, command));
sandboxAssign
  .command("repo")
  .description("Assign a sandbox layer source to one target repo")
  .argument("<target-repo>", "Target repository owner/name")
  .argument("<source-repo>", "Source repository owner/name")
  .option("--manifest <path>", "Manifest path", ".cycloid/sandbox.yaml")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .action((targetRepo, sourceRepo, options, command) =>
    sandboxAssignRepoCommand(targetRepo, sourceRepo, options, command),
  );
const sandboxUnassign = sandbox.command("unassign").description("Remove sandbox layer source assignments");
sandboxUnassign
  .command("default")
  .description("Clear the business default sandbox layer source")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .option("--yes", "Skip confirmation")
  .action((options, command) => sandboxUnassignDefaultCommand(options, command));
sandboxUnassign
  .command("repo")
  .description("Clear a target repo sandbox layer assignment")
  .argument("<target-repo>", "Target repository owner/name")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .option("--yes", "Skip confirmation")
  .action((targetRepo, options, command) => sandboxUnassignRepoCommand(targetRepo, options, command));

const egress = program.command("egress").description("Workspace egress allowlist commands");
const egressSource = egress.command("source").description("Manage the workspace egress allowlist source repo");
egressSource
  .command("set")
  .description("Set the source repo for .cycloid/egress-allowlist.txt")
  .argument("<source-repo>", "Source repository owner/name")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .action((sourceRepo, options, command) => egressSourceSetCommand(sourceRepo, options, command));
egressSource
  .command("get")
  .description("Show the configured egress allowlist source")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .action((options, command) => egressSourceGetCommand(options, command));
egress
  .command("add")
  .description("Open or update a PR adding domains to the egress allowlist source file")
  .argument("<domains...>", "Exact domain names to add")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .option("--reason <text>", "Reason to include in the PR body")
  .action((domains, options, command) => egressAddCommand(domains, options, command));
egress
  .command("sync")
  .description("Apply the merged egress allowlist source file to the runtime business policy")
  .option("--business <id>", "Business ID; defaults to authenticated user's business")
  .action((options, command) => egressSyncCommand(options, command));
egress
  .command("validate")
  .description("Validate a local egress allowlist source file")
  .argument("[path]", "Path to validate", ".cycloid/egress-allowlist.txt")
  .action((path, options, command) => egressValidateCommand(path, options, command));

const tokens = program.command("tokens").description("CLI token commands");
tokens
  .command("list")
  .description("List CLI tokens")
  .option("--limit <n>", "Maximum tokens to return")
  .option("--cursor <cursor>", "Pagination cursor")
  .option("--all", "Fetch all pages")
  .action((options, command) => listTokensCommand(options, command));
tokens
  .command("create")
  .description("Create a CLI token and print it once")
  .option("--scope <scope>", "Token scope: read or write", "read")
  .option("--expires-in-days <days>", "Token expiry in days")
  .option("--idempotency-key <uuid>", "Request idempotency key for safe manual retries")
  .addHelpText(
    "after",
    `
Examples:
  cycloid tokens create --scope read
  cycloid tokens create --scope read --json
`,
  )
  .action((options, command) => createTokenCommand(options, command));
tokens
  .command("revoke")
  .description("Revoke a CLI token")
  .argument("<id>", "Token ID")
  .option("--yes", "Confirm revocation without prompting")
  .addHelpText(
    "after",
    `
Examples:
  cycloid tokens revoke 42
  cycloid tokens revoke 42 --yes --json
`,
  )
  .action((id, options, command) => revokeTokenCommand(id, options, command));

const testCreds = program
  .command("test-creds")
  .description("Manage repo-scoped test credentials referenced by appRuntime.e2e.credentials in .cycloid.json");
testCreds
  .command("list")
  .description("List test credentials configured for a repo")
  .argument("<repo>", "Repository in 'owner/name' form")
  .requiredOption("--business <id>", "Business ID that owns the repo")
  .action((repo, options, command) => listTestCredentialsCommand(repo, options, command));
testCreds
  .command("set")
  .description("Set or rotate a test credential value")
  .argument("<repo>", "Repository in 'owner/name' form")
  .argument("<name>", "Credential name (must match credentials[].name in .cycloid.json)")
  .requiredOption("--business <id>", "Business ID that owns the repo")
  .option("--value <value>", "Credential value (insecure on shared shells; prefer --value-stdin)")
  .option("--value-file <path>", "Read value from a file")
  .option("--value-stdin", "Read value from stdin")
  .addHelpText(
    "after",
    `
Examples:
  echo "$E2E_PASS" | cycloid test-creds set trycycloid/cycloid test_user_password --business biz-1 --value-stdin
  cycloid test-creds set trycycloid/cycloid test_user_email --business biz-1 --value-file ./email.txt
`,
  )
  .action((repo, name, options, command) => setTestCredentialCommand(repo, name, options, command));
testCreds
  .command("delete")
  .description("Delete a test credential")
  .argument("<repo>", "Repository in 'owner/name' form")
  .argument("<name>", "Credential name")
  .requiredOption("--business <id>", "Business ID that owns the repo")
  .option("--yes", "Confirm deletion without prompting")
  .action((repo, name, options, command) => deleteTestCredentialCommand(repo, name, options, command));

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (isCommanderHelpOrVersion(err)) {
      process.exit(0);
    }
    if (err instanceof CliError && err.exitCode === EXIT_CODE_INTERRUPTED) restoreTerminal();
    const cliError = toCliError(err);
    const options = program.opts() as { json?: boolean };
    if (options.json) {
      process.stderr.write(`${formatJsonError(cliError)}\n`);
    } else {
      process.stderr.write(`Error: ${cliError.message}\n`);
      if (cliError.hint) process.stderr.write(`Hint: ${cliError.hint}\n`);
    }
    process.exit(cliError.exitCode);
  }
}

function isCommanderHelpOrVersion(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "commander.helpDisplayed" || code === "commander.version";
}

function restoreTerminal(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write("\u001b[?25h");
}

main();
