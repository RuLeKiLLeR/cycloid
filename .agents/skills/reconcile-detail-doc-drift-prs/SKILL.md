---
name: reconcile-detail-doc-drift-prs
description: Find all open doc-drift pull requests authored by `app/detail-app` in the current repo, compare each proposed documentation patch against the current `main` branch, merge the PRs whose changes are still correct, and close the PRs whose patches are stale or already obsolete. Use when asked to sweep PRs like Detail PR #3285.
user_invocable: true
---

# Reconcile Detail doc-drift PRs

Takes no arguments. Work in the current repository.

## Goal

Process every open Detail-generated doc-drift PR and choose exactly one outcome per PR:

- merge it
- close it as stale
- leave it open and report why it was ambiguous or blocked

Act only on PRs matching the Detail doc-drift pattern. Do not touch unrelated bot PRs.

## Step 1: Discover candidate PRs

Derive the repo from the current checkout and list open PRs authored by `app/detail-app`:

```bash
gh pr list --state open --limit 200 --search 'author:app/detail-app' \
  --json number,title,body,author,headRefName,baseRefName,isDraft,mergeStateStatus,url,updatedAt
```

Keep only PRs where all of these hold:

- `author.login` is `app/detail-app`
- the head branch starts with `detail/`
- the base branch is `main`

Treat the `Doc Drift PRs can be configured here` body marker as a secondary confirmation, not the sole gate. If author, branch, and base match but the body text has drifted, inspect the PR before excluding it.

For each candidate, fetch file metadata:

```bash
gh pr view <N> --json files
gh pr diff <N>
```

Continue automatically when every changed file is documentation or other text-only repo content such as:

- `*.md`
- `docs/**`
- `README*`
- other obviously documentation-only text files

If a candidate also edits code files, inspect the diff before stopping.
You may continue automatically only when the non-doc changes are purely non-executable documentation text, such as comments, block comments, JSDoc/docstrings, or type/interface comments, and the changed statements still match the current codebase.
Treat those PRs as doc-drift PRs, but mention the comment-only code-file edit in the report.

You may also continue automatically for a narrowly scoped executable metadata-list correction when all of these are true:

- The code edit only adds or corrects an entry in a canonical deletion/export/coverage registry such as `OFFBOARDING_USER_ID_TABLES`, `OFFBOARDING_SESSION_ID_TABLES`, `OFFBOARDING_ROOT_TABLES`, or an equivalent table/list whose purpose is to keep lifecycle cleanup, export, or compliance coverage aligned with schema.
- The PR body or surrounding docs explain the drift as missing coverage for a table or field introduced by the referenced commit.
- Current `origin/main` proves the table/field exists and has the referenced ownership key by schema, DAO, or migration evidence.
- The table/list semantics prove the change is coverage-only and does not introduce a new behavior path beyond including already-existing owned data in the established cleanup/export mechanism.
- Existing tests and required checks pass, or a focused local test covers the registry behavior.

Treat these as doc-drift parity PRs, but mention the executable metadata-list edit in the report.
If the evidence does not prove ownership, schema, and coverage-only semantics, leave the PR open and report the ambiguity.

If a candidate edits executable code, config, migrations, workflows, infra, generated artifacts, or anything whose semantics are not obviously comment-only, stop and report it instead of acting automatically.
Do not rely on file extension alone; inspect the hunk content.

## Step 2: Compare the PR against current `main`

Always compare against the live target branch, not the PR's original base snapshot:

```bash
git fetch origin main
```

For each candidate PR, save the patch and test whether it still applies cleanly to current `origin/main` in a temporary detached worktree:

```bash
PATCH="$(mktemp -t detail-doc-pr.XXXXXX.patch)"
WORKTREE="$(mktemp -d "${TMPDIR:-/tmp}/detail-doc-pr.XXXXXX")"

cleanup() {
  if [ -n "${WORKTREE:-}" ]; then
    git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  fi
  rm -f "${PATCH:-}"
}
trap cleanup EXIT

gh pr diff <N> > "$PATCH"
git worktree add --detach "$WORKTREE" origin/main
git -C "$WORKTREE" apply --check "$PATCH"

trap - EXIT
cleanup
```

Interpret conservatively:

- If `git apply --check` succeeds, the patch is still current enough to consider merging.
- If it fails, inspect the changed files on `origin/main` and the PR diff to decide whether the PR is clearly stale.

Treat the PR as **stale** only when the evidence is clear, such as:

- the intended wording or structural correction is already present on `origin/main`
- the text the PR wants to replace no longer exists because later edits made the fix obsolete
- the referenced code or file structure changed enough that the proposed doc update is no longer accurate

Do **not** close automatically when the failure is ambiguous. If the patch does not apply cleanly and you cannot clearly prove it is obsolete, leave the PR open and report it for manual follow-up.

Remove the temporary worktree after each PR:

```bash
git worktree remove --force "$WORKTREE"
rm -f "$PATCH"
```

## Step 3: Merge non-stale PRs

For every PR whose patch still applies cleanly and whose content still matches the current codebase, confirm mergeability right before acting:

```bash
gh pr view <N> --json isDraft,mergeStateStatus,title,url
gh pr checks <N>
```

Rules:

- Do not merge draft PRs.
- Do not merge PRs with conflicts or failed required checks.
- If checks are pending but the PR is otherwise mergeable, prefer enabling auto-merge instead of waiting idly.

Use squash merge:

```bash
gh pr merge <N> --squash --delete-branch
```

If required checks are still pending and GitHub allows auto-merge:

```bash
gh pr merge <N> --auto --squash --delete-branch
```

## Step 4: Close stale PRs

When a PR is clearly obsolete, close it with a short reason tied to current `main`:

```bash
gh pr close <N> --delete-branch --comment "<brief stale reason>"
```

Good close reasons are concrete and current, for example:

- the wording the PR adds is already present on `main`
- the target section has already been rewritten, so the patch no longer applies
- the codebase changed after the source commit and the proposed doc explanation is now inaccurate

Do not use vague comments like `stale` by itself.

See [the shared Skill Feedback Loop guidance](docs/skill-shared.md#skill-feedback-loop).

## Step 5: Report the sweep

Concise summary with three sections when applicable:

### Merged

- PR number and title
- one sentence on why it was still current

### Closed as stale

- PR number and title
- one sentence on the evidence that made it obsolete

### Left open

- PR number and title
- exact blocker or ambiguity

### Skill gaps

- Friction events and proposed fixes per the Skill Feedback Loop section; omit when there was none.

## Rules

- Compare every PR against current `origin/main`, not memory and not the PR's original base SHA.
- Fail closed on ambiguity. Only auto-close when the stale conclusion is clear.
- Only auto-merge when the doc change still matches the current codebase.
- Do not broaden scope into editing the PR branch, refreshing patches, or fixing unrelated checks.
- Do not touch non-Detail PRs or non-doc-only PRs, except for the verified executable metadata-list corrections allowed above.
