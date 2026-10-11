---
name: cross-check-pr
description: Break down and review a GitHub PR with a read-only, assumption-verified, adversarial Claude+Codex loop. Takes a PR number or URL and produces a verdict, walkthrough, findings, and author questions.
user_invocable: true
argument: PR number, PR URL, or empty to use the current branch PR
disable-model-invocation: true
allowed-tools: Read, Grep, Glob, Bash(mktemp:*), Bash(mkdir:*), Bash(cat:*), Bash(cp:*), Bash(rm:-rf *), Bash(diff:*), Bash(git status:*), Bash(git diff:*), Bash(git show:*), Bash(git cat-file:*), Bash(gh pr view:*), Bash(gh pr diff:*), Bash(gh api:repos/*/contents/*), Bash(codex exec:*)
---

# PR Review

Review an open GitHub PR deeply and read-only. Produce the review in-session; never edit files, check out the PR, push, comment, submit a review, or change PR state.

## Input

The user provides `$ARGUMENTS`: a PR number, a PR URL, or nothing.

- No argument: resolve the PR for the current branch with `gh pr view --json ...`. If the branch has no PR, say so and stop.
- A URL: parse it into `owner/repo` and PR number. Pass `-R owner/repo` to every `gh` command for that PR.
- A bare number: use the current repo.

## Step 1: Gather the PR

Use authenticated `gh` only. Never web-fetch private repo or PR context.

1. Normalize the input to one repo and one PR number. Record `owner/repo`, PR number, `baseRefName`, `headRefName`, `baseRefOid`, and `headRefOid` so the review is pinned to a specific head SHA.
2. Gather PR metadata:

```bash
gh pr view <n> --repo <owner/repo> --json number,title,author,state,baseRefName,headRefName,baseRefOid,headRefOid,additions,deletions,changedFiles,body,isDraft,labels,reviewDecision,url
```

3. Gather the full diff with `gh pr diff <n> --repo <owner/repo>`.
4. Gather `comments,reviews` with `gh pr view <n> --repo <owner/repo> --json comments,reviews` when existing discussion matters.
5. Discover and read applicable repo instructions and project conventions in one parallel batch:
   - root `AGENTS.md`
   - any nested `AGENTS.md` whose directory scopes changed files or PR-head snapshots
   - `CLAUDE.md` when present, as an additional compatibility source
   - `docs/conventions.md`
   - `docs/security.md`
   - `docs/database.md`
   - `docs/testing.md`
   - `docs/infrastructure.md` and `docs/deployments.md` only when the diff touches `infra/`, workflows, deployments, or migrations

### Large Diffs

If the diff is over 1500 lines or 25 files, do not imply full coverage. List changed files and per-file risk, then read the highest-risk hunks first: auth, authorization, secrets, migrations, money, parsing, concurrency, deletes, public API contracts, and test gaps. State exactly what was sampled versus read fully.

### PR-Head File Context

When a hunk depends on surrounding callers, invariants, or file-local context, read the file at the PR head, not the ambient working tree. The local checkout may be stale, dirty, on the base branch, or on another branch.

Preferred source:

```bash
gh api repos/<owner>/<repo>/contents/<path>?ref=<headRefOid> \
  -H "Accept: application/vnd.github.raw"
```

The default contents API response is JSON with base64 `content`; if not using the raw Accept header, explicitly decode `.content` before saving a snapshot. `git show <headRefOid>:<path>` is allowed only after verifying the object exists locally. Never use `gh pr checkout`. Working-tree reads are allowed only if the current checkout is confirmed to be the PR branch at `headRefOid`.

## Step 2: Evaluate the PR

Run only the review lenses that apply. Findings must include severity, `file:line`, and a concrete fix.

- correctness, logic, and edge cases
- security: authz, injection, secrets, fail-open behavior, and server/client boundaries per `docs/security.md`
- data and migrations: D1-only DAO access, append-only migration files, idempotency guards, reversibility, integer timestamps, and single-writer FSM projection expectations per `docs/database.md` and `docs/fsm.md`
- layer discipline: route -> service -> DAO; shared code in `shared/`; no cross-app imports
- tests: new branching, DAO, parsing, auth, migration, or error-handling logic needs same-PR coverage
- error handling: no empty catches; polling and background failures must surface
- blast radius: what breaks if this change is wrong

Do not manufacture issues. A clean PR gets a clean report.

## Step 3: Verify Assumptions

PR code embeds assumptions about SDK methods, API contracts, internal module behavior, CLI flags, config options, and runtime behavior. Verify load-bearing assumptions before using them as review evidence.

### Verification Rules

- Do not mark a claim "Verified" from training knowledge alone. Verification requires source read or command output from this review.
- Use the strongest available source: repo or `node_modules` source, then direct command output, then a fetched public docs page. Web search is only for finding the public docs URL.
- Private repo and PR context comes only from local files and authenticated `gh`; never put private code, PR text, customer details, or session details into web search/fetch.
- Public library, API, CLI, and documentation claims may use public docs only when the query does not expose private context.
- Codex is not responsible for network verification. Its review input is the local bundle from Step 4.

### Assumption Output

For each checked assumption, record:

- **Claim**: the specific assertion
- **Source checked**: file path, URL, or command
- **Evidence**: the relevant line, signature, output, or "no matching evidence found"
- **Verdict**: Verified / Unverified / Incorrect

Incorrect assumptions become blocker findings. Unverified assumptions become warnings requiring author evidence.

## Step 4: Run the Adversarial Review Loop

Run Claude and Codex review rounds until convergence. Codex reviews a local bundle, never the live PR.

### Setup

Create one isolated workspace:

```bash
mktemp -d "${TMPDIR:-/tmp}/cross-check-pr-XXXXXXXX"
```

This prints a path like `/tmp/cross-check-pr-3f9aQ2bM`. Use that exact literal path in every command. Shell state does NOT persist between Bash tool calls, so do not rely on shell variables such as `$WORKDIR`, `$PR_NUMBER`, or `$HEAD_SHA` across calls.

`<WORKDIR>` below means the one literal directory from `mktemp`.

Capture a clean-tree baseline before the first Codex launch:

```bash
git status --porcelain > <WORKDIR>/git-status-before.txt
```

### Stage the Local PR Bundle

Before round 1, stage everything Codex needs under `<WORKDIR>`:

- `<WORKDIR>/metadata.md`: owner/repo, PR number, URL, title, author, state, draft state, labels, review decision, base/head refs, base/head SHAs, additions, deletions, changed-file count, and PR body
- `<WORKDIR>/pr-<n>.diff`: output from `gh pr diff <n> --repo <owner/repo>`
- `<WORKDIR>/coverage.md`: whether the diff was fully read or sampled, plus the sampled files/hunks and skipped lenses
- PR-head snapshots of changed files Claude actually read, fetched from `headRefOid`
- relevant convention docs, either copied into the bundle or referenced by absolute repo paths

If the PR is sampled because it is large, stage only the same sampled surface and record that boundary in `coverage.md`.

### Round Structure

Each round has Claude findings, a synchronous Codex review, then merge and convergence.

**Phase A: Claude**

Write Claude's round findings with Bash heredoc, not a file-edit tool:

```bash
cat <<'REVIEW_EOF' > <WORKDIR>/claude-round-N.md
... findings ...
REVIEW_EOF
```

Finding format:

- **Section**: lens or assumption area
- **Problem**: issue and why it matters
- **Suggestion**: concrete fix
- **Severity**: Blocker / Warning / Nit

**Phase B: Codex**

In the same assistant message as Phase A, run Codex to completion:

```bash
codex exec -s read-only \
  -o <WORKDIR>/codex-round-N.md \
  "You are independently reviewing a GitHub PR from a local read-only bundle. Read the literal staged files for this PR: <WORKDIR>/metadata.md, <WORKDIR>/coverage.md, <WORKDIR>/pr-<PR_NUMBER>.diff, the staged PR-head file snapshots under <WORKDIR>, and the convention docs referenced in the bundle. Replace both placeholders in this prompt before running it: <WORKDIR> is the literal mktemp directory and <PR_NUMBER> is the decimal PR number. Do not run gh, curl, web fetches, git checkout, git commit, git push, or PR mutation commands. Start with a short coverage preface: inputs read, files sampled vs fully reviewed, assumptions checked, and lenses skipped. Then emit only findings in this format: **Section**: ... / **Problem**: ... / **Suggestion**: ... / **Severity**: Blocker|Warning|Nit. If you have no findings, output exactly: NO_NEW_FINDINGS" < /dev/null
```

For rounds 2 and 3, also point Codex at `<WORKDIR>/accumulated.md` and ask only for new findings not already covered.

Codex rules:

- Use `codex exec`, not the interactive `codex` command.
- Use `-s read-only`, not `--full-auto`.
- Do not pass `-m` or `--model`; use the configured default.
- Do not pass fast-tier options.
- Use `-o <WORKDIR>/codex-round-N.md`.
- Always redirect stdin with `< /dev/null`.
- Run `codex exec` as its own command, not chained after a heredoc or another stdin-consuming command.
- The command is expected to block until complete. After it exits, read the output file.
- If Codex fails or produces empty output, inspect the installed Codex CLI argument parsing source before retrying; do not guess flags.

### Merge and Converge

After Codex completes, read both round files, deduplicate overlaps, and write the consolidated review to `<WORKDIR>/accumulated.md`.

Convergence:

- Stop when neither reviewer adds findings in a round.
- Stop after round 1 if there are zero blocker findings.
- Cap at 3 rounds. If round 3 still adds findings, include them and move on.

After the loop, capture the tree status again:

```bash
git status --porcelain > <WORKDIR>/git-status-after.txt
diff -u <WORKDIR>/git-status-before.txt <WORKDIR>/git-status-after.txt
```

If `git-status-before.txt` and `git-status-after.txt` differ, surface that the review was not cleanly read-only and do not claim read-only verification.

## Step 5: Deliver the Review

Do not mutate the PR or files. Deliver the final read-only report in this shape:

1. **Verdict**: `approve` / `request-changes` / `discuss`, one reason, confidence, and what would change it.
2. **What & why**: 2-4 lines explaining intent and problem solved. If intent is unclear from title/body/diff, say so.
3. **Change walkthrough**: grouped by concern, not file-by-file, with `file:line` refs.
4. **Findings**: blocker / warning / nit, each with location and concrete fix. Fold in Incorrect assumptions as blockers and Unverified assumptions as warnings. If there are none, say "no blocking findings."
5. **Open questions**: author-only intent or evidence questions.

## Step 6: Cleanup

Remove only the literal workspace directory after the final report is delivered and every background Codex run has completed:

```bash
rm -rf <WORKDIR>
```

Never use a broad glob like `/tmp/cross-check-pr-*`; it can delete concurrent reviews. If a Codex round failed, preserve `<WORKDIR>` long enough to inspect its output, then remove exactly that literal directory.

## Bounds

- Read-only: never edit, push, comment, submit a review, label, merge, close, or change PR state.
- Use authenticated `gh` only for private PR context; never web-fetch private repo context.
- Never `gh pr checkout`.
- Distinguish verified evidence from inference. Cite `file:line` for code claims.
- Do not rubber-stamp and do not invent findings.
