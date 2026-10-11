# Review Loop v1.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship review-loop v1.2 — suppress Slack noise from follow-up requests, slim the follow-up prompt body, skip review-looping on unverified draft PRs (with telemetry), and drive the loop on failing CI checks until green.

**Architecture:** Four independent work units, each its own PR into release branch `review-loop-v1.2`, then one PR to `main`. All behavior stays behind the existing `users.pr_review_auto_response_enabled` gate. No migrations. Spec: `docs/superpowers/specs/2026-05-29-review-loop-v1.2-design.md`.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, D1 (raw SQL DAOs), Vitest (`tests/test_cloudflare/`). Run tests with `npx vitest run <path>` from repo root. Run `npm run typecheck` before each commit.

**Landing order (low → high risk):** WU2 (prompt strip) → WU1 (Slack suppression) → WU3 (draft skip + telemetry) → WU4 (CI-failure loop).

---

## File Structure

| Work unit                  | Files touched                                                                                                                                                                                                                                                                        | Test file                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WU1 Slack suppression      | `apps/control-plane-worker/src/session/prompt-queue.ts` (3 call sites)                                                                                                                                                                                                               | `tests/test_cloudflare/session/prompt-queue-helper.test.ts`                                                                                                            |
| WU2 Prompt-body strip      | `apps/control-plane-worker/src/webhooks/prompts.ts` (2 builders)                                                                                                                                                                                                                     | `tests/test_cloudflare/webhook-prompts.test.ts`                                                                                                                        |
| WU3 Draft skip + telemetry | `apps/control-plane-worker/src/session/publish-service.ts`; new `apps/control-plane-worker/src/observability/review-loop-metrics.ts`                                                                                                                                                 | `tests/test_cloudflare/session/pr-workflow.test.ts`; new metrics unit test                                                                                             |
| WU4 CI-failure loop        | `apps/control-plane-worker/src/webhooks/github.ts`; `apps/control-plane-worker/src/services/review-loop-epochs.ts`; `apps/control-plane-worker/src/services/review-loop-sweep.ts`; `apps/control-plane-worker/src/github/pr.ts`; `apps/control-plane-worker/src/webhooks/prompts.ts` | `tests/test_cloudflare/review-loop-webhook-service.test.ts`; `tests/test_cloudflare/github-pr-review-webhook.test.ts`; `tests/test_cloudflare/webhook-prompts.test.ts` |

---

## Setup (once)

- [ ] **Step 1:** `git branch --show-current` → expect `review-loop-v1.2` (already created, holds the spec commit). If not, `git checkout review-loop-v1.2`.

Each work unit is implemented on its own branch cut from `review-loop-v1.2`, PR targeting `review-loop-v1.2`.

---

## Work Unit 2 — Strip the redundant PR header from the follow-up body

PR title: `Review loop v1.2: strip redundant PR header from follow-up prompt`. Branch from `review-loop-v1.2`.

Drop `Repository:`, `GitHub Pull Request: #N`, and `PR URL:` from both builders. **Keep `Head SHA:`** and the `[cycloid:review-loop epoch=…]` marker. The worklist (with per-item source URLs) is unchanged.

### Task 2.1: Update existing tests to reflect the slimmed bot-path prompt

**Files:** test `tests/test_cloudflare/webhook-prompts.test.ts`

- [ ] **Step 1:** In the test `"builds structured review-loop prompts with epoch marker and wrapped reviewer text"` (~line 502), replace the assertion block:

```typescript
expect(result).toContain("[cycloid:review-loop epoch=epoch-123]");
// PR header stripped — these are already in session context (v1.2):
expect(result).not.toContain("GitHub Pull Request: #42");
expect(result).not.toContain("PR URL:");
expect(result).not.toContain("Repository:");
// Head SHA kept for bookkeeping:
expect(result).toContain("Head SHA: abc123");
expect(result).toContain("Timed out bots: known:greptile");
expect(result).toContain("Duplicate group: issue-comment:1 duplicates issue-comment:2");
expect(result).toContain("Conflict: review-comment:1, review-comment:3 - Conflicting nullability guidance");
expect(result).toContain('<user_content source="github_pr_review_loop_item" author="cursor[bot]">');
expect(result).toContain("Handle <script>alert(1)</script> and add tests.");
expect(result).toContain(
  "Use the guarded review-loop publish path and cycloid.review_loop_reply for source-linked replies; do not run raw GitHub mutation commands.",
);
```

- [ ] **Step 2:** Replace the test `"opens with a human-first header that mentions human reviewer feedback and the PR URL"` (~line 568) with:

```typescript
it("opens with a human-first header that mentions human reviewer feedback without the PR URL", () => {
  const result = buildGithubPrReviewLoopHumanPrompt(baseParams);

  expect(result).toContain("human reviewer");
  expect(result).not.toContain("https://github.com/acme/repo/pull/99");
  expect(result).not.toContain("GitHub Pull Request: #99");
  expect(result).not.toContain("Repository:");
  expect(result).toContain("Head SHA: deadbeef");
});
```

- [ ] **Step 3:** `npx vitest run tests/test_cloudflare/webhook-prompts.test.ts` → FAIL (builders still emit `GitHub Pull Request:` / `PR URL:` / `Repository:` and the PR URL).

### Task 2.2: Slim `buildGithubPrReviewLoopPrompt`

**Files:** modify `apps/control-plane-worker/src/webhooks/prompts.ts:1055-1062`

- [ ] **Step 1:** Replace lines 1056-1062 (from `const normalizedRepoUrl` through `parts.push(`Head SHA: ${params.headSha}`);`) with:

```typescript
const parts: string[] = [`[cycloid:review-loop epoch=${params.epochId}]`];
// v1.2: repo/PR/PR-URL stripped — already present in session context. Keep Head SHA for bookkeeping.
parts.push(`Head SHA: ${params.headSha}`);
```

(The `const parts` line already exists as the function's first line; merge to a single `parts` declaration followed by the Head SHA push. Remove the now-unused `normalizedRepoUrl` and `normalizedPrUrl` locals in this function.)

### Task 2.3: Slim `buildGithubPrReviewLoopHumanPrompt`

**Files:** modify `apps/control-plane-worker/src/webhooks/prompts.ts:1091-1102`

- [ ] **Step 1:** Replace lines 1092-1102 with:

```typescript
const parts: string[] = [`[cycloid:review-loop epoch=${params.epochId}]`];
parts.push("There is unaddressed PR review feedback from a human reviewer (and possibly bots).");
// v1.2: repo/PR/PR-URL stripped — already present in session context. Keep Head SHA for bookkeeping.
parts.push(`Head SHA: ${params.headSha}`);
```

(Remove the now-unused `normalizedPrUrl` and `normalizedRepoUrl` locals in this function.)

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/webhook-prompts.test.ts` → PASS.

- [ ] **Step 3:** `npm run -w @cycloid/control-plane-worker typecheck` → no errors. If `normalizedRepoUrl`/`normalizedPrUrl`/`normalizeWebhookReference` become unused in these functions, delete the dead locals (keep the import if still used elsewhere in the file).

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane-worker/src/webhooks/prompts.ts tests/test_cloudflare/webhook-prompts.test.ts
git commit -m "Review loop v1.2: strip redundant PR header from follow-up prompt"
```

---

## Work Unit 1 — Suppress review-loop follow-up requests in Slack

PR title: `Review loop v1.2: suppress review-loop follow-ups in Slack`. Branch from `review-loop-v1.2`.

A review-loop follow-up prompt carries `reviewLoopEpochId`. On finalization, `prompt-queue.ts` mirrors completion to the Slack thread via `host.notifySlackThread(...)`. Gate those calls so review-loop prompts are not mirrored. PR-created/merged notifications (separate `PrWorkflowNotifications` path) are untouched.

### Task 1.1: Gate the three `notifySlackThread` call sites

**Files:** modify `apps/control-plane-worker/src/session/prompt-queue.ts` (call sites ~1110, ~1458, ~1742)

- [ ] **Step 1:** Call site 1 (`handlePromptCallbackRequest`, ~line 1110) — finalized prompt object `prompt` is in scope:

```typescript
if (!activePromptId && !prompt?.reviewLoopEpochId) {
  host.notifySlackThread(session.sessionId, finalizedPromptId, !failed).catch((err) => {
    host.log.error({ sessionId: session.sessionId, error: String(err) }, "Slack thread notification error");
    Sentry.captureException(err, {
      tags: { sessionId: session.sessionId, operation: "notifySlackThread" },
    });
  });
}
```

- [ ] **Step 2:** Call site 2 (`completeActivePrompt`, ~line 1458) — finalized prompt object `activePrompt` is in scope:

```typescript
if (!activePromptId && !activePrompt?.reviewLoopEpochId) {
  host.notifySlackThread(sessionId, finalizedPromptId, completion.success).catch((err) => {
    host.log.error({ sessionId, error: String(err) }, "Slack thread notification error");
    Sentry.captureException(err, { tags: { sessionId, operation: "notifySlackThread" } });
  });
}
```

- [ ] **Step 3:** Call site 3 (`recoverStalePromptCompletion`, ~line 1742) — finalized prompt object `prompt` is in scope:

```typescript
if (!prompt?.reviewLoopEpochId) {
  host.notifySlackThread(sessionId, finalizedPromptId, completion.success).catch((err) => {
    host.log.error({ sessionId, error: String(err) }, "Slack thread notification error");
    Sentry.captureException(err, { tags: { sessionId, operation: "notifySlackThread" } });
  });
}
```

> If `prompt`/`activePrompt` is not in scope or not the finalized prompt at a site: `const finalized = doDb.getPrompt(this.sql, finalizedPromptId)` is NOT available (no `this` in prompt-queue helpers) — read the prompt already fetched in that function instead. Confirm the variable name by reading ~30 lines above each call before editing.

### Task 1.2: Test — review-loop prompts are not mirrored to Slack

**Files:** test `tests/test_cloudflare/session/prompt-queue-helper.test.ts`

- [ ] **Step 1:** Read the file to find the test that finalizes a prompt and the mock `host` with a `notifySlackThread` spy (host interface declares `notifySlackThread(sessionId, promptId, success)`). Reuse that harness.

- [ ] **Step 2:** Add a test where a prompt carrying `reviewLoopEpochId` is finalized and the spy is not called, plus a control where a normal prompt IS mirrored:

```typescript
it("does not mirror review-loop follow-up prompts to Slack", async () => {
  const { host, notifySlackThread } = makePromptQueueHost(); // reuse this file's existing host factory
  // Arrange: a finalized prompt that carries a review-loop epoch id.
  const prompt = makePromptState({ promptId: "p-rl-1", reviewLoopEpochId: "epoch-1" });
  await completeActivePrompt(host, "s-1", prompt, { success: true });
  expect(notifySlackThread).not.toHaveBeenCalled();
});

it("still mirrors normal prompts to Slack", async () => {
  const { host, notifySlackThread } = makePromptQueueHost();
  const prompt = makePromptState({ promptId: "p-normal-1" }); // no reviewLoopEpochId
  await completeActivePrompt(host, "s-1", prompt, { success: true });
  expect(notifySlackThread).toHaveBeenCalledWith("s-1", "p-normal-1", true);
});
```

Adapt helper names (`makePromptQueueHost`, `makePromptState`, `completeActivePrompt` invocation) to whatever the file uses; the `notifySlackThread` spy assertions are the contract.

- [ ] **Step 3:** `npx vitest run tests/test_cloudflare/session/prompt-queue-helper.test.ts` → PASS (review-loop prompt → spy not called; normal prompt → spy called).

- [ ] **Step 4: Typecheck + commit**

```bash
npm run -w @cycloid/control-plane-worker typecheck
git add apps/control-plane-worker/src/session/prompt-queue.ts tests/test_cloudflare/session/prompt-queue-helper.test.ts
git commit -m "Review loop v1.2: suppress review-loop follow-ups in Slack"
```

---

## Work Unit 3 — Draft PR skips review-looping (with skip telemetry)

PR title: `Review loop v1.2: skip review-loop on draft PRs + skip counter`. Branch from `review-loop-v1.2`.

When the feature is enabled AND Cycloid opened the PR as a draft (`options.draft === true`), do not arm review-listening; post one explanatory PR comment and emit a non-alerting Datadog counter. The draft flag is `options.draft` (from `prDraftOptions(request.verification)`), already in scope at both `enterReviewListeningIfEligible` call sites (publish-service.ts:820, 908).

### Task 3.1: Add the non-alerting skip counter helper

**Files:** create `apps/control-plane-worker/src/observability/review-loop-metrics.ts`; test `tests/test_cloudflare/review-loop-metrics.test.ts`

- [ ] **Step 1:** Write the failing test:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

import { emitReviewLoopDraftSkipMetric } from "../../apps/control-plane-worker/src/observability/review-loop-metrics";

describe("emitReviewLoopDraftSkipMetric", () => {
  afterEach(() => vi.restoreAllMocks());

  it("POSTs a us5 count metric named arcanist.review_loop.skipped_draft with tags", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));
    await emitReviewLoopDraftSkipMetric({ DD_API_KEY: "key-123" } as never, {
      repo: "acme/repo",
      ownerUserId: 101,
      sessionId: "s-1",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.us5.datadoghq.com/api/v2/series");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.series[0].metric).toBe("arcanist.review_loop.skipped_draft");
    expect(body.series[0].type).toBe(1); // COUNT
    expect(body.series[0].points[0].value).toBe(1);
    expect(body.series[0].tags).toEqual(
      expect.arrayContaining(["repo:acme/repo", "owner_user_id:101", "session_id:s-1"]),
    );
  });

  it("no-ops without an API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await emitReviewLoopDraftSkipMetric({} as never, { repo: "acme/repo", ownerUserId: 101, sessionId: "s-1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/review-loop-metrics.test.ts` → FAIL (module/function does not exist).

- [ ] **Step 3:** Create `apps/control-plane-worker/src/observability/review-loop-metrics.ts`:

```typescript
import type { Env } from "../types";

// Non-alerting: this metric intentionally has no Datadog monitor. The distinct
// `arcanist.review_loop.skipped_draft` name keeps it out of catch-all monitors so it never
// routes to the Slack Datadog channel. Revisit query (us5): sum:arcanist.review_loop.skipped_draft{*}
// See docs/superpowers/specs/2026-05-29-review-loop-v1.2-design.md (2026-06-05 revisit).
const US5_SERIES_URL = "https://api.us5.datadoghq.com/api/v2/series";

export async function emitReviewLoopDraftSkipMetric(
  env: Pick<Env, "DD_API_KEY">,
  tags: { repo: string; ownerUserId: number; sessionId: string },
): Promise<void> {
  const apiKey = env.DD_API_KEY;
  if (!apiKey) return;
  const payload = {
    series: [
      {
        metric: "arcanist.review_loop.skipped_draft",
        type: 1, // 1 = COUNT
        points: [{ timestamp: Math.floor(Date.now() / 1000), value: 1 }],
        tags: [`repo:${tags.repo}`, `owner_user_id:${tags.ownerUserId}`, `session_id:${tags.sessionId}`],
      },
    ],
  };
  try {
    const response = await fetch(US5_SERIES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "DD-API-KEY": apiKey },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.warn(`[review-loop-metrics] skip metric POST failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.warn(`[review-loop-metrics] skip metric POST threw: ${String(err)}`);
  }
}
```

> Confirm `DD_API_KEY` is on the `Env` type (used by `observability/phase-metrics.ts`). If the env var name differs, match `phase-metrics.ts`.

- [ ] **Step 4:** `npx vitest run tests/test_cloudflare/review-loop-metrics.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/observability/review-loop-metrics.ts tests/test_cloudflare/review-loop-metrics.test.ts
git commit -m "Review loop v1.2: add non-alerting draft-skip counter"
```

### Task 3.2: Gate review-listening on draft in `enterReviewListeningIfEligible`

**Files:** modify `apps/control-plane-worker/src/session/publish-service.ts:1497-1558`; test `tests/test_cloudflare/session/pr-workflow.test.ts`

- [ ] **Step 1:** Change the signature of `enterReviewListeningIfEligible` to accept the draft flag, and insert the skip branch immediately after the `resolveReviewLoopChecklist` success gate (after line 1536, before `await this.enterReviewListening(...)`):

```typescript
  private async enterReviewListeningIfEligible(
    sessionId: string,
    session: NonNullable<ReturnType<typeof doDb.getSession>>,
    ext: SessionPrWorkflowExt,
    prUrl: string,
    currentHeadSha: string,
    promptId?: string,
    isDraft?: boolean,
  ): Promise<void> {
```

After the checklist resolution try/catch (the block that returns on `!checklist.ok`), insert:

```typescript
// v1.2: a draft means verification was skipped/failed. Do not review-loop on unverified code.
if (isDraft) {
  const repo = `${repoOwner}/${repoName}`;
  this.host.log.info(
    { sessionId, prUrl, repo },
    "Skipping review listening: PR opened as draft (verification skipped/failed)",
  );
  if (typeof ext.prNumber === "number" && ext.prNumber > 0) {
    try {
      const token = await this.resolveInstallationToken(session, ext); // see Step 2 note
      await createPrIssueComment(
        token,
        repoOwner,
        repoName,
        ext.prNumber,
        "Skipping Cycloid review-loop: this PR was opened as a draft because verification was skipped or failed. This change needs human attention before automated review handling resumes.",
      );
    } catch (err) {
      this.host.log.warn({ sessionId, error: String(err) }, "Failed to post draft-skip PR comment");
    }
  }
  await emitReviewLoopDraftSkipMetric(this.host.env, { repo, ownerUserId, sessionId });
  return;
}

await this.enterReviewListening(sessionId, prUrl, currentHeadSha, promptId);
```

- [ ] **Step 2:** Resolve the GitHub token the same way the file already does — read how `publish-service.ts` obtains an installation token elsewhere (e.g. the existing `createPrIssueComment` call at line ~214) and reuse that exact token-resolution path rather than inventing `resolveInstallationToken`. Add the import at the top:

```typescript
import { createPrIssueComment } from "../github/pr";
import { emitReviewLoopDraftSkipMetric } from "../observability/review-loop-metrics";
```

(`createPrIssueComment` may already be imported — check before adding.)

- [ ] **Step 3:** At publish-service.ts:820 (update path) and :908 (create path), add `options.draft === true` as the final argument:

```typescript
await this.enterReviewListeningIfEligible(
  request.sessionId,
  session,
  ext,
  currentPr.prUrl, // or created.prUrl at the second site
  remoteHeadSha,
  request.promptId,
  options.draft === true,
);
```

- [ ] **Step 4:** In `tests/test_cloudflare/session/pr-workflow.test.ts`, using the existing harness (`createHost`, `seedSession`, `createSessionPrWorkflow`, `mockResolveReviewLoopChecklist`, `mockCreatePullRequest`), add tests driving a DRAFT publish. Mock `createPrIssueComment` and `emitReviewLoopDraftSkipMetric`:

```typescript
it("skips review listening and posts a comment when the PR is opened as a draft", async () => {
  const storage = new FakeStorage();
  seedSession(storage, {
    sessionId: SESSION_ID,
    ownerUserId: "101",
    repoOwner: "acme",
    repoName: "repo",
    baseBranch: "main",
  });
  const { host, enterReviewListening } = createHost(storage);
  const workflow = createSessionPrWorkflow(host);

  // Drive a draft publish (verification.publishMode = "draft" → options.draft true).
  await triggerDraftPrCreation(workflow); // adapt to the harness: set verification.publishMode="draft"

  expect(enterReviewListening).not.toHaveBeenCalled();
  expect(mockCreatePrIssueComment).toHaveBeenCalledWith(
    expect.anything(),
    "acme",
    "repo",
    expect.any(Number),
    expect.stringContaining("Skipping Cycloid review-loop"),
  );
  expect(mockEmitReviewLoopDraftSkipMetric).toHaveBeenCalledTimes(1);
});

it("does not post a draft-skip comment when the feature is disabled", async () => {
  mockResolveReviewLoopChecklist.mockResolvedValueOnce({ ok: false, reason: "auto_response_disabled" });
  const storage = new FakeStorage();
  seedSession(storage, {
    sessionId: SESSION_ID,
    ownerUserId: "101",
    repoOwner: "acme",
    repoName: "repo",
    baseBranch: "main",
  });
  const { host, enterReviewListening } = createHost(storage);
  const workflow = createSessionPrWorkflow(host);

  await triggerDraftPrCreation(workflow);

  expect(enterReviewListening).not.toHaveBeenCalled();
  expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
  expect(mockEmitReviewLoopDraftSkipMetric).not.toHaveBeenCalled();
});
```

Add the mocks near the top of the file (mirroring the existing `vi.mock` for review-loop-settings):

```typescript
const mockCreatePrIssueComment = vi.fn().mockResolvedValue({ id: 1, htmlUrl: "https://x" });
const mockEmitReviewLoopDraftSkipMetric = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../apps/control-plane-worker/src/github/pr", async (orig) => ({
  ...(await orig<typeof import("../../../apps/control-plane-worker/src/github/pr")>()),
  createPrIssueComment: (...a: unknown[]) => mockCreatePrIssueComment(...a),
}));
vi.mock("../../../apps/control-plane-worker/src/observability/review-loop-metrics", () => ({
  emitReviewLoopDraftSkipMetric: (...a: unknown[]) => mockEmitReviewLoopDraftSkipMetric(...a),
}));
```

`triggerDraftPrCreation` is a thin wrapper over the existing publish trigger that sets `verification.publishMode = "draft"` (so `prDraftOptions` returns `draft: true`). Inspect `mockCreatePullRequest`/`triggerPrCreation` in the file to see how `verification` is threaded.

- [ ] **Step 5:** `npx vitest run tests/test_cloudflare/session/pr-workflow.test.ts` → PASS (draft → no review-listening, comment posted, metric emitted once; disabled → nothing).

- [ ] **Step 6: Typecheck + commit**

```bash
npm run -w @cycloid/control-plane-worker typecheck
git add apps/control-plane-worker/src/session/publish-service.ts tests/test_cloudflare/session/pr-workflow.test.ts
git commit -m "Review loop v1.2: skip review-loop on draft PRs with skip counter"
```

---

## Work Unit 4 — Failing CI checks drive the loop until green

PR title: `Review loop v1.2: drive review-loop on failing CI checks`. Branch from `review-loop-v1.2`.

A failing terminal `check_run` (`conclusion` ∈ {`failure`, `timed_out`, `action_required`}) from ANY app, on a review-listening PR whose `reviewListeningHeadSha` matches `check_run.head_sha`, becomes actionable: record a `ci_failure` epoch signal, drive the sweep to fetch failing checks for the head SHA and prompt the agent to fix them. Loop continues as the head advances; terminates when all checks are green/skipped. Cap: 3 consecutive CI-fix attempts per change, reset on any new external signal (review item or human push).

**Existing machinery to reuse:**

- `handleCheckRunEvent` (github.ts:1162) already parses the payload and loops `pull_requests`; currently every PR goes to `ingestReviewLoopCheckRunWebhook` (bot-terminal only).
- `getCommitCheckRuns(token, owner, repo, sha)` and `getCommitCiStatus(token, owner, repo, sha)` already exist in `github/pr.ts` (returns `CommitCheckRun[]` with `{id,name,status,conclusion,appSlug,appName,detailsUrl}`, and `"failed"|"pending"|"success"|"unknown"`).
- The sweep (`review-loop-sweep.ts:512-546`) already builds the worklist via `getPrReviewLoopWorklist` and enqueues via the prompt builders.
- Epoch table: `pr_review_response_epochs`. Evidence is a JSON array; `source_kind` ∈ `bot|human|mixed`.

### Task 4.1: Define the failing-CI conclusion set and a check-run worklist mapper

**Files:** modify `apps/control-plane-worker/src/github/pr.ts`; test `tests/test_cloudflare/review-loop-ci-checks.test.ts` (new)

- [ ] **Step 1:** Write the failing test for the pure helpers:

```typescript
import { describe, expect, it } from "vitest";

import {
  FAILING_CHECK_RUN_CONCLUSIONS,
  failingCheckRunWorklistItems,
  hasPendingCheckRuns,
} from "../../apps/control-plane-worker/src/github/pr";

const run = (o: Partial<{ id: number; name: string; status: string; conclusion: string; detailsUrl: string }>) => ({
  id: o.id ?? 1,
  name: o.name ?? "ci",
  status: o.status ?? "completed",
  conclusion: o.conclusion ?? "success",
  appSlug: null,
  appName: null,
  detailsUrl: o.detailsUrl ?? null,
});

describe("failing CI check helpers", () => {
  it("treats failure/timed_out/action_required as failing", () => {
    expect([...FAILING_CHECK_RUN_CONCLUSIONS].sort()).toEqual(["action_required", "failure", "timed_out"]);
  });

  it("builds worklist items only for completed failing runs", () => {
    const items = failingCheckRunWorklistItems([
      run({ id: 1, name: "unit", conclusion: "failure", detailsUrl: "https://ci/1" }),
      run({ id: 2, name: "lint", conclusion: "success" }),
      run({ id: 3, name: "migrate", conclusion: "timed_out", detailsUrl: "https://ci/3" }),
      run({ id: 4, name: "flaky", status: "in_progress", conclusion: "" }),
    ]);
    expect(items.map((i) => i.sourceId)).toEqual(["check-run-failure:1", "check-run-failure:3"]);
    expect(items[0].body).toContain("unit");
    expect(items[0].body).toContain("failure");
    expect(items[0].sourceUrl).toBe("https://ci/1");
    expect(items[0].authorType).toBe("ci");
  });

  it("detects pending check runs", () => {
    expect(hasPendingCheckRuns([run({ status: "in_progress", conclusion: "" })])).toBe(true);
    expect(hasPendingCheckRuns([run({ status: "queued", conclusion: "" })])).toBe(true);
    expect(hasPendingCheckRuns([run({ status: "completed", conclusion: "failure" })])).toBe(false);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/review-loop-ci-checks.test.ts` → FAIL (helpers do not exist).

- [ ] **Step 3:** Implement in `github/pr.ts` near the `CommitCheckRun`/`getCommitCheckRuns` definitions, reusing the existing `ReviewLoopWorklistItem` type:

```typescript
export const FAILING_CHECK_RUN_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "timed_out", "action_required"]);

export function hasPendingCheckRuns(runs: CommitCheckRun[]): boolean {
  return runs.some((r) => r.status !== "completed");
}

/** Map failing, completed check runs to review-loop worklist items (CI source). */
export function failingCheckRunWorklistItems(runs: CommitCheckRun[]): ReviewLoopWorklistItem[] {
  return runs
    .filter((r) => r.status === "completed" && r.conclusion != null && FAILING_CHECK_RUN_CONCLUSIONS.has(r.conclusion))
    .map((r) => ({
      sourceId: `check-run-failure:${r.id}`,
      sourceUrl: r.detailsUrl ?? "",
      authorLogin: r.appSlug ?? r.appName ?? "ci",
      authorType: "ci",
      body: `Failing CI check "${r.name ?? "check"}" (conclusion: ${r.conclusion}). Investigate and fix so the check passes.`,
      path: null,
      line: null,
      updatedAtMs: 0,
      isResolved: false,
      isOutdated: false,
    }));
}
```

- [ ] **Step 4:** `npx vitest run tests/test_cloudflare/review-loop-ci-checks.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/github/pr.ts tests/test_cloudflare/review-loop-ci-checks.test.ts
git commit -m "Review loop v1.2: failing-CI check helpers"
```

### Task 4.2: Ingest failing CI check_runs as a `ci_failure` epoch signal

**Files:** modify `apps/control-plane-worker/src/services/review-loop-epochs.ts` (new `ingestReviewLoopCiFailureWebhook`); test `tests/test_cloudflare/review-loop-webhook-service.test.ts`

- [ ] **Step 1:** In `tests/test_cloudflare/review-loop-webhook-service.test.ts` (reuse the `session()` helper and DB setup), add:

```typescript
it("records a failing CI check_run from a non-bot app as a ci_failure epoch", async () => {
  const result = await service.ingestReviewLoopCiFailureWebhook({
    env: { DB: db } as never,
    deliveryId: "delivery-ci-1",
    sourceId: "check-run:7001:42",
    checkRunId: 7001,
    checkRunName: "unit tests",
    checkRunConclusion: "failure",
    actorLogin: "github-actions[bot]",
    actorType: "Bot",
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 42,
    prUrl: "https://github.com/acme/repo/pull/42",
    headSha: "head-sha",
  });
  expect(result.status).toBe("handled");
  expect(result.epoch?.status).toBe("ready");
  expect(result.epoch?.sourceKind).toBe("ci");
});

it("ignores a CI check_run when the session head SHA is stale", async () => {
  mockGetSessionState.mockResolvedValueOnce(session({ reviewListeningHeadSha: "other-sha" }));
  const result = await service.ingestReviewLoopCiFailureWebhook({
    env: { DB: db } as never,
    deliveryId: null,
    sourceId: "check-run:7002:42",
    checkRunId: 7002,
    checkRunName: "unit",
    checkRunConclusion: "failure",
    actorLogin: "github-actions[bot]",
    actorType: "Bot",
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 42,
    prUrl: "https://github.com/acme/repo/pull/42",
    headSha: "head-sha",
  });
  expect(result.status).toBe("ignored");
});
```

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/review-loop-webhook-service.test.ts` → FAIL (`ingestReviewLoopCiFailureWebhook` and `sourceKind: "ci"` do not exist).

- [ ] **Step 3:** In `review-loop-epochs.ts`:

1. Add `"ci"` to the `ReviewLoopSourceKind` union (find `type ReviewLoopSourceKind = "bot" | "human" | "mixed"` and add `| "ci"`). In `statusForObserved`, a CI epoch has no expected bots to wait on, so make it ready immediately — add near the human branch:

```typescript
if (sourceKind === "ci")
  return existingStatus === "ready" || existingStatus === "collecting" || !existingStatus ? "ready" : existingStatus;
```

Also add an exported sentinel hash constant near the top of the file:

```typescript
// CI-failure epochs key on this sentinel instead of a real expected-bots hash so they NEVER
// fold into a concurrent bot/human review epoch on the same head (the epoch unique key is
// owner+session+prUrl+headSha+expectedBotsHash and does NOT include source_kind). Distinct hash =
// distinct epoch row = CI fixing tracked independently of review-comment handling.
export const REVIEW_LOOP_CI_EPOCH_HASH = "ci-fixes";
```

> **Why the sentinel (important):** `selectLatestEpochByUniqueKey` keys on `expectedBotsHash`, not `source_kind`. If a CI failure reused the bot `expectedBotsHash`, it would fold into an existing bot epoch and the sweep would build the review-comment worklist with no CI items — the CI failure would be lost. The sentinel hash guarantees CI epochs are their own rows. The existing `insertReviewLoopEpochActivity` already honors `input.sourceKind ?? "bot"`, so passing `sourceKind: "ci"` is sufficient — no change to the insert's source_kind logic and no `mergedSourceKind` change.

2. Add the input interface and function (mirror `ingestReviewLoopCheckRunWebhook` but skip bot matching, require a failing conclusion, and key the epoch on the sentinel hash with `sourceKind: "ci"`). The `resolveReviewLoopChecklist` call here is only the feature-enabled gate; its `expectedBots`/hash are intentionally NOT used for the CI epoch:

```typescript
export interface ReviewLoopCiFailureWebhookInput {
  env: Env;
  deliveryId: string | null;
  sourceId: string;
  checkRunId: number;
  checkRunName: string | null;
  checkRunConclusion: string | null;
  actorLogin: string | null;
  actorType: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  headSha: string;
}

export async function ingestReviewLoopCiFailureWebhook(
  input: ReviewLoopCiFailureWebhookInput,
): Promise<ReviewLoopWebhookIngestResult> {
  const sessionIds = await listSessionIdsByWebhookRef(input.env.DB, SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, input.prUrl);
  if (sessionIds.length === 0) return { status: "ignored", reason: "no_review_listening_session" };

  const ignored: string[] = [];
  for (const sessionId of sessionIds) {
    const session = await getSessionState(input.env, sessionId);
    if (!session || session.status === "archived") continue;
    if (!session.reviewListeningActive || session.reviewListeningPrUrl !== input.prUrl) continue;
    const headSha = typeof session.reviewListeningHeadSha === "string" ? session.reviewListeningHeadSha.trim() : "";
    if (!headSha) {
      ignored.push("missing_head_sha");
      continue;
    }
    if (headSha !== input.headSha) {
      ignored.push("stale_head");
      continue;
    }
    const ownerUserId = Number(session.ownerUserId);
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) continue;
    const checklist = await resolveReviewLoopChecklist(input.env, {
      ownerUserId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
    });
    if (!checklist.ok) {
      ignored.push(checklist.reason);
      continue;
    }

    const epoch = await upsertReviewLoopEpochActivity(input.env.DB, {
      sessionId,
      ownerUserId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      headSha,
      expectedBots: [], // CI epochs wait on no bots
      expectedBotsHash: REVIEW_LOOP_CI_EPOCH_HASH, // sentinel — isolates from bot/human epochs
      sourceId: input.sourceId,
      sourceKind: "ci", // honored by insertReviewLoopEpochActivity (input.sourceKind ?? "bot")
      botKey: "ci", // non-empty placeholder; not used for CI worklist
      botActorLogin: input.actorLogin,
      terminal: true,
      evidence: {
        type: "ci_failure",
        sourceId: input.sourceId,
        checkRunId: input.checkRunId,
        checkRunName: input.checkRunName,
        conclusion: input.checkRunConclusion,
        deliveryId: input.deliveryId,
      },
      nowMs: Date.now(),
    });
    return { status: "handled", epoch };
  }
  return { status: "ignored", reason: ignored[0] ?? "no_review_listening_session" };
}
```

- [ ] **Step 4:** Confirm source-kind type + insert support (no merge change needed). The sentinel hash means CI activities never fold into a bot/human epoch, so `mergedSourceKind` needs no change. Verify only:

- `ReviewLoopSourceKind` includes `"ci"` (Step 3 item 1).
- `insertReviewLoopEpochActivity` sets `source_kind` from `input.sourceKind ?? "bot"` (it already does — confirm the line `const sourceKind: ReviewLoopSourceKind = isHuman ? "human" : (input.sourceKind ?? "bot");`). Passing `sourceKind: "ci"` therefore yields a `source_kind = "ci"` row. No edit beyond the union.
- `botKey`/`botActorLogin` are required fields on `ReviewLoopActivityInput`; the `"ci"` placeholder satisfies the type and is irrelevant for CI (no bot worklist is built for `ci` epochs).

- [ ] **Step 5:** `npx vitest run tests/test_cloudflare/review-loop-webhook-service.test.ts` → PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run -w @cycloid/control-plane-worker typecheck
git add apps/control-plane-worker/src/services/review-loop-epochs.ts tests/test_cloudflare/review-loop-webhook-service.test.ts
git commit -m "Review loop v1.2: ingest failing CI check_runs as ci_failure epochs"
```

### Task 4.3: Route failing CI check_runs in the webhook handler

**Files:** modify `apps/control-plane-worker/src/webhooks/github.ts` (`handleCheckRunEvent`, ~1251-1289); test `tests/test_cloudflare/github-pr-review-webhook.test.ts`

- [ ] **Step 1:** In the `"check_run webhook routing"` describe block, add (mock `ingestReviewLoopCiFailureWebhook` alongside the existing `ingestReviewLoopCheckRunWebhook` mock):

```typescript
it("routes a failing check_run from a non-configured app into CI-failure ingestion", async () => {
  mockIngestReviewLoopCheckRunWebhook.mockResolvedValueOnce({ status: "ignored", reason: "actor_not_configured_bot" });
  mockIngestReviewLoopCiFailureWebhook.mockResolvedValueOnce({
    status: "handled",
    epoch: { id: "epoch-ci-1", status: "ready" },
  });

  const payload = buildGithubCheckRunPayload({
    check_run: {
      id: 7100,
      name: "unit tests",
      status: "completed",
      conclusion: "failure",
      head_sha: "head-sha",
      app: { slug: "github-actions", name: "GitHub Actions" },
      pull_requests: [{ number: 42, head: { sha: "head-sha" } }],
    },
    sender: { id: 1, login: "github-actions[bot]", type: "Bot" },
  });
  const request = await makeSignedCheckRunRequest(JSON.stringify(payload), "delivery-ci-1");
  const response = await githubMod.handleGithubWebhook(request, buildEnv());

  expect(response.status).toBe(200);
  expect(mockIngestReviewLoopCiFailureWebhook).toHaveBeenCalledWith(
    expect.objectContaining({ checkRunId: 7100, checkRunConclusion: "failure", prNumber: 42, headSha: "head-sha" }),
  );
});

it("does NOT call CI-failure ingestion for a successful check_run", async () => {
  mockIngestReviewLoopCheckRunWebhook.mockResolvedValueOnce({ status: "ignored", reason: "actor_not_configured_bot" });
  const request = await makeSignedCheckRunRequest(JSON.stringify(buildGithubCheckRunPayload()), "delivery-ok-1"); // default conclusion: success
  await githubMod.handleGithubWebhook(request, buildEnv());
  expect(mockIngestReviewLoopCiFailureWebhook).not.toHaveBeenCalled();
});
```

Add the mock wiring next to the existing `ingestReviewLoopCheckRunWebhook` mock:

```typescript
const mockIngestReviewLoopCiFailureWebhook = vi.fn();
// in the vi.mock factory for review-loop-epochs, add:
//   ingestReviewLoopCiFailureWebhook: (...a) => mockIngestReviewLoopCiFailureWebhook(...a),
```

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/github-pr-review-webhook.test.ts` → FAIL.

- [ ] **Step 3:** In `handleCheckRunEvent`, import `FAILING_CHECK_RUN_CONCLUSIONS` from `../github/pr` and `ingestReviewLoopCiFailureWebhook` from the epochs service. Inside the `for (const entry of pullRequests)` loop, after the existing `ingestReviewLoopCheckRunWebhook` call, add a CI branch when the conclusion is failing:

```typescript
if (checkRunConclusion && FAILING_CHECK_RUN_CONCLUSIONS.has(checkRunConclusion)) {
  const ciResult = await ingestReviewLoopCiFailureWebhook({
    env,
    deliveryId,
    sourceId: `check-run:${checkRunId}:${prNumber}`,
    checkRunId,
    checkRunName,
    checkRunConclusion,
    actorLogin,
    actorType,
    repoOwner,
    repoName,
    prNumber,
    prUrl,
    headSha: checkRunHeadSha,
  });
  if (ciResult.status === "handled") {
    await syncReviewLoopStatusCommentForIngest(env, ciResult, log);
    handled += 1;
  } else {
    ignored += 1;
    ignoredReasons.push(`ci:${ciResult.reason}`);
  }
}
```

The Cycloid-owned-actor filter (already at the top of `handleCheckRunEvent`) prevents our own checks from triggering this. The duplicate-claim (`claimGithubWebhook`) already ran once per delivery, so the CI sourceId reuse is fine (epoch upsert dedups on `sourceId`).

- [ ] **Step 4:** `npx vitest run tests/test_cloudflare/github-pr-review-webhook.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run -w @cycloid/control-plane-worker typecheck
git add apps/control-plane-worker/src/webhooks/github.ts tests/test_cloudflare/github-pr-review-webhook.test.ts
git commit -m "Review loop v1.2: route failing CI check_runs to ci_failure ingestion"
```

### Task 4.4: Sweep — debounce, append failing-CI worklist items, and enforce the streak cap

**Files:** modify `apps/control-plane-worker/src/services/review-loop-sweep.ts` (worklist build ~512-546) and `apps/control-plane-worker/src/services/review-loop-epochs.ts` (new `countConsecutiveCiFixEpochsForPr`); test `tests/test_cloudflare/review-loop-ci-sweep.test.ts` (new) + extend webhook-service test for the count DAO

- [ ] **Step 1:** In `tests/test_cloudflare/review-loop-webhook-service.test.ts` (has a real in-memory DB), add:

```typescript
it("counts prior consecutive ci epochs, excluding the current one, resetting on a review epoch", async () => {
  // Build history oldest→newest for the same PR, advancing head_sha each time:
  //   ci(#1), ci(#2), human(#3), ci(#4 = current).
  // Arrange via service.upsertReviewLoopEpochActivity: ci epochs use expectedBots:[],
  //   expectedBotsHash: REVIEW_LOOP_CI_EPOCH_HASH, sourceKind:"ci"; the human epoch uses humanSource.
  // Excluding the current ci(#4), the trailing ci run is just ci(#4 excluded)→human(#3) breaks → 0 priors
  //   after the human; so streak counts ci epochs newer than the human and not equal to current = 0.
  const current = /* the ci(#4) epoch returned by the last upsert */;
  const streak = await service.countConsecutiveCiFixEpochsForPr(db, {
    sessionId: "s-review",
    prUrl: "https://github.com/acme/repo/pull/42",
    excludeEpochId: current.id,
  });
  expect(streak).toBe(0); // the human epoch (#3) sits between current and the earlier ci run → reset
});

it("counts the prior ci run when no review epoch intervenes", async () => {
  // History: ci(#1), ci(#2), ci(#3 = current). Excluding current → 2 priors.
  const current = /* ci(#3) */;
  const streak = await service.countConsecutiveCiFixEpochsForPr(db, {
    sessionId: "s-review",
    prUrl: "https://github.com/acme/repo/pull/42",
    excludeEpochId: current.id,
  });
  expect(streak).toBe(2);
});
```

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/review-loop-webhook-service.test.ts` → FAIL (`countConsecutiveCiFixEpochsForPr` does not exist).

- [ ] **Step 3:** Implement the streak-count DAO in `review-loop-epochs.ts`, modeled on the existing `pr_review_response_epochs` queries (e.g. `getMaxEpochWaveForSession` at line ~264). Count `source_kind = 'ci'` epochs newest-first, **excluding the current epoch being processed**, stopping at the first non-`ci` epoch. Excluding the current epoch makes the count = number of _prior_ consecutive CI-fix attempts, so a `>= 3` gate yields exactly 3 enqueued attempts before stopping:

```typescript
export async function countConsecutiveCiFixEpochsForPr(
  db: D1Database,
  input: { sessionId: string; prUrl: string; excludeEpochId: string },
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT id, source_kind FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ?
       ORDER BY created_at DESC, wave DESC`,
    )
    .bind(input.sessionId, input.prUrl)
    .all<{ id: string; source_kind: string }>();
  let streak = 0;
  for (const row of rows.results ?? []) {
    if (row.id === input.excludeEpochId) continue; // don't count the attempt we're about to make
    if (row.source_kind === "ci") streak += 1;
    else break; // a bot/human/mixed epoch (review item) resets the streak
  }
  return streak;
}
```

> Attempt accounting: epoch #1 → prior=0 → enqueue (attempt 1); #2 → prior=1 → enqueue (attempt 2); #3 → prior=2 → enqueue (attempt 3); #4 → prior=3 → `>= 3` → block. Exactly 3 enqueued fix attempts.
> Reset on a new external signal is covered because a new external head produces a fresh bot/human epoch (or no ci epoch); the count only sums the trailing run of `ci` epochs and breaks at the first review-bearing epoch.

- [ ] **Step 4:** Create `tests/test_cloudflare/review-loop-ci-sweep.test.ts`. Mock `getCommitCheckRuns`, `getCommitCiStatus`, `countConsecutiveCiFixEpochsForPr`, and `enqueueSessionPrompt`; drive the sweep's per-epoch processing for a `ci` epoch. Assert:

```typescript
// (a) Debounce: checks still pending → no prompt enqueued.
it("defers a ci epoch while checks are still pending", async () => {
  mockGetCommitCheckRuns.mockResolvedValue([
    { id: 1, name: "unit", status: "in_progress", conclusion: null, appSlug: null, appName: null, detailsUrl: null },
  ]);
  const outcome = await runSweepForClaimedCiEpoch(/* harness */);
  expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  expect(outcome).toBe("transient_deferred"); // or the existing "skipped"/defer outcome the sweep returns
});

// (b) Failing checks settled → prompt enqueued containing the failing check as a worklist item.
it("enqueues a fix prompt listing the failing checks", async () => {
  mockGetCommitCheckRuns.mockResolvedValue([
    {
      id: 9,
      name: "unit tests",
      status: "completed",
      conclusion: "failure",
      appSlug: "github-actions",
      appName: "GitHub Actions",
      detailsUrl: "https://ci/9",
    },
  ]);
  mockCountConsecutiveCiFixEpochsForPr.mockResolvedValue(0);
  await runSweepForClaimedCiEpoch(/* harness */);
  const prompt = mockEnqueueSessionPrompt.mock.calls[0][2];
  expect(prompt).toContain("unit tests");
  expect(prompt).toContain("Failing CI check");
});

// (c) Streak at cap → no prompt, escalation comment instead.
it("stops and escalates at the 3-attempt cap", async () => {
  mockGetCommitCheckRuns.mockResolvedValue([
    { id: 9, name: "unit", status: "completed", conclusion: "failure", appSlug: null, appName: null, detailsUrl: null },
  ]);
  mockCountConsecutiveCiFixEpochsForPr.mockResolvedValue(3);
  await runSweepForClaimedCiEpoch(/* harness */);
  expect(mockEnqueueSessionPrompt).not.toHaveBeenCalled();
  expect(mockSyncReviewLoopStatusComment).toHaveBeenCalled(); // escalation surfaced on the PR
});
```

`runSweepForClaimedCiEpoch` wraps the sweep's existing per-epoch processing function (the one containing lines 512-559). Read the sweep to find the entry point used by existing sweep tests and reuse that harness.

- [ ] **Step 5:** `npx vitest run tests/test_cloudflare/review-loop-ci-sweep.test.ts` → FAIL.

- [ ] **Step 6:** Implement the sweep branch for `ci` epochs. The per-epoch function is `processEpoch(env, epoch, nowMs, logger)` (internal to `review-loop-sweep.ts`, ~line 397). Place the `ci` branch **after the installation token is obtained** (~line 497, `const token = await createInstallationToken(env, installationId)`) and **before** the `backfillReviewLoopTerminalSignals` / `getPrReviewLoopWorklist` block (~line 512). The branch fully handles the `ci` epoch and returns, never reaching the bot/human worklist code. (The earlier `resolveReviewLoopChecklist` gate at ~line 466 runs for `ci` epochs too but is harmless — ingestion already required the feature enabled, so it resolves `ok`.) Branch when `claimed.sourceKind === "ci"`:

```typescript
if (claimed.sourceKind === "ci") {
  const runs = await getCommitCheckRuns(token, claimed.repoOwner, claimed.repoName, claimed.headSha);
  // Debounce: do not act mid-suite.
  if (hasPendingCheckRuns(runs)) {
    await markReviewLoopEpochContentionDeferred(env.DB, claimed.id, {
      reason: "ci_checks_pending",
      nowMs,
      expectedReservationToken: claimed.reservationToken,
    });
    return "contention_deferred";
  }
  const ciItems = failingCheckRunWorklistItems(runs);
  if (ciItems.length === 0) {
    // All green/skipped now — nothing to fix.
    await markReviewLoopEpochCompleted(env.DB, claimed.id, {
      nowMs,
      worklistHash: "",
      expectedReservationToken: claimed.reservationToken,
    });
    return "completed_noop";
  }
  // Streak cap: 3 consecutive ci-fix attempts per change; resets on any review-bearing epoch.
  // The DAO excludes this epoch, so `streak` = prior consecutive CI attempts (0,1,2 → enqueue; 3 → stop).
  const streak = await countConsecutiveCiFixEpochsForPr(env.DB, {
    sessionId: claimed.sessionId,
    prUrl: claimed.prUrl,
    excludeEpochId: claimed.id,
  });
  if (streak >= 3) {
    // Escalate on the PR. The managed status-comment service has no field for a one-off escalation
    // message, so post a plain PR comment (visible, simple, robust). Reuse the token already in scope.
    try {
      await createPrIssueComment(
        token,
        claimed.repoOwner,
        claimed.repoName,
        claimed.prNumber,
        "Cycloid: CI is still failing after 3 automated fix attempts on this change. This PR needs human attention. Automated CI fixing will resume after a new commit (a human push or a change addressing review feedback).",
      );
    } catch (err) {
      logger.warn({ epochId: claimed.id, error: String(err) }, "Failed to post CI-cap escalation comment");
    }
    await markReviewLoopEpochBlocked(env.DB, claimed.id, {
      reason: "ci_attempt_cap_reached",
      error: "CI still failing after 3 automated fix attempts",
      nowMs,
      expectedReservationToken: claimed.reservationToken,
    });
    return "blocked";
  }
  const prompt = buildGithubPrReviewLoopPrompt({
    epochId: claimed.id,
    repoUrl: `https://github.com/${claimed.repoOwner}/${claimed.repoName}`,
    prUrl: claimed.prUrl,
    prNumber: claimed.prNumber,
    headSha: claimed.headSha,
    worklistItems: ciItems,
    duplicateGroups: [],
    timedOutBotKeys: claimed.timedOutBotKeys,
  });
  const enqueueResult = await enqueueSessionPrompt(env, claimed.sessionId, prompt, String(claimed.ownerUserId), {
    reviewLoopEpochId: claimed.id,
    reviewLoopSourceKind: "mixed", // sweep enqueue option accepts bot|human|mixed; CI uses the bot-style builder
  });
  // ... reuse the existing enqueue-result handling (contention/blocked/markEnqueued/markProcessing) below ...
  // Mirror lines 551-585 of the current sweep for the enqueueResult branches.
  return "enqueued"; // after the shared markReviewLoopEpochEnqueued bookkeeping
}
```

> The `reviewLoopSourceKind` enqueue option type is `"bot" | "human" | "mixed"`. CI epochs use the bot-style builder (`buildGithubPrReviewLoopPrompt`) and pass `"mixed"` for the enqueue attribute (only metadata on the prompt). Optionally widen that option type to include `"ci"` in `enqueueSessionPrompt` + `prompt-queue.ts` — not required for behavior.

Add imports at the top of `review-loop-sweep.ts`:

```typescript
import {
  createPrIssueComment,
  failingCheckRunWorklistItems,
  getCommitCheckRuns,
  hasPendingCheckRuns,
} from "../github/pr";
import { countConsecutiveCiFixEpochsForPr } from "./review-loop-epochs";
```

(`getCommitCheckRuns` is already imported — extend the existing `../github/pr` import rather than duplicating; add `createPrIssueComment`, `failingCheckRunWorklistItems`, `hasPendingCheckRuns`. `countConsecutiveCiFixEpochsForPr` joins the existing `./review-loop-epochs` import block.)

- [ ] **Step 7:** `npx vitest run tests/test_cloudflare/review-loop-ci-sweep.test.ts tests/test_cloudflare/review-loop-webhook-service.test.ts` → PASS.

- [ ] **Step 8:** Confirm the `ci` epoch is selected by the sweep (no code change expected). `listDueReviewLoopEpochs` (review-loop-epochs.ts:503) selects `WHERE status = 'ready' OR (status = 'collecting' AND fallback_after_at <= ?) OR ...` with **no `source_kind` filter** — confirmed by reading. A `ci` epoch created with `status: "ready"` (Task 4.2) is selected as-is. Add a regression test asserting a `ready` `ci` epoch row is returned by `listDueReviewLoopEpochs`.

- [ ] **Step 9: Typecheck + commit**

```bash
npm run -w @cycloid/control-plane-worker typecheck
git add apps/control-plane-worker/src/services/review-loop-sweep.ts apps/control-plane-worker/src/services/review-loop-epochs.ts tests/test_cloudflare/review-loop-ci-sweep.test.ts tests/test_cloudflare/review-loop-webhook-service.test.ts
git commit -m "Review loop v1.2: sweep failing CI checks with debounce and 3-attempt streak cap"
```

### Task 4.5: Full-suite check + open the PR

- [ ] **Step 1:** `npx vitest run tests/test_cloudflare/` → PASS. Fix any regressions before opening the PR.

- [ ] **Step 2: Open the PR into the release branch**

```bash
git push -u origin <wu4-branch>
gh pr create --base review-loop-v1.2 --title "Review loop v1.2: drive review-loop on failing CI checks" --body "<summary + link to spec>"
```

---

## Integration

After all four work-unit PRs merge into `review-loop-v1.2`:

- [ ] **Step 1:** `npx vitest run tests/test_cloudflare/ && npm run typecheck` → PASS.

- [ ] **Step 2: Open the release PR to main**

```bash
gh pr create --base main --head review-loop-v1.2 --title "Review loop v1.2" --body "<summary of all four work units + link to spec>"
```

Do NOT enable auto-merge. The release PR is merged manually.

- [ ] **Step 3: Post-merge staging verification (Item 4)** — replay a failing `check_run` on a review-listening PR in staging; confirm a fix session is triggered, the loop continues to green, and the 3-attempt cap escalates via the status comment. See `docs/testing.md`.

---

## Notes for the implementer

- `npx vitest run <path>` runs a single file; from repo root.
- Always `npm run -w @cycloid/control-plane-worker typecheck` before committing (the pre-commit hook also runs full typecheck).
- Routes call services; services call DAOs. The new CI ingestion lives in the epochs service; the webhook handler only routes.
- The streak reset is implicit: `countConsecutiveCiFixEpochsForPr` counts only the trailing run of `source_kind = 'ci'` epochs, so any intervening bot/human/mixed epoch (a review item) or a human push producing a non-ci epoch resets the count to 0.
