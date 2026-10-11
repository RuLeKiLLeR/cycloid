---
name: daily-update
description: Draft a short, themes-based daily status update from visible evidence of today's work. Use when the user wants a concise coworker-facing summary, a copy-pastable Slack update, or a "what I accomplished today" message.
user_invocable: true
argument: optional audience or emphasis such as coworkers, leadership, blockers, or project names
---

# Daily Update

Draft a short Slack-ready update summarizing what the user accomplished today, organized as a handful of themes. Group the day's work by problem area or product surface, not one line per task or stack. On a high-volume day this keeps the update short by rolling many PRs into a few themes.

## Input

`$ARGUMENTS` may give optional guidance: audience, tone, project names to emphasize, or whether to include blockers.

## Gather Evidence

Use visible evidence first. Prefer:

- the current session history
- files edited today in the repo
- today's commits, diffs, and branch context
- PRs, tickets, or tasks explicitly mentioned in the session

When repo evidence is needed, inspect the smallest useful set:

- `git status --short`
- `git diff --stat`
- targeted file reads for the specific work surfaced by the diff or session

Always scope repo history and PR evidence to the current Git user identities for the day:

1. Capture the local Git identity and fail closed if both values are empty:

   ```bash
   git_user_name="$(git config user.name || true)"
   git_user_email="$(git config user.email || true)"

   if [ -z "$git_user_name" ] && [ -z "$git_user_email" ]; then
     echo "No Git user identity is configured; skip repo history and rely on session evidence."
   fi
   ```

2. Capture the authenticated GitHub login only when `gh` is available:

   ```bash
   if command -v gh >/dev/null 2>&1; then
     gh_login="$(gh api user --jq .login)"
   else
     echo "GitHub CLI is unavailable; skip PR evidence and rely on git/session evidence."
   fi
   ```

3. Inspect only today's commits authored by the current Git username or email. Run only queries with non-empty identity values, and dedupe overlapping results before using them:

   ```bash
   if [ -n "$git_user_email" ]; then
     git log --since="midnight" --author="$git_user_email" --stat --oneline
   fi

   if [ -n "$git_user_name" ]; then
     git log --since="midnight" --author="$git_user_name" --stat --oneline
   fi
   ```

4. If `gh` is available, inspect only today's PRs authored by the captured GitHub login in the current repo. Use created and merged dates as same-day PR evidence; do not use `updated` alone because reviewer, CI, or label activity can update a PR without user work:

   ```bash
   if [ -n "${gh_login:-}" ]; then
     repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
     today="$(date +%F)"
     gh search prs --repo "$repo" --author "$gh_login" --created ">=$today" --json number,title,state,url,createdAt,closedAt,updatedAt
     gh search prs --repo "$repo" --author "$gh_login" --merged-at ">=$today" --json number,title,state,url,createdAt,closedAt,updatedAt
   fi
   ```

Do not use unfiltered `git log --since="midnight"` output or other authors' PRs as evidence, even if visible in the current branch history.

If the session already contains enough concrete work items, do not dig further.

## Recover the Parent Task Behind a Stack

Many PRs are not standalone - a whole Graphite stack maps to one task broken into sub-tasks, and the original inspiration lives in a plan, not in any single PR title. A per-PR list buries this. Before drafting, reconstruct the parent task for each stack:

1. **Detect stacks.** Group same-day PRs that share a `[N/M]` title prefix, a common plan link, or a contiguous PR-number range submitted together. Treat the group as one unit of work, not M units.
2. **Read the bodies for the plan link.** `gh pr view <n> --json title,body` on a representative PR (and the first/last in the stack). PR bodies in this repo carry `Why:`/`What:` and often a `Plan: <path>` line pointing at `~/.claude/plans/<slug>.md`.
3. **Open the plan and lift the inspiration.** Read the linked plan file (or, if unlinked, match the stack's theme to a file in `~/.claude/plans/`). Use its `## Goal` and `## Context` sections - that is the original inspiration (the problem, the audit, the ticket, the observed failure that motivated the whole stack). Lead the task with this, not with a concatenation of sub-task titles.

If a stack has no discoverable plan or shared rationale, fall back to grouping by title theme and say what the group accomplishes as a whole.

## What Counts

Include only work that appears to have happened today, supported by visible evidence.

Prefer: completed fixes; merged or prepared changes; meaningful debugging or investigation progress; tests, verification, or rollout work.

Avoid: vague filler; speculative claims; future plans unless explicitly requested; low-signal implementation trivia.

If evidence shows partial progress, phrase it as progress, not completion.

## Group Into Themes

Roll the day's work into a small number of themes - aim for 3 to 6, never one per stack. A theme is a problem area or product surface (e.g. "Review pipeline", "QA verification correctness", "Cost & reliability", "Tooling"). Several stacks and standalone PRs usually collapse into one theme.

For each theme, write a `*Theme name*` header and one or two tight sentences describing what changed and the outcome it delivers - what now works, what bug class no longer reproduces, or what got faster/cheaper/more reliable. Use the parent task behind each stack (see "Recover the Parent Task Behind a Stack") to describe the outcome, not a concatenation of sub-task titles.

Keep it short. Fold minor one-off work into a trailing sentence or an "Also" line rather than giving it its own theme. Do not enumerate PR numbers, stack sizes, or `Task N`/`Metric of Success` scaffolding - the goal is a scannable themes summary, not a full accounting.

If shipping state matters, note it inline in parentheses (e.g. `(merged)`, `(in review)`) rather than splitting the message into shipped/unshipped sections.

## Output Rules

- Return a copy-pastable Slack message as plain text.
- 3 to 6 theme blocks, each a `*Theme name*` header line plus 1-2 sentences.
- Lead each theme with the outcome; coworker-facing language, not internal agent narration.
- No PR numbers, stack ranges, confidence notes, caveats, or evidence appendix in the message.
- Mention blockers only if requested or clearly important; fold them into the relevant theme's sentence.

## Output Shape

```text
*What I worked on today*

*<Theme name>* - <what changed and the outcome it delivers, 1-2 sentences>. (<optional shipping state>)

*<Theme name>* - <outcome>.

*<Theme name>* - <outcome>. Also <minor one-off work folded in>.
```

## Fallback

If there is not enough visible evidence for a trustworthy update, ask one short follow-up question for the missing context instead of inventing accomplishments.
