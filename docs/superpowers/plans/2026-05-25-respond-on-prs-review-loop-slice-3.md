# Respond-on-PRs Review Loop Slice 3 Plan

## Goal

Finish the plan-backed review-loop slice for configured PR review bots:

- Convert configured bot webhook activity into durable response epochs.
- Poll the final PR state, build a structured worklist, and enqueue a guarded follow-up prompt.
- Keep review-loop publication and bot replies in control-plane-owned code paths.
- Add admin retry/complete escape hatches.
- Harden bridge guardrails for review-loop sessions and fix the approval UI duplicate `Other` behavior.

## Constraints

- Do not write `session_index` directly from webhook/epoch/sweep code; session projection remains owned by existing projection helpers and lifecycle paths.
- Re-check repo settings and expected bot checklist before epoch creation, prompt enqueue, push, and reply.
- Use GitHub installation/user credentials only server-side.
- Fail closed when repo authorization, session state, bot identity, checklist settings, head SHA, or active prompt state cannot be proven.
- Write failing tests before production code for each behavior.

## Implementation Steps

1. Add epoch persistence helpers around `pr_review_response_epochs`.
   - Define the epoch row shape and JSON field parsing.
   - Add create/upsert-by-unique-key, event merge, status transition, reservation, retry, complete, and due-list helpers.
   - Cover CAS/status transitions and JSON parsing in focused tests.

2. Add review-loop bot/event ingestion.
   - Find the review-listening session by `session_index.pr_url`/webhook refs and require `rich_status='review_listening'`.
   - Match configured bots against known aliases/capabilities or exact custom bot logins with Bot/App metadata.
   - Treat first top-level comments as activity, not terminal completion.
   - Use review `commit_id` for review submissions and review-comment `comment.commit_id` where available.
   - Keep legacy human PR review behavior intact.

3. Add final PR worklist and prompt enqueue.
   - Add paginated GitHub GraphQL/REST helpers for review threads and issue comments.
   - Skip resolved/outdated/empty/status-only/own-reply-only items.
   - Build a deterministic worklist hash and structured prompt with `[cycloid:review-loop epoch=<epoch_id>]`.
   - Extend prompt enqueue/bridge command metadata with `reviewLoopMode` and `epochId`.

4. Add scheduled sweep and session lifecycle integration.
   - Hook the sweep into `router.scheduled`.
   - Claim due epochs, refresh settings/head/session state, poll GitHub, enqueue prompts, and mark blocked/completed/retry states.
   - Emit review-listening lifecycle events through the existing Session DO path where applicable.

5. Add guarded publish/reply service methods.
   - Add scope caps: max 10 files or 300 changed lines.
   - Force owner approval for sensitive paths.
   - Validate stale head, active session, settings checklist, and repo authorization before mutation.
   - Add idempotent retry state for partial publish/reply.

6. Add admin escape hatches.
   - Add `POST /api/admin/pr-review-epochs/:id/retry`.
   - Add `POST /api/admin/pr-review-epochs/:id/complete`.
   - Wire through the existing route table and admin-token allowlist.

7. Harden bridge and UI.
   - In review-loop mode, require both prompt frontmatter and bridge metadata.
   - Block raw GitHub mutation escape hatches and writes outside the worktree.
   - Update `QuestionOptions` so explicit `Something else` opens free text and does not duplicate the generic `Other...` option.

8. Verify and publish.
   - Run focused Vitest suites for the new behavior.
   - Run `npx tsc --noEmit` or the repo’s focused typecheck if the changed surface needs it.
   - Run `npm run lint:changed`.
   - Commit, push the stacked branch, and open a draft PR against `codex/respond-on-prs-review-listening`.
