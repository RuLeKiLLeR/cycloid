---
name: easiest-ticket-to-stack
description: End-to-end workflow that finds the single easiest still-useful open Linear ticket for the current repo, writes a structured plan file to ~/.claude/plans and stops for approval, then on approval implements it as a Graphite stack in a fresh worktree (one PR per unit) and returns only the github.com PR URLs. Use when Josiah says "find the easiest ticket, plan it, and ship it as a stack" or wants the full pick-plan-implement loop from one command.
user_invocable: true
argument: optional focus area such as guardrails, docs, or reliability, and optional repo override
---

# Easiest Ticket to Stack

Works in the current repository. Runs three phases in sequence:

1. **Pick** the single easiest still-useful open Linear ticket.
2. **Plan** it into a structured plan file, then stop and wait for explicit approval.
3. **Implement** the approved plan as a Graphite stack in a fresh worktree, one PR per unit, and report only the github.com PR URLs.

There is exactly one hard gate: after writing the plan you stop and wait. Approval of the plan authorizes the entire implementation phase - do not add further per-PR gates.

## Input

`$ARGUMENTS` may contain any of:

- a focus area such as `guardrails`, `docs`, or `reliability` (ranking hint, not a hard filter)
- an explicit repo such as `trycycloid/cycloid` or a full GitHub URL

If no repo is given, resolve it from the checkout. If the repo cannot be proven, stop and ask; do not guess.

---

## Phase 1: Pick the single easiest ticket

Reuse the `shortlist-easy-linear-tickets` rubric in full, but return exactly **one** ticket - the easiest still-useful candidate - not a shortlist.

Condensed rubric:

1. Resolve the repo and default branch from the checkout (unless overridden):

   ```bash
   git remote get-url origin
   gh repo view --json nameWithOwner,url,defaultBranchRef
   git fetch origin <default-branch>
   ```

2. Discover open tickets with the bundled Linear read tools (`list_issues`, `get_issue`), scoped to the narrowest trustworthy team/project for this repo. Do not sweep the whole workspace when a repo-aligned scope exists.

3. Keep only tickets with a strong repo-relevance signal: names this repo, has a linked PR here, has a branch targeting this repo, or obviously maps to code owned here. Skip the rest.

4. Drop stale or already-done tickets. Check linked PRs and current code before trusting a ticket:

   ```bash
   gh pr list --state all --limit 1000 \
     --json number,title,body,author,headRefName,baseRefName,state,isDraft,mergeStateStatus,url,updatedAt
   ```

   Read the current code with targeted `rg` / file reads. Drop the ticket if the change already landed, the target code/docs no longer exist, or it was superseded.

5. Score ease conservatively. Prefer one narrow file/module, an obvious implementation location, nearby tests, clear verification, minimal cross-system coordination. Penalize auth/infra/migration/deploy/webhook complexity, broad wording ("improve", "refactor", "make smarter") without a tight acceptance condition, multiple plausible implementations, or a missing expected outcome. Do not call a ticket easy when the hard part is simply unspecified - that is ambiguity, not ease.

6. If a focus area was passed, use it as a ranking weight and tie-breaker, not proof of ease.

Do not change any Linear ticket status in this skill.

Announce the pick in one or two lines: ticket ID, title, URL, the concrete deliverable, the likely implementation surface, and the one real risk. Then proceed straight to Phase 2 (no gate here - the gate is after the plan).

If nothing clearly qualifies, say so and stop. Do not force a weak pick.

---

## Phase 2: Write the plan, then stop

Verify the ticket premise is still valid against current code before planning. If the change already shipped, say so and stop rather than planning adjacent work.

Write the plan to `~/.claude/plans/`, as a new Markdown file named after the task in kebab-case (for example `fix-session-reaper.md`). Reference specific files and symbols as `path:line`, not vague descriptions. Use these exact sections:

- **Goal**: the concrete end state, in one or two sentences.
- **Context**: current behavior, relevant files (`path:line`), and constraints.
- **Proposed changes**: file-by-file, describing what changes and why. Group the changes into the discrete units that will each become one PR (see Phase 3 sizing).
- **Risks & open questions**: edge cases, unknowns, and decisions that need the user's input.
- **Verification**: how each change will be proven locally (tests, harness, or E2E path).

Open the required docs for the touched area before writing the plan so the file-by-file section is accurate.

**Do not write or edit any code in this phase.** Produce the plan file only, tell the user its path and give a short summary of the proposed PR units, then **stop and wait for explicit approval.** Approval covers the whole implementation sequence.

If the user revises the plan, update the file and re-confirm before implementing.

---

## Phase 3: Implement the approved plan as a Graphite stack

Only after explicit approval. Approval of the plan is sign-off for the entire implementation sequence; do not add per-PR gates.

Invoke the `implement-plan-as-stack` skill (via the Skill tool) with the approved absolute plan path.
It owns the fresh worktree setup, PR sizing, bottom-branch adoption, stacked branch creation, per-PR verification, progressive ready-for-review submits, and final stack submit.

### Report

Return **only** the github.com PR URLs, in stack order (bottom to top). No Graphite links, no commentary unless something failed.

```markdown
1. https://github.com/<owner>/<repo>/pull/<n> (PR 1 subject)
2. https://github.com/<owner>/<repo>/pull/<n> (PR 2 subject)
```

---

## Rules

- Exactly one gate: stop after writing the plan and wait for approval. No per-PR gates in Phase 3.
- Do not change Linear ticket status.
- Do not pick a ticket whose repo relevance is unclear, and do not force a weak pick.
- Phase 2 writes a plan file only - no code edits.
- Fresh worktree off `main`; run `scripts/worktree-setup.sh` after creating it.
- One PR per plan unit; split out tangential changes; never bundle.
- Every PR gets local verification + tests before the next is stacked.
- `gt` for every branch/commit/submit; stage by name; always pass a commit body. `gt` failure = stop and surface, never silent fallback.
- Final output is only the github.com PR URLs in stack order.
