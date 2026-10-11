# Workflow

Agent planning, task tracking, worktrees, and PR hygiene.

## Planning

- Write non-trivial implementation plans to `~/.claude/plans/<descriptive-name>.md`.
- Before finalizing a non-trivial plan, ask enough alignment questions to confirm scope, constraints, sequencing, verification, and publish or handoff expectations (five questions is a default, not a quota). For every open question, include a recommendation, brief rationale, and the default assumption if unanswered.
- Do not dump the full plan inline in chat.
- Re-plan when assumptions break instead of pushing through a broken approach.

## Task tracking

1. Start from a named plan file.
2. Check in before implementation begins.
3. Mark progress in the plan as the work moves.
4. Add a short review section when the task is done.

## Linear ticket intake

- Before implementing from a Linear ticket, verify it against current code, tests, migrations, docs, and linked PRs/sessions.
- Report `valid`, `already fixed`, `obsolete`, `duplicate`, or `needs clarification` with evidence before editing.
- Do not implement stale ticket text; narrow partial tickets to the still-valid failing behavior.

## Local worktrees

These rules apply only to Codex or Claude Code in a local developer checkout. Sandbox sessions already run in an isolated checkout and must not create or inspect nested worktrees; enforced in `apps/sandbox-bridge/src/utils/bash-parser.ts`.

- In a local developer checkout, create a worktree before editing repo files.
- Base the worktree on the latest `origin/main`, creating the branch at add time. Plain `git worktree add <path> origin/main` detaches HEAD and breaks `gt create`:

```bash
git fetch origin main
git worktree add -b <branch> ../<dir> origin/main
cd ../<dir> && bash scripts/worktree-setup.sh
gt track <branch> --parent main
```

- First branch in a local worktree: `git worktree add -b <branch> ../<dir> origin/main` -> `git commit -m "<subject>" -m "<body>"` -> `gt track <branch> --parent main` -> `gt submit --no-interactive --publish`.
- Stacked follow-up branch: `gt create <branch> -m "<subject>" -m "<body>" --no-interactive`.
- Current branch amend or added commit: `gt modify [-c] -m "<subject>" -m "<body>" --no-interactive`.
- Always include a commit body. `gt submit` copies the PR body from the commit body, so a subject-only commit produces a PR with no description. Body = why + what changed.
- Open PRs ready for review, never draft. Never pass `--draft` to `gt submit` or `gh pr create`; use `gt submit --publish` to force ready if a draft default ever creeps in.
- Run `npm run dev:full` only for live API/UI, browser, webhook/tunnel, or E2E/product verification. Unit tests, docs/static checks, and focused Vitest suites do not need it. For E2B, sandbox app-runtime, and Cycloid-on-Cycloid dogfood startup details, use [e2b-local-setup.md](e2b-local-setup.md).
- Run `npm run format` in the worktree before committing changes to formatter-supported files.
- Run `npm run lint:changed` before opening a PR; it checks TypeScript changes from `origin/main` through staged, unstaged, and untracked files.
- Use direct `npx eslint <files...>` for a narrow pre-commit check of specific files.
- Use `npm run lint` for a full-repo autofix pass when the focused check reports fixable issues.
- Read-only exploration can happen on `main`; edits should not.

## Branch and PR hygiene

- `docs/workflow.md` is the canonical place for Cycloid-owned publish and handoff workflow. Do not restate these rules in root repo instruction files.
- In local developer checkouts, Graphite (`gt`) is the default branch and PR workflow. Prefer `gt create`, `gt modify`, `gt submit`, `gt restack`, and `gt sync` over manual branch management or `gh pr create`. One-time setup and local-state repair: [graphite.md](graphite.md).
- Use `gh` for authenticated GitHub reads and investigation. Use `gh` for PR creation/mutation only when Graphite is unavailable, blocked by missing auth or workspace access, or explicitly requested.
- One concern per branch and per PR.
- Check `git status` and `git diff` before starting.
- Keep the branch clean relative to `origin/main`.
- For Cycloid-run Codex sessions, "done" means scoped changes committed locally with verification evidence. The sandbox bridge handles branch creation and push after post-execution succeeds, and the control plane creates or updates the PR.
- In customer-facing or user-facing responses, report publish outcomes directly (`PR opened`, `publish blocked`, `no PR needed`) and never explain bridge/control-plane ownership.
- When handing work back to a user, provide explicit non-worktree test instructions for the bridge-published branch: remove the worktree, check out the published branch in their main checkout, pull with `--ff-only`, run normal startup commands there.
- Include the exact branch name and worktree path in those handoff steps. Prefer a concrete command block: `git worktree remove <path>`, `git checkout <branch>`, `git pull --ff-only origin <branch>`, then the repo's normal startup commands.
- If the worktree contains unrelated or ambiguous changes, stop and ask before staging or relying on bridge publication.
- Update the PR title/body if the implementation direction changes materially.
- If publishing one slice of an ordered plan, title the PR `[i/N] <short title>`, where `N` is the number of planned PRs. Add a short `## Plan` PR-body section with the local plan path as plain text (or a shareable plan link) and current slice. Omit the prefix when the plan has no ordered PR sequence.
- PR bodies must include external sources consulted when code depends on current third-party facts: links plus a short note on verified values/behavior (model pricing, context limits, API support, rate limits, SDK contracts).
- The control plane opens or updates the PR once the change is ready so CI starts immediately.
- When investigating a Cycloid-authored PR, check the PR body for the `📋 Session transcript` link before asking the user for session context. If missing, use `bash scripts/debug/customer-session-prompt.sh` with the PR URL, branch, or session UUID; the script resolves all branch formats (legacy suffixed branches and post-#7194 clean branches) and retrieves the exact prompt across businesses.
- If a published PR needs an out-of-scope commit removed, reset locally before the next bridge-managed publish step instead of creating a revert commit. Manual `git push --force-with-lease` is human-only recovery outside the agent session.

### Attaching screenshots to PRs

This repo is private, so `raw.githubusercontent.com` URLs 404 for unauthenticated clients and `gh gist create` rejects binary files. To embed a screenshot in a PR description:

1. Commit the image into the PR branch itself under `docs/images/` (e.g. `docs/images/pr-<number>-<slug>.png`). No orphan asset branches.
2. Reference it in the PR body with an authenticated GitHub blob URL: `https://github.com/trycycloid/cycloid/blob/<branch>/docs/images/<file>?raw=true`. GitHub serves this through the viewer's auth cookie and renders inline for anyone who can read the repo.
3. Verify the image loads in the rendered PR view before reporting the task done — do not assume the URL works.

## Execution habits

- Trace bugs end-to-end before patching them.
- For clear fixes, act first; ask only if scope or risk is ambiguous.
- Run the relevant local commands, tests, repros, and verification yourself when the environment supports them.
- Default to doing the work instead of delegating it or pushing runnable verification back to the user.
- Prove changes with tests, logs, or other concrete verification before calling the task done.
- Pull real CI or Terraform failure context from GitHub instead of guessing.
- Implementation philosophy: [docs/conventions.md](conventions.md).

## Evidence-backed decisions

Speculation is not a deliverable. For any recommendation, prioritization, diagnosis, or
claim that something is useful/broken/done, report:

- `Claim:` what you assert.
- `Evidence:` data that settles it (query+result, `file:line`, metric, session ID, row
  count) and its source: code, prod D1, Datadog (us5), `wrangler tail`, Braintrust, `gh`,
  or a real Cycloid session.
- `Confidence + unverified:` what you could not prove and the cheapest way to prove it.

Get gettable data before deciding; never ship the guess. If it is not gettable, label the
assumption unverified (marked-unverified is fine; a guess sold as a finding is not), and try
to disprove load-bearing claims first.

Performance investigations specialize this rule.

## GitHub App permission changes

When changing Cycloid GitHub App permissions or scoped installation-token permissions, prove the exact API surface first. A GitHub CLI command may span multiple permission families; for example, `gh pr checks` reads `statusCheckRollup` and needs both `checks:read` for check runs and `statuses:read` for classic commit statuses.

Required checklist:

1. Identify the exact sandbox, push, webhook, review-loop, or server-side operation that needs the permission.
2. Verify the required GitHub App permission from GitHub docs, GitHub CLI/source, or a live scoped-token repro. Do not infer from the command name.
3. Put the permission on the narrowest token surface: clone/`gh` sandbox token, push-only token, or server-side control-plane token.
4. Decide whether the permission is required or degradable. Clone/push/PR-read basics fail closed; optional CI-read and push-only widenings must have explicit fallback behavior.
5. Update constants, comments, guardrail tests, and customer/admin re-approval notes in the same PR. Tests must name the user-visible operation the permission enables.
6. Before merge or post-deploy verification, run the real command or API call with a token scoped to the intended permission set.

## Performance investigations

When proposing a performance optimization, report:

- `Metric/Baseline:`
- `Bottleneck evidence:`
- `Recommendation + why:`
- `Expected delta/Confidence:`
- `Verification plan:`
- `Observability:` metric name + Datadog dashboard (existing or to-add)

When the change measurably alters a perf-sensitive code path, also make it measurable:

1. Confirm the metric is emitted: reuse an existing `cycloid.*` metric, add a log-derived metric in `infra/datadog-log-metrics.tf`, or emit via an existing server-side helper (`postStructuredEventToDd` / `postCountMetric`). Do not hand-roll a Datadog POST. Tags stay low-cardinality and PII-free (no `session_id`, branch, prompt text, raw paths, or user IDs).
2. Add or extend a Terraform `datadog_dashboard` widget in the domain-appropriate `infra/datadog-*.tf` so the metric is tracked before/after. Run `terraform -chdir=infra fmt -recursive`, `terraform -chdir=infra fmt -check -recursive`, and `terraform -chdir=infra validate -no-color`; validate the query in the Datadog editor when you have access, else report it as unvalidated.

Do both in the same PR only when cheap: an existing structured event or numeric log field carries the metric, no new secret or env var, no migration, no hot-path blocking, no high-cardinality tags, and the change is covered by focused local verification. Otherwise call it out as an explicit follow-up in your final response (the control plane owns the PR body), never skip it silently. Datadog is Terraform-only (`infra/*.tf`), us5 endpoints; never edit the UI/API/MCP. Split infra-first only if a deploy workflow depends on the newly applied infra (see [docs/infrastructure.md](infrastructure.md)).

## Self-improvement

- When a failure exposes a missing rule, add the rule to the canonical doc in the same pass as the fix.
- If no existing doc fits, add a concise invariant to `docs/conventions.md`.
- Do not use `.claude/lessons.md`; it is not part of the active instruction path.
