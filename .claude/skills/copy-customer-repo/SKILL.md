---
name: copy-customer-repo
description: Create a standalone, fork-free copy of a customer repo under the trycycloid org so we can test Cycloid against it without touching the customer's repo. Use when the user wants to clone/copy a customer repo into trycycloid as a private push target.
user_invocable: true
argument: optional path to the local clone and/or desired destination repo name (e.g. "~/dev/mia-labs/mia mia-copy")
---

# Copy customer repo into trycycloid

Produce a **private, standalone copy** of a customer repository under the `trycycloid` org, with **no fork relationship and no link** to the customer's repo, so we can push freely and run Cycloid without bothering the customer.

Default: copy **files only** (working tree at `HEAD`), **no git history and no `.git` metadata** - a single initial commit. Deviate only if the user explicitly asks to preserve history or all branches.

## Input

`$ARGUMENTS` may contain the local clone path and/or the destination repo name. If missing:

- Source path: ask which local clone to copy (or infer if obvious).
- Destination name: default `<repo>-copy` (e.g. `mia` -> `mia-copy`); the `-copy` suffix marks it as the push target, not the customer's repo. Confirm if ambiguous.

This is an outward-facing action (creates a repo, pushes code). Confirm source + destination name before creating the repo. After that, proceed without pausing **except** the Step 2 secret gate, which always blocks until the user decides.

## Step 1: Inspect the source clone

```bash
SRC=<local clone path>
git -C "$SRC" rev-parse --short HEAD
git -C "$SRC" rev-parse --abbrev-ref HEAD          # which branch we're copying
git -C "$SRC" ls-files | wc -l                      # tracked file count (target to match)
```

Note the tracked file count - you'll verify the copy matches it.

## Step 2: Secret gate (blocking - runs before any copy, repo creation, or push)

Secrets committed to a customer repo must not be silently replicated: even a private destination broadens access and is hard to expunge once pushed (cached views, forks). Detect secret-bearing tracked files **first**, and stop if any are found:

```bash
git -C "$SRC" ls-files \
  | grep -iE '(^|/)\.env(\.|$)|secrets?|credentials?|\.(pem|key|pfx|p12)$' \
  || echo "no obvious secret-bearing tracked files"
```

This matches filenames only (`ls-files`), never reads contents - do not print secret values. The patterns are a substring filename heuristic (`secret`/`credential` anywhere in the path, plus `.env` and key extensions), catching e.g. `secrets/db.yml`, `credentials/aws.json`, `database-credentials.json`. It can't catch creatively named secret files, so also eyeball the Step 1 file list.

If any files match, **stop before Step 3** and ask the user to choose, listing the matched paths:

- **Sanitize**: remove or redact the listed files in the copy before pushing (recommended for live credentials).
- **Copy as-is**: explicit approval to replicate them verbatim into the private destination.

Do not run `git archive`, create the repo, or push until the user decides. If sanitize, drop those paths from the staged set in Step 4 (or delete them from `$DEST` after extraction) and note exactly what was removed.

## Step 3: Verify the destination name is free

```bash
gh api repos/trycycloid/<dest-name> 2>&1 | grep -E '"(full_name|message)"'
```

`404 Not Found` means available. If it exists, pick another name and confirm.

## Step 4: Export tracked files only (no history, no junk)

Only after the Step 2 secret gate is cleared. Use `git archive HEAD` - exports **only tracked files at HEAD**, deliberately excluding `node_modules`, build output, and untracked/gitignored files. Do **not** `rsync` the working tree (copies ignored junk and untracked secrets).

**Gotcha - `export-ignore`.** `git archive` honors `.gitattributes` `export-ignore`, so tracked files marked that way (sometimes tests, CI config, or docs) are silently dropped from the tarball. If the file count below comes up short of the source tracked count, check for `export-ignore` entries (`git -C "$SRC" check-attr -a -- <missing path>` or grep `.gitattributes`) and re-add those paths explicitly so the copy is complete for Cycloid testing.

```bash
SRC=<local clone path>
DEST=<sibling dir, e.g. ${SRC%/*}/<dest-name>>
[[ -n "$DEST" ]] || { echo "DEST is empty - aborting"; exit 1; }   # guard rm -rf
rm -rf "$DEST" && mkdir -p "$DEST"
git -C "$SRC" archive --format=tar HEAD | tar -xf - -C "$DEST"
find "$DEST" -type f | wc -l                         # sanity check vs tracked count
```

## Step 5: Init a clean repo and commit

The user's global rule forbids `git add -A` / `git add .` / `git add --all`. The concurrency concern doesn't apply in this fresh dedicated directory, but honor the rule by **staging top-level entries explicitly by name**. List them first:

```bash
cd "$DEST"
ls -A                                                # top-level entries to stage
git init -q -b main
# Derive identity from the active gh account so this works for any team member.
git config user.name "$(gh api user --jq .name)"
git config user.email "$(gh api user --jq '(.id|tostring) + "+" + .login + "@users.noreply.github.com"')"
git add -- <list every top-level entry by name>
```

**Gotcha - ignored-but-tracked paths.** Some entries (commonly `.vscode`) are committed in the customer repo but match its own `.gitignore`, so plain `git add` skips them with an "ignored by .gitignore" hint. Only force-add **reviewed, non-sensitive** paths; if an ignored-but-tracked path may hold secrets or local credentials, treat it as a Step 2 finding and stop for the user's decision before force-adding.

```bash
git add -f -- .vscode   # and any other reviewed non-sensitive path git reported as ignored
git diff --cached --name-only | wc -l   # should match the source tracked count (minus any sanitized files)
```

Then commit:

```bash
git commit -q -m "Initial import of <customer-org>/<repo> working tree (no upstream history)

Standalone copy for Cycloid testing under the trycycloid org.
Not a fork; no link to the original repository."
```

## Step 6: Create the private repo and push

This is a customer copy, **not** a Cycloid Graphite repo - use native `git`/`gh` (state this). Confirm the intended account with `gh auth status` first.

```bash
cd "$DEST"
gh repo create trycycloid/<dest-name> --private --source=. --remote=origin --push \
  --description "Standalone copy of <customer-org>/<repo> for Cycloid testing. Not a fork."
```

## Step 7: Handle the email-privacy push rejection

If the active account has commit-email privacy on, pushing a commit authored with a private email is rejected with `GH007: Your push would publish a private email address`. The Step 5 noreply derivation avoids this. If it still happens, re-derive and amend:

```bash
git config user.email "$(gh api user --jq '(.id|tostring) + "+" + .login + "@users.noreply.github.com"')"
git commit -q --amend --reset-author --no-edit
git push -u origin main
```

## Step 8: Verify it's a true standalone copy

```bash
gh api repos/trycycloid/<dest-name> --jq '{full_name, private, fork, parent: (.parent.full_name // "none")}'
# expect: fork:false, parent:"none", private:true
```

Then open it: `open https://github.com/trycycloid/<dest-name>`

## Report back

- Repo URL (opened in browser).
- Confirm `fork: false`, `parent: none`, `private: true`.
- File/commit summary (files-only, single import commit, no history).
- Secret-gate outcome: "no secret-bearing tracked files found", or the matched files plus the user's decision (sanitized - naming what was removed - or approved as-is). Secret values are never read or printed.
- Note the local working dir path with `origin` pointing at the new repo, ready for pushes.
