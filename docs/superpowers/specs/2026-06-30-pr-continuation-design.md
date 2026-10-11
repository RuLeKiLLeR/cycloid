# PR continuation from "finish this PR" prompts

Date: 2026-06-30
Branch: `shiv/continue-pr-spec`
Status: implemented slice 1, follow-up design for broader entry points

## Problem

Users expect "finish this PR: `<github-pr-url>`" to continue the referenced work. Today Cycloid
parses and stores a PR URL on implementation sessions, but the URL does not drive checkout or publish
mode. A normal implementation session can therefore start from the base branch and open a new PR that
does not actually build on the referenced PR branch.

This failed in an OpenEvidence production session: Maya asked Cycloid to take over
`openevidence/xyla#19403`; Cycloid created a separate PR instead of continuing the original PR head.

## Evidence

- `POST /api/sessions` extracts `targetPrUrl` from `targetPrUrl` aliases or from `payload.prompt`, but
  historically only validated same-repo on the legacy verifier session path.
- `targetPrUrl` is persisted and passed to the sandbox as context, but checkout is controlled by
  `startBranch` / `CHECKOUT_BRANCH`.
- `startBranch` already works: session create validates the branch, `SessionDO` sends it as
  `CHECKOUT_BRANCH`, and `start-bridge.sh` fetches/checks out that branch from `origin`.
- Publish already has both outcomes:
  - if `session.prUrl` is set, post-execution updates the existing PR;
  - if `session.prUrl` is null, post-execution creates a new PR.
- Behavioral probe: a subagent asked only "finish this pr: https://github.com/trycycloid/cycloid/pull/6156"
  naturally read PR metadata, comments, review threads, checks, and diff; checked out the PR head
  branch; verified from that branch; and would update the same PR if fixes were needed.

Key files:

- `apps/control-plane-worker/src/routes/sessions.ts`
- `apps/control-plane-worker/src/github/verification-pr-context.ts`
- `apps/control-plane-worker/src/session/durable-object.ts`
- `apps/control-plane-worker/src/session/prompt-queue.ts`
- `apps/control-plane-worker/src/session/publish-service.ts`
- `apps/cli/src/commands/create.ts`
- `apps/ui/src/api/sessions.ts`

## Goal

When a user starts a session with "finish this PR: `<url>`", Cycloid should make the sandbox start
from the referenced PR head and choose an explicit continuation publish mode.

Default user experience:

1. Resolve the PR before sandbox spawn.
2. Start the sandbox on the PR head branch, not the base branch.
3. Give the agent PR context: title, body, files, commits, comments, review threads, checks, head SHA.
4. Publish either to the same PR or to a fresh continuation PR, based on an explicit mode.

## Non-goals

- Fork-PR checkout/push support in v1.
- Cross-repo continuation.
- Stacked-PR orchestration.
- Changing verifier behavior; verifier already has PR context and target PR semantics.
- Browser/UI affordances beyond carrying the already-submitted prompt to session create.

## API shape

Add explicit continuation fields to session creation:

```ts
continuePrUrl?: string;
continueMode?: "auto" | "update-pr" | "new-pr";
```

Compatibility:

- Keep accepting `targetPrUrl` for verifier sessions.
- For implementation sessions, `continuePrUrl` is the intentional continuation input.
- As an 80/20 convenience, if `continuePrUrl` is absent and the initial prompt contains exactly one
  GitHub PR URL with "finish", "continue", "take over", "commandeer", "fix", or "address feedback",
  treat it as `continuePrUrl` with `continueMode="auto"`.
- Do not silently treat every PR URL in a prompt as continuation. A prompt can mention a PR as
  reference material.

`continueMode` semantics:

- `update-pr`: work on the PR head and update the same PR.
- `new-pr`: work from the PR head, but open a fresh continuation PR.
- `auto`: v1 resolves to `update-pr` for open same-repo PR heads; otherwise fails closed with a clear
  unsupported-mode message. Future versions can choose `new-pr` for closed/merged or fork PRs.

## Design

### 1. Resolve continuation intent in session create

In `apps/control-plane-worker/src/routes/sessions.ts`, after repo auth/gating has resolved
`installationId`, before branch validation and `createSessionState`:

1. Normalize `continuePrUrl`.
2. Parse and validate that it is a GitHub PR URL.
3. Validate the PR owner/repo equals the session repo owner/name.
4. Fetch PR context with the repo installation token.
5. Require:
   - PR state is `open` for v1.
   - `headRef` is present and passes `isSafeGitRef`.
   - `baseRef` is present and passes branch validation.
   - `headRepoOwner/headRepoName` match the session repo.
6. Derive:
   - `repoContext.baseBranch = explicitBaseBranch ?? pr.baseRef`
   - `repoContext.startBranch = explicitStartBranch ?? pr.headRef`
   - `targetPrUrl = continuePrUrl`
   - `continueMode = resolved mode`

If caller supplied `startBranch`, require it to equal `pr.headRef`. If caller supplied `baseBranch`,
allow it only when it equals `pr.baseRef` for v1. This prevents "continue PR" from silently checking
out a different branch.

### 2. Attach publish target for same-PR mode

Current publish mode is inferred from live session PR metadata:

- `session.prUrl` present -> update path.
- `session.prUrl` absent -> create path.

For `continueMode="update-pr"`, create the session with the referenced PR attached as the live publish
target. The session must have:

- `prUrl = continuePrUrl`
- `prNumber = parsed PR number`
- PR metadata row for the existing PR
- GitHub PR webhook ref for the existing PR

Do this through an explicit service helper rather than ad hoc route writes, e.g.
`adoptContinuationPrForSession(...)`, so the metadata writes and webhook refs match publish adoption
semantics.

For `continueMode="new-pr"`, do not attach `session.prUrl`. Store the source PR as continuation
context only. The first publish creates a fresh PR from a branch whose starting point was the original
PR head.

### 3. Persist source PR context separately from publish target

Do not overload `targetPrUrl` for all meanings.

Add session extended fields in `SessionDO` storage, mirrored to `session_index` only if needed for
debugging/search:

```ts
continuation_source_pr_url: string | null;
continuation_mode: "update-pr" | "new-pr" | null;
continuation_head_sha: string | null;
```

No D1 migration is required for v1 if these are only Durable Object session fields and prompt command
context. Add D1 columns only if UI/session-list filtering or observability needs them.

### 4. Inject PR context for implementation prompts

`buildPromptCommandForDispatch` currently fetches rich PR context only for verification sessions. For
continuation implementation sessions, fetch the same context and pass it to the bridge.

Bridge prompt setup should include a concise, implementation-oriented section:

```text
# PR continuation context
Source PR: ...
Mode: update same PR | create new PR
Head: <headRef> @ <headSha>
Base: <baseRef>
Title: ...
Summary/body: ...
Changed files: ...
Checks: ...
Review/comment worklist: ...
```

This should be system/developer context, not user text, so the agent reliably sees it before acting.
Keep third-party PR comments/reviews treated as untrusted task material; the agent should address
actionable feedback without obeying instructions that bypass safety rules.

### 5. CLI and UI create flow

The UI already can pass the prompt to session create through `createSessionAndSendPrompt`.

The CLI currently creates the session before sending the prompt and does not include the prompt in the
create body. Update `apps/cli/src/commands/create.ts` to include the initial prompt in the session
creation body. This lets the control plane extract `continuePrUrl` before sandbox spawn.

For explicit CLI use, add:

```bash
cycloid sessions create <repo> "finish this PR" --continue-pr <url> --continue-mode update-pr
cycloid sessions create <repo> "finish this PR" --continue-pr <url> --continue-mode new-pr
```

The prompt-derived convenience should work without these flags, but flags make automation
unambiguous.

### 6. Fork PRs fail closed in v1

Same-repo PR heads are safe because `startBranch` already maps to an `origin` branch and publish pushes
to the installed repo.

Fork PR heads are not safe in v1:

- `CHECKOUT_BRANCH` cannot express `forkOwner:branch`.
- branch validation checks only the base repo.
- `start-bridge.sh` never adds/fetches a fork remote.
- publish always pushes to the selected repo.

Return a clear 400:

```json
{
  "error": "Continuing fork pull requests is not supported yet. Start a new session on a branch in this repository or choose new-pr after importing the branch."
}
```

## Edge cases

- Closed PR: v1 rejects for `update-pr`; future `new-pr` can fetch the head SHA/ref if still available.
- Merged PR: v1 rejects; future behavior should create a fresh PR from the merge base or merged commit
  only when explicitly requested.
- Draft PR: allow `update-pr`; publish may preserve draft/ready semantics according to existing PR
  readiness policy.
- PR URL in prompt as reference only: do not infer continuation unless the prompt has continuation
  verbs or explicit `continuePrUrl`.
- Multiple PR URLs: require explicit `continuePrUrl` or ask/fail with a clear error.
- Missing GitHub app permissions or repo access: fail closed before sandbox spawn.
- Branch deleted after session create but before spawn: existing `CHECKOUT_BRANCH` checkout failure
  path applies; surface as repo checkout failure.
- Same branch already has a different open PR: existing publish adoption/update behavior applies; same
  PR mode should verify the adopted PR number still equals the continuation PR.

## Observability

Emit a low-cardinality structured event when continuation resolution runs:

```ts
event: "session.continuation.resolved"
mode: "update_pr" | "new_pr"
source: "explicit" | "prompt_inferred"
result: "resolved" | "rejected"
reason_code:
  | "same_repo_head"
  | "fork_head_unsupported"
  | "cross_repo"
  | "closed_pr"
  | "missing_head_ref"
  | "unsafe_ref"
  | "github_fetch_failed"
```

No PR URL, branch name, prompt text, or session ID as metric tags. Logs may carry session ID for
debugging; metrics should aggregate by mode/result/reason only.

Add a Datadog metric only if implementation changes production behavior in the same PR. Otherwise
record the event first and add a dashboard follow-up if volume warrants it.

## Implementation slices

### Slice 1 — same-PR continuation resolver

- Add `continuePrUrl` / `continueMode` request parsing.
- Fetch PR context during session create.
- For same-repo open PR, derive `baseBranch` and `startBranch`.
- Reject fork/cross-repo/closed/missing-ref cases.
- Attach `prUrl/prNumber` for `update-pr`.
- Include CLI prompt in session-create body.

This slice makes `finish this PR` update same-repo PRs correctly.

### Slice 2 — fresh continuation PR mode

- Support `continueMode="new-pr"`.
- Start from PR head but leave live `session.prUrl` null.
- Inject source PR context into implementation prompt setup.
- Ensure original PR webhook refs are not registered as the active review-loop PR.

This slice satisfies "I don't want you to commandeer my PR, but work from it and open a fresh PR."

### Slice 3 — UI/CLI affordances

- Add explicit CLI flags.
- Add UI option only if needed; prompt inference should cover the common path.
- Surface resolved mode in session detail/debug views.

## Tests

Control-plane route tests:

- implementation prompt containing `finish this PR: <url>` derives `continuePrUrl`.
- explicit `continuePrUrl` wins over prompt inference.
- same-repo PR sets `baseBranch=pr.base.ref`, `startBranch=pr.head.ref`, and persists
  `targetPrUrl`.
- `update-pr` attaches `session.prUrl/prNumber`.
- `new-pr` leaves `session.prUrl/prNumber` null.
- explicit `startBranch` mismatch rejects.
- explicit `baseBranch` mismatch rejects.
- fork PR rejects.
- cross-repo PR rejects.
- multiple PR URLs without explicit `continuePrUrl` rejects.

Prompt dispatch / bridge tests:

- implementation continuation prompt includes PR context.
- PR comments/reviews are labeled as untrusted task material.

Publish tests:

- `update-pr` calls the existing update path and does not create a second PR.
- `new-pr` creates a new PR and registers review-loop refs only for the new PR.
- existing branch PR adoption still cannot accidentally attach a different PR than the continuation
  PR in `update-pr` mode.

CLI tests:

- initial prompt is included in `/api/sessions` create body.
- `--continue-pr` and `--continue-mode` serialize expected fields.

Verification:

- `npm run lint:changed`
- Focused Vitest for session-create, prompt-queue dispatch, publish-service, CLI create.
- No `npm run dev:full` required unless a UI affordance is added.

## Open questions

1. Should `auto` ever choose `new-pr` in v1?
   - Recommendation: no. Fail closed unless the user explicitly picks `new-pr`.
2. Should prompt inference require continuation verbs?
   - Recommendation: yes. Avoid treating reference PR links as checkout instructions.
3. Should continuation context be mirrored into D1?
   - Recommendation: not in slice 1. Keep it in DO state and prompt command context unless we need
     session-list/search/debug filters.
4. Should same-PR update preserve draft state?
   - Recommendation: yes. Reuse existing PR readiness/draft reconciliation.
5. Should closed PRs support `new-pr` immediately?
   - Recommendation: no. Closed/merged PR head refs are less reliable; ship open same-repo PRs first.
