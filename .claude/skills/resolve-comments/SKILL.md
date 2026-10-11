---
name: resolve-comments
description: Process every unresolved GitHub pull request review comment and every actionable top-level PR conversation comment, deduping exact duplicate feedback before addressing it holistically. Inspects review threads, bot summaries and inline findings (Greptile, ChatGPT Review, Graphite), makes targeted code fixes, posts concise replies, and tracks out-of-scope feedback via Linear tickets. Pass a GitHub PR URL or PR number, or omit to use the PR for the current branch.
---

# Resolve PR comments

Process every unresolved review comment and every actionable top-level PR conversation comment. For each: make a targeted code fix, reply explaining why no change is needed, or file a Linear ticket and reply with the link.

Automation may invoke this skill once all always-required reviewers have responded (`Greptile Review`) or after a 10-minute fallback window, whichever is first. In the fallback case, process whatever comments already exist; do not wait for more bot feedback.

## Step 1: Parse input and fetch PR context

Extract the PR number (and optionally owner/repo) from input. If no argument, find the PR for the current branch via `gh pr view --json number,headRefName,baseRefName,title,body,author`. If only a number is given, infer the repo from `git remote -v`.

Run in parallel:

```bash
gh pr view <N> --repo <OWNER>/<REPO> --json title,body,headRefName,baseRefName,author
gh pr diff <N> --repo <OWNER>/<REPO>
gh api repos/<OWNER>/<REPO>/pulls/<N>/reviews
gh api repos/<OWNER>/<REPO>/pulls/<N>/comments
gh api repos/<OWNER>/<REPO>/issues/<N>/comments
```

## Step 2: Build the worklist

Build from both sources:

- **Review comments** from `pulls/<N>/comments`, grouped by file and thread
- **Top-level PR conversation comments** from `issues/<N>/comments`

From review comments, identify all that are **not resolved**. Group by file and thread; read the full thread before acting.

From top-level conversation comments, extract every actionable finding even though they are not review threads. Required for bot summaries such as Greptile, especially sections like `Comments Outside Diff`, `Issues found`, `P1` / `P2`, or other enumerated findings embedded in a single summary comment.

A review's own top-level **body** (from `pulls/<N>/reviews`) is usually a roll-up of that review's inline comments, not a separate actionable item. When a review has inline comments, answer those inline threads and do **not** echo, as a top-level PR comment, any body substance already covered by an inline thread in that same review — the inline replies address it. A review body can still carry standalone findings with **no** matching inline thread (e.g. a Greptile COMMENT review whose body has `Comments Outside Diff`, extra `P1`/`P2`, or other enumerated items): extract and answer each such standalone finding via the top-level reply path, exactly as for a body-only review. Match inline comments to their parent review via each inline comment's `pull_request_review_id`, and let the exact-duplicate dedupe step collapse a body finding and its inline counterpart rather than answering it twice.

After extracting findings, dedupe exact duplicate feedback across all sources before deciding what to change. Exact duplicates are comments or findings with the same actionable text after trimming only leading/trailing whitespace. Do not dedupe comments that are merely similar, paraphrased, or overlapping.

Represent duplicate feedback as one work item with multiple source comments/threads. Address the concern once, holistically against the current PR head, then post a reply or resolve marker to every source comment/thread in the duplicate group. Do not make repeated or conflicting edits just because multiple reviewers or bots posted the exact same feedback.

### Bot review comments

These automated reviewers post actionable feedback and must be processed the same as human comments:

- **Greptile** (`greptile-apps[bot]`): Posts a top-level summary on `issues/<N>/comments` and inline comments on `pulls/<N>/comments`. The summary may contain P1/P2 findings, "Comments Outside Diff" sections, or other enumerated issues. Extract each finding individually.
- **ChatGPT Review** (`chatgpt-codex-connector[bot]`): Inline review comments with P-level badges. Process each individually.
- **Graphite AI reviewer** (`graphite-app[bot]`): Posts inline review comments on `pulls/<N>/comments` as part of a review submission, usually with a `Suggested change` block. Extract the actual finding; ignore the boilerplate footer (`Spotted by Graphite`, `Fix in Graphite`, `Is this helpful? React 👍 or 👎`), which is not actionable. Graphite is inline-only - it does not post a Greptile-style top-level summary, so do not expect a finding in `issues/<N>/comments` from it.

This list is illustrative, not exhaustive: process every unresolved inline review comment and actionable top-level comment regardless of author, including bot reviewers not named here.

Do not assume "no work to do" just because the review-thread APIs return no human comments. A PR can have zero review threads and still contain actionable bot feedback in top-level conversation comments.

Ignore:

- Resolved or outdated comments
- Bot comments that are purely summary with no actionable finding (e.g. "Confidence Score: 5/5, Safe to merge")
- Purely positive comments (e.g. "LGTM", "nice")

## Step 3: Check out the PR branch

```bash
git fetch origin <headRefName>
git checkout <headRefName>
```

## Step 4: Process each comment

For each unique item in the deduped worklist, decide: **code change**, **reply**, or **ticket + reply**. If a work item has multiple duplicate source comments/threads, apply the decision once and then acknowledge each source location.

### When to make a code change

- The comment identifies a bug, typo, or clear defect
- The comment requests a rename, style fix, or convention alignment
- The comment asks for a specific, scoped improvement within this PR

Make the fix. Only touch code directly related to the comment. Read the relevant file(s) first, then edit.

### When to reply instead

- The behavior is intentional and the comment misunderstands the design
- The comment is already addressed elsewhere in the PR
- The suggestion would require a significant architectural change

Post a reply explaining the rationale. Concise, direct tone. First person. No filler.

For inline review comments, use the GitHub review-comment reply endpoint that includes the PR number in the path. Do not use `repos/<OWNER>/<REPO>/pulls/comments/<COMMENT_ID>/replies`; that abbreviated endpoint returns 404 for replies.

```bash
gh api repos/<OWNER>/<REPO>/pulls/<N>/comments/<COMMENT_ID>/replies \
  -f body="<reply text>"
```

For top-level PR conversation comments (e.g. bot summaries from Greptile), post a new conversation comment that references the finding clearly:

```bash
gh api repos/<OWNER>/<REPO>/issues/<N>/comments \
  -f body="<reply text>"
```

### When to create a ticket and reply

If the comment identifies a valid improvement that is **out of scope for this PR** (affects other files, requires a broader refactor, or is cleanup that should be done separately):

1. Create a Linear ticket using `mcp__linear-server__save_issue` with:
   - A clear title describing the work
   - Description referencing the specific files/lines and linking to the PR comment
   - Priority 4 (low) unless urgent
   - A link to the PR comment via the `links` parameter
   - Assignee set to the original PR author from `gh pr view`, not the reviewer, commenter, or current agent, when an exact Linear user match can be resolved. Resolve only against fields belonging to the PR author: use `author.login` from `gh pr view --json author` to find an exact Linear GitHub login, username, or handle match when Linear exposes one; then try the PR author's exact email if available in PR/session metadata for that same GitHub account; then try the exact `author.name` display name. Do not use fuzzy or partial matches. If no exact Linear assignee can be resolved, still create the ticket unassigned and note the failed assignee lookup in the ticket description and PR reply.
   - No labels unless the user explicitly requests them
2. Reply to the comment with a brief explanation of why it's out of scope, including a link to the created ticket (e.g. `[ARC-470](https://linear.app/cycloid2/issue/ARC-470/...)`).

**Never dismiss valid feedback as "out of scope" without tracking it.** If the suggestion has merit, it gets a ticket.

### Resolving comments

When a comment has been fully addressed (code change, reply, or ticket + reply), include the marker `[RESOLVE PARENT COMMENT]` on its own line at the end of the reply body. This signals to automation that the thread can be resolved.

For top-level PR conversation comments there may be no thread to resolve in the GitHub UI, but still include the marker so downstream automation can detect the finding was handled.

### Signature

Every comment you post must end with `(sent via resolve-comments)` on the last line (after `[RESOLVE PARENT COMMENT]` if present).

### When to stop and ask

If a comment suggests a significant architectural change, or you're genuinely unsure whether to address it, **stop and ask the user**. Do not guess on high-impact changes.

## Step 5: Commit and push

After processing all comments that require code changes:

1. Stage only the files you modified (never `git add -A` or `git add .`)
2. Commit with a message prefixed with `[resolve-comments] - ` followed by a concise subject:

   ```text
   [resolve-comments] - Address PR review comments
   ```

   If you choose a different commit subject, keep the prefix format: `[resolve-comments] - {subject}`.

3. Push to the PR branch.

4. If every deduped work item was fully handled in this run and nothing is listed as **Deferred (needs your input)**, ensure the PR has the `resolved-comments` label. If the repository does not have that label yet, create it first, then add it to the PR.

   ```bash
   gh api repos/<OWNER>/<REPO>/labels/resolved-comments >/dev/null 2>&1 || \
     gh label create resolved-comments --repo <OWNER>/<REPO> \
       --color 0E8A16 \
       --description "All actionable PR comments were handled by resolve-comments." \
       >/dev/null 2>&1 || true

   gh api repos/<OWNER>/<REPO>/labels/resolved-comments >/dev/null 2>&1 && \
     gh pr edit <N> --repo <OWNER>/<REPO> --add-label resolved-comments
   ```

If no code changes were needed, skip commit/push but still post replies and add the label once all items are fully handled. Do not add the label if the run stops early or any work item remains deferred.

Do not enable auto-merge from this skill.
The merge orchestrator must arm auto-merge only after `resolve-comments` completes for that PR, using the repo's Graphite per-PR merge flow.

## Step 6: Summarize

Present a table with up to three sections.

### Code changes made

| Comment | File | What was changed |
| ------- | ---- | ---------------- |

### Replied without code change

| Comment | Rationale |
| ------- | --------- |

### Tickets created

| Comment | Ticket | Reason out of scope |
| ------- | ------ | ------------------- |

For deduped duplicate feedback, list it as a single row and mention the duplicate source count.

If you stopped to ask the user about any comments, list them as **Deferred (needs your input)**.

## Rules

- **Scope guard**: Only make changes directly related to the review comment. Do not refactor surrounding code, fix unrelated issues, or improve code that wasn't flagged.
- **Coverage guard**: Always inspect both `pulls/<N>/comments` and `issues/<N>/comments`. Bot reviewers (Greptile, ChatGPT Review, Graphite) post findings in one or both places; Graphite is inline-only. Process every bot reviewer, not just those named here.
- **Duplicate guard**: Dedupe exact duplicate actionable text across reviewers and bots before editing. Handle the concern once, but reply or mark every duplicate source as handled.
- **Review-body umbrella guard**: A review body (`pulls/<N>/reviews`) is the umbrella over its own inline comments. Do not echo body substance already answered by an inline thread in the same review; still surface standalone body findings that have no inline counterpart. Use the top-level reply path for reviews/comments with no inline thread (e.g. bot summaries).
- **Tone**: Concise, direct, first person. No filler like "Great suggestion!" or "Thanks for catching this."
- **Track out-of-scope feedback**: Never dismiss valid feedback as "out of scope" without filing a Linear ticket.
- **Ticket assignee**: Out-of-scope Linear tickets must be assigned to the original PR author when an exact Linear user match can be resolved. Do not leave valid feedback untracked because assignee resolution failed.
- **Approval threshold**: Stop and ask the user before making significant architectural changes.
- **Read before edit**: Always read the full file before making changes. Never edit blind.
- **One concern per commit**: If comments span multiple concerns, consider separate commits. Use judgment.
- **Commit prefix**: All commits created by this skill must be prefixed with `[resolve-comments] - `.
