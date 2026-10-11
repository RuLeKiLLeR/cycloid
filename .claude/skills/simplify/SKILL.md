---
name: simplify
description: Simplify the current branch's PR or local code changes for clarity and maintainability while preserving behavior exactly. Use when the user wants code cleanup or simplification without changing functionality.
user_invocable: true
---

# Simplify

Simplify code that is already in scope on the current branch. Do not take arguments. Detect the scope automatically:

1. First try the current branch PR with `gh pr view`.
2. If a PR exists, simplify only code in that PR.
3. Otherwise, simplify the local delta on the current branch: committed changes vs the branch upstream (fallback `origin/main`), staged changes, and unstaged changes.
4. If there is no PR and no local delta, stop and report that there is nothing to simplify.

## Goal

Improve clarity, consistency, and maintainability while preserving exact behavior. Prefer fewer moving parts, simpler control flow, and existing project patterns. Not a feature change, bug fix spree, or broad refactor outside the current delta.

## Required context

Before editing:

- Read `AGENTS.md` and `docs/conventions.md`.
- Read any file before modifying it.
- Read the relevant area docs if the touched code falls under a documented surface such as testing, database, security, workflow, prompts, bridge, or infra.

## Scope detection

Use authenticated local GitHub context only.

### PR mode

If `gh pr view --json number,title,body,files,baseRefName,headRefName` succeeds for the current branch:

- Treat the PR files as the editable scope.
- Read the PR diff with `gh pr diff`.
- Use the PR title/body only as context for intent; do not expand the scope beyond the PR.

### Local mode

If there is no current-branch PR:

- Read `git status --short --branch`.
- Determine the upstream ref with `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo origin/main`.
- Refresh that upstream ref before reading committed diffs. If the ref is remote-tracking, fetch its remote/branch first.
- Read `git diff --stat <upstreamRef>...HEAD`, `git diff --stat`, and `git diff --cached --stat`.
- Treat the union of committed, staged, and unstaged local changes as the editable scope.

## What good simplification looks like

- Remove redundant branches, variables, wrappers, and comments.
- Reduce nesting when it makes the code easier to read.
- Inline trivial one-use helpers when that improves flow.
- Extract a helper only when it removes repeated logic or meaningfully clarifies the code.
- Prefer explicit readable code over dense clever code.
- Reuse existing helpers, validators, and abstractions instead of adding parallel ones.
- Keep server/client, route/service/DAO, and other repo invariants intact.

## What not to do

- Do not change behavior, data flow, auth, validation rules, SQL semantics, API shapes, or prompt content meaning unless the current code is obviously equivalent after simplification.
- Do not widen the scope beyond the current PR or local delta.
- Do not introduce speculative abstractions, compatibility shims, flags, or cleanup unrelated to the scoped changes.
- Do not revert user changes.

## Execution flow

1. Determine whether the scope is the current branch PR or local delta.
2. Identify the highest-value simplification opportunities inside that scope.
3. Make the smallest coherent edits that improve readability and maintainability without changing behavior.
4. Audit nearby same-pattern code only when the simplification exposes duplicated logic already inside scope.
5. Run targeted verification for touched code.
6. Run `npm run format`.
7. Run `npm run lint:changed`.
8. Summarize what was simplified and how behavior was kept the same.

## Verification

- Run focused tests for touched logic whenever practical.
- If no focused automated test exists, run the smallest available command that proves the risky path still behaves the same.
- Do not claim success without local verification evidence.

## Output

Report:

- whether the skill operated in PR mode or local mode
- which files were simplified
- what kinds of simplifications were made
- what verification ran
