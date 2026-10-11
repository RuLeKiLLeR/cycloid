---
name: review-cycloid-session
description: Review a single Cycloid session from a session URL or UUID. Wait for the session if it is still active, then reconstruct the tool calls, process followed, verification performed, and quality issues, with special attention to sandbox-vs-local environment confusion, customer-facing oddities, and whether the agent behavior was good or bad.
user_invocable: true
argument: required -- a Cycloid session URL like https://app.trycycloid.com/sessions/<uuid> or a raw session UUID
---

# Review Cycloid Session

Audit one Cycloid session as an operator. Focus on what the agent actually did, whether the behavior was correct, and what would look good or bad to a customer.

## Input

`$ARGUMENTS` must be one of:

- a full session URL, such as `https://app.trycycloid.com/sessions/<uuid>`
- a raw session UUID

Extract the UUID first. If the input is not a session URL or UUID, stop and say so.

## Goal

Produce a concrete review of the session:

- what tools were called
- what process the agent followed
- what it did well
- what it did poorly
- whether the agent showed environment confusion or leaked internal workflow assumptions
- what follow-up bug or prompt fixes may be warranted

This skill is for reviewing the session itself, not for debugging the product via Datadog or Braintrust unless the user explicitly asks for deeper production investigation. Start with the Cycloid session record and transcript first.

## Required Workflow

### 1. Fetch the session record

Run:

```bash
cycloid sessions get <session-id> --json
```

If this fails, stop immediately and report the exact error. Do not continue to transcript or event reconstruction with missing session data, and do not retry in a loop unless the user explicitly asks.

Capture:

- session status
- repo
- title
- created/updated timestamps
- sandbox/runtime state if present
- PR URL if present

### 2. Wait for active sessions when needed

If the session is still active, wait for it before auditing:

```bash
cycloid sessions events <session-id> --follow --json
```

Stop following once the session reaches a terminal state and then fetch the session record again. Do not treat `idle` as terminal when code changes were made — `idle` can be an intermediate state while the control plane is still doing push, post-exec verification, and PR creation. Keep polling `sessions get` until `publishStatus` is `published` with a `prUrl`, a terminal non-success outcome (blocked/error/manual review), or there is clear evidence no publish was expected:

```bash
cycloid sessions get <session-id> --json
```

Do not leave `--follow` running indefinitely. If the session stalls, or if it stops emitting useful events for a reasonable interval, stop following and report the latest observed state instead of waiting forever.

If the user explicitly wants a live in-progress snapshot instead of waiting, say that and review the current state as a snapshot-in-time.

### 3. Fetch transcript and event history

Run both:

```bash
cycloid sessions transcript <session-id> --json
cycloid sessions events <session-id> --json --limit 1000
```

Prefer the transcript for the high-level narrative and the event stream for exact tool-call reconstruction.

### 4. Reconstruct the tool sequence

From `tool_call` and `tool_update` events, summarize:

- tool name
- important command or target
- why the call was made
- whether it completed, failed, or retried
- obvious loops, redundant reads, or expensive churn

Do not dump raw NDJSON unless the user explicitly asks. Summarize the actual sequence in plain English.

### 5. Reconstruct the process followed

Identify the workflow the agent used, for example:

- read ticket or source of truth first
- read repo instructions/docs
- searched code paths
- inspected specific files
- edited code
- reran verification
- reviewed its own diff
- committed or published

Call out whether the sequence was disciplined or sloppy.

### 6. Evaluate quality

Always assess these dimensions:

- `Investigation quality`: Did it start from the right source and trace the issue end to end?
- `Tool efficiency`: Did it use tools economically, or churn through redundant reads/searches?
- `Verification quality`: Did it run the right checks, or stop too early?
- `Communication quality`: Were progress updates concrete and honest?
- `Environment correctness`: Did it correctly understand where it was running?
- `Customer-facing quality`: Would the session look trustworthy to a customer?
- `Scope honesty`: If it discovered the requested implementation was already present, did it say so explicitly, or silently change scope into adjacent work?

### 7. Explicitly check for environment confusion

Always look for language or behavior that confuses:

- Cycloid sandbox vs local checkout
- sandbox filesystem vs user machine filesystem
- bridge responsibilities vs agent responsibilities
- local worktree workflow vs sandbox session workflow

Flag examples such as:

- mentioning worktrees inside a normal Cycloid sandbox session
- talking as if the agent is editing the user's local checkout
- telling the user to do steps the agent could already do in-session
- claiming the bridge will do work that the agent should have verified first

Treat these as customer-facing quality issues even if the code change itself was correct.

Also treat premise drift as a review concern:

- if the agent finds the requested change already exists, it should explicitly frame the ticket as stale, already satisfied, or no longer applicable
- if it continues with follow-up work, check whether that follow-up is narrowly justified and clearly labeled
- call out any case where the agent claims it "implemented" the request after discovering it was already done

### 8. Identify action items

If the session exposed a product or prompt problem, say what kind:

- prompt/instruction bug
- progress/observability gap
- tooling gap
- verification gap
- environment-modeling bug
- harmless wording issue

Be specific about why.

## Output Format

Use exactly these sections:

```markdown
**Session**

- ID / URL
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
- If the session is still running, separate finished facts from predictions.
- If transcript/events are incomplete, say what is missing.
