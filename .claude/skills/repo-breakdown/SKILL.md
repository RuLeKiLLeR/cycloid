---
name: repo-breakdown
description: Break down this repository into understandable areas, explain what each area owns, and keep a running log of which parts have already been reviewed versus which parts are still todo. Use when the user wants a recurring repo walkthrough, onboarding map, or ongoing inventory of explored and unexplored codebase areas.
user_invocable: true
argument: optional area to review next, such as apps/control-plane-worker, shared, tests, or docs
---

# Repo Breakdown

Use when the user wants to understand the repository over time rather than in one pass.

Durable tracker: `docs/repo-breakdown-log.md`. If it does not exist, create it first.

## Goal

Maintain a running repository map answering: what parts have we already broken down, and what parts not yet. Each invocation should help the user understand the codebase and update the tracker so the next invocation continues from current state.

## Default workflow

1. Read `AGENTS.md` and the current `docs/repo-breakdown-log.md`.
2. If the user named a target area in `$ARGUMENTS`, use that area.
3. Otherwise, pick the highest-value remaining `todo` area from the log.
4. Read only the files needed to explain that area accurately.
5. Update `docs/repo-breakdown-log.md`:
   - mark the reviewed area as `done`
   - add dated notes under `Breakdown history`
   - refresh any notes, open questions, or suggested next order
   - add newly discovered sub-areas if they matter
6. Reply with a concise plain-English explanation of the area and point to the updated log.

## How to break an area down

For the selected area, explain:

- what it is
- why it exists
- the main entry points
- the important folders or files
- how it interacts with the rest of the system
- any confusing or high-risk concepts worth studying later

Prefer concrete file paths over abstract architecture talk.

## Scope rules

- Start top-down: high level before file-by-file details.
- Keep the current pass proportional; do not recursively explain every child directory unless asked.
- For large areas, identify sensible sub-areas and record them in the log for future passes.
- Treat docs as source of truth for orientation, then verify against code.
- Do not invent ownership. If something is unclear, say so and record the uncertainty in the log.

## Log format expectations

Keep the log simple and durable:

- a status legend
- a current map table with `done`, `in_progress`, and `todo`
- a dated `Breakdown history` section
- a short `Suggested next order`

History entries include: area reviewed, short summary of what was learned, important entry points, open questions or next follow-ups.

## Output expectations

In the user-facing reply:

- summarize the area reviewed
- mention the most important files or directories
- say what changed in `docs/repo-breakdown-log.md`
- suggest the next area to review unless the user already chose one

Keep the tone direct and compact. The point is to make the repo steadily easier to navigate.
