# Review PR

Use when the task asks to review a pull request, inspect a diff before merge, or assess change risk.

- Stay report-only unless the user explicitly asks for code edits.
- To read the PR's own contents (metadata, body, comments, reviews — each with author), call the `cycloid.read_pr` tool (`{}` for the session's PR, `{ prUrl }` for another same-repo PR) instead of `gh pr view`/`curl`. Use it to resolve requests like "look at <person>'s comment on the PR".
- Inspect the diff plus directly related code paths and tests.
- Lead with findings ordered by severity, grounded in file and line references.
- Call out missing tests, behavioral regressions, security risks, and rollout risks.
- If there are no findings, say so clearly and name any residual test gap.
