# 👀 Acknowledgement Reaction on Ingested PR Reviews — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Cycloid accepts a PR review (human or bot) into the review loop, leave a 👀 reaction on the review's comment(s) so the reviewer sees it was picked up even while it is queued behind an in-flight epoch.

**Architecture:** A new REST wrapper reacts to inline PR review comments (the existing one already handles top-level PR/issue comments). A new focused module `webhooks/review-ack-reaction.ts` holds a **pure decision** (skip Cycloid-owned authors + known-bot no-findings/in-progress noise) and a **fire-and-forget scheduler** (fetch inline comments when needed, cap fan-out, post reactions off the response path). The three webhook handlers call the scheduler at each point their ingest returns `{ status: "handled" }`.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest. GitHub REST reactions API via the existing raw-fetch client (installation-token auth).

## Global Constraints

- Reaction content is ALWAYS `"eyes"`, exported as `GITHUB_REVIEW_ACK_REACTION`.
- Inline fan-out cap = `REVIEW_ACK_INLINE_CAP = 50`; `log.warn` on truncation — never a silent cap.
- Fire-and-forget ONLY: never awaited on the webhook response path, never throws into ingest. Every path ends in `.catch(log.warn)` handed to `executionCtx.waitUntil`.
- Fires only when ingest returns `{ status: "handled" }` (`services/review-loop-epochs.ts:2457`). Every `{ status: "ignored" }` reason gets no reaction, for free.
- Skip Cycloid-owned authors (incl. the `cycloid-qa[bot]` QA carve-out that IS admitted to ingest) and known-bot no-findings / in-progress noise. Humans and custom bots always react.
- No new D1 table — GitHub's reaction POST is naturally idempotent (re-post returns the existing reaction), and the bot path already claims webhook-delivery idempotency.
- The human-review path fans out over multiple sessions; the ack fires **once per review**, not once per session.
- Import `ReviewComment` structurally (`{ id: number | null; reviewId: number | null }`) — the interface in `github/pr.ts` is not exported.

---

### Task 1: `postReviewCommentReaction` REST wrapper

Adds the one endpoint the codebase lacks: a reaction on an inline PR review comment (`POST /repos/{o}/{r}/pulls/comments/{id}/reactions`). Mirror of the existing `postIssueCommentReaction`.

**Files:**

- Modify: `apps/control-plane-worker/src/github/issues.ts` (after `postIssueCommentReaction`, ends line 58)
- Test: `tests/test_cloudflare/github/issues.test.ts`

**Interfaces:**

- Consumes: `createInstallationToken` (`./octokit`), `GITHUB_API`, `githubHeaders` (`./pr`), `tracedFetch` (`../observability/wrappers`), `assertGithubOk` (`./errors`), `GithubIssueCommentReactionContent` (same file) — all already imported in `issues.ts`.
- Produces: `postReviewCommentReaction(env, installationId: number, owner: string, repo: string, commentId: number, content: GithubIssueCommentReactionContent): Promise<void>` and `const GITHUB_REVIEW_ACK_REACTION: GithubIssueCommentReactionContent = "eyes"`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_cloudflare/github/issues.test.ts` inside the `describe("github/issues", ...)` block:

```ts
it("posts an inline review-comment reaction to the pulls/comments endpoint", async () => {
  const { postReviewCommentReaction, GITHUB_REVIEW_ACK_REACTION } =
    await import("../../../apps/control-plane-worker/src/github/issues");
  const env = {} as Parameters<typeof postReviewCommentReaction>[0];

  await postReviewCommentReaction(env, 123, "acme", "repo", 555, GITHUB_REVIEW_ACK_REACTION);

  expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 123);
  expect(mockTracedFetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/acme/repo/pulls/comments/555/reactions",
    {
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer ghs_installation",
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ content: "eyes" }),
    },
    "github.postReviewCommentReaction",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/github/issues.test.ts -t "inline review-comment reaction"`
Expected: FAIL — `postReviewCommentReaction` is not exported (import resolves to `undefined`).

- [ ] **Step 3: Write minimal implementation**

Append to `apps/control-plane-worker/src/github/issues.ts` (after line 58, keeping `GITHUB_REVIEW_ACK_REACTION` near the other reaction constants at the top OR next to the function — place the const at the top with the others, line 11–12):

At the top, after `GITHUB_QA_FINISHED_REACTION` (line 11):

```ts
export const GITHUB_REVIEW_ACK_REACTION: GithubIssueCommentReactionContent = "eyes";
```

At the end of the file:

```ts
export async function postReviewCommentReaction(
  env: Env,
  installationId: number,
  owner: string,
  repo: string,
  commentId: number,
  content: GithubIssueCommentReactionContent,
): Promise<void> {
  const token = await createInstallationToken(env, installationId);
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${commentId}/reactions`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ content }),
    },
    "github.postReviewCommentReaction",
  );

  await assertGithubOk(response, "GitHub review comment reaction creation");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/test_cloudflare/github/issues.test.ts`
Expected: PASS (all tests in the file, including the two existing ones).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/github/issues.ts tests/test_cloudflare/github/issues.test.ts
git commit -m "feat(review-ack): add postReviewCommentReaction for inline review comments"
```

---

### Task 2: Pure ack decision (`decideReviewAckReaction`)

The heart of the feature, fully isolated and unit-testable with no GitHub/DB calls: given the author + a body, decide whether to react.

**Files:**

- Create: `apps/control-plane-worker/src/webhooks/review-ack-reaction.ts`
- Test: `tests/test_cloudflare/review-ack-reaction.test.ts`

**Interfaces:**

- Consumes: `classifyReviewLoopNoise` (`../github/review-loop-noise-gate`), and from `../github/pr-review-bots`: `ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET`, `knownReviewBotIdForActorLogin`, `normalizeGitHubActorLogin`, `isBotOrAppAuthor`.
- Produces: `type ReviewAckSkipReason = "owned" | "noise"`; `decideReviewAckReaction(params: { actorLogin: string | null | undefined; actorType: string | null | undefined; body: string | null | undefined }): { react: true } | { react: false; reason: ReviewAckSkipReason }`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_cloudflare/review-ack-reaction.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decideReviewAckReaction } from "../../apps/control-plane-worker/src/webhooks/review-ack-reaction";

describe("decideReviewAckReaction", () => {
  it("reacts to a human review", () => {
    expect(
      decideReviewAckReaction({ actorLogin: "octocat", actorType: "User", body: "please fix the null check" }),
    ).toEqual({ react: true });
  });

  it("reacts to a human review with an empty body (inline-only review)", () => {
    expect(decideReviewAckReaction({ actorLogin: "octocat", actorType: "User", body: "" })).toEqual({ react: true });
  });

  it("skips a Cycloid-owned author (cycloid-qa[bot] QA verdict)", () => {
    expect(
      decideReviewAckReaction({ actorLogin: "cycloid-qa[bot]", actorType: "Bot", body: "app_breaks: login fails" }),
    ).toEqual({ react: false, reason: "owned" });
  });

  it("skips a known bot's no-findings placeholder", () => {
    expect(
      decideReviewAckReaction({ actorLogin: "greptile-apps[bot]", actorType: "Bot", body: "No issues found." }),
    ).toEqual({ react: false, reason: "noise" });
  });

  it("skips a known bot's in-progress placeholder", () => {
    expect(
      decideReviewAckReaction({
        actorLogin: "greptile-apps[bot]",
        actorType: "Bot",
        body: "Security review in progress.",
      }),
    ).toEqual({ react: false, reason: "noise" });
  });

  it("reacts to a known bot review that carries real feedback", () => {
    expect(
      decideReviewAckReaction({
        actorLogin: "greptile-apps[bot]",
        actorType: "Bot",
        body: "This dereferences a null pointer on line 40.",
      }),
    ).toEqual({ react: true });
  });

  it("reacts to a custom (unknown) bot — never noise-gated", () => {
    expect(
      decideReviewAckReaction({ actorLogin: "acme-review-bot[bot]", actorType: "Bot", body: "No issues found." }),
    ).toEqual({ react: true });
  });
});
```

NOTE: `greptile-apps[bot]` must be a real known-bot alias. Before running, confirm the exact alias with:
`rg -n "greptile" apps/control-plane-worker/../../shared/constants/pr-review-bots.* apps/control-plane-worker/src/github/pr-review-bots.ts` and substitute the actual `actorAliases` login if it differs. The test's intent (known bot ⇒ noise-gated) is what matters; use whatever known alias the registry defines.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/review-ack-reaction.test.ts`
Expected: FAIL — module `review-ack-reaction` does not exist / `decideReviewAckReaction` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `apps/control-plane-worker/src/webhooks/review-ack-reaction.ts`:

```ts
import { classifyReviewLoopNoise } from "../github/review-loop-noise-gate";
import {
  ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET,
  isBotOrAppAuthor,
  knownReviewBotIdForActorLogin,
  normalizeGitHubActorLogin,
} from "../github/pr-review-bots";

export type ReviewAckSkipReason = "owned" | "noise";

/**
 * Pure ack decision: given the review/comment author and the body we would react to, decide whether to
 * leave a 👀. Skips Cycloid-owned authors (incl. the cycloid-qa[bot] QA verdict, which IS admitted to
 * ingest via a carve-out) and a KNOWN review bot's no-findings / in-progress placeholder (via the same
 * `classifyReviewLoopNoise` the worklist uses). Humans and custom bots always react — the classifier
 * fail-opens on both, and the residual guard keeps "lgtm, but see comments" reactable.
 */
export function decideReviewAckReaction(params: {
  actorLogin: string | null | undefined;
  actorType: string | null | undefined;
  body: string | null | undefined;
}): { react: true } | { react: false; reason: ReviewAckSkipReason } {
  const login = params.actorLogin ? normalizeGitHubActorLogin(params.actorLogin) : null;
  if (login && ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(login)) {
    return { react: false, reason: "owned" };
  }
  // Only a bot/app author can be a known review bot; humans are never noise-gated.
  const knownId = isBotOrAppAuthor(params.actorType) ? knownReviewBotIdForActorLogin(login) : null;
  const botKey = knownId ? `known:${knownId}` : null;
  if (classifyReviewLoopNoise({ botKey, body: params.body }).gated) {
    return { react: false, reason: "noise" };
  }
  return { react: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/test_cloudflare/review-ack-reaction.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/webhooks/review-ack-reaction.ts tests/test_cloudflare/review-ack-reaction.test.ts
git commit -m "feat(review-ack): pure decideReviewAckReaction (owned + noise gating)"
```

---

### Task 3: Fire-and-forget scheduler (`runReviewAckReaction` + `scheduleReviewAckReaction`)

Resolves reaction targets per surface (fetching + filtering inline comments for a review submission when not pre-supplied), applies the decision, caps fan-out, and posts — all off the response path.

**Files:**

- Modify: `apps/control-plane-worker/src/webhooks/review-ack-reaction.ts`
- Test: `tests/test_cloudflare/review-ack-reaction.test.ts`

**Interfaces:**

- Consumes: `createInstallationToken` (`../github/octokit`), `getPrReviewComments` (`../github/pr`), `GITHUB_REVIEW_ACK_REACTION`, `postIssueCommentReaction`, `postReviewCommentReaction` (`../github/issues`), `createLogger` (`../logger`), `Env` (`../types`), and `decideReviewAckReaction` (same file).
- Produces:
  - `const REVIEW_ACK_INLINE_CAP = 50`
  - `type ReviewAckSurface = { kind: "issue_comment"; commentId: number; body: string | null } | { kind: "review_comment"; commentId: number; body: string | null } | { kind: "review_submission"; reviewId: number | null; reviewBody: string | null; prNumber: number; inlineComments?: readonly { id: number | null; reviewId: number | null }[] }`
  - `interface ReviewAckInput { installationId: number | null | undefined; owner: string; repo: string; actorLogin: string | null; actorType: string | null; surface: ReviewAckSurface }`
  - `interface ReviewAckResult { posted: number; skipped: ReviewAckSkipReason | null; cappedFrom: number | null }`
  - `async function runReviewAckReaction(env: Env, input: ReviewAckInput): Promise<ReviewAckResult>`
  - `function scheduleReviewAckReaction(env: Env, executionCtx: ExecutionContext | undefined, input: ReviewAckInput): void`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_cloudflare/review-ack-reaction.test.ts`. Add mocks at the TOP of the file (above the existing `describe`), then a new `describe`:

```ts
import { beforeEach, vi } from "vitest";

const mockPostIssueCommentReaction = vi.hoisted(() => vi.fn());
const mockPostReviewCommentReaction = vi.hoisted(() => vi.fn());
const mockGetPrReviewComments = vi.hoisted(() => vi.fn());
const mockCreateInstallationToken = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/github/issues", () => ({
  GITHUB_REVIEW_ACK_REACTION: "eyes",
  postIssueCommentReaction: (...a: unknown[]) => mockPostIssueCommentReaction(...a),
  postReviewCommentReaction: (...a: unknown[]) => mockPostReviewCommentReaction(...a),
}));
vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  getPrReviewComments: (...a: unknown[]) => mockGetPrReviewComments(...a),
}));
vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...a: unknown[]) => mockCreateInstallationToken(...a),
}));

describe("runReviewAckReaction", () => {
  const env = {} as import("../../apps/control-plane-worker/src/types").Env;

  beforeEach(() => {
    mockPostIssueCommentReaction.mockReset().mockResolvedValue(undefined);
    mockPostReviewCommentReaction.mockReset().mockResolvedValue(undefined);
    mockGetPrReviewComments.mockReset().mockResolvedValue([]);
    mockCreateInstallationToken.mockReset().mockResolvedValue("ghs_x");
  });

  it("reacts on a top-level issue comment", async () => {
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: { kind: "issue_comment", commentId: 111, body: "please fix" },
    });
    expect(mockPostIssueCommentReaction).toHaveBeenCalledWith(env, 7, "acme", "repo", 111, "eyes");
    expect(r).toEqual({ posted: 1, skipped: null, cappedFrom: null });
  });

  it("reacts on a single inline review comment", async () => {
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: { kind: "review_comment", commentId: 222, body: "nit" },
    });
    expect(mockPostReviewCommentReaction).toHaveBeenCalledWith(env, 7, "acme", "repo", 222, "eyes");
    expect(r).toEqual({ posted: 1, skipped: null, cappedFrom: null });
  });

  it("reacts on each inline comment of a review submission (pre-supplied)", async () => {
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: {
        kind: "review_submission",
        reviewId: 900,
        reviewBody: "",
        prNumber: 3,
        inlineComments: [
          { id: 1, reviewId: 900 },
          { id: 2, reviewId: 900 },
          { id: 3, reviewId: 999 },
        ],
      },
    });
    expect(mockGetPrReviewComments).not.toHaveBeenCalled();
    expect(mockPostReviewCommentReaction).toHaveBeenCalledTimes(2); // 3 belongs to a different review
    expect(r).toEqual({ posted: 2, skipped: null, cappedFrom: null });
  });

  it("fetches inline comments for a review submission when not pre-supplied", async () => {
    mockGetPrReviewComments.mockResolvedValue([
      { id: 5, reviewId: 900 },
      { id: 6, reviewId: 900 },
    ]);
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "greptile-apps[bot]",
      actorType: "Bot",
      surface: { kind: "review_submission", reviewId: 900, reviewBody: "", prNumber: 3 },
    });
    expect(mockCreateInstallationToken).toHaveBeenCalledWith(env, 7);
    expect(mockGetPrReviewComments).toHaveBeenCalledWith("ghs_x", "acme", "repo", 3);
    expect(r.posted).toBe(2);
  });

  it("caps inline fan-out at 50 and reports cappedFrom", async () => {
    const inlineComments = Array.from({ length: 63 }, (_, i) => ({ id: i + 1, reviewId: 900 }));
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: { kind: "review_submission", reviewId: 900, reviewBody: "", prNumber: 3, inlineComments },
    });
    expect(mockPostReviewCommentReaction).toHaveBeenCalledTimes(50);
    expect(r).toEqual({ posted: 50, skipped: null, cappedFrom: 63 });
  });

  it("skips (no post) for an owned author", async () => {
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: 7,
      owner: "acme",
      repo: "repo",
      actorLogin: "cycloid-qa[bot]",
      actorType: "Bot",
      surface: { kind: "issue_comment", commentId: 111, body: "app_breaks" },
    });
    expect(mockPostIssueCommentReaction).not.toHaveBeenCalled();
    expect(r).toEqual({ posted: 0, skipped: "owned", cappedFrom: null });
  });

  it("no-ops when installationId is null", async () => {
    const { runReviewAckReaction } = await import("../../apps/control-plane-worker/src/webhooks/review-ack-reaction");
    const r = await runReviewAckReaction(env, {
      installationId: null,
      owner: "acme",
      repo: "repo",
      actorLogin: "octocat",
      actorType: "User",
      surface: { kind: "issue_comment", commentId: 111, body: "x" },
    });
    expect(mockPostIssueCommentReaction).not.toHaveBeenCalled();
    expect(r).toEqual({ posted: 0, skipped: null, cappedFrom: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/review-ack-reaction.test.ts -t "runReviewAckReaction"`
Expected: FAIL — `runReviewAckReaction` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/control-plane-worker/src/webhooks/review-ack-reaction.ts` (add the new imports to the top import block, and the `log` after them):

```ts
import { createInstallationToken } from "../github/octokit";
import { GITHUB_REVIEW_ACK_REACTION, postIssueCommentReaction, postReviewCommentReaction } from "../github/issues";
import { getPrReviewComments } from "../github/pr";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger({ bindings: { component: "review-ack-reaction" } });

export const REVIEW_ACK_INLINE_CAP = 50;

export type ReviewAckSurface =
  | { kind: "issue_comment"; commentId: number; body: string | null }
  | { kind: "review_comment"; commentId: number; body: string | null }
  | {
      kind: "review_submission";
      reviewId: number | null;
      reviewBody: string | null;
      prNumber: number;
      // When the caller already fetched the review's inline comments (human loop), pass them to avoid a
      // second GET. Omitted (bot path) → fetched inside the deferred task and filtered to reviewId.
      inlineComments?: readonly { id: number | null; reviewId: number | null }[];
    };

export interface ReviewAckInput {
  installationId: number | null | undefined;
  owner: string;
  repo: string;
  actorLogin: string | null;
  actorType: string | null;
  surface: ReviewAckSurface;
}

export interface ReviewAckResult {
  posted: number;
  skipped: ReviewAckSkipReason | null;
  cappedFrom: number | null;
}

/** Awaitable core: resolve targets, apply the decision, cap, and post. Thrown errors propagate to the
 *  fire-and-forget wrapper's `.catch`. */
export async function runReviewAckReaction(env: Env, input: ReviewAckInput): Promise<ReviewAckResult> {
  const empty: ReviewAckResult = { posted: 0, skipped: null, cappedFrom: null };
  if (input.installationId == null) return empty;

  const bodyForDecision = input.surface.kind === "review_submission" ? input.surface.reviewBody : input.surface.body;
  const decision = decideReviewAckReaction({
    actorLogin: input.actorLogin,
    actorType: input.actorType,
    body: bodyForDecision,
  });
  if (!decision.react) return { posted: 0, skipped: decision.reason, cappedFrom: null };

  if (input.surface.kind === "issue_comment") {
    await postIssueCommentReaction(
      env,
      input.installationId,
      input.owner,
      input.repo,
      input.surface.commentId,
      GITHUB_REVIEW_ACK_REACTION,
    );
    return { posted: 1, skipped: null, cappedFrom: null };
  }
  if (input.surface.kind === "review_comment") {
    await postReviewCommentReaction(
      env,
      input.installationId,
      input.owner,
      input.repo,
      input.surface.commentId,
      GITHUB_REVIEW_ACK_REACTION,
    );
    return { posted: 1, skipped: null, cappedFrom: null };
  }

  // review_submission: resolve the review's inline comments, then react to each (capped).
  const reviewId = input.surface.reviewId;
  const all =
    input.surface.inlineComments ??
    (await getPrReviewComments(
      await createInstallationToken(env, input.installationId),
      input.owner,
      input.repo,
      input.surface.prNumber,
    ));
  const ids = Array.from(
    new Set(all.filter((c) => c.id != null && c.reviewId === reviewId).map((c) => c.id as number)),
  );
  const capped = ids.slice(0, REVIEW_ACK_INLINE_CAP);
  const cappedFrom = ids.length > REVIEW_ACK_INLINE_CAP ? ids.length : null;
  if (cappedFrom !== null) {
    log.warn(
      { owner: input.owner, repo: input.repo, reviewId, total: ids.length, cap: REVIEW_ACK_INLINE_CAP },
      "Capping review ack 👀 reactions to the inline fan-out limit",
    );
  }
  for (const commentId of capped) {
    await postReviewCommentReaction(
      env,
      input.installationId,
      input.owner,
      input.repo,
      commentId,
      GITHUB_REVIEW_ACK_REACTION,
    );
  }
  return { posted: capped.length, skipped: null, cappedFrom };
}

/** Fire-and-forget: never awaited on the response path, never throws into ingest. */
export function scheduleReviewAckReaction(
  env: Env,
  executionCtx: ExecutionContext | undefined,
  input: ReviewAckInput,
): void {
  const task = runReviewAckReaction(env, input).catch((err) => {
    log.warn(
      {
        error: String(err),
        owner: input.owner,
        repo: input.repo,
        surface: input.surface.kind,
        actorLogin: input.actorLogin,
      },
      "Failed to post review ack 👀 reaction",
    );
  });
  if (executionCtx) executionCtx.waitUntil(task);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/test_cloudflare/review-ack-reaction.test.ts`
Expected: PASS (both `describe` blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/webhooks/review-ack-reaction.ts tests/test_cloudflare/review-ack-reaction.test.ts
git commit -m "feat(review-ack): fire-and-forget reaction scheduler with inline fan-out cap"
```

---

### Task 4: Wire the scheduler into the three webhook handlers

Call `scheduleReviewAckReaction` at each of the four `{ status: "handled" }` sites: issue-comment, inline review-comment, human review loop (once per review), bot review.

**Files:**

- Modify: `apps/control-plane-worker/src/webhooks/github.ts`
  - import (near line 53, next to the existing `pr-review-bots` import)
  - `handleIssueCommentEvent` handled block (~line 1556)
  - `handlePullRequestReviewCommentEvent` handled block (~line 2371)
  - `handlePullRequestReviewEventHumanLoop` after `perSessionResults` (~line 2699)
  - `handlePullRequestReviewEvent` bot handled block (~line 2880)
- Test: `tests/test_cloudflare/github-pr-review-webhook.test.ts`, `tests/test_cloudflare/github-issue-comment-webhook.test.ts`

**Interfaces:**

- Consumes: `scheduleReviewAckReaction` (`./review-ack-reaction`), and the handler-local variables already in scope at each site (confirmed below).

- [ ] **Step 1: Write the failing integration test (wiring)**

In `tests/test_cloudflare/github-pr-review-webhook.test.ts`, add a hoisted mock for the ack module and assert the wiring. Add near the other `vi.hoisted` mocks at the top:

```ts
const mockScheduleReviewAckReaction = vi.hoisted(() => vi.fn());
vi.mock("../../apps/control-plane-worker/src/webhooks/review-ack-reaction", () => ({
  scheduleReviewAckReaction: (...a: unknown[]) => mockScheduleReviewAckReaction(...a),
}));
```

Then add (adapt the surrounding `describe`/`beforeEach` — reset the mock in `beforeEach`, and reuse the file's existing signed-request + `mockIngestReviewLoopPullRequestReviewWebhook` helpers):

```ts
it("schedules a 👀 ack when a bot review is ingested (handled)", async () => {
  mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValue({
    status: "handled",
    epoch: { id: "ep_1", status: "collecting" },
  });
  const payload = buildGithubPullRequestReviewPayload({
    action: "submitted",
    reviewId: 900,
    reviewBody: "Found a bug",
    userLogin: "greptile-apps[bot]",
    userType: "Bot",
  });
  const req = await makeSignedGithubRequest("pull_request_review", payload);
  await worker.fetch(req, env, ctx); // use the file's existing worker/env/ctx harness

  expect(mockScheduleReviewAckReaction).toHaveBeenCalledTimes(1);
  const arg = mockScheduleReviewAckReaction.mock.calls[0]?.[2];
  expect(arg).toMatchObject({ surface: { kind: "review_submission", reviewId: 900 } });
});

it("does NOT schedule a 👀 ack when the review is ignored (stale_head)", async () => {
  mockIngestReviewLoopPullRequestReviewWebhook.mockResolvedValue({ status: "ignored", reason: "stale_head" });
  const payload = buildGithubPullRequestReviewPayload({
    action: "submitted",
    reviewId: 901,
    userLogin: "greptile-apps[bot]",
    userType: "Bot",
  });
  const req = await makeSignedGithubRequest("pull_request_review", payload);
  await worker.fetch(req, env, ctx);

  expect(mockScheduleReviewAckReaction).not.toHaveBeenCalled();
});
```

NOTE: Match the exact fixture-builder field names in `buildGithubPullRequestReviewPayload` (`./github-webhook-fixtures`) and the file's existing worker-invocation pattern — read the top of the test file first and mirror how other `it(...)` cases drive the handler and what the harness variables are named.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/test_cloudflare/github-pr-review-webhook.test.ts -t "👀 ack"`
Expected: FAIL — `mockScheduleReviewAckReaction` never called (not wired yet).

- [ ] **Step 3: Wire the four call sites**

Add the import in `apps/control-plane-worker/src/webhooks/github.ts` (next to the `pr-review-bots` import at line 53):

```ts
import { scheduleReviewAckReaction } from "./review-ack-reaction";
```

**Site A — `handleIssueCommentEvent`** (~line 1556). Inside the existing `if (result.status === "handled") { ... }` block, before its `return jsonResponse(...)`:

```ts
scheduleReviewAckReaction(env, ctx, {
  installationId: parsed.details.installationId,
  owner: parsed.details.repoOwner,
  repo: parsed.details.repoName,
  actorLogin: parsed.details.senderLogin,
  actorType: parsed.details.senderType,
  surface: { kind: "issue_comment", commentId: parsed.details.commentId, body: parsed.details.commentBody ?? null },
});
```

**Site B — `handlePullRequestReviewCommentEvent`** (~line 2371). Inside the existing `if (result.status === "handled") { ... }` block, before its `return`:

```ts
scheduleReviewAckReaction(env, ctx, {
  installationId,
  owner: repoOwner,
  repo: repoName,
  actorLogin: commentAuthor,
  actorType: commentUserType,
  surface: { kind: "review_comment", commentId, body: commentBody ?? null },
});
```

**Site C — `handlePullRequestReviewEventHumanLoop`** (~line 2699). Immediately AFTER the `const perSessionResults = await Promise.all(...)` block closes (line 2699), before the "Summarize results" section:

```ts
// 👀 acknowledge the human review ONCE (not per session) when at least one session ingested it.
if (perSessionResults.some((r) => r.status === "ingest_handled")) {
  scheduleReviewAckReaction(env, ctx, {
    installationId: f.installationId,
    owner: f.repoOwner!,
    repo: f.repoName!,
    actorLogin: f.reviewAuthor,
    actorType: f.reviewUserType,
    surface: {
      kind: "review_submission",
      reviewId: f.reviewId,
      reviewBody: f.reviewBody,
      prNumber: f.prNumber!,
      inlineComments: triggeringReviewComments,
    },
  });
}
```

**Site D — `handlePullRequestReviewEvent`** bot path (~line 2880). Inside the existing `if (result.status === "handled") { ... }` block, before its `return`:

```ts
scheduleReviewAckReaction(env, ctx, {
  installationId: f.installationId,
  owner: f.repoOwner,
  repo: f.repoName,
  actorLogin: f.reviewAuthor,
  actorType: f.reviewUserType,
  surface: { kind: "review_submission", reviewId: f.reviewId, reviewBody: f.reviewBody, prNumber: f.prNumber },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/test_cloudflare/github-pr-review-webhook.test.ts tests/test_cloudflare/github-issue-comment-webhook.test.ts`
Expected: PASS. If the issue-comment test file needs the same mock, add the identical `vi.hoisted` + `vi.mock` block and a `handled → scheduled` / `ignored → not scheduled` pair mirroring the review test.

- [ ] **Step 5: Typecheck + full control-plane suite**

Run: `npm run -w apps/control-plane-worker typecheck` (or the repo's typecheck script) and `npx vitest run tests/test_cloudflare/review-ack-reaction.test.ts tests/test_cloudflare/github/issues.test.ts tests/test_cloudflare/github-pr-review-webhook.test.ts`
Expected: no type errors; all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane-worker/src/webhooks/github.ts tests/test_cloudflare/github-pr-review-webhook.test.ts tests/test_cloudflare/github-issue-comment-webhook.test.ts
git commit -m "feat(review-ack): 👀 reaction on every accepted PR review (human + bot)"
```

---

## Self-Review (completed against the spec)

**Spec coverage:**

- 👀 on review's comments, per surface → Task 1 (endpoint) + Task 3 (per-surface targets) + Task 4 (wiring). ✓
- Fires only on `handled` → Task 4 sites are inside `status === "handled"` blocks. ✓
- Human + bot; exclude Cycloid-owned (incl. `cycloid-qa[bot]` carve-out) → Task 2 owned check + tests. ✓
- Known-bot no-findings / in-progress suppressed → Task 2 via `classifyReviewLoopNoise` + tests. ✓
- Every inline comment, cap 50 + warn → Task 3 cap + test. ✓
- Summary-only review (no inline comments) → no target → `posted: 0`, no error (Task 3 fetch/filter yields empty). Accepted gap. ✓
- Fire-and-forget, natural idempotency, no D1 table → Task 3 `scheduleReviewAckReaction`. ✓
- Once per review on the multi-session human path → Task 4 Site C `some(... "ingest_handled")`. ✓

**Placeholder scan:** none — every step has concrete code/commands. Two "confirm the exact alias / fixture field names" notes are verification instructions, not placeholders (the registry alias and fixture builder are pre-existing; the implementer substitutes the real identifier).

**Type consistency:** `decideReviewAckReaction` return (`{ react: true } | { react: false; reason }`), `ReviewAckInput`, `ReviewAckResult`, `REVIEW_ACK_INLINE_CAP`, and `GITHUB_REVIEW_ACK_REACTION` are used identically across Tasks 2–4. `installationId: number | null | undefined` no-op path matches the issue-comment site where `parsed.details.installationId` is `number | null`.

## Out of scope

- No fallback signal for summary-only reviews (accepted).
- No `pr_review_response_operations` ack row (natural idempotency suffices).
- No telemetry counter in v1 (spec-optional; add later if adoption/gap sizing is wanted).
