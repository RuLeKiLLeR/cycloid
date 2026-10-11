---
name: clean-worktrees
description: Audit git worktrees, create PRs for unpushed work, and remove stale ones. Use when worktrees accumulate and need cleanup.
---

# Clean worktrees

Audit all git worktrees, preserve active work, create PRs for anything worth keeping, remove the rest.

## Critical: all commands run from the main directory

**NEVER cd into a worktree directory.** Run everything from the main working directory (first entry in `git worktree list`). Inspect worktrees via `-C` flags or absolute paths:

- `git -C <worktree-path> status --short`
- `git -C <worktree-path> log main..HEAD --oneline`

If you cd into a worktree and then try to remove it, the removal will fail or corrupt state.

## Step 1: Prune and inventory worktrees

First clean up worktrees whose directories were already deleted:

```
git worktree prune
```

Then `git worktree list`; ignore the main working directory (first entry). For each worktree, gather:

- Branch name
- Worktree age (Step 1b)
- `git -C <worktree-path> status --short` (uncommitted changes)
- `git -C <worktree-path> log main..HEAD --oneline` (unpushed commits vs main)
- Remote branch exists? `git ls-remote --heads origin <branch>` (non-empty = exists)
- PR exists? `gh pr list --head <branch>`

## Step 1b: Age gate -- never touch worktrees created in the last 2 days

Most important rule. Recently created worktrees are almost always still in use. **Any worktree created within the last 2 days (48 hours) is ALWAYS kept, no matter how it would otherwise classify.** Do not push, PR, or remove it.

Get creation time from directory birth time. `stat` flags differ by platform; try BSD (macOS) then GNU (Linux):

```bash
# epoch birth time; BSD `stat -f %B`, fallback to GNU `stat -c %W`
birthtime() { stat -f %B "$1" 2>/dev/null || stat -c %W "$1"; }
birthtime <worktree-path>
```

Compare against `date +%s`: if `now - birthtime < 172800` (2 days in seconds), the worktree is **fresh** and must be kept.

List every worktree path with age in days in one pass (parse paths with `sed`, not `awk $2`, so paths with spaces aren't truncated):

```bash
now=$(date +%s)
birthtime() { stat -f %B "$1" 2>/dev/null || stat -c %W "$1"; }
git worktree list --porcelain | sed -n 's/^worktree //p' | tail -n +2 | while IFS= read -r wt; do
  b=$(birthtime "$wt")
  printf '%s\t%.1f days\n' "$wt" "$(echo "($now-$b)/86400" | bc -l)"
done
```

Mark anything under 2.0 days **fresh / keep** and exclude it from all later steps. If `birthtime` returns `0` or empty (some Linux filesystems lack birth time), treat the worktree as **fresh / keep** rather than risk removing recent work.

## Step 2: Classify each worktree

Present a summary table of all worktrees and their state. Classify each as:

- **Fresh**: created within the last 2 days (Step 1b). Default: **keep** -- always, regardless of other state. Never push, PR, or remove.
- **Active**: uncommitted changes or clearly in progress. Default: **keep**.
- **Has unpushed work**: commits not on main, no PR. Default: **push + create PR, then remove**.
- **Has open PR**: pushed with an open PR. Default: **remove** (work is safe on remote).
- **Stale**: no uncommitted changes, no unpushed commits, or branch already merged. Default: **remove**.

Ask the user to confirm keep vs clean. If the user named worktrees to keep, pre-select those as "keep" and note it, but still confirm.

## Step 3: Handle worktrees marked for cleanup

For each worktree being removed, in order:

### If it has uncommitted changes that should be preserved:

1. Stage and commit with a descriptive message (use `git -C <worktree-path>` for all commands)
2. Push the branch
3. Create a PR if none exists

### If it has unpushed commits and no PR:

1. Push the branch (`git push -u origin <branch>`)
2. Create a PR summarizing the commits

### Then remove:

1. `git worktree remove <path>` (`--force` if needed for trivial leftovers like lockfiles or build artifacts)
2. Delete the local branch: `git branch -D <branch>` (safe -- work is already on remote)
3. **Do NOT delete the remote branch** -- leave it for the PR. If there's no PR and no unpushed work, optionally delete it, but only after confirming it exists: `git ls-remote --heads origin <branch>` first, then `git push origin --delete <branch>`.

## Step 4: Verify

Run `git worktree prune && git worktree list` to confirm final state. Report what was removed and what remains.

## Important

- **All commands run from the main working directory -- never cd into a worktree**
- **Never touch a worktree created in the last 2 days** -- it is almost certainly still in use
- Never remove a worktree the user asked to keep
- Never remove a worktree with uncommitted changes without asking first
- Always ensure work is pushed to remote before removing
- Use specific `git add <file>` commands, never `git add -A` or `git add .`
- Always check a remote branch exists before deleting it
- Run `git worktree prune` before inventory and after cleanup
