# Troubleshooting

Customer-facing failure taxonomy. Error labels match the UI and Slack; canonical code → label → hint mapping: `shared/types/error-codes.ts`.

## Where to look first

1. Session page: error label, failing prompt, full transcript.
2. PR body (when opened): verification verdict and checks run.
3. Slack threads: same terminal status as the UI.

## Failure classes

### Provider / model errors

| Label                   | Meaning                                                 | What to do                                              |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| Provider rate limit     | The model provider throttled the session                | Wait a few minutes, retry. Recurs: check your BYOK plan |
| Provider API error      | Upstream 5xx/timeout from the model provider            | Retry in a few minutes                                  |
| Context window exceeded | The task accumulated more context than the model allows | Retry with a narrower prompt or fewer attached files    |
| Output was too long     | The reply exceeded output limits                        | Open the session for the partial output, narrow the ask |

Rate limits, provider API errors, edit failures, empty completions, and agent-transport drops auto-retry with backoff before failing. Context-window and output-length failures do NOT auto-retry — narrow the request and retry manually. "Suspected failure loop" = same failure exhausted its retry budget repeatedly with no code progress; the session stops on purpose. Retry with a different approach or narrower task.

### Configuration and access

| Label                 | Meaning                                         | What to do                                                                                            |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Authentication failed | GitHub credentials/installation no longer valid | Reconnect GitHub in Cycloid settings; check the GitHub App is installed and not suspended for the org |
| Configuration error   | Repo or session configuration is invalid        | Check repo settings (base branch, repo access), retry                                                 |

### Sandbox lifecycle

| Label                                             | Meaning                                   | What to do                        |
| ------------------------------------------------- | ----------------------------------------- | --------------------------------- |
| Sandbox spawn timed out                           | The isolated sandbox did not start        | Retry in a few minutes            |
| Sandbox spawn failed (provider API error)         | The sandbox provider returned an error    | Retry in a few minutes            |
| Sandbox spawn timed out before provider responded | The provider never acknowledged the spawn | Retry in a few minutes            |
| Sandbox spawn timed out before bridge connected   | The sandbox started but never connected   | Retry in a few minutes            |
| Sandbox failed before connecting                  | The sandbox failed during startup         | Retry in a few minutes            |
| Sandbox terminated                                | The sandbox stopped before finishing      | Retry the request                 |
| Sandbox disconnected                              | The sandbox disconnected before finishing | Retry the request                 |
| Sandbox callback failed                           | The sandbox could not report progress     | Open the session, then retry      |
| Prompt exceeded maximum duration                  | The task ran past the session time limit  | Split the work into smaller tasks |
| Stopped by user                                   | Someone clicked stop or replied "stop"    | Nothing — expected                |

### Agent runtime (Codex)

| Label                            | Meaning                                          | What to do                             |
| -------------------------------- | ------------------------------------------------ | -------------------------------------- |
| Codex startup timed out          | The agent runtime did not start in time          | Retry in a few minutes                 |
| Codex API readiness timed out    | The agent runtime did not become ready           | Retry in a few minutes                 |
| Codex session creation timed out | The agent session could not be created           | Retry in a few minutes                 |
| Codex prompt dispatch timed out  | The prompt could not be delivered to the agent   | Retry the request                      |
| Codex did not become ready       | The agent runtime was not ready                  | Retry in a few minutes                 |
| Codex transport closed           | The agent runtime connection closed unexpectedly | Retry the request (auto-retried first) |
| Codex unrecoverable failure      | The agent runtime stopped unexpectedly           | Open the session for details           |

### Agent execution

| Label            | Meaning                                                   | What to do                              |
| ---------------- | --------------------------------------------------------- | --------------------------------------- |
| Edit failure     | The agent could not apply repeated edits to the same file | Retry with a narrower request           |
| Empty completion | The model returned nothing actionable                     | Retry; rephrase the prompt if it recurs |

## "It finished but no ready-for-review PR appeared"

Not an error — the publish pipeline decided the change was not ready:

- **Draft PR** (most common): a configured check failed or verification was inconclusive/refuted; reason in the PR body. Fix or verify manually, then mark ready.
- **Publish blocked**: no PR opened; change held back. Session page shows the blocked reason.
- **No diff**: the agent answered a question or found the change already present; nothing to publish.

## Escalation

If a failure recurs after retry, share the session URL with the Cycloid team — it has the full transcript and diagnostics.
