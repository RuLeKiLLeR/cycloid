import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionState } from "../../apps/control-plane-worker/src/types";

const mockGetSessionState = vi.fn();
const mockGetUserSettingsIfExists = vi.fn();
const mockGetUserPrReviewBotSettings = vi.fn();
const mockGetUserPrReviewBotSettingsByUserIds = vi.fn();
const mockListSessionIdsByWebhookRef = vi.fn();
const mockGetInstallationByOwner = vi.fn();
const mockGetInstallationsByOwners = vi.fn();
const mockUpdateInstallationPermissions = vi.fn();
const mockGetAppInstallationCapabilities = vi.fn();
const mockEmitReviewLoopIngestOutcomeEvent = vi.fn();

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

vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
}));

vi.mock("../../apps/control-plane-worker/src/settings/db", () => ({
  getUserSettingsIfExists: (...args: unknown[]) => mockGetUserSettingsIfExists(...args),
  getUserPrReviewBotSettings: (...args: unknown[]) => mockGetUserPrReviewBotSettings(...args),
  getUserPrReviewBotSettingsByUserIds: (...args: unknown[]) => mockGetUserPrReviewBotSettingsByUserIds(...args),
}));

vi.mock("../../apps/control-plane-worker/src/webhooks/db", () => ({
  SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR: "github_pr_url",
  listSessionIdsByWebhookRef: (...args: unknown[]) => mockListSessionIdsByWebhookRef(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...args: unknown[]) => mockGetInstallationByOwner(...args),
  getInstallationsByOwners: (...args: unknown[]) => mockGetInstallationsByOwners(...args),
  updateInstallationPermissions: (...args: unknown[]) => mockUpdateInstallationPermissions(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  getAppInstallationCapabilities: (...args: unknown[]) => mockGetAppInstallationCapabilities(...args),
}));

vi.mock("../../apps/control-plane-worker/src/observability/review-loop-events", async (importActual) => {
  const actual =
    await importActual<typeof import("../../apps/control-plane-worker/src/observability/review-loop-events")>();
  return {
    ...actual,
    emitReviewLoopIngestOutcomeEvent: (...args: unknown[]) => mockEmitReviewLoopIngestOutcomeEvent(...args),
  };
});

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

type ReviewLoopWebhookService = typeof import("../../apps/control-plane-worker/src/services/review-loop-epochs");

let sqlite: Database.Database;
let db: D1Database;
let service: ReviewLoopWebhookService;

function session(overrides: Partial<SessionState> = {}): Partial<SessionState> {
  return {
    sessionId: "s-review",
    ownerUserId: "101",
    status: "active",
    reviewListeningActive: true,
    reviewListeningPrUrl: "https://github.com/acme/repo/pull/42",
    reviewListeningHeadSha: "head-sha",
    activePromptId: null,
    ...overrides,
  };
}

const FULL_INSTALLATION = {
  installation_id: 2222,
  owner_login: "acme",
  owner_id: 2222,
  owner_type: "Organization",
  repository_selection: "all",
  permissions_json: JSON.stringify({
    checks: "read",
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    statuses: "read",
  }),
  events_json: JSON.stringify([
    "check_run",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "status",
  ]),
  created_at: 100,
  suspended_at: null,
};

const DEFAULT_BOT_SETTINGS = {
  expectedBots: [{ type: "known", id: "cursor-bugbot" }],
  expectedBotsHash: "settings-hash",
  ciResponseEnabled: true,
};

function botSettingsByUserId(entries: Array<[number, unknown]>): Map<number, unknown> {
  return new Map(entries);
}

function setBatchedBotSettings(settings: unknown): void {
  mockGetUserPrReviewBotSettingsByUserIds.mockImplementation((_db: unknown, ownerUserIds: number[]) =>
    Promise.resolve(new Map(ownerUserIds.map((ownerUserId) => [ownerUserId, settings]))),
  );
}

function setBatchedInstallation(installation: unknown): void {
  mockGetInstallationsByOwners.mockResolvedValue(new Map([["acme", installation]]));
}

beforeEach(async () => {
  vi.resetModules();
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0226_review_loop_reply_verdict.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0122_review_loop_ci_source_kind.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql", "utf8"));
  sqlite.exec(
    readFileSync("apps/control-plane-worker/migrations/0156_review_loop_verification_source_kind.sql", "utf8"),
  );
  db = new SqliteD1(sqlite) as unknown as D1Database;

  mockGetSessionState.mockReset().mockResolvedValue(session());
  // Manual review mode (ARC-1514): the checklist/human/merge-conflict gates and the humanSource ingest
  // bypass now read `automatic_reviews_enabled`. Default the harness to automatic-ON so the existing
  // bot/human ingest cases exercise their intended path; the manual-mode cases override to 0.
  mockGetUserSettingsIfExists
    .mockReset()
    .mockResolvedValue({ automatic_reviews_enabled: 1, pr_review_auto_response_enabled: 1 });
  mockGetUserPrReviewBotSettings.mockReset().mockResolvedValue({
    expectedBots: [{ type: "known", id: "cursor-bugbot" }],
    expectedBotsHash: "settings-hash",
    ciResponseEnabled: true,
  });
  mockGetUserPrReviewBotSettingsByUserIds
    .mockReset()
    .mockImplementation((_db: unknown, ownerUserIds: number[]) =>
      Promise.resolve(new Map(ownerUserIds.map((ownerUserId) => [ownerUserId, DEFAULT_BOT_SETTINGS]))),
    );
  mockGetInstallationByOwner.mockReset().mockResolvedValue(FULL_INSTALLATION);
  mockGetInstallationsByOwners.mockReset().mockResolvedValue(new Map([["acme", FULL_INSTALLATION]]));
  mockUpdateInstallationPermissions.mockReset().mockResolvedValue(undefined);
  mockGetAppInstallationCapabilities.mockReset();
  mockEmitReviewLoopIngestOutcomeEvent.mockReset().mockResolvedValue(undefined);
  mockListSessionIdsByWebhookRef.mockReset().mockResolvedValue(["s-review"]);

  service =
    (await import("../../apps/control-plane-worker/src/services/review-loop-epochs")) as ReviewLoopWebhookService;
});

describe("review-loop webhook ingestion service", () => {
  it("ignores review webhooks whose only listening session is a verification session", async () => {
    mockGetSessionState.mockReset().mockResolvedValue(session({ agentRole: "verification" }));

    const result = await service.ingestReviewLoopPullRequestReviewWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-verify",
      sourceId: "review:9002",
      reviewId: 9002,
      reviewState: "commented",
      reviewBody: "Found one issue",
      reviewCommitId: "head-sha",
      actorLogin: "cursor[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-sha",
    });

    expect(result.status).toBe("ignored");
    expect(result.status === "ignored" && result.reason).toBe("no_review_listening_session");
    expect(mockEmitReviewLoopIngestOutcomeEvent).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), {
      sourceKind: "bot",
      webhookKind: "review_submission",
      outcome: "ignored",
      reason: "no_review_listening_session",
      repo: "acme/repo",
      ownerUserId: null,
      sessionId: null,
      prUrl: "https://github.com/acme/repo/pull/42",
      bot: "cursor-bugbot",
      ignoredClass: "suspicious",
    });
  });

  it("records configured bot review submissions as terminal epoch activity", async () => {
    const result = await service.ingestReviewLoopPullRequestReviewWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-1",
      sourceId: "review:9001",
      reviewId: 9001,
      reviewState: "commented",
      reviewBody: "Found one issue",
      reviewCommitId: "head-sha",
      actorLogin: "cursor[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-sha",
    });

    expect(result.status).toBe("handled");
    expect(result.epoch?.status).toBe("ready");
    expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:cursor-bugbot"]);
    expect(result.epoch?.observedTerminalBots).toEqual(["cursor"]);
    expect(mockGetUserPrReviewBotSettingsByUserIds).toHaveBeenCalledWith(db, [101], "acme", "repo");
    expect(mockGetUserPrReviewBotSettings).not.toHaveBeenCalled();
  });

  it("stamps fallback_after_at = firstActivityAt (walltime removal: no collection window)", async () => {
    setBatchedBotSettings({
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "settings-hash",
      ciResponseEnabled: true,
    });

    const result = await service.ingestReviewLoopPullRequestReviewWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-timeout",
      sourceId: "review:9050",
      reviewId: 9050,
      reviewState: "commented",
      reviewBody: "Found one issue",
      reviewCommitId: "head-sha",
      actorLogin: "cursor[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-sha",
    });

    expect(result.status).toBe("handled");
    expect(result.epoch).toBeDefined();
    // The per-repo reviewTimeoutMinutes no longer widens the window — the epoch is immediately due.
    expect(result.epoch?.fallbackAfterAt).toBe(result.epoch?.firstActivityAt);
  });

  it("continues past stale-head sessions for the same PR URL", async () => {
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-stale", "s-current"]);
    mockGetSessionState.mockImplementation((_env: unknown, sessionId: string) =>
      Promise.resolve(
        session({
          sessionId,
          reviewListeningHeadSha: sessionId === "s-stale" ? "old-head" : "head-sha",
        }),
      ),
    );

    const result = await service.ingestReviewLoopPullRequestReviewWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-1",
      sourceId: "review:9001",
      reviewId: 9001,
      reviewState: "commented",
      reviewBody: "Found one issue",
      reviewCommitId: "head-sha",
      actorLogin: "cursor[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-sha",
    });

    expect(result.status).toBe("handled");
    expect(result.epoch?.sessionId).toBe("s-current");
    expect(result.epoch?.observedTerminalBots).toEqual(["cursor"]);
  });

  it("refreshes legacy installations whose capability snapshot has not been populated yet", async () => {
    setBatchedInstallation({
      installation_id: 2222,
      owner_login: "acme",
      owner_id: 2222,
      owner_type: "Organization",
      repository_selection: "all",
      permissions_json: null,
      events_json: null,
      created_at: 100,
      suspended_at: null,
    });
    mockGetAppInstallationCapabilities.mockResolvedValue({
      installationId: 2222,
      ownerLogin: "acme",
      ownerId: 2222,
      ownerType: "Organization",
      repositorySelection: "all",
      permissions: {
        checks: "read",
        contents: "write",
        metadata: "read",
        pull_requests: "write",
        statuses: "read",
      },
      events: [
        "check_run",
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "push",
        "status",
      ],
    });

    const result = await service.ingestReviewLoopPullRequestReviewWebhook({
      env: { DB: db, GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "private-key" } as never,
      deliveryId: "delivery-legacy-install",
      sourceId: "review:9010",
      reviewId: 9010,
      reviewState: "commented",
      reviewBody: "Found one issue",
      reviewCommitId: "head-sha",
      actorLogin: "cursor[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-sha",
    });

    expect(result.status).toBe("handled");
    expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:cursor-bugbot"]);
    expect(mockUpdateInstallationPermissions).toHaveBeenCalledWith(db, {
      installationId: 2222,
      ownerLogin: "acme",
      ownerId: 2222,
      ownerType: "Organization",
      repositorySelection: "all",
      permissions: {
        checks: "read",
        contents: "write",
        metadata: "read",
        pull_requests: "write",
        statuses: "read",
      },
      events: [
        "check_run",
        "issue_comment",
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "push",
        "status",
      ],
    });
  });

  it("fails closed when the installation lacks review-loop permissions or subscriptions", async () => {
    setBatchedInstallation({
      installation_id: 2222,
      owner_login: "acme",
      owner_id: 2222,
      owner_type: "Organization",
      repository_selection: "all",
      permissions_json: JSON.stringify({ contents: "write", metadata: "read", pull_requests: "read" }),
      events_json: JSON.stringify(["pull_request_review"]),
      created_at: 100,
      suspended_at: null,
    });

    const result = await service.ingestReviewLoopPullRequestReviewWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-missing-capabilities",
      sourceId: "review:9009",
      reviewId: 9009,
      reviewState: "commented",
      reviewBody: "Found one issue",
      reviewCommitId: "head-sha",
      actorLogin: "cursor[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-sha",
    });

    expect(result).toMatchObject({ status: "ignored", reason: "installation_capabilities_missing" });
    const row = sqlite.prepare("SELECT COUNT(*) AS count FROM pr_review_response_epochs").get() as { count: number };
    expect(row.count).toBe(0);
  });

  it("ingests a known-registry bot respond-only even for a session with no configured bots", async () => {
    // Walltime removal: a zero-bot session now resolves the checklist ok:true (was empty_expected_bots),
    // so it no longer short-circuits — the allow-list still admits a known-registry bot (cursor) respond-
    // only. The first listening session that can ingest the review therefore handles it. (The PR-review
    // ingestion still batch-loads both owners' bot settings.)
    mockListSessionIdsByWebhookRef.mockResolvedValue(["s-unconfigured", "s-current"]);
    mockGetSessionState.mockImplementation((_env: unknown, sessionId: string) =>
      Promise.resolve(
        session({
          sessionId,
          ownerUserId: sessionId === "s-unconfigured" ? "102" : "101",
        }),
      ),
    );
    mockGetUserPrReviewBotSettingsByUserIds.mockResolvedValue(
      botSettingsByUserId([
        [102, { expectedBots: [], expectedBotsHash: "empty", ciResponseEnabled: true }],
        [
          101,
          {
            expectedBots: [{ type: "known", id: "cursor-bugbot" }],
            expectedBotsHash: "settings-hash",
            ciResponseEnabled: true,
          },
        ],
      ]),
    );

    const result = await service.ingestReviewLoopPullRequestReviewWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-1",
      sourceId: "review:9001",
      reviewId: 9001,
      reviewState: "commented",
      reviewBody: "Found one issue",
      reviewCommitId: "head-sha",
      actorLogin: "cursor[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-sha",
    });

    expect(result.status).toBe("handled");
    expect(result.epoch?.sessionId).toBe("s-unconfigured");
    expect(result.epoch?.ownerUserId).toBe(102);
    // Respond-only: cursor is a known-registry bot but unconfigured for this session (never a terminal latch).
    expect(result.epoch?.observedTerminalBotKeys).toEqual([]);
    expect(mockGetInstallationsByOwners).toHaveBeenCalledWith(db, ["acme"]);
    expect(mockGetUserPrReviewBotSettingsByUserIds).toHaveBeenCalledWith(db, [102, 101], "acme", "repo");
  });

  it("records configured summary-bot PR issue comments as terminal epoch activity", async () => {
    setBatchedBotSettings({
      expectedBots: [{ type: "known", id: "greptile" }],
      expectedBotsHash: "greptile-hash",
      ciResponseEnabled: true,
    });

    const result = await service.ingestReviewLoopPrIssueCommentWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-greptile",
      sourceId: "issue-comment:9100",
      commentId: 9100,
      commentBody: "Greptile review complete",
      actorLogin: "greptile-apps[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
    });

    expect(result.status).toBe("handled");
    expect(result.epoch?.status).toBe("ready");
    expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:greptile"]);
    expect(result.epoch?.observedTerminalBots).toEqual(["greptile-apps"]);
    expect(result.epoch?.terminalEvidence).toEqual([
      {
        type: "issue_comment_final",
        sourceId: "issue-comment:9100",
        commentId: 9100,
        deliveryId: "delivery-greptile",
      },
    ]);
  });

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
          },
        ],
        [
          101,
          {
            expectedBots: [{ type: "known", id: "cursor-bugbot" }],
            expectedBotsHash: "settings-hash",
            ciResponseEnabled: true,
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
    expect(result.epoch?.status).toBe("ready");
  });

  it("DROPS a non-reviewer bot's PR issue comment (linear[bot] linkback) — the #6558 fix", async () => {
    setBatchedBotSettings({
      expectedBots: [{ type: "known", id: "greptile" }],
      expectedBotsHash: "greptile-hash",
      ciResponseEnabled: true,
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

  it("DROPS github-actions[bot]'s PR issue comment (not a configured reviewer)", async () => {
    setBatchedBotSettings({
      expectedBots: [{ type: "known", id: "greptile" }],
      expectedBotsHash: "greptile-hash",
      ciResponseEnabled: true,
    });

    const result = await service.ingestReviewLoopPrIssueCommentWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-github-actions",
      sourceId: "issue-comment:9201",
      commentId: 9201,
      commentBody: "Workflow run completed",
      actorLogin: "github-actions[bot]",
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

  it("records configured bot inline review comments as non-terminal current-head activity", async () => {
    const result = await service.ingestReviewLoopPullRequestReviewCommentWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-inline-1",
      sourceId: "review-comment:9301",
      commentId: 9301,
      commentBody: "This branch can still throw.",
      commentCommitId: "head-sha",
      actorLogin: "cursor[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-sha",
    });

    expect(result.status).toBe("handled");
    // Walltime removal: immediately due (`ready`); still non-terminal (no observed terminal bot).
    expect(result.epoch?.status).toBe("ready");
    expect(result.epoch?.observedTerminalBotKeys).toEqual([]);
    expect(result.epoch?.handledSourceIds).toEqual(["review-comment:9301"]);
    expect(result.epoch?.triggeringSourceIds).toEqual(["review-comment:9301"]);
    expect(result.epoch?.terminalEvidence).toEqual([]);

    await expect(
      service.ingestReviewLoopPullRequestReviewCommentWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-inline-2",
        sourceId: "review-comment:9302",
        commentId: 9302,
        commentBody: "Old head comment.",
        commentCommitId: "old-sha",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-sha",
      }),
    ).resolves.toMatchObject({ status: "ignored", reason: "stale_head" });
  });

  it("ignores PR issue comments when the session has no review-listening head SHA", async () => {
    mockGetSessionState.mockResolvedValue(session({ reviewListeningHeadSha: null }));

    const result = await service.ingestReviewLoopPrIssueCommentWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-6",
      sourceId: "comment:9006",
      commentId: 9006,
      commentBody: "new activity",
      actorLogin: "cursor[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
    });

    expect(result).toMatchObject({ status: "ignored", reason: "missing_head_sha" });
    const row = sqlite.prepare("SELECT COUNT(*) AS count FROM pr_review_response_epochs").get() as { count: number };
    expect(row.count).toBe(0);
  });

  it("ignores humans, unconfigured bots, custom non-bot actors, and stale-head reviews", async () => {
    await expect(
      service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-2",
        sourceId: "review:9002",
        reviewId: 9002,
        reviewState: "commented",
        reviewBody: "Human review",
        reviewCommitId: "head-sha",
        actorLogin: "octocat",
        actorType: "User",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      }),
    ).resolves.toMatchObject({ status: "ignored", reason: "actor_not_configured_bot" });

    setBatchedBotSettings({
      expectedBots: [{ type: "custom", login: "review-pal" }],
      expectedBotsHash: "custom-hash",
      ciResponseEnabled: true,
    });
    await expect(
      service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-3",
        sourceId: "review:9003",
        reviewId: 9003,
        reviewState: "commented",
        reviewBody: "custom but user",
        reviewCommitId: "head-sha",
        actorLogin: "review-pal",
        actorType: "User",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      }),
    ).resolves.toMatchObject({ status: "ignored", reason: "actor_not_configured_bot" });

    await expect(
      service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-4",
        sourceId: "review:9004",
        reviewId: 9004,
        reviewState: "commented",
        reviewBody: "old head",
        reviewCommitId: "old-sha",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-sha",
      }),
    ).resolves.toMatchObject({ status: "ignored", reason: "stale_head" });
  });

  it("emits ignored bot-review ingest telemetry with the actual reason", async () => {
    const result = await service.ingestReviewLoopPullRequestReviewWebhook({
      env: { DB: db } as never,
      deliveryId: "delivery-telemetry-1",
      sourceId: "review:9010",
      reviewId: 9010,
      reviewState: "commented",
      reviewBody: "old head",
      reviewCommitId: "old-sha",
      actorLogin: "cursor[bot]",
      actorType: "Bot",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "old-sha",
    });

    expect(result).toMatchObject({ status: "ignored", reason: "stale_head" });
    expect(mockEmitReviewLoopIngestOutcomeEvent).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), {
      sourceKind: "bot",
      webhookKind: "review_submission",
      outcome: "ignored",
      reason: "stale_head",
      repo: "acme/repo",
      ownerUserId: null,
      sessionId: null,
      prUrl: "https://github.com/acme/repo/pull/42",
      bot: "cursor-bugbot",
      ignoredClass: "expected",
    });
  });

  describe("check_run ingestion", () => {
    it("records completed check_run as terminal epoch activity for a configured bot", async () => {
      const result = await service.ingestReviewLoopCheckRunWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-check-1",
        sourceId: "check-run:9500:42",
        checkRunId: 9500,
        checkRunName: "cursor bugbot",
        checkRunStatus: "completed",
        checkRunConclusion: "success",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result.status).toBe("handled");
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:cursor-bugbot"]);
      expect(result.epoch?.observedTerminalBots).toEqual(["cursor"]);
      expect(result.epoch?.terminalEvidence).toEqual([
        {
          type: "check_run",
          sourceId: "check-run:9500:42",
          checkRunId: 9500,
          checkRunName: "cursor bugbot",
          status: "completed",
          conclusion: "success",
          deliveryId: "delivery-check-1",
        },
      ]);
    });

    it("records a non-success (failure) completed check_run as terminal — any completed conclusion is terminal", async () => {
      const result = await service.ingestReviewLoopCheckRunWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-check-fail",
        sourceId: "check-run:9501:42",
        checkRunId: 9501,
        checkRunName: "cursor bugbot",
        checkRunStatus: "completed",
        checkRunConclusion: "failure",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result.status).toBe("handled");
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:cursor-bugbot"]);
      expect(result.epoch?.terminalEvidence?.[0]).toMatchObject({ conclusion: "failure" });
    });

    it("ignores a check_run that is still in_progress (not yet terminal)", async () => {
      const result = await service.ingestReviewLoopCheckRunWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-check-pending",
        sourceId: "check-run:9502:42",
        checkRunId: 9502,
        checkRunName: "cursor bugbot",
        checkRunStatus: "in_progress",
        checkRunConclusion: null,
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result.status).toBe("ignored");
    });

    it("records Strix Security check_run as terminal epoch activity for configured Strix", async () => {
      setBatchedBotSettings({
        expectedBots: [{ type: "known", id: "strix" }],
        expectedBotsHash: "strix-hash",
        ciResponseEnabled: true,
      });

      const result = await service.ingestReviewLoopCheckRunWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-strix-check",
        sourceId: "check-run:9505:42",
        checkRunId: 9505,
        checkRunName: "Strix Security Review",
        checkRunStatus: "completed",
        checkRunConclusion: "success",
        actorLogin: "strix-security[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result.status).toBe("handled");
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:strix"]);
      expect(result.epoch?.observedTerminalBots).toEqual(["strix-security"]);
    });

    it("ignores check_run from a bot whose capability does not list check_run", async () => {
      setBatchedBotSettings({
        expectedBots: [{ type: "known", id: "chatgpt-codex" }],
        expectedBotsHash: "codex-hash",
        ciResponseEnabled: true,
      });

      const result = await service.ingestReviewLoopCheckRunWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-check-2",
        sourceId: "check-run:9501:42",
        checkRunId: 9501,
        checkRunName: "codex",
        checkRunStatus: "completed",
        checkRunConclusion: "success",
        actorLogin: "chatgpt-codex-connector[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result).toMatchObject({ status: "ignored", reason: "actor_not_configured_bot" });
      const row = sqlite.prepare("SELECT COUNT(*) AS count FROM pr_review_response_epochs").get() as { count: number };
      expect(row.count).toBe(0);
    });

    it("ignores check_run whose head SHA no longer matches the review-listening session", async () => {
      const result = await service.ingestReviewLoopCheckRunWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-check-3",
        sourceId: "check-run:9502:42",
        checkRunId: 9502,
        checkRunName: "cursor bugbot",
        checkRunStatus: "completed",
        checkRunConclusion: "failure",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-sha",
      });

      expect(result).toMatchObject({ status: "ignored", reason: "stale_head" });
    });

    it("ignores check_run from a non-bot actor", async () => {
      const result = await service.ingestReviewLoopCheckRunWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-check-4",
        sourceId: "check-run:9503:42",
        checkRunId: 9503,
        checkRunName: "ci",
        checkRunStatus: "completed",
        checkRunConclusion: "success",
        actorLogin: "octocat",
        actorType: "User",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result).toMatchObject({ status: "ignored", reason: "actor_not_configured_bot" });
    });

    it("ignores check_run when the matched session has no review-listening head SHA", async () => {
      mockGetSessionState.mockResolvedValueOnce(session({ reviewListeningHeadSha: null }));

      const result = await service.ingestReviewLoopCheckRunWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-check-5",
        sourceId: "check-run:9504:42",
        checkRunId: 9504,
        checkRunName: "cursor bugbot",
        checkRunStatus: "completed",
        checkRunConclusion: "success",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result).toMatchObject({ status: "ignored", reason: "missing_head_sha" });
      expect(mockEmitReviewLoopIngestOutcomeEvent).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), {
        sourceKind: "bot",
        webhookKind: "check_run",
        outcome: "ignored",
        reason: "missing_head_sha",
        repo: "acme/repo",
        ownerUserId: null,
        sessionId: null,
        prUrl: "https://github.com/acme/repo/pull/42",
        bot: "cursor-bugbot",
        ignoredClass: "expected",
      });
    });

    it("keeps ambient check_run no-listener drops out of the suspicious alert class", async () => {
      mockListSessionIdsByWebhookRef.mockResolvedValueOnce([]);

      const result = await service.ingestReviewLoopCheckRunWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-check-6",
        sourceId: "check-run:9505:42",
        checkRunId: 9505,
        checkRunName: "cursor bugbot",
        checkRunStatus: "completed",
        checkRunConclusion: "success",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result).toMatchObject({ status: "ignored", reason: "no_session_for_pr" });
      expect(mockEmitReviewLoopIngestOutcomeEvent).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), {
        sourceKind: "bot",
        webhookKind: "check_run",
        outcome: "ignored",
        reason: "no_session_for_pr",
        repo: "acme/repo",
        ownerUserId: null,
        sessionId: null,
        prUrl: "https://github.com/acme/repo/pull/42",
        bot: "cursor-bugbot",
        ignoredClass: "expected",
      });
    });

    it("keeps a bot review on a PR Cycloid never tracked out of the suspicious class", async () => {
      // No session webhook-ref for the PR (human/third-party PR a review bot commented on). Even though
      // review_submission is a content webhook, the reason is `no_session_for_pr` → ignoredClass expected,
      // so the suspicious-ignored-ingest monitor never fires on it.
      mockListSessionIdsByWebhookRef.mockResolvedValueOnce([]);

      const result = await service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-unaffiliated",
        sourceId: "review:9600",
        reviewId: 9600,
        reviewState: "commented",
        reviewBody: "Found one issue",
        reviewCommitId: "head-sha",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result).toMatchObject({ status: "ignored", reason: "no_session_for_pr" });
      expect(mockEmitReviewLoopIngestOutcomeEvent).toHaveBeenCalledWith(expect.objectContaining({ DB: db }), {
        sourceKind: "bot",
        webhookKind: "review_submission",
        outcome: "ignored",
        reason: "no_session_for_pr",
        repo: "acme/repo",
        ownerUserId: null,
        sessionId: null,
        prUrl: "https://github.com/acme/repo/pull/42",
        bot: "cursor-bugbot",
        ignoredClass: "expected",
      });
    });
  });

  describe("ci_failure ingestion", () => {
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

    it("records a CI failure on a repo with ZERO configured bots (no longer dropped)", async () => {
      setBatchedBotSettings({
        expectedBots: [],
        expectedBotsHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ciResponseEnabled: true,
      });
      const result = await service.ingestReviewLoopCiFailureWebhook({
        env: { DB: db } as never,
        deliveryId: "d-ci-nobots",
        sourceId: "check_run:9001",
        checkRunId: 9001,
        checkRunName: "build",
        checkRunConclusion: "failure",
        actorLogin: "github-actions",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });
      expect(result.status).toBe("handled");
    });

    it("ingests a CI failure even when the (removed) per-repo CI-response opt-out was off", async () => {
      // ARC-1288: the CI-response opt-out was removed; CI failures are always ingested for capable
      // repos regardless of a once-"off" ciResponseEnabled. Only missing capabilities would skip.
      setBatchedBotSettings({
        expectedBots: [],
        expectedBotsHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ciResponseEnabled: false,
      });
      const result = await service.ingestReviewLoopCiFailureWebhook({
        env: { DB: db } as never,
        deliveryId: "d-ci-optout",
        sourceId: "check_run:9002",
        checkRunId: 9002,
        checkRunName: "build",
        checkRunConclusion: "failure",
        actorLogin: "github-actions",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });
      expect(result.status).toBe("handled");
    });

    it("creates a SEPARATE ci epoch rather than folding into a concurrent bot epoch on the same head", async () => {
      // Arrange: an in-flight bot epoch on the same head/PR (settings-hash from the default mock).
      const botEpoch = await service.upsertReviewLoopEpochActivity(db, {
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        expectedBotsHash: "settings-hash",
        sourceId: "review:1",
        botKey: "known:cursor-bugbot",
        botActorLogin: "cursor[bot]",
        terminal: true,
        evidence: { type: "test" },
        nowMs: Date.now(),
      });

      const result = await service.ingestReviewLoopCiFailureWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-ci-iso",
        sourceId: "check-run:7777:42",
        checkRunId: 7777,
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

      expect(result.status).toBe("handled");
      // A distinct epoch row — NOT the bot epoch folded into.
      expect(result.epoch?.id).not.toBe(botEpoch.id);
      expect(result.epoch?.sourceKind).toBe("ci");
      expect(result.epoch?.expectedBotsHash).toBe(service.REVIEW_LOOP_CI_EPOCH_HASH);
      // Two distinct rows exist on the same head.
      const rows = sqlite
        .prepare("SELECT source_kind, expected_bots_hash FROM pr_review_response_epochs WHERE head_sha = ?")
        .all("head-sha") as { source_kind: string; expected_bots_hash: string }[];
      expect(rows).toHaveLength(2);
      expect(rows.some((r) => r.source_kind === "bot" && r.expected_bots_hash === "settings-hash")).toBe(true);
      expect(
        rows.some((r) => r.source_kind === "ci" && r.expected_bots_hash === service.REVIEW_LOOP_CI_EPOCH_HASH),
      ).toBe(true);
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

    it("a ready ci epoch is selected by listDueReviewLoopEpochs (no source_kind filter)", async () => {
      const ingested = await service.ingestReviewLoopCiFailureWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-ci-due",
        sourceId: "check-run:7300:42",
        checkRunId: 7300,
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
      expect(ingested.status).toBe("handled");
      expect(ingested.epoch?.status).toBe("ready");

      const due = await service.listDueReviewLoopEpochs(db, { nowMs: Date.now(), limit: 50 });
      expect(due.some((e) => e.id === ingested.epoch?.id && e.sourceKind === "ci")).toBe(true);
    });
  });

  describe("epoch status and source-kind merging", () => {
    it("marks ci, verification, and no-bot human epochs ready", async () => {
      const ciEpoch = await service.upsertReviewLoopEpochActivity(db, {
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha-ci-ready",
        expectedBots: [],
        expectedBotsHash: service.REVIEW_LOOP_CI_EPOCH_HASH,
        sourceId: "check-run-failure:ready",
        sourceKind: "ci",
        botKey: "ci",
        botActorLogin: "github-actions[bot]",
        terminal: true,
        evidence: { type: "ci_failure" },
        nowMs: 1_000,
      });
      expect(ciEpoch.sourceKind).toBe("ci");
      expect(ciEpoch.status).toBe("ready");

      const verificationEpoch = await service.bootstrapReviewLoopEpochForVerification(db, {
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha-verification-ready",
        triggeringSourceId: "verification:ready",
        nowMs: 2_000,
      });
      expect(verificationEpoch.sourceKind).toBe("verification");
      expect(verificationEpoch.status).toBe("ready");

      const humanEpoch = await service.upsertReviewLoopEpochActivity(db, {
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha-human-ready",
        expectedBots: [],
        expectedBotsHash: service.EMPTY_EXPECTED_BOTS_HASH,
        sourceId: "human:ready",
        botKey: "",
        botActorLogin: "alice",
        terminal: false,
        evidence: { type: "review" },
        nowMs: 3_000,
        humanSource: { userId: 7, login: "alice" },
      });
      expect(humanEpoch.sourceKind).toBe("human");
      expect(humanEpoch.status).toBe("ready");
    });

    it("widens bot epochs to mixed on a human fold-in (epoch stays ready)", async () => {
      const botEpoch = await service.upsertReviewLoopEpochActivity(db, {
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha-mixed-collecting",
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        expectedBotsHash: "settings-hash",
        sourceId: "review-comment:mixed-collecting",
        botKey: "known:cursor-bugbot",
        botActorLogin: "cursor[bot]",
        terminal: false,
        evidence: { type: "review_comment" },
        nowMs: 4_000,
      });
      expect(botEpoch.sourceKind).toBe("bot");
      expect(botEpoch.status).toBe("ready");

      const mixedEpoch = await service.upsertReviewLoopEpochActivity(db, {
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha-mixed-collecting",
        expectedBots: [{ type: "known", id: "cursor-bugbot" }],
        expectedBotsHash: "settings-hash",
        sourceId: "human:mixed-collecting",
        botKey: "",
        botActorLogin: "alice",
        terminal: false,
        evidence: { type: "review" },
        nowMs: 5_000,
        humanSource: { userId: 7, login: "alice" },
      });
      expect(mixedEpoch.id).toBe(botEpoch.id);
      expect(mixedEpoch.sourceKind).toBe("mixed");
      expect(mixedEpoch.status).toBe("ready");
    });
  });

  describe("countConsecutiveCiFixEpochsForPr", () => {
    const PR = "https://github.com/acme/repo/pull/42";

    const ciEpoch = (headSha: string, sourceId: string, nowMs: number) =>
      service.upsertReviewLoopEpochActivity(db, {
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: PR,
        headSha,
        expectedBots: [],
        expectedBotsHash: service.REVIEW_LOOP_CI_EPOCH_HASH,
        sourceId,
        sourceKind: "ci",
        botKey: "ci",
        botActorLogin: "github-actions[bot]",
        terminal: true,
        evidence: { type: "ci_failure", sourceId },
        nowMs,
      });

    const humanEpoch = (headSha: string, sourceId: string, nowMs: number) =>
      service.upsertReviewLoopEpochActivity(db, {
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: PR,
        headSha,
        expectedBots: [],
        expectedBotsHash: service.EMPTY_EXPECTED_BOTS_HASH,
        sourceId,
        botKey: "",
        botActorLogin: "octocat",
        terminal: false,
        evidence: { type: "review" },
        nowMs,
        humanSource: { userId: 7, login: "octocat" },
      });

    // Each ci epoch records its failing-check fingerprint in worklist_hash at enqueue. The DAO
    // tests set it directly to simulate that, since upsertReviewLoopEpochActivity (the ingest path)
    // does not write worklist_hash.
    const setFingerprint = (epochId: string, fingerprint: string) =>
      sqlite.prepare("UPDATE pr_review_response_epochs SET worklist_hash = ? WHERE id = ?").run(fingerprint, epochId);

    const FP_A = "ci-fail:unit";
    const FP_B = "ci-fail:typecheck";

    it("breaks both streaks at a review epoch (prior ci epochs after a human epoch do not count)", async () => {
      // History oldest→newest: ci(#1 FP_A), ci(#2 FP_A), human(#3), ci(#4 = current FP_A).
      const e1 = await ciEpoch("h1", "check-run-failure:1", 1_000);
      const e2 = await ciEpoch("h2", "check-run-failure:2", 2_000);
      setFingerprint(e1.id, FP_A);
      setFingerprint(e2.id, FP_A);
      await humanEpoch("h3", "review:3", 3_000);
      const current = await ciEpoch("h4", "check-run-failure:4", 4_000);

      const { sameFingerprintStreak, totalConsecutiveStreak } = await service.countConsecutiveCiFixEpochsForPr(db, {
        sessionId: "s-review",
        prUrl: PR,
        excludeEpochId: current.id,
        fingerprint: FP_A,
      });
      // Excluding current ci(#4), the next-newest epoch is human(#3) → break → 0 priors of either.
      expect(sameFingerprintStreak).toBe(0);
      expect(totalConsecutiveStreak).toBe(0);
    });

    it("counts both streaks when prior ci epochs share the current fingerprint", async () => {
      // History: ci(#1 FP_A), ci(#2 FP_A), ci(#3 = current FP_A). Excluding current → 2 priors.
      const e1 = await ciEpoch("h1", "check-run-failure:1", 1_000);
      const e2 = await ciEpoch("h2", "check-run-failure:2", 2_000);
      setFingerprint(e1.id, FP_A);
      setFingerprint(e2.id, FP_A);
      const current = await ciEpoch("h3", "check-run-failure:3", 3_000);

      const { sameFingerprintStreak, totalConsecutiveStreak } = await service.countConsecutiveCiFixEpochsForPr(db, {
        sessionId: "s-review",
        prUrl: PR,
        excludeEpochId: current.id,
        fingerprint: FP_A,
      });
      expect(sameFingerprintStreak).toBe(2);
      expect(totalConsecutiveStreak).toBe(2);
    });

    it("a different prior fingerprint resets sameFingerprintStreak but keeps totalConsecutiveStreak", async () => {
      // History: ci(#1 FP_A), ci(#2 FP_A), ci(#3 FP_B), ci(#4 = current FP_B).
      // From newest excluding current: ci(#3 FP_B) matches → same=1; ci(#2 FP_A) differs → same stops;
      // ci(#1 FP_A) still counts toward total. Total = 3.
      const e1 = await ciEpoch("h1", "check-run-failure:1", 1_000);
      const e2 = await ciEpoch("h2", "check-run-failure:2", 2_000);
      const e3 = await ciEpoch("h3", "check-run-failure:3", 3_000);
      setFingerprint(e1.id, FP_A);
      setFingerprint(e2.id, FP_A);
      setFingerprint(e3.id, FP_B);
      const current = await ciEpoch("h4", "check-run-failure:4", 4_000);

      const { sameFingerprintStreak, totalConsecutiveStreak } = await service.countConsecutiveCiFixEpochsForPr(db, {
        sessionId: "s-review",
        prUrl: PR,
        excludeEpochId: current.id,
        fingerprint: FP_B,
      });
      expect(sameFingerprintStreak).toBe(1);
      expect(totalConsecutiveStreak).toBe(3);
    });

    it("finds prior retry context with overlapping failing check names", async () => {
      const prior = await ciEpoch("h-prior", "check-run-failure:overlap-1", 1_000);
      setFingerprint(prior.id, 'ci-fail:["lint","typecheck"]');
      const current = await ciEpoch("h-current", "check-run-failure:overlap-2", 2_000);

      const result = await service.getLatestPriorMatchingCiFixAttempt(db, {
        sessionId: "s-review",
        prUrl: PR,
        excludeEpochId: current.id,
        fingerprint: 'ci-fail:["typecheck"]',
      });

      expect(result).toMatchObject({
        epochId: prior.id,
        headSha: "h-prior",
        failingCheckFingerprint: 'ci-fail:["lint","typecheck"]',
      });
    });

    it("same-fingerprint cap is reached exactly at the 3rd attempt against the same checks", async () => {
      // ci(#1 FP_A), ci(#2 FP_A) prior, ci(#3 = current FP_A). same-streak excluding current = 2 (< 3 → enqueue #3).
      const e1 = await ciEpoch("h1", "check-run-failure:1", 1_000);
      const e2 = await ciEpoch("h2", "check-run-failure:2", 2_000);
      setFingerprint(e1.id, FP_A);
      setFingerprint(e2.id, FP_A);
      const third = await ciEpoch("h3", "check-run-failure:3", 3_000);
      expect(
        (
          await service.countConsecutiveCiFixEpochsForPr(db, {
            sessionId: "s-review",
            prUrl: PR,
            excludeEpochId: third.id,
            fingerprint: FP_A,
          })
        ).sameFingerprintStreak,
      ).toBe(2);
      // A 4th attempt against the same checks would see 3 same-fingerprint priors → cap.
      setFingerprint(third.id, FP_A);
      const fourth = await ciEpoch("h4", "check-run-failure:4", 4_000);
      expect(
        (
          await service.countConsecutiveCiFixEpochsForPr(db, {
            sessionId: "s-review",
            prUrl: PR,
            excludeEpochId: fourth.id,
            fingerprint: FP_A,
          })
        ).sameFingerprintStreak,
      ).toBe(3);
    });

    const blockCapReached = (epochId: string) =>
      sqlite
        .prepare(
          "UPDATE pr_review_response_epochs SET status = 'blocked', blocked_reason = 'ci_attempt_cap_reached' WHERE id = ?",
        )
        .run(epochId);

    it("FIX 6b: hasCiAttemptCapEscalationForHead detects a prior cap escalation on the same head", async () => {
      const capped = await ciEpoch("h-cap", "ci-check:10:42", 1_000);
      blockCapReached(capped.id);
      const another = await ciEpoch("h-cap", "ci-check:11:42", 2_000);

      // Same head as the capped epoch → escalation already exists.
      expect(
        await service.hasCiAttemptCapEscalationForHead(db, {
          sessionId: "s-review",
          prUrl: PR,
          headSha: "h-cap",
          excludeEpochId: another.id,
        }),
      ).toBe(true);
      // A different head has no prior escalation.
      expect(
        await service.hasCiAttemptCapEscalationForHead(db, {
          sessionId: "s-review",
          prUrl: PR,
          headSha: "h-other",
          excludeEpochId: another.id,
        }),
      ).toBe(false);
    });
  });

  describe("commit_status ingestion", () => {
    it("records CodeRabbit commit status as terminal epoch activity for configured CodeRabbit", async () => {
      setBatchedBotSettings({
        expectedBots: [{ type: "known", id: "coderabbit" }],
        expectedBotsHash: "coderabbit-hash",
        ciResponseEnabled: true,
      });

      const result = await service.ingestReviewLoopCommitStatusWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-status-1",
        sourceId: "commit-status:9600:42",
        statusId: 9600,
        context: "CodeRabbit",
        state: "success",
        description: "Review completed",
        targetUrl: "https://coderabbit.ai/gh/trycycloid/cycloid/pulls/42",
        actorLogin: "coderabbitai",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result.status).toBe("handled");
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:coderabbit"]);
      expect(result.epoch?.observedTerminalBots).toEqual(["coderabbitai"]);
      expect(result.epoch?.terminalEvidence).toEqual([
        {
          type: "commit_status",
          sourceId: "commit-status:9600:42",
          statusId: 9600,
          context: "CodeRabbit",
          state: "success",
          description: "Review completed",
          targetUrl: "https://coderabbit.ai/gh/trycycloid/cycloid/pulls/42",
          deliveryId: "delivery-status-1",
        },
      ]);
    });

    it("records a non-success (failure) commit status as terminal — matches the backfill/bootstrap semantics", async () => {
      setBatchedBotSettings({
        expectedBots: [{ type: "known", id: "coderabbit" }],
        expectedBotsHash: "coderabbit-hash",
      });

      const result = await service.ingestReviewLoopCommitStatusWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-status-fail",
        sourceId: "commit-status:9601:42",
        statusId: 9601,
        context: "CodeRabbit",
        state: "failure",
        description: "Issues found",
        targetUrl: null,
        actorLogin: "coderabbitai",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result.status).toBe("handled");
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:coderabbit"]);
      expect(result.epoch?.terminalEvidence?.[0]).toMatchObject({ state: "failure" });
    });

    it("ignores a pending commit status (still running)", async () => {
      setBatchedBotSettings({
        expectedBots: [{ type: "known", id: "coderabbit" }],
        expectedBotsHash: "coderabbit-hash",
      });

      const result = await service.ingestReviewLoopCommitStatusWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-status-pending",
        sourceId: "commit-status:9602:42",
        statusId: 9602,
        context: "CodeRabbit",
        state: "pending",
        description: "Review in progress",
        targetUrl: null,
        actorLogin: "coderabbitai",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(result.status).toBe("ignored");
    });
  });

  describe("bootstrapReviewLoopEpochFromHeadSignals", () => {
    function bootstrapInput(overrides: Record<string, unknown> = {}) {
      return {
        env: { DB: db } as never,
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
        expectedBots: [{ type: "known", id: "strix" }] as const,
        expectedBotsHash: "strix-hash",
        checkRuns: [] as Array<{
          id: number;
          name: string | null;
          status: string;
          conclusion: string | null;
          appSlug: string | null;
          appName: string | null;
          detailsUrl: string | null;
        }>,
        commitStatuses: [] as Array<{
          id: number;
          state: string;
          context: string | null;
          description: string | null;
          targetUrl: string | null;
          creatorLogin: string | null;
          creatorType: string | null;
        }>,
        nowMs: 1_000_000,
        ...overrides,
      };
    }

    it("bootstraps an epoch from a successful Strix check_run when none exists", async () => {
      const result = await service.bootstrapReviewLoopEpochFromHeadSignals(
        bootstrapInput({
          checkRuns: [
            {
              id: 9505,
              name: "Strix Security Review",
              status: "completed",
              conclusion: "success",
              appSlug: "strix-security",
              appName: "Strix",
              detailsUrl: null,
            },
          ],
        }),
      );

      expect(result.bootstrapped).toBe(1);
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:strix"]);
      expect(result.epoch?.observedTerminalBots).toEqual(["strix-security"]);
      expect(result.epoch?.handledSourceIds).toEqual(["check-run:9505:42"]);
      expect(result.epoch?.terminalEvidence).toHaveLength(1);
      expect(result.epoch?.terminalEvidence?.[0]).toMatchObject({
        type: "check_run",
        source: "head_reconciliation",
        checkRunId: 9505,
        conclusion: "success",
      });
    });

    it("bootstraps an epoch from a successful CodeRabbit commit_status when none exists", async () => {
      const result = await service.bootstrapReviewLoopEpochFromHeadSignals(
        bootstrapInput({
          expectedBots: [{ type: "known", id: "coderabbit" }],
          expectedBotsHash: "coderabbit-hash",
          commitStatuses: [
            {
              id: 9600,
              state: "success",
              context: "CodeRabbit",
              description: "Review completed",
              targetUrl: "https://coderabbit.ai/x",
              creatorLogin: "coderabbitai",
              creatorType: "Bot",
            },
          ],
        }),
      );

      expect(result.bootstrapped).toBe(1);
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:coderabbit"]);
      expect(result.epoch?.observedTerminalBots).toEqual(["coderabbitai"]);
      expect(result.epoch?.handledSourceIds).toEqual(["commit-status:9600:42"]);
      expect(result.epoch?.terminalEvidence?.[0]).toMatchObject({
        type: "commit_status",
        source: "head_reconciliation",
        statusId: 9600,
        state: "success",
      });
    });

    it("bootstraps a partially-observed epoch as ready, accumulating the observed terminal bot", async () => {
      // Walltime removal: the epoch is immediately `ready` even though only one of two expected bots is
      // terminal — the observed terminal set still accumulates correctly.
      const result = await service.bootstrapReviewLoopEpochFromHeadSignals(
        bootstrapInput({
          expectedBots: [
            { type: "known", id: "strix" },
            { type: "known", id: "coderabbit" },
          ],
          expectedBotsHash: "strix+coderabbit-hash",
          checkRuns: [
            {
              id: 9505,
              name: "Strix Security Review",
              status: "completed",
              conclusion: "success",
              appSlug: "strix-security",
              appName: "Strix",
              detailsUrl: null,
            },
          ],
        }),
      );

      expect(result.bootstrapped).toBe(1);
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:strix"]);
    });

    it("ignores unconfigured bots, GitHub Actions checks, and still-running signals", async () => {
      const result = await service.bootstrapReviewLoopEpochFromHeadSignals(
        bootstrapInput({
          expectedBots: [{ type: "known", id: "coderabbit" }],
          expectedBotsHash: "coderabbit-hash",
          checkRuns: [
            {
              id: 1001,
              name: "tests",
              status: "completed",
              conclusion: "success",
              appSlug: "github-actions",
              appName: "GitHub Actions",
              detailsUrl: null,
            },
            {
              id: 1003,
              name: "Strix Security Review",
              status: "in_progress",
              conclusion: null,
              appSlug: "strix-security",
              appName: "Strix",
              detailsUrl: null,
            },
          ],
          commitStatuses: [
            {
              id: 2001,
              state: "pending",
              context: "CodeRabbit",
              description: null,
              targetUrl: null,
              creatorLogin: "coderabbitai",
              creatorType: "Bot",
            },
          ],
        }),
      );

      expect(result.bootstrapped).toBe(0);
      expect(result.epoch).toBeNull();
      const row = sqlite.prepare("SELECT COUNT(*) AS count FROM pr_review_response_epochs").get() as { count: number };
      expect(row.count).toBe(0);
    });

    it("bootstraps a configured bot from a non-success (failure) commit_status — any completed status is terminal", async () => {
      const result = await service.bootstrapReviewLoopEpochFromHeadSignals(
        bootstrapInput({
          expectedBots: [{ type: "known", id: "coderabbit" }],
          expectedBotsHash: "coderabbit-hash",
          commitStatuses: [
            {
              id: 2002,
              state: "failure",
              context: "CodeRabbit",
              description: "Issues found",
              targetUrl: null,
              creatorLogin: "coderabbitai",
              creatorType: "Bot",
            },
          ],
        }),
      );

      expect(result.bootstrapped).toBe(1);
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:coderabbit"]);
      expect(result.epoch?.terminalEvidence?.[0]).toMatchObject({
        type: "commit_status",
        statusId: 2002,
        state: "failure",
      });
    });

    it("bootstraps a configured bot from a non-success (cancelled) check_run — any completed conclusion is terminal", async () => {
      const result = await service.bootstrapReviewLoopEpochFromHeadSignals(
        bootstrapInput({
          checkRuns: [
            {
              id: 1002,
              name: "Strix Security Review",
              status: "completed",
              conclusion: "cancelled",
              appSlug: "strix-security",
              appName: "Strix",
              detailsUrl: null,
            },
          ],
        }),
      );

      expect(result.bootstrapped).toBe(1);
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:strix"]);
      expect(result.epoch?.terminalEvidence?.[0]).toMatchObject({
        type: "check_run",
        checkRunId: 1002,
        conclusion: "cancelled",
      });
    });

    it("enriches an existing ready epoch from polled signals using stable source IDs", async () => {
      setBatchedBotSettings({
        expectedBots: [{ type: "known", id: "strix" }],
        expectedBotsHash: "strix-hash",
        ciResponseEnabled: true,
      });

      await service.ingestReviewLoopPullRequestReviewCommentWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-warmup",
        sourceId: "review-comment:7001",
        commentId: 7001,
        commentBody: "Looking",
        commentCommitId: "head-sha",
        actorLogin: "strix-security[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      const before = sqlite.prepare("SELECT id, status FROM pr_review_response_epochs").all() as Array<{
        id: string;
        status: string;
      }>;
      expect(before).toHaveLength(1);
      expect(before[0].status).toBe("ready");

      const result = await service.bootstrapReviewLoopEpochFromHeadSignals(
        bootstrapInput({
          checkRuns: [
            {
              id: 9505,
              name: "Strix Security Review",
              status: "completed",
              conclusion: "success",
              appSlug: "strix-security",
              appName: "Strix",
              detailsUrl: null,
            },
          ],
        }),
      );

      expect(result.bootstrapped).toBe(1);
      expect(result.epoch?.id).toBe(before[0].id);
      expect(result.epoch?.status).toBe("ready");
      expect(result.epoch?.observedTerminalBotKeys).toEqual(["known:strix"]);
      expect(result.epoch?.handledSourceIds.sort()).toEqual(["check-run:9505:42", "review-comment:7001"]);
    });

    it("ignores an older success when a newer non-success status exists for the same context", async () => {
      const result = await service.bootstrapReviewLoopEpochFromHeadSignals(
        bootstrapInput({
          expectedBots: [{ type: "known", id: "coderabbit" }],
          expectedBotsHash: "coderabbit-hash",
          commitStatuses: [
            {
              id: 9700,
              state: "pending",
              context: "CodeRabbit",
              description: "Re-running",
              targetUrl: null,
              creatorLogin: "coderabbitai",
              creatorType: "Bot",
            },
            {
              id: 9600,
              state: "success",
              context: "CodeRabbit",
              description: "Review completed",
              targetUrl: null,
              creatorLogin: "coderabbitai",
              creatorType: "Bot",
            },
          ],
        }),
      );

      expect(result.bootstrapped).toBe(0);
      expect(result.epoch).toBeNull();
      const row = sqlite.prepare("SELECT COUNT(*) AS count FROM pr_review_response_epochs").get() as { count: number };
      expect(row.count).toBe(0);
    });

    it("is idempotent across repeated bootstrap calls for the same source IDs", async () => {
      const input = bootstrapInput({
        checkRuns: [
          {
            id: 9505,
            name: "Strix Security Review",
            status: "completed",
            conclusion: "success",
            appSlug: "strix-security",
            appName: "Strix",
            detailsUrl: null,
          },
        ],
      });

      const first = await service.bootstrapReviewLoopEpochFromHeadSignals(input);
      const second = await service.bootstrapReviewLoopEpochFromHeadSignals(input);

      expect(first.bootstrapped).toBe(1);
      expect(second.bootstrapped).toBe(1);
      expect(second.epoch?.id).toBe(first.epoch?.id);
      const row = sqlite.prepare("SELECT COUNT(*) AS count FROM pr_review_response_epochs").get() as { count: number };
      expect(row.count).toBe(1);
    });

    /**
     * FIX 4: a ci epoch on a head must NOT count as "an epoch already exists" for that head,
     * so head reconciliation can still bootstrap a real bot/human review epoch there.
     */
    it("ci epoch on head H does not suppress hasReviewLoopEpochForHead / bot bootstrap (FIX 4)", async () => {
      // A ci epoch on head-sha.
      const ci = await service.ingestReviewLoopCiFailureWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-ci-bootstrap",
        sourceId: "ci-check:9400:42",
        checkRunId: 9400,
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
      expect(ci.epoch?.sourceKind).toBe("ci");

      // The ci epoch must not register as an existing epoch for the head.
      const exists = await service.hasReviewLoopEpochForHead(db, {
        sessionId: "s-review",
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });
      expect(exists).toBe(false);

      // Bootstrapping a bot signal on the same head still creates a bot epoch.
      const result = await service.bootstrapReviewLoopEpochFromHeadSignals({
        env: { DB: db } as never,
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
        expectedBots: [{ type: "known", id: "strix" }],
        expectedBotsHash: "strix-hash",
        checkRuns: [
          {
            id: 9505,
            name: "Strix Security Review",
            status: "completed",
            conclusion: "success",
            appSlug: "strix-security",
            appName: "Strix",
            detailsUrl: null,
          },
        ],
        commitStatuses: [],
        nowMs: Date.now(),
      });
      expect(result.bootstrapped).toBe(1);
      expect(result.epoch?.sourceKind).toBe("bot");
      // Now a bot/human epoch exists for the head.
      const existsAfter = await service.hasReviewLoopEpochForHead(db, {
        sessionId: "s-review",
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });
      expect(existsAfter).toBe(true);
    });
  });

  describe("Fix A regression — human fold-in during active bot wave", () => {
    /**
     * Seeds an active bot epoch (non-empty expectedBotsHash) then
     * calls ingestReviewLoopPullRequestReviewWebhook with humanSource set.
     * Asserts the human folds into the bot epoch:
     *   - exactly ONE epoch exists
     *   - sourceKind is "mixed"
     *   - triggeringSourceIds contains "review-body:<reviewId>" (NOT "review:<reviewId>")
     *   - status stays "ready" (immediately due; walltime removal)
     */
    it("folds a human review into an active bot epoch → one mixed epoch, still ready", async () => {
      // First, seed a bot epoch by ingesting a non-terminal bot signal (inline review comment).
      const botResult = await service.ingestReviewLoopPullRequestReviewCommentWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-bot-warmup",
        sourceId: "review-comment:8001",
        commentId: 8001,
        commentBody: "Bot is looking at it",
        commentCommitId: "head-sha",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });

      expect(botResult.status).toBe("handled");
      expect(botResult.epoch?.status).toBe("ready");
      expect(botResult.epoch?.sourceKind).toBe("bot");

      const reviewId = 5555;

      // Now ingest the human review while the bot epoch is still open (ready).
      const humanResult = await service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-human-1",
        sourceId: `review-body:${reviewId}`,
        reviewId,
        reviewState: "commented",
        reviewBody: "Looks good to me",
        reviewCommitId: "head-sha",
        actorLogin: "alice",
        actorType: "User",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
        humanSource: { userId: 42, login: "alice" },
      });

      expect(humanResult.status).toBe("handled");

      // Exactly ONE epoch must exist (human folded in, not a new separate epoch).
      const rows = sqlite
        .prepare("SELECT id, status, source_kind, triggering_source_ids_json FROM pr_review_response_epochs")
        .all() as Array<{ id: string; status: string; source_kind: string; triggering_source_ids_json: string }>;
      expect(rows).toHaveLength(1);

      const epoch = rows[0];
      expect(epoch.source_kind).toBe("mixed");

      const triggeringIds: string[] = JSON.parse(epoch.triggering_source_ids_json) as string[];
      expect(triggeringIds).toContain(`review-body:${reviewId}`);
      // Must NOT contain the raw review:<reviewId> sourceId
      expect(triggeringIds).not.toContain(`review:${reviewId}`);

      // Status stays ready — immediately due (walltime removal).
      expect(epoch.status).toBe("ready");
    });

    it("does NOT fold a human review into a verification-intake epoch — creates a separate human epoch", async () => {
      // A verification-intake epoch is in flight on the head (QTA needs-work verdict), on the same
      // (ownerUserId, sessionId, prUrl, headSha) the human ingest resolves.
      const va = await service.bootstrapReviewLoopEpochForVerification(db, {
        sessionId: "s-review",
        ownerUserId: 101,
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
        triggeringSourceId: "verification:head-sha:1",
        nowMs: Date.now(),
      });
      expect(va.sourceKind).toBe("verification");

      const reviewId = 6006;
      const humanResult = await service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-human-va",
        sourceId: `review-body:${reviewId}`,
        reviewId,
        reviewState: "changes_requested",
        reviewBody: "Please address X",
        reviewCommitId: "head-sha",
        actorLogin: "alice",
        actorType: "User",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
        humanSource: { userId: 42, login: "alice" },
      });
      expect(humanResult.status).toBe("handled");

      // Two distinct epochs: the verification intake (untouched) and a NEW human epoch. The human
      // review must never fold into the verification epoch — mergedSourceKind would leave it
      // 'verification', dispatching the human feedback under the QTA prompt.
      const rows = sqlite
        .prepare("SELECT source_kind, triggering_source_ids_json FROM pr_review_response_epochs")
        .all() as Array<{ source_kind: string; triggering_source_ids_json: string }>;
      expect(rows).toHaveLength(2);
      const kinds = rows.map((r) => r.source_kind).sort();
      expect(kinds).toEqual(["human", "verification"]);

      const verificationRow = rows.find((r) => r.source_kind === "verification")!;
      expect(JSON.parse(verificationRow.triggering_source_ids_json) as string[]).not.toContain(
        `review-body:${reviewId}`,
      );
      const humanRow = rows.find((r) => r.source_kind === "human")!;
      expect(JSON.parse(humanRow.triggering_source_ids_json) as string[]).toContain(`review-body:${reviewId}`);
    });

    /**
     * FIX 3: with both a bot epoch AND a ci epoch on the same head, a human review must fold
     * into the BOT epoch (→ mixed), NOT the ci epoch. selectLatestEpochForHead previously had no
     * source_kind filter and no deterministic tiebreaker, so a newer ci epoch could capture the
     * human fold-in and the human feedback would be lost on a ci-keyed row.
     */
    it("folds a human review into the bot epoch, not a concurrent ci epoch on the same head (FIX 3)", async () => {
      // Bot epoch first (ready, via inline review comment).
      const botResult = await service.ingestReviewLoopPullRequestReviewCommentWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-bot-warmup-ci",
        sourceId: "review-comment:8100",
        commentId: 8100,
        commentBody: "Bot looking",
        commentCommitId: "head-sha",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
      });
      expect(botResult.epoch?.sourceKind).toBe("bot");
      const botEpochId = botResult.epoch?.id;

      // A ci epoch on the SAME head, created later (newest row).
      const ciResult = await service.ingestReviewLoopCiFailureWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-ci-fold",
        sourceId: "ci-check:9200:42",
        checkRunId: 9200,
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
      expect(ciResult.epoch?.sourceKind).toBe("ci");
      const ciEpochId = ciResult.epoch?.id;

      const reviewId = 5757;
      const humanResult = await service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-human-ci-fold",
        sourceId: `review-body:${reviewId}`,
        reviewId,
        reviewState: "changes_requested",
        reviewBody: "Please fix",
        reviewCommitId: "head-sha",
        actorLogin: "alice",
        actorType: "User",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
        humanSource: { userId: 42, login: "alice" },
      });
      expect(humanResult.status).toBe("handled");
      // The human must have folded into the BOT epoch.
      expect(humanResult.epoch?.id).toBe(botEpochId);
      expect(humanResult.epoch?.sourceKind).toBe("mixed");

      const rows = sqlite
        .prepare("SELECT id, source_kind, triggering_source_ids_json FROM pr_review_response_epochs ORDER BY id")
        .all() as Array<{ id: string; source_kind: string; triggering_source_ids_json: string }>;
      // Two rows: the (now mixed) bot epoch and the untouched ci epoch.
      expect(rows).toHaveLength(2);
      const ciRow = rows.find((r) => r.id === ciEpochId)!;
      expect(ciRow.source_kind).toBe("ci");
      // ci epoch must NOT have absorbed the human sourceId.
      expect(JSON.parse(ciRow.triggering_source_ids_json) as string[]).not.toContain(`review-body:${reviewId}`);
      const botRow = rows.find((r) => r.id === botEpochId)!;
      expect(JSON.parse(botRow.triggering_source_ids_json) as string[]).toContain(`review-body:${reviewId}`);
    });

    /**
     * When there is NO existing epoch, a human review creates a fresh human
     * epoch that is immediately ready (no bot wait).
     */
    it("creates a fresh human epoch when no prior epoch exists → single ready human epoch", async () => {
      const reviewId = 6666;

      const result = await service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-human-fresh",
        sourceId: `review-body:${reviewId}`,
        reviewId,
        reviewState: "changes_requested",
        reviewBody: "Please address these",
        reviewCommitId: "head-sha",
        actorLogin: "bob",
        actorType: "User",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
        humanSource: { userId: 99, login: "bob" },
      });

      expect(result.status).toBe("handled");

      const rows = sqlite
        .prepare("SELECT status, source_kind, triggering_source_ids_json FROM pr_review_response_epochs")
        .all() as Array<{ status: string; source_kind: string; triggering_source_ids_json: string }>;
      expect(rows).toHaveLength(1);

      const epoch = rows[0];
      expect(epoch.source_kind).toBe("human");
      expect(epoch.status).toBe("ready");

      const triggeringIds: string[] = JSON.parse(epoch.triggering_source_ids_json) as string[];
      expect(triggeringIds).toContain(`review-body:${reviewId}`);
      expect(triggeringIds).not.toContain(`review:${reviewId}`);
    });

    /**
     * A human review left on a now-superseded commit (e.g. the owner reviews while Cycloid's own
     * fix push is advancing the head) must NOT be dropped as stale — the owner's instruction is
     * deliberate. It is re-attributed to the current reviewListeningHeadSha so it lands on the live
     * head's epoch and is carried into a prompt. (Bots, by contrast, are still dropped on a stale
     * head — they re-review the new commit.)
     */
    it("carries a human review on a stale head onto the listening head instead of dropping it", async () => {
      const reviewId = 7777;

      const result = await service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-human-stale",
        sourceId: `review-body:${reviewId}`,
        reviewId,
        reviewState: "changes_requested",
        reviewBody: "Conflicting change requested",
        // Review was submitted against an older commit than the session is now listening on.
        reviewCommitId: "old-sha",
        actorLogin: "alice",
        actorType: "User",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "old-sha",
        humanSource: { userId: 42, login: "alice" },
      });

      expect(result.status).toBe("handled");

      const rows = sqlite
        .prepare("SELECT head_sha, source_kind, triggering_source_ids_json FROM pr_review_response_epochs")
        .all() as Array<{ head_sha: string; source_kind: string; triggering_source_ids_json: string }>;
      expect(rows).toHaveLength(1);
      // Re-attributed to the current listening head, not the stale review commit.
      expect(rows[0].head_sha).toBe("head-sha");
      expect(JSON.parse(rows[0].triggering_source_ids_json) as string[]).toContain(`review-body:${reviewId}`);
    });
  });

  describe("Bug A fix — sessionId scoping for multi-session human ingest", () => {
    /**
     * With two sessions [A, B] listening on the same PR, calling
     * ingestReviewLoopPullRequestReviewWebhook with sessionId: "B" must fold
     * the human review only into B's epoch. B's epoch gets review-body:<reviewId>
     * in triggeringSourceIds; A is untouched (no epoch created for A).
     */
    it("scopes ingest to the specified sessionId — only B's epoch is created/updated", async () => {
      const reviewId = 7777;

      // Two sessions listening on the same PR.
      mockListSessionIdsByWebhookRef.mockResolvedValue(["s-A", "s-B"]);
      mockGetSessionState.mockImplementation((_env: unknown, sessionId: string) =>
        Promise.resolve(
          session({
            sessionId,
            ownerUserId: sessionId === "s-A" ? "201" : "202",
          }),
        ),
      );

      const result = await service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-scoped",
        sourceId: `review-body:${reviewId}`,
        reviewId,
        reviewState: "commented",
        reviewBody: "Looks good",
        reviewCommitId: "head-sha",
        actorLogin: "alice",
        actorType: "User",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
        humanSource: { userId: 42, login: "alice" },
        // Explicitly scope to session B only.
        sessionId: "s-B",
      });

      expect(result.status).toBe("handled");

      // listSessionIdsByWebhookRef must NOT have been called (sessionId bypasses it).
      expect(mockListSessionIdsByWebhookRef).not.toHaveBeenCalled();

      // Exactly one epoch for session B.
      const rows = sqlite
        .prepare("SELECT session_id, source_kind, triggering_source_ids_json FROM pr_review_response_epochs")
        .all() as Array<{ session_id: string; source_kind: string; triggering_source_ids_json: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe("s-B");

      const triggeringIds: string[] = JSON.parse(rows[0].triggering_source_ids_json) as string[];
      expect(triggeringIds).toContain(`review-body:${reviewId}`);
      // A's epoch was never created.
      expect(rows.every((r) => r.session_id !== "s-A")).toBe(true);
    });

    /**
     * The bot path calls ingestReviewLoopPullRequestReviewWebhook once WITHOUT
     * sessionId.  It must fall back to the internal listSessionIdsByWebhookRef
     * iteration, resolving to the first eligible session exactly as before.
     */
    it("no-sessionId (bot) call still resolves via internal iteration to the first eligible session", async () => {
      // Two sessions; both eligible but the first eligible one wins on bot path.
      mockListSessionIdsByWebhookRef.mockResolvedValue(["s-first", "s-second"]);
      mockGetSessionState.mockImplementation((_env: unknown, sessionId: string) =>
        Promise.resolve(
          session({
            sessionId,
            ownerUserId: sessionId === "s-first" ? "101" : "102",
          }),
        ),
      );

      const result = await service.ingestReviewLoopPullRequestReviewWebhook({
        env: { DB: db } as never,
        deliveryId: "delivery-bot-no-scope",
        sourceId: "review-body:8888",
        reviewId: 8888,
        reviewState: "commented",
        reviewBody: "Bot review",
        reviewCommitId: "head-sha",
        actorLogin: "cursor[bot]",
        actorType: "Bot",
        repoOwner: "acme",
        repoName: "repo",
        prNumber: 42,
        prUrl: "https://github.com/acme/repo/pull/42",
        headSha: "head-sha",
        // No sessionId — bot path.
      });

      expect(result.status).toBe("handled");
      // listSessionIdsByWebhookRef was called (internal iteration).
      expect(mockListSessionIdsByWebhookRef).toHaveBeenCalled();
      // The first eligible session (s-first) gets the epoch.
      expect(result.epoch?.sessionId).toBe("s-first");
    });
  });

  describe("manual review mode (ARC-1514) — humanSource ingest bypass", () => {
    const humanInput = () => ({
      env: { DB: db } as never,
      deliveryId: "delivery-manual-human",
      sourceId: "review-body:5501",
      reviewId: 5501,
      reviewState: "changes_requested",
      reviewBody: "Please fix this.",
      reviewCommitId: "head-sha",
      actorLogin: "alice",
      actorType: "User",
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      headSha: "head-sha",
      humanSource: { userId: 42, login: "alice" },
    });

    it("returns ignored/review_handling_disabled and registers NO epoch when automatic review handling is off", async () => {
      // Session owner (default ownerUserId 101) is in manual mode.
      mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 0 });

      const result = await service.ingestReviewLoopPullRequestReviewWebhook(humanInput());

      expect(result).toEqual({ status: "ignored", reason: "review_handling_disabled" });
      const row = sqlite.prepare("SELECT COUNT(*) AS count FROM pr_review_response_epochs").get() as { count: number };
      expect(row.count).toBe(0);
    });

    it("control: folds/creates a human epoch when automatic review handling is on", async () => {
      mockGetUserSettingsIfExists.mockResolvedValue({ automatic_reviews_enabled: 1 });

      const result = await service.ingestReviewLoopPullRequestReviewWebhook(humanInput());

      expect(result.status).toBe("handled");
      const rows = sqlite.prepare("SELECT source_kind FROM pr_review_response_epochs").all() as Array<{
        source_kind: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].source_kind).toBe("human");
    });
  });
});
