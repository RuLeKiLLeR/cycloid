---
name: reconcile-open-linear-tickets
description: Sweep open Linear tickets relevant to the current repository, compare each ticket's intended work against the current codebase and any linked pull requests, and move only the Linear tickets that are clearly done or obsolete to `Done` or `Canceled`. Use when asked to review open Linear work for a repo starting from the ticket list, cross-reference ticket intent against the repo's default branch, and clean up outdated tickets without guessing.
user_invocable: true
---

# Reconcile Open Linear Tickets

Works in the current repository. Start from the open Linear tickets relevant to the repo, inspect the current codebase and any linked PRs, and choose exactly one outcome per ticket:

- move the ticket to `Done`
- move the ticket to `Canceled`
- leave the ticket unchanged and report why

Do not edit code; this is review-and-triage, not implementation.

## Goal

Update Linear ticket status only when the evidence is clear:

- `Done` when the ticket's intended work is already present on current `origin/<default-branch>`
- `Canceled` when the ticket is obsolete, superseded, or no longer the right work item

Fail closed on ambiguity. If the ticket might still require work, leave it unchanged and report that.

## Step 1: Resolve the current repo

Derive the repo and its default branch from the checkout:

```bash
git remote get-url origin
gh repo view --json nameWithOwner,url,defaultBranchRef
```

Keep the discovered default branch name and reuse it in later commands instead of hardcoding `main`.

Use the authenticated local `gh` CLI for GitHub state. Do not use browser fetches for private repo context.

## Step 2: Discover candidate open Linear tickets

Start from open Linear tickets, not from open PRs.

Use current repo context to determine which open tickets are relevant. Strong signals:

- the ticket body or title explicitly names this repo
- the ticket has an attached GitHub PR in this repo
- the ticket branch name or linked implementation target clearly maps to this repo
- surrounding trusted repo context makes the repo match obvious

If repo relevance cannot be proven, skip the ticket.

For each relevant open ticket:

- fetch the issue from Linear
- confirm it still exists
- confirm it is not completed or canceled
- capture title, description, URL, and any linked branch or PR context

## Step 3: Discover linked PRs for each open ticket

For each relevant open ticket, find PRs in the current repo that clearly map to it. Look for the ticket identifier or URL in PR title, PR body, or branch name.

Use:

```bash
gh pr list --state open --limit 1000 \
  --json number,title,body,author,headRefName,baseRefName,isDraft,mergeStateStatus,url,updatedAt
```

Match common forms such as:

- `ARC-952`
- `ENG-123`
- `https://linear.app/.../issue/ARC-952/...`

For each matching PR, also fetch:

```bash
gh pr view <N> --json files,commits,reviews
gh pr diff <N>
```

If an open ticket has no linked PR in this repo, do not invent one. Evaluate the ticket from the current codebase and ticket text alone when possible; otherwise leave it unchanged and report insufficient evidence.

## Step 4: Compare linked PRs and the current codebase against the ticket intent

Always compare against the live default branch, not memory and not the PR's original base snapshot:

```bash
git fetch origin <default-branch>
```

For each linked PR, save the patch and test whether it still applies cleanly to the current default branch in a temporary detached worktree:

```bash
PATCH="$(mktemp "${TMPDIR:-/tmp}/linear-pr.XXXXXX")"
WORKTREE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/linear-pr.XXXXXX")"
WORKTREE="${WORKTREE_ROOT}/repo"

cleanup() {
  if [ -n "${WORKTREE:-}" ]; then
    git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  fi
  rm -f "${PATCH:-}"
  rm -rf "${WORKTREE_ROOT:-}"
}
trap cleanup EXIT

gh pr diff <N> > "$PATCH"
git worktree add --detach "$WORKTREE" origin/<default-branch>
git -C "$WORKTREE" apply --check "$PATCH"

trap - EXIT
cleanup
```

Interpret conservatively:

- If `git apply --check` succeeds, the PR is current enough to be weak evidence the ticket may still be in progress.
- If it fails, inspect the changed files on the default branch, the PR diff, and the ticket intent before deciding anything.

Also inspect the current code directly:

- read the files the ticket or PR targets
- use `rg` to find the relevant symbols, handlers, tests, docs, or feature text
- compare the current implementation to the ticket's requested outcome

Do not rely on PR state alone.

## Step 5: Decide the ticket outcome

Move to `Done` only on clear evidence, e.g.:

- the intended fix is already present on `origin/<default-branch>`
- the ticket intent has already been satisfied by later commits or another PR
- the linked PR has already landed or the current code matches the requested end state

Move to `Canceled` only on clear evidence, e.g.:

- the code or docs the ticket targets no longer exist and the ticket is no longer relevant
- the Linear ticket has materially changed scope and the PR no longer addresses the current request
- the ticket has been superseded by another ticket or implementation path
- the requested work is no longer the right thing to do based on current code and product direction

Do not change ticket status automatically when any of these hold:

- the patch merely needs a rebase
- the patch still appears directionally correct but conflicts with later edits
- the linked PR is blocked on checks, reviewers, or merge conflicts rather than obsolescence
- the ticket might still be valid but needs human prioritization or scope clarification
- the codebase evidence is incomplete or ambiguous

When judging whether the ticket is done or obsolete, prove it from current code:

- inspect the exact files the PR edits on the default branch
- compare the PR diff against the current implementation
- if needed, use `rg` to find the relevant symbol, route, test, or wording in the repo

Do not rely on titles alone.

## Step 6: Update Linear ticket status only when the conclusion is clear

When a ticket is clearly done or obsolete, update the Linear issue with the target state and a concise note in the description or a linked comment/worklog-equivalent summary in your final report.

Good status reasons are concrete, for example:

- `Done: the ARC-952 behavior is already present on main, so no further implementation work remains.`
- `Canceled: the route and handler this ticket targeted were removed after the ticket was filed, so the requested change is no longer relevant on current main.`
- `Done: the ticket scope already landed through PR #1234 and matches the current implementation.`

Do not use vague reasons like `stale` or `obsolete` by themselves.

Use:

```bash
mcp__linear__save_issue({
  id: "<issue-id>",
  state: "<Done|Canceled>",
  reason: "<concise evidence-backed reason>",
})
```

Update the ticket via the Linear issue update tool, not by editing GitHub PR state.

## Step 7: Leave ambiguous tickets unchanged

Leave the ticket unchanged when:

- the ticket is still open and the PR could still be refreshed into a valid fix
- the patch does not apply cleanly but you cannot prove it is obsolete
- the ticket-to-PR mapping is ambiguous
- the repo state suggests partial overlap but not full supersession

Report the exact reason it stayed unchanged.

## Output

Concise summary with these sections when applicable:

### Tickets reviewed

- Linear ticket
- whether it had a linked open PR in this repo
- short note on why it was in scope

### Moved to Done

- Linear ticket
- one sentence on the codebase evidence
- the status reason

### Moved to Canceled

- Linear ticket
- one sentence on the codebase evidence
- the status reason

### Left unchanged

- Linear ticket
- exact blocker or ambiguity

### Skipped

- Linear ticket
- why it was skipped, such as repo relevance not proven

## Rules

- Work from the current repository only.
- Start from open Linear tickets, not from open PR discovery.
- Compare linked PRs and current code against the current default branch.
- Use Linear as the ticket source of truth and `gh` as the GitHub source of truth.
- Fail closed on ambiguity.
- Do not assume every open ticket belongs to this repo.
- Never close or edit PRs as part of this skill.
- Do not move a ticket just because a linked PR is old, open, or blocked.
- Do not move a ticket just because `git apply --check` fails.
- Do not move a ticket to `Done` or `Canceled` unless the current codebase clearly proves that outcome.
