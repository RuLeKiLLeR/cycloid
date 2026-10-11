---
name: ship-stack
description: Ship a Cycloid task, plan file, PR, branch, or stack ref through the no-gate Graphite pipeline to merged PRs with Greptile triage and deployed-verification verdicts.
user_invocable: true
argument: a task prompt (full run) OR a plan-file path (skip planning, start at spec-check) OR a PR number/URL, branch, or stack ref (skip to Greptile + merge). One arg, classified at intake; `plan:`/`pr:` prefixes force an entrypoint. Natural phrases such as `this stack`, `the stack`, or `current stack` mean the entire currently checked-out Graphite stack, including all open descendant PRs.
---

# Ship stack

End-to-end pipeline for the Cycloid repo: **a single argument in, merged and verified PRs out.** Runs six phases back to back with **no approval gates** - the only human touch is reviewing the PRs live if you want to. This replaces the manual sequence of plan -> clear context -> `/spec-check` -> implement -> `/greptile-triage-stack` -> `/merge-graphite-stack` -> `/verify-deployed-pr`.

The six phases are one resumable pipeline, and the argument decides **where it starts** (see Input): a task prompt runs all six; a plan-file path starts at Phase 2; a PR/branch/stack ref starts at Phase 4. Every entrypoint runs the same phases from that point to the end, under the same no-gates rule.

Run from a checkout of the `trycycloid/cycloid` repo (it chains the repo-local `spec-check`, `greptile-triage-stack`, `merge-graphite-stack`, and `verify-deployed-pr` skills). If the current repo is not Cycloid, say so and stop.

## Prerequisites

This skill will fail partway if the local environment is not set up. Before Phase 1, assume these exist; if a phase's tool is missing, surface the exact error and stop.

- **Claude Code** - this skill runs in it.
- **Codex** (`codex exec` on `PATH`, configured via `~/.codex/config.toml`) - the `spec-check` phase runs an adversarial Claude + Codex review and spawns a background `codex exec`. Without Codex, spec-check cannot converge.
- **Graphite** (`gt`) - every branch/commit/submit goes through `gt`.
- **Authenticated `gh`** - PR creation, Greptile-comment polling, and merge status.

## Input - one argument, three entrypoints

`$ARGUMENTS` decides where the pipeline starts. **Classify it before doing anything else**, announce the entrypoint in one line, then run every phase from there to the end without stopping.

1. **Task prompt** (the default) - free text describing what to build. Start at **Phase 1**; run all six phases.
2. **Plan-file path** - an existing plan on disk. Skip Phase 1; record that path as the plan and start at **Phase 2** (spec-check it, then implement it as a stack).
3. **PR / branch / stack ref** - the code is already built and PR'd. Skip Phases 1-3 and start at **Phase 4** (Greptile triage -> merge). This includes the shorthand used after submitting a stack: `/ship-stack this stack` means “process every open PR in the current Graphite stack,” not only the current branch's PR.

### How to classify

Resolve, do not guess. Apply in order; first match wins:

- **Empty argument** - ask once for the task prompt and stop. This is the only unavoidable question.
- **Explicit prefix override** - `plan: <path>` forces case 2; `pr: <ref>` forces case 3. Strip the prefix and use the rest as the value. Use these when the heuristic below would misread the input.
- **Plan file (case 2)** - the argument, trimmed, is a path to a file that exists on disk, or a bare `*.md` filename found under `~/.claude/plans/`. Confirm with a filesystem check (`test -f`); resolve to an absolute path and treat it as the plan.
- **PR / branch / stack ref (case 3)** - the argument is a PR number (`123` / `#123`), a `github.com/<owner>/<repo>/pull/N` URL, a branch name that `gt ls` or `git branch --all` actually knows, or literally names the current stack (`this stack`, `current stack`, `the stack`, `this PR stack`, `these PRs`). Normalize case and surrounding whitespace before matching the shorthand. A shorthand is valid only when the checkout is on a Graphite-managed non-trunk branch with a real stack; if it is on `main` or has no stack, stop and ask for a concrete branch or PR instead of guessing.
- **Otherwise** - treat it as a task prompt (case 1). A string that is only _plausibly_ a branch but does not resolve to a real branch/PR is a task prompt, not case 3.

Once classified, jump to the named phase. Everything after that runs without stopping - the no-gates rule below applies to whichever entrypoint you took.

## The one rule about gates

There are **no** approval gates. Do not stop to ask "does the plan look good?", "continue to implementation?", or "ready to merge?". The user has opted into a fully automatic run. Stop only when genuinely blocked:

- empty task prompt (ask once, above)
- the premise is already shipped / impossible (say so, stop)
- a required tool hard-fails: `gt`, `codex`, `gh` (surface the exact output, stop - never silent fallback)

Everything else, keep going.

---

## Phase 1 - Write the plan

> Entrypoint for the **task-prompt** case only. If you were handed a plan file (case 2) or a PR/stack ref (case 3), skip this phase entirely.

Write the plan to `~/.claude/plans/`, using a new Markdown file named after the task in kebab-case (e.g. `fix-session-reaper.md`).
Open the required docs for the touched area first and inspect files as needed.
Do not edit code, create branches, commit, push, or ask for approval during this phase.

The plan must reference specific files and symbols as `path:line`, never vague descriptions. Use exactly these sections:

- **Goal**: the concrete end state, in one or two sentences.
- **Context**: current behavior, relevant files (`path:line`), and constraints.
- **Proposed changes**: file-by-file, describing what changes and why. Group changes into the discrete units that will each become one PR (see Phase 3 sizing).
- **Risks & open questions**: edge cases, unknowns, and decisions.
- **Verification**: how each change is proven locally (tests, harness, or E2E path).

**Do not write or edit any code in this phase.** Produce the plan file only, then continue straight to Phase 2 - do not stop for approval.

Record the absolute plan path; the next phases need it.

---

## Phase 2 - Spec-check the plan

> **Entrypoint for the plan-file case.** When entered here, the "absolute plan path" below is the file you were handed (case 2) - resolved to an absolute path in the Input step. A handed-in plan is spec-checked like any other; do not skip this on the assumption it is already reviewed. (spec-check is idempotent enough that re-checking a reviewed plan is safe.)

Invoke the `spec-check` skill (via the Skill tool) with the absolute plan path as its argument. **Run it inline in this context - do not wrap it in a subagent.** `spec-check` runs an adversarial review loop of Claude (you) plus a background `codex exec` reviewer, so its independent "fresh eyes" come from Codex, not from clearing context; the background Codex run depends on the main-loop harness re-invoking you when it finishes, which a subagent would break.

`spec-check` **rewrites the plan file in place** (its Step 5) to fold in every Blocking and Should-address finding, so there is nothing extra to apply here. When it returns:

1. If its summary says the plan was fundamentally misconceived or the work is already shipped, say so and stop.
2. Otherwise continue to Phase 3 - the plan file on disk is now the improved version.

> Note: the manual flow cleared context before `/spec-check`. Phase 1 now isolates plan authoring in a subagent for task-prompt runs; plan-file entrypoints still start here with the artifact the user supplied. The Codex reviewer remains the independent second angle.

---

## Phase 3 - Implement the plan as a Graphite stack

Invoke the `implement-plan-as-stack` skill (via the Skill tool) with the absolute plan path.
It owns the fresh worktree setup, PR sizing, bottom-branch adoption flow, stacked branch creation, per-PR verification, progressive ready-for-review submits, and final stack submit.

Record the github.com PR URL and number it returns for each unit, in stack order.

---

## Phase 4 - Triage Greptile on the stack

> **Entrypoint for the PR/branch/stack case.** When you arrive here from Phase 3, "this stack" is the stack you just built. When entered directly (case 3), first point yourself at the right stack. For shorthand (`this stack`, `the stack`, `current stack`, `this PR stack`, or `these PRs`), treat the current checkout as the anchor and enumerate the complete stack with `gt log short --stack`; include every open descendant PR even when the user says “a bunch of PRs.” Do not reduce the run to the checked-out branch's single PR.
>
> - **Current stack** (a shorthand above): already checked out - nothing to do beyond confirming `gt log short --stack` contains the intended branches. If the checkout is `main` or the command shows no managed stack, stop and ask for a concrete PR or branch; never infer a stack from recency or from unrelated open PRs.
> - **A branch name**: `gt checkout <branch>` so the sibling skills operate on that stack.
> - **A PR number/URL**: resolve to its branch and check it out - `gh pr view <N> --repo <OWNER>/<REPO> --json headRefName -q .headRefName`, then `gt checkout <headRefName>`. If `gt checkout` aborts on uncommitted changes, stash by path first.
>
> `merge-graphite-stack` (Phase 5) assumes you are operating from a Graphite worktree on the stack, so this checkout is a prerequisite, not a convenience. If the ref does not resolve to a real branch/PR, stop and say so (do not fall back to treating it as a task prompt this late).

Before submitting a continuation branch, verify its Graphite parent is the intended downstack branch (not `main`) with `gt log short --stack` and the PR's `baseRefName`/`headRefName`. If the parent is wrong, repair tracking or recreate the child from the intended parent before submitting; never submit a duplicate stack rooted at `main`.

Invoke the `greptile-triage-stack` skill (via the Skill tool) in `--pipeline-mode`. It walks the stack, judges each PR's diff, and posts the `@greptileai` trigger **only** on PRs that warrant a paid review, skipping trivial ones. Pass it no arg to triage the checked-out stack, or the explicit branch / PR list from case 3. Record each triggered PR number, trigger timestamp, and head SHA; pass that metadata to Phase 5 so merge waits on the correct current-head Greptile signal. If it triggered nothing, note that and continue to Phase 5.

---

## Phase 5 - Merge the stack in order

Invoke the `merge-graphite-stack` skill (via the Skill tool), passing the Greptile trigger metadata captured in Phase 4. It sweeps from the earliest open PR upward, waits for any triggered Greptile review on that PR's current head, runs `resolve-comments` (handling Greptile + inline feedback and pushing fixups), then arms `--merge-when-ready` for that single PR, verifies `autoMergeRequest` is non-null, waits for it to land, and syncs the rest. Do not arm the whole stack up front; let the sibling skill drive its per-PR loop. If `gt submit --merge-when-ready` reports a no-op for an already-submitted PR and auto-merge is still unset, use `gh pr merge <N> --auto --squash` as the documented rescue.

After a base PR squash-merges, refresh `main` and move the continuation branch onto the new trunk before resubmitting it: `gt move --source <child-branch> --onto main --only`. Squash merges replace the downstack commit with a new trunk commit, so `gt submit --stack` can otherwise reject the child because the merged commit is not in its trunk ancestry; verify the child now targets `main` before continuing.

After every base retarget, confirm all required ruleset contexts are present on the PR head. If the PR is mergeable but required checks are absent, use the Graphite synchronization fallback in `merge-graphite-stack`: `gt modify -c` cannot create an empty commit from a clean worktree, so make the smallest non-behavioral edit in an already-touched test/comment file, stage it by name, create the synchronization commit with `gt modify -c`, and resubmit the single PR so branch-filtered workflows run against `main`. If no safe edit exists, use that skill’s narrow `git commit --allow-empty` exception rather than inventing a production/configuration change; native commits remain forbidden for every other recovery or ordinary commit.

Record which PRs actually landed; Phase 6 verifies only merged PRs.

---

## Phase 6 - Verify deployed behavior

The merged stack deploys to production off `main` (control plane, UI, sandbox image, CLI, per surface). Close the loop: prove each merged PR's behavior in the deployed environment, or explicitly record why a PR is not worth verifying. Only merged PRs are eligible - skip any that did not land in Phase 5.

**This phase reports; it does not gate.** ship-stack has already merged - do not roll back, revert, or open follow-up PRs here. A FAIL is surfaced loudly in the report (with evidence) for the human; your live PR review stays the authoritative gate.

### Triage first, then try to verify every runtime change

Do not skip a runtime PR merely because the probe mutates a pull request. First create the smallest disposable fixture needed in `trycycloid/cycloid` (normally a temporary branch and open PR), run the production session against that fixture, and clean up the fixture afterward when safe. The default is to verify every merged runtime PR; conservatively skipping a test that could have used a disposable fixture is a pipeline failure.

For each merged PR, judge its diff and pick one:

- **Verify** - the PR changes runtime behavior on a surface a real Cycloid session against `trycycloid/cycloid` can reach: control plane, UI, CLI, sandbox/bridge, or prompt/agent behavior.
- **Skip as literally untestable** - only when the behavior cannot be safely forced with a disposable fixture, cannot be observed through a real session or authoritative local harness, or is inherently nondeterministic (for example, a narrow race). Record the exact blocker and the attempted alternatives. Do not use this category for behavior that merely requires creating a temporary PR.
  - docs, comments, tests-only, or dev-tooling with no runtime surface;
  - infra/Terraform/CI/config with no session-observable behavior;
  - behavior that only manifests under conditions you cannot safely or cheaply force in prod (destructive, customer-visible, load- or failure-path-dependent, cost-amplifying);
  - a code path not reachable by a session against `trycycloid/cycloid`.

If a PR is literally untestable, say "not verified: literally untestable - <reason>" and move on. Do not contort production or create customer-visible risk, but exhaust a disposable repo fixture and the smallest local harness first.
For provider-specific behavior, confirm the default verification business uses that provider before selecting **Verify**; otherwise classify it as literally untestable because the session cannot reach the changed path.

### Verify each verifiable PR

For each PR you marked Verify, invoke the `verify-deployed-pr` skill (via the Skill tool) with that PR number. It waits for the deployment, starts a fresh cold CLI session that exercises the PR behavior, queries Braintrust/Datadog/D1, and returns an evidence-backed pass/fail. Since the whole stack landed on `main`, the deploy is shared: the first verification pays the deploy wait, the rest resolve quickly.

Collect per PR: **verified pass**, **verified FAIL** (with the failing signal and IDs - prompt ID, `bt_span_id`, `dd_trace_id`), or **not verified** (literally untestable: reason and attempted alternatives). Do not stop the pipeline on a FAIL; finish verifying the remaining PRs, then report all results together.

---

See [the shared Skill Feedback Loop guidance](docs/skill-shared.md#skill-feedback-loop).

## Report

Return the github.com PR URLs in stack order (bottom to top), each with its landed/open status and its Phase 6 verification verdict.
No Graphite links.
During long-running phases, emit one terse progress update at phase boundaries and before waits for external work.
Keep the final report to the URL list and failure or Skill Feedback Loop notes.
A verified FAIL always gets a one-line evidence note beneath its row.
If friction occurred, append the `Skill gaps` section after the PR URL list.

Before the final report, capture lessons from avoidable pipeline friction actually hit during this run.
For each wrong command, stale assumption, missing guardrail, or wasted round-trip that a small skill edit would have prevented, name the root cause and propose the smallest terse edit to both mirrored `ship-stack` skill files (`.agents/skills/ship-stack/SKILL.md` and `.claude/skills/ship-stack/SKILL.md`) or the pointed doc.
Do not apply those edits in the implementation worktree; offer a separate small follow-up PR instead.
Do not invent hypothetical improvements, and do not bloat skill prose with narrative.
If the run was clean or only hit external blockers, record no lesson edit.

```markdown
1. https://github.com/trycycloid/cycloid/pull/<n> (subject) - merged - verified pass
2. https://github.com/trycycloid/cycloid/pull/<n> (subject) - merged - not verified (literally untestable: infra-only)
3. https://github.com/trycycloid/cycloid/pull/<n> (subject) - merged - verified FAIL
   - <failing signal + prompt ID / bt_span_id / dd_trace_id>

Skill gaps

- <friction event, root cause, owner, smallest concrete edit or user action>
```

---

## Rules recap

- One argument, three entrypoints (classified at intake): task prompt -> Phase 1; plan-file path -> Phase 2; PR/branch/stack ref -> Phase 4. `plan:`/`pr:` prefixes force an entrypoint. Announce the entrypoint, then run to the end (through Phase 6).
- Zero approval gates. Only stop when blocked (empty prompt, impossible premise, unresolvable plan/PR ref, hard tool failure in `gt`/`codex`/`gh`).
- Phase 1 writes a plan file only - no code.
- Phase 2 runs `spec-check` inline (not in a subagent); it runs the Claude + Codex adversarial loop and rewrites the plan file in place.
- Fresh worktree off `main`; `scripts/worktree-setup.sh` after creating it.
- One PR per plan unit; split out tangential changes; never bundle.
- Every PR gets local verification + tests before the next is stacked.
- `gt` for every branch/commit/submit; stage by name; always pass a commit body. `gt` failure = stop and surface.
- Greptile is triggered selectively (Phase 4); `merge-graphite-stack` waits per PR before `resolve-comments` and merges in order (Phase 5).
- Phase 6 verifies deployed behavior for every merged runtime PR via `verify-deployed-pr`, using disposable repo fixtures when needed; only literally untestable behavior is recorded "not verified: literally untestable - <reason>" with attempted alternatives. Verification reports pass/fail, never gates or rolls back.
- Final output is only the github.com PR URLs in stack order, each with landed status + verification verdict.
