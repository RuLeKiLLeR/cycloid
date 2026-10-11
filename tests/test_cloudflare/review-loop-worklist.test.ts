import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

type MockFetchResponse = {
  ok: boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  // Optional endpoint matcher. When set, this response is only delivered to a request whose URL
  // contains this substring. Unlabeled responses (url omitted) fall back to FIFO order, preserving
  // every positional test. Labeling is required only when fetch chains run concurrently and their
  // paginated requests interleave (getPrReviewLoopWorklist's Promise.all), so a page-2 request no
  // longer lands in strict array order.
  url?: string;
};

let mockFetchResponses: MockFetchResponse[] = [];
let fetchUrls: string[] = [];
let fetchBodies: string[] = [];
// Optional per-request hook. When set, the mock awaits it before returning a response, letting a
// test hold every in-flight request open until it has observed the concurrency it wants to prove.
let fetchGate: ((url: string) => Promise<void>) | null = null;

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedFetch: async (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    fetchUrls.push(url);
    if (options?.body) fetchBodies.push(options.body);
    // Prefer the first queued response that matches this URL; unlabeled responses match anything so
    // FIFO behavior is unchanged for tests that do not label. This lets concurrently-interleaved
    // paginated chains each receive their own endpoint's responses regardless of arrival order.
    const idx = mockFetchResponses.findIndex((r) => r.url === undefined || url.includes(r.url));
    if (idx === -1) throw new Error(`Unexpected fetch ${url}`);
    const [response] = mockFetchResponses.splice(idx, 1);
    if (fetchGate) await fetchGate(url);
    return {
      ok: response.ok,
      status: response.status,
      headers: {
        get: (name: string) => response.headers?.[name.toLowerCase()] ?? null,
      },
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    };
  },
  tracedEnv: (env: unknown) => env,
}));

type PrModule = {
  githubGraphqlErrorsIndicateAlreadyResolved: (errors: unknown) => boolean;
  resolvePrReviewThread: (token: string, reviewThreadId: string) => Promise<void>;
  getPrReviewLoopWorklist: (
    token: string,
    owner: string,
    repo: string,
    prNumber: number,
    options: {
      expectedBots: Array<
        | { type: "known"; id: "greptile" | "coderabbit" | "cursor-bugbot" | "chatgpt-codex" | "strix" }
        | { type: "custom"; login: string }
      >;
      sourceKind?: "bot" | "human" | "mixed" | "verification";
      triggeringSourceIds?: string[];
      excludePromptedSourceRecords?: ReadonlyMap<string, number>;
      excludePromptedSourceBodyHashes?: ReadonlyMap<string, string>;
      excludeSourceIds?: ReadonlySet<string>;
      excludeSelfReplyCommentIds?: ReadonlySet<string>;
      restrictToSourceIds?: readonly string[];
      contextSourceIds?: readonly string[];
      verificationResult?: { needsWorkLabel: "verification-gap" | null; blockers: string[] } | null;
      verificationHeadSha?: string;
    },
  ) => Promise<{
    items: Array<{
      sourceId: string;
      sourceUrl: string;
      reviewThreadId?: string | null;
      authorLogin: string;
      body: string;
      verificationResult?: {
        needsWorkLabel?: "verification-gap";
        blockers: string[];
      };
      path: string | null;
      line: number | null;
      startLine: number | null;
      startSide: "LEFT" | "RIGHT" | null;
      side: "LEFT" | "RIGHT" | null;
      diffHunk: string | null;
      updatedAtMs: number;
      rawBodyHash?: string;
    }>;
    duplicateGroups: Array<{
      canonicalSourceId: string;
      duplicateSourceIds: string[];
      duplicateSources: Array<{ sourceId: string; path: string | null; line: number | null }>;
    }>;
    worklistHash: string;
    droppedItemCount: number;
    droppedBodyBytes: number;
    droppedHunkCount: number;
    droppedHunkBytes: number;
    droppedSourceIds: string[];
    noiseGatedItems: Array<{ sourceId: string; bot: string; reason: string }>;
    unpromptableItems: Array<{ sourceId: string; reason: string }>;
    liveSourceIds: string[];
  }>;
};

describe("review-loop final PR worklist", () => {
  let mod: PrModule;

  beforeAll(async () => {
    mod = (await import("../../apps/control-plane-worker/src/github/pr")) as unknown as PrModule;
  });

  afterEach(() => {
    mockFetchResponses = [];
    fetchUrls = [];
    fetchBodies = [];
    fetchGate = null;
  });

  it("drops items in excludeSourceIds before dedup/hash, without inflating the truncation counters", async () => {
    const threadsPage = {
      ok: true,
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "thread-x",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/a.ts",
                    line: 10,
                    comments: {
                      nodes: [
                        {
                          databaseId: 1001,
                          url: "https://github.com/acme/repo/pull/7#discussion_r1001",
                          body: "Already addressed on a prior head",
                          author: { login: "cursor[bot]", __typename: "Bot" },
                          updatedAt: "2026-05-25T01:00:00Z",
                          pullRequestReview: { databaseId: 7001, author: { login: "cursor[bot]", __typename: "Bot" } },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const issueComments = {
      ok: true,
      status: 200,
      body: [
        {
          id: 2001,
          html_url: "https://github.com/acme/repo/pull/7#issuecomment-2001",
          body: "Still actionable issue comment",
          user: { login: "greptile-apps[bot]", type: "Bot" },
          created_at: "2026-05-25T01:00:00Z",
          updated_at: "2026-05-25T01:00:00Z",
        },
      ],
    };
    const expectedBots = [
      { type: "known" as const, id: "cursor-bugbot" as const },
      { type: "known" as const, id: "greptile" as const },
    ];

    // Baseline: no exclusion → both the review-comment and the issue-comment are present.
    mockFetchResponses = [threadsPage, issueComments];
    const full = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, { expectedBots });
    expect(full.items.map((i) => i.sourceId).sort()).toEqual(["issue-comment:2001", "review-comment:1001"]);

    // Excluding the already-prompted review comment drops it; the issue comment survives; the hash is
    // recomputed over the retained item; and droppedItemCount stays 0 (an exclusion is not a
    // body-budget truncation).
    mockFetchResponses = [threadsPage, issueComments];
    const filtered = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots,
      excludeSourceIds: new Set(["review-comment:1001"]),
    });
    expect(filtered.items.map((i) => i.sourceId)).toEqual(["issue-comment:2001"]);
    expect(filtered.droppedItemCount).toBe(0);
    expect(filtered.droppedBodyBytes).toBe(0);
    expect(filtered.worklistHash).not.toBe(full.worklistHash);
  });

  it("carries review-comment hunks, ranges, and side without changing the worklist hash", async () => {
    const makeThreadsPage = (diffHunk: string) => ({
      ok: true,
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "thread-anchor",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/anchor.ts",
                    line: 12,
                    startLine: 10,
                    startDiffSide: "LEFT",
                    diffSide: "LEFT",
                    comments: {
                      nodes: [
                        {
                          databaseId: 1010,
                          url: "https://github.com/acme/repo/pull/7#discussion_r1010",
                          body: "This deleted branch still needs handling.",
                          diffHunk,
                          author: { login: "cursor[bot]", __typename: "Bot" },
                          updatedAt: "2026-05-25T01:00:00Z",
                          pullRequestReview: { databaseId: 7010, author: { login: "cursor[bot]", __typename: "Bot" } },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });
    const issueComments = { ok: true, status: 200, body: [] };
    const expectedBots = [{ type: "known" as const, id: "cursor-bugbot" as const }];

    mockFetchResponses = [makeThreadsPage("@@ -10,3 +10,0 @@\n-old();\n-branch();"), issueComments];
    const withHunk = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, { expectedBots });

    expect(fetchBodies[0]).toContain("diffHunk");
    expect(fetchBodies[0]).toContain("startLine");
    expect(fetchBodies[0]).toContain("diffSide");
    expect(withHunk.items[0]).toMatchObject({
      sourceId: "review-comment:1010",
      path: "src/anchor.ts",
      line: 12,
      startLine: 10,
      startSide: "LEFT",
      side: "LEFT",
      diffHunk: "@@ -10,3 +10,0 @@\n-old();\n-branch();",
    });

    mockFetchResponses = [makeThreadsPage("@@ -10,3 +10,0 @@\n-changed();"), issueComments];
    const changedHunk = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, { expectedBots });
    expect(changedHunk.items[0]?.diffHunk).toContain("changed");
    expect(changedHunk.worklistHash).toBe(withHunk.worklistHash);
  });

  it("tail-caps hunks on UTF-8 boundaries and drops hunks without dropping items when hunk budget is exhausted", async () => {
    const hugeHunk = (index: number) => `${"x".repeat(3_000)}\n-é-${index}\n+🙂-${index}`;
    mockFetchResponses = [
      {
        ok: true,
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: Array.from({ length: 13 }, (_, index) => ({
                    id: `thread-${index}`,
                    isResolved: false,
                    isOutdated: false,
                    path: `src/${index}.ts`,
                    line: index + 1,
                    startLine: index + 1,
                    startDiffSide: "RIGHT",
                    diffSide: "RIGHT",
                    comments: {
                      nodes: [
                        {
                          databaseId: 10_000 + index,
                          url: `https://github.com/acme/repo/pull/7#discussion_r${10_000 + index}`,
                          body: `Finding ${index}`,
                          diffHunk: hugeHunk(index),
                          author: { login: "cursor[bot]", __typename: "Bot" },
                          updatedAt: "2026-05-25T01:00:00Z",
                          pullRequestReview: {
                            databaseId: 9000 + index,
                            author: { login: "cursor[bot]", __typename: "Bot" },
                          },
                        },
                      ],
                    },
                  })),
                },
              },
            },
          },
        },
      },
      { ok: true, status: 200, body: [] },
    ];

    const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
    });

    expect(result.items).toHaveLength(13);
    expect(result.droppedItemCount).toBe(0);
    expect(result.droppedHunkCount).toBe(1);
    expect(result.droppedHunkBytes).toBeGreaterThan(0);
    expect(result.items[0]?.diffHunk).toContain("…[truncated for length]");
    expect(result.items[0]?.diffHunk).toContain("é-0");
    expect(result.items[0]?.diffHunk).toContain("🙂-0");
    expect(result.items.at(-1)?.diffHunk).toBeNull();
  });

  it("re-dispatches edited prompted feedback while suppressing unchanged replays", async () => {
    const threadsPage = {
      ok: true,
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "thread-x",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/a.ts",
                    line: 10,
                    comments: {
                      nodes: [
                        {
                          databaseId: 1001,
                          url: "https://github.com/acme/repo/pull/7#discussion_r1001",
                          body: "Edited after the prior prompt",
                          author: { login: "cursor[bot]", __typename: "Bot" },
                          updatedAt: "2026-05-25T02:00:00Z",
                          pullRequestReview: { databaseId: 7001, author: { login: "cursor[bot]", __typename: "Bot" } },
                        },
                        {
                          databaseId: 1002,
                          url: "https://github.com/acme/repo/pull/7#discussion_r1002",
                          body: "Unchanged replay",
                          author: { login: "cursor[bot]", __typename: "Bot" },
                          updatedAt: "2026-05-25T01:00:00Z",
                          pullRequestReview: { databaseId: 7001, author: { login: "cursor[bot]", __typename: "Bot" } },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const issueComments = { ok: true, status: 200, body: [] };

    mockFetchResponses = [threadsPage, issueComments];
    const filtered = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [{ type: "known" as const, id: "cursor-bugbot" as const }],
      excludePromptedSourceRecords: new Map([
        ["review-comment:1001", Date.parse("2026-05-25T01:30:00Z")],
        ["review-comment:1002", Date.parse("2026-05-25T01:30:00Z")],
      ]),
    });

    expect(filtered.items.map((i) => i.sourceId)).toEqual(["review-comment:1001"]);
    expect(filtered.items[0]?.body).toBe("Edited after the prior prompt");
    expect(filtered.droppedItemCount).toBe(0);
    expect(filtered.droppedBodyBytes).toBe(0);
  });

  // PR-1: a review BODY has no GitHub `updated_at` and its `submitted_at` does not change when the
  // reviewer edits the body, so timestamp dedup cannot detect an edit. These cases exercise the
  // body-hash dedup path that closes that gap (without re-admitting an unchanged body).
  const emptyThreadsPage = () => ({
    ok: true,
    status: 200,
    body: {
      data: {
        repository: {
          pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        },
      },
    },
  });
  const reviewBodiesResponse = (reviews: Array<{ id: number; body: string; submitted_at: string }>) => ({
    ok: true,
    status: 200,
    body: reviews.map((review) => ({
      id: review.id,
      body: review.body,
      state: "CHANGES_REQUESTED",
      user: { login: "alice", type: "User" },
      html_url: `https://github.com/acme/repo/pull/7#pullrequestreview-${review.id}`,
      submitted_at: review.submitted_at,
    })),
  });
  // submitted_at is fixed across waves on purpose: the reviewer edits the body in place, which does
  // NOT advance submitted_at — the exact condition that defeats timestamp dedup.
  const SUBMITTED_AT = "2026-05-25T02:00:00Z";
  const promptedAfter = Date.parse("2026-05-25T02:30:00Z"); // a prompt time strictly after submitted_at

  it("re-admits an edited review body via body-hash even though submitted_at is unchanged", async () => {
    // Wave 1: prompt the original body and capture the persisted hash.
    mockFetchResponses = [
      emptyThreadsPage(),
      { ok: true, status: 200, body: [] },
      reviewBodiesResponse([{ id: 9100, body: "Original review body", submitted_at: SUBMITTED_AT }]),
    ];
    const wave1 = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [],
      sourceKind: "human",
      triggeringSourceIds: ["human:9100"],
    });
    expect(wave1.items.map((i) => i.sourceId)).toEqual(["review-body:9100"]);
    const storedHash = wave1.items[0]?.rawBodyHash;
    expect(storedHash).toBeTruthy();

    // Wave 2: the body text changed (different hash); submitted_at is still SUBMITTED_AT and the
    // prompt time is AFTER it, so timestamp dedup alone would suppress it. Hash dedup re-admits it.
    mockFetchResponses = [
      emptyThreadsPage(),
      { ok: true, status: 200, body: [] },
      reviewBodiesResponse([
        { id: 9100, body: "Edited review body — also fix the retry path", submitted_at: SUBMITTED_AT },
      ]),
    ];
    const wave2 = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [],
      sourceKind: "human",
      triggeringSourceIds: ["human:9100"],
      excludePromptedSourceRecords: new Map([["review-body:9100", promptedAfter]]),
      excludePromptedSourceBodyHashes: new Map([["review-body:9100", storedHash as string]]),
    });
    expect(wave2.items.map((i) => i.sourceId)).toEqual(["review-body:9100"]);
    expect(wave2.items[0]?.body).toBe("Edited review body — also fix the retry path");
  });

  it("accepts the canonical review-body:<id> trigger namespace too (dual-read; human: is the live/flip form)", async () => {
    mockFetchResponses = [
      emptyThreadsPage(),
      { ok: true, status: 200, body: [] },
      reviewBodiesResponse([{ id: 9100, body: "Original review body", submitted_at: SUBMITTED_AT }]),
    ];
    const wave = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [],
      sourceKind: "human",
      triggeringSourceIds: ["review-body:9100"],
    });
    expect(wave.items.map((i) => i.sourceId)).toEqual(["review-body:9100"]);
  });

  it("suppresses an unchanged review body when its stored hash matches (no re-answer)", async () => {
    mockFetchResponses = [
      emptyThreadsPage(),
      { ok: true, status: 200, body: [] },
      reviewBodiesResponse([{ id: 9100, body: "Original review body", submitted_at: SUBMITTED_AT }]),
    ];
    const wave1 = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [],
      sourceKind: "human",
      triggeringSourceIds: ["human:9100"],
    });
    const storedHash = wave1.items[0]?.rawBodyHash as string;

    mockFetchResponses = [
      emptyThreadsPage(),
      { ok: true, status: 200, body: [] },
      reviewBodiesResponse([{ id: 9100, body: "Original review body", submitted_at: SUBMITTED_AT }]),
    ];
    const wave2 = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [],
      sourceKind: "human",
      triggeringSourceIds: ["human:9100"],
      excludePromptedSourceRecords: new Map([["review-body:9100", promptedAfter]]),
      excludePromptedSourceBodyHashes: new Map([["review-body:9100", storedHash]]),
    });
    expect(wave2.items).toHaveLength(0);
    expect(wave2.droppedItemCount).toBe(0);
  });

  it("falls back to timestamp dedup for a review body with no stored hash (legacy record)", async () => {
    // No excludePromptedSourceBodyHashes entry → legacy behavior: review-body uses submitted_at.
    // promptedAfter > submitted_at, so an edit is (still) suppressed — proving fail-open to the old path.
    mockFetchResponses = [
      emptyThreadsPage(),
      { ok: true, status: 200, body: [] },
      reviewBodiesResponse([
        { id: 9100, body: "Edited body but legacy record has no hash", submitted_at: SUBMITTED_AT },
      ]),
    ];
    const legacySuppressed = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [],
      sourceKind: "human",
      triggeringSourceIds: ["human:9100"],
      excludePromptedSourceRecords: new Map([["review-body:9100", promptedAfter]]),
    });
    expect(legacySuppressed.items).toHaveLength(0);

    // And when the prompt time predates submitted_at, the timestamp path admits it (newer activity).
    mockFetchResponses = [
      emptyThreadsPage(),
      { ok: true, status: 200, body: [] },
      reviewBodiesResponse([{ id: 9100, body: "Body submitted after the prior prompt", submitted_at: SUBMITTED_AT }]),
    ];
    const legacyAdmitted = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [],
      sourceKind: "human",
      triggeringSourceIds: ["human:9100"],
      excludePromptedSourceRecords: new Map([["review-body:9100", Date.parse("2026-05-25T01:00:00Z")]]),
    });
    expect(legacyAdmitted.items.map((i) => i.sourceId)).toEqual(["review-body:9100"]);
  });

  it("hashes the RAW body, not the budget-capped body, so a beyond-cap tail edit is re-admitted", async () => {
    // Both bodies share an identical first-4KB prefix (the capped body is byte-identical) but differ
    // only past the per-item cap. Hashing the capped body would wrongly suppress the edit; hashing
    // the raw body catches it.
    const prefix = "x".repeat(5000);
    mockFetchResponses = [
      emptyThreadsPage(),
      { ok: true, status: 200, body: [] },
      reviewBodiesResponse([{ id: 9100, body: `${prefix}AAAA`, submitted_at: SUBMITTED_AT }]),
    ];
    const wave1 = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [],
      sourceKind: "human",
      triggeringSourceIds: ["human:9100"],
    });
    const storedHash = wave1.items[0]?.rawBodyHash as string;

    mockFetchResponses = [
      emptyThreadsPage(),
      { ok: true, status: 200, body: [] },
      reviewBodiesResponse([{ id: 9100, body: `${prefix}BBBB`, submitted_at: SUBMITTED_AT }]),
    ];
    const wave2 = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [],
      sourceKind: "human",
      triggeringSourceIds: ["human:9100"],
      excludePromptedSourceRecords: new Map([["review-body:9100", promptedAfter]]),
      excludePromptedSourceBodyHashes: new Map([["review-body:9100", storedHash]]),
    });
    expect(wave2.items.map((i) => i.sourceId)).toEqual(["review-body:9100"]);
  });

  it("uses timestamp dedup for non-review-body kinds even if a body hash is supplied", async () => {
    // A review-comment carries a real updatedAt, so it must never take the hash path. Supply a bogus
    // hash for it and assert the timestamp still governs: newer updatedAt → admitted.
    const threadsPage = {
      ok: true,
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "thread-x",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/a.ts",
                    line: 10,
                    comments: {
                      nodes: [
                        {
                          databaseId: 1001,
                          url: "https://github.com/acme/repo/pull/7#discussion_r1001",
                          body: "Edited inline comment",
                          author: { login: "cursor[bot]", __typename: "Bot" },
                          updatedAt: "2026-05-25T03:00:00Z",
                          pullRequestReview: { databaseId: 7001, author: { login: "cursor[bot]", __typename: "Bot" } },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };
    mockFetchResponses = [threadsPage, { ok: true, status: 200, body: [] }];
    const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [{ type: "known" as const, id: "cursor-bugbot" as const }],
      excludePromptedSourceRecords: new Map([["review-comment:1001", Date.parse("2026-05-25T01:00:00Z")]]),
      excludePromptedSourceBodyHashes: new Map([["review-comment:1001", "deadbeef-not-a-real-hash"]]),
    });
    // updatedAt (03:00) is newer than the prompt time (01:00) → admitted via timestamp, hash ignored.
    expect(result.items.map((i) => i.sourceId)).toEqual(["review-comment:1001"]);
    expect(result.items[0]?.rawBodyHash).toBeUndefined();
  });

  it("paginates review threads and issue comments, filters resolved/outdated/empty items, and hashes deterministically", async () => {
    // Both the review-thread (GraphQL) and issue-comment (REST) chains paginate. Because
    // getPrReviewLoopWorklist runs them concurrently, their page requests interleave, so responses
    // are labeled by endpoint (`url`) rather than relying on strict FIFO array order.
    mockFetchResponses = [
      {
        ok: true,
        status: 200,
        url: "graphql",
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: true, endCursor: "thread-cursor-1" },
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/a.ts",
                      line: 10,
                      comments: {
                        nodes: [
                          {
                            databaseId: 1001,
                            url: "https://github.com/acme/repo/pull/7#discussion_r1001",
                            body: "Handle null here",
                            author: { login: "cursor[bot]", __typename: "Bot" },
                            updatedAt: "2026-05-25T01:00:00Z",
                            pullRequestReview: {
                              databaseId: 7001,
                              author: { login: "cursor[bot]", __typename: "Bot" },
                            },
                          },
                        ],
                      },
                    },
                    {
                      id: "thread-2",
                      isResolved: true,
                      isOutdated: false,
                      path: "src/old.ts",
                      line: 3,
                      comments: {
                        nodes: [
                          {
                            databaseId: 1002,
                            url: "https://github.com/acme/repo/pull/7#discussion_r1002",
                            body: "resolved",
                            author: { login: "cursor[bot]", __typename: "Bot" },
                            updatedAt: "2026-05-25T01:00:00Z",
                            pullRequestReview: {
                              databaseId: 7001,
                              author: { login: "cursor[bot]", __typename: "Bot" },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        url: "graphql",
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "thread-3",
                      isResolved: false,
                      isOutdated: true,
                      path: "src/outdated.ts",
                      line: 1,
                      comments: {
                        nodes: [
                          {
                            databaseId: 1003,
                            url: "https://github.com/acme/repo/pull/7#discussion_r1003",
                            body: "outdated",
                            author: { login: "cursor[bot]", __typename: "Bot" },
                            updatedAt: "2026-05-25T01:02:00Z",
                            pullRequestReview: {
                              databaseId: 7002,
                              author: { login: "cursor[bot]", __typename: "Bot" },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        url: "/issues/7/comments",
        headers: { link: '<https://api.github.com/repos/acme/repo/issues/7/comments?page=2>; rel="next"' },
        body: [
          {
            id: 2001,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-2001",
            body: "Top level actionable",
            user: { login: "greptile-apps[bot]", type: "Bot" },
            created_at: "2026-05-25T01:00:00Z",
            updated_at: "2026-05-25T01:00:00Z",
          },
          {
            id: 2002,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-2002",
            body: "   ",
            user: { login: "greptile-apps[bot]", type: "Bot" },
            created_at: "2026-05-25T01:01:00Z",
            updated_at: "2026-05-25T01:01:00Z",
          },
        ],
      },
      {
        ok: true,
        status: 200,
        url: "/issues/7/comments",
        body: [
          {
            id: 2003,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-2003",
            body: "Top level actionable",
            user: { login: "greptile-apps[bot]", type: "Bot" },
            created_at: "2026-05-25T01:02:00Z",
            updated_at: "2026-05-25T01:02:00Z",
          },
        ],
      },
    ];

    const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [
        { type: "known", id: "cursor-bugbot" },
        { type: "known", id: "greptile" },
      ],
    });

    // The three chains run concurrently, so page requests interleave; assert both endpoints fully
    // paginated rather than a fixed cross-endpoint request order. GraphQL is always the thread
    // chain's first request (index 0). The thread chain's page-2 request carries the cursor; only
    // GraphQL requests have a POST body, so fetchBodies order is unaffected by REST interleaving.
    expect(fetchUrls[0]).toBe("https://api.github.com/graphql");
    expect(fetchUrls.filter((u) => u === "https://api.github.com/graphql")).toHaveLength(2);
    expect(fetchBodies.some((b) => b.includes("thread-cursor-1"))).toBe(true);
    expect(fetchUrls.some((u) => u.includes("/repos/acme/repo/issues/7/comments?per_page=100"))).toBe(true);
    expect(fetchUrls.some((u) => u.includes("page=2"))).toBe(true);
    // The budget loop iterates in a deterministic order that preserves the historical cross-kind
    // precedence (review-comment threads before issue comments), with sourceId as the within-kind
    // tiebreak. The set and the (order-insensitive) hash are unchanged.
    expect(result.items.map((item) => item.sourceId)).toEqual(["review-comment:1001", "issue-comment:2001"]);
    expect(result.items[0]).toMatchObject({
      sourceUrl: "https://github.com/acme/repo/pull/7#discussion_r1001",
      reviewThreadId: "thread-1",
      authorLogin: "cursor[bot]",
      path: "src/a.ts",
      body: "Handle null here",
    });
    expect(result.duplicateGroups).toEqual([
      {
        canonicalSourceId: "issue-comment:2001",
        duplicateSourceIds: ["issue-comment:2003"],
        duplicateSources: [{ sourceId: "issue-comment:2003", path: null, line: null }],
      },
    ]);
    expect(result.worklistHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves a review thread with GitHub GraphQL and treats already-resolved errors as success", async () => {
    mockFetchResponses = [
      {
        ok: true,
        status: 200,
        body: {
          data: {
            resolveReviewThread: {
              thread: { id: "thread-1", isResolved: true },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        body: {
          errors: [{ message: "Review thread is already resolved" }],
        },
      },
    ];

    await expect(mod.resolvePrReviewThread("token", "thread-1")).resolves.toBeUndefined();
    await expect(mod.resolvePrReviewThread("token", "thread-1")).resolves.toBeUndefined();

    expect(fetchUrls).toEqual(["https://api.github.com/graphql", "https://api.github.com/graphql"]);
    expect(fetchBodies[0]).toContain("resolveReviewThread");
    expect(fetchBodies[0]).toContain('"threadId":"thread-1"');
  });

  it("classifies only already-resolved GraphQL errors as idempotent review-thread resolution", () => {
    expect(mod.githubGraphqlErrorsIndicateAlreadyResolved([{ message: "Review thread is already resolved" }])).toBe(
      true,
    );
    expect(
      mod.githubGraphqlErrorsIndicateAlreadyResolved([
        { message: "Review thread is already resolved" },
        { message: "Could not resolve review thread" },
      ]),
    ).toBe(false);
    expect(mod.githubGraphqlErrorsIndicateAlreadyResolved([{ message: "Review thread is already resolved" }, {}])).toBe(
      false,
    );
    expect(mod.githubGraphqlErrorsIndicateAlreadyResolved([])).toBe(false);
  });

  it("filters final worklist to configured verified bot authors and canonicalizes capped bodies", async () => {
    const longBody = `Long finding ${"x".repeat(5_000)}`;
    mockFetchResponses = [
      {
        ok: true,
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "thread-configured",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/filter.ts",
                      line: 20,
                      comments: {
                        nodes: [
                          {
                            databaseId: 3001,
                            url: "https://github.com/acme/repo/pull/7#discussion_r3001",
                            body: longBody,
                            author: { login: "cursor[bot]", __typename: "Bot" },
                            updatedAt: "2026-05-25T01:01:00Z",
                            pullRequestReview: {
                              databaseId: 7101,
                              author: { login: "cursor[bot]", __typename: "Bot" },
                            },
                          },
                          {
                            databaseId: 3002,
                            url: "https://github.com/acme/repo/pull/7#discussion_r3002",
                            body: "Human reply should be dropped",
                            author: { login: "octocat", __typename: "User" },
                            updatedAt: "2026-05-25T01:02:00Z",
                            pullRequestReview: {
                              databaseId: 7101,
                              author: { login: "cursor[bot]", __typename: "Bot" },
                            },
                          },
                        ],
                      },
                    },
                    {
                      id: "thread-unconfigured",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/other.ts",
                      line: 3,
                      comments: {
                        nodes: [
                          {
                            databaseId: 3003,
                            url: "https://github.com/acme/repo/pull/7#discussion_r3003",
                            body: "Unconfigured bot should be dropped",
                            author: { login: "coderabbitai[bot]", __typename: "Bot" },
                            updatedAt: "2026-05-25T01:03:00Z",
                            pullRequestReview: {
                              databaseId: 7102,
                              author: { login: "coderabbitai[bot]", __typename: "Bot" },
                            },
                          },
                        ],
                      },
                    },
                    {
                      id: "thread-mismatched-review-author",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/mismatch.ts",
                      line: 4,
                      comments: {
                        nodes: [
                          {
                            databaseId: 3004,
                            url: "https://github.com/acme/repo/pull/7#discussion_r3004",
                            body: "Mismatched review actor should be dropped",
                            author: { login: "cursor[bot]", __typename: "Bot" },
                            updatedAt: "2026-05-25T01:04:00Z",
                            pullRequestReview: {
                              databaseId: 7103,
                              author: { login: "coderabbitai[bot]", __typename: "Bot" },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        body: [
          {
            id: 4001,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-4001",
            body: "Greptile actionable summary",
            user: { login: "greptile-apps[bot]", type: "Bot" },
            created_at: "2026-05-25T01:05:00Z",
            updated_at: "2026-05-25T01:05:00Z",
          },
          {
            id: 4002,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-4002",
            body: "[RESOLVE PARENT COMMENT] already handled",
            user: { login: "cycloid[bot]", type: "Bot" },
            created_at: "2026-05-25T01:06:00Z",
            updated_at: "2026-05-25T01:06:00Z",
          },
          {
            id: 4003,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-4003",
            body: "Review complete",
            user: { login: "greptile-apps[bot]", type: "Bot" },
            created_at: "2026-05-25T01:07:00Z",
            updated_at: "2026-05-25T01:07:00Z",
          },
          {
            id: 4004,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-4004",
            body: "Custom user should be dropped",
            user: { login: "review-pal", type: "User" },
            created_at: "2026-05-25T01:08:00Z",
            updated_at: "2026-05-25T01:08:00Z",
          },
          {
            id: 4005,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-4005",
            body: "Custom bot should stay even if it quotes [RESOLVE PARENT COMMENT]",
            user: { login: "review-pal", type: "Bot" },
            created_at: "2026-05-25T01:09:00Z",
            updated_at: "2026-05-25T01:09:00Z",
          },
        ],
      },
    ];

    const expectedBots = [
      { type: "known" as const, id: "cursor-bugbot" as const },
      { type: "known" as const, id: "greptile" as const },
      { type: "custom" as const, login: "review-pal" },
    ];
    const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, { expectedBots });
    // Deterministic order preserving cross-kind precedence: the review-comment thread before issue
    // comments (sorted by id). Same set + same order-insensitive hash as before the stable sort.
    expect(result.items.map((item) => item.sourceId)).toEqual([
      "review-comment:3001",
      // coderabbitai[bot] is not in this repo's expectedBots, but it is still ingested because it's a
      // known-registry reviewer (allow-list posture — see resolveIngestBotKey).
      "review-comment:3003",
      "issue-comment:4001",
      "issue-comment:4005",
    ]);
    expect(result.items[0].body).toContain("\n…[truncated for length]\n");
    expect(result.items[0].body.length).toBeLessThanOrEqual(4_096);
    expect(result.items[3].body).toContain("[RESOLVE PARENT COMMENT]");
    expect(result.worklistHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("drops a User-type account whose login matches a known bot alias (PR-6 authorType gate)", async () => {
    // A `User` account named `cursor` (the cursor-bugbot alias) must NOT be folded into the worklist;
    // only a real Bot-typed actor counts. Previously the known branch matched on alias alone.
    const threadsPage = {
      ok: true,
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "thread-impostor",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/a.ts",
                    line: 1,
                    comments: {
                      nodes: [
                        {
                          databaseId: 6001,
                          url: "https://github.com/acme/repo/pull/7#discussion_r6001",
                          body: "Impostor comment from a User account named cursor",
                          author: { login: "cursor", __typename: "User" },
                          updatedAt: "2026-05-25T01:00:00Z",
                          pullRequestReview: { databaseId: 7201, author: { login: "cursor", __typename: "User" } },
                        },
                      ],
                    },
                  },
                  {
                    id: "thread-real",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/b.ts",
                    line: 2,
                    comments: {
                      nodes: [
                        {
                          databaseId: 6002,
                          url: "https://github.com/acme/repo/pull/7#discussion_r6002",
                          body: "Real bot finding",
                          author: { login: "cursor[bot]", __typename: "Bot" },
                          updatedAt: "2026-05-25T01:01:00Z",
                          pullRequestReview: { databaseId: 7202, author: { login: "cursor[bot]", __typename: "Bot" } },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };
    mockFetchResponses = [threadsPage, { ok: true, status: 200, body: [] }];
    const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [{ type: "known" as const, id: "cursor-bugbot" as const }],
    });
    expect(result.items.map((i) => i.sourceId)).toEqual(["review-comment:6002"]);
  });

  it("drops generated summary issue comments from any configured bot when they contain no actionable findings", async () => {
    mockFetchResponses = [
      {
        ok: true,
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        body: [
          {
            id: 5001,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-5001",
            body: `<!-- This is an auto-generated review summary -->
<details><summary>Recent review info</summary>
Review profile: CHILL
</details>
<!-- walkthrough_start -->
<details><summary>Walkthrough</summary>
This PR standardizes sendability error responses.
</details>
<!-- walkthrough_end -->`,
            user: { login: "summary-bot", type: "Bot" },
            created_at: "2026-05-25T01:00:00Z",
            updated_at: "2026-05-25T01:00:00Z",
          },
        ],
      },
    ];

    const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [{ type: "custom", login: "summary-bot" }],
    });

    expect(result.items).toEqual([]);
  });

  it("reduces generated summary issue comments from any configured bot to explicit actionable sections", async () => {
    mockFetchResponses = [
      {
        ok: true,
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        body: [
          {
            id: 6001,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-6001",
            body: `<h3>Review Summary</h3>
This PR fixes the structured envelope.
<h3>Confidence Score: 4/5</h3>
Safe to merge, with minor observations.
<h3>Important Files Changed</h3>
apps/control-plane-worker/src/session/prompt-queue.ts | Overview text.
<h3>Sequence Diagram</h3>
sequenceDiagram
<details open><summary><h3>Actionable Comments (1)</h3></summary>

1. \`apps/control-plane-worker/src/webhooks/github.ts\`, line 294 ([link](https://github.com/acme/repo/blob/abc/apps/control-plane-worker/src/webhooks/github.ts#L294))

   <a href="#"><img alt="P2" src="https://example.com/badges/p2.svg" align="top"></a> The fallback value \`"session_not_sendable"\` is the error code, not a descriptive phase reason.

</details>`,
            user: { login: "summary-bot", type: "Bot" },
            created_at: "2026-05-25T01:00:00Z",
            updated_at: "2026-05-25T01:00:00Z",
          },
        ],
      },
    ];

    const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [{ type: "custom", login: "summary-bot" }],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceId).toBe("issue-comment:6001");
    expect(result.items[0].body).toContain("Actionable Comments");
    expect(result.items[0].body).toContain("The fallback value");
    expect(result.items[0].body).not.toContain("Confidence Score");
    expect(result.items[0].body).not.toContain("Sequence Diagram");
  });
  it("drops generated summary actionable headings with no finding body", async () => {
    mockFetchResponses = [
      {
        ok: true,
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        body: [
          {
            id: 6501,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-6501",
            body: `<h3>Review Summary</h3>
This PR changes generated summary extraction.
<h3>Confidence Score: 5/5</h3>
Safe to merge.
<details><summary><h3>Comments Outside Diff (0)</h3></summary>

</details>`,
            user: { login: "summary-bot", type: "Bot" },
            created_at: "2026-05-25T01:00:00Z",
            updated_at: "2026-05-25T01:00:00Z",
          },
        ],
      },
    ];

    const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [{ type: "custom", login: "summary-bot" }],
    });

    expect(result.items).toEqual([]);
  });
  it("keeps later actionable sections and skips empty actionable buckets", async () => {
    mockFetchResponses = [
      {
        ok: true,
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        },
      },
      {
        ok: true,
        status: 200,
        body: [
          {
            id: 7001,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-7001",
            body: `<h3>Review Summary</h3>
This PR changes generated summary extraction.
<h3>Confidence Score: 4/5</h3>
Safe except one issue.
<details><summary><h3>Actionable Comments (0)</h3></summary>

</details>
<details><summary><h3>Comments Outside Diff (1)</h3></summary>

1. \`apps/control-plane-worker/src/github/pr.ts\`, line 906

   Preserve actionable sections that appear after empty actionable buckets.

</details>
<h3>Important Files Changed</h3>
apps/control-plane-worker/src/github/pr.ts | Overview text.`,
            user: { login: "summary-bot", type: "Bot" },
            created_at: "2026-05-25T01:00:00Z",
            updated_at: "2026-05-25T01:00:00Z",
          },
        ],
      },
    ];

    const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
      expectedBots: [{ type: "custom", login: "summary-bot" }],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceId).toBe("issue-comment:7001");
    expect(result.items[0].body).toContain("Comments Outside Diff");
    expect(result.items[0].body).toContain("Preserve actionable sections");
    expect(result.items[0].body).not.toContain("Actionable Comments (0)");
    expect(result.items[0].body).not.toContain("Confidence Score");
    expect(result.items[0].body).not.toContain("Important Files Changed");
  });

  // Task 16: sourceKind / triggeringSourceIds filtering
  describe("sourceKind filtering", () => {
    function makeThreadPayload(
      threads: Array<{
        id: string;
        databaseId: number;
        authorLogin: string;
        authorType: string;
        reviewDatabaseId: number;
        reviewAuthorLogin: string;
        reviewAuthorType: string;
        body: string;
        isResolved?: boolean;
        isOutdated?: boolean;
      }>,
    ) {
      return {
        ok: true,
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: threads.map((t) => ({
                    id: t.id,
                    isResolved: t.isResolved ?? false,
                    isOutdated: t.isOutdated ?? false,
                    path: "src/app.ts",
                    line: 10,
                    comments: {
                      nodes: [
                        {
                          databaseId: t.databaseId,
                          url: `https://github.com/acme/repo/pull/7#discussion_r${t.databaseId}`,
                          body: t.body,
                          author: { login: t.authorLogin, __typename: t.authorType },
                          updatedAt: "2026-05-25T01:00:00Z",
                          pullRequestReview: {
                            databaseId: t.reviewDatabaseId,
                            author: { login: t.reviewAuthorLogin, __typename: t.reviewAuthorType },
                          },
                        },
                      ],
                    },
                  })),
                },
              },
            },
          },
        },
      };
    }

    function emptyIssueComments() {
      return { ok: true, status: 200, body: [] };
    }

    function emptyReviews() {
      return { ok: true, status: 200, body: [] };
    }

    function botThreadPayload() {
      return makeThreadPayload([
        {
          id: "thread-9700",
          databaseId: 8700,
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          reviewDatabaseId: 7700,
          reviewAuthorLogin: "cursor[bot]",
          reviewAuthorType: "Bot",
          body: "Inline bot note.",
        },
      ]);
    }

    function humanReviewBodyResponse() {
      return {
        ok: true,
        status: 200,
        body: [
          {
            id: 9700,
            body: "Top-level review ask.",
            state: "CHANGES_REQUESTED",
            user: { login: "dana", type: "User" },
            html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9700",
            submitted_at: "2026-05-25T02:00:00Z",
          },
        ],
      };
    }

    function endpointOf(url: string): "threads" | "issueComments" | "reviewBodies" {
      if (url.includes("graphql")) return "threads";
      if (url.includes("/issues/")) return "issueComments";
      return "reviewBodies";
    }

    // PERF-103: getPrReviewLoopWorklist runs the three fetch chains concurrently. This barrier holds
    // every in-flight request open until all three endpoints have been requested. Sequential fetches
    // would await the first request before issuing the next, so the barrier would never open and the
    // test would time out — the exact regression this guards against.
    it("fetches review threads, issue comments, and human review bodies concurrently", async () => {
      const requested = new Set<string>();
      let releaseAll: () => void = () => {};
      const allRequested = new Promise<void>((resolve) => {
        releaseAll = resolve;
      });
      fetchGate = async (url) => {
        requested.add(endpointOf(url));
        if (requested.size === 3) releaseAll();
        await allRequested;
      };
      mockFetchResponses = [
        { ...botThreadPayload(), url: "graphql" },
        { ...emptyIssueComments(), url: "/issues/" },
        { ...humanReviewBodyResponse(), url: "/reviews" },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "mixed",
        triggeringSourceIds: ["human:9700"],
      });

      expect(requested).toEqual(new Set(["threads", "issueComments", "reviewBodies"]));
      expect(result.items.map((i) => i.sourceId).sort()).toEqual(["review-body:9700", "review-comment:8700"]);
    }, 5000);

    // PERF-103: the worklist is assembled by a deterministic sort, so its hash must not depend on the
    // order in which the concurrent fetch chains resolve. Run the same fixed responses twice while
    // releasing the endpoints in opposite orders and assert identical output.
    it("produces an identical worklist hash regardless of fetch resolution order", async () => {
      async function runWithReleaseOrder(order: Array<"threads" | "issueComments" | "reviewBodies">) {
        const deferreds = new Map<string, { promise: Promise<void>; resolve: () => void }>();
        for (const key of ["threads", "issueComments", "reviewBodies"]) {
          let resolve: () => void = () => {};
          const promise = new Promise<void>((r) => {
            resolve = r;
          });
          deferreds.set(key, { promise, resolve });
        }
        const requested = new Set<string>();
        fetchGate = async (url) => {
          const key = endpointOf(url);
          requested.add(key);
          if (requested.size === 3) {
            for (const releaseKey of order) deferreds.get(releaseKey)?.resolve();
          }
          await deferreds.get(key)?.promise;
        };
        mockFetchResponses = [
          { ...botThreadPayload(), url: "graphql" },
          { ...emptyIssueComments(), url: "/issues/" },
          { ...humanReviewBodyResponse(), url: "/reviews" },
        ];
        return mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
          expectedBots: [{ type: "known", id: "cursor-bugbot" }],
          sourceKind: "mixed",
          triggeringSourceIds: ["human:9700"],
        });
      }

      const forward = await runWithReleaseOrder(["threads", "issueComments", "reviewBodies"]);
      const reversed = await runWithReleaseOrder(["reviewBodies", "issueComments", "threads"]);

      expect(forward.worklistHash).toBe(reversed.worklistHash);
      expect(forward.items.map((i) => i.sourceId)).toEqual(reversed.items.map((i) => i.sourceId));
    }, 5000);

    it("hits the reviews endpoint only for human/mixed epochs, never for bot", async () => {
      mockFetchResponses = [
        { ...makeThreadPayload([]), url: "graphql" },
        { ...emptyIssueComments(), url: "/issues/" },
      ];
      await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "bot",
        triggeringSourceIds: ["human:9700"],
      });
      expect(fetchUrls.some((u) => u.includes("/pulls/7/reviews"))).toBe(false);

      fetchUrls.length = 0;
      mockFetchResponses = [
        { ...makeThreadPayload([]), url: "graphql" },
        { ...emptyIssueComments(), url: "/issues/" },
        { ...humanReviewBodyResponse(), url: "/reviews" },
      ];
      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "mixed",
        triggeringSourceIds: ["human:9700"],
      });
      expect(fetchUrls.some((u) => u.includes("/pulls/7/reviews"))).toBe(true);
      expect(result.items.map((i) => i.sourceId)).toEqual(["review-body:9700"]);
    });

    const QA_MARKER = "<!-- cycloid-qa:v1 owner=acme repo=repo pr=7 head=abc123 -->";
    const LEGACY_VERIFICATION_MARKER = "<!-- cycloid-" + "verification:v1 owner=acme repo=repo pr=7 head=abc123 -->";
    const QA_COMMENT_BODY = `${QA_MARKER}\n\n## Cycloid QA\n\n**Verdict:** INCONCLUSIVE\n\n### Blockers\n\n- tests missing`;
    const LEGACY_VERIFICATION_COMMENT_BODY = `${LEGACY_VERIFICATION_MARKER}\n\n## Cycloid QA\n\n**Verdict:** INCONCLUSIVE\n\n### Blockers\n\n- tests missing`;

    function verificationIssueComments() {
      return {
        ok: true,
        status: 200,
        body: [
          {
            id: 5001,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-5001",
            body: QA_COMMENT_BODY,
            user: { login: "cycloid[bot]", type: "Bot" },
            updated_at: "2026-06-11T01:00:00Z",
          },
          {
            id: 5002,
            html_url: "https://github.com/acme/repo/pull/7#issuecomment-5002",
            body: "Cycloid: this branch has merge conflicts with its base branch.",
            user: { login: "cycloid[bot]", type: "Bot" },
            updated_at: "2026-06-11T01:01:00Z",
          },
        ],
      };
    }

    it("verification sourceKind does not admit the removed legacy marker", async () => {
      mockFetchResponses = [
        makeThreadPayload([]),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 5003,
              html_url: "https://github.com/acme/repo/pull/7#issuecomment-5003",
              body: LEGACY_VERIFICATION_COMMENT_BODY,
              user: { login: "cycloid[bot]", type: "Bot" },
              updated_at: "2026-06-11T01:00:00Z",
            },
          ],
        },
      ];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "verification",
      });

      expect(worklist.items.map((item) => item.sourceId)).toEqual([]);
    });

    // ── A4 single-intake — the synthetic `verification-verdict:*` worklist item is removed. The QA verdict
    // is intaken exactly once, from the restored managed QA comment admitted as `known:cycloid-qa`
    // (covered in "managed QA comment intake (A4)" below). A verification epoch with no admitted QA comment
    // yields an empty worklist (no synth substitute). ──
    it("does not synthesize a verification worklist item when no QA comment is present", async () => {
      mockFetchResponses = [makeThreadPayload([]), emptyIssueComments()];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "verification",
        triggeringSourceIds: ["verification:head-xyz:3"],
      });

      expect(worklist.items).toEqual([]);
      expect(worklist.items.some((i) => i.sourceId.startsWith("verification-verdict:"))).toBe(false);
    });

    // ── noise gate (D4) — a known bot's purely-informational output never becomes a worklist item ──
    it("noise gate drops a bot's no-findings issue comment (the prod exhibit) and reports it in noiseGatedItems", async () => {
      mockFetchResponses = [
        makeThreadPayload([]),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 4862622839,
              html_url: "https://github.com/acme/repo/pull/7#issuecomment-4862622839",
              body: "No security issues found.",
              user: { login: "strix[bot]", type: "Bot" },
              updated_at: "2026-07-02T01:00:00Z",
            },
          ],
        },
      ];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "strix" }],
        sourceKind: "bot",
      });

      expect(worklist.items).toEqual([]);
      expect(worklist.noiseGatedItems).toEqual([
        { sourceId: "issue-comment:4862622839", bot: "known:strix", reason: "no_findings" },
      ]);
    });

    it("noise gate keeps a bot's issue comment that carries real findings", async () => {
      mockFetchResponses = [
        makeThreadPayload([]),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 555,
              html_url: "https://github.com/acme/repo/pull/7#issuecomment-555",
              body: "Found a path traversal in fileHandler.ts — sanitize the input before use.",
              user: { login: "strix[bot]", type: "Bot" },
              updated_at: "2026-07-02T01:00:00Z",
            },
          ],
        },
      ];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "strix" }],
        sourceKind: "bot",
      });

      expect(worklist.items.map((item) => item.sourceId)).toEqual(["issue-comment:555"]);
      expect(worklist.noiseGatedItems).toEqual([]);
    });

    it("noise gate drops a bot's 'in progress' placeholder issue comment (PR #7118) as in_progress", async () => {
      mockFetchResponses = [
        makeThreadPayload([]),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 4909514271,
              html_url: "https://github.com/acme/repo/pull/7#issuecomment-4909514271",
              body: "<!-- strix-pr-review:master -->\n## Strix Security Review\n\nSecurity review in progress.\n\n<sub>Updated for `9c9371f`.</sub>\n\n*Reviewed by [Strix](https://strix.ai)*",
              user: { login: "strix-security[bot]", type: "Bot" },
              updated_at: "2026-07-07T01:00:00Z",
            },
          ],
        },
      ];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "strix" }],
        sourceKind: "bot",
      });

      expect(worklist.items).toEqual([]);
      expect(worklist.noiseGatedItems).toEqual([
        { sourceId: "issue-comment:4909514271", bot: "known:strix", reason: "in_progress" },
      ]);
    });

    it("re-admits the SAME mutable comment once Strix edits the placeholder into real findings", async () => {
      // getPrReviewLoopWorklist is stateless + body-driven: it re-fetches GitHub every sweep. Once the same
      // comment id flips from the placeholder body to findings, a later wave's worklist includes it (it was
      // never prompted while gated, so nothing dedups it). This is why gating the placeholder does NOT drop
      // the findings — cf. the epoch-layer new-wave proof in review-loop-epochs.test.ts.
      mockFetchResponses = [
        makeThreadPayload([]),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 4909514271,
              html_url: "https://github.com/acme/repo/pull/7#issuecomment-4909514271",
              body: "## Strix Security Review\n\nHigh-severity path traversal in fileHandler.ts — sanitize the input before use.",
              user: { login: "strix-security[bot]", type: "Bot" },
              updated_at: "2026-07-07T02:00:00Z",
            },
          ],
        },
      ];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "strix" }],
        sourceKind: "bot",
      });

      expect(worklist.items.map((item) => item.sourceId)).toEqual(["issue-comment:4909514271"]);
      expect(worklist.noiseGatedItems).toEqual([]);
    });

    it("noise gate drops a bot's no-findings inline review comment", async () => {
      mockFetchResponses = [
        makeThreadPayload([
          {
            id: "thread-noise",
            databaseId: 7777,
            authorLogin: "strix[bot]",
            authorType: "Bot",
            reviewDatabaseId: 8888,
            reviewAuthorLogin: "strix[bot]",
            reviewAuthorType: "Bot",
            body: "No issues found.",
          },
        ]),
        emptyIssueComments(),
      ];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "strix" }],
        sourceKind: "bot",
      });

      expect(worklist.items).toEqual([]);
      expect(worklist.noiseGatedItems).toEqual([
        { sourceId: "review-comment:7777", bot: "known:strix", reason: "no_findings" },
      ]);
    });

    it("reports resolved and outdated registered comments as unpromptable", async () => {
      mockFetchResponses = [
        makeThreadPayload([
          {
            id: "thread-resolved",
            databaseId: 7771,
            authorLogin: "strix[bot]",
            authorType: "Bot",
            reviewDatabaseId: 8881,
            reviewAuthorLogin: "strix[bot]",
            reviewAuthorType: "Bot",
            body: "Fix the auth check.",
            isResolved: true,
          },
          {
            id: "thread-resolved-blank",
            databaseId: 7773,
            authorLogin: "strix[bot]",
            authorType: "Bot",
            reviewDatabaseId: 8883,
            reviewAuthorLogin: "strix[bot]",
            reviewAuthorType: "Bot",
            body: "   ",
            isResolved: true,
          },
          {
            id: "thread-outdated",
            databaseId: 7772,
            authorLogin: "strix[bot]",
            authorType: "Bot",
            reviewDatabaseId: 8882,
            reviewAuthorLogin: "strix[bot]",
            reviewAuthorType: "Bot",
            body: "Rename this symbol.",
            isOutdated: true,
          },
        ]),
        emptyIssueComments(),
      ];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "strix" }],
        sourceKind: "bot",
      });

      expect(worklist.items).toEqual([]);
      expect(worklist.unpromptableItems).toEqual([
        { sourceId: "review-comment:7771", reason: "thread_resolved" },
        { sourceId: "review-comment:7773", reason: "thread_resolved" },
        // Outdated-thread entries carry the thread root so per-thread consumers (the sweep's
        // outdated note) can act once per thread.
        { sourceId: "review-comment:7772", reason: "thread_outdated", threadRootSourceId: "review-comment:7772" },
      ]);
      expect(worklist.liveSourceIds).toEqual(["review-comment:7771", "review-comment:7772", "review-comment:7773"]);
    });

    it("reports blank registered issue comments as unpromptable", async () => {
      mockFetchResponses = [
        makeThreadPayload([]),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 7774,
              html_url: "https://github.com/acme/repo/pull/7#issuecomment-7774",
              body: "   ",
              user: { login: "strix[bot]", type: "Bot" },
              updated_at: "2026-06-11T01:00:00Z",
            },
          ],
        },
      ];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "strix" }],
        sourceKind: "bot",
      });

      expect(worklist.items).toEqual([]);
      expect(worklist.unpromptableItems).toEqual([
        { sourceId: "issue-comment:7774", reason: "comment_blank" },
        { sourceId: "qa-verdict:7774", reason: "comment_blank" },
      ]);
      expect(worklist.liveSourceIds).toEqual(["issue-comment:7774", "qa-verdict:7774"]);
    });

    it("non-verification sourceKinds still drop the managed QA Tester comment", async () => {
      mockFetchResponses = [makeThreadPayload([]), verificationIssueComments()];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "mixed",
        triggeringSourceIds: [],
      });

      expect(worklist.items).toEqual([]);
    });

    it("does not admit a spoofed marker from a non-Cycloid author", async () => {
      mockFetchResponses = [
        makeThreadPayload([]),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 5004,
              html_url: "https://github.com/acme/repo/pull/7#issuecomment-5004",
              // Any PR commenter can paste the marker; admission must also require the
              // Cycloid-owned author.
              body: QA_COMMENT_BODY,
              user: { login: "attacker", type: "User" },
              updated_at: "2026-06-11T01:00:00Z",
            },
            {
              id: 5005,
              html_url: "https://github.com/acme/repo/pull/7#issuecomment-5005",
              body: QA_COMMENT_BODY,
              user: { login: "evil-bot[bot]", type: "Bot" },
              updated_at: "2026-06-11T01:01:00Z",
            },
          ],
        },
      ];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "verification",
      });

      expect(worklist.items).toEqual([]);
    });

    it("verification sourceKind does not admit a marker for a different PR", async () => {
      mockFetchResponses = [
        makeThreadPayload([]),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 5003,
              html_url: "https://github.com/acme/repo/pull/7#issuecomment-5003",
              body: "<!-- cycloid-qa:v1 owner=acme repo=repo pr=99 head=abc123 -->\n\n## Cycloid QA",
              user: { login: "cycloid[bot]", type: "Bot" },
              updated_at: "2026-06-11T01:00:00Z",
            },
          ],
        },
      ];

      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "verification",
      });

      expect(worklist.items).toEqual([]);
    });

    it("human sourceKind includes review threads whose reviewId is in triggeringSourceIds", async () => {
      // Review ID 9001 corresponds to triggeringSourceId "human:9001"
      mockFetchResponses = [
        makeThreadPayload([
          {
            id: "thread-human",
            databaseId: 8001,
            authorLogin: "alice",
            authorType: "User",
            reviewDatabaseId: 9001,
            reviewAuthorLogin: "alice",
            reviewAuthorType: "User",
            body: "Please fix this",
          },
        ]),
        emptyIssueComments(),
        emptyReviews(),
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "human",
        triggeringSourceIds: ["human:9001"],
      });

      expect(result.items.map((i) => i.sourceId)).toEqual(["review-comment:8001"]);
    });

    it("admits outdated human-triggered threads but keeps outdated bot threads skipped", async () => {
      mockFetchResponses = [
        {
          ok: true,
          status: 200,
          body: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "thread-human-outdated",
                        isResolved: false,
                        isOutdated: true,
                        path: "src/human.ts",
                        line: 4,
                        startLine: 4,
                        diffSide: "RIGHT",
                        comments: {
                          nodes: [
                            {
                              databaseId: 8101,
                              url: "https://github.com/acme/repo/pull/7#discussion_r8101",
                              body: "Human feedback just before force-push",
                              diffHunk: "@@ -4 +4 @@",
                              author: { login: "alice", __typename: "User" },
                              updatedAt: "2026-05-25T01:00:00Z",
                              pullRequestReview: {
                                databaseId: 9101,
                                author: { login: "alice", __typename: "User" },
                              },
                            },
                          ],
                        },
                      },
                      {
                        id: "thread-bot-outdated",
                        isResolved: false,
                        isOutdated: true,
                        path: "src/bot.ts",
                        line: 8,
                        comments: {
                          nodes: [
                            {
                              databaseId: 8102,
                              url: "https://github.com/acme/repo/pull/7#discussion_r8102",
                              body: "Stale bot feedback",
                              diffHunk: "@@ -8 +8 @@",
                              author: { login: "cursor[bot]", __typename: "Bot" },
                              updatedAt: "2026-05-25T01:00:00Z",
                              pullRequestReview: {
                                databaseId: 9102,
                                author: { login: "cursor[bot]", __typename: "Bot" },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        emptyIssueComments(),
        emptyReviews(),
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "human",
        triggeringSourceIds: ["human:9101", "human:9102"],
      });

      expect(result.items.map((item) => item.sourceId)).toEqual(["review-comment:8101"]);
      expect(result.items[0]?.isOutdated).toBe(true);
    });

    // PR #7119 self-reply loop: a human-triggered thread returns EVERY comment, including Cycloid's
    // own guarded-decline replies. Without the self-reply fence, each reply comes back as a fresh
    // worklist item the next sweep and the loop answers itself forever. The fence keys off the stored
    // reply github_id (identity-independent — the dogfood PR replies as the user, not cycloid[bot]).
    function makeSelfReplyThreadPayload() {
      return {
        ok: true,
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "thread-selfreply",
                      isResolved: false,
                      isOutdated: false,
                      path: "shared/utils/math.ts",
                      line: 3,
                      comments: {
                        nodes: [
                          {
                            databaseId: 3540474921,
                            url: "https://github.com/acme/repo/pull/7#discussion_r3540474921",
                            body: "what smy name",
                            author: { login: "josiah-arcanist", __typename: "User" },
                            updatedAt: "2026-07-08T00:28:54Z",
                            pullRequestReview: {
                              databaseId: 9100,
                              author: { login: "josiah-arcanist", __typename: "User" },
                            },
                          },
                          {
                            // Cycloid's own decline reply, posted as the user (dogfood identity).
                            databaseId: 4649950310,
                            url: "https://github.com/acme/repo/pull/7#discussion_r4649950310",
                            body: "No actionable code change requested here.",
                            author: { login: "jag-arcanist", __typename: "User" },
                            updatedAt: "2026-07-08T00:30:49Z",
                            pullRequestReview: {
                              databaseId: 4649950309,
                              author: { login: "jag-arcanist", __typename: "User" },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }

    it("human sourceKind fences Cycloid's own review-loop replies out of a human-triggered thread (PR #7119)", async () => {
      mockFetchResponses = [makeSelfReplyThreadPayload(), emptyIssueComments(), emptyReviews()];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "human",
        triggeringSourceIds: ["human:9100"],
        excludeSelfReplyCommentIds: new Set(["4649950310"]),
      });

      // Josiah's comment is still surfaced; Cycloid's own reply is dropped so the loop cannot re-answer it.
      expect(result.items.map((i) => i.sourceId)).toEqual(["review-comment:3540474921"]);
    });

    it("human sourceKind admits every thread comment when no self-reply ids are provided (default off)", async () => {
      mockFetchResponses = [makeSelfReplyThreadPayload(), emptyIssueComments(), emptyReviews()];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "human",
        triggeringSourceIds: ["human:9100"],
      });

      // Fence is opt-in: with no ids passed, behavior is unchanged (both comments surface).
      expect(result.items.map((i) => i.sourceId).sort()).toEqual([
        "review-comment:3540474921",
        "review-comment:4649950310",
      ]);
    });

    it("human sourceKind excludes reviews whose reviewId is NOT in triggeringSourceIds", async () => {
      // Review ID 9002 is not in triggeringSourceIds
      mockFetchResponses = [
        makeThreadPayload([
          {
            id: "thread-other-human",
            databaseId: 8002,
            authorLogin: "bob",
            authorType: "User",
            reviewDatabaseId: 9002,
            reviewAuthorLogin: "bob",
            reviewAuthorType: "User",
            body: "Different human reviewer",
          },
        ]),
        emptyIssueComments(),
        emptyReviews(),
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "human",
        triggeringSourceIds: ["human:9001"],
      });

      expect(result.items).toEqual([]);
    });

    it("mixed sourceKind includes both expected-bot threads and human threads in triggeringSourceIds", async () => {
      mockFetchResponses = [
        makeThreadPayload([
          // Bot thread from configured bot
          {
            id: "thread-bot",
            databaseId: 8010,
            authorLogin: "cursor[bot]",
            authorType: "Bot",
            reviewDatabaseId: 9010,
            reviewAuthorLogin: "cursor[bot]",
            reviewAuthorType: "Bot",
            body: "Bot finding",
          },
          // Human thread with review in triggeringSourceIds
          {
            id: "thread-human-mixed",
            databaseId: 8011,
            authorLogin: "carol",
            authorType: "User",
            reviewDatabaseId: 9011,
            reviewAuthorLogin: "carol",
            reviewAuthorType: "User",
            body: "Human finding",
          },
          // Human thread NOT in triggeringSourceIds — should be excluded
          {
            id: "thread-human-excluded",
            databaseId: 8012,
            authorLogin: "dave",
            authorType: "User",
            reviewDatabaseId: 9012,
            reviewAuthorLogin: "dave",
            reviewAuthorType: "User",
            body: "Dave excluded finding",
          },
        ]),
        emptyIssueComments(),
        emptyReviews(),
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "mixed",
        triggeringSourceIds: ["human:9011"],
      });

      expect(result.items.map((i) => i.sourceId)).toEqual(["review-comment:8010", "review-comment:8011"]);
    });

    it("bot sourceKind (default) still filters to expected bots only", async () => {
      mockFetchResponses = [
        makeThreadPayload([
          {
            id: "thread-bot-only",
            databaseId: 8020,
            authorLogin: "cursor[bot]",
            authorType: "Bot",
            reviewDatabaseId: 9020,
            reviewAuthorLogin: "cursor[bot]",
            reviewAuthorType: "Bot",
            body: "Bot-only finding",
          },
          {
            id: "thread-human-ignored",
            databaseId: 8021,
            authorLogin: "eve",
            authorType: "User",
            reviewDatabaseId: 9021,
            reviewAuthorLogin: "eve",
            reviewAuthorType: "User",
            body: "Human ignored in bot mode",
          },
        ]),
        emptyIssueComments(),
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "bot",
        triggeringSourceIds: ["human:9021"],
      });

      // Only bot thread; human thread excluded even though it's in triggeringSourceIds for bot mode
      expect(result.items.map((i) => i.sourceId)).toEqual(["review-comment:8020"]);
    });

    // Case 1: human review with body but no inline threads
    it("Case 1 (human, body-only review): surfaces review body as worklist item when no inline threads exist", async () => {
      // Zero review threads, one triggering human review with a non-empty body.
      // The reviews REST endpoint returns the review with the triggering id.
      mockFetchResponses = [
        // fetchReviewLoopReviewThreadItems → GraphQL (no threads)
        {
          ok: true,
          status: 200,
          body: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                },
              },
            },
          },
        },
        // fetchReviewLoopIssueCommentItems → REST (empty)
        emptyIssueComments(),
        // fetchReviewLoopHumanReviewBodyItems → REST /pulls/:number/reviews
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 9100,
              body: "Please address the null guard before merge.",
              state: "CHANGES_REQUESTED",
              user: { login: "alice", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9100",
              submitted_at: "2026-05-25T02:00:00Z",
            },
            {
              // Review whose id is NOT in triggeringSourceIds — must be excluded
              id: 9101,
              body: "Looks fine from my end.",
              state: "COMMENTED",
              user: { login: "bob", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9101",
              submitted_at: "2026-05-25T02:01:00Z",
            },
          ],
        },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "human",
        triggeringSourceIds: ["human:9100"],
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sourceId).toBe("review-body:9100");
      expect(result.items[0].authorLogin).toBe("alice");
      expect(result.items[0].body).toBe("Please address the null guard before merge.");
      expect(result.items[0].path).toBeNull();
      expect(result.items[0].line).toBeNull();
    });

    it("Case 1 (human, review with body AND inline comments): bundles the review body together with its inline comment in one worklist", async () => {
      // A triggering human review (id 9600) that left BOTH a review-level body AND an inline
      // comment. Both the body and the inline comment surface together in one worklist so the whole
      // review (head + comments) is delivered as one epoch — no live-thread-gated body suppression.
      mockFetchResponses = [
        // fetchReviewLoopReviewThreadItems → one inline thread owned by the triggering human review
        makeThreadPayload([
          {
            id: "thread-human-9600",
            databaseId: 8600,
            authorLogin: "alice",
            authorType: "User",
            reviewDatabaseId: 9600,
            reviewAuthorLogin: "alice",
            reviewAuthorType: "User",
            body: "Inline: tighten this null check.",
          },
        ]),
        // fetchReviewLoopIssueCommentItems → empty
        emptyIssueComments(),
        // fetchReviewLoopHumanReviewBodyItems → the SAME review also carries a top-level body
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 9600,
              body: "Please address the null guard before merge.",
              state: "CHANGES_REQUESTED",
              user: { login: "alice", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9600",
              submitted_at: "2026-05-25T02:00:00Z",
            },
          ],
        },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "human",
        triggeringSourceIds: ["human:9600"],
      });

      const ids = result.items.map((i) => i.sourceId);
      expect(ids).toContain("review-comment:8600");
      expect(ids).toContain("review-body:9600");
      expect(result.items).toHaveLength(2);
    });

    it("Case 1 (mixed, review with body AND inline comments): bundles the human review body with its inline comment alongside a bot thread", async () => {
      // Mixed mode bundles the same way as human mode. A triggering human review (9700) contributes
      // both an inline comment and a body; a bot thread is also present. The human inline comment,
      // the human review body, and the bot comment all surface together.
      mockFetchResponses = [
        makeThreadPayload([
          {
            id: "thread-bot-mix",
            databaseId: 8700,
            authorLogin: "cursor[bot]",
            authorType: "Bot",
            reviewDatabaseId: 9701,
            reviewAuthorLogin: "cursor[bot]",
            reviewAuthorType: "Bot",
            body: "Bot inline finding",
          },
          {
            id: "thread-human-mix",
            databaseId: 8702,
            authorLogin: "dave",
            authorType: "User",
            reviewDatabaseId: 9700,
            reviewAuthorLogin: "dave",
            reviewAuthorType: "User",
            body: "Inline: rename this variable.",
          },
        ]),
        emptyIssueComments(),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 9700,
              body: "Please also update the changelog.",
              state: "CHANGES_REQUESTED",
              user: { login: "dave", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9700",
              submitted_at: "2026-05-25T02:00:00Z",
            },
          ],
        },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "mixed",
        triggeringSourceIds: ["human:9700"],
      });

      const ids = result.items.map((i) => i.sourceId);
      expect(ids).toContain("review-comment:8702");
      expect(ids).toContain("review-comment:8700");
      expect(ids).toContain("review-body:9700");
    });

    it("Case 1 (human, later triggering review replies inline on an origin-triggered thread): includes the later review's body alongside its inline reply", async () => {
      // One thread whose origin comment belongs to triggering review 9800, plus a reply comment
      // belonging to a DIFFERENT triggering review 9801. Both inline comments enter the worklist
      // via the origin-triggered branch, and review 9801's body is bundled in too — the whole
      // review (head + comments) is delivered together.
      mockFetchResponses = [
        {
          ok: true,
          status: 200,
          body: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "thread-multi-review",
                        isResolved: false,
                        isOutdated: false,
                        path: "src/app.ts",
                        line: 20,
                        comments: {
                          nodes: [
                            {
                              databaseId: 8800,
                              url: "https://github.com/acme/repo/pull/7#discussion_r8800",
                              body: "Origin: fix the guard.",
                              author: { login: "dave", __typename: "User" },
                              updatedAt: "2026-05-25T01:00:00Z",
                              pullRequestReview: { databaseId: 9800, author: { login: "dave", __typename: "User" } },
                            },
                            {
                              databaseId: 8801,
                              url: "https://github.com/acme/repo/pull/7#discussion_r8801",
                              body: "Reply: and rebase onto main.",
                              author: { login: "erin", __typename: "User" },
                              updatedAt: "2026-05-25T01:05:00Z",
                              pullRequestReview: { databaseId: 9801, author: { login: "erin", __typename: "User" } },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        emptyIssueComments(),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 9801,
              body: "Please rebase onto main before merge.",
              state: "COMMENTED",
              user: { login: "erin", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9801",
              submitted_at: "2026-05-25T02:00:00Z",
            },
          ],
        },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "human",
        triggeringSourceIds: ["human:9800", "human:9801"],
      });

      const ids = result.items.map((i) => i.sourceId);
      expect(ids).toContain("review-comment:8800");
      expect(ids).toContain("review-comment:8801");
      expect(ids).toContain("review-body:9801");
    });

    it("Case 1 (human, review with body AND multiple inline comments): delivers the body plus every inline comment in one worklist", async () => {
      // The whole point of the change: a single triggering human review (9900) with a top-level body
      // AND two inline comments must produce ONE worklist carrying all three items (head + both
      // comments), so the review is dispatched as a single epoch rather than split across waves.
      mockFetchResponses = [
        makeThreadPayload([
          {
            id: "thread-multi-a",
            databaseId: 8900,
            authorLogin: "alice",
            authorType: "User",
            reviewDatabaseId: 9900,
            reviewAuthorLogin: "alice",
            reviewAuthorType: "User",
            body: "Inline A: tighten this null check.",
          },
          {
            id: "thread-multi-b",
            databaseId: 8901,
            authorLogin: "alice",
            authorType: "User",
            reviewDatabaseId: 9900,
            reviewAuthorLogin: "alice",
            reviewAuthorType: "User",
            body: "Inline B: rename this variable.",
          },
        ]),
        emptyIssueComments(),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 9900,
              body: "Overall: please tighten the error handling before merge.",
              state: "CHANGES_REQUESTED",
              user: { login: "alice", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9900",
              submitted_at: "2026-05-25T02:00:00Z",
            },
          ],
        },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "human",
        triggeringSourceIds: ["human:9900"],
      });

      const ids = result.items.map((i) => i.sourceId);
      expect(ids).toContain("review-body:9900");
      expect(ids).toContain("review-comment:8900");
      expect(ids).toContain("review-comment:8901");
      expect(result.items).toHaveLength(3);
    });

    it("Case 1 (mixed, body-only review): surfaces review body alongside bot threads", async () => {
      mockFetchResponses = [
        // fetchReviewLoopReviewThreadItems → GraphQL (one bot thread)
        makeThreadPayload([
          {
            id: "thread-bot-mixed",
            databaseId: 8030,
            authorLogin: "cursor[bot]",
            authorType: "Bot",
            reviewDatabaseId: 9030,
            reviewAuthorLogin: "cursor[bot]",
            reviewAuthorType: "Bot",
            body: "Bot inline finding",
          },
        ]),
        // fetchReviewLoopIssueCommentItems → REST (empty)
        emptyIssueComments(),
        // fetchReviewLoopHumanReviewBodyItems → REST /pulls/:number/reviews
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 9031,
              body: "Please clean up the logging code.",
              state: "CHANGES_REQUESTED",
              user: { login: "carol", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9031",
              submitted_at: "2026-05-25T02:02:00Z",
            },
          ],
        },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "mixed",
        triggeringSourceIds: ["human:9031"],
      });

      const ids = result.items.map((i) => i.sourceId);
      expect(ids).toContain("review-comment:8030");
      expect(ids).toContain("review-body:9031");
    });

    it("retains the human review body under budget pressure from large bot bodies and reports dropped items", async () => {
      // ~5KB of distinct bot body per thread; 20 threads >> the 64KB total budget. With the old
      // ordering (human bodies appended last) the human review body would be dropped first.
      const bigBody = (n: number) => `bot finding ${n} `.padEnd(5 * 1024, `x${n}`);
      const botThreads = Array.from({ length: 20 }, (_, i) => ({
        id: `thread-bot-${i}`,
        databaseId: 8100 + i,
        authorLogin: "cursor[bot]",
        authorType: "Bot",
        reviewDatabaseId: 9300 + i,
        reviewAuthorLogin: "cursor[bot]",
        reviewAuthorType: "Bot",
        body: bigBody(i),
      }));
      mockFetchResponses = [
        makeThreadPayload(botThreads),
        emptyIssueComments(),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 9400,
              body: "Please address the security review before merge.",
              state: "CHANGES_REQUESTED",
              user: { login: "alice", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9400",
              submitted_at: "2026-05-25T03:00:00Z",
            },
          ],
        },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "mixed",
        triggeringSourceIds: ["human:9400"],
      });

      const ids = result.items.map((i) => i.sourceId);
      // Human review body survives the budget; some bot threads are dropped.
      expect(ids).toContain("review-body:9400");
      expect(ids.length).toBeLessThan(botThreads.length + 1);
      expect(result.droppedItemCount).toBeGreaterThan(0);
      expect(result.droppedBodyBytes).toBeGreaterThan(0);
    });

    it("drops the SAME tail regardless of GitHub paging order (deterministic truncation, PR-5)", async () => {
      // Carry-forward convergence assumes the budget drops the same items every wave, but GitHub
      // paging order is not contractually stable. The stable sort makes the retained set, the dropped
      // tail, and the hash identical across two shuffled fetch orders of the same 20 overflowing bots.
      const bigBody = (n: number) => `bot finding ${n} `.padEnd(5 * 1024, `x${n}`);
      const threadFor = (i: number) => ({
        id: `thread-bot-${i}`,
        databaseId: 8100 + i,
        authorLogin: "cursor[bot]",
        authorType: "Bot",
        reviewDatabaseId: 9300 + i,
        reviewAuthorLogin: "cursor[bot]",
        reviewAuthorType: "Bot",
        body: bigBody(i),
      });
      const ascending = Array.from({ length: 20 }, (_, i) => i);
      const shuffled = [5, 19, 0, 12, 3, 17, 8, 1, 14, 9, 2, 18, 6, 11, 4, 16, 7, 13, 10, 15];
      const opts = {
        expectedBots: [{ type: "known" as const, id: "cursor-bugbot" as const }],
        sourceKind: "bot" as const,
        triggeringSourceIds: [],
      };

      mockFetchResponses = [makeThreadPayload(ascending.map(threadFor)), emptyIssueComments(), emptyReviews()];
      const first = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, opts);

      mockFetchResponses = [makeThreadPayload(shuffled.map(threadFor)), emptyIssueComments(), emptyReviews()];
      const second = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, opts);

      expect(first.droppedItemCount).toBeGreaterThan(0); // genuinely under budget pressure
      expect(second.items.map((i) => i.sourceId)).toEqual(first.items.map((i) => i.sourceId));
      expect(second.droppedSourceIds).toEqual(first.droppedSourceIds);
      expect(second.worklistHash).toBe(first.worklistHash);
    });

    it("keeps the human review body winning the budget over bots regardless of fetch order (PR-5)", async () => {
      const bigBody = (n: number) => `bot finding ${n} `.padEnd(5 * 1024, `x${n}`);
      const threadFor = (i: number) => ({
        id: `thread-bot-${i}`,
        databaseId: 8100 + i,
        authorLogin: "cursor[bot]",
        authorType: "Bot",
        reviewDatabaseId: 9300 + i,
        reviewAuthorLogin: "cursor[bot]",
        reviewAuthorType: "Bot",
        body: bigBody(i),
      });
      const humanBody = {
        ok: true,
        status: 200,
        body: [
          {
            id: 9400,
            body: "Please address the security review before merge.",
            state: "CHANGES_REQUESTED",
            user: { login: "alice", type: "User" },
            html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9400",
            submitted_at: "2026-05-25T03:00:00Z",
          },
        ],
      };
      const opts = {
        expectedBots: [{ type: "known" as const, id: "cursor-bugbot" as const }],
        sourceKind: "mixed" as const,
        triggeringSourceIds: ["human:9400"],
      };

      mockFetchResponses = [
        makeThreadPayload([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(threadFor)),
        emptyIssueComments(),
        humanBody,
      ];
      const first = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, opts);
      mockFetchResponses = [
        makeThreadPayload([14, 0, 9, 3, 12, 6, 1, 11, 4, 8, 2, 13, 5, 10, 7].map(threadFor)),
        emptyIssueComments(),
        humanBody,
      ];
      const second = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, opts);

      // review-body (tier 0) is retained in both orders, never dropped.
      expect(first.items.map((i) => i.sourceId)).toContain("review-body:9400");
      expect(second.items.map((i) => i.sourceId)).toContain("review-body:9400");
      expect(first.droppedSourceIds).not.toContain("review-body:9400");
      expect(second.droppedSourceIds).toEqual(first.droppedSourceIds);
    });

    it("returns the exact dropped sourceIds for budget-truncated items so they can be carried forward", async () => {
      // 20 distinct ~5KB bot threads overflow the 64KB total budget; the tail is dropped. The fix
      // must surface the EXACT sourceIds of the dropped items (not just a count) so the sweep can
      // carry them forward as un-prompted work and re-dispatch them once budget frees up.
      const bigBody = (n: number) => `bot finding ${n} `.padEnd(5 * 1024, `x${n}`);
      const botThreads = Array.from({ length: 20 }, (_, i) => ({
        id: `thread-bot-${i}`,
        databaseId: 8100 + i,
        authorLogin: "cursor[bot]",
        authorType: "Bot",
        reviewDatabaseId: 9300 + i,
        reviewAuthorLogin: "cursor[bot]",
        reviewAuthorType: "Bot",
        body: bigBody(i),
      }));
      mockFetchResponses = [makeThreadPayload(botThreads), emptyIssueComments(), emptyReviews()];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "bot",
        triggeringSourceIds: [],
      });

      const retainedIds = new Set(result.items.map((i) => i.sourceId));
      // One dropped sourceId per dropped item, all real review-comment ids absent from `items`.
      expect(result.droppedSourceIds.length).toBe(result.droppedItemCount);
      expect(result.droppedSourceIds.length).toBeGreaterThan(0);
      for (const id of result.droppedSourceIds) {
        expect(id).toMatch(/^review-comment:/);
        expect(retainedIds.has(id)).toBe(false);
      }
      // Retained ∪ dropped covers all 20 distinct threads with no overlap (nothing silently lost).
      expect(new Set([...retainedIds, ...result.droppedSourceIds]).size).toBe(20);
    });

    it("re-drive convergence: excluding the prior wave's prompted head frees budget so the carried tail re-surfaces (ARC-1226)", async () => {
      // Proves the P0 convergence guarantee END-TO-END against the REAL budget arithmetic (the unit
      // tests only cover the pieces): wave 1 drops a tail past the 64KB budget; wave 2 re-drives with
      // THIS epoch's already-prompted head excluded (exactly what processEpoch does when
      // carried_forward is non-empty), and every previously-dropped sourceId must now land in `items`
      // (not droppedSourceIds). That is the "no item is dropped forever" property the fix relies on.
      const bigBody = (n: number) => `bot finding ${n} `.padEnd(5 * 1024, `x${n}`);
      const botThreads = Array.from({ length: 20 }, (_, i) => ({
        id: `thread-bot-${i}`,
        databaseId: 8100 + i,
        authorLogin: "cursor[bot]",
        authorType: "Bot",
        reviewDatabaseId: 9300 + i,
        reviewAuthorLogin: "cursor[bot]",
        reviewAuthorType: "Bot",
        body: bigBody(i),
      }));
      const opts = {
        expectedBots: [{ type: "known" as const, id: "cursor-bugbot" as const }],
        sourceKind: "bot" as const,
        triggeringSourceIds: [],
      };

      // Wave 1: no exclusion → the budget retains a head and drops a non-empty tail.
      mockFetchResponses = [makeThreadPayload(botThreads), emptyIssueComments(), emptyReviews()];
      const wave1 = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, opts);
      const wave1Retained = wave1.items.map((i) => i.sourceId);
      const wave1Dropped = wave1.droppedSourceIds;
      expect(wave1Dropped.length).toBeGreaterThan(0);

      // Wave 2: re-drive with the wave-1 prompted head excluded (frees its bytes BEFORE the budget
      // loop). The carried tail must now be admitted in full, and the excluded head must be gone.
      mockFetchResponses = [makeThreadPayload(botThreads), emptyIssueComments(), emptyReviews()];
      const wave2 = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        ...opts,
        excludeSourceIds: new Set(wave1Retained),
      });
      const wave2Ids = new Set(wave2.items.map((i) => i.sourceId));
      for (const id of wave1Dropped) {
        expect(wave2Ids.has(id)).toBe(true); // previously-dropped tail now fits → convergence
      }
      // The carried tail is not re-dropped, and the already-prompted head is not re-surfaced.
      expect(wave2.droppedSourceIds.filter((id) => wave1Dropped.includes(id))).toEqual([]);
      for (const id of wave1Retained) {
        expect(wave2Ids.has(id)).toBe(false);
      }
    });

    it("reports zero dropped items when everything fits in the budget", async () => {
      mockFetchResponses = [
        makeThreadPayload([
          {
            id: "thread-small",
            databaseId: 8500,
            authorLogin: "cursor[bot]",
            authorType: "Bot",
            reviewDatabaseId: 9500,
            reviewAuthorLogin: "cursor[bot]",
            reviewAuthorType: "Bot",
            body: "small bot finding",
          },
        ]),
        emptyIssueComments(),
        emptyReviews(),
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "mixed",
        triggeringSourceIds: [],
      });

      expect(result.droppedItemCount).toBe(0);
      expect(result.droppedBodyBytes).toBe(0);
      expect(result.droppedSourceIds).toEqual([]);
    });

    it("Case 1: skips review body when the body is empty (APPROVED with no comment)", async () => {
      mockFetchResponses = [
        {
          ok: true,
          status: 200,
          body: {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                },
              },
            },
          },
        },
        emptyIssueComments(),
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 9200,
              body: "",
              state: "APPROVED",
              user: { login: "dave", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9200",
              submitted_at: "2026-05-25T02:03:00Z",
            },
          ],
        },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [],
        sourceKind: "human",
        triggeringSourceIds: ["human:9200"],
      });

      expect(result.items).toEqual([]);
    });

    it("Case 1: skips the reviews fetch entirely for bot sourceKind", async () => {
      // In bot mode, no reviews fetch should happen at all.
      // emptyIssueComments is provided but no reviews endpoint — if the reviews
      // fetch fires it will throw "Unexpected fetch".
      mockFetchResponses = [
        makeThreadPayload([
          {
            id: "thread-bot-regression",
            databaseId: 8040,
            authorLogin: "cursor[bot]",
            authorType: "Bot",
            reviewDatabaseId: 9040,
            reviewAuthorLogin: "cursor[bot]",
            reviewAuthorType: "Bot",
            body: "Bot-only, no reviews fetch",
          },
        ]),
        emptyIssueComments(),
        // No third mock — reviews fetch must NOT fire for bot sourceKind.
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        // sourceKind defaults to "bot"
      });

      expect(result.items.map((i) => i.sourceId)).toEqual(["review-comment:8040"]);
    });

    // Case 2: human reply to an existing bot thread
    function makeMultiCommentThreadPayload(
      threadId: string,
      comments: Array<{
        databaseId: number;
        authorLogin: string;
        authorType: string;
        reviewDatabaseId: number;
        reviewAuthorLogin: string;
        reviewAuthorType: string;
        body: string;
      }>,
    ) {
      return {
        ok: true,
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: threadId,
                      isResolved: false,
                      isOutdated: false,
                      path: "src/app.ts",
                      line: 10,
                      comments: {
                        nodes: comments.map((c) => ({
                          databaseId: c.databaseId,
                          url: `https://github.com/acme/repo/pull/7#discussion_r${c.databaseId}`,
                          body: c.body,
                          author: { login: c.authorLogin, __typename: c.authorType },
                          updatedAt: "2026-05-25T01:00:00Z",
                          pullRequestReview: {
                            databaseId: c.reviewDatabaseId,
                            author: { login: c.reviewAuthorLogin, __typename: c.reviewAuthorType },
                          },
                        })),
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      };
    }

    it("Case 2 (human): includes human reply in a bot-origin thread when the reply's review id is in triggeringSourceIds", async () => {
      // Thread origin comment belongs to bot review 9300.
      // Second comment (the human reply) belongs to human review 9301.
      // triggeringSourceIds = ["human:9301"] → thread must be included.
      mockFetchResponses = [
        makeMultiCommentThreadPayload("thread-bot-origin", [
          {
            databaseId: 8050,
            authorLogin: "cursor[bot]",
            authorType: "Bot",
            reviewDatabaseId: 9300,
            reviewAuthorLogin: "cursor[bot]",
            reviewAuthorType: "Bot",
            body: "Bot original comment",
          },
          {
            databaseId: 8051,
            authorLogin: "alice",
            authorType: "User",
            reviewDatabaseId: 9301,
            reviewAuthorLogin: "alice",
            reviewAuthorType: "User",
            body: "Human reply to bot thread",
          },
        ]),
        emptyIssueComments(),
        // fetchReviewLoopHumanReviewBodyItems → no non-empty body reviews
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 9301,
              body: "",
              state: "COMMENTED",
              user: { login: "alice", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9301",
              submitted_at: "2026-05-25T01:01:00Z",
            },
          ],
        },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "human",
        triggeringSourceIds: ["human:9301"],
      });

      const ids = result.items.map((i) => i.sourceId);
      expect(ids).toContain("review-comment:8051");
    });

    it("Case 2 (mixed): bot-origin thread with human reply is included; bot thread without human reply also included via bot path", async () => {
      mockFetchResponses = [
        makeMultiCommentThreadPayload("thread-mixed-bot-origin", [
          {
            databaseId: 8060,
            authorLogin: "cursor[bot]",
            authorType: "Bot",
            reviewDatabaseId: 9310,
            reviewAuthorLogin: "cursor[bot]",
            reviewAuthorType: "Bot",
            body: "Bot original",
          },
          {
            databaseId: 8061,
            authorLogin: "carol",
            authorType: "User",
            reviewDatabaseId: 9311,
            reviewAuthorLogin: "carol",
            reviewAuthorType: "User",
            body: "Carol reply in mixed mode",
          },
        ]),
        emptyIssueComments(),
        // Reviews fetch: no body
        {
          ok: true,
          status: 200,
          body: [
            {
              id: 9311,
              body: "",
              state: "COMMENTED",
              user: { login: "carol", type: "User" },
              html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-9311",
              submitted_at: "2026-05-25T01:01:00Z",
            },
          ],
        },
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "mixed",
        triggeringSourceIds: ["human:9311"],
      });

      const ids = result.items.map((i) => i.sourceId);
      // Bot origin comment included via bot path (cursor[bot] is a configured bot)
      expect(ids).toContain("review-comment:8060");
      // Human reply included via human-reply path
      expect(ids).toContain("review-comment:8061");
    });

    it("Case 2 regression: bot-only sourceKind does NOT include human replies in bot threads", async () => {
      // In bot mode, even if a human reply has a reviewId that happens to match
      // the format "human:N", no human-reply scanning should occur.
      mockFetchResponses = [
        makeMultiCommentThreadPayload("thread-bot-only-regression", [
          {
            databaseId: 8070,
            authorLogin: "cursor[bot]",
            authorType: "Bot",
            reviewDatabaseId: 9320,
            reviewAuthorLogin: "cursor[bot]",
            reviewAuthorType: "Bot",
            body: "Bot comment only",
          },
          {
            databaseId: 8071,
            authorLogin: "frank",
            authorType: "User",
            reviewDatabaseId: 9321,
            reviewAuthorLogin: "frank",
            reviewAuthorType: "User",
            body: "Human reply should not appear in bot mode",
          },
        ]),
        emptyIssueComments(),
        // No third mock — reviews fetch must NOT fire for bot sourceKind.
      ];

      const result = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        sourceKind: "bot",
        triggeringSourceIds: ["human:9321"],
      });

      // Only the bot comment (8070); human reply (8071) must NOT appear.
      expect(result.items.map((i) => i.sourceId)).toEqual(["review-comment:8070"]);
    });
  });

  describe("managed QA comment intake (A4)", () => {
    const emptyThreads = {
      ok: true,
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
          },
        },
      },
    };
    const qaIssueComments = (verdict: "app_breaks" | "pass") => ({
      ok: true,
      status: 200,
      body: [
        {
          id: verdict === "app_breaks" ? 501 : 502,
          html_url: "https://github.com/acme/web/pull/7#issuecomment-1",
          body: `<!-- cycloid-qa:v1 owner=acme repo=web pr=7 head=sha verdict=${verdict} -->\n## Cycloid QA\n\nfindings`,
          user: { login: "cycloid-qa[bot]", type: "Bot" },
          created_at: "2026-05-25T01:00:00Z",
          updated_at: "2026-05-25T01:00:00Z",
        },
      ],
    });
    const expectedBots = [{ type: "known" as const, id: "greptile" as const }];

    it("admits an app_breaks QA comment exactly once as a qa-verdict item", async () => {
      mockFetchResponses = [emptyThreads, qaIssueComments("app_breaks")];
      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "web", 7, { expectedBots });
      const qaItems = worklist.items.filter((i) => i.sourceId === "qa-verdict:501");
      expect(qaItems).toHaveLength(1);
      expect(qaItems[0]?.authorLogin).toBe("cycloid-qa[bot]");
    });

    it("drops a clean (pass) QA comment — non-actionable, no worklist item", async () => {
      mockFetchResponses = [emptyThreads, qaIssueComments("pass")];
      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "web", 7, { expectedBots });
      expect(worklist.items.some((i) => i.sourceId.startsWith("qa-verdict:"))).toBe(false);
      expect(worklist.items.some((i) => i.sourceId === "issue-comment:502")).toBe(false);
    });

    it("does not synthesize a verification-verdict item (the restored comment is the single source)", async () => {
      mockFetchResponses = [emptyThreads, { ok: true, status: 200, body: [] }];
      const worklist = await mod.getPrReviewLoopWorklist("token", "acme", "web", 7, {
        expectedBots: [],
        sourceKind: "verification",
      });
      expect(worklist.items.some((i) => i.sourceId.startsWith("verification-verdict:"))).toBe(false);
    });
  });

  describe("targeted @cycloid mention scope (restrictToSourceIds + contextSourceIds)", () => {
    // Two review comments (a target and its replied-to parent) plus an unrelated issue comment — the
    // full worklist a targeted mention must be narrowed down from.
    const threadsPage = {
      ok: true,
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "thread-parent",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/a.ts",
                    line: 10,
                    comments: {
                      nodes: [
                        {
                          databaseId: 2002,
                          url: "https://github.com/acme/repo/pull/7#discussion_r2002",
                          body: "Parent review comment being replied to",
                          author: { login: "cursor[bot]", __typename: "Bot" },
                          updatedAt: "2026-05-25T01:00:00Z",
                          pullRequestReview: { databaseId: 8001, author: { login: "cursor[bot]", __typename: "Bot" } },
                        },
                      ],
                    },
                  },
                  {
                    id: "thread-target",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/b.ts",
                    line: 20,
                    comments: {
                      nodes: [
                        {
                          databaseId: 2001,
                          url: "https://github.com/acme/repo/pull/7#discussion_r2001",
                          body: "Target comment the mention scopes to",
                          author: { login: "cursor[bot]", __typename: "Bot" },
                          updatedAt: "2026-05-25T01:00:00Z",
                          pullRequestReview: { databaseId: 8001, author: { login: "cursor[bot]", __typename: "Bot" } },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const issueComments = {
      ok: true,
      status: 200,
      body: [
        {
          id: 3001,
          html_url: "https://github.com/acme/repo/pull/7#issuecomment-3001",
          body: "Unrelated issue comment",
          user: { login: "cursor[bot]", type: "Bot" },
          created_at: "2026-05-25T01:00:00Z",
          updated_at: "2026-05-25T01:00:00Z",
        },
      ],
    };
    const expectedBots = [{ type: "known" as const, id: "cursor-bugbot" as const }];

    it("returns the target plus the replied-to parent context, dropping every other item", async () => {
      // Baseline: no restriction → all three items are present.
      mockFetchResponses = [threadsPage, issueComments];
      const full = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, { expectedBots });
      expect(full.items.map((i) => i.sourceId).sort()).toEqual([
        "issue-comment:3001",
        "review-comment:2001",
        "review-comment:2002",
      ]);

      // Restrict to the target + admit the parent as context → exactly those two; the unrelated issue
      // comment is dropped outright (never budget-counted).
      mockFetchResponses = [threadsPage, issueComments];
      const scoped = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots,
        restrictToSourceIds: ["review-comment:2001"],
        contextSourceIds: ["review-comment:2002"],
      });
      expect(scoped.items.map((i) => i.sourceId).sort()).toEqual(["review-comment:2001", "review-comment:2002"]);
      expect(scoped.droppedItemCount).toBe(0);
      expect(scoped.droppedBodyBytes).toBe(0);
    });

    it("a bare restrictToSourceIds cannot fetch the parent by itself (context set is required for it)", async () => {
      mockFetchResponses = [threadsPage, issueComments];
      const targetOnly = await mod.getPrReviewLoopWorklist("token", "acme", "repo", 7, {
        expectedBots,
        restrictToSourceIds: ["review-comment:2001"],
      });
      expect(targetOnly.items.map((i) => i.sourceId)).toEqual(["review-comment:2001"]);
    });
  });
});
