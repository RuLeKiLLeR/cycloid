# HTTP API: session create

`POST /api/sessions` (cookie or CLI-token auth). Relevant payload fields:

| Field                 | Type                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`               | string                        | Session-start model id, optionally `provider:`/`provider/`-prefixed. Used as-is when provided; when omitted the backend default is used. See the backend/model matrix below.                                                                                                                                                                                                                                                                        |
| `agentRuntimeBackend` | string                        | `codex` \| `claude_code` \| `opencode`. Optional: when omitted it is derived from `model` (`claude-*` implies `claude_code`, Baseten-backed models imply `opencode`, no model implies `codex`).                                                                                                                                                                                                                                                     |
| `reasoningEffort`     | string                        | Must be valid for the resolved model.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `context`             | object                        | `{ repoUrl, baseBranch? }`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `startBranch`         | string                        | Resume an existing branch with its history instead of forking a fresh branch off base. Validated as a safe git ref and verified to exist on the remote (404 if missing, 503 on a transient GitHub error).                                                                                                                                                                                                                                           |
| `prompt`              | string                        | Initial prompt. Included in create body for continuation inference; capped at 4000 chars in the create payload while the full prompt is sent to the prompt endpoint.                                                                                                                                                                                                                                                                                |
| `continuePrUrl`       | string                        | GitHub PR URL for continuation. Checks out the PR head branch before the prompt runs. Same-repo open PRs only; fork PRs fail closed with a clear error.                                                                                                                                                                                                                                                                                             |
| `continueMode`        | string                        | `auto` \| `update-pr` \| `new-pr`. `update-pr` attaches the referenced PR as the publish target. `new-pr` starts from the PR head but opens a fresh PR on publish. `auto` (default) resolves to `update-pr` for supported open same-repo PRs.                                                                                                                                                                                                       |
| `qa`                  | boolean                       | QA Tester session (see [docs/prompt-agents.md](prompt-agents.md)). Automatic and comment-triggered QA testers inherit the parent session's backend/model when known, valid, and credentialed for the QA Tester owner; missing, unknown, invalid, or unavailable parent runtime falls back to the Codex default (`gpt-5.4`).                                                                                                                         |
| `targetPrUrl`         | string                        | GitHub PR URL for QA Tester sessions. When `qa: true` and `targetPrUrl` is absent, the server infers it from a single PR URL in the prompt; multiple distinct PR URLs in the prompt are rejected as ambiguous (400). Explicit `targetPrUrl` always takes precedence.                                                                                                                                                                                |
| `forceNewSession`     | boolean                       | QA Tester only. When `true`, skip the active-verifier dedup and supersede any in-flight verifier for the PR (kill its child + admit a fresh run) rather than returning the existing session as a successful duplicate. Still bounded by `MAX_VERIFICATION_RUNS_PER_PR`. Defaults to `false`.                                                                                                                                                        |
| `autoVerify`          | boolean                       | Governs the automatic QA Tester after publish. When on, the verifier child is spawned at publish and runs **off-gate in parallel** with the review loop (its verdict is advisory and does not gate merge-ready); when `false`, no QA child spawns — review listening still arms independently (ARC-1472). When omitted, the user's saved Settings preference applies (`auto_verify_enabled` defaults **off** for new users since migration `0242`). |
| `planMode`            | `"off"` \| `"on"` \| `"auto"` | On interactive sessions, `"auto"` classifies the prompt at creation; a null result defaults to execute directly. When omitted, the saved plan-mode setting applies. Unattended and carve-out sessions resolve off.                                                                                                                                                                                                                                  |

Session-start backend/model matrix:

| Backend       | Runtime     | Default model     | Accepted session-start models                                                                                          | Credential note                                                                 |
| ------------- | ----------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `codex`       | Codex       | `gpt-5.4`         | `gpt-5.4`, `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` | Uses OpenAI credentials resolved for the session owner/business.                |
| `claude_code` | Claude Code | `claude-opus-4-8` | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-sonnet-5`, `claude-fable-5`                                            | Requires a business or user Anthropic API key (BYOK) in prod.                   |
| `opencode`    | opencode    | `kimi-k2.7-code`  | `kimi-k2.7-code`                                                                                                       | Uses Baseten-backed opencode models; availability depends on configured access. |

Validation is fail-closed: an explicit `(model, agentRuntimeBackend)` mismatch,
an unknown backend, or a non-session-start model returns 400.
Credential resolution also fails closed when the selected backend's required provider credential is unavailable.
CLI flags map 1:1 (see [docs/cli.md](cli.md)).

A QA Tester session (`qa: true` with `targetPrUrl`, or `qa: true` with a single PR URL in the prompt) returns 201 with `duplicate: true` if another QA Tester session for the same PR is still active; the body includes `sessionId` and `sessionUrl` for the running QA tester. A 409 is returned only when a concurrent admission race (`admitted_elsewhere`) or the per-PR run cap (`run_limit_reached`) prevents creation. Manual UI "Verify" buttons send `forceNewSession: true`, which supersedes the in-flight verifier and admits a fresh run instead of returning the existing session as a duplicate.

## Read the latest session plan

`GET /api/sessions/:id/plan` uses browser cookie authentication. It applies normal session access and repository authorization, returning `404` when the session has no plan.

The response is the latest `session_plans` revision:

```json
{
  "status": "pending",
  "revision": 2,
  "markdown": "# Plan\n\n...",
  "userEdited": false,
  "updatedAt": "2026-07-09T16:00:00.000Z",
  "planPromptId": "p-plan-2"
}
```

## Approve a session plan

`POST /api/sessions/:sessionId/plan/approve` accepts `{ "revision": number }` from an authenticated browser session. Session ownership/shared-business repository access is checked the same way as other session mutations.

Approval compare-and-sets the latest pending revision, supersedes queued discussion turns, inserts one implementation prompt ahead of held follow-ups, and resumes dispatch. Replaying the already-approved revision is idempotent and returns the existing implementation prompt id.

Success returns `{ ok: true, revision, implementationPromptId, idempotent }`. Malformed input returns 400, unauthorized access 403/404, stale or non-pending state 409, oversized bodies 413, and non-JSON content types 415.

## Edit a pending plan

`PUT /api/sessions/:id/plan` is a browser cookie-session route. The JSON body is `{ revision, markdown }`; `revision` must match the latest pending plan revision. A successful edit returns `{ ok: true, planApprovalPending: true, revision, status: "pending" }` with the incremented revision.

Markdown is capped at 60,000 characters and must contain non-whitespace text. The full edit is retained, while implementation context uses the same 12,000-character excerpt cap as generated plans. Responses are `400` for malformed or empty input, `403`/`404` for access denial, `409` for a stale revision or non-pending plan, `413` for oversized markdown, `415` for a non-JSON content type, and `429` for the per-user edit limit.
