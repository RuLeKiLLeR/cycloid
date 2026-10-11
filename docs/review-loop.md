# Review loop

After Cycloid opens a PR, it keeps working on it: addresses reviewer comments and fixes red CI. When automatic QA is enabled (opt-in — off by default), a QA Tester agent spawned at publish also checks the work against what was asked, in parallel. Runs until the PR is human-mergeable. Two ways to start it.

> The post-publish coordination that drives this loop — when QA runs, when the PR becomes merge-ready — is the [lifecycle FSM](fsm.md), the source of truth for post-publish lifecycle state. This page describes the behavior; `fsm.md` is the state machine and its live-vs-legacy ownership boundary.

## Automatic review handling (`automatic_reviews_enabled`)

Per-user setting under Settings → General, **default OFF** (migration `0253`). It gates only the review-handling arms — reviewer comments, human reviews, and merge-conflict resolution:

- **Off (default = manual mode):** Cycloid works CI to green and leaves reviews untouched. CI-fix, `ci_green → MERGE_READY`, and the QA verifier are unaffected. Mention `@cycloid` on a comment to pull it into a specific review regardless of this setting.
- **On:** every PR from your Cycloid sessions also gets automatic review handling (reviewer allow-list + merge-conflict resolution) driven to disposition.

Implementation: `resolveAutomaticReviewsEnabled` gates `resolveReviewLoopChecklist` / `resolveReviewLoopHumanEligibility` / `resolveReviewLoopMergeConflictEligibility` (failure reason `review_handling_disabled`, arm-only); `resolveReviewLoopCiEligibility` never consults it.

Per-repo config is still which reviewers Cycloid responds to (the allow-list) and whether to fix red CI. No reviewers picked for a repo → the review arm won't run on that repo's PRs even with automatic review handling on; CI fixes still run if enabled.

## On-demand on any PR

Trigger QA testing on any PR (yours, a teammate's, an external contributor's) by commenting:

```
@cycloid qa=true https://github.com/owner/repo/pull/123
```

The PR URL is required for QA testing.

Requires the Cycloid GitHub App installed on the repo and a registered Cycloid user.

## How it works

```
        Cycloid opens PR
              │
       ┌──────┴───────┐
       ▼              ▼
  ┌─────────┐   ┌──────────────┐
  │ Review  │   │ QA Tester    │  spawned at publish,
  │ loop    │   │ (parallel)   │  runs alongside the loop
  │ (CI fix,│   └──────┬───────┘
  │ reviewer│          ▼
  │ resp.)  │   verdict → PR comment
  └────┬────┘   (advisory; QA issues →
       │         non-blocking DM)
       ▼
 CI green + no in-flight epoch
       │
       ▼
 PR ready for human merge
```

The review loop and QA testing run **in parallel** — when automatic QA is enabled (opt-in; the `auto_verify_enabled` setting defaults **off** since migration `0242`), QA is spawned once at publish (`SPAWN_VERIFICATION_CHILD` on the `publish.pr_opened` transition; the spawn executor declines when auto-verify is off), not re-triggered by the review loop finishing. QA compares the change against the original task and posts its verdict as a PR comment (good to merge, needs more work, or doesn't match the ask); the verdict is **advisory and does not gate merge-ready**. The review loop separately listens for comments from your allow-listed reviewers and failing CI checks and drives them to disposition. `MERGE_READY` is reached on `ci_green ∧ no in-flight epoch` — the pure CI ladder — independent of the QA verdict. PR labels are projections of the FSM record (`labelsOf`), and the review-loop/verification label axis is **scrapped**: the only managed labels are the loud `NEEDS_YOU` terminals (`review-stuck`, `ci-fix-exhausted`, `owner-approval`, `internal-error`); the sticky informational `E2E-Tested` label is applied imperatively on a passing QA verdict, is not FSM-managed or a merge gate, and is never removed. Automated QA reruns for the same PR lifecycle enqueue into the same verifier session/sandbox, but each pass refreshes the PR head and clears per-pass evidence directories before running. Manual GitHub `qa=true` and Slack `qa=true` start fresh verifier sessions subject to the duplicate-spawn dedup (the FSM idempotency anchor). The user-initiated UI "Verify"/"QA Test PR" buttons additionally send `forceNewSession: true`, which skips the duplicate-return path; when the coordinator is already in `VERIFYING`, it kills the active child and admits a fresh run, otherwise it admits a new run directly. The loop stops when the review loop has nothing fresh and CI is green.

## Continuing an existing PR

PR takeover uses the same post-publish FSM path as a newly opened PR.
After the first push, publish emits publish.pr_opened, which moves the coordination record from PUBLISHING to REVIEW and keeps CI and reviewer monitoring active.

The adopted path preserves the human-owned PR narrative and draft state.
It still records the PR, updates the Cycloid verification/evidence comment, and runs the normal review-loop side effects.
It does not reconcile the title or body, apply Cycloid provenance labels, or mark a human-owned draft ready for review.

Only one non-terminal Cycloid session may coordinate an adopted PR at create time.
A second takeover receives pr_takeover_conflict with a link to the live session instead of racing the existing branch.

## FAQ

### Who actually merges the PR?

You. Cycloid never hits the merge button.

### What's verification-exhausted?

`verification-exhausted` is a legacy status name for QA testing that hit its per-PR round cap. It is no longer emitted as a PR label, and QA no longer gates the loop: since QA runs off-gate in parallel, a QA run that hits its cap or dies on infra (broken test harness, missing creds) now surfaces as a **non-blocking DM**, not a merge block. (Sessions still parked in the old `VERIFYING` gate drain out to a loud terminal; no new PR enters it.)

### What's verification-skipped?

`verification-skipped` is a legacy status name for a QA planner skip — the planner decided the PR didn't need a full QA run (e.g., docs-only changes with no runtime proof requirements). It is no longer emitted as a PR label; the review loop and merge-ready path are unaffected because QA is advisory.

### Will it respond to every comment on the PR?

No. The loop ingests a comment/review **only** from a recognized reviewer: a known review bot (Greptile, CodeRabbit, Cursor, ChatGPT Codex, Strix, GitHub Copilot) or a custom reviewer you configured for the repo. Every other bot — Linear linkbacks, `github-actions`, coverage/deploy/status apps, Graphite stack comments — is dropped (`actor_not_configured_bot`), so ordinary PR chatter never restarts the loop. The admission gate is `resolveIngestBotKey` + `PR_REVIEW_BOT_CAPABILITIES` in `apps/control-plane-worker/src/github/pr-review-bots.ts`. QA/verifier verdicts do **not** come through this gate — they arrive via the FSM `verification.*` spine.

### Can I stop the loop on one PR without turning the whole thing off?

Close the PR, or clear the reviewer list and turn off CI fixes for that repo under Settings → General.

### Nothing's happening on my PRs. Why?

Check: "Automatic review handling" is on (it is **off by default** — manual mode only fixes CI and ignores reviews unless you `@cycloid` a comment); the repo has at least one reviewer listed or CI fixes on; the PR came from a Cycloid session (hand-opened PRs need the `@cycloid qa=true` comment); the GitHub App on the repo receives PR review events. If the UI looks right and still nothing, share a screenshot of the General → Review panel with your Cycloid contact.

### Does the @cycloid qa=true trick respect the same settings?

Yes, same loop, same per-repo reviewer list and CI behavior. No saved settings for the repo → defaults: CI fixes on, no reviewers configured.

### Can someone else trigger the loop on my PR?

Yes, if they're a registered Cycloid user and the App is installed. The session runs under their account, not yours.

### How do I pause the review handling?

Flip "Automatic review handling" off (Settings → General). Mid-round review work finishes, then the review arms stop; CI-fix keeps running to green. Turn it back on when ready. To act on one specific comment while off, mention `@cycloid` on it.

### Will Cycloid edit CI config to make CI pass?

No. It fixes the failing code (broken tests, type errors, lint). It won't touch workflow files or change package versions unless specifically asked.
