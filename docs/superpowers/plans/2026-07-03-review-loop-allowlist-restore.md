# Review-loop bot-ingest allow-list restore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the review loop ingesting non-reviewer GitHub App comments (e.g. `linear[bot]` linkbacks) as actionable feedback by inverting the D3 "admit any bot" fallback into an allow-list gated on the known-reviewer registry + user-configured customs.

**Architecture:** Single-chokepoint change in `resolveIngestBotKey` (`apps/control-plane-worker/src/github/pr-review-bots.ts`) — the function all three webhook ingest paths and the worklist builder funnel through. An unconfigured author is admitted only if it is a known-registry review bot (respond-only, keyed `known:<id>`); everything else is dropped `actor_not_configured_bot`. Copilot is added to the registry so a genuine unlisted reviewer is caught by default. Cycloid-owned bots stay excluded (QA verdicts flow via the FSM `verification.*` spine, not comment ingest). No LLM, no DB table, no migration.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest (`tests/test_cloudflare/**`), D1 (unchanged), Datadog structured events.

**Spec:** `docs/superpowers/specs/2026-07-03-review-loop-allowlist-restore-design.md`

## Global Constraints

- **Every commit message** ends with these two trailers (verbatim):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01EAhKEe8tHFrfNfXNDjsHV6
  ```
- **New/changed logic ships with tests in the same PR** (repo rule).
- **No DB migration, no new dependency, no LLM call, no new config flag.**
- **Cycloid-owned bots (`cycloid[bot]`, `cycloid-dev[bot]`, `cycloid-staging[bot]`, `cycloid-qa[bot]`) MUST remain excluded** from ingest — do not add them to any allow-list.
- **Verify locally per branch** (stacked PRs skip full CI until on main): `npx vitest run tests/test_cloudflare/<file> --maxWorkers=2`, plus `npm run typecheck` and `npx eslint .` on changed files before each commit.
- **Fail toward keeping real feedback:** the allow-list may only ever drop an actor that is neither a known-registry reviewer nor user-configured.

---

## File Structure

- `apps/control-plane-worker/src/github/pr-review-bots.ts` — **Modify.** Add reverse alias→id map + `knownReviewBotIdForActorLogin` helper; rewrite `resolveIngestBotKey` fallback to allow-list. (Task 1)
- `tests/test_cloudflare/pr-review-bots-owned-actors.test.ts` — **Modify.** Update the `resolveIngestBotKey` D3 tests to allow-list behavior. (Task 1)
- `apps/control-plane-worker/src/observability/review-loop-events.ts` — **Modify.** Add optional `actorLogin` log field to `emitReviewLoopIngestOutcomeEvent`. (Task 2)
- `apps/control-plane-worker/src/services/review-loop-epochs.ts` — **Modify.** Thread `actorLogin` into `emitReviewLoopWebhookIngestOutcome` from the three bot ingest fns. (Task 2)
- `tests/test_cloudflare/review-loop-webhook-service.test.ts` — **Modify.** Rename the D3 "any bot" test; add `linear[bot]`-dropped + `github-actions[bot]`-dropped regressions. (Task 3)
- `shared/constants/pr-review-bots.ts` — **Modify.** Add `copilot` id + label. (Task 4)
- `apps/control-plane-worker/src/github/pr-review-bots.ts` — **Modify.** Add `copilot` capability entry. (Task 4)
- `docs/review-loop.md`, `docs/debugging-runbook.md` — **Modify.** Allow-list FAQ + debugging signpost. (Task 5)

---

## Task 1: Allow-list gate in `resolveIngestBotKey`

**Files:**

- Modify: `apps/control-plane-worker/src/github/pr-review-bots.ts`
- Test: `tests/test_cloudflare/pr-review-bots-owned-actors.test.ts`

**Interfaces:**

- Produces: `knownReviewBotIdForActorLogin(login: string | null | undefined): PrReviewKnownBotId | null` (exported).
- Changes: `resolveIngestBotKey(...)` — for an unconfigured author, now returns `{ key: "known:<id>", configured: false }` when the login is a known-registry alias, else `null`. (Signature unchanged.)

- [ ] **Step 1: Update the failing unit tests** in `tests/test_cloudflare/pr-review-bots-owned-actors.test.ts`. Replace the `describe("resolveIngestBotKey (D3 content-based ingest)")` block (lines ~112-160) with:

```typescript
describe("resolveIngestBotKey (allow-list ingest)", () => {
  const greptile: PrReviewExpectedBot = { type: "known", id: "greptile" };

  it("returns the configured allowlist key for a configured bot", () => {
    expect(
      resolveIngestBotKey({
        expectedBots: [greptile],
        actorLogin: "greptile-apps[bot]",
        actorType: "Bot",
        signal: "activity",
      }),
    ).toEqual({ key: "known:greptile", configured: true });
  });

  it("admits an UNCONFIGURED but KNOWN-registry reviewer respond-only (known:<id>, configured:false)", () => {
    // cursor-bugbot is a known review bot but NOT in this repo's expected list. It is still ingested so a
    // drive-by review is addressed — respond-only, and keyed known:<id> so the D4 noise gate can act on it.
    for (const signal of ["review_submission", "activity", "issue_comment_final"] as const) {
      expect(
        resolveIngestBotKey({ expectedBots: [greptile], actorLogin: "cursor[bot]", actorType: "Bot", signal }),
      ).toEqual({ key: "known:cursor-bugbot", configured: false });
    }
  });

  it("DROPS an unlisted non-reviewer bot (allow-list restore of #6558)", () => {
    // linear[bot] linkbacks + CI/deploy/status bots are not reviewers → dropped (returns null → the caller
    // reports actor_not_configured_bot). This is the regression fix.
    for (const login of ["linear[bot]", "github-actions[bot]", "codecov[bot]", "vercel[bot]", "some-reviewer[bot]"]) {
      for (const signal of ["review_submission", "activity", "issue_comment_final"] as const) {
        expect(
          resolveIngestBotKey({ expectedBots: [greptile], actorLogin: login, actorType: "Bot", signal }),
        ).toBeNull();
      }
    }
  });

  it("does NOT fall back for terminal signals (check_run/commit_status stay allowlist-only)", () => {
    for (const signal of ["check_run", "commit_status"] as const) {
      expect(
        resolveIngestBotKey({ expectedBots: [greptile], actorLogin: "cursor[bot]", actorType: "Bot", signal }),
      ).toBeNull();
    }
  });

  it("never ingests Cycloid-owned actors, non-bot authors, or empty logins", () => {
    expect(
      resolveIngestBotKey({
        expectedBots: [greptile],
        actorLogin: "cycloid[bot]",
        actorType: "Bot",
        signal: "activity",
      }),
    ).toBeNull();
    expect(
      resolveIngestBotKey({
        expectedBots: [greptile],
        actorLogin: "cycloid-qa[bot]",
        actorType: "Bot",
        signal: "activity",
      }),
    ).toBeNull();
    expect(
      resolveIngestBotKey({ expectedBots: [greptile], actorLogin: "alice", actorType: "User", signal: "activity" }),
    ).toBeNull();
    expect(
      resolveIngestBotKey({ expectedBots: [greptile], actorLogin: "", actorType: "Bot", signal: "activity" }),
    ).toBeNull();
  });
});

describe("knownReviewBotIdForActorLogin", () => {
  it("maps a known-registry alias login (with or without [bot]) to its id, else null", () => {
    expect(knownReviewBotIdForActorLogin("cursor[bot]")).toBe("cursor-bugbot");
    expect(knownReviewBotIdForActorLogin("greptile-apps")).toBe("greptile");
    expect(knownReviewBotIdForActorLogin("linear[bot]")).toBeNull();
    expect(knownReviewBotIdForActorLogin("")).toBeNull();
    expect(knownReviewBotIdForActorLogin(null)).toBeNull();
  });
});
```

Also add `knownReviewBotIdForActorLogin` to the import block at the top of the test file (from `../../apps/control-plane-worker/src/github/pr-review-bots`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/test_cloudflare/pr-review-bots-owned-actors.test.ts --maxWorkers=2`
Expected: FAIL — `knownReviewBotIdForActorLogin` is not exported; the "DROPS an unlisted non-reviewer bot" and "known:<id>" cases fail against the current `custom:<login>` fallback.

- [ ] **Step 3: Add the reverse alias→id map + helper** in `apps/control-plane-worker/src/github/pr-review-bots.ts`, immediately after the `PR_REVIEW_BOT_ACTOR_ALIAS_LOGINS` definition (~line 79):

```typescript
/** Reverse index: a known review bot's normalized alias login → its bot id. Built from the registry. */
const KNOWN_REVIEW_BOT_ID_BY_ACTOR_ALIAS: ReadonlyMap<string, PrReviewKnownBotId> = new Map(
  Object.values(PR_REVIEW_BOT_CAPABILITIES).flatMap((capability) =>
    capability.actorAliases.map((alias) => [normalizeGitHubActorLogin(alias), capability.id] as const),
  ),
);

/**
 * The known review bot id whose registry alias matches this actor login, or null. Lets ingest admit an
 * unconfigured-but-known reviewer under its `known:<id>` key (respond-only) so the D4 noise gate — which
 * only fires on `known:` keys — can still gate that reviewer's no-findings output.
 */
export function knownReviewBotIdForActorLogin(login: string | null | undefined): PrReviewKnownBotId | null {
  if (!login) return null;
  return KNOWN_REVIEW_BOT_ID_BY_ACTOR_ALIAS.get(normalizeGitHubActorLogin(login)) ?? null;
}
```

- [ ] **Step 4: Rewrite the `resolveIngestBotKey` fallback** in the same file. Replace the final block (from `if (!UNLISTED_INGEST_SIGNALS.has(params.signal)) return null;` through `return { key: \`custom:${normalizedActor}\`, configured: false };`) with:

```typescript
// Allow-list posture (fixes #6558's admit-any-bot regression): an UNCONFIGURED author is ingested ONLY
// if it is a known-registry review bot — respond-only (configured:false, never a no-show-latch terminal).
// Keyed known:<id> (not custom:<login>) so the D4 noise gate, which only fires on known: keys, still gates
// a known reviewer's no-findings output. Every non-registry bot (linear[bot] linkbacks, github-actions,
// codecov, vercel/netlify deploy previews, graphite-app, changeset-bot, ...) is NOT a reviewer and is
// dropped as actor_not_configured_bot. QA/verifier verdicts do NOT arrive here — they flow via the FSM
// verification.* spine. See docs/review-loop.md + docs/debugging-runbook.md.
if (!UNLISTED_INGEST_SIGNALS.has(params.signal)) return null;
if (!params.actorLogin || !isBotOrAppAuthor(params.actorType)) return null;
const normalizedActor = normalizeGitHubActorLogin(params.actorLogin);
if (ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizedActor)) return null;
const knownId = knownReviewBotIdForActorLogin(normalizedActor);
if (!knownId) return null;
return { key: `known:${knownId}`, configured: false };
```

Also update the `resolveIngestBotKey` JSDoc (~lines 146-154) to describe the allow-list behavior instead of "any unlisted bot's SUBSTANTIVE content is still ingested."

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/test_cloudflare/pr-review-bots-owned-actors.test.ts --maxWorkers=2`
Expected: PASS.

- [ ] **Step 6: Run the full ingest/worklist test surface to catch fallout**

Run: `npx vitest run tests/test_cloudflare/review-loop-worklist.test.ts tests/test_cloudflare/review-loop-sweep.test.ts tests/test_cloudflare/github-pr-review-webhook.test.ts --maxWorkers=2`
Expected: PASS. `review-loop-worklist.test.ts:837` uses `coderabbitai[bot]` (a known bot) so it still resolves (now `known:coderabbit`, respond-only) — if any assertion hard-codes a `custom:` key for a **known** bot, update it to `known:<id>`. If any test asserts a **non-registry** bot is ingested, that assertion is now wrong by design — change it to expect a drop and note the allow-list in a comment.

- [ ] **Step 7: Typecheck + lint, then commit**

Run: `npm run typecheck && npx eslint apps/control-plane-worker/src/github/pr-review-bots.ts tests/test_cloudflare/pr-review-bots-owned-actors.test.ts`

```bash
git add apps/control-plane-worker/src/github/pr-review-bots.ts tests/test_cloudflare/pr-review-bots-owned-actors.test.ts
git commit  # message below
```

Message:

```
fix(review-loop): gate bot ingest to an allow-list, dropping non-reviewer bots

resolveIngestBotKey's D3 fallback admitted any non-Cycloid GitHub App
(linear[bot] linkbacks, github-actions, codecov, deploy-preview bots), which
minted review epochs + verdict-replies for pure metadata (#6558 regression).
Admit an unconfigured author only if it is a known-registry review bot
(respond-only, keyed known:<id> so the noise gate still applies); drop the rest
as actor_not_configured_bot.

<trailers>
```

---

## Task 2: `actor_login` telemetry breadcrumb

**Files:**

- Modify: `apps/control-plane-worker/src/observability/review-loop-events.ts`
- Modify: `apps/control-plane-worker/src/services/review-loop-epochs.ts`
- Test: `tests/test_cloudflare/review-loop-webhook-service.test.ts` (assertion added in Task 3; this task is covered by the emitter's existing observability tests)

**Interfaces:**

- Changes: `emitReviewLoopIngestOutcomeEvent(env, fields)` — `fields` gains optional `actorLogin?: string | null`, emitted as log field `actor_login` (log-only drill-down, NOT a metric group_by).
- Changes: `emitReviewLoopWebhookIngestOutcome(env, result, input)` — `input` gains optional `actorLogin?: string | null`, forwarded to the event.

- [ ] **Step 1: Add the `actorLogin` field to the event emitter.** In `apps/control-plane-worker/src/observability/review-loop-events.ts`, update `emitReviewLoopIngestOutcomeEvent` (~line 250):

```typescript
export async function emitReviewLoopIngestOutcomeEvent(
  env: EmitEnv,
  fields: {
    sourceKind: string;
    outcome: "handled" | "ignored";
    reason: string | null;
    repo: string;
    ownerUserId: number | null;
    sessionId: string | null;
    prUrl: string;
    actorLogin?: string | null;
  },
): Promise<void> {
  await postStructuredEventToDd(env, {
    event: "review_loop.ingest.outcome",
    source_kind: fields.sourceKind,
    outcome: fields.outcome,
    reason: fields.reason ?? "none",
    repo: fields.repo,
    owner_user_id: fields.ownerUserId,
    session_id: fields.sessionId,
    pr_url: fields.prUrl,
    // Log-only drill-down (NOT a metric group_by — unbounded cardinality): names the actor so an
    // `ignored: actor_not_configured_bot` drop is diagnosable ("dropped X — not a recognized reviewer").
    actor_login: fields.actorLogin ?? null,
  });
}
```

- [ ] **Step 2: Thread `actorLogin` through `emitReviewLoopWebhookIngestOutcome`.** In `apps/control-plane-worker/src/services/review-loop-epochs.ts` (~line 2380):

```typescript
async function emitReviewLoopWebhookIngestOutcome(
  env: Env,
  result: ReviewLoopWebhookIngestResult,
  input: { sourceKind: string; repoOwner: string; repoName: string; prUrl: string; actorLogin?: string | null },
): Promise<void> {
  await emitReviewLoopIngestOutcomeEvent(env, {
    sourceKind: input.sourceKind,
    outcome: result.status,
    reason: result.status === "ignored" ? result.reason : null,
    repo: `${input.repoOwner}/${input.repoName}`,
    ownerUserId: result.status === "handled" ? result.epoch.ownerUserId : null,
    sessionId: result.status === "handled" ? result.epoch.sessionId : null,
    prUrl: input.prUrl,
    actorLogin: input.actorLogin ?? null,
  });
}
```

- [ ] **Step 3: Pass `actorLogin` from the three bot-content ingest fns.** In `apps/control-plane-worker/src/services/review-loop-epochs.ts`, each of the three calls to `emitReviewLoopWebhookIngestOutcome` inside `ingestReviewLoopPullRequestReviewWebhook`, `ingestReviewLoopPullRequestReviewCommentWebhook`, and `ingestReviewLoopPrIssueCommentWebhook` currently passes `{ sourceKind, repoOwner, repoName, prUrl }`. Add `actorLogin: input.actorLogin` to each of those three call sites. (Leave the CI/check-run/commit-status call sites unchanged.)

- [ ] **Step 4: Typecheck + lint, then commit**

Run: `npm run typecheck && npx eslint apps/control-plane-worker/src/observability/review-loop-events.ts apps/control-plane-worker/src/services/review-loop-epochs.ts`

```bash
git add apps/control-plane-worker/src/observability/review-loop-events.ts apps/control-plane-worker/src/services/review-loop-epochs.ts
git commit  # message below
```

Message:

```
feat(review-loop): log dropped actor_login on ingest outcome

Adds actor_login to the review_loop.ingest.outcome event (log-only) so an
`ignored: actor_not_configured_bot` drop names the reviewer that was gated —
the diagnostic breadcrumb for "why isn't reviewer X being addressed?".

<trailers>
```

---

## Task 3: Service-level ingest regression (linear dropped, known-unconfigured admitted)

**Files:**

- Test: `tests/test_cloudflare/review-loop-webhook-service.test.ts`

**Interfaces:**

- Consumes: `service.ingestReviewLoopPrIssueCommentWebhook(...)` (existing), `pr_review_response_epochs` table (existing).

- [ ] **Step 1: Rewrite the D3 "any bot" test** at `tests/test_cloudflare/review-loop-webhook-service.test.ts:527`. Rename it and update the comment; keep the `cursor[bot]` actor (a known bot, still admitted respond-only) and add a botKey assertion:

```typescript
it("admits an unconfigured KNOWN reviewer at the first bound session, respond-only (allow-list)", async () => {
  mockListSessionIdsByWebhookRef.mockResolvedValue(["s-unconfigured", "s-current"]);
  mockGetSessionState.mockImplementation((_env: unknown, sessionId: string) =>
    Promise.resolve(session({ sessionId, ownerUserId: sessionId === "s-unconfigured" ? "102" : "101" })),
  );
  mockGetUserPrReviewBotSettingsByUserIds.mockResolvedValue(
    botSettingsByUserId([
      [
        102,
        {
          expectedBots: [{ type: "known", id: "greptile" }],
          expectedBotsHash: "greptile-hash",
          ciResponseEnabled: true,
          reviewTimeoutMinutes: 10,
        },
      ],
      [
        101,
        {
          expectedBots: [{ type: "known", id: "cursor-bugbot" }],
          expectedBotsHash: "settings-hash",
          ciResponseEnabled: true,
          reviewTimeoutMinutes: 10,
        },
      ],
    ]),
  );

  const result = await service.ingestReviewLoopPrIssueCommentWebhook({
    env: { DB: db } as never,
    deliveryId: "delivery-5",
    sourceId: "comment:9005",
    commentId: 9005,
    commentBody: "new activity",
    actorLogin: "cursor[bot]", // a KNOWN reviewer, not in s-unconfigured's expected list
    actorType: "Bot",
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 42,
    prUrl: "https://github.com/acme/repo/pull/42",
  });

  expect(result.status).toBe("handled");
  // Known reviewer admitted respond-only under known:<id> (NOT a custom: key), keyed to the first bound
  // session (a PR is 1:1 with a session in production).
  expect(result.epoch?.sessionId).toBe("s-unconfigured");
  expect(result.epoch?.status).toBe("collecting");
});
```

- [ ] **Step 2: Add the linkback-drop regression** immediately after that test:

```typescript
it("DROPS a non-reviewer bot's PR issue comment (linear[bot] linkback) — the #6558 fix", async () => {
  setBatchedBotSettings({
    expectedBots: [{ type: "known", id: "greptile" }],
    expectedBotsHash: "greptile-hash",
    ciResponseEnabled: true,
    reviewTimeoutMinutes: 10,
  });

  const result = await service.ingestReviewLoopPrIssueCommentWebhook({
    env: { DB: db } as never,
    deliveryId: "delivery-linear",
    sourceId: "issue-comment:9200",
    commentId: 9200,
    commentBody: "<!-- linear-linkback --> ARC-1386 …",
    actorLogin: "linear[bot]",
    actorType: "Bot",
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 42,
    prUrl: "https://github.com/acme/repo/pull/42",
  });

  expect(result.status).toBe("ignored");
  expect(result.status === "ignored" && result.reason).toBe("actor_not_configured_bot");
  const row = sqlite.prepare("SELECT COUNT(*) AS count FROM pr_review_response_epochs").get() as { count: number };
  expect(row.count).toBe(0);
});
```

Note: mirror the existing epoch-count assertion at line ~435 for the `sqlite` handle name; use `setBatchedBotSettings` (single-session path) exactly as the test at line 491 does. If `github-actions[bot]` coverage is cheap to add in the same style, add a second drop case for it.

- [ ] **Step 3: Run the service test**

Run: `npx vitest run tests/test_cloudflare/review-loop-webhook-service.test.ts --maxWorkers=2`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/test_cloudflare/review-loop-webhook-service.test.ts
git commit  # message below
```

Message:

```
test(review-loop): pin linkback drop + known-unconfigured admit at ingest

<trailers>
```

---

## Task 4: Seed Copilot into the known-reviewer registry

**Files:**

- Modify: `shared/constants/pr-review-bots.ts`
- Modify: `apps/control-plane-worker/src/github/pr-review-bots.ts`
- Test: `tests/test_cloudflare/pr-review-bots-owned-actors.test.ts` (extend)

**Interfaces:**

- Changes: `PR_REVIEW_BOT_IDS` gains `"copilot"`; `PrReviewKnownBotId` widens; `PR_REVIEW_BOT_CAPABILITIES` gains a `copilot` entry.

- [ ] **Step 1: Verify Copilot's exact PR-review author login + signal.** Find a real GitHub Copilot code-review on any accessible repo and confirm the review author login and that it posts a `pull_request_review` (review submission):

Run: `gh api graphql -f query='{ search(query: "is:pr reviewed-by:copilot-pull-request-reviewer", type: ISSUE, first: 1) { nodes { ... on PullRequest { reviews(first: 5) { nodes { author { login } state } } } } } }'`
Expected: an author login of `copilot-pull-request-reviewer` (the `[bot]` suffix is stripped by GraphQL). If the real login differs, use the confirmed value in Step 3's `actorAliases`. If Copilot posts via check-run rather than a review in the sample, keep `terminalSignals: ["review_submission"]` anyway (review is its primary signal) and note the finding in the commit body.

- [ ] **Step 2: Write the failing registry test.** Append to `tests/test_cloudflare/pr-review-bots-owned-actors.test.ts`:

```typescript
describe("copilot registry seed", () => {
  it("recognizes GitHub Copilot review as a known reviewer, ingested respond-only when unconfigured", () => {
    expect(knownReviewBotIdForActorLogin("copilot-pull-request-reviewer[bot]")).toBe("copilot");
    expect(
      resolveIngestBotKey({
        expectedBots: [{ type: "known", id: "greptile" }],
        actorLogin: "copilot-pull-request-reviewer[bot]",
        actorType: "Bot",
        signal: "review_submission",
      }),
    ).toEqual({ key: "known:copilot", configured: false });
  });
});
```

- [ ] **Step 3: Run to verify failure, then add Copilot to the registry.**

Run: `npx vitest run tests/test_cloudflare/pr-review-bots-owned-actors.test.ts --maxWorkers=2`
Expected: FAIL (`copilot` not a known id).

In `shared/constants/pr-review-bots.ts`:

```typescript
export const PR_REVIEW_BOT_IDS = [
  "greptile",
  "coderabbit",
  "cursor-bugbot",
  "chatgpt-codex",
  "strix",
  "copilot",
] as const;
```

and add to `PR_REVIEW_BOT_LABELS`:

```typescript
  copilot: "GitHub Copilot",
```

In `apps/control-plane-worker/src/github/pr-review-bots.ts`, add to `PR_REVIEW_BOT_CAPABILITIES`:

```typescript
  copilot: {
    id: "copilot",
    actorAliases: ["copilot-pull-request-reviewer[bot]"],
    reviewCapable: true,
    terminalSignals: ["review_submission"],
  },
```

- [ ] **Step 4: Run to verify pass + registry fallout.**

Run: `npx vitest run tests/test_cloudflare/pr-review-bots-owned-actors.test.ts tests/test_cloudflare/pr-review-bot-settings-routes.test.ts --maxWorkers=2`
Expected: PASS. If any test hard-codes the 5-bot id list (e.g. a settings-options snapshot), update it to include `copilot`.

- [ ] **Step 5: Typecheck (widened `PrReviewKnownBotId` must be exhaustive everywhere) + lint, then commit.**

Run: `npm run typecheck && npx eslint shared/constants/pr-review-bots.ts apps/control-plane-worker/src/github/pr-review-bots.ts`
Expected: PASS. `npm run typecheck` will flag any `Record<PrReviewKnownBotId, …>` that now needs a `copilot` entry — add it where required.

```bash
git add shared/constants/pr-review-bots.ts apps/control-plane-worker/src/github/pr-review-bots.ts tests/test_cloudflare/pr-review-bots-owned-actors.test.ts
git commit  # message below
```

Message:

```
feat(review-loop): add GitHub Copilot to the known-reviewer registry

Copilot code review is a genuine unlisted reviewer; seed it so its reviews are
ingested by default (respond-only when a repo hasn't configured it), while the
allow-list keeps dropping non-reviewer bots.

<trailers>
```

---

## Task 5: Docs + debugging signpost

**Files:**

- Modify: `docs/review-loop.md`
- Modify: `docs/debugging-runbook.md`

- [ ] **Step 1: Update the review-loop FAQ.** In `docs/review-loop.md`, replace the answer under **"Will it respond to every comment on the PR?"** with a precise allow-list statement:

```markdown
### Will it respond to every comment on the PR?

No. The loop ingests a comment/review **only** from a recognized reviewer: a known review bot
(Greptile, CodeRabbit, Cursor, ChatGPT Codex, Strix, GitHub Copilot) or a custom reviewer you
configured for the repo. Every other bot — Linear linkbacks, `github-actions`, coverage/deploy/status
apps, Graphite stack comments — is dropped (`actor_not_configured_bot`), so ordinary PR chatter never
restarts the loop. The admission gate is `resolveIngestBotKey` + `PR_REVIEW_BOT_CAPABILITIES` in
`apps/control-plane-worker/src/github/pr-review-bots.ts`. QA/verifier verdicts do **not** come through
this gate — they arrive via the FSM `verification.*` spine.
```

- [ ] **Step 2: Add the debugging signpost.** In `docs/debugging-runbook.md`, add an entry to the symptom→code index (match the file's existing entry format):

```markdown
### A reviewer's review isn't being addressed by the review loop

The loop admits comments/reviews through an **allow-list** — `resolveIngestBotKey`
(`apps/control-plane-worker/src/github/pr-review-bots.ts`). An actor is admitted only if it is a
known-registry review bot (`PR_REVIEW_BOT_CAPABILITIES`) or a user-configured custom reviewer for that
repo; everything else is dropped as `actor_not_configured_bot`. Check, in order:

1. Is the bot in `PR_REVIEW_BOT_CAPABILITIES` (known) or the repo's configured reviewers (Settings → General)?
2. Telemetry: the `review_loop.ingest.outcome` event carries `outcome: ignored`, `reason: actor_not_configured_bot`, and `actor_login` — search it to confirm the specific login was dropped and why.
3. Author type: the actor must be `type: Bot`/`App` (a `User`-type poster is rejected before the allow-list).

**Not here:** QA/verifier ("QA Testing") verdicts flow via the FSM `verification.*` spine + stored
verdict (`buildVerificationVerdictWorklistItem`), NOT this allow-list. Cycloid-owned bots
(`cycloid[bot]`/`cycloid-qa[bot]`) are excluded on purpose (self-loop prevention).
```

- [ ] **Step 3: Verify docs render + no broken links, then commit.**

Run: `npm run format:check` (or `npx prettier --check docs/review-loop.md docs/debugging-runbook.md`)
Expected: PASS.

```bash
git add docs/review-loop.md docs/debugging-runbook.md
git commit  # message below
```

Message:

```
docs(review-loop): document the reviewer allow-list + debugging signpost

<trailers>
```

---

## Final verification (before opening PRs)

- [ ] Run the full review-loop test surface:
      `npx vitest run tests/test_cloudflare/pr-review-bots-owned-actors.test.ts tests/test_cloudflare/review-loop-webhook-service.test.ts tests/test_cloudflare/review-loop-worklist.test.ts tests/test_cloudflare/review-loop-sweep.test.ts tests/test_cloudflare/review-loop-noise-gate.test.ts tests/test_cloudflare/github-pr-review-webhook.test.ts tests/test_cloudflare/pr-review-bot-settings-routes.test.ts --maxWorkers=4`
- [ ] `npm run typecheck`
- [ ] `npx eslint .` (or `npm run lint:changed`)
- [ ] `npm run format:check`

## Stack / PR grouping (for execution)

Graphite stack, bottom → top:

1. **PR 1** — Tasks 1 + 2 + 3 (allow-list gate + telemetry breadcrumb + ingest regressions). Stops the prod bleeding on its own.
2. **PR 2** — Task 4 (Copilot registry seed).
3. **PR 3** — Task 5 (docs + debugging signpost).

Tasks 1–3 could merge into a single PR 1; keep 4 and 5 separate for independent review. Use `gt` for the stack (never hand-rolled `git`/`gh` chaining).

## Out of scope (future ticket)

Adaptive LLM substance-gate + learned per-repo skip cache (gate unlisted-bot content by actionability, auto-populate a business+repo-scoped deny cache with re-probe/TTL). Revisit only if curated-registry maintenance becomes a real burden across many customer repos.
