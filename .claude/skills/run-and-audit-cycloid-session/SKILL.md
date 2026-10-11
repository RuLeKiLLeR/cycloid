---
name: run-and-audit-cycloid-session
description: Take a Linear ticket as input, create a Cycloid session for the ticket, wait for completion and PR outcome, then audit the resulting session.
user_invocable: true
argument: required -- a Linear issue URL like https://linear.app/<workspace>/issue/ABC-123/... or a raw Linear issue identifier like ABC-123
---

# Run And Audit Cycloid Session

Run a real Cycloid session from a Linear ticket, wait until the run is actually done, then audit what happened.

## Input

`$ARGUMENTS` must be one of:

- a full Linear issue URL, such as `https://linear.app/<workspace>/issue/ABC-123/...`
- a raw Linear issue identifier such as `ABC-123`

If the input is not a Linear issue URL or identifier, stop and say so.

## Goal

Produce a concrete operator review of a real task run:

- resolve the Linear ticket as the source of truth
- determine the target repo or fail closed if it cannot be proven
- create the Cycloid session
- wait for prompt completion and real PR outcome
- audit the resulting session with the same rubric as `review-cycloid-session`

## Required Workflow

### 1. Resolve the Linear issue first

Fetch the issue details from Linear before building the prompt. Capture:

- issue identifier
- title
- description
- URL
- any explicit repo reference or implementation target in the issue body

Do not create the session before reading the actual ticket.

### 2. Resolve the repo or fail closed

Determine the target repo from the Linear issue or adjacent trusted context.

Allowed cases:

- the Linear issue explicitly names a repo
- the surrounding user request already named the repo
- the repo can be derived from existing Cycloid or product context with high confidence

If the repo cannot be proven, stop and report that the repo is missing. Do not guess.

### 3. Build the task prompt from the Linear ticket

Construct a concrete Cycloid prompt that includes:

- the Linear issue URL
- the ticket title and relevant description
- the requested deliverable
- publish expectation: open a PR if code changes are made

Also require the launched agent to treat stale premises explicitly:

- before implementation, verify whether the requested change is still absent
- if the requested implementation is already present or already shipped, it must say so explicitly
- it must then say whether no code change is needed, the request should be closed, or a narrow follow-up is still justified
- a narrow follow-up is allowed only when the agent explains why the original request is already satisfied and why the small follow-up is still directly justified
- it must not silently invent adjacent work after disproving the ticket premise

Keep the prompt anchored to the ticket. Do not replace it with a loose paraphrase if the issue has specific acceptance criteria.

### 4. Create the session and wait for prompt completion

Run:

```bash
printf '%s' "$PROMPT" | cycloid sessions create <repo> --prompt-stdin --wait --json
```

Capture:

- `sessionId`
- `sessionUrl` if present
- repo URL
- model/reasoning fields if returned

Use stdin for the prompt instead of inline shell quoting so Linear ticket text with quotes, backticks, dollar signs, or code fences is passed through safely.

If creation fails, stop immediately and report the exact error.

### 5. Check the real session and PR outcome

After `--wait`, fetch the session record:

```bash
cycloid sessions get <session-id> --json
```

Treat the first post-`--wait` snapshot as provisional. `--wait` can return before post-execution verification, branch push, or PR creation fully settles, and does not mean a PR was created.

Do not start the audit yet if any of the following are still true:

- the session is still active/running
- the prompt is still processing
- publish has not reached a real outcome yet
- the transcript suggests code changes or a commit happened, but `prUrl`/publish outcome is still missing

If the run is still active or publish is still in progress, keep waiting. Prefer:

```bash
cycloid sessions watch <session-id> --json
```

Then fetch the session record again:

```bash
cycloid sessions get <session-id> --json
```

If publish is still ambiguous, continue following events until it becomes clear, then fetch the session record again:

```bash
cycloid sessions events <session-id> --follow --json
```

Do not treat `status: idle` by itself as terminal when code changes were made; `idle` can be an intermediate state unless the refreshed session record also proves the publish outcome.

The final source of truth for publish is the refreshed `cycloid sessions get <session-id> --json` output, not a provisional transcript summary and not a partial read of the event stream. Keep polling `sessions get` after `watch` or `events --follow` until one of these terminal publish outcomes is proven:

- `publishStatus: "published"` with `prUrl` / PR number present
- draft PR created
- a terminal non-success outcome: publish blocked / manual review / publish error
- no PR expected — only when the evidence clearly shows the task was read-only or there was no diff to publish

If the event stream shows post-execution steps like configured tests, `git.push`, or `pr.open`, do not stop early; keep waiting until the next refreshed session record confirms the terminal publish state.

When inspecting event history in non-follow mode, do not assume `cycloid sessions events <session-id> --json` emits raw NDJSON lines that can be safely trimmed with shell filters like `tail`. It returns a JSON envelope; read the structured payload and then re-fetch `sessions get` for the final state check.

Do not leave `watch` or `--follow` running indefinitely. If the session stalls or stops emitting useful events for a reasonable interval, stop following and report the latest observed state instead of waiting forever.

If the session appears logically done but publish is unresolved, call that out as a product/session-state issue, keep the review scope labeled as an in-progress snapshot, and explicitly say the publish outcome is still unconfirmed.

### 6. Audit the resulting session

Use the same audit procedure and output contract as `review-cycloid-session`:

- fetch transcript and event history
- reconstruct tool calls
- reconstruct the process followed
- assess investigation, verification, communication, environment correctness, and customer-facing quality
- call out environment confusion explicitly
- identify prompt/product/tooling follow-up items

## Output Format

Use exactly these sections:

```markdown
**Session**

- ID / URL
- Source ticket
- Status
- Repo
- PR
- Review scope: final review or in-progress snapshot

**Tool Calls**

- Short ordered bullets covering the important tool calls and what they accomplished

**Process**

- Short ordered bullets describing the workflow the agent followed

**What Was Good**

- Flat bullets

**What Was Bad**

- Flat bullets

**Environment Confusion**

- `None visible.` or flat bullets with exact examples

**Customer-Facing Assessment**

- 2-4 sentences on whether this would inspire confidence

**Follow-Up**

- Flat bullets for prompt/product/skill fixes, or `None visible.`
```

## Style Rules

- Be concrete and evidence-backed.
- Prefer short bullets over long prose.
- Quote only short snippets when needed to prove a point.
- Do not praise generically; tie every judgment to visible behavior.
- If transcript/events are incomplete, say what is missing.
