---
name: launch-easy-linear-tickets
description: Shortlist the easiest still-useful open Linear tickets for the current repository, then kick off one Cycloid session per shortlisted ticket so the work starts in parallel. Confirms the shortlist before launching anything, and reports the launched session URLs. Use when asked to find and run the N easiest open tickets, clear the easy backlog, or batch-launch Cycloid sessions from Linear.
user_invocable: true
argument: optional count (default 5), optional focus area such as guardrails, docs, or reliability, and optional repo override
---

# Launch Easy Linear Tickets

Works in the current repository. Find the easiest worthwhile open Linear tickets, confirm the shortlist with the user, then create one Cycloid session per shortlisted ticket so the work runs in parallel.

This skill launches real Cycloid sessions that can open PRs as the user. Do not launch any session until the user confirms the shortlist.

## Input

`$ARGUMENTS` may contain any of:

- a count override such as `5` (default 5)
- a focus area such as `guardrails`, `docs`, or `reliability`
- an explicit repo, such as `trycycloid/cycloid` or a full GitHub URL

Treat a focus area as a ranking hint, not a hard filter, unless the user clearly asks for an exclusive shortlist. If no count is given, default to 5.

## Goal

Turn the open Linear backlog into running work:

1. Resolve the target repo.
2. Shortlist the N easiest still-useful open tickets.
3. Present the shortlist and wait for explicit go-ahead.
4. Launch one Cycloid session per ticket.
5. Report the launched sessions.

## Step 1: Resolve the current repo

Derive the repository and default branch from the checkout, unless the user passed an explicit repo:

```bash
git remote get-url origin
gh repo view --json nameWithOwner,url,defaultBranchRef
git fetch origin <default-branch>
```

Use authenticated local `gh` for private GitHub state. If the repo cannot be proven from the checkout or the argument, stop and ask; do not guess.

## Step 2: Shortlist the easiest tickets

Reuse the `shortlist-easy-linear-tickets` procedure to produce the candidate list. Apply its full rubric, condensed:

- Start from open Linear tickets using the bundled Linear app read tools (`list_issues`, `get_issue`), scoped to the narrowest trustworthy team/project for this repo. Do not sweep the whole workspace when a repo-aligned scope exists.
- Keep only tickets with a strong repo-relevance signal: names this repo, has a linked PR here, has a branch targeting this repo, or obviously maps to code owned here.
- Drop tickets that are stale or already done. Check linked PRs and current code before trusting a ticket:

```bash
gh pr list --state all --limit 1000 \
  --json number,title,body,author,headRefName,baseRefName,state,isDraft,mergeStateStatus,url,updatedAt
```

- Score ease conservatively. Prefer one narrow file/module, an obvious implementation location, nearby tests, clear verification, and minimal cross-system coordination. Penalize auth/infra/migration/deploy/webhook complexity, broad wording ("improve", "refactor", "make smarter") without a tight acceptance condition, multiple plausible implementations, or missing expected outcome.
- Do not call a ticket easy when the hard part is simply unspecified. Prefer a smaller trustworthy shortlist over a longer noisy one.

Do not change any Linear ticket status in this skill.

Capture for each shortlisted ticket: ID, title, URL, the concrete deliverable, the likely implementation surface, and one risk.

If fewer than N tickets clearly qualify, shortlist only the ones that do and say how many you found. Do not pad the list to hit the count.

## Step 3: Confirm before launching

Present the shortlist and the exact prompt you will send for each ticket. Then stop and wait for explicit confirmation.

Show, per ticket:

- ID, title, URL
- why it is easy and the likely implementation surface
- one concrete risk
- the launch settings (repo, base branch if non-default, backend/model only if overriding defaults)

Do not launch until the user confirms. If the user narrows or reorders the list, honor that. This gate exists because each launch can open a PR as the user.

## Step 4: Build a per-ticket prompt

For each confirmed ticket, construct a concrete Cycloid prompt anchored to the ticket, including:

- the Linear issue URL
- the ticket title and relevant description
- the requested deliverable and any acceptance criteria
- an instruction to verify the ticket premise is still valid before implementing (if the change is already shipped, say so and stop rather than inventing adjacent work)
- publish expectation: open a PR if code changes are made

Keep the prompt anchored to the ticket. Do not replace specific acceptance criteria with a loose paraphrase.

## Step 5: Launch one session per ticket

Launch the sessions in parallel. Do not use `--wait` here; it blocks until the prompt completes and would serialize the batch. Create each session and capture its identifiers immediately:

```bash
printf '%s' "$PROMPT" | cycloid sessions create <repo> --prompt-stdin --json
```

Pass through any user-specified `--base-branch`, `--backend`, or `--model`. Use stdin for the prompt instead of inline shell quoting so ticket text with quotes, backticks, dollar signs, or code fences passes through safely.

From each create response capture: `sessionId`, `sessionUrl` if present, `repoUrl`, and `model`/`agentRuntimeBackend`/`baseBranch` if returned.

If a single create fails, report that ticket's exact error and continue launching the rest. Do not abort the whole batch for one failure. At the end, clearly list which tickets launched and which did not.

## Step 6: Report

Return a launch summary. Do not wait for the sessions to finish or audit them here; that is `run-and-audit-cycloid-session`'s job. Tell the user how to follow up.

## Output

```markdown
**Repo**: <name> (default branch <branch>)

**Launched sessions**

| Ticket  | Title | Session URL | Status   |
| ------- | ----- | ----------- | -------- |
| ABC-123 | ...   | https://... | launched |

**Not launched**

- ABC-456: <exact error, or why it was excluded from the shortlist>

**Follow up**

- Watch one: `cycloid sessions watch <session-id> --json`
- Audit one when done: use `run-and-audit-cycloid-session` with the ticket
```

## Rules

- Confirm the shortlist before launching. Never launch a session the user has not approved.
- Work from current repo state, not ticket age or title alone.
- Do not change Linear ticket status.
- Do not shortlist tickets whose repo relevance is not clear, and do not pad to the count.
- Launch without `--wait` so the batch runs in parallel.
- A failed launch for one ticket does not abort the others; report it and continue.
- This skill launches and reports; it does not wait for completion or audit.
