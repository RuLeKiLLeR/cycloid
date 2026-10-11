---
name: greptile-triage-stack
description: Triage a Graphite PR stack for Greptile review - decide per PR whether it warrants a review, then trigger Greptile (`@greptileai`) only on the PRs that deserve one, skipping trivial PRs to stay mindful of Greptile cost. Use after submitting a Graphite stack, or on any set of open PRs, to opt reviews in deliberately instead of reviewing everything.
user_invocable: true
argument: optional branch/PR list, plus optional `--pipeline-mode` for no-gate stack callers
---

# Greptile triage for a Graphite stack

Greptile costs money per review. This skill walks a Graphite stack, judges each PR's diff, and posts the `@greptileai` trigger **only** on PRs whose change actually benefits from review. Trivial PRs are left untriggered.

Greptile is opt-in in this repo: `greptile.json` restricts auto-review to PRs carrying the `greptile` label and excludes all bot authors (`excludeAuthors: ["*[bot]"]`). The manual, per-PR trigger is a `@greptileai` PR comment. Nothing in the control plane triggers Greptile automatically - this skill is how a review gets requested.

## Inputs

- No arg: triage the current branch's stack (`gt log short --stack`).
- A branch name, or a list of PR numbers/URLs: triage exactly those.
- `--pipeline-mode`: intended for no-gate stack pipelines. Borderline PRs default to trigger instead of skip, and the report must include trigger timestamp + head SHA for every triggered PR so the merge phase can wait on the exact head.

## Step 1 - enumerate the stack's open PRs

```bash
gt log short --stack            # the branches in the current stack, trunk-up
```

Resolve each non-`main` branch to its PR and pull the fields the triage needs. For each branch:

```bash
gh pr view <branch> --repo <OWNER>/<REPO> \
  --json number,title,isDraft,state,author,additions,deletions,files,headRefOid
```

Drop from the worklist, without spending, any PR that is:

- **not `OPEN`** (merged/closed) - nothing to review.
- **draft** (`isDraft: true`) - still churning; a review now is wasted the moment it's pushed again. Note it as `skip: draft` so the user can re-run after marking it ready.
- **bot-authored** (`author.login` ends in `[bot]`) - `greptile.json` excludes bot authors, so a trigger would no-op.
- **already triggered once** - Greptile was already requested on this PR (a prior `@greptileai` trigger comment) or already responded (summary comment, review, or check). Do not pay again just because a restack moved the head SHA (see Step 3's already-triggered check).

## Step 2 - decide per PR: does this diff deserve a review?

Read the actual diff, not just the stats: `gh pr diff <N> --repo <OWNER>/<REPO>`. Judge the **substance** of the change.
If you need stats, use `gh pr view <N> --repo <OWNER>/<REPO> --json additions,deletions,files`; do not use `gh pr diff --stat`, which is not supported by every installed `gh` version.

**Trigger a review** when the diff contains net-new or materially changed logic, especially any of:

- auth / authorization / session / membership / feature-gating
- credential, secret, or token handling
- the lifecycle FSM, `applyEvent`, state transitions, or CAS/concurrency logic
- DB migrations, schema changes, or DAO queries
- routes, webhooks, or other request-handling entrypoints
- billing, payments, or anything money-touching
- external API / integration contracts, or prompt/agent behavior
- non-trivial control flow, parsing, or algorithms
- a large change (roughly >100 lines of non-mechanical diff) or broad blast radius

**Skip (do not spend)** when the change is clearly low-risk:

- docs / markdown / comments only
- test-only changes
- config, version, or dependency-lock bumps
- pure mechanical rename / move / formatting with no behavior change
- generated files
- tiny, self-evident edits (a few lines, obviously correct)

**When genuinely borderline, default to skip** in normal mode - cost-consciousness is the point - but list it in the report as `borderline` with the reason, so the user can trigger it by hand if they disagree.
In `--pipeline-mode`, default borderline PRs to trigger because there is no human approval gate between triage and merge.
Do not silently swallow a borderline call.

## Step 3 - trigger only the "deserves review" set

Before triggering, confirm Greptile has not **already been requested once** on this PR (idempotence / no double-spend).
Greptile is triggered **at most once per PR**. A Graphite stack restacks constantly - rebasing a child onto an updated parent changes the head SHA without changing the diff content - so a SHA-keyed check pays Greptile again on every restack. Key the check on the PR, not the head.

Skip (do not re-trigger) if **either** of these already exists on the PR, regardless of head SHA:

- a prior `@greptileai` trigger comment (we already requested a review), or
- any Greptile response: a summary/issue comment, a review, or a Greptile check-run.

```bash
# Already requested? (our own trigger comment)
gh api repos/<OWNER>/<REPO>/issues/<N>/comments \
  --jq 'any(.[]; (.body // "") | test("(^|\\s)@greptileai(\\s|$)"; "i"))'

# Already responded? (summary comment / review / check-run on the current head)
gh api repos/<OWNER>/<REPO>/issues/<N>/comments \
  --jq 'any(.[]; .user.login == "greptile-apps[bot]")'
gh api repos/<OWNER>/<REPO>/pulls/<N>/reviews \
  --jq 'any(.[]; (.user.login | test("greptile"; "i")))'
gh api "repos/<OWNER>/<REPO>/commits/$(gh pr view <N> --repo <OWNER>/<REPO> --json headRefOid --jq .headRefOid)/check-runs" \
  --jq 'any(.check_runs[]?; (.name | test("greptile"; "i")) and .status == "completed")'
```

If any of those is true, record `skip: already-triggered` and move on - do not spend again. A restack that moved the head SHA is **not** a reason to re-trigger; if genuinely new work needs a fresh review, a human can comment `@greptileai` manually.

If none is true, record the trigger timestamp and head SHA, then trigger:

```bash
triggered_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
head=$(gh pr view <N> --repo <OWNER>/<REPO> --json headRefOid --jq .headRefOid)
gh pr comment <N> --repo <OWNER>/<REPO> --body '@greptileai'
```

Then verify the trigger landed - Greptile responds with a comment or a check/status within a couple of minutes.
This proves the trigger was accepted, not that a current-head review is complete:

```bash
gh api repos/<OWNER>/<REPO>/issues/<N>/comments --jq 'any(.[]; .user.login == "greptile-apps[bot]")'
# or:
gh pr checks <N> --repo <OWNER>/<REPO> --json name,bucket \
  --jq 'any(.[]; (.name | test("Greptile"; "i")) and .bucket!="pending")'
```

If the trigger comment posts but Greptile never responds, surface the exact PR and the failed verification - do **not** report it as reviewed.

## Step 4 - report

One row per PR:

| PR  | Decision | Reason | Head SHA | Triggered at |
| --- | -------- | ------ | -------- | ------------ |

`Decision` is `triggered`, `skip: <why>` (draft / bot / docs-only / test-only / mechanical / trivial / already-triggered), or `borderline (not triggered)` in normal mode.
For triggered PRs, include the exact head SHA and UTC trigger timestamp that `merge-graphite-stack` must wait against.
Close with a one-line tally: how many triggered vs skipped, and call out any borderline PRs the user may want to trigger manually.

## Rules

- Trigger `@greptileai` **only** on PRs that pass Step 2. Never blanket-trigger the whole stack.
- Trigger Greptile **at most once per PR**. Never re-trigger a PR that already has a prior `@greptileai` trigger comment or any Greptile response, even after a force-push or restack changes the head SHA.
- Never trigger draft or bot-authored PRs.
- Verify every trigger actually produced a Greptile response before reporting it as reviewed; surface blockers instead of silently continuing.
- When in doubt, skip and flag as borderline in normal mode; in `--pipeline-mode`, trigger borderline PRs and state why.
- This skill only requests reviews. Processing the resulting Greptile feedback is `/resolve-comments`.
