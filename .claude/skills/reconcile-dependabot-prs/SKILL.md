---
name: reconcile-dependabot-prs
description: Find all open Dependabot pull requests in the current repo, classify each by ecosystem and version-bump risk, merge the safe green-CI patch/minor bumps, close the ones superseded or already on `main`, and leave major-version or red-CI bumps open with rationale. Use when asked to sweep Dependabot PRs like Dependabot PR #5341.
user_invocable: true
---

# Reconcile Dependabot PRs

Takes no arguments. Work in the current repository.

## What Dependabot does (so you know what you're reconciling)

Dependabot opens PRs to bump dependency versions. Configured by `.github/dependabot.yml` for two ecosystems, both weekly:

- **npm** (`/`) - bumps `package.json` / `package-lock.json`. Grouped into `dev-dependencies`
  (dev deps, minor+patch), `production-minor-patch` (prod deps, minor+patch), and
  `security-updates` (any pattern, security advisories).
- **github-actions** (`/`) - bumps pinned action versions inside `.github/workflows/*.yml`,
  all grouped under `github-actions`.

Facts that drive the decision:

- PRs are authored by `app/dependabot`, head branches start with `dependabot/`,
  base is `main`, and carry the `dependencies` label plus an ecosystem label
  (`javascript`/`npm` or `github_actions`).
- A PR can be **single** (`Bump X from 1.2.3 to 1.3.0`) or **grouped**
  (`Bump the <group> group with N updates`) with a `From | To` table in the body.
- Dependabot maintains its own branch: it rebases, and auto-closes a PR once the target
  version already landed on `main`. Open PRs can still be stale or conflicting between sweeps.
- The safety gate is **CI**, not whether the patch applies. A clean-merging bump can still
  break the build. Never merge red or unproven CI.

## Goal

Process every open Dependabot PR, exactly one outcome per PR:

- merge it (safe, low-risk, CI green)
- close it (superseded, or the bump already landed on `main`)
- leave it open and report why (major-version risk, red/failed CI, or unresolved conflict)

Act only on PRs authored by `app/dependabot`. Do not touch other bot or human PRs.

## Step 1: Discover candidate PRs

```bash
gh pr list --state open --limit 500 --search 'author:app/dependabot' \
  --json number,title,body,author,headRefName,baseRefName,isDraft,mergeStateStatus,labels,url,updatedAt
```

`--limit` caps the result set silently. The `open-pull-requests-limit` values in
`.github/dependabot.yml` keep the count well under 500, but if the returned count equals
the limit, raise it and re-run - never process a truncated set as complete.

Keep only PRs where all hold:

- `author.login` is `app/dependabot`
- head branch starts with `dependabot/`
- base branch is `main`

For each candidate, pull changed files and diff:

```bash
gh pr view <N> --json files,title,body
gh pr diff <N>
```

Confirm the diff only touches expected files for its ecosystem:

- npm: `package.json`, `package-lock.json` (and per-package equivalents in a monorepo)
- github-actions: `.github/workflows/*.yml`

If a Dependabot PR touches anything outside its ecosystem's expected files, stop and report
it instead of acting automatically.

## Step 2: Classify each PR

From the title, body table, and labels determine:

1. **Ecosystem** - npm or github-actions.
2. **Bump severity** - the highest semver jump across all packages in the PR:
   - `major` if any package's left major != right major (e.g. `4 -> 6`, `1.x -> 2.0`)
   - `major`-equivalent if a package is on `0.x` and its minor changes (e.g. `0.1.0 -> 0.2.0`):
     under npm semver a `0.x` minor bump can carry breaking changes, so classify it
     as major for the merge policy below, never as minor
   - else `minor` if any minor changes (and the `0.x` major-equivalent case above does not apply)
   - else `patch`
     For grouped PRs, parse every row of the `From | To` table and take the max severity.
3. **Security** - true if the PR is from the `security-updates` group, references a CVE/GHSA,
   or the body says it resolves a security advisory.

Major-version bumps carry breaking-change risk. github-actions majors (e.g.
`actions/checkout 6 -> 7`) are usually low-risk but still count as major. npm majors of
runtime/build-critical deps are higher risk.

## Step 3: Decide staleness / supersession

A Dependabot PR is **stale** (close it) only when the evidence is clear:

```bash
git fetch origin main
```

- The target version is already on `origin/main` (check `package.json` /
  `package-lock.json`, or the action ref in the workflow files). Dependabot usually
  auto-closes these, but catch any it missed.
- It is **superseded** by another open Dependabot PR for the same package/group bumping to
  a higher version. Close the lower one, keep the higher.
- The dependency was removed from the manifest entirely.

Do not close on ambiguity. If you cannot prove the bump already landed or is superseded,
leave it open.

## Step 4: Check CI - the gate for merging

CI is mandatory for dependency bumps. Confirm right before acting:

```bash
gh pr view <N> --json isDraft,mergeStateStatus,title,url
gh pr checks <N>
```

- **All required checks green** -> eligible to merge per Step 5.
- **Any required check failed** -> do not merge. Leave open and report the failing check; a
  failed build on a bump is signal the upgrade breaks something.
- **Checks pending** and otherwise mergeable -> prefer auto-merge over waiting idly.
- **Conflict / dirty** (`mergeStateStatus` is `DIRTY`, or lockfile conflicts from a
  just-merged sibling) -> ask Dependabot to rebase rather than hand-fixing:

  ```bash
  gh pr comment <N> --body "@dependabot rebase"
  ```

  Then leave it open for the next sweep; do not edit the Dependabot branch yourself.

## Step 5: Merge policy

Apply per classification, only when CI is green (or pending with auto-merge):

- **patch or minor, CI green** -> merge.
- **security update, CI green** -> merge, prioritized - **except** when it is a major (or `0.x`
  major-equivalent from Step 2) npm bump, which still follows the major-hold rule below. A
  security advisory does not waive breaking-change risk on a major npm jump; hold it for human
  review like any other major npm bump.
- **major version** (including `0.x` major-equivalent npm bumps) -> do **not** auto-merge. Skim
  the release notes / changelog links in the PR body for breaking changes, then leave the PR
  open and report the bump and the specific breaking-change risk so a human can decide.
  (Exception: github-actions-only major bumps with green CI may be merged, since CI exercises
  the action directly and there is no runtime blast radius - but still call them out in the
  report.)

Merge with squash, deleting the branch:

```bash
gh pr merge <N> --squash --delete-branch
```

If required checks are still pending and GitHub allows auto-merge:

```bash
gh pr merge <N> --auto --squash --delete-branch
```

If `gh pr merge --auto` fails because auto-merge is not enabled, do not fall
back to a plain merge of an unproven PR. Leave the PR open and list it under "Left open" with
the reason (auto-merge disabled, checks still pending).

**Grouped PRs and lockfile churn:** merging one npm PR invalidates other open npm PRs'
`package-lock.json`, turning them `DIRTY`. Merge npm PRs one at a time; after each merge,
re-check the remaining npm PRs and `@dependabot rebase` any that conflict before moving on.
github-actions PRs rarely conflict with each other.

## Step 6: Close superseded / already-landed PRs

```bash
gh pr close <N> --delete-branch --comment "<concrete reason>"
```

Good close reasons are concrete and current:

- the target version (`X@1.3.0`) is already on `main`
- superseded by #<M>, which bumps the same package to a higher version

Do not use vague comments like `stale` alone.

See [the shared Skill Feedback Loop guidance](docs/skill-shared.md#skill-feedback-loop).

## Step 7: Report the sweep

Concise summary with these sections when applicable:

### Merged

- PR number, title, ecosystem, severity (patch/minor/security)

### Closed

- PR number, title, one sentence on why (already on `main` / superseded by #M)

### Left open

- PR number, title, exact reason (major-version breaking-change risk + which package; failed
  CI check name; conflict awaiting `@dependabot rebase`)

### Skill gaps

- Friction events and proposed fixes per the Skill Feedback Loop section; omit when there was none.

## Rules

- Only act on `app/dependabot` PRs whose diff stays within their ecosystem's expected files.
- CI green is a hard precondition for every merge. A failed check means leave open, never merge.
- Never auto-merge major-version npm bumps, including `0.x` major-equivalent bumps and major
  npm security updates; surface them for human review with the breaking change cited.
- Fail closed on ambiguity. Only close when "already landed" or "superseded" is provable.
- Do not edit Dependabot branches, hand-resolve lockfile conflicts, or fix unrelated checks -
  use `@dependabot rebase` and let Dependabot regenerate.
- Merge npm PRs serially to avoid lockfile thrash; rebase conflicting siblings between merges.
- Do not touch non-Dependabot PRs.
