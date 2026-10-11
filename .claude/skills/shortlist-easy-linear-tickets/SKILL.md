---
name: shortlist-easy-linear-tickets
description: Find the easiest still-useful open Linear tickets relevant to the current repository, using current repo state and any linked PR context to produce a short, defensible implementation shortlist without changing ticket status.
user_invocable: true
argument: optional count or focus area such as guardrails, docs, or reliability
---

# Shortlist Easy Linear Tickets

Works in the current repository. Identify a small set of open Linear tickets that are both still relevant to the current repo state and likely low-effort or low-ambiguity to implement next.

Do not edit code or change Linear ticket status in this workflow.

## Input

`$ARGUMENTS` may contain either or both:

- a count override such as `5`
- a focus area such as `guardrails`, `docs`, or `reliability`

Treat a focus area as a ranking hint, not a hard filter, unless the user clearly asks for an exclusive shortlist.

## Goal

Produce a short, evidence-backed shortlist of the easiest worthwhile open tickets for this repo. A good candidate should have most of:

- repo relevance is clear
- desired outcome is concrete
- implementation surface is narrow
- current code suggests low ambiguity
- no obvious blocker from missing infra, product decisions, or external dependencies

Exclude tickets that are stale, already done, broad, underspecified, or only "easy" because the request is unclear.

## Step 1: Resolve the current repo

Derive the repository and default branch from the checkout:

```bash
git remote get-url origin
gh repo view --json nameWithOwner,url,defaultBranchRef
git fetch origin <default-branch>
```

Use authenticated local `gh` for private GitHub state.

## Step 2: Discover relevant open Linear tickets

Start from open Linear tickets, not from code search alone. Use the bundled Linear app's read tools:

- start with `list_issues` for open issues in the relevant team or project when that scope is clear
- use `mcp__linear-server__list_issues` with an assignee filter when the user phrasing clearly points at their own queue
- use `get_issue` to expand any promising candidate before deciding scope

If the relevant team or project is unclear, derive the narrowest trustworthy scope from repo context and linked PR evidence before listing issues. Do not guess across the whole workspace when a smaller repo-aligned scope is available.

Keep only tickets whose repo relevance has at least one strong signal:

- the ticket explicitly names this repo
- it has a linked PR in this repo
- its branch name clearly targets this repo
- the requested change obviously maps to code owned here

If repo relevance is unclear, skip the ticket.

Capture for each in-scope ticket: ID and title, description, URL, any linked PR or branch context.

If the user passed a focus area, record whether each candidate clearly matches it from the title, description, labels, linked PR, or affected code area. Use that match for ranking later; do not discard a clearly good repo-relevant ticket solely because the focus-area match is weak.

## Step 3: Eliminate stale or already-done tickets

Before ranking for ease, remove tickets that should not be shortlisted.

Check for linked PRs in this repo using ticket ID or URL in PR title, PR body, or branch name:

```bash
gh pr list --state all --limit 1000 \
  --json number,title,body,author,headRefName,baseRefName,state,isDraft,mergeStateStatus,url,updatedAt
```

`--limit 1000` is a sampling cap, not an exhaustive history query; follow linked PRs or narrow searches when deciding whether a ticket is already done.

For promising matches, inspect:

```bash
gh pr view <N> --json files,commits
gh pr diff <N>
```

Also inspect the current code directly with targeted `rg` and file reads.

Drop a ticket if the evidence shows:

- the intended change is already on the default branch
- the target code or docs no longer exist
- the ticket has been superseded by a later implementation or ticket

When stale or done status is only a suspicion, keep the ticket eligible but lower confidence.

## Step 4: Score ease conservatively

Rank remaining tickets using visible evidence from current code and linked PR context.

If the user passed a focus area, prefer tickets whose intent and implementation surface clearly match it:

- `docs`: documentation-only or documentation-led tickets
- `reliability`: correctness, failure handling, or operational robustness
- `guardrails`: prompt, workflow, or agent-safety constraints

Treat the focus area as a tie-breaker and ranking weight, not proof that a ticket is easy.

Prefer tickets with:

- one primary file or one narrow module boundary
- existing tests nearby
- an obvious implementation location
- minimal cross-system coordination
- clear verification steps

Penalize tickets with:

- auth, infra, migration, deploy, or webhook complexity
- broad wording like "improve", "refactor", or "make smarter" without a tight acceptance condition
- multiple plausible implementations
- missing reproduction or missing expected outcome
- strong signs the ticket needs product or priority judgment rather than execution

Do not use point estimates or title vibes alone as evidence.

## Step 5: Produce the shortlist

Default to the top 3-5 tickets unless the user asked for a different count.

For each shortlisted ticket, include: ID and title, why it is relevant to this repo, why it appears easy now, the likely implementation surface, and one concrete risk or uncertainty.

Also include a short "Not shortlisted" section for tickets that looked tempting but were excluded as stale, broad, blocked, or ambiguous.

## Output

Return:

### Best next tickets

- ticket
- why it is easy
- likely files or area
- one concrete risk or uncertainty
- confidence: high / medium / low

### Excluded

- ticket
- why it was not shortlisted

## Rules

- Work from current repo state, not ticket age or title alone.
- Do not change ticket status.
- Do not propose tickets whose repo relevance is not clear.
- Do not call a ticket easy if the hard part is simply unspecified.
- Prefer a smaller trustworthy shortlist over a longer noisy one.
