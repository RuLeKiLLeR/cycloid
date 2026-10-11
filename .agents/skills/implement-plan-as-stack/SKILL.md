---
name: implement-plan-as-stack
description: Implement an approved local plan file as a Graphite stack in a fresh worktree, one PR per Proposed changes unit, using the correct bottom-branch adoption flow and progressive ready-for-review submits.
user_invocable: true
argument: absolute path to an approved/spec-checked plan markdown file
---

# Implement plan as Graphite stack

Build the whole approved plan as a Graphite stack.
Use this for plan files that are already approved or are being run by a no-gates parent workflow.

## Input

The user provides an absolute plan path as `$ARGUMENTS`.
Resolve it, verify it exists, and read the plan fresh before implementing.
Use the plan's Proposed changes section as the starting PR breakdown.

## Fresh worktree off `main`

Create a fresh git worktree off `origin/main`:

```bash
git fetch origin main
git worktree add <path> -b <bottom-branch> origin/main
cd <path>
bash scripts/worktree-setup.sh
```

`worktree add -b` leaves you on `<bottom-branch>` sitting at `origin/main` with no commits yet.
It is not yet a Graphite-tracked branch, and it is the bottom of the stack.
Do not `gt create` a second branch here; that stacks an empty parent.

Graphite config lives in the common git dir, so `gt` works from the worktree.
If `gt ls` errors from the worktree, use `docs/graphite.md` "Repair broken local state".

## PR sizing

- One PR = one idea.
- Each discrete unit from the plan's Proposed changes becomes its own PR.
- No bundling.
- Split tangential refactors, renames, or cleanups into their own PRs.
- If a unit grows large or spans more than one idea, split it further.

## Per-PR loop

Repeat bottom-up for each unit:

1. Implement the smallest scoped change that satisfies this unit.
   Inspect current code before editing.
2. Add or extend tests in the same PR.
   New DAO/service functions, branching routes, and shared parsing logic need tests.
3. Run the narrowest meaningful local verification.
   If it fails, debug and fix within scope before moving on.
   Never stack the next PR on unverified work.
4. Stage by name, never `-a`, `-u`, `-p`, `.`, or `--all`.
5. Commit with a real body.

For the bottom unit, adopt the existing bottom branch onto trunk and create the first commit:

```bash
git add <files>
gt track --parent main
gt modify -c -m "<subject>" -m "<why + what changed>" --no-interactive
```

Before `gt track`, confirm local `main` is current with `origin/main`.
If `git rev-parse main` differs from `git rev-parse origin/main`, fast-forward local `main` safely from the checkout that owns it (usually the primary worktree) or run `gt sync`; do not track the bottom branch against stale `main`.
If `gt track` reports the branch is already tracked, skip that command.

For every stacked unit above it, create a new child branch from the branch you just committed:

```bash
git add <files>
gt create <next-branch> -m "<subject>" -m "<why + what changed>" --no-interactive
```

Body = why + what changed.
If a pre-commit hook reformats files, it is auto-restaged into the commit.

Submit each PR ready for review before starting the next unit:

```bash
gt submit --no-interactive --publish
```

`--no-interactive` alone opens drafts; `--publish` forces ready.
A subject-only commit produces a PR with no description.
Capture and record the github.com PR URL and number from the submit output for this unit.

After the final unit, re-push and retarget the whole stack:

```bash
gt submit --stack --no-interactive --publish
```

Then complete `docs/workflow.md#branch-and-pr-hygiene`.

If `gt` fails at any point, stop, surface the exact output, and investigate.
Do not silently fall back to native git or `gh`.

## Report

Return only the github.com PR URLs and numbers in stack order, bottom to top.
