# Live review-loop status comment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While Cycloid is review-looping on a PR, maintain a single top-level PR comment showing live which configured review bots it has observed and which it is still waiting on.

**Architecture:** A new `pr_review_status_comments` table (keyed by `session_id + pr_url`, stable across waves) tracks one GitHub comment per PR. A pure renderer turns epoch/checklist state into markdown; a best-effort `syncReviewLoopStatusComment` creates the comment on first watch and edits it in place. Invoked from three places: publish-service when watching starts, GitHub webhook handlers on each bot signal, and the review-loop sweep as a backup / terminal-state reflector.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (raw prepared statements in DAO functions), Vitest with an in-memory better-sqlite3 D1 shim, append-only SQL migrations.

**Working directory:** worktree `.worktrees/review-loop-status-comment` (branch `feat/review-loop-status-comment`, off latest `main`).

**Spec:** `docs/superpowers/specs/2026-05-28-review-loop-status-comment-design.md`

---

## Conventions used throughout

- Run a single test file: `npx vitest run tests/test_cloudflare/<file>.test.ts` (repo root).
- Run typecheck: `npm run typecheck` (repo root) — what the pre-commit hook runs.
- The D1 test shim (`SqliteD1`) is copied verbatim from `tests/test_cloudflare/review-loop-epochs.test.ts` lines 26-64. Reuse that pattern; do not invent a new one.
- Commits: the pre-commit hook runs prettier + typecheck automatically. End commit messages with the repo's co-author trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File structure

| File                                                                      | Responsibility                                                | Created/Modified |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------- |
| `apps/control-plane-worker/migrations/0120_pr_review_status_comments.sql` | Table for the per-PR status comment                           | Create           |
| `apps/control-plane-worker/src/services/review-loop-status-comment-db.ts` | DAO: row CRUD + posting lease                                 | Create           |
| `apps/control-plane-worker/src/services/review-loop-epochs.ts`            | Add `getLatestReviewLoopEpochForPr` query                     | Modify           |
| `shared/constants/pr-review-bots.ts`                                      | Add `prReviewBotKeyLabel`                                     | Modify           |
| `apps/control-plane-worker/src/services/review-loop-status-comment.ts`    | Pure renderer + `syncReviewLoopStatusComment` + ingest helper | Create           |
| `apps/control-plane-worker/src/webhooks/github.ts`                        | Call ingest sync helper at the 5 ingest call sites            | Modify           |
| `apps/control-plane-worker/src/session/publish-service.ts`                | Initial post when watching starts                             | Modify           |
| `apps/control-plane-worker/src/services/review-loop-sweep.ts`             | Backup + terminal-state sync                                  | Modify           |
| `tests/test_cloudflare/review-loop-status-comment-db.test.ts`             | DAO tests                                                     | Create           |
| `tests/test_cloudflare/review-loop-status-comment.test.ts`                | Renderer + sync tests                                         | Create           |

---

## Task 1: Migration — `pr_review_status_comments` table

**Files:** create `apps/control-plane-worker/migrations/0120_pr_review_status_comments.sql`

- [ ] **Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS pr_review_status_comments (
  session_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  github_comment_id INTEGER,
  last_rendered_body_hash TEXT,
  posting_lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, pr_url)
);
```

- [ ] **Step 2:** `ls apps/control-plane-worker/migrations/ | sort | tail -3` → `0120_pr_review_status_comments.sql` is present and highest-numbered (after `0118_warm_sandbox_pool_claim_lease.sql`).

- [ ] **Step 3:** Verify it applies cleanly in sqlite:

Run: `node -e "const D=require('better-sqlite3');const fs=require('fs');const db=new D(':memory:');db.exec(fs.readFileSync('apps/control-plane-worker/migrations/0120_pr_review_status_comments.sql','utf8'));console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='pr_review_status_comments'\").get())"`
Expected: prints `{ name: 'pr_review_status_comments' }`

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane-worker/migrations/0120_pr_review_status_comments.sql
git commit -m "Add pr_review_status_comments migration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: DAO module — `review-loop-status-comment-db.ts`

**Files:** create `apps/control-plane-worker/src/services/review-loop-status-comment-db.ts`; test `tests/test_cloudflare/review-loop-status-comment-db.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimReviewLoopStatusCommentPostingLease,
  clearReviewLoopStatusCommentGithubId,
  ensureReviewLoopStatusCommentRow,
  getReviewLoopStatusComment,
  persistReviewLoopStatusCommentBodyHash,
  persistReviewLoopStatusCommentCreated,
} from "../../apps/control-plane-worker/src/services/review-loop-status-comment-db";

class SqliteD1Statement {
  private boundValues: unknown[] = [];
  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}
  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}
class SqliteD1 {
  constructor(readonly db: Database.Database) {}
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

let sqlite: Database.Database;
let db: D1Database;

const ident = {
  sessionId: "s-1",
  prUrl: "https://github.com/acme/repo/pull/7",
  ownerUserId: 101,
  repoOwner: "acme",
  repoName: "repo",
  prNumber: 7,
};

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0120_pr_review_status_comments.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("review-loop status comment DAO", () => {
  it("ensures a row once and is idempotent", async () => {
    await ensureReviewLoopStatusCommentRow(db, { ...ident, nowMs: 1000 });
    await ensureReviewLoopStatusCommentRow(db, { ...ident, nowMs: 2000 });
    const row = await getReviewLoopStatusComment(db, ident.sessionId, ident.prUrl);
    expect(row?.githubCommentId).toBeNull();
    expect(row?.createdAt).toBe(1000);
  });

  it("grants the posting lease to exactly one caller until it expires", async () => {
    await ensureReviewLoopStatusCommentRow(db, { ...ident, nowMs: 1000 });
    const first = await claimReviewLoopStatusCommentPostingLease(db, {
      sessionId: ident.sessionId,
      prUrl: ident.prUrl,
      leaseUntil: 31000,
      nowMs: 1000,
    });
    const second = await claimReviewLoopStatusCommentPostingLease(db, {
      sessionId: ident.sessionId,
      prUrl: ident.prUrl,
      leaseUntil: 31500,
      nowMs: 1500,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("persists creation, then body-hash, then clears the comment id", async () => {
    await ensureReviewLoopStatusCommentRow(db, { ...ident, nowMs: 1000 });
    await persistReviewLoopStatusCommentCreated(db, {
      sessionId: ident.sessionId,
      prUrl: ident.prUrl,
      githubCommentId: 555,
      bodyHash: "hash-a",
      nowMs: 2000,
    });
    let row = await getReviewLoopStatusComment(db, ident.sessionId, ident.prUrl);
    expect(row?.githubCommentId).toBe(555);
    expect(row?.lastRenderedBodyHash).toBe("hash-a");
    expect(row?.postingLeaseUntil).toBeNull();

    await persistReviewLoopStatusCommentBodyHash(db, {
      sessionId: ident.sessionId,
      prUrl: ident.prUrl,
      bodyHash: "hash-b",
      nowMs: 3000,
    });
    row = await getReviewLoopStatusComment(db, ident.sessionId, ident.prUrl);
    expect(row?.lastRenderedBodyHash).toBe("hash-b");

    await clearReviewLoopStatusCommentGithubId(db, {
      sessionId: ident.sessionId,
      prUrl: ident.prUrl,
      nowMs: 4000,
    });
    row = await getReviewLoopStatusComment(db, ident.sessionId, ident.prUrl);
    expect(row?.githubCommentId).toBeNull();
    expect(row?.lastRenderedBodyHash).toBeNull();
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/review-loop-status-comment-db.test.ts` → FAIL (module not found).

- [ ] **Step 3: Write the DAO module**

```ts
export interface ReviewLoopStatusComment {
  sessionId: string;
  prUrl: string;
  ownerUserId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  githubCommentId: number | null;
  lastRenderedBodyHash: string | null;
  postingLeaseUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ReviewLoopStatusCommentRow {
  session_id: string;
  pr_url: string;
  owner_user_id: number;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  github_comment_id: number | null;
  last_rendered_body_hash: string | null;
  posting_lease_until: number | null;
  created_at: number;
  updated_at: number;
}

function rowToStatusComment(row: ReviewLoopStatusCommentRow): ReviewLoopStatusComment {
  return {
    sessionId: row.session_id,
    prUrl: row.pr_url,
    ownerUserId: row.owner_user_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    prNumber: row.pr_number,
    githubCommentId: row.github_comment_id,
    lastRenderedBodyHash: row.last_rendered_body_hash,
    postingLeaseUntil: row.posting_lease_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getReviewLoopStatusComment(
  db: D1Database,
  sessionId: string,
  prUrl: string,
): Promise<ReviewLoopStatusComment | null> {
  const row = await db
    .prepare(`SELECT * FROM pr_review_status_comments WHERE session_id = ? AND pr_url = ? LIMIT 1`)
    .bind(sessionId, prUrl)
    .first<ReviewLoopStatusCommentRow>();
  return row ? rowToStatusComment(row) : null;
}

export async function ensureReviewLoopStatusCommentRow(
  db: D1Database,
  input: {
    sessionId: string;
    prUrl: string;
    ownerUserId: number;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    nowMs: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO pr_review_status_comments (
        session_id, pr_url, owner_user_id, repo_owner, repo_name, pr_number,
        github_comment_id, last_rendered_body_hash, posting_lease_until, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(
      input.sessionId,
      input.prUrl,
      input.ownerUserId,
      input.repoOwner,
      input.repoName,
      input.prNumber,
      input.nowMs,
      input.nowMs,
    )
    .run();
}

export async function claimReviewLoopStatusCommentPostingLease(
  db: D1Database,
  input: { sessionId: string; prUrl: string; leaseUntil: number; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE pr_review_status_comments
       SET posting_lease_until = ?, updated_at = ?
       WHERE session_id = ? AND pr_url = ?
         AND github_comment_id IS NULL
         AND (posting_lease_until IS NULL OR posting_lease_until < ?)`,
    )
    .bind(input.leaseUntil, input.nowMs, input.sessionId, input.prUrl, input.nowMs)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function persistReviewLoopStatusCommentCreated(
  db: D1Database,
  input: { sessionId: string; prUrl: string; githubCommentId: number; bodyHash: string; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE pr_review_status_comments
       SET github_comment_id = ?, last_rendered_body_hash = ?, posting_lease_until = NULL, updated_at = ?
       WHERE session_id = ? AND pr_url = ?`,
    )
    .bind(input.githubCommentId, input.bodyHash, input.nowMs, input.sessionId, input.prUrl)
    .run();
}

export async function persistReviewLoopStatusCommentBodyHash(
  db: D1Database,
  input: { sessionId: string; prUrl: string; bodyHash: string; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE pr_review_status_comments
       SET last_rendered_body_hash = ?, updated_at = ?
       WHERE session_id = ? AND pr_url = ?`,
    )
    .bind(input.bodyHash, input.nowMs, input.sessionId, input.prUrl)
    .run();
}

export async function clearReviewLoopStatusCommentGithubId(
  db: D1Database,
  input: { sessionId: string; prUrl: string; nowMs: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE pr_review_status_comments
       SET github_comment_id = NULL, last_rendered_body_hash = NULL, posting_lease_until = NULL, updated_at = ?
       WHERE session_id = ? AND pr_url = ?`,
    )
    .bind(input.nowMs, input.sessionId, input.prUrl)
    .run();
}
```

- [ ] **Step 4:** `npx vitest run tests/test_cloudflare/review-loop-status-comment-db.test.ts` → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-status-comment-db.ts tests/test_cloudflare/review-loop-status-comment-db.test.ts
git commit -m "Add review-loop status comment DAO

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `getLatestReviewLoopEpochForPr` query

**Files:** modify `apps/control-plane-worker/src/services/review-loop-epochs.ts` (add after `hasReviewLoopEpochForHead`, ~line 420); test `tests/test_cloudflare/review-loop-epochs.test.ts` (add a case)

- [ ] **Step 1:** Append inside the existing `describe("review-loop epoch DAO/service", ...)` block in `review-loop-epochs.test.ts`:

```ts
it("returns the highest-wave epoch for a PR via getLatestReviewLoopEpochForPr", async () => {
  const prUrl = "https://github.com/acme/repo/pull/77";
  // wave 1 (completes so the next activity opens a new wave)
  const first = await upsertReviewLoopEpochActivity(db, {
    sessionId: "s-latest",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 77,
    prUrl,
    headSha: "sha-1",
    expectedBots: [{ type: "known", id: "cursor-bugbot" }],
    expectedBotsHash: "hash-1",
    sourceId: "review:1",
    botKey: "known:cursor-bugbot",
    botActorLogin: "cursor[bot]",
    terminal: true,
    evidence: { type: "review_submission", sourceId: "review:1" },
    nowMs: 1000,
  });
  await markReviewLoopEpochCompleted(db, first.id, { nowMs: 1500, worklistHash: null });

  const second = await upsertReviewLoopEpochActivity(db, {
    sessionId: "s-latest",
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 77,
    prUrl,
    headSha: "sha-2",
    expectedBots: [{ type: "known", id: "cursor-bugbot" }],
    expectedBotsHash: "hash-1",
    sourceId: "review:2",
    botKey: "known:cursor-bugbot",
    botActorLogin: "cursor[bot]",
    terminal: true,
    evidence: { type: "review_submission", sourceId: "review:2" },
    nowMs: 2000,
  });

  const latest = await getLatestReviewLoopEpochForPr(db, { sessionId: "s-latest", prUrl });
  expect(latest?.id).toBe(second.id);
  expect(latest?.wave).toBe(2);

  const none = await getLatestReviewLoopEpochForPr(db, { sessionId: "s-latest", prUrl: "https://x/pull/0" });
  expect(none).toBeNull();
});
```

Also add `getLatestReviewLoopEpochForPr` and `markReviewLoopEpochCompleted` to the test file's import list (the latter is already imported).

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/review-loop-epochs.test.ts` → FAIL (`getLatestReviewLoopEpochForPr` not exported).

- [ ] **Step 3:** Insert in `review-loop-epochs.ts` directly after `hasReviewLoopEpochForHead`:

```ts
export async function getLatestReviewLoopEpochForPr(
  db: D1Database,
  options: { sessionId: string; prUrl: string },
): Promise<ReviewLoopEpoch | null> {
  const row = await db
    .prepare(
      `SELECT * FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ?
       ORDER BY created_at DESC, wave DESC
       LIMIT 1`,
    )
    .bind(options.sessionId, options.prUrl)
    .first<ReviewLoopEpochRow>();
  return row ? rowToEpoch(row) : null;
}
```

- [ ] **Step 4:** `npx vitest run tests/test_cloudflare/review-loop-epochs.test.ts` → PASS (all existing + new).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-epochs.ts tests/test_cloudflare/review-loop-epochs.test.ts
git commit -m "Add getLatestReviewLoopEpochForPr query

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Bot-label helper `prReviewBotKeyLabel`

**Files:** modify `shared/constants/pr-review-bots.ts` (append after `normalizePrReviewExpectedBot`); test `tests/test_cloudflare/review-loop-status-comment.test.ts` (create now; renderer tests added in Task 5 — the helper is also exercised through the renderer, plus this direct unit test)

- [ ] **Step 1:** Create `tests/test_cloudflare/review-loop-status-comment.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { prReviewBotKeyLabel } from "../../shared/constants/pr-review-bots.js";

describe("prReviewBotKeyLabel", () => {
  it("maps known bot keys to display labels", () => {
    expect(prReviewBotKeyLabel("known:greptile")).toBe("Greptile");
    expect(prReviewBotKeyLabel("known:cursor-bugbot")).toBe("Cursor Bugbot");
  });

  it("maps custom bot keys to @login", () => {
    expect(prReviewBotKeyLabel("custom:my-review-bot")).toBe("@my-review-bot");
  });

  it("falls back to the raw key for unknown formats", () => {
    expect(prReviewBotKeyLabel("known:does-not-exist")).toBe("does-not-exist");
    expect(prReviewBotKeyLabel("weird")).toBe("weird");
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/review-loop-status-comment.test.ts` → FAIL (`prReviewBotKeyLabel` not exported).

- [ ] **Step 3:** Append to `shared/constants/pr-review-bots.ts`:

```ts
export function prReviewBotKeyLabel(key: string): string {
  if (key.startsWith("known:")) {
    const id = key.slice("known:".length);
    return PR_REVIEW_BOT_LABELS[id as PrReviewKnownBotId] ?? id;
  }
  if (key.startsWith("custom:")) {
    return `@${key.slice("custom:".length)}`;
  }
  return key;
}
```

- [ ] **Step 4:** `npx vitest run tests/test_cloudflare/review-loop-status-comment.test.ts` → PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/constants/pr-review-bots.ts tests/test_cloudflare/review-loop-status-comment.test.ts
git commit -m "Add prReviewBotKeyLabel helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Renderer + sync orchestration — `review-loop-status-comment.ts`

**Files:** create `apps/control-plane-worker/src/services/review-loop-status-comment.ts`; test `tests/test_cloudflare/review-loop-status-comment.test.ts` (extend)

### 5a — Pure renderer

- [ ] **Step 1:** Append failing renderer tests to `review-loop-status-comment.test.ts` (add the import at the top):

```ts
import { renderReviewLoopStatusComment } from "../../apps/control-plane-worker/src/services/review-loop-status-comment";
import type { PrReviewExpectedBot } from "../../shared/constants/pr-review-bots.js";

const expected: PrReviewExpectedBot[] = [
  { type: "known", id: "greptile" },
  { type: "known", id: "coderabbit" },
  { type: "known", id: "cursor-bugbot" },
  { type: "custom", login: "my-review-bot" },
];

describe("renderReviewLoopStatusComment", () => {
  it("renders collecting state with reviewed and waiting groups", async () => {
    const { body, bodyHash } = await renderReviewLoopStatusComment({
      expectedBots: expected,
      observedBotKeys: ["known:greptile", "known:coderabbit"],
      timedOutBotKeys: [],
      status: "collecting",
      headSha: "a1b2c3d4e5",
      blockedReason: null,
    });
    expect(body).toContain("No actionable items");
    expect(body).toContain("Watching for reviews on `a1b2c3d`");
    expect(body).toContain("**✅ Reviewed**");
    expect(body).toContain("- Greptile");
    expect(body).toContain("**⏳ Waiting on**");
    expect(body).toContain("- Cursor Bugbot");
    expect(body).toContain("- @my-review-bot");
    expect(body).toContain("Auto-proceeds");
    expect(bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("renders the responding state when all bots are observed", async () => {
    const { body } = await renderReviewLoopStatusComment({
      expectedBots: expected,
      observedBotKeys: ["known:greptile", "known:coderabbit", "known:cursor-bugbot", "custom:my-review-bot"],
      timedOutBotKeys: [],
      status: "processing",
      headSha: "a1b2c3d4e5",
      blockedReason: null,
    });
    expect(body).toContain("All reviewers in");
    expect(body).not.toContain("**⏳ Waiting on**");
    expect(body).not.toContain("Auto-proceeds");
  });

  it("moves timed-out bots into their own group on fallback", async () => {
    const { body } = await renderReviewLoopStatusComment({
      expectedBots: expected,
      observedBotKeys: ["known:greptile"],
      timedOutBotKeys: ["known:coderabbit", "known:cursor-bugbot", "custom:my-review-bot"],
      status: "ready",
      headSha: "a1b2c3d4e5",
      blockedReason: null,
    });
    expect(body).toContain("Proceeding on `a1b2c3d`");
    expect(body).toContain("**⏭️ Proceeded without (timed out)**");
    expect(body).toContain("- CodeRabbit");
    expect(body).not.toContain("**⏳ Waiting on**");
  });

  it("renders completed and blocked states", async () => {
    const completed = await renderReviewLoopStatusComment({
      expectedBots: expected,
      observedBotKeys: ["known:greptile"],
      timedOutBotKeys: [],
      status: "completed",
      headSha: "a1b2c3d4e5",
      blockedReason: null,
    });
    expect(completed.body).toContain("Done — addressed this round");

    const blocked = await renderReviewLoopStatusComment({
      expectedBots: expected,
      observedBotKeys: [],
      timedOutBotKeys: [],
      status: "blocked",
      headSha: "a1b2c3d4e5",
      blockedReason: "missing installation permissions",
    });
    expect(blocked.body).toContain("Paused: missing installation permissions");
  });

  it("produces a stable hash for identical input", async () => {
    const a = await renderReviewLoopStatusComment({
      expectedBots: expected,
      observedBotKeys: ["known:greptile"],
      timedOutBotKeys: [],
      status: "collecting",
      headSha: "a1b2c3d4e5",
      blockedReason: null,
    });
    const b = await renderReviewLoopStatusComment({
      expectedBots: expected,
      observedBotKeys: ["known:greptile"],
      timedOutBotKeys: [],
      status: "collecting",
      headSha: "a1b2c3d4e5",
      blockedReason: null,
    });
    expect(a.bodyHash).toBe(b.bodyHash);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/review-loop-status-comment.test.ts` → FAIL (`renderReviewLoopStatusComment` not exported).

- [ ] **Step 3:** Create `review-loop-status-comment.ts` with the renderer (sync function added in 5b):

```ts
import { computeSha256Hex } from "../crypto";
import type { PrReviewExpectedBot } from "../../../../shared/constants/pr-review-bots.js";
import { normalizeGithubLogin, prReviewBotKeyLabel } from "../../../../shared/constants/pr-review-bots.js";
import type { ReviewLoopEpochStatus } from "./review-loop-epochs";

const PREFACE = "> 🤖 **Cycloid review status** — _No actionable items in this comment; informational only._";

export interface RenderReviewLoopStatusCommentInput {
  expectedBots: PrReviewExpectedBot[];
  observedBotKeys: string[];
  timedOutBotKeys: string[];
  status: ReviewLoopEpochStatus;
  headSha: string;
  blockedReason?: string | null;
}

function expectedBotKey(bot: PrReviewExpectedBot): string {
  return bot.type === "known" ? `known:${bot.id}` : `custom:${normalizeGithubLogin(bot.login)}`;
}

function shortSha(headSha: string): string {
  return headSha ? headSha.slice(0, 7) : "the latest commit";
}

function headline(input: RenderReviewLoopStatusCommentInput, hasTimedOut: boolean): string {
  const sha = shortSha(input.headSha);
  switch (input.status) {
    case "collecting":
      return `Watching for reviews on \`${sha}\`. I'll address feedback once the reviewers below weigh in.`;
    case "waiting_for_owner":
      return "Waiting on repo-owner approval before responding.";
    case "completed":
      return `Done — addressed this round of reviews on \`${sha}\`.`;
    case "blocked":
      return `Paused: ${input.blockedReason ?? "review loop is blocked"}.`;
    case "ready":
    case "reserving":
    case "enqueued":
    case "processing":
    case "publishing":
      return hasTimedOut
        ? `Proceeding on \`${sha}\` — addressing the reviews that arrived.`
        : `All reviewers in — addressing feedback on \`${sha}\`…`;
    default:
      return `Watching for reviews on \`${sha}\`.`;
  }
}

function group(title: string, labels: string[]): string | null {
  if (labels.length === 0) return null;
  return [`**${title}**`, ...labels.map((label) => `- ${label}`)].join("\n");
}

export async function renderReviewLoopStatusComment(
  input: RenderReviewLoopStatusCommentInput,
): Promise<{ body: string; bodyHash: string }> {
  const observed = new Set(input.observedBotKeys);
  const timedOut = new Set(input.timedOutBotKeys);

  const reviewed: string[] = [];
  const waiting: string[] = [];
  const proceeded: string[] = [];
  for (const bot of input.expectedBots) {
    const key = expectedBotKey(bot);
    const label = prReviewBotKeyLabel(key);
    if (observed.has(key)) reviewed.push(label);
    else if (timedOut.has(key)) proceeded.push(label);
    else waiting.push(label);
  }

  const sections = [
    PREFACE,
    "",
    headline(input, proceeded.length > 0),
    group("✅ Reviewed", reviewed),
    group("⏳ Waiting on", waiting),
    group("⏭️ Proceeded without (timed out)", proceeded),
  ].filter((part): part is string => part !== null && part !== undefined);

  if (input.status === "collecting" && waiting.length > 0) {
    sections.push("<sub>Auto-proceeds ~10 min after the first review if a reviewer stays quiet.</sub>");
  }

  const body = sections.join("\n\n");
  const bodyHash = await computeSha256Hex(body);
  return { body, bodyHash };
}
```

- [ ] **Step 4:** `npx vitest run tests/test_cloudflare/review-loop-status-comment.test.ts` → PASS (renderer + label tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-status-comment.ts tests/test_cloudflare/review-loop-status-comment.test.ts
git commit -m "Add review-loop status comment renderer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### 5b — `syncReviewLoopStatusComment`

- [ ] **Step 6:** Append failing sync tests to `review-loop-status-comment.test.ts`; add mocks + imports at the very top of the file, before other imports that pull these modules:

```ts
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { beforeEach, vi } from "vitest";

const mockGetSessionState = vi.fn();
const mockCreateInstallationToken = vi.fn();
const mockCreatePrIssueComment = vi.fn();
const mockUpdateIssueComment = vi.fn();
const mockResolveReviewLoopChecklist = vi.fn();

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));
vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: (...args: unknown[]) => mockCreateInstallationToken(...args),
}));
vi.mock("../../apps/control-plane-worker/src/github/pr", () => ({
  createPrIssueComment: (...args: unknown[]) => mockCreatePrIssueComment(...args),
  updateIssueComment: (...args: unknown[]) => mockUpdateIssueComment(...args),
}));
vi.mock("../../apps/control-plane-worker/src/services/review-loop-settings", () => ({
  resolveReviewLoopChecklist: (...args: unknown[]) => mockResolveReviewLoopChecklist(...args),
}));
```

Reuse the same `SqliteD1`/`SqliteD1Statement` classes from Task 2 (copy them into this file). Then:

```ts
import { syncReviewLoopStatusComment } from "../../apps/control-plane-worker/src/services/review-loop-status-comment";
import { upsertReviewLoopEpochActivity } from "../../apps/control-plane-worker/src/services/review-loop-epochs";

describe("syncReviewLoopStatusComment", () => {
  let sqlite: Database.Database;
  let db: D1Database;
  const logger = { info: vi.fn(), warn: vi.fn() } as never;
  const prUrl = "https://github.com/acme/repo/pull/7";
  const baseParams = {
    sessionId: "s-1",
    prUrl,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 7,
    logger,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(":memory:");
    sqlite.exec(
      readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"),
    );
    sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0120_pr_review_status_comments.sql", "utf8"));
    db = new SqliteD1(sqlite) as unknown as D1Database;
    mockGetSessionState.mockResolvedValue({
      sessionId: "s-1",
      status: "active",
      ownerUserId: "101",
      installationId: 9001,
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      reviewListeningHeadSha: "a1b2c3d4",
    });
    mockCreateInstallationToken.mockResolvedValue("tok");
    mockCreatePrIssueComment.mockResolvedValue({ id: 555, htmlUrl: "" });
    mockUpdateIssueComment.mockResolvedValue(undefined);
    mockResolveReviewLoopChecklist.mockResolvedValue({
      ok: true,
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-1",
    });
  });

  const env = () => ({ DB: db }) as never;

  it("posts the comment at watch-start when no epoch exists yet", async () => {
    await syncReviewLoopStatusComment(env(), { ...baseParams, nowMs: 1000 });
    expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
    const [, owner, repo, num, body] = mockCreatePrIssueComment.mock.calls[0];
    expect([owner, repo, num]).toEqual(["acme", "repo", 7]);
    expect(body).toContain("Waiting on");
  });

  it("skips entirely when no checklist and no existing comment", async () => {
    mockResolveReviewLoopChecklist.mockResolvedValue({ ok: false, reason: "empty_expected_bots" });
    await syncReviewLoopStatusComment(env(), { ...baseParams, nowMs: 1000 });
    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
  });

  it("edits in place on a second sync after a bot is observed", async () => {
    await syncReviewLoopStatusComment(env(), { ...baseParams, nowMs: 1000 }); // create
    await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-1",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 7,
      prUrl,
      headSha: "a1b2c3d4",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-1",
      sourceId: "review:1",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:1" },
      nowMs: 1500,
    });
    await syncReviewLoopStatusComment(env(), { ...baseParams, nowMs: 2000 }); // edit
    expect(mockUpdateIssueComment).toHaveBeenCalledTimes(1);
    const [, , , commentId] = mockUpdateIssueComment.mock.calls[0];
    expect(commentId).toBe(555);
  });

  it("skips the GitHub edit when nothing changed (hash guard)", async () => {
    await syncReviewLoopStatusComment(env(), { ...baseParams, nowMs: 1000 }); // create
    await syncReviewLoopStatusComment(env(), { ...baseParams, nowMs: 2000 }); // identical
    expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
    expect(mockUpdateIssueComment).not.toHaveBeenCalled();
  });

  it("recreates the comment when the edit returns 404", async () => {
    await syncReviewLoopStatusComment(env(), { ...baseParams, nowMs: 1000 }); // create -> id 555
    await upsertReviewLoopEpochActivity(db, {
      sessionId: "s-1",
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 7,
      prUrl,
      headSha: "a1b2c3d4",
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-1",
      sourceId: "review:1",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:1" },
      nowMs: 1400,
    });
    mockUpdateIssueComment.mockRejectedValueOnce(new Error("GitHub issue comment update failed (404): not found"));
    mockCreatePrIssueComment.mockResolvedValueOnce({ id: 777, htmlUrl: "" });
    await syncReviewLoopStatusComment(env(), { ...baseParams, nowMs: 1500 }); // edit -> 404 -> clear
    await syncReviewLoopStatusComment(env(), { ...baseParams, nowMs: 1600 }); // recreate
    expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(2);
  });

  it("does not create when review listening is inactive", async () => {
    mockGetSessionState.mockResolvedValue({
      sessionId: "s-1",
      status: "active",
      ownerUserId: "101",
      installationId: 9001,
      reviewListeningActive: false,
      reviewListeningPrUrl: prUrl,
      reviewListeningHeadSha: "a1b2c3d4",
    });
    await syncReviewLoopStatusComment(env(), { ...baseParams, nowMs: 1000 });
    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7:** `npx vitest run tests/test_cloudflare/review-loop-status-comment.test.ts` → FAIL (`syncReviewLoopStatusComment` not exported).

- [ ] **Step 8:** Append the sync function to `review-loop-status-comment.ts`; extend the import block:

```ts
import type { Env } from "../types";
import type { Logger } from "../logger";
import { createInstallationToken } from "../github/octokit";
import { createPrIssueComment, updateIssueComment } from "../github/pr";
import { getSessionState } from "../session/state";
import { getLatestReviewLoopEpochForPr, type ReviewLoopWebhookIngestResult } from "./review-loop-epochs";
import { resolveReviewLoopChecklist } from "./review-loop-settings";
import {
  claimReviewLoopStatusCommentPostingLease,
  clearReviewLoopStatusCommentGithubId,
  ensureReviewLoopStatusCommentRow,
  getReviewLoopStatusComment,
  persistReviewLoopStatusCommentBodyHash,
  persistReviewLoopStatusCommentCreated,
} from "./review-loop-status-comment-db";

const POSTING_LEASE_MS = 30_000;

export async function syncReviewLoopStatusComment(
  env: Env,
  params: {
    sessionId: string;
    prUrl: string;
    repoOwner: string;
    repoName: string;
    prNumber: number;
    nowMs: number;
    logger: Logger;
    tokenHint?: string;
  },
): Promise<void> {
  const { sessionId, prUrl, repoOwner, repoName, prNumber, nowMs, logger } = params;
  try {
    const session = await getSessionState(env, sessionId);
    if (!session) return;

    const epoch = await getLatestReviewLoopEpochForPr(env.DB, { sessionId, prUrl });
    const existing = await getReviewLoopStatusComment(env.DB, sessionId, prUrl);

    let renderInput: RenderReviewLoopStatusCommentInput;
    let ownerUserId: number;
    if (epoch) {
      ownerUserId = epoch.ownerUserId;
      renderInput = {
        expectedBots: epoch.expectedBots,
        observedBotKeys: epoch.observedTerminalBotKeys,
        timedOutBotKeys: epoch.timedOutBotKeys,
        status: epoch.status,
        headSha: epoch.headSha,
        blockedReason: epoch.blockedReason,
      };
    } else {
      ownerUserId = Number(session.ownerUserId);
      if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) return;
      const checklist = await resolveReviewLoopChecklist(env, { ownerUserId, repoOwner, repoName });
      if (!checklist.ok) {
        if (!existing) return; // nothing configured and nothing posted: post nothing
        return;
      }
      renderInput = {
        expectedBots: checklist.expectedBots,
        observedBotKeys: [],
        timedOutBotKeys: [],
        status: "collecting",
        headSha: typeof session.reviewListeningHeadSha === "string" ? session.reviewListeningHeadSha : "",
        blockedReason: null,
      };
    }

    if (!existing && renderInput.expectedBots.length === 0) return;

    const { body, bodyHash } = await renderReviewLoopStatusComment(renderInput);

    await ensureReviewLoopStatusCommentRow(env.DB, {
      sessionId,
      prUrl,
      ownerUserId,
      repoOwner,
      repoName,
      prNumber,
      nowMs,
    });
    const row = existing ?? (await getReviewLoopStatusComment(env.DB, sessionId, prUrl));
    if (!row) return;

    if (row.githubCommentId != null && row.lastRenderedBodyHash === bodyHash) return;

    const installationId = session.installationId;
    if (typeof installationId !== "number") return;
    const token = params.tokenHint ?? (await createInstallationToken(env, installationId));

    if (row.githubCommentId == null) {
      if (!session.reviewListeningActive || session.reviewListeningPrUrl !== prUrl) return;
      const won = await claimReviewLoopStatusCommentPostingLease(env.DB, {
        sessionId,
        prUrl,
        leaseUntil: nowMs + POSTING_LEASE_MS,
        nowMs,
      });
      if (!won) return;
      const created = await createPrIssueComment(token, repoOwner, repoName, prNumber, body);
      await persistReviewLoopStatusCommentCreated(env.DB, {
        sessionId,
        prUrl,
        githubCommentId: created.id,
        bodyHash,
        nowMs,
      });
      return;
    }

    try {
      await updateIssueComment(token, repoOwner, repoName, row.githubCommentId, body);
      await persistReviewLoopStatusCommentBodyHash(env.DB, { sessionId, prUrl, bodyHash, nowMs });
    } catch (error) {
      if (/\(404\)/.test(String(error))) {
        await clearReviewLoopStatusCommentGithubId(env.DB, { sessionId, prUrl, nowMs });
        return;
      }
      throw error;
    }
  } catch (error) {
    logger.warn({ sessionId, prUrl, error: String(error) }, "Review-loop status comment sync failed");
  }
}

export async function syncReviewLoopStatusCommentForIngest(
  env: Env,
  result: ReviewLoopWebhookIngestResult,
  logger: Logger,
): Promise<void> {
  if (result.status !== "handled") return;
  const epoch = result.epoch;
  await syncReviewLoopStatusComment(env, {
    sessionId: epoch.sessionId,
    prUrl: epoch.prUrl,
    repoOwner: epoch.repoOwner,
    repoName: epoch.repoName,
    prNumber: epoch.prNumber,
    nowMs: Date.now(),
    logger,
  });
}
```

Note: `RenderReviewLoopStatusCommentInput` is already defined in this file (5a). `ReviewLoopWebhookIngestResult` is exported from `review-loop-epochs.ts` (line 785).

- [ ] **Step 9:** `npx vitest run tests/test_cloudflare/review-loop-status-comment.test.ts` → PASS (renderer + label + sync tests).

- [ ] **Step 10:** `npm run typecheck` → PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-status-comment.ts tests/test_cloudflare/review-loop-status-comment.test.ts
git commit -m "Add syncReviewLoopStatusComment orchestration

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire live edits into webhook handlers

The 5 review-loop ingest handlers in `webhooks/github.ts` already branch on `result.status === "handled"`. After each, call the ingest sync helper. It is best-effort (swallows its own errors) and awaited (hash-guarded, so usually a no-op DB read).

**Files:** modify `apps/control-plane-worker/src/webhooks/github.ts`; test `tests/test_cloudflare/review-loop-status-comment.test.ts` (extend — unit-test the ingest helper)

- [ ] **Step 1:** Append to `review-loop-status-comment.test.ts`:

```ts
import { syncReviewLoopStatusCommentForIngest } from "../../apps/control-plane-worker/src/services/review-loop-status-comment";

describe("syncReviewLoopStatusCommentForIngest", () => {
  let sqlite2: Database.Database;
  let db2: D1Database;
  const logger = { info: vi.fn(), warn: vi.fn() } as never;
  const prUrl = "https://github.com/acme/repo/pull/7";

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite2 = new Database(":memory:");
    sqlite2.exec(
      readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"),
    );
    sqlite2.exec(readFileSync("apps/control-plane-worker/migrations/0120_pr_review_status_comments.sql", "utf8"));
    db2 = new SqliteD1(sqlite2) as unknown as D1Database;
    mockGetSessionState.mockResolvedValue({
      sessionId: "s-1",
      status: "active",
      ownerUserId: "101",
      installationId: 9001,
      reviewListeningActive: true,
      reviewListeningPrUrl: prUrl,
      reviewListeningHeadSha: "a1b2c3d4",
    });
    mockCreateInstallationToken.mockResolvedValue("tok");
    mockCreatePrIssueComment.mockResolvedValue({ id: 555, htmlUrl: "" });
  });

  it("no-ops for ignored results", async () => {
    await syncReviewLoopStatusCommentForIngest(
      { DB: db2 } as never,
      { status: "ignored", reason: "actor_not_configured_bot" },
      logger,
    );
    expect(mockCreatePrIssueComment).not.toHaveBeenCalled();
  });

  it("syncs for handled results using the epoch identity", async () => {
    const epoch = {
      sessionId: "s-1",
      prUrl,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 7,
      ownerUserId: 101,
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      observedTerminalBotKeys: ["known:cursor-bugbot"],
      timedOutBotKeys: [],
      status: "ready",
      headSha: "a1b2c3d4",
      blockedReason: null,
    };
    await syncReviewLoopStatusCommentForIngest({ DB: db2 } as never, { status: "handled", epoch } as never, logger);
    expect(mockCreatePrIssueComment).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/test_cloudflare/review-loop-status-comment.test.ts` — the helper was added in Task 5 step 8, so this should already PASS (it just adds coverage). If you split helper creation, add the helper now.

- [ ] **Step 3:** Add the import in `webhooks/github.ts` (near the other `services/review-loop-*` imports, ~line 32):

```ts
import { syncReviewLoopStatusCommentForIngest } from "../services/review-loop-status-comment";
```

- [ ] **Step 4:** At each of the 5 `if (result.status === "handled") {` blocks, add the sync call as the first statement inside (before the existing `return`/response build):

- Issue comment handler — after line 1059.
- Commit status handler — after line 1206.
- Check run handler — after line 1352.
- PR review comment handler — after line 1457.
- PR review handler — after line 1539.

The inserted line is identical at each (`env` and the module-level `log` are in scope at every site):

```ts
await syncReviewLoopStatusCommentForIngest(env, result, log);
```

- [ ] **Step 5:** `npx vitest run tests/test_cloudflare/github-pr-review-webhook.test.ts tests/test_cloudflare/review-loop-webhook-service.test.ts` → PASS (existing behavior unchanged).

- [ ] **Step 6:** `npm run typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane-worker/src/webhooks/github.ts tests/test_cloudflare/review-loop-status-comment.test.ts
git commit -m "Edit review-loop status comment live on bot webhooks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Initial post when watching starts (publish-service)

**Files:** modify `apps/control-plane-worker/src/session/publish-service.ts`

`enterReviewListeningIfEligible` (line 1309) already resolves the checklist and has `ext.repoOwner`, `ext.repoName`, `ext.prNumber`, `ownerUserId`, `prUrl`, `currentHeadSha`. After it calls `this.enterReviewListening(...)`, post the initial comment.

- [ ] **Step 1:** Add the import (with the other `services/review-loop-*` imports):

```ts
import { syncReviewLoopStatusComment } from "../services/review-loop-status-comment";
```

- [ ] **Step 2:** Replace the final line of `enterReviewListeningIfEligible`. Find (line ~1350):

```ts
    await this.enterReviewListening(sessionId, prUrl, currentHeadSha, promptId);
  }
```

Replace with:

```ts
    await this.enterReviewListening(sessionId, prUrl, currentHeadSha, promptId);

    if (repoOwner && repoName && typeof ext.prNumber === "number" && ext.prNumber > 0) {
      await syncReviewLoopStatusComment(this.host.env, {
        sessionId,
        prUrl,
        repoOwner,
        repoName,
        prNumber: ext.prNumber,
        nowMs: Date.now(),
        logger: this.host.log,
      });
    }
  }
```

(`repoOwner` and `repoName` are the trimmed locals already validated non-empty earlier in the method. `syncReviewLoopStatusComment` is best-effort and will not throw.)

- [ ] **Step 3:** `npm run typecheck` → PASS.

- [ ] **Step 4:** `npx vitest run tests/test_cloudflare/session/pr-workflow.test.ts` → PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/session/publish-service.ts
git commit -m "Post review-loop status comment when watching starts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Backup + terminal-state sync (sweep)

**Files:** modify `apps/control-plane-worker/src/services/review-loop-sweep.ts`

Two insertion points: after backfill in the collecting reconcile pass (catches signals polled outside webhooks), and after each due epoch is processed (reflects responding/completed/blocked).

- [ ] **Step 1:** Add the import (with the other `./review-loop-*` imports):

```ts
import { syncReviewLoopStatusComment } from "./review-loop-status-comment";
```

- [ ] **Step 2:** In `reconcileCollectingTerminalSignals`, immediately after line 368. Find:

```ts
await backfillReviewLoopTerminalSignals(env, epoch, token, options.nowMs, options.logger);
```

Add directly after it (still inside the `try`):

```ts
await syncReviewLoopStatusComment(env, {
  sessionId: epoch.sessionId,
  prUrl: epoch.prUrl,
  repoOwner: epoch.repoOwner,
  repoName: epoch.repoName,
  prNumber: epoch.prNumber,
  nowMs: options.nowMs,
  logger: options.logger,
  tokenHint: token,
});
```

- [ ] **Step 3:** In `runReviewLoopSweep`, inside the `for (const epoch of due)` loop (line 805-812), after the status tallies. Find:

```ts
    if (status === "transient_deferred") result.transientDeferred += 1;
  }
```

Replace with:

```ts
    if (status === "transient_deferred") result.transientDeferred += 1;
    await syncReviewLoopStatusComment(env, {
      sessionId: epoch.sessionId,
      prUrl: epoch.prUrl,
      repoOwner: epoch.repoOwner,
      repoName: epoch.repoName,
      prNumber: epoch.prNumber,
      nowMs,
      logger,
    });
  }
```

- [ ] **Step 4:** `npm run typecheck` → PASS.

- [ ] **Step 5:** `npx vitest run tests/test_cloudflare/review-loop-sweep.test.ts` → PASS. (The existing sweep test mocks the `review-loop-epochs` and `state` modules; `review-loop-status-comment` is not mocked there, but `syncReviewLoopStatusComment` swallows errors when `env.DB`/session are absent, so it is a safe no-op. If any sweep test asserts exact mock-call counts for `createInstallationToken`, add `vi.mock("../../apps/control-plane-worker/src/services/review-loop-status-comment", () => ({ syncReviewLoopStatusComment: vi.fn() }))` to that test file.)

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-sweep.ts tests/test_cloudflare/review-loop-sweep.test.ts
git commit -m "Re-sync review-loop status comment from the sweep

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Full verification

- [ ] **Step 1:** `npx vitest run tests/test_cloudflare` → PASS (all suites).
- [ ] **Step 2:** `npm run typecheck` → PASS.
- [ ] **Step 3:** `npm run lint:changed` → PASS (or auto-fixes applied; re-stage if so).
- [ ] **Step 4:** `git diff origin/main --stat` → exactly the files in the File Structure table, plus the two spec/plan docs.

---

## Self-review notes (verified while writing)

- **Spec coverage:** table (0119) → Task 1; DAO + lease → Task 2; latest-epoch query → Task 3; label helper → Task 4; renderer (all states) + sync (create/edit/no-op/404/lease/inactive) → Task 5; live webhook edits → Task 6; watch-start post → Task 7; sweep backup + terminal states → Task 8.
- **No new setting / no UI:** confirmed — gating is the existing `resolveReviewLoopChecklist`.
- **"Post nothing" when no bots:** sync returns early when checklist not ok and no existing row (Task 5) — covered by test "skips entirely when no checklist".
- **Keep + mark Done on completion:** `completed` status renders "Done — addressed this round"; the row and comment are never deleted.
- **One comment per PR across waves:** row PK is `(session_id, pr_url)`; `getLatestReviewLoopEpochForPr` drives rendering from the newest wave.
- **Real signatures used:** `updateIssueComment(token, owner, repo, commentId, body)` and `createPrIssueComment(token, owner, repo, prNumber, body)` (verified in `github/pr.ts`); `createInstallationToken(env, installationId)`; `resolveReviewLoopChecklist(env, {ownerUserId, repoOwner, repoName})`; `getSessionState(env, sessionId)`.
- **No import cycle:** `review-loop-status-comment.ts` imports `review-loop-epochs.ts`; callers (`webhooks/github.ts`, `publish-service.ts`, `review-loop-sweep.ts`) import the status-comment module; `review-loop-epochs.ts` imports neither — acyclic.
