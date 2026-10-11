---
name: pr-session-timeline
description: Build a stopwatch-style timeline for a Cycloid session and its GitHub PR review loop from either a session URL/UUID or a PR URL/number. Use when asked when a prompt started, published, reviewers commented or edited comments, review-loop agents started, verification agents ran, or follow-up changes were pushed.
user_invocable: true
argument: required -- a Cycloid session URL/UUID, a GitHub PR URL, or a PR number in the current repo
---

# PR Session Timeline

Reconstruct a precise timeline for a Cycloid session plus its GitHub PR activity. Prefer stopwatch offsets over wall-clock time when the user asks for elapsed timing.

## Input

`$ARGUMENTS` is one of:

- Cycloid session URL: `https://app.trycycloid.com/sessions/<uuid>`
- raw Cycloid session UUID
- GitHub PR URL: `https://github.com/<owner>/<repo>/pull/<number>`
- PR number in the current repo

If only a PR is provided, resolve the related session from the PR body first, then comments:

```bash
gh pr view <pr-number> --repo <owner>/<repo> --json body,url,title,headRefName,baseRefName,author
gh api repos/<owner>/<repo>/issues/<pr-number>/comments --paginate
```

First parse the PR body for `<!-- cycloid-dedup: <session-id>:` and session transcript links. If the body has no session ID, look for `cycloid-review-status session=<uuid>` or `cycloid-verification` comments with linked session URLs. If several sessions are present, use the implementation session that created or is review-listening on the PR; mention any ambiguity.

## Required Data

Fetch Cycloid data with the local authenticated CLI:

```bash
cycloid sessions get <session-id> --json
cycloid sessions transcript <session-id> --json
```

Use the transcript for full prompt and event history. The events endpoint is capped at 1000 rows; use it only for focused paging or spot checks:

```bash
cycloid sessions events <session-id> --json --limit 1000
cycloid sessions events <session-id> --json --after-sequence <n> --limit 1000
```

Fetch GitHub data with authenticated `gh`, never browser/web fetches for private repo context:

```bash
gh pr view <pr-number> --repo <owner>/<repo> --json number,title,state,createdAt,updatedAt,mergedAt,author,headRefName,headRefOid,baseRefName,url,reviews,comments,commits,statusCheckRollup
gh api repos/<owner>/<repo>/issues/<pr-number>/comments --paginate
gh api repos/<owner>/<repo>/pulls/<pr-number>/comments --paginate
gh api repos/<owner>/<repo>/pulls/<pr-number>/reviews --paginate
```

For comment update history, query GraphQL `userContentEdits` once per comment node ID returned by REST. Paginate each comment's edits until `pageInfo.hasNextPage` is false; if you cannot paginate, note any `hasNextPage: true` result as truncated in the output.

```graphql
query ($id: ID!, $editsAfter: String) {
  node(id: $id) {
    __typename
    ... on IssueComment {
      databaseId
      url
      author {
        login
      }
      createdAt
      updatedAt
      lastEditedAt
      bodyText
      userContentEdits(first: 100, after: $editsAfter) {
        nodes {
          editedAt
          editor {
            login
          }
          deletedAt
          deletedBy {
            login
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
    ... on PullRequestReviewComment {
      databaseId
      url
      author {
        login
      }
      createdAt
      updatedAt
      lastEditedAt
      bodyText
      path
      line
      originalLine
      replyTo {
        databaseId
        url
        author {
          login
        }
        createdAt
      }
      userContentEdits(first: 100, after: $editsAfter) {
        nodes {
          editedAt
          editor {
            login
          }
          deletedAt
          deletedBy {
            login
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}
```

## Timeline Events To Extract

From the Cycloid session transcript:

- session `createdAt`, status, repo, PR URL, publish status
- each prompt `createdAt`, `startedAt`, `completedAt`, result commit SHA, and `noChanges`
- `agent_timeline` events: `prompt.started`, `git.push`, `verification.result`, `pr.open`, `tools.run`, `files.edited`
- `publish.started`, `publish.push.confirmed`, `publish.pr.created`, `publish.blocked_by_verification`, `publish.completed`
- `review_listening.entered`, `pr_created`, `pr_failed`
- child session IDs from the parent record; fetch each child with `cycloid sessions get` and `transcript`

Classify prompt roles:

- Initial implementation: first normal prompt that produced the PR.
- RLA/review-loop: prompts whose text starts with `[cycloid:review-loop`.
- VA/verification agent: child sessions with `agentRole: "verification"` or `agentProfile: "verify"`.

From GitHub:

- PR created/updated/merged time and commit authored/committed times
- top-level PR comments with author, created time, updated time, edit history, and short classification
- inline review comments with author, created time, updated time, review ID, path/line, and reply relationships
- PR reviews with author, state, submitted time, and commit SHA
- status check start/completion times when they explain verification blockers

## Stopwatch Anchor

Default anchor is the initial prompt `createdAt` or `startedAt`, whichever is earlier and not null. If the user asks for "from session creation", anchor at session `createdAt`. State the anchor explicitly.

Render offsets as:

- `T+MM:SS` for under one hour
- `T+H:MM:SS` for one hour or more
- Include tenths only when sub-second ordering matters

## Output

Start with a one-line anchor:

`Stopwatch zero = initial prompt enqueued at <ISO timestamp>.`

Then provide a compact table:

```markdown
| Stopwatch | Event                              |
| --------: | ---------------------------------- |
|   T+00:00 | Initial prompt enqueued/processing |
|   T+13:35 | PR opened/published                |
```

Include at least:

- prompt start and completion
- initial publish/open
- reviewer comments and edits, one row per reviewer/actionable comment
- VA child session enqueue/start/complete
- RLA enqueue/start/commit/reply/push/publish result
- later reviewer or verification comments/edits
- final publish or final blocked/no-diff state

After the table, add short notes only for important caveats:

- no final successful publish happened
- a publish was held by owner/sensitive-path approval
- a reviewer did not comment
- GitHub exposes update history only through `userContentEdits`; if unavailable, say so
- session is still active/review-listening, so the timeline is a snapshot

## Rules

- Do not mutate the PR, comments, checks, labels, branches, or session state.
- Do not rely on PR web pages for private repo data.
- Prefer exact API timestamps over inferred ordering.
- If Cycloid and GitHub disagree, report both and label the source.
- Keep the final answer short enough to scan; omit raw JSON unless asked.
