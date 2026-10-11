# Graphite (gt)

Setup, agent operation, and local-state repair for the Graphite CLI (`gt`). When to use `gt` vs `gh`, branch/PR hygiene, and worktree setup live in [workflow.md](workflow.md#branch-and-pr-hygiene); landing a finished stack is the `merge-graphite-stack` skill (`.claude/skills/merge-graphite-stack/SKILL.md`).

## Install, auth, init

1. `npm install -g @withgraphite/graphite-cli@stable`
2. Create a CLI token at <https://app.graphite.dev/activate>, then run `gt auth --token <token>`.
3. In the repo: `gt init --trunk main`.
4. Verify: `gt ls` prints `main`.

## Running gt as an agent

`gt` is interactive by default: missing flags open an editor or a prompt, which hangs a non-TTY agent indefinitely. `gt` auto-detects non-TTY and disables interactivity, but never rely on that - pass the flags that make every command fully non-interactive. Add `-q` (`--quiet`, implies `--no-interactive`) for terse output once a command is known-good.

| Task                                   | Command                                                           | Why                                                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New branch + commit staged changes     | `gt create <name> -m "<subject>" -m "<body>" --no-interactive`    | `-m` skips the editor; name skips AI/prompt; `--no-interactive` skips the "stage unstaged changes?" prompt. Stage by name first (`git add <files>`); never `-a`/`-u`/`-p`. Body = why + what changed.        |
| Stack a branch on the current one      | (same `gt create`, run from the parent)                           | `create` always stacks on the checked-out branch.                                                                                                                                                            |
| Amend current commit                   | `gt modify -m "<subject>" -m "<body>" --no-interactive`           | Auto-restacks descendants. `--no-interactive` skips the staging prompt. Never `-a`; stage by name first. Body = why + what changed.                                                                          |
| Add a new commit to the branch         | `gt modify -c -m "<subject>" -m "<body>" --no-interactive`        | `-c` creates instead of amending. Body = why + what changed.                                                                                                                                                 |
| Open/update PRs, ready for review      | `gt submit --no-interactive --publish`                            | No metadata prompt; PR title/body come from the commit. A subject-only commit produces an empty PR body; see the commit rows. `--no-interactive` alone opens PRs as **draft**; `--publish` opens them ready. |
| Submit whole stack incl. descendants   | `gt submit --stack --no-interactive --publish`                    | `gt ss` is the default alias.                                                                                                                                                                                |
| Submit only branches with existing PRs | `gt submit --update-only --no-interactive`                        | Won't open PRs for new branches.                                                                                                                                                                             |
| Preview a submit                       | `gt submit --dry-run --no-interactive`                            | Reports PRs, pushes nothing. `--no-interactive` keeps the preview from prompting for new-branch metadata.                                                                                                    |
| Pull trunk + rebase all stacks         | `gt sync --no-interactive`                                        | Use before stacking new work. `-f` skips delete confirmations.                                                                                                                                               |
| Rebase a stack onto its parents        | `gt restack`                                                      | Run after a parent branch changes.                                                                                                                                                                           |
| Inspect the stack                      | `gt ls` / `gt log` / `gt info`                                    | Read-only; safe anytime.                                                                                                                                                                                     |
| Navigate                               | `gt checkout <branch>`, `gt up`, `gt down`, `gt top`, `gt bottom` | Pass an explicit branch to `checkout` to avoid the interactive picker.                                                                                                                                       |

Mutating commands to avoid running unattended (interactive-only or destructive): `gt reorder`, `gt split`, `gt absorb`, `gt fold`, `gt squash`, `gt modify --interactive-rebase`, `gt delete`, `gt move` without a target branch. Prefer explicit `git` plus `gt restack` if a stack edit is unavoidable.

When creating a fresh stack, submit each branch as it is ready with `gt submit --no-interactive --publish` so per-PR review automation starts progressively. Reserve `gt submit --stack` for re-pushing or retargeting an existing stack after a merge.

After any `gt submit` that opens or updates PRs, complete the post-publish checklist in [workflow.md](workflow.md#branch-and-pr-hygiene) before reporting PR URLs.

Use `gh` for PR creation/mutation only when `gt` is unavailable, blocked by missing auth/workspace access, or explicitly requested; see [workflow.md](workflow.md#branch-and-pr-hygiene).

## Conflict recovery

`gt restack`, `gt sync`, and `gt modify` drop into an interactive `git` rebase on conflict, which stalls an agent. Recover deterministically:

1. `git status` shows the conflicted files.
2. Resolve them and `git add <files>` (by name).
3. `gt continue` resumes the halted `gt` command (repeat per conflicted commit).
4. `gt abort` backs all the way out if the rebase is not worth finishing.
5. `gt undo` reverts the most recent `gt` mutation when a command did the wrong thing.

## Adopt pre-Graphite branches

`gt` only manages branches it tracks. Adopt an existing branch with:

```bash
gt track <branch> --parent main
```

Track against a current trunk tip: tracking an empty branch off a stale `main` can lock the PR title to the wrong commit. Commit first, or `gt sync` to advance `main` before tracking.

## Repair broken local state

- **Wrong or deleted trunk** (every `gt` command errors): `.git/.graphite_repo_config` names the trunk. `gt init --trunk main` fixes it but its reset confirmation only works interactively; editing the JSON `trunk`/`trunks` fields to `main` is equivalent. In a worktree, the config lives under `git rev-parse --git-common-dir`.
- **Stale tracking metadata** (branches tracked against a deleted trunk, `BAD_PARENT_NAME` parents): delete `.git/.graphite_metadata.db`; `gt` rebuilds it on the next command.
- **"You have uncommitted files" but `git stash` finds nothing**: untracked files fail `gt`'s clean-tree check and plain `git stash` skips them. Ignore scratch dirs via `.git/info/exclude`, or use `git stash -u`.
- **Stack view looks wrong on Web/GitHub** after downtime: `gt submit --always` force-pushes even unchanged branches to repair it.
