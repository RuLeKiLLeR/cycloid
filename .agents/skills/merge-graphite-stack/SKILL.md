---
name: merge-graphite-stack
description: Sweep a Graphite PR stack from the earliest open PR upward. Runs resolve-comments first on each PR, only then arms Graphite's `--merge-when-ready` for that single PR, waits for the merge, and syncs the remainder. Use when a stacked Graphite branch series is ready to land in order.
user_invocable: true
---

# Merge Graphite stack

Land an existing Graphite stack in order. Each PR may take several minutes to merge because branch protection waits on CI; this skill is mostly orchestration and monitoring around an async merge.

## Assumptions

- Repo uses Graphite (`gt`) for stack management. Required checks are enforced via a **repository ruleset** (`gh api repos/<OWNER>/<REPO>/rules/branches/main`), not classic branch protection (`.../branches/main/protection` returns 404). Query the ruleset during the run; do not rely on a hardcoded check list. Merges are squash-only.
- `gt submit --no-stack --no-interactive --publish --no-edit --branch <name> --merge-when-ready` is the per-PR call to arm auto-merge: a Graphite-native passthrough that turns on GitHub's auto-merge on that one PR's head SHA without touching upstack PRs. Use `gh pr merge <N> --auto --squash` only as a rescue when the gt call fails for a specific PR.
- `resolve-comments` (the sibling skill) handles inline + bot feedback, pushes any necessary fixup commits, and adds the `resolved-comments` label when complete. It does **not** arm auto-merge; this skill owns the single per-PR merge-enablement call after `resolve-comments` returns.
- The user is operating from a Graphite worktree, not the primary `main` worktree.

## Do NOT arm the whole stack up-front

`gt submit --stack --merge-when-ready` exists but **must not be used here**. Arming every PR before its own resolve-comments pass means bot or human feedback landing during the merge window can be missed - the PR squash-merges as soon as required checks go green, regardless of pending review threads. This skill arms auto-merge **per PR, only after resolve-comments has completed**, so each PR's feedback is processed before it can land.

## Per-PR loop

For each PR from the earliest open in the stack up:

### Phase A - synchronous setup (under a minute)

1. Check out the PR's branch:

   ```bash
   gt checkout <branch>
   ```

   If `gt checkout` aborts on uncommitted changes, `git stash push -m "<note>" <paths>` first and pop after the merge.

1.5. If the caller supplied Greptile trigger metadata for this PR, wait for Greptile's feedback to exist before resolving comments.
The metadata must include PR number, UTC trigger timestamp, and the head SHA that was triggered.
`resolve-comments` needs the Greptile feedback to exist before it runs.

Greptile is paid per review, and it is triggered **at most once per PR** (matching `greptile-triage-stack`). A Graphite stack restacks constantly - rebasing a child onto an updated parent changes the head SHA without changing the diff content - so do **not** re-trigger just because a restack moved the head. Wait for the existing review; re-trigger only if Greptile was never requested on this PR at all.

Distinguish **completed** Greptile feedback from a bare trigger-accepted signal. Greptile's first `greptile-apps[bot]` comment may only acknowledge the trigger, not carry findings (`greptile-triage-stack` documents that a post-trigger comment/status proves acceptance, not completion), so `resolve-comments` must wait for the terminal signal - a completed Greptile **check-run** on the current head or a Greptile **review** submission - not merely any Greptile comment:

```bash
# Feedback complete? (terminal signal - completed check-run on current head, or a review)
gh api "repos/<OWNER>/<REPO>/commits/$(gh pr view <N> --repo <OWNER>/<REPO> --json headRefOid --jq .headRefOid)/check-runs" \
  --jq 'any(.check_runs[]?; (.name | test("greptile"; "i")) and .status == "completed")'
gh api repos/<OWNER>/<REPO>/pulls/<N>/reviews \
  --jq 'any(.[]; (.user.login | test("greptile"; "i")))'
# Already requested? (a prior @greptileai trigger comment, or any Greptile comment, is in flight)
gh api repos/<OWNER>/<REPO>/issues/<N>/comments \
  --jq 'any(.[]; ((.body // "") | test("(^|\\s)@greptileai(\\s|$)"; "i")) or .user.login == "greptile-apps[bot]")'
```

- Feedback complete (terminal signal present) → continue to `resolve-comments`, do not re-trigger.
- Requested (a trigger comment or a bare Greptile comment exists) but not yet complete → poll for up to 15 minutes for the terminal signal, then continue. Do **not** post a second trigger.
- Neither exists (Greptile was never requested on this PR) → trigger once, then poll:

```bash
triggered_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh pr comment <N> --repo <OWNER>/<REPO> --body '@greptileai'
```

If the poll times out, record `Greptile timed out for #<N>` and proceed to `resolve-comments`; do not block the whole stack indefinitely, and do not re-trigger.

2. **Bring genuinely-red required checks green before resolving comments.** A PR sometimes opens with a _real_ failing required check (most often the backend `test` job) unrelated to any review feedback. Fix it now, before `resolve-comments`, so feedback is processed against a green base instead of layered onto broken code. Do **not** wait for a green CI run before moving on - the CI fix rides up with the resolve-comments push (steps 3–4), and the Phase B monitor already enforces green before the merge lands. Waiting for green twice (once here, once after resolve-comments) doubles the CI wall-clock on every PR for no added safety.

   Inspect required checks on the current head SHA:

   ```bash
   gh pr checks <N> --repo <OWNER>/<REPO> --json name,bucket \
     --jq '[.[] | select(.bucket=="fail") | .name] | join(",")'
   ```

   - Nothing failing → move on to resolve-comments (step 3).
   - A required check is failing but matches a **Known failure mode** (infra flap: base-retarget race, merge conflict, stale FAILURE after a passing re-run) → handle it per that entry, not here. Those are not code fixes; an empty commit or rebase is the remedy.
   - A required check is failing for a **genuine code reason** (a real `test` / `build` / `lint` break in the PR's own diff) → read the failing job's logs, fix in the working tree, and commit the fix on its own before running resolve-comments:

     ```bash
     run=$(gh pr checks <N> --repo <OWNER>/<REPO> --json link,bucket \
       --jq 'first(.[] | select(.bucket=="fail")).link' | grep -oE 'runs/[0-9]+' | grep -oE '[0-9]+')
     gh run view "$run" --repo <OWNER>/<REPO> --log-failed
     # ...fix the code, stage by name, then:
     gt modify --commit -m "[ci-fix] - <subject>" -m "<why the check was red + what fixed it>" --no-interactive
     ```

   Keep the CI fix a **separate commit** from resolve-comments' commit: clean attribution, and a real test break deserves its own commit. Do not blindly re-run a suspected-flaky check to make it pass - only fix genuine failures, and surface anything ambiguous rather than papering over it.

3. Check for a prepared prepass artifact for this PR before invoking the sibling skill.
   A prepass artifact is only valid when Phase C rekeyed it to this PR's current post-restack head SHA and an authoritative re-collection shows no new feedback since the prepass snapshot.
   Re-collect comments, review threads, and bot findings now; this re-collection is the source of truth, not the artifact.
   If the recorded post-restack head SHA is missing or differs from the current head, the prepared patch conflicts, or new feedback arrived, discard the artifact, record the discard reason in the merge report, and run the normal `/resolve-comments <PR#>` path.
   If the artifact still matches, pass it as prepared context into the next `/resolve-comments <PR#>` run; do not apply or commit it here.

   ```bash
   # Prepared artifact is validated read-only here; resolve-comments owns applying it, replies, and label.
   git apply --check <prepared-patch>
   ```

   The validated prepass may replace the expensive analysis portion of `resolve-comments`, but it never fully processes a PR by itself.
   `resolve-comments` still owns applying any patch, posting replies, and adding the `resolved-comments` label after this PR's feedback has been processed.

4. Run the sibling skill for every PR: `/resolve-comments <PR#>`.
   If step 3 validated a prepared artifact, provide that artifact as context and tell `resolve-comments` to apply that patch once before posting replies and labeling; if no artifact is valid, run the normal path.
   It:
   - reads inline + top-level bot/human comments
   - applies code fixes
   - posts replies marked `[RESOLVE PARENT COMMENT]`
   - adds the `resolved-comments` label

5. Arm auto-merge for **only this PR** via Graphite's native passthrough:

   ```bash
   gt submit --no-stack --no-interactive --publish --no-edit --branch <branch> --merge-when-ready
   ```

   This pushes the branch (if needed) and should turn on GitHub's auto-merge on that one PR's head SHA. **Immediately verify `autoMergeRequest` is non-null.** When entering merge from a stack that was submitted moments earlier (e.g. via ship-stack Phase 3 or a Phase C retarget), this call will **usually** no-op and leave auto-merge unarmed - expect the `gh pr merge <N> --repo <OWNER>/<REPO> --auto --squash` rescue to be the standard path, not an exception. Graphite 1.8.x can print `No-op` / `All PRs up to date` for an already-current PR and skip the `--merge-when-ready` side effect, leaving GitHub auto-merge unarmed. If `autoMergeRequest` is still null, run that per-PR rescue.

   **`--no-stack` is required.** Without it, `gt submit` defaults to walking up the stack and prompting whether to also submit branches with open PRs; combined with `--no-interactive`, the default may still include those upstack PRs, and `--merge-when-ready` applies to **all PRs being submitted** in the same operation. That re-arms upstack PRs before their own resolve-comments - the exact race this skill prevents.

6. If the resolve-comments fix changes a function signature or API used by an upstack PR (very common - a parameter rename in PR N often breaks PR N+1's call site), check out PR N+1 and patch the call site immediately. Don't wait for the rebase to discover it as a textual non-conflict that ships a broken call. Commit on N+1 via `gt modify --commit -m "[resolve-comments] - cascade fix for #<N>" -m "Fixes call site broken by the PR N change."`. **Do not arm auto-merge on N+1 yet** - that happens in N+1's own loop iteration after its own resolve-comments pass.

### Phase A.5 - confirm required checks will actually report (do this every time, before the monitor)

The #1 cause of "the PR sits forever on pending checks that never run." Most of this repo's required CI workflows gate on `on.pull_request.branches: [main]`, evaluated against the PR's **base branch at the instant the event fires**. Graphite's submit force-pushes the head (a `synchronize` event) and only _then_ retargets the base to `main` a second or two later - so the `synchronize` fires while the base is still the stacked parent, the `branches: [main]` filter excludes `build`/`lint`/`test`, and **no check run is ever created** for them. The later base flip to `main` does not re-fire `synchronize`, so they never appear. GitHub renders them as "Expected - waiting for status to be reported" and holds `mergeStateStatus: BLOCKED` indefinitely. They won't show in `gh pr checks` (no run was created), so it looks like phantom pending checks. (`check` from `migration-isolation.yml` often _does_ report, because that workflow also listens to `labeled` and the `resolved-comments` label re-triggers it after the base is already `main` - so seeing only `check` present with `build`/`lint`/`test` absent is the signature of this bug.)

After arming auto-merge (step 4), confirm every **required** context is present in the head SHA's rollup. If any required context is _missing_ (absent, not failing), there are TWO distinct causes and the fix differs - **check `mergeable` first**:

- `mergeable == "CONFLICTING"` (merge conflict with main): GitHub cannot build the PR's test-merge commit, and `pull_request` workflows run against that merge commit - so GitHub Actions never even creates a check-suite for the required jobs (GitHub Apps like Greptile/Strix still run; they do not need the merge ref). **An empty commit does NOT fix this - it loops forever.** Rebase onto current main and resolve the conflict, then push. Common on a stack because main advances under it between merges. Confirm with `gh pr view <N> --json mergeable` returning `CONFLICTING`, not the base-retarget race below.
- `mergeable == "MERGEABLE"` and `base == main` (the base-retarget race): force a fresh `synchronize` with an empty commit so the branch-filtered workflows fire with `base == main`.
- `mergeable == "UNKNOWN"`: GitHub is still computing mergeability - wait a few seconds and re-query before acting.

```bash
# Required contexts - this repo enforces them via a ruleset, NOT classic branch protection.
required=$(gh api "repos/<OWNER>/<REPO>/rules/branches/main" \
  --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context] | unique | .[]' | sort)
# Contexts actually reported on the current head SHA (CheckRun -> .name, StatusContext -> .context).
reported=$(gh pr view <N> --repo <OWNER>/<REPO> --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | (.name // .context)] | unique | .[]' | sort)
missing=$(comm -23 <(echo "$required") <(echo "$reported"))
shards_pending=$(gh pr checks <N> --repo <OWNER>/<REPO> --json name,bucket \
  --jq 'any(.[]; (.name == "test-shard-1" or .name == "test-shard-2") and .bucket == "pending")')
[[ "$shards_pending" == "true" ]] && missing=$(echo "$missing" | grep -vx test || true)
mergeable=$(gh pr view <N> --repo <OWNER>/<REPO> --json mergeable --jq .mergeable)
if [[ -n "$missing" ]]; then
  if [[ "$mergeable" == "CONFLICTING" ]]; then
    # Merge conflict: the test-merge commit can't be built, so pull_request Actions never start.
    # Rebase onto current main and resolve - an empty commit does nothing here.
    echo "MERGE CONFLICT - rebase and resolve, do NOT empty-commit"
    git branch -f main origin/main   # FF local main (it is not checked out in this worktree)
    gt restack                       # resolve conflicts, then: gt add <file>; gt continue
    gt submit --no-stack --no-interactive --publish --no-edit --branch <branch> --merge-when-ready
  elif [[ "$mergeable" == "MERGEABLE" ]]; then
    echo "MISSING REQUIRED CHECKS (base-retarget race): $missing"
    # `gt modify -c` rejects a clean worktree. Prefer the Graphite synchronization
    # fallback below: stage the smallest non-behavioral edit in an already-touched
    # test/comment file, then create the synchronization commit with `gt`.
    git add <sync-file>
    gt modify -c -m "[ci] Force required checks after base retarget" -m "Re-run branch-filtered required checks after retargeting onto main" --no-interactive
    # If no safe non-behavioral edit exists, the empty-commit exception below is
    # the only permitted native commit; use it instead of inventing a code change.
    gt submit --no-stack --no-interactive --publish --no-edit --branch <branch> --merge-when-ready
  else
    echo "mergeable=UNKNOWN - wait and re-query before acting"
  fi
fi
```

Only act when a required context is genuinely absent.
A required check that is _present and pending/running_ just needs the monitor to wait - do not churn the head SHA under a running check.
Treat the required `test` aggregator as pending while either `test-shard-1` or `test-shard-2` is pending; GitHub does not create the dependent `test` job until both shards finish, so its temporary absence is not the base-retarget race.

### Phase B - async wait (3–10 min depending on CI)

7. Start a Monitor that polls the PR and exits on a terminal state. Don't poll yourself; let the monitor notify you. The loop also breaks on the missing-required-check signature above so you act instead of waiting forever:

   ```bash
   required=$(gh api "repos/<OWNER>/<REPO>/rules/branches/main" \
     --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context] | unique | .[]' | sort)
   while true; do
     state=$(gh pr view <N> --repo <OWNER>/<REPO> --json state,mergeStateStatus --jq '"\(.state) \(.mergeStateStatus)"')
     echo "[$(date +%H:%M:%S)] $state"
     [[ "$state" == MERGED* ]] && echo MERGED && break
     [[ "$state" == CLOSED* ]] && echo "PR CLOSED" && break
     failed=$(gh pr checks <N> --repo <OWNER>/<REPO> --json name,bucket --jq '[.[] | select(.bucket=="fail") | .name] | join(",")')
     [[ -n "$failed" ]] && echo "CHECKS FAILED: $failed" && break
     # BLOCKED with a required context that was never even reported => phantom-pending bug, not a slow check
     if [[ "$state" == "OPEN BLOCKED" ]]; then
       reported=$(gh pr view <N> --repo <OWNER>/<REPO> --json statusCheckRollup --jq '[.statusCheckRollup[] | (.name // .context)] | unique | .[]' | sort)
       missing=$(comm -23 <(echo "$required") <(echo "$reported"))
       shards_pending=$(gh pr checks <N> --repo <OWNER>/<REPO> --json name,bucket \
         --jq 'any(.[]; (.name == "test-shard-1" or .name == "test-shard-2") and .bucket == "pending")')
       [[ "$shards_pending" == "true" ]] && missing=$(echo "$missing" | grep -vx test || true)
       [[ -n "$missing" ]] && echo "MISSING REQUIRED CHECKS: $missing" && break
     fi
     sleep 30
   done
   ```

8. While the Phase B monitor waits for PR N to merge, run a read-only preparation prepass for PR N+1 if one exists.
   This prepass is **not** an invocation of `resolve-comments`, because that sibling skill mutates PRs, posts replies, commits, labels, and arms auto-merge.
   Do not check out PR N+1, do not touch any branch, do not commit, do not push, do not label, do not reply, and do not arm `--merge-when-ready`.
   Keep the working tree on PR N's branch while the monitor is active.

   The prepass may use read-only GitHub API calls to fetch and classify PR N+1's review threads, top-level comments, bot findings, and relevant check/status rollups.
   Draft the intended fixes as a patch artifact in the session scratchpad, keyed to PR N+1's pre-restack head SHA and the feedback snapshot timestamp.
   The artifact must state the assumptions it depends on: pre-restack head SHA, files touched, feedback item IDs, and whether any finding was intentionally left as non-actionable.
   If a safe patch cannot be drafted without checking out PR N+1, skip the prepass and record that no artifact was prepared.

9. On `MERGED`, go to Phase C.

10. On `CHECKS FAILED`, diagnose - see "Known failure modes". Most repeat failures here are infra issues with known fixes, not real test breakage. If none of the Known failure modes fit, treat it as a **genuine code break** (e.g. the resolve-comments commit itself broke a `test` / `build` / `lint`): read logs with `gh run view <run> --log-failed`, fix in the working tree, and commit `[ci-fix] - <subject>` via `gt modify --commit` - same path as Phase A step 2. After fixing (flap or code break), re-arm the single PR with `gt submit --no-stack --no-interactive --publish --no-edit --branch <branch> --merge-when-ready` and restart the monitor.

10b. On `MISSING REQUIRED CHECKS`, follow the Phase A.5 triage and the matching Known failure modes entry. Do not keep waiting; the missing checks will never arrive on their own.

### Phase C - restack the remainder

11. Move off the merged branch before syncing - `gt sync`'s cleanup tries to `git switch main` and fails if `main` is checked out in another worktree (it usually is - the user's primary worktree). Hop to the next PR up:

```bash
gt checkout <next-branch-up>
gt sync --no-interactive --force
```

`gt sync` pulls trunk, deletes the merged branch locally, and restacks every descendant.

12. Re-submit the stack (without arming auto-merge) so the remaining PRs retarget main on each force-pushed head. Each upstack PR gets its own auto-merge arm in its own Phase A auto-merge step, not here:

```bash
gt submit --stack --no-interactive --publish --no-edit
```

If Phase B prepared an artifact for the next PR, rekey it now after the restack: capture the next PR's current head SHA, re-collect feedback read-only, run `git apply --check <prepared-patch>`, and only then add `postRestackHeadSha: <sha>` to the artifact.
If the patch no longer applies or new feedback arrived, discard the artifact and record `discarded: post-restack mismatch` in the merge report.

13. Back to Phase A for the new earliest open PR.

## Known failure modes

Things that have actually broken in this repo's CI. Treat as first-pass diagnoses before assuming a real bug. If none of these fit, the failure is a genuine code break - fix the code and commit `[ci-fix] - <subject>` (Phase A step 2 for a PR that opens red, Phase B step 8 for a break the monitor catches), not an empty commit or rebase.

### Required checks never appear AND `mergeable: false` (merge conflict, not the phantom-pending race)

Looks identical to the phantom-pending bug - `mergeStateStatus: BLOCKED`, required `build`/`lint`/`test` absent from the rollup, nothing in `gh pr checks` - but the cause is a **merge conflict with main**, not the base-retarget race. `pull_request` workflows run against the PR's test-merge commit (`refs/pull/N/merge`); when the branch conflicts with main, GitHub cannot build that commit, so GitHub **Actions** never create a check-suite for the required jobs. GitHub **Apps** (Greptile, Strix, CodeRabbit, the QA app) do not need the merge ref, so they still run - the tell: App check-suites exist for the head SHA but there is **no `github-actions` check-suite at all**. Common on a stack because main advances under it between merges (e.g. a sibling PR refactors a file your branch also touches).

Diagnose - the one query that disambiguates this from the race:

```bash
gh pr view <N> --repo <OWNER>/<REPO> --json mergeable,mergeStateStatus  # mergeable:false / "CONFLICTING" => conflict
gh api "repos/<OWNER>/<REPO>/commits/<HEAD_SHA>/check-suites" --jq '[.check_suites[].app.slug]'  # no "github-actions" => Actions never ran
```

Fix - rebase onto current main and resolve; an empty commit does NOT help and will loop forever:

```bash
git branch -f main origin/main        # FF local main (not checked out in this worktree)
gt restack                            # hits the conflict
# ...edit the conflicted file(s), then:
gt add <conflicted-file>
gt continue
gt submit --no-stack --no-interactive --publish --no-edit --branch <branch> --merge-when-ready
```

After the push, `mergeable` flips to `MERGEABLE` and the test-merge commit builds, so all required Actions finally start. Only then does the monitor make sense.

### `mergeStateStatus: BLOCKED` with required checks that never appear (phantom pending checks)

**The most common reason a PR "just sits there waiting on checks that never run."** The required workflows (`build`, `lint`, `test`) gate on `on.pull_request.branches: [main]`, evaluated against the **base branch at the moment the event fires**. Graphite submits a stacked PR by force-pushing the head (`synchronize`) and only then retargeting the base to `main` - so the `synchronize` fires while the base is still the parent branch, the filter excludes those workflows, and **no check run is ever created**. The subsequent base→`main` flip does not re-fire `synchronize`. Result: GitHub shows `build`/`lint`/`test` as "Expected - waiting for status to be reported," `mergeStateStatus` stays `BLOCKED`, and `gh pr checks` shows nothing for them (no run to show). Tell-tale: the rollup `state` is `SUCCESS` and only a subset of required checks is present (often just `check`, because `migration-isolation.yml` also listens to `labeled` and the `resolved-comments` label re-triggers it after base is already `main`).

Diagnose:

```bash
gh pr view <N> --repo <OWNER>/<REPO> --json statusCheckRollup --jq '.statusCheckRollup[] | (.name // .context)'  # what reported
gh api "repos/<OWNER>/<REPO>/rules/branches/main" --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'  # what is required
```

If a required context is in the second list but not the first, it was never created. Fix: while `base == main`, make the smallest non-behavioral edit in an already-touched test/comment file so a fresh `synchronize` fires, then re-arm. `gt modify -c` cannot create an empty synchronization commit from a clean worktree, so stage the edit by name and use:

```bash
git add <sync-file>
gt modify -c -m "[ci] Force required checks after base retarget" -m "Re-run branch-filtered required checks after retargeting onto main" --no-interactive
gt submit --no-stack --no-interactive --publish --no-edit --branch <branch> --merge-when-ready
```

Phase A.5 prevents this proactively on every PR; this entry is the after-the-fact rescue. Do not wait it out - the checks will never arrive on their own.

### `mergeStateStatus: BLOCKED` after the failed check was re-run and passed

A successful re-run does not retroactively replace the original FAILURE in the GraphQL `statusCheckRollup`; branch protection keeps blocking on the old conclusion.

Fix: make the smallest non-behavioral edit in an already-touched test/comment file so the head SHA changes and all check runs re-evaluate cleanly. `gt modify -c` rejects a clean worktree:

```bash
git add <sync-file>
gt modify -c -m "[ci] Force re-run after <reason>" -m "Refresh the check head after the prior failed run was re-run" --no-interactive
gt submit --no-stack --no-interactive --publish --no-edit --branch <current-branch> --merge-when-ready
```

If no safe non-behavioral edit exists, use the same narrow empty-commit exception instead of changing production or configuration code:

```bash
git commit --allow-empty -m "[ci] Force re-run after <reason>"
gt submit --no-stack --no-interactive --publish --no-edit --branch <current-branch> --merge-when-ready
```

### `gt sync` aborts with `'main' is already used by worktree at <path>`

`gt sync`'s cleanup tries to switch to `main` to delete the merged branch, but `main` lives in the primary worktree.

Fix: `gt checkout <some-non-merged-branch>` first, then re-run `gt sync --no-interactive --force`.

### `gt submit` aborts with `trunk branch is out of date and could not be updated`

Same root cause - `gt` can't pull main because it's checked out elsewhere. If `gt sync` already worked and only the submit step fails, fall back to a manual rebase + force-push:

```bash
git rebase --onto origin/main <prior-merged-branch> <current-branch>
gt track --parent main --force
git push --force-with-lease origin <current-branch>
```

Then re-enable auto-merge on the single PR via `gh pr merge <N> --auto --squash`. The per-PR `gt submit --no-stack --branch <branch> --merge-when-ready` call in Phase A step 4 can resume on the next iteration.

### `gt submit --merge-when-ready` no-ops and leaves auto-merge unarmed

If `gt submit --no-stack --no-interactive --publish --no-edit --branch <branch> --merge-when-ready` prints `No-op` / `All PRs up to date`, verify `autoMergeRequest`.
If it is still null, Graphite did not arm auto-merge for the already-current branch.
Use the per-PR rescue path:

```bash
gh pr view <N> --repo <OWNER>/<REPO> --json autoMergeRequest
gh pr merge <N> --repo <OWNER>/<REPO> --auto --squash
```

### Cascading code break across the stack after a resolve-comments fix

If you renamed a parameter, changed a return shape, or moved an export on PR N during resolve-comments, the call site in PR N+1 is now wrong. `gt restack`'s textual rebase will not detect this - it replays PR N+1's commits cleanly, and CI fails on a fresh test run.

Fix preemptively: after pushing the PR N fix, `gt checkout` PR N+1 and patch the call site, then `gt modify --commit -m "[resolve-comments] - cascade fix for #<N>" -m "Fixes call site broken by the PR N change."`. The fixup commit usually auto-squashes into PR N+1's main commit during the next `gt sync` rebase, so the PR stays one clean commit.

### Strix Security Review reports `NEUTRAL` / `skipping`

Strix sometimes posts a non-`SUCCESS`, non-`FAILURE` conclusion on PRs touching certain files. If Strix is a required check, that can leave `mergeStateStatus: BLOCKED` despite no real failure. Inspect the run output first - if Strix genuinely skipped (e.g. doc-only change), the empty-commit retrigger above is usually enough.

## Commands actually used

Verified against `gt --help` and `gh --help`:

- `gt submit --no-stack --no-interactive --publish --no-edit --branch <name> --merge-when-ready` - push a single branch, create/update its PR, and arm Graphite's auto-merge on it. **The primary merge-enablement call for this skill**, used once per PR after resolve-comments completes.
- `gt submit --stack --no-interactive --publish --no-edit` - push the whole stack to GitHub (PR creation, base retargeting) WITHOUT arming auto-merge. Use during Phase C after a merge to retarget upstack PRs onto the new main. Never combine `--stack` and `--merge-when-ready`; that's the bug this skill exists to prevent.
- `gt checkout <branch>` - switch to a branch; refuses on uncommitted changes
- `gt log short --stack` - show only the current branch's stack (`-s` is the short flag)
- `gt sync --no-interactive --force` - pull trunk, delete merged branches, restack descendants
- `gt restack` - replay a branch onto its restacked parent (most often run implicitly by `gt sync`)
- `gt modify --commit -m "<subject>" -m "<body>"` - add a new commit to the current branch and auto-restack descendants. Body = why + what changed.
- `gh pr ready <N>` - mark a draft PR ready (a prerequisite for `--merge-when-ready` on that PR)
- `gh pr merge <N> --auto --squash` - per-PR rescue when `--merge-when-ready` cannot be used for a single PR (e.g. the trunk-out-of-date failure mode above)
- `gh pr checks <N> --repo <OWNER>/<REPO> --json name,bucket` - machine-readable check states (`pass` / `fail` / `pending` / `skipping`)
- `gh pr view <N> --json state,mergeStateStatus,autoMergeRequest` - top-level merge readiness; `autoMergeRequest` is non-null when auto-merge is armed

One flag this skill does **not** use:

- `gt merge` merges every PR from trunk to the current branch in one operation. **Do not call this** - it bypasses CI gating and merges the whole stack at once.

## Reporting

After each PR lands, append a one-line entry to the running summary:

| PR  | Status | Resolve-comments fixes (one-line) |
| --- | ------ | --------------------------------- |

Include prepass outcomes when they happened:

- `prepared` when a read-only artifact was drafted for the next PR.
- `applied` when the next PR validated and used that artifact.
- `discarded: <reason>` when the artifact did not match after restack or new feedback arrived.

When stopped by a blocker, include:

- exact PR number
- failing check names from `gh pr checks`
- which "Known failure modes" category it fits, or "novel" with logs

## Rules

- Arm auto-merge **per PR, only after `resolve-comments` has completed for that PR** via `gt submit --no-stack --branch <branch> --merge-when-ready`. Never arm the whole stack up-front - that lets bot/human feedback land after a PR has already squash-merged. `--no-stack` is mandatory; without it the submit may walk upstack and arm `--merge-when-ready` on every PR in the same operation.
- Run `resolve-comments` per PR for actual code/feedback work. After it pushes fixes, the same `gt submit --no-stack --branch <branch> --merge-when-ready` call re-arms the new head SHA.
- A preparation prepass is read-only and may only run while waiting for the previous PR to merge. It cannot check out the next branch, mutate a PR, commit, push, label, reply, or arm auto-merge.
- A prepass artifact is advisory until the next PR's own loop re-collects feedback and validates the recorded head SHA. On mismatch, conflict, or new feedback, discard it loudly and run the normal path.
- Wait for `MERGED` or a terminal check failure before moving up the stack. Do not move up on `pending`.
- `gt sync` between merges. After sync use `gt submit --stack` (no `--merge-when-ready`) to retarget upstack PR bases; the next per-PR iteration arms its own auto-merge.
- Never call `gt merge` - it merges the whole stack at once and bypasses CI gating.
- Never push to `main` directly. Never force-push to a branch someone else may have updated without checking.
- For cascading code breaks across the stack, patch upstream PRs proactively - don't let CI discover it after the fact. The fixup commit goes onto the upstack PR's branch but its auto-merge stays disarmed until that PR's own Phase A.
- Stop and surface the blocker rather than escalating to risky workarounds. `--no-verify`, force-push to base, or skipping required checks is never the right move.
- If this run exposes and resolves a novel repeatable failure mode, append the smallest accurate entry to **Known failure modes** in a separate small PR after the stack merge work is complete.
