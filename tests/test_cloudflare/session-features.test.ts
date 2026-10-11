import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRepoSkillsMemoryCache } from "../../apps/control-plane-worker/src/github/skills";
import { resetReposMemoryCache } from "../../apps/control-plane-worker/src/services/repos";
import { upsertSessionPlan } from "../../apps/control-plane-worker/src/session/do-db";
import {
  createDurableNamespace,
  type DurableNamespace,
  FakeKV,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  workerFetch,
  type WorkerModule,
} from "./helpers/worker-harness";

mockCloudflareWorkers();
mockSentryCloudflare();

const { mockCloneTokenMint, mockScopedTokenMint } = vi.hoisted(() => ({
  mockCloneTokenMint: vi.fn(),
  mockScopedTokenMint: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: (_env: unknown, _id: number, scope: { permissions: Record<string, string> }) => {
    mockScopedTokenMint(scope);
    return Promise.resolve("ghs_install_token");
  },
  createInstallationTokenForCloneToken: (_env: unknown, _id: number, scope: { permissions: Record<string, string> }) =>
    mockCloneTokenMint(scope),
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  sandboxGhReadonlyTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "read", pull_requests: "read", checks: "read", statuses: "read", actions: "read" },
  }),
  sandboxPushTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read", workflows: "write" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

vi.mock("e2b", () => ({
  Sandbox: class {
    static connect(): never {
      throw new Error("E2B should not be used by session feature route tests");
    }

    static create(): never {
      throw new Error("E2B should not be used by session feature route tests");
    }
  },
}));

const mockPublishReviewLoopSummaryComment = vi.fn();
const { mockSlackPostMessage, mockSlackUploadFile } = vi.hoisted(() => ({
  mockSlackPostMessage: vi.fn(),
  mockSlackUploadFile: vi.fn(),
}));
const { mockPostStructuredEventToDd } = vi.hoisted(() => ({
  mockPostStructuredEventToDd: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/session/publish-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/control-plane-worker/src/session/publish-service")>();
  return {
    ...actual,
    publishReviewLoopSummaryComment: (...args: unknown[]) => mockPublishReviewLoopSummaryComment(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/slack/notify", () => ({
  postMessage: mockSlackPostMessage,
  uploadFile: mockSlackUploadFile,
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

type AuthTokenUser = {
  user_id: number;
  expires_at: number;
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  business_id?: string;
  shared_sessions?: number;
  created_at?: number;
};

class FakeD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  private boundInsertValues(): Record<string, unknown> {
    const match = this.query.match(/INSERT INTO\s+\w+\s*\(([\s\S]*?)\)\s*VALUES/i);
    if (!match?.[1]) {
      throw new Error(`Could not parse insert columns: ${this.query}`);
    }

    const valuesByColumn: Record<string, unknown> = {};
    const columns = match[1].split(",").map((column) => column.trim());
    columns.forEach((column, index) => {
      valuesByColumn[column] = this.boundValues[index];
    });
    return valuesByColumn;
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number; changes?: number } }> {
    if (this.query.includes("CREATE TABLE IF NOT EXISTS") || this.query.includes("CREATE INDEX IF NOT EXISTS")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO session_index")) {
      const row = this.boundInsertValues();
      const sessionId = row.session_id as string;
      const ownerUserId = row.owner_user_id as string;
      const businessId = row.business_id as string | null;
      const status = row.status as string;
      const createdAt = row.created_at as string;
      const updatedAt = row.updated_at as string;
      const closedAt = row.closed_at as string | null;
      const lastEventId = row.last_event_id as string | null;
      const installationId = row.installation_id as number | null;
      const repoOwner = row.repo_owner as string | null;
      const repoName = row.repo_name as string | null;
      const existing = this.db.sessionIndex.get(sessionId);
      const resolvedBusinessId =
        (existing?.business_id as string | null | undefined) ??
        businessId ??
        this.db.users.get(String(ownerUserId))?.business_id ??
        null;
      this.db.sessionIndex.set(sessionId, {
        ...existing,
        session_id: sessionId,
        owner_user_id: ownerUserId,
        business_id: resolvedBusinessId,
        status,
        created_at: createdAt,
        updated_at: updatedAt,
        closed_at: closedAt,
        last_event_id: lastEventId,
        installation_id: installationId ?? existing?.installation_id ?? null,
        repo_owner: repoOwner ?? existing?.repo_owner ?? null,
        repo_name: repoName ?? existing?.repo_name ?? null,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO durable_event_replay_metadata")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT OR IGNORE INTO integration_lifecycle_events")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO session_webhook_refs")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      this.db.authTokens.delete(token);
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO auth_sessions")) {
      const [token, userId, expiresAt, createdAt] = this.boundValues as [string, number, number, number];
      const user = this.db.users.get(String(userId));
      const businessId = user?.business_id ?? "biz-1";
      const sharedSessions = this.db.businesses.get(businessId)?.shared_sessions ?? 0;
      this.db.authTokens.set(token, {
        user_id: userId,
        id: userId,
        expires_at: expiresAt,
        created_at: createdAt,
        login: user?.login ?? "owner",
        name: null,
        email: null,
        business_id: businessId,
        shared_sessions: sharedSessions,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("DELETE FROM session_index")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE session_index SET rich_status")) {
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE session_index") && this.query.includes("publish_status")) {
      const sessionId = this.boundValues[this.boundValues.length - 1] as string;
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) {
        this.db.sessionIndex.set(sessionId, {
          ...existing,
          publish_status: (this.boundValues[0] as string | null | undefined) ?? existing.publish_status ?? null,
          publish_stage: this.boundValues[1]
            ? ((this.boundValues[2] as string | null | undefined) ?? null)
            : (existing.publish_stage ?? null),
          publish_error: this.boundValues[3]
            ? ((this.boundValues[4] as string | null | undefined) ?? null)
            : (existing.publish_error ?? null),
          published_branch: this.boundValues[5]
            ? ((this.boundValues[6] as string | null | undefined) ?? null)
            : (existing.published_branch ?? null),
          publish_attempt: (this.boundValues[7] as number | null | undefined) ?? existing.publish_attempt ?? null,
          publish_sequence: (this.boundValues[8] as number | null | undefined) ?? existing.publish_sequence ?? null,
          pr_polish_status: (this.boundValues[9] as string | null | undefined) ?? existing.pr_polish_status ?? null,
          pr_polish_error: this.boundValues[10]
            ? ((this.boundValues[11] as string | null | undefined) ?? null)
            : (existing.pr_polish_error ?? null),
        });
      }
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO session_feedback")) {
      const [id, sessionId, userId, rating, message, transcript] = this.boundValues as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string,
      ];
      this.db.sessionFeedback.set(id, {
        id,
        session_id: sessionId,
        user_id: userId,
        rating,
        message,
        transcript,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("INSERT INTO memory_feedback")) {
      const [
        id,
        feedbackKey,
        sessionId,
        promptId,
        activityEventId,
        displayEventType,
        usageSource,
        memoryId,
        userId,
        userLogin,
        rating,
        message,
        memoryTitle,
        memoryPath,
        memoryReason,
        memoryExpectedEffect,
        memoryObservedEffect,
        repoOwner,
        repoName,
        sessionUrl,
        createdAt,
      ] = this.boundValues;
      this.db.memoryFeedback.set(String(id), {
        id,
        feedback_key: feedbackKey,
        session_id: sessionId,
        prompt_id: promptId,
        activity_event_id: activityEventId,
        display_event_type: displayEventType,
        usage_source: usageSource,
        memory_id: memoryId,
        user_id: userId,
        user_login: userLogin,
        rating,
        message,
        memory_title: memoryTitle,
        memory_path: memoryPath,
        memory_reason: memoryReason,
        memory_expected_effect: memoryExpectedEffect,
        memory_observed_effect: memoryObservedEffect,
        repo_owner: repoOwner,
        repo_name: repoName,
        session_url: sessionUrl,
        slack_channel_id: null,
        slack_message_ts: null,
        slack_post_status: null,
        slack_post_error: null,
        created_at: createdAt,
      });
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE memory_feedback")) {
      const [status, channelId, messageTs, error, id] = this.boundValues as [
        string,
        string | null,
        string | null,
        string | null,
        string,
      ];
      const row = this.db.memoryFeedback.get(id);
      if (row) {
        this.db.memoryFeedback.set(id, {
          ...row,
          slack_post_status: status,
          slack_channel_id: channelId,
          slack_message_ts: messageTs,
          slack_post_error: error,
        });
      }
      return { success: true, meta: { last_row_id: 0 } };
    }

    if (this.query.includes("UPDATE memory_usage_events")) {
      const [reviewOutcome, sessionId, promptId, memoryId, source] = this.boundValues as [
        string,
        string,
        string,
        string,
        string,
      ];
      const key = `${sessionId}:${promptId}:${memoryId}:${source}`;
      if (this.db.memoryUsageEvents.has(key)) {
        this.db.memoryUsageReviewOutcomes.set(key, reviewOutcome);
        return { success: true, meta: { last_row_id: 0, changes: 1 } };
      }
      return { success: true, meta: { last_row_id: 0, changes: 0 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (
      this.query.includes("SELECT session_id, prompt_id, stage, attempt_count") &&
      this.query.includes("FROM slack_posts")
    ) {
      return { results: [] };
    }

    if (this.query.includes("FROM session_evaluations")) {
      const [sessionId] = this.boundValues as [string];
      const rows = this.db.sessionEvaluations.get(sessionId) ?? [];
      return { results: rows };
    }

    if (this.query.includes("FROM github_installations")) {
      const owners = new Set(this.boundValues.map((value) => String(value).toLowerCase()));
      const results = [...this.db.githubInstallations.values()].filter((row) => {
        const ownerLogin = typeof row.owner_login === "string" ? row.owner_login.toLowerCase() : "";
        return owners.has(ownerLogin) && row.suspended_at == null;
      });
      return { results };
    }

    // getBusinessMembers: SELECT id FROM users WHERE business_id = ?
    if (this.query.includes("FROM users WHERE business_id")) {
      const [businessId] = this.boundValues as [string];
      const results: Array<{ id: number }> = [];
      for (const user of this.db.users.values()) {
        if (user.business_id === businessId && user.id != null) {
          results.push({ id: user.id });
        }
      }
      return { results };
    }

    if (this.query.includes("FROM memory_feedback")) {
      const [sessionId, userId] = this.boundValues as [string, string];
      const latestByKey = new Map<string, Record<string, unknown>>();
      for (const row of this.db.memoryFeedback.values()) {
        if (row.session_id !== sessionId || row.user_id !== userId) continue;
        const existing = latestByKey.get(String(row.feedback_key));
        if (!existing || Number(row.created_at) >= Number(existing.created_at)) {
          latestByKey.set(String(row.feedback_key), row);
        }
      }
      return { results: [...latestByKey.values()].sort((a, b) => Number(b.created_at) - Number(a.created_at)) };
    }

    if (this.query.includes("FROM session_index")) {
      const rows = [...this.db.sessionIndex.values()];
      let filtered = rows;
      let bindIndex = 0;

      if (this.query.includes("s.business_id = ?")) {
        const businessId = this.boundValues[bindIndex++] as string;
        filtered = filtered.filter((row) => row.business_id === businessId);
        if (this.query.includes("s.owner_user_id != ?")) {
          const excludeOwnerUserId = this.boundValues[bindIndex++] as string;
          filtered = filtered.filter((row) => row.owner_user_id !== excludeOwnerUserId);
        }
      } else if (this.query.includes("s.owner_user_id = ?") || this.query.includes("WHERE owner_user_id = ?")) {
        const ownerUserId = this.boundValues[bindIndex++] as string;
        filtered = filtered.filter((row) => row.owner_user_id === ownerUserId);
      }

      if (this.query.includes("s.rich_status = ?")) {
        bindIndex++;
      } else if (this.query.includes("s.status = ?") || this.query.includes("WHERE status = ?")) {
        const status = this.boundValues[bindIndex++] as string;
        filtered = filtered.filter((row) => row.status === status);
      }

      return { results: filtered };
    }

    if (this.query.includes("FROM user_integrations")) {
      return {
        results: [
          {
            integration_id: "openai",
            oauth_access_token: null,
            oauth_refresh_token: null,
            oauth_expires_at: null,
            api_key: "sk-openai-test",
            service_url: null,
            encrypted: 0,
            last_validated_at: Date.now(),
            last_validation_status: "validated",
            last_validation_reason_code: null,
          },
        ],
      };
    }

    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.query.includes("SELECT MIN(COALESCE(next_attempt_at, created_at)) AS next_attempt_at")) {
      return null;
    }

    if (this.query.includes("FROM github_installations")) {
      const [ownerLogin] = this.boundValues as [string];
      return this.db.githubInstallations.get(ownerLogin) ?? null;
    }

    if (this.query.includes("FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      const user = this.db.authTokens.get(token);
      if (!user) return null;
      // Support resolveAuthSession's member_ids subquery
      if (this.query.includes("member_ids")) {
        const memberIds =
          user.shared_sessions === 1 && user.business_id
            ? [...this.db.users.values()]
                .filter((u) => u.business_id === user.business_id && u.id != null)
                .map((u) => u.id)
                .join(",")
            : null;
        return { ...user, member_ids: memberIds || null };
      }
      return user;
    }

    if (this.query.includes("FROM durable_event_replay_metadata")) {
      return null;
    }

    if (this.query.includes("SELECT owner_user_id, business_id, repo_owner, repo_name FROM session_index")) {
      const [sessionId] = this.boundValues as [string];
      const session = this.db.sessionIndex.get(sessionId);
      return session
        ? {
            owner_user_id: session.owner_user_id,
            business_id: session.business_id,
            repo_owner: session.repo_owner ?? null,
            repo_name: session.repo_name ?? null,
          }
        : null;
    }

    if (this.query.includes("SELECT business_id FROM session_index WHERE session_id = ?")) {
      const [sessionId] = this.boundValues as [string];
      const session = this.db.sessionIndex.get(sessionId);
      return session ? { business_id: session.business_id as string | null } : null;
    }

    // Per-business active-session admission count (countActiveSessionsForBusiness).
    // The query excludes closed/archived `status` AND terminal `rich_status`
    // phases (bound after the business id), keeping NULL rich_status as active.
    if (this.query.includes("SELECT COUNT(*) AS count FROM session_index")) {
      const [businessId, ...terminalPhases] = this.boundValues as [string, ...string[]];
      const count = [...this.db.sessionIndex.values()].filter((s) => {
        if (s.business_id !== businessId) return false;
        if (s.status === "closed" || s.status === "archived") return false;
        const richStatus = s.rich_status as string | null | undefined;
        if (richStatus != null && terminalPhases.includes(richStatus)) return false;
        return true;
      }).length;
      return { count };
    }

    if (this.query.includes("FROM session_feedback")) {
      const [sessionId, userId] = this.boundValues as [string, string];
      const key = `${sessionId}:${userId}`;
      return this.db.sessionFeedback.get(key) ?? null;
    }

    if (this.query.includes("FROM memory_usage_events")) {
      const [sessionId, promptId, memoryId, source] = this.boundValues as [string, string, string, string];
      const key = `${sessionId}:${promptId}:${memoryId}:${source}`;
      return this.db.memoryUsageEvents.has(key) ? { id: key } : null;
    }

    if (this.query.includes("FROM user_integrations") && this.query.includes("oauth_access_token")) {
      const [userId] = this.boundValues as [number];
      if (this.db.throwGithubTokenUserIds.has(userId)) {
        throw new Error("github token lookup failed");
      }
      if (this.db.noGithubTokenUserIds.has(userId)) {
        return null;
      }
      return {
        oauth_access_token: "ghp_test",
        oauth_refresh_token: null,
        oauth_expires_at: null,
        encrypted: 0,
      };
    }

    if (this.query.includes("FROM user_integrations")) {
      const [_userIdRaw, integrationId] = this.boundValues as [number | string, string | undefined];
      if (integrationId === "openai") {
        return {
          api_key: "sk-openai-test",
          oauth_access_token: null,
          oauth_refresh_token: null,
          oauth_expires_at: null,
          service_url: null,
          encrypted: 0,
          last_validated_at: Date.now(),
          last_validation_status: "validated",
          last_validation_reason_code: null,
        };
      }
      return null;
    }

    if (this.query.includes("FROM user_settings")) {
      const [userId] = this.boundValues as [number];
      return {
        user_id: userId,
      };
    }

    // users queries
    if (
      this.query.includes("FROM users") &&
      this.query.includes("business_id") &&
      !this.query.includes("business_members")
    ) {
      const [userId] = this.boundValues as [string];
      const user = this.db.users.get(String(userId));
      if (!user || !user.business_id) return null;
      return { business_id: user.business_id };
    }

    if (this.query.includes("FROM users") && this.query.includes("login")) {
      const [userId] = this.boundValues as [string];
      const user = this.db.users.get(String(userId));
      if (!user) return null;
      return { login: user.login, avatar_url: user.avatar_url };
    }

    // businesses queries
    if (this.query.includes("FROM businesses")) {
      const [businessId] = this.boundValues as [string];
      const biz = this.db.businesses.get(businessId);
      if (!biz) return null;
      return { shared_sessions: biz.shared_sessions };
    }

    // business_members queries
    if (this.query.includes("FROM business_members")) {
      const [userId] = this.boundValues as [number];
      const user = this.db.users.get(String(userId));
      if (!user?.business_id) return null;
      const member = this.db.businessMembers.get(`${user.business_id}:${userId}`);
      return member ? { business_id: user.business_id, business_role: member.role } : null;
    }

    // business_integrations queries
    if (this.query.includes("FROM business_integrations")) {
      return null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async executeBatch(): Promise<{ results: unknown[]; meta?: { last_row_id: number; changes?: number } }> {
    const normalized = this.query.trim().toUpperCase();
    if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) {
      try {
        return await this.all();
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Unhandled all query")) {
          const row = await this.first();
          return { results: row ? [row] : [] };
        }
        throw error;
      }
    }
    const result = await this.run();
    return { results: [], meta: result.meta };
  }
}

class FakeD1 {
  readonly sessionIndex = new Map<string, Record<string, unknown>>();
  readonly authTokens = new Map<string, AuthTokenUser>();
  readonly githubInstallations = new Map<string, Record<string, unknown>>();
  readonly sessionFeedback = new Map<string, Record<string, unknown>>();
  readonly memoryFeedback = new Map<string, Record<string, unknown>>();
  readonly memoryUsageEvents = new Set<string>();
  readonly memoryUsageReviewOutcomes = new Map<string, string>();
  readonly users = new Map<string, { id?: number; login: string; avatar_url: string | null; business_id?: string }>();
  readonly businesses = new Map<string, { shared_sessions: number }>();
  readonly businessMembers = new Map<string, { business_id: string; user_id: number; role: string }>();
  readonly sessionEvaluations = new Map<string, Record<string, unknown>[]>();
  /** User IDs that should return null when querying for GitHub token */
  readonly noGithubTokenUserIds = new Set<number>();
  /** User IDs that should throw when querying for GitHub token */
  readonly throwGithubTokenUserIds = new Set<number>();

  setAuthToken(token: string, user: AuthTokenUser): void {
    const businessId = user.business_id ?? this.users.get(String(user.id))?.business_id ?? "biz-1";
    const existingBusiness = this.businesses.get(businessId);
    const sharedSessions = user.shared_sessions ?? existingBusiness?.shared_sessions ?? 0;
    this.authTokens.set(token, {
      ...user,
      business_id: businessId,
      shared_sessions: sharedSessions,
    });
    if (!this.users.has(String(user.id))) {
      this.users.set(String(user.id), {
        id: user.id,
        login: user.login,
        avatar_url: null,
        business_id: businessId,
      });
    }
    if (!this.businesses.has(businessId)) {
      this.businesses.set(businessId, { shared_sessions: sharedSessions });
    }
  }

  addEvaluation(sessionId: string, eval_: Record<string, unknown>): void {
    const existing = this.sessionEvaluations.get(sessionId) ?? [];
    existing.push(eval_);
    this.sessionEvaluations.set(sessionId, existing);
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.executeBatch()));
  }
}

function createWorkerEnv(workerModule: WorkerModule): {
  env: Record<string, unknown>;
  db: FakeD1;
  sessionNs: DurableNamespace;
  kv: FakeKV;
} {
  const db = new FakeD1();
  const kv = new FakeKV();

  const env: Record<string, unknown> = {
    DB: db,
    REPOS_CACHE: kv,
    WORKER_ENV: "test",
    AUTH_SMOKE_TOKEN: "smoke-token",
    ARCANIST_ADMIN_TOKEN: "admin-secret",
    SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    GITHUB_WEBHOOK_SECRET: "gh-webhook-secret",
    SLACK_SIGNING_SECRET: "slack-webhook-secret",
    LINEAR_WEBHOOK_SECRET: "linear-webhook-secret",
  };

  const sessionNs = createDurableNamespace(workerModule.SessionDO, env, { sqlStorage: true });
  env.SESSION = sessionNs;
  env.SESSION_RESUME_RATE_LIMITER = createDurableNamespace(workerModule.SessionResumeRateLimiterDO, env);

  // Seed default GitHub App installations for common test repo owners
  for (const owner of ["test-owner", "acme"]) {
    db.githubInstallations.set(owner, {
      installation_id: 1,
      owner_login: owner,
      owner_id: 1,
      owner_type: "Organization",
      repository_selection: "all",
      created_at: Date.now(),
      suspended_at: null,
    });
  }

  return { env, db, sessionNs, kv };
}

/** Helper: create an authenticated session via API token. */
async function createSession(
  workerModule: WorkerModule,
  env: Record<string, unknown>,
  sessionId: string,
  opts?: { repoUrl?: string; baseBranch?: string; businessId?: string },
): Promise<void> {
  const db = env.DB as FakeD1;
  const businessId = opts?.businessId ?? "biz-1";
  if (!db.users.has("1001")) {
    db.users.set("1001", {
      id: 1001,
      login: "owner",
      avatar_url: null,
      business_id: businessId,
    });
  }
  db.businessMembers.set(`${businessId}:1001`, { business_id: businessId, user_id: 1001, role: "member" });
  if (!db.businesses.has(businessId)) {
    db.businesses.set(businessId, { shared_sessions: 0 });
  }

  const res = await workerFetch(workerModule, env, "/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer admin-secret",
    },
    body: JSON.stringify({
      sessionId,
      ownerUserId: "1001",
      repoUrl: opts?.repoUrl ?? "https://github.com/test-owner/test-repo",
      ...(opts?.baseBranch ? { baseBranch: opts.baseBranch } : {}),
    }),
  });
  expect(res.status).toBe(201);
}

function seedSessionPlan(
  sessionNs: DurableNamespace,
  sessionId: string,
  status: "none" | "pending" | "approved" | "superseded",
  revision = 1,
): void {
  const state = sessionNs._states.get(sessionId);
  if (!state) throw new Error(`Missing SessionDO state for ${sessionId}`);
  upsertSessionPlan(state.storage.sql as unknown as SqlStorage, {
    sessionId,
    planPromptId: `p-plan-${revision}`,
    implementationPromptId: null,
    markdown: "# Plan\n\nTest it",
    excerpt: "Test it",
    artifactId: null,
    valid: true,
    missingReason: null,
    missingHeadings: [],
    status,
    revision,
    userEdited: false,
    approvedBy: null,
    approvedAt: null,
    source: "generated",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session feature routes", () => {
  let workerModule: WorkerModule;
  const originalFetch = globalThis.fetch;

  async function sha256Hex(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(message));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function seedSandboxToken(
    sessionNs: DurableNamespace,
    sessionId: string,
    sandboxToken: string,
    status = "ready",
  ): Promise<void> {
    const doState = sessionNs._states.get(sessionId);
    expect(doState).toBeDefined();
    doState!.storage.sql.exec(
      "UPDATE sandbox_state SET sandbox_auth_token_hash = ?, status = ? WHERE session_id = ?",
      await sha256Hex(sandboxToken),
      status,
      sessionId,
    );
  }

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
    resetRepoSkillsMemoryCache();
    resetReposMemoryCache();
    mockPublishReviewLoopSummaryComment.mockReset();
    mockSlackPostMessage.mockReset();
    mockSlackUploadFile.mockReset();
    mockPostStructuredEventToDd.mockReset();
    mockPostStructuredEventToDd.mockResolvedValue(true);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      return originalFetch(input, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetRepoSkillsMemoryCache();
    resetReposMemoryCache();
    vi.useRealTimers();
  });

  it("includes indexed repository context in session list rows", async () => {
    const { env } = createWorkerEnv(workerModule);

    await createSession(workerModule, env, "s-list-repo-context", {
      repoUrl: "https://github.com/acme/widget",
    });

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{ sessionId: string; repoOwner?: string; repoName?: string }>;
    };

    expect(body.sessions.find((session) => session.sessionId === "s-list-repo-context")).toMatchObject({
      repoOwner: "acme",
      repoName: "widget",
    });
  });

  it("rejects unknown bearer token auth on session routes", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { authorization: "Bearer mcp-secret" },
    });

    expect(res.status).toBe(401);
  });

  it("rejects invalid targetPrUrl on session creation", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret",
      },
      body: JSON.stringify({
        sessionId: "s-invalid-target-pr",
        ownerUserId: "1001",
        repoUrl: "https://github.com/test-owner/test-repo",
        qa: true,
        targetPrUrl: "https://example.com/not-a-pr",
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.error).toBe("targetPrUrl must be a valid GitHub pull request URL");
  });

  it("rejects qa session creation without a pull request URL", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret",
      },
      body: JSON.stringify({
        sessionId: "s-missing-target-pr",
        ownerUserId: "1001",
        repoUrl: "https://github.com/test-owner/test-repo",
        qa: true,
        prompt: "check the regression",
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.error).toBe(
      "QA requires a GitHub pull request URL. Provide targetPrUrl or include a pull request URL in the prompt.",
    );
  });

  it("rejects verification target PRs outside the authorized session repository", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret",
      },
      body: JSON.stringify({
        sessionId: "s-cross-repo-target-pr",
        ownerUserId: "1001",
        repoUrl: "https://github.com/test-owner/test-repo",
        qa: true,
        targetPrUrl: "https://github.com/acme/widgets/pull/123",
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(403);
    expect(body.error).toBe("targetPrUrl must belong to the same repository as repoUrl");
  });

  describe("shared session repository authorization", () => {
    it("rejects same-business non-owner reads without GitHub repo visibility", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.githubInstallations.set("private-owner", {
        installation_id: 1,
        owner_login: "private-owner",
        owner_id: 1,
        owner_type: "Organization",
        repository_selection: "all",
        created_at: Date.now(),
        suspended_at: null,
      });
      db.users.set("1001", {
        id: 1001,
        login: "owner",
        avatar_url: "https://avatars.example.com/1001",
        business_id: "biz-shared",
      });
      db.users.set("2002", { id: 2002, login: "viewer", avatar_url: null, business_id: "biz-shared" });
      db.businesses.set("biz-shared", { shared_sessions: 1 });

      await createSession(workerModule, env, "s-shared-private", {
        repoUrl: "https://github.com/private-owner/private-repo",
        businessId: "biz-shared",
      });

      db.setAuthToken("sess-shared-viewer", {
        user_id: 2002,
        id: 2002,
        expires_at: Date.now() + 60_000,
        login: "viewer",
        name: null,
        email: null,
        business_id: "biz-shared",
        shared_sessions: 1,
      });

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.startsWith("https://api.github.com/user/repos")) {
          return new Response(
            JSON.stringify([
              {
                full_name: "private-owner/visible-repo",
                html_url: "https://github.com/private-owner/visible-repo",
                private: true,
                default_branch: "main",
              },
            ]),
            { status: 200 },
          );
        }
        if (url === "https://api.github.com/repos/private-owner/private-repo") {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      const listRes = await workerFetch(workerModule, env, "/api/sessions?scope=business", {
        headers: { cookie: "session_token=sess-shared-viewer" },
      });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { sessions: Array<{ sessionId: string }> };
      expect(listBody.sessions.some((session) => session.sessionId === "s-shared-private")).toBe(false);

      const deniedEndpoints = [
        "/api/sessions/s-shared-private",
        "/api/sessions/s-shared-private/events",
        "/api/sessions/s-shared-private/events/history",
        "/api/sessions/s-shared-private/context",
        "/api/sessions/s-shared-private/export",
        "/api/sessions/s-shared-private/prompts",
        "/api/sessions/s-shared-private/view",
      ];

      for (const path of deniedEndpoints) {
        const res = await workerFetch(workerModule, env, path, {
          headers: { cookie: "session_token=sess-shared-viewer" },
        });
        expect(res.status, path).toBe(403);
        await expect(res.json(), path).resolves.toMatchObject({
          ok: false,
          error: "You do not have access to this repository on GitHub",
        });
      }
    });

    it("filters business-scope sessions with bounded repo access concurrency and stable list order", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      const repos = ["repo-a", "repo-b", "repo-c", "repo-d", "repo-e"];

      db.githubInstallations.set("private-owner", {
        installation_id: 1,
        owner_login: "private-owner",
        owner_id: 1,
        owner_type: "Organization",
        repository_selection: "all",
        created_at: Date.now(),
        suspended_at: null,
      });
      db.users.set("1001", {
        id: 1001,
        login: "owner",
        avatar_url: "https://avatars.example.com/1001",
        business_id: "biz-shared",
      });
      db.users.set("2002", { id: 2002, login: "viewer", avatar_url: null, business_id: "biz-shared" });
      db.businesses.set("biz-shared", { shared_sessions: 1 });

      for (const repo of repos) {
        await createSession(workerModule, env, `s-${repo}`, {
          repoUrl: `https://github.com/private-owner/${repo}`,
          businessId: "biz-shared",
        });
      }

      const originalSessionNamespace = env.SESSION as DurableNamespace;
      let stateReadCount = 0;
      const countingSessionNamespace: DurableNamespace = {
        ...originalSessionNamespace,
        get(id: string) {
          const stub = originalSessionNamespace.get(id);
          return {
            fetch: async (request: Request | string, init?: RequestInit): Promise<Response> => {
              const url = request instanceof Request ? request.url : request;
              if (url === "https://internal/session/state") {
                stateReadCount += 1;
                await new Promise((resolve) => setTimeout(resolve, 50));
              }
              return stub.fetch(request, init);
            },
          };
        },
      };
      env.SESSION = countingSessionNamespace;

      db.setAuthToken("sess-shared-viewer", {
        user_id: 2002,
        id: 2002,
        expires_at: Date.now() + 60_000,
        login: "viewer",
        name: null,
        email: null,
        business_id: "biz-shared",
        shared_sessions: 1,
      });

      const requestedRepos: string[] = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.startsWith("https://api.github.com/user/repos")) {
          requestedRepos.push(url);
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new Response(
            JSON.stringify(
              ["repo-a", "repo-b", "repo-d", "repo-e"].map((repo) => ({
                full_name: `private-owner/${repo}`,
                html_url: `https://github.com/private-owner/${repo}`,
                private: true,
                default_branch: "main",
              })),
            ),
            { status: 200 },
          );
        }
        return originalFetch(input, init);
      };

      const res = await workerFetch(workerModule, env, "/api/sessions?scope=business", {
        headers: { cookie: "session_token=sess-shared-viewer" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
      expect(body.sessions.map((session) => session.sessionId)).toEqual([
        "s-repo-a",
        "s-repo-b",
        "s-repo-d",
        "s-repo-e",
      ]);
      expect(requestedRepos).toHaveLength(1);
      expect(stateReadCount).toBe(0);
    });

    it("loads the business-scope repo access snapshot once across paginated scans", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.githubInstallations.set("private-owner", {
        installation_id: 1,
        owner_login: "private-owner",
        owner_id: 1,
        owner_type: "Organization",
        repository_selection: "all",
        created_at: Date.now(),
        suspended_at: null,
      });
      db.users.set("1001", {
        id: 1001,
        login: "owner",
        avatar_url: "https://avatars.example.com/1001",
        business_id: "biz-shared",
      });
      db.users.set("2002", { id: 2002, login: "viewer", avatar_url: null, business_id: "biz-shared" });
      db.businesses.set("biz-shared", { shared_sessions: 1 });

      for (const repo of ["repo-a", "repo-b", "repo-c", "repo-d", "repo-e"]) {
        await createSession(workerModule, env, `s-${repo}`, {
          repoUrl: `https://github.com/private-owner/${repo}`,
          businessId: "biz-shared",
        });
      }

      db.setAuthToken("sess-shared-viewer", {
        user_id: 2002,
        id: 2002,
        expires_at: Date.now() + 60_000,
        login: "viewer",
        name: null,
        email: null,
        business_id: "biz-shared",
        shared_sessions: 1,
      });

      let repoListChecks = 0;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.startsWith("https://api.github.com/user/repos")) {
          repoListChecks += 1;
          return new Response(
            JSON.stringify([
              {
                full_name: "private-owner/repo-e",
                html_url: "https://github.com/private-owner/repo-e",
                private: true,
                default_branch: "main",
              },
            ]),
            { status: 200 },
          );
        }
        return originalFetch(input, init);
      };

      const res = await workerFetch(workerModule, env, "/api/sessions?scope=business&limit=1", {
        headers: { cookie: "session_token=sess-shared-viewer" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
      expect(body.sessions.map((session) => session.sessionId)).toEqual(["s-repo-e"]);
      expect(repoListChecks).toBe(1);
    });

    it("fails business-scope session lists closed when repo access verification is unavailable", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.githubInstallations.set("private-owner", {
        installation_id: 1,
        owner_login: "private-owner",
        owner_id: 1,
        owner_type: "Organization",
        repository_selection: "all",
        created_at: Date.now(),
        suspended_at: null,
      });
      db.users.set("1001", {
        id: 1001,
        login: "owner",
        avatar_url: "https://avatars.example.com/1001",
        business_id: "biz-shared",
      });
      db.users.set("2002", { id: 2002, login: "viewer", avatar_url: null, business_id: "biz-shared" });
      db.businesses.set("biz-shared", { shared_sessions: 1 });

      await createSession(workerModule, env, "s-repo-ok", {
        repoUrl: "https://github.com/private-owner/repo-ok",
        businessId: "biz-shared",
      });
      await createSession(workerModule, env, "s-repo-unavailable", {
        repoUrl: "https://github.com/private-owner/repo-unavailable",
        businessId: "biz-shared",
      });

      db.setAuthToken("sess-shared-viewer", {
        user_id: 2002,
        id: 2002,
        expires_at: Date.now() + 60_000,
        login: "viewer",
        name: null,
        email: null,
        business_id: "biz-shared",
        shared_sessions: 1,
      });

      let repoListChecks = 0;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.startsWith("https://api.github.com/user/repos")) {
          repoListChecks += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error("GitHub unavailable");
        }
        return originalFetch(input, init);
      };

      const res = await workerFetch(workerModule, env, "/api/sessions?scope=business", {
        headers: { cookie: "session_token=sess-shared-viewer" },
      });
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: "Unable to verify repository access. Please try again.",
      });
      expect(repoListChecks).toBe(1);
    });

    it("hides business-scope sessions missing indexed repo context without reading session state", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.githubInstallations.set("private-owner", {
        installation_id: 1,
        owner_login: "private-owner",
        owner_id: 1,
        owner_type: "Organization",
        repository_selection: "all",
        created_at: Date.now(),
        suspended_at: null,
      });
      db.users.set("1001", {
        id: 1001,
        login: "owner",
        avatar_url: "https://avatars.example.com/1001",
        business_id: "biz-shared",
      });
      db.users.set("2002", { id: 2002, login: "viewer", avatar_url: null, business_id: "biz-shared" });
      db.businesses.set("biz-shared", { shared_sessions: 1 });

      await createSession(workerModule, env, "s-repo-ok", {
        repoUrl: "https://github.com/private-owner/repo-ok",
        businessId: "biz-shared",
      });
      await createSession(workerModule, env, "s-repo-missing-context", {
        repoUrl: "https://github.com/private-owner/repo-missing-context",
        businessId: "biz-shared",
      });
      const missingContextRow = db.sessionIndex.get("s-repo-missing-context");
      if (missingContextRow) {
        missingContextRow.repo_owner = null;
        missingContextRow.repo_name = null;
      }

      db.setAuthToken("sess-shared-viewer", {
        user_id: 2002,
        id: 2002,
        expires_at: Date.now() + 60_000,
        login: "viewer",
        name: null,
        email: null,
        business_id: "biz-shared",
        shared_sessions: 1,
      });

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.startsWith("https://api.github.com/user/repos")) {
          return new Response(
            JSON.stringify([
              {
                full_name: "private-owner/repo-ok",
                html_url: "https://github.com/private-owner/repo-ok",
                private: true,
                default_branch: "main",
              },
            ]),
            { status: 200 },
          );
        }
        return originalFetch(input, init);
      };

      const originalSessionNamespace = env.SESSION as DurableNamespace;
      const failingSessionNamespace: DurableNamespace = {
        ...originalSessionNamespace,
        get(id: string) {
          const stub = originalSessionNamespace.get(id);
          return {
            fetch: async (request: Request | string, init?: RequestInit): Promise<Response> => {
              const url = request instanceof Request ? request.url : request;
              if (url === "https://internal/session/state") {
                throw new Error("session state lookup failed");
              }
              return stub.fetch(request, init);
            },
          };
        },
      };
      env.SESSION = failingSessionNamespace;

      const res = await workerFetch(workerModule, env, "/api/sessions?scope=business", {
        headers: { cookie: "session_token=sess-shared-viewer" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
      expect(body.sessions.map((session) => session.sessionId)).toEqual(["s-repo-ok"]);
    });
  });

  // ---- GET /api/sessions/:id/prompts ----

  describe("GET /api/sessions/:id/prompts", () => {
    it("fetches guarded state and forwards auth headers for the owner", async () => {
      const { env, db, sessionNs } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-prompts-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-prompts-owner",
        },
        body: JSON.stringify({ sessionId: "s-prompts-owner", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      const requestCountBefore = sessionNs._requests.length;
      const res = await workerFetch(workerModule, env, "/api/sessions/s-prompts-owner/prompts", {
        headers: { cookie: "session_token=sess-prompts-owner" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.prompts).toEqual([]);

      const newRequests = sessionNs._requests.slice(requestCountBefore);
      expect(newRequests.map((request) => request.url)).toEqual([
        "https://internal/session/state",
        "https://internal/session/prompts",
      ]);
      expect(newRequests[1].headers["x-auth-user-id"]).toBe("1001");
      expect(newRequests[1].headers["x-auth-can-access-all"]).toBe("false");
    });

    it("allows admins to read another user's prompts", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-prompts-admin-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-prompts-admin-owner",
        },
        body: JSON.stringify({ sessionId: "s-prompts-admin", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-prompts-admin/prompts", {
        headers: { authorization: "Bearer admin-secret" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.prompts).toEqual([]);
    });

    it("allows shared business members to read teammate prompts", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.users.set("1001", { id: 1001, login: "owner", avatar_url: null, business_id: "biz-1" });
      db.users.set("1002", { id: 1002, login: "teammate", avatar_url: null, business_id: "biz-1" });
      db.setAuthToken("sess-prompts-business-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
        business_id: "biz-1",
        shared_sessions: 1,
      });
      db.setAuthToken("sess-prompts-business-member", {
        user_id: 1002,
        id: 1002,
        expires_at: Date.now() + 60_000,
        login: "teammate",
        name: null,
        email: null,
        business_id: "biz-1",
        shared_sessions: 1,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-prompts-business-owner",
        },
        body: JSON.stringify({ sessionId: "s-prompts-business", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-prompts-business/prompts", {
        headers: { cookie: "session_token=sess-prompts-business-member" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.prompts).toEqual([]);
    });

    it("returns 404 for a user without session access", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-prompts-private-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
      });
      db.setAuthToken("sess-prompts-private-other", {
        user_id: 2002,
        id: 2002,
        expires_at: Date.now() + 60_000,
        login: "other",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-prompts-private-owner",
        },
        body: JSON.stringify({ sessionId: "s-prompts-private", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-prompts-private/prompts", {
        headers: { cookie: "session_token=sess-prompts-private-other" },
      });

      expect(res.status).toBe(404);
    });
  });

  // ---- GET /api/sessions/:id/context ----

  describe("GET /api/sessions/:id/context", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/context");
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/context", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(404);
    });

    it("returns context for existing session with default repo", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-ctx-1");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-ctx-1/context", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.context.sessionId).toBe("s-ctx-1");
      expect(body.context.repoOwner).toBe("test-owner");
      expect(body.context.repoName).toBe("test-repo");
      expect(body.context.repoUrl).toBe("https://github.com/test-owner/test-repo");
    });

    it("returns context with repo info for session created with repoUrl", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-ctx-2", {
        repoUrl: "https://github.com/acme/widget",
        baseBranch: "develop",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-ctx-2/context", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.context.repoOwner).toBe("acme");
      expect(body.context.repoName).toBe("widget");
      expect(body.context.repoUrl).toBe("https://github.com/acme/widget");
      expect(body.context.baseBranch).toBe("develop");
      expect(body.context.lastBranch).toBeNull();
      expect(body.context.prUrl).toBeNull();
    });

    it("enforces ownership for cookie-auth users", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-ctx-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
      });
      db.setAuthToken("sess-ctx-other", {
        user_id: 2002,
        id: 2002,
        expires_at: Date.now() + 60_000,
        login: "other",
        name: null,
        email: null,
      });

      // Create a session owned by user 1001
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-ctx-owner",
        },
        body: JSON.stringify({ sessionId: "s-ctx-owned", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      // Owner can access it
      const ownerRes = await workerFetch(workerModule, env, "/api/sessions/s-ctx-owned/context", {
        headers: { cookie: "session_token=sess-ctx-owner" },
      });
      expect(ownerRes.status).toBe(200);

      // Other user gets 404 (not found == access denied)
      const otherRes = await workerFetch(workerModule, env, "/api/sessions/s-ctx-owned/context", {
        headers: { cookie: "session_token=sess-ctx-other" },
      });
      expect(otherRes.status).toBe(404);
    });
  });

  // ---- GET /api/sessions/:id/export ----

  describe("GET /api/sessions/:id/export", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/export");
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/export", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(404);
    });

    it("returns export data for existing session", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-export-1", {
        repoUrl: "https://github.com/acme/widget",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-export-1/export", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.session.id).toBe("s-export-1");
      expect(body.session.status).toBe("idle");
      expect(body.session.repoUrl).toBe("https://github.com/acme/widget");
      expect(body.prompts).toEqual([]);
      expect(body.events).toEqual([]);
      expect(body.tokens.inputTokens).toBe(0);
      expect(body.tokens.outputTokens).toBe(0);
      expect(body.stats.totalPrompts).toBe(0);
      expect(body.stats.successCount).toBe(0);
      expect(body.stats.failCount).toBe(0);
      expect(body.pr).toBeNull();
    });
  });

  describe("POST /api/sessions/:id/pr-title", () => {
    it("returns 401 without sandbox authentication (public route, DO-gated)", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/pr-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "ENG-1234 fix" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/sessions/:id/pr-close", () => {
    it("returns 401 without sandbox authentication (public route, DO-gated)", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/pr-close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });
  });

  // ---- PUT /api/sessions/:id/repo ----

  describe("PUT /api/sessions/:id/repo", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/repo", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoUrl: "https://github.com/acme/widget" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/repo", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ repoUrl: "https://github.com/acme/widget" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 when repoUrl is missing", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-repo-1");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-repo-1/repo", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Missing repoUrl");
    });

    it("sets repo successfully on existing session", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-repo-2");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-repo-2/repo", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          repoUrl: "https://github.com/acme/widget",
          baseBranch: "main",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Verify via context endpoint
      const ctxRes = await workerFetch(workerModule, env, "/api/sessions/s-repo-2/context", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(ctxRes.status).toBe(200);
      const ctxBody = await ctxRes.json();
      expect(ctxBody.context.repoOwner).toBe("acme");
      expect(ctxBody.context.repoName).toBe("widget");
      expect(ctxBody.context.baseBranch).toBe("main");
    });

    it("rejects invalid repoUrl format", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-repo-3");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-repo-3/repo", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ repoUrl: "not-a-valid-url" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Invalid repo URL");
    });
  });

  // ---- POST /api/sessions/:id/feedback ----

  describe("POST /api/sessions/:id/feedback", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating: "up" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ rating: "up" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid rating", async () => {
      const { env } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-fb-invalid");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-fb-invalid/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ rating: "neutral" }),
      });
      expect(res.status).toBe(400);
    });

    it("submits feedback with rating only", async () => {
      const { env } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-fb-1");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-fb-1/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ rating: "up" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("submits feedback with message", async () => {
      const { env } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-fb-2");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-fb-2/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          rating: "down",
          message: "needs improvement",
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it("generates transcript server-side from session export", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-fb-3");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-fb-3/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ rating: "up" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // Verify transcript was generated server-side and persisted
      // Admin token auth sets userId to "admin-token"
      const feedbackRow = db.sessionFeedback.get("s-fb-3:admin-token");
      expect(feedbackRow).toBeTruthy();
      expect(feedbackRow!.transcript).toBeTruthy();
      expect(typeof feedbackRow!.transcript).toBe("string");
      expect((feedbackRow!.transcript as string).length).toBeGreaterThan(0);
    });

    it("still returns ok when the Slack notification throws", async () => {
      const { env } = createWorkerEnv(workerModule);
      env.SLACK_BOT_TOKEN = "xoxb-test";
      mockSlackPostMessage.mockRejectedValue(new Error("slack down"));
      await createSession(workerModule, env, "s-fb-slack-throw");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-fb-slack-throw/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ rating: "up" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // Slack post threw -> swallowed -> transcript upload is skipped.
      expect(mockSlackUploadFile).not.toHaveBeenCalled();
    });
  });

  // ---- GET /api/sessions/:sessionId ----

  describe("GET /api/sessions/:sessionId", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-get-1");
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(404);
    });

    it("returns session state for existing session (API token auth)", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-get-1");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-get-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session).toBeDefined();
      expect(body.session.sessionId).toBe("s-get-1");
      expect(body.session.status).toBeDefined();
      expect(body.session.createdAt).toBeDefined();

      // GET handler is a pure read -- no session_index write
    });

    it("normalizes top-level status to the lifecycle phase for completed published sessions", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-get-finality");

      const sessionNs = env.SESSION as DurableNamespace;
      const doState = sessionNs._states.get("s-get-finality");
      expect(doState).toBeDefined();
      doState!.storage.sql.exec(
        "UPDATE session SET publish_status = ? WHERE session_id = ?",
        "published",
        "s-get-finality",
      );

      const res = await workerFetch(workerModule, env, "/api/sessions/s-get-finality", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.phase).toBe("completed");
      expect(body.session.status).toBe("completed");
    });

    it("returns session state for owner (cookie auth)", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-get-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
        business_id: "biz-1",
        shared_sessions: 0,
      });

      // Create a session owned by user 1001 via cookie auth
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-get-owner",
        },
        body: JSON.stringify({ sessionId: "s-get-owned", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-get-owned", {
        headers: { cookie: "session_token=sess-get-owner" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session).toBeDefined();
      expect(body.session.sessionId).toBe("s-get-owned");

      // Owner viewing own session -- no ownerLogin included
      expect(body.ownerLogin).toBeUndefined();
      expect(body.ownerAvatarUrl).toBeUndefined();
    });

    it("returns ownerLogin and ownerAvatarUrl when viewing another user's session", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      // Seed user 1001 in users table with login, avatar_url, and business_id
      db.users.set("1001", {
        id: 1001,
        login: "session-owner",
        avatar_url: "https://avatars.example.com/1001",
        business_id: "biz-shared",
      });

      // Seed a business with shared sessions enabled (for legacy queries)
      db.businesses.set("biz-shared", { shared_sessions: 1 });

      // Create session owned by user 1001 (via API token) with the same business snapshot
      await createSession(workerModule, env, "s-get-shared", { businessId: "biz-shared" });

      // Create auth token for user 2002 in the same business
      db.setAuthToken("sess-get-other", {
        user_id: 2002,
        id: 2002,
        expires_at: Date.now() + 60_000,
        login: "viewer",
        name: null,
        email: null,
        business_id: "biz-shared",
        shared_sessions: 1,
      });

      // GET session as different business member
      const res = await workerFetch(workerModule, env, "/api/sessions/s-get-shared", {
        headers: { cookie: "session_token=sess-get-other" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session).toBeDefined();
      expect(body.session.sessionId).toBe("s-get-shared");
      expect(body.ownerLogin).toBe("session-owner");
      expect(body.ownerAvatarUrl).toBe("https://avatars.example.com/1001");
    });

    it("handles missing owner profile gracefully", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      // Create session owned by user 1001, then remove the profile row.
      await createSession(workerModule, env, "s-get-no-owner");
      db.users.delete("1001");

      // API token auth: userId is "api-token" which differs from ownerUserId "1001",
      // so the handler tries to look up the owner profile, which doesn't exist
      const res = await workerFetch(workerModule, env, "/api/sessions/s-get-no-owner", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session).toBeDefined();
      expect(body.session.sessionId).toBe("s-get-no-owner");
      // No owner profile found -- ownerLogin should not be present
      expect(body.ownerLogin).toBeUndefined();
      expect(body.ownerAvatarUrl).toBeUndefined();
    });
  });

  // ---- DELETE /api/sessions/:sessionId ----

  describe("DELETE /api/sessions/:sessionId", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-del-1", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(404);
    });

    it("successfully deletes (closes) an existing session", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-del-1");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-del-1", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();

      await expect(res.json()).resolves.toEqual({ ok: true, archived: true });

      // Verify session index was updated before fetching the archived session
      const indexRow = db.sessionIndex.get("s-del-1");
      expect(indexRow).toBeDefined();
      expect(indexRow!.status).toBe("archived");

      // Verify session is marked archived (rich status: closed -> archived) by GETting it
      const getRes = await workerFetch(workerModule, env, "/api/sessions/s-del-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.session.status).toBe("archived");

      const eventsRes = await workerFetch(workerModule, env, "/api/sessions/s-del-1/events", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(eventsRes.status).toBe(200);
      expect(await eventsRes.text()).not.toContain('"closeSource":"dashboard_archive"');
    });

    it("delete is idempotent (closing already-closed session)", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-del-idem");

      // First delete
      const res1 = await workerFetch(workerModule, env, "/api/sessions/s-del-idem", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res1.status).toBe(200);

      // Second delete -- should still return 200
      const res2 = await workerFetch(workerModule, env, "/api/sessions/s-del-idem", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res2.status).toBe(200);
    });

    it("rejects malformed archive bodies", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-del-bad-body");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-del-bad-body", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: JSON.stringify({ closePr: "yes" }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts closePr true with no attached PR as archive-only", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-del-close-no-pr");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-del-close-no-pr", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: JSON.stringify({ closePr: true }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        ok: true,
        archived: true,
        prClose: { attempted: false, closed: false },
      });
    });

    it("works with cookie auth (owner deleting own session)", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-del-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
      });

      // Create session owned by user 1001 via cookie auth
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-del-owner",
        },
        body: JSON.stringify({ sessionId: "s-del-cookie", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      // DELETE with cookie auth
      const res = await workerFetch(workerModule, env, "/api/sessions/s-del-cookie", {
        method: "DELETE",
        headers: { cookie: "session_token=sess-del-owner" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();

      // Verify session is archived (rich status: closed -> archived)
      const getRes = await workerFetch(workerModule, env, "/api/sessions/s-del-cookie", {
        headers: { cookie: "session_token=sess-del-owner" },
      });
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json();
      expect(getBody.session.status).toBe("archived");

      const eventsRes = await workerFetch(workerModule, env, "/api/sessions/s-del-cookie/events", {
        headers: { cookie: "session_token=sess-del-owner" },
      });
      expect(eventsRes.status).toBe(200);
      expect(await eventsRes.text()).toContain('"closeSource":"dashboard_archive"');
    });
  });

  // ---- GET /api/sessions/:id/feedback ----

  describe("GET /api/sessions/:id/feedback", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/feedback", {
        method: "GET",
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/feedback", {
        method: "GET",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(404);
    });

    it("returns null feedback when none submitted", async () => {
      const { env } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-fb-get-1");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-fb-get-1/feedback", {
        method: "GET",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.feedback).toBeNull();
    });

    it("returns submitted feedback after POST", async () => {
      const { env } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-fb-get-2");

      // Submit feedback
      const postRes = await workerFetch(workerModule, env, "/api/sessions/s-fb-get-2/feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ rating: "down", message: "could be better" }),
      });
      expect(postRes.status).toBe(200);

      // Retrieve feedback
      const getRes = await workerFetch(workerModule, env, "/api/sessions/s-fb-get-2/feedback", {
        method: "GET",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(getRes.status).toBe(200);
      const body = await getRes.json();
      expect(body.feedback).toBeTruthy();
      expect(body.feedback.rating).toBe("down");
      expect(body.feedback.message).toBe("could be better");
    });
  });

  // ---- /api/sessions/:id/memory-feedback ----

  describe("/api/sessions/:id/memory-feedback", () => {
    function memoryFeedbackPayload(overrides: Record<string, unknown> = {}) {
      return {
        promptId: "p-1",
        activityEventId: "mem-1",
        displayEventType: "memory_usage",
        usageSource: "prompt_start",
        memoryId: "memory-1",
        rating: "up",
        message: "This was useful.",
        memoryTitle: "Useful memory",
        memoryPath: ".cycloid/memory/useful.md",
        memoryReason: "It matched the repo convention.",
        memoryExpectedEffect: "Reuse the helper.",
        memoryObservedEffect: "The helper was reused.",
        ...overrides,
      };
    }

    function addMemoryFeedbackTarget(
      db: FakeD1,
      sessionId: string,
      overrides: { promptId?: string; memoryId?: string; source?: string } = {},
    ) {
      db.memoryUsageEvents.add(
        `${sessionId}:${overrides.promptId ?? "p-1"}:${overrides.memoryId ?? "memory-1"}:${
          overrides.source ?? "prompt_start"
        }`,
      );
    }

    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/memory-feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(memoryFeedbackPayload()),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid event/source pairs", async () => {
      const { env } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-mem-fb-invalid");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-invalid/memory-feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify(
          memoryFeedbackPayload({ displayEventType: "memory_recall_usage", usageSource: "prompt_start" }),
        ),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("memory_recall_usage feedback must use recall source");
    });

    it("stores append-only feedback and skips Slack when config is missing", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-mem-fb-skip", { repoUrl: "https://github.com/acme/widget" });
      addMemoryFeedbackTarget(db, "s-mem-fb-skip");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-skip/memory-feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify(memoryFeedbackPayload()),
      });
      expect(res.status).toBe(200);
      expect(mockSlackPostMessage).not.toHaveBeenCalled();
      const row = [...db.memoryFeedback.values()][0];
      expect(row.rating).toBe("up");
      expect(row.slack_post_status).toBe("skipped_config");
      expect(row.repo_owner).toBe("acme");
      expect(row.repo_name).toBe("widget");
      expect(db.memoryUsageReviewOutcomes.get("s-mem-fb-skip:p-1:memory-1:prompt_start")).toBe("helpful");
    });

    it("rejects feedback for memory usage rows that were not recorded for the session", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-mem-fb-forged");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-forged/memory-feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify(memoryFeedbackPayload()),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("memory feedback target is invalid");
      expect(db.memoryFeedback.size).toBe(0);
      expect(db.memoryUsageReviewOutcomes.size).toBe(0);
      expect(mockSlackPostMessage).not.toHaveBeenCalled();
    });

    it("skips Slack when SLACK_BOT_TOKEN is unset (e.g. QA)", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      // SLACK_BOT_TOKEN intentionally unset; the channel id is now hardcoded, so
      // the token is the only remaining delivery gate -> record skipped_config.
      await createSession(workerModule, env, "s-mem-fb-placeholder");
      addMemoryFeedbackTarget(db, "s-mem-fb-placeholder");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-placeholder/memory-feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify(memoryFeedbackPayload()),
      });
      expect(res.status).toBe(200);
      expect(mockSlackPostMessage).not.toHaveBeenCalled();
      expect([...db.memoryFeedback.values()][0].slack_post_status).toBe("skipped_config");
    });

    it("posts structured Slack feedback when configured", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      env.SLACK_BOT_TOKEN = "xoxb-test";
      mockSlackPostMessage.mockResolvedValueOnce({ ok: true, channel: "C0B9G5TCATB", ts: "123.456" });
      await createSession(workerModule, env, "s-mem-fb-slack", { repoUrl: "https://github.com/acme/widget" });
      addMemoryFeedbackTarget(db, "s-mem-fb-slack");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-slack/memory-feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify(memoryFeedbackPayload({ rating: "down" })),
      });
      expect(res.status).toBe(200);
      expect(mockSlackPostMessage).toHaveBeenCalledWith(
        "xoxb-test",
        "C0B9G5TCATB",
        expect.stringContaining("Memory feedback: down"),
        expect.arrayContaining([expect.objectContaining({ type: "section" })]),
      );
      const row = [...db.memoryFeedback.values()][0];
      expect(row.slack_post_status).toBe("sent");
      expect(row.slack_channel_id).toBe("C0B9G5TCATB");
      expect(row.slack_message_ts).toBe("123.456");
      expect(db.memoryUsageReviewOutcomes.get("s-mem-fb-slack:p-1:memory-1:prompt_start")).toBe("incorrect");
    });

    it("accepts company bootstrap feedback when the durable memory event recorded a prompt-start target", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      env.SLACK_BOT_TOKEN = "xoxb-test";
      mockSlackPostMessage.mockResolvedValueOnce({ ok: true, channel: "C0B9G5TCATB", ts: "123.456" });
      await createSession(workerModule, env, "s-mem-fb-company-bootstrap");
      addMemoryFeedbackTarget(db, "s-mem-fb-company-bootstrap", { source: "prompt_start" });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-company-bootstrap/memory-feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify(memoryFeedbackPayload({ usageSource: "company_bootstrap" })),
      });

      expect(res.status).toBe(200);
      expect(mockSlackPostMessage).toHaveBeenCalledWith(
        "xoxb-test",
        "C0B9G5TCATB",
        expect.stringContaining("Memory feedback: up"),
        expect.arrayContaining([expect.objectContaining({ type: "section" })]),
      );
      const row = [...db.memoryFeedback.values()][0];
      expect(row.usage_source).toBe("prompt_start");
      expect(row.slack_post_status).toBe("sent");
      expect(db.memoryUsageReviewOutcomes.get("s-mem-fb-company-bootstrap:p-1:memory-1:prompt_start")).toBe("helpful");
    });

    it("accepts company recall feedback for memory recall usage rows", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-mem-fb-company-recall");
      addMemoryFeedbackTarget(db, "s-mem-fb-company-recall", { source: "company_recall" });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-company-recall/memory-feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify(
          memoryFeedbackPayload({
            displayEventType: "memory_recall_usage",
            usageSource: "company_recall",
          }),
        ),
      });

      expect(res.status).toBe(200);
      const row = [...db.memoryFeedback.values()][0];
      expect(row.usage_source).toBe("company_recall");
      expect(db.memoryUsageReviewOutcomes.get("s-mem-fb-company-recall:p-1:memory-1:company_recall")).toBe("helpful");
      expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          event: "memory_context.feedback_upvoted",
          sessionId: "s-mem-fb-company-recall",
          memoryId: "memory-1",
          rating: "up",
          usageSource: "company_recall",
        }),
      );
    });

    it("emits a memory context downvote metric for recall feedback", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-mem-fb-recall-downvote", { repoUrl: "https://github.com/acme/widget" });
      addMemoryFeedbackTarget(db, "s-mem-fb-recall-downvote", { source: "recall" });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-recall-downvote/memory-feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify(
          memoryFeedbackPayload({
            displayEventType: "memory_recall_usage",
            usageSource: "recall",
            rating: "down",
          }),
        ),
      });

      expect(res.status).toBe(200);
      expect(db.memoryUsageReviewOutcomes.get("s-mem-fb-recall-downvote:p-1:memory-1:recall")).toBe("incorrect");
      expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          event: "memory_context.feedback_downvoted",
          sessionId: "s-mem-fb-recall-downvote",
          repoOwner: "acme",
          repoName: "widget",
          memoryId: "memory-1",
          rating: "down",
          usageSource: "recall",
        }),
      );
    });

    it("keeps long Slack memory feedback sections within Slack block limits", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      env.SLACK_BOT_TOKEN = "xoxb-test";
      mockSlackPostMessage.mockResolvedValueOnce({ ok: true, channel: "C0B9G5TCATB", ts: "123.456" });
      await createSession(workerModule, env, "s-mem-fb-slack-long");
      addMemoryFeedbackTarget(db, "s-mem-fb-slack-long");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-slack-long/memory-feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify(
          memoryFeedbackPayload({
            memoryTitle: "t".repeat(2000),
            memoryPath: "p".repeat(2000),
            memoryReason: "r".repeat(2000),
            memoryObservedEffect: "o".repeat(2000),
          }),
        ),
      });
      expect(res.status).toBe(200);
      const blocks = mockSlackPostMessage.mock.calls[0]?.[3] as Array<{ text?: { text?: string } }>;
      const sectionTexts = blocks.map((block) => block.text?.text).filter((text): text is string => Boolean(text));
      expect(sectionTexts.length).toBeGreaterThan(0);
      for (const text of sectionTexts) {
        expect(text.length).toBeLessThanOrEqual(2900);
      }
    });

    it("keeps the route successful when Slack returns an error", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      env.SLACK_BOT_TOKEN = "xoxb-test";
      mockSlackPostMessage.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
      await createSession(workerModule, env, "s-mem-fb-slack-fail");
      addMemoryFeedbackTarget(db, "s-mem-fb-slack-fail");
      const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-slack-fail/memory-feedback", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify(memoryFeedbackPayload()),
      });
      expect(res.status).toBe(200);
      const row = [...db.memoryFeedback.values()][0];
      expect(row.slack_post_status).toBe("failed");
      expect(row.slack_post_error).toBe("channel_not_found");
    });

    it("returns the latest feedback per memory row for the current user", async () => {
      const { env, db } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-mem-fb-get");
      addMemoryFeedbackTarget(db, "s-mem-fb-get");
      for (const rating of ["up", "down"]) {
        const res = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-get/memory-feedback", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer admin-secret",
          },
          body: JSON.stringify(memoryFeedbackPayload({ rating })),
        });
        expect(res.status).toBe(200);
      }
      const getRes = await workerFetch(workerModule, env, "/api/sessions/s-mem-fb-get/memory-feedback", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as { feedback: Array<{ rating: string; memoryId: string }> };
      expect(body.feedback).toHaveLength(1);
      expect(body.feedback[0]).toMatchObject({ rating: "down", memoryId: "memory-1" });
    });
  });

  // ---- POST /api/sessions/:id/send ----

  describe("POST /api/sessions/:id/send", () => {
    function mockGithubSkillResponses(
      skills: Array<{ dir: string; name: string; description?: string; argument?: string }>,
    ): void {
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.endsWith("/git/trees/HEAD?recursive=1")) {
          return new Response(
            JSON.stringify({
              truncated: false,
              tree: skills.map((skill, index) => ({
                path: `.claude/skills/${skill.dir}/SKILL.md`,
                sha: `skill-sha-${index}`,
                type: "blob",
              })),
            }),
            { status: 200 },
          );
        }
        const skill = skills.find((_, index) => url.endsWith(`/git/blobs/skill-sha-${index}`));
        if (skill) {
          const markdown = [
            "---",
            `name: ${skill.name}`,
            `description: ${skill.description ?? "Test skill"}`,
            ...(skill.argument ? [`argument: ${skill.argument}`] : []),
            "---",
            "",
            "# Skill",
          ].join("\n");
          return new Response(JSON.stringify({ content: btoa(markdown), encoding: "base64" }), { status: 200 });
        }
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        }
        return originalFetch(input, init);
      };
    }

    // -- Auth & basic errors --

    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-1/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hello" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-nonexistent/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "hello" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 for closed session", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-closed");

      // Close the session via DELETE
      const delRes = await workerFetch(workerModule, env, "/api/sessions/s-send-closed", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(delRes.status).toBe(200);

      // Now try to send a prompt to the closed session
      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-closed/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "hello" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("session_not_sendable");
      expect(body.reason).toBe("archived");
    });

    // -- Prompt validation --

    it("returns 400 when prompt is missing", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-noprompt");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-noprompt/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("prompt");
    });

    it("returns 400 when prompt is empty string", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-empty");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-empty/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "   " }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("prompt");
    });

    it("returns 400 when prompt is non-string type", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-nonstr");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-nonstr/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: 123 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain("prompt");
    });

    it("returns 400 when prompt is non-string type even with skills present", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-nonstr-skills");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-nonstr-skills/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: 123, skills: ["review-spec"] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Prompt must be a string");
    });

    it("returns 503 when requested skills cannot be verified", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-skills-unavailable");
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.endsWith("/git/trees/HEAD?recursive=1") || url.includes("/contents/")) {
          throw new Error("GitHub API failed");
        }
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-skills-unavailable/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "test", skills: ["review-spec"] }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toContain("Unable to verify repository skills");
    });

    it("returns 400 when a requested skill is not available in the repo", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-skills-unknown");
      mockGithubSkillResponses([{ dir: "review-spec", name: "review-spec" }]);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-skills-unknown/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "test", skills: ["missing-skill"] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Unknown skill: missing-skill");
    });

    it("accepts prompt skills after verifying the repo skill list", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-skills-ok");
      mockGithubSkillResponses([{ dir: "review-plan", name: "review-spec" }]);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-skills-ok/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "test", skills: ["review-spec"] }),
      });

      expect(res.status).toBe(202);
    });

    it("accepts optional-argument prompt skills with an empty prompt", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-skills-empty-optional");
      mockGithubSkillResponses([{ dir: "audit-docs", name: "audit-docs", argument: "optional -- doc path" }]);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-skills-empty-optional/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "", skills: ["audit-docs"] }),
      });

      expect(res.status).toBe(202);
    });

    it("accepts prompt skills with required-looking argument metadata and an empty prompt", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-skills-empty-required");
      mockGithubSkillResponses([
        { dir: "verify-pr-before-merge", name: "verify-pr-before-merge", argument: "PR URL or number" },
      ]);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-skills-empty-required/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "", skills: ["verify-pr-before-merge"] }),
      });

      expect(res.status).toBe(202);
    });

    // -- File validation --

    it("returns 400 when files array exceeds 10 items", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-files-max");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-files-max/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          prompt: "test",
          files: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("10");
    });

    it("returns 400 when file path contains '..'", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-files-dotdot");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-files-dotdot/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "test", files: ["../etc/passwd"] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid file path");
    });

    it("returns 400 when file path starts with '/'", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-files-abs");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-files-abs/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "test", files: ["/etc/passwd"] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid file path");
    });

    it("empty files array is treated as undefined (succeeds)", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-files-empty");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-files-empty/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "test", files: [] }),
      });
      expect(res.status).toBe(202);
    });

    // -- Uploaded file validation --

    it("returns 400 when uploaded file exceeds 100KB", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-upload-big");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-upload-big/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          prompt: "test",
          uploadedFiles: [{ name: "big.txt", content: "x".repeat(200_000) }],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("too large");
    });

    it("returns 400 when uploaded file name contains '/' or '\\'", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-upload-slash");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-upload-slash/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          prompt: "test",
          uploadedFiles: [{ name: "path/file.txt", content: "hi" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid uploaded file name");
    });

    it("returns 400 when uploaded file contains null bytes (binary)", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-upload-binary");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-upload-binary/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          prompt: "test",
          uploadedFiles: [{ name: "binary.dat", content: "hello\0world" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Binary files");
    });

    it("returns 400 when more than 5 uploaded files", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-upload-count");

      const sixFiles = Array.from({ length: 6 }, (_, i) => ({
        name: `file${i}.txt`,
        content: `content ${i}`,
      }));

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-upload-count/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "test", uploadedFiles: sixFiles }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("5");
    });

    // -- Uploaded image validation --

    it("returns 400 for invalid image media type", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-img-type");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-img-type/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          prompt: "test",
          uploadedImages: [{ name: "img.bmp", mediaType: "image/bmp", data: "AAAA" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Unsupported image type");
    });

    it("returns 400 when image base64 exceeds 5MB decoded", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-img-big");

      // 5MB decoded = ~6.67MB base64. Generate a string that exceeds the limit.
      // base64 decoded size = length * 3/4, so for > 5*1024*1024 decoded bytes,
      // we need length > 5*1024*1024 * 4/3 ≈ 6990507 chars
      const oversizedBase64 = "A".repeat(7_000_000);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-img-big/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          prompt: "test",
          uploadedImages: [{ name: "huge.png", mediaType: "image/png", data: oversizedBase64 }],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("too large");
    });

    it("returns 400 for invalid base64 string", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-img-b64");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-img-b64/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          prompt: "test",
          uploadedImages: [{ name: "img.png", mediaType: "image/png", data: "not-valid-base64!!!" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid base64");
    });

    it("returns 413 when large prompt text plus near-limit uploads exceed the prompt row budget", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-row-budget");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-row-budget/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          prompt: "x".repeat(20_000),
          uploadedImages: [{ name: "large.png", mediaType: "image/png", data: "A".repeat(1_790_000) }],
        }),
      });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toContain("Prompt and attachments are too large");
    });

    // -- Success paths --

    it("successfully sends a simple prompt (202)", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-ok");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-ok/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "hello world" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.sessionId).toBe("s-send-ok");
      expect(body.prompt).toBeDefined();
      expect(body.dispatch).toBeDefined();
      expect(body.queue).toBeDefined();
    });

    it("successfully sends prompt with files and uploadedFiles", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-full");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-full/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({
          prompt: "implement the feature",
          files: ["src/index.ts", "src/utils.ts"],
          uploadedFiles: [{ name: "spec.md", content: "# Spec\nDo the thing" }],
        }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.sessionId).toBe("s-send-full");
    });

    it("accepts a queued follow-up prompt while the session is already running", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-send-follow-up");

      const first = await workerFetch(workerModule, env, "/api/sessions/s-send-follow-up/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "start working" }),
      });
      expect(first.status).toBe(202);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-send-follow-up/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "follow up with more details" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  // ---- POST /api/sessions/:sessionId/stop ----

  describe("POST /api/sessions/:sessionId/stop", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-stop-1/stop", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/stop", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("not found");
    });

    it("returns 409 session_not_stoppable when no sandbox is connected", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-stop-no-sandbox");

      // No sandbox socket and not transient: surface a structured 409 instead
      // of the legacy `200 { status: "already_stopped" }` silent-fail. Callers
      // (UI, CLI, webhooks) now see a real conflict and can branch on `reason`.
      const res = await workerFetch(workerModule, env, "/api/sessions/s-stop-no-sandbox/stop", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("session_not_stoppable");
      expect(body.reason).toBe("already_stopped");
    });

    it("returns 409 when sandbox is still spawning without a socket", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-stop-spawning");
      const doState = sessionNs._states.get("s-stop-spawning");
      expect(doState).toBeDefined();
      doState!.storage.sql.exec(
        "UPDATE sandbox_state SET status = ? WHERE session_id = ?",
        "spawning",
        "s-stop-spawning",
      );

      const res = await workerFetch(workerModule, env, "/api/sessions/s-stop-spawning/stop", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Sandbox spawning");
    });

    it("returns 409 session_not_stoppable when stopping an already-closed session", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-stop-closed");

      // Close the session via DELETE
      const delRes = await workerFetch(workerModule, env, "/api/sessions/s-stop-closed", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(delRes.status).toBe(200);

      // Try to stop the closed session — no sandbox socket: structured 409 (see above).
      const res = await workerFetch(workerModule, env, "/api/sessions/s-stop-closed/stop", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("session_not_stoppable");
      expect(body.reason).toBe("already_stopped");
    });

    it("works with cookie auth", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-stop-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
      });

      // Create session owned by user 1001 via cookie auth
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-stop-owner",
        },
        body: JSON.stringify({ sessionId: "s-stop-cookie", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      // Stop with cookie auth — no sandbox returns a structured 409 now
      // (auth still succeeds; the 409 is from `STOP_BLOCKED_ERROR`, not 401/403).
      const res = await workerFetch(workerModule, env, "/api/sessions/s-stop-cookie/stop", {
        method: "POST",
        headers: { cookie: "session_token=sess-stop-owner" },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("session_not_stoppable");
    });
  });

  // ---- POST /api/sessions/:sessionId/retry ----

  describe("POST /api/sessions/:sessionId/retry", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-retry-1/retry", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/retry", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("not found");
    });

    it("returns 404 for a user without session access (fail closed)", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-retry-private-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
      });
      db.setAuthToken("sess-retry-private-other", {
        user_id: 2002,
        id: 2002,
        expires_at: Date.now() + 60_000,
        login: "other",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-retry-private-owner",
        },
        body: JSON.stringify({ sessionId: "s-retry-private", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-retry-private/retry", {
        method: "POST",
        headers: { cookie: "session_token=sess-retry-private-other" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a member of a different business (fail closed)", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.users.set("1001", { id: 1001, login: "owner", avatar_url: null, business_id: "biz-1" });
      db.users.set("3003", { id: 3003, login: "outsider", avatar_url: null, business_id: "biz-2" });
      db.setAuthToken("sess-retry-biz-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
        business_id: "biz-1",
        shared_sessions: 1,
      });
      db.setAuthToken("sess-retry-biz-outsider", {
        user_id: 3003,
        id: 3003,
        expires_at: Date.now() + 60_000,
        login: "outsider",
        name: null,
        email: null,
        business_id: "biz-2",
        shared_sessions: 1,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-retry-biz-owner",
        },
        body: JSON.stringify({ sessionId: "s-retry-cross-biz", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-retry-cross-biz/retry", {
        method: "POST",
        headers: { cookie: "session_token=sess-retry-biz-outsider" },
      });
      expect(res.status).toBe(404);
    });

    it("fails retry closed when repo access revalidation fails", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-retry-denied", {
        user_id: 1206,
        id: 1206,
        expires_at: Date.now() + 60_000,
        login: "retry-denied-user",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-retry-denied",
        },
        body: JSON.stringify({ sessionId: "s-retry-denied", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        return originalFetch(input, init);
      };

      const res = await workerFetch(workerModule, env, "/api/sessions/s-retry-denied/retry", {
        method: "POST",
        headers: { cookie: "session_token=sess-retry-denied" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Access unavailable. Contact your administrator.");
    });

    it("returns 409 when the session has no completed or failed prompt to retry", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-retry-no-terminal");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-retry-no-terminal/retry", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      // The route collapses every DO rejection to 409 (see the retry route in
      // routes/sessions.ts); the DO's original error body is preserved.
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No completed or failed prompts");
    });

    it("returns 409 for an archived session", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-retry-archived");

      const delRes = await workerFetch(workerModule, env, "/api/sessions/s-retry-archived", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(delRes.status).toBe(200);
      expect(((await delRes.json()) as { archived?: boolean }).archived).toBe(true);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-retry-archived/retry", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      // The route's archived guard fires before the phase gate and the DO,
      // so the archived rejection carries the user-facing message.
      expect(body.error).toBe("Session is archived. Start a new session to continue.");
    });

    it("clones and re-queues the last failed prompt (202)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-retry-ok");

      const sendRes = await workerFetch(workerModule, env, "/api/sessions/s-retry-ok/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ prompt: "do the thing" }),
      });
      expect(sendRes.status).toBe(202);

      // Force the seeded prompt terminal so the DO has a failed prompt to clone.
      const doState = sessionNs._states.get("s-retry-ok");
      expect(doState).toBeDefined();
      doState!.storage.sql.exec("UPDATE prompts SET status = 'failed' WHERE session_id = ?", "s-retry-ok");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-retry-ok/retry", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.prompt).toBeDefined();
      expect(body.prompt.prompt).toBe("do the thing");
      // No active prompt remained, so the clone dispatches immediately.
      expect(body.status).toBe("running");
    });

    it("works with cookie auth (owner retrying own session)", async () => {
      const { env, db, sessionNs } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-retry-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-retry-owner",
        },
        body: JSON.stringify({ sessionId: "s-retry-cookie", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      const sendRes = await workerFetch(workerModule, env, "/api/sessions/s-retry-cookie/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-retry-owner",
        },
        body: JSON.stringify({ prompt: "cookie retry seed" }),
      });
      expect(sendRes.status).toBe(202);

      const doState = sessionNs._states.get("s-retry-cookie");
      expect(doState).toBeDefined();
      doState!.storage.sql.exec("UPDATE prompts SET status = 'failed' WHERE session_id = ?", "s-retry-cookie");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-retry-cookie/retry", {
        method: "POST",
        headers: { cookie: "session_token=sess-retry-owner" },
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });

  // ---- POST /api/sessions/:sessionId/respond ----

  describe("POST /api/sessions/:sessionId/respond", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-1/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-nonexistent/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: "yes" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 when answer is missing", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-respond-noanswer");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-noanswer/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("answer");
    });

    it("returns 400 when answer is empty string", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-respond-empty");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-empty/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: "" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("answer");
    });

    it("returns 400 when answer is non-string type", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-respond-nonstr");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-nonstr/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: 42 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("answer");
    });

    it("returns 413 without parsing when the declared Content-Length exceeds the cap", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-respond-clen");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-clen/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "999999999",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: "small" }),
      });
      expect(res.status).toBe(413);
    });

    it("returns 413 when the answer exceeds the byte cap", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-respond-big");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-big/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: "a".repeat(1_900_000) }),
      });
      expect(res.status).toBe(413);
    });

    it("returns 413 for a multi-byte answer over the byte cap but under the char-count cap", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-respond-mb");

      // 700k chars of a 3-byte UTF-8 char: 2.1MB bytes, well under the cap by .length.
      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-mb/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: "€".repeat(700_000) }),
      });
      expect(res.status).toBe(413);
    });

    it("does not false-reject an at-cap answer whose JSON envelope pushes Content-Length over the cap", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-respond-envelope");

      // Answer is exactly at the byte cap (1 byte/char), so the JSON body
      // `{"answer":"…"}` is slightly larger than the cap. The pre-parse guard
      // must allow envelope headroom and the post-parse answer check must pass,
      // so the request reaches the phase gate (409) rather than a false 413.
      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-envelope/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: "a".repeat(1_800_000) }),
      });
      expect(res.status).not.toBe(413);
      expect(res.status).toBe(409);
    });

    it("returns 409 session_not_respondable when the session has no pending question", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-respond-ok");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-ok/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: "yes" }),
      });
      // Phase=idle on a fresh session → route gate via `isRespondAvailable`
      // rejects with structured 409 before the DO is called.
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("session_not_respondable");
      expect(body.reason).toBe("idle");
    });

    it("returns 409 with a plan-approval reason when the session is parked", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-respond-parked");
      seedSessionPlan(sessionNs, "s-respond-parked", "pending", 4);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-parked/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: "yes" }),
      });

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: "session_not_respondable",
        reason: "plan_approval_pending",
      });
    });

    it("rejects respond with questionId when phase isn't waiting_for_input", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-respond-qid");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-qid/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: "yes", questionId: "q-123" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("session_not_respondable");
      expect(body.reason).toBe("idle");
    });

    it("returns 409 for closed session", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-respond-closed");

      // Close the session via DELETE
      const delRes = await workerFetch(workerModule, env, "/api/sessions/s-respond-closed", {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(delRes.status).toBe(200);

      // Try to respond to the closed session
      const res = await workerFetch(workerModule, env, "/api/sessions/s-respond-closed/respond", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer admin-secret",
        },
        body: JSON.stringify({ answer: "yes" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });
  });

  it("carries plan approval metadata on the session view payload without markdown", async () => {
    const { env, db, sessionNs } = createWorkerEnv(workerModule);
    db.setAuthToken("sess-view-plan-owner", {
      user_id: 1001,
      id: 1001,
      expires_at: Date.now() + 60_000,
      login: "owner",
      name: null,
      email: null,
      business_id: "biz-1",
      shared_sessions: 0,
    });
    await createSession(workerModule, env, "s-view-plan-metadata");
    seedSessionPlan(sessionNs, "s-view-plan-metadata", "pending", 6);

    const res = await workerFetch(workerModule, env, "/api/sessions/s-view-plan-metadata/view", {
      headers: { cookie: "session_token=sess-view-plan-owner" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: Record<string, unknown> };
    expect(body.session).toMatchObject({
      planApprovalPending: true,
      planRevision: 6,
      planStatus: "pending",
    });
    expect(body.session).not.toHaveProperty("planMarkdown");
    expect(body.session).not.toHaveProperty("markdown");
  });

  // ---- GET /api/sessions/:sessionId/usage ----

  describe("GET /api/sessions/:sessionId/usage", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-usage-1/usage");
      expect(res.status).toBe(401);
    });

    it("returns 404 for nonexistent session", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/usage", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("not found");
    });

    it("returns null usage for fresh session (no prompts sent)", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-usage-fresh");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-usage-fresh/usage", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.usage).toBeNull();
    });

    it("returns usage data when usage_cache is populated", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-usage-data");

      // Inject prompt_usage rows via SQL (usage is now computed from prompt_usage table)
      const doState = sessionNs._states.get("s-usage-data");
      expect(doState).toBeDefined();
      const sql = doState!.storage.sql;
      const now = Date.now();
      // Insert two prompts so promptCount == 2
      sql.exec(
        "INSERT INTO prompts (prompt_id, session_id, prompt_text, actor_user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "p-usage-1",
        "s-usage-data",
        "prompt 1",
        "user-1",
        "completed",
        now,
        now,
      );
      sql.exec(
        "INSERT INTO prompts (prompt_id, session_id, prompt_text, actor_user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "p-usage-2",
        "s-usage-data",
        "prompt 2",
        "user-1",
        "completed",
        now,
        now,
      );
      sql.exec(
        "INSERT INTO prompt_usage (prompt_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_cost_usd_micros) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "p-usage-1",
        "gpt-5.4-mini",
        1000,
        500,
        60,
        30,
        30000,
      );
      sql.exec(
        "INSERT INTO prompt_usage (prompt_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_cost_usd_micros) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "p-usage-2",
        "gpt-5.4-mini",
        500,
        300,
        40,
        20,
        20000,
      );

      const res = await workerFetch(workerModule, env, "/api/sessions/s-usage-data/usage", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.usage).toBeDefined();
      expect(body.usage.promptCount).toBe(2);
      expect(body.usage.inputTokens).toBe(1500);
      expect(body.usage.outputTokens).toBe(800);
      expect(body.usage.cacheReadTokens).toBe(100);
      expect(body.usage.cacheWriteTokens).toBe(50);
      expect(body.usage.totalTokens).toBe(2300);
      expect(body.usage.totalBilledTokens).toBe(2450);
      expect(body.usage.totalCostUsd).toBeCloseTo(0.05);
      expect(body.usage.byModel).toBeDefined();
      expect(body.usage.byModel["gpt-5.4-mini"]).toMatchObject({
        inputTokens: 1500,
        outputTokens: 800,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        totalTokens: 2300,
        totalBilledTokens: 2450,
      });
    });

    it("returns usage via cookie auth for session owner", async () => {
      const { env, db } = createWorkerEnv(workerModule);

      db.setAuthToken("sess-usage-owner", {
        user_id: 1001,
        id: 1001,
        expires_at: Date.now() + 60_000,
        login: "owner",
        name: null,
        email: null,
      });

      // Create session owned by user 1001 via cookie auth
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-usage-owner",
        },
        body: JSON.stringify({ sessionId: "s-usage-cookie", repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(201);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-usage-cookie/usage", {
        headers: { cookie: "session_token=sess-usage-owner" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.usage).toBeNull();
    });

    it("returns null usage when usage_cache has promptCount of 0", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-usage-zero");

      // No prompt_usage rows needed -- zero prompts means usage is null
      const doState = sessionNs._states.get("s-usage-zero");
      expect(doState).toBeDefined();

      const res = await workerFetch(workerModule, env, "/api/sessions/s-usage-zero/usage", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // DO returns null when promptCount is 0
      expect(body.usage).toBeNull();
    });
  });

  // ---- GET /api/sessions/:sessionId/input-composition ----

  describe("GET /api/sessions/:sessionId/input-composition", () => {
    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-input-composition-1/input-composition");
      expect(res.status).toBe(401);
    });

    it("returns null input composition for a fresh session", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-input-composition-fresh");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-input-composition-fresh/input-composition", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.inputComposition).toBeNull();
    });

    it("returns estimated input composition data", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-input-composition-data");

      const doState = sessionNs._states.get("s-input-composition-data");
      expect(doState).toBeDefined();
      const sql = doState!.storage.sql;
      const now = Date.now();
      sql.exec(
        "INSERT INTO prompts (prompt_id, session_id, prompt_text, actor_user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "p-input-composition-1",
        "s-input-composition-data",
        "prompt 1",
        "user-1",
        "completed",
        now,
        now,
      );
      sql.exec(
        "INSERT INTO prompt_token_attribution (prompt_id, attribution_json) VALUES (?, ?)",
        "p-input-composition-1",
        JSON.stringify({
          kind: "estimated_input_composition",
          version: 1,
          components: {
            systemContext: 100,
            historicalSessions: 50,
            taskText: 25,
            uploads: 10,
            measuredTotal: 185,
            actualInputTokens: 210,
            actualOutputTokens: 40,
            unmeasuredTokens: 25,
          },
        }),
      );

      const res = await workerFetch(workerModule, env, "/api/sessions/s-input-composition-data/input-composition", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.inputComposition["p-input-composition-1"]).toMatchObject({
        kind: "estimated_input_composition",
        version: 1,
        components: {
          measuredTotal: 185,
          actualInputTokens: 210,
          unmeasuredTokens: 25,
        },
      });
    });
  });

  // ---- GET /api/sessions/:sessionId/files ----

  describe("GET /api/sessions/:sessionId/files", () => {
    /** Mock GitHub tree API response for fetchRepoTree */
    const MOCK_TREE_RESPONSE = {
      tree: [
        { path: "src", type: "tree" },
        { path: "src/index.ts", type: "blob" },
        { path: "README.md", type: "blob" },
      ],
      truncated: false,
    };

    /** Helper: create session via cookie auth and return the env pieces */
    async function setupCookieSession(
      wm: WorkerModule,
      opts: {
        sessionId: string;
        userId?: number;
        login?: string;
        repoUrl?: string;
        baseBranch?: string;
      },
    ): Promise<{
      env: Record<string, unknown>;
      db: FakeD1;
      sessionNs: DurableNamespace;
      kv: FakeKV;
      cookieHeader: string;
    }> {
      const { env, db, sessionNs, kv } = createWorkerEnv(wm);
      const userId = opts.userId ?? 1001;
      const login = opts.login ?? "testuser";
      const token = `sess-files-${opts.sessionId}`;

      db.setAuthToken(token, {
        user_id: userId,
        id: userId,
        expires_at: Date.now() + 60_000,
        login,
        name: null,
        email: null,
      });

      const createRes = await workerFetch(wm, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `session_token=${token}`,
        },
        body: JSON.stringify({
          sessionId: opts.sessionId,
          repoUrl: opts.repoUrl ?? "https://github.com/test-owner/test-repo",
          ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
        }),
      });
      expect(createRes.status).toBe(201);

      return { env, db, sessionNs, kv, cookieHeader: `session_token=${token}` };
    }

    it("returns 401 without authentication", async () => {
      const { env } = createWorkerEnv(workerModule);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-files-1/files");
      expect(res.status).toBe(401);
    });

    it("returns 403 when using API token auth (browser-only endpoint)", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-files-api");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-files-api/files", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("Browser-only");
    });

    it("returns 400 when session has no repo configured", async () => {
      const { env, sessionNs, cookieHeader } = await setupCookieSession(workerModule, {
        sessionId: "s-files-norepo",
      });

      // Clear repo context from DO SQL storage to simulate missing repo
      const doState = sessionNs._states.get("s-files-norepo");
      expect(doState).toBeDefined();
      doState!.storage.sql.exec(
        "UPDATE session SET repo_owner = NULL, repo_name = NULL WHERE session_id = ?",
        "s-files-norepo",
      );

      const res = await workerFetch(workerModule, env, "/api/sessions/s-files-norepo/files", {
        headers: { cookie: cookieHeader },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("No repo configured");
    });

    it("returns 400 when only repoName is missing from context", async () => {
      const { env, sessionNs, cookieHeader } = await setupCookieSession(workerModule, {
        sessionId: "s-files-noname",
      });

      // Clear only repo_name to test partial repo config
      const doState = sessionNs._states.get("s-files-noname");
      expect(doState).toBeDefined();
      doState!.storage.sql.exec("UPDATE session SET repo_name = NULL WHERE session_id = ?", "s-files-noname");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-files-noname/files", {
        headers: { cookie: cookieHeader },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("No repo configured");
    });

    it("returns 401 when user has no GitHub token", async () => {
      const { env, db, cookieHeader } = await setupCookieSession(workerModule, {
        sessionId: "s-files-notoken",
        userId: 2002,
      });

      // Mark user 2002 as having no GitHub token
      db.noGithubTokenUserIds.add(2002);

      const res = await workerFetch(workerModule, env, "/api/sessions/s-files-notoken/files", {
        headers: { cookie: cookieHeader },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain("GitHub token not found");
    });

    it("returns file list on success (with GitHub mock)", async () => {
      const { env, cookieHeader } = await setupCookieSession(workerModule, {
        sessionId: "s-files-success",
      });

      // Mock GitHub tree API
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/repos/test-owner/test-repo/git/trees/")) {
          return new Response(JSON.stringify(MOCK_TREE_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      const res = await workerFetch(workerModule, env, "/api/sessions/s-files-success/files", {
        headers: { cookie: cookieHeader },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.files).toBeDefined();
      expect(Array.isArray(body.files)).toBe(true);
      // fetchRepoTree filters blobs and trees, then sorts
      expect(body.files).toEqual(["README.md", "src", "src/index.ts"]);
    });

    it("returns cached result on second request (KV cache)", async () => {
      const { env, kv, cookieHeader } = await setupCookieSession(workerModule, {
        sessionId: "s-files-cache",
        baseBranch: "develop",
      });

      let githubCallCount = 0;

      // Mock GitHub tree API with call counter
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/repos/test-owner/test-repo/git/trees/")) {
          githubCallCount++;
          return new Response(JSON.stringify(MOCK_TREE_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      // First request: populates KV cache
      const res1 = await workerFetch(workerModule, env, "/api/sessions/s-files-cache/files", {
        headers: { cookie: cookieHeader },
      });
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.files).toEqual(["README.md", "src", "src/index.ts"]);
      expect(githubCallCount).toBe(1);

      // Verify KV cache key format: files:{userId}:{repoOwner}:{repoName}:{branch}
      const cacheKey = "files:1001:test-owner:test-repo:develop";
      const cached = (await kv.get(cacheKey, "json")) as { files: string[] } | null;
      expect(cached).toBeTruthy();
      expect(cached!.files).toEqual(["README.md", "src", "src/index.ts"]);

      // Second request: should use cache, no additional GitHub call
      const res2 = await workerFetch(workerModule, env, "/api/sessions/s-files-cache/files", {
        headers: { cookie: cookieHeader },
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.files).toEqual(["README.md", "src", "src/index.ts"]);
      expect(githubCallCount).toBe(1); // Still 1 -- no second GitHub call
    });

    it("returns 500 when GitHub fetch fails", async () => {
      const { env, cookieHeader } = await setupCookieSession(workerModule, {
        sessionId: "s-files-error",
      });

      // Mock GitHub tree API to return error
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/repos/test-owner/test-repo/git/trees/")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
        }
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      const res = await workerFetch(workerModule, env, "/api/sessions/s-files-error/files", {
        headers: { cookie: cookieHeader },
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("GitHub tree fetch failed");
    });

    it("defaults branch to 'main' when baseBranch is not set", async () => {
      const { env, kv, cookieHeader } = await setupCookieSession(workerModule, {
        sessionId: "s-files-default-branch",
        // No baseBranch specified -- should default to "main"
      });

      let capturedTreeUrl = "";

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
        if (url.includes("api.github.com/repos/test-owner/test-repo/git/trees/")) {
          capturedTreeUrl = url;
          return new Response(JSON.stringify(MOCK_TREE_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("api.github.com/repos/")) {
          return new Response(JSON.stringify({ id: 1 }), { status: 200 });
        }
        return originalFetch(input, init);
      };

      const res = await workerFetch(workerModule, env, "/api/sessions/s-files-default-branch/files", {
        headers: { cookie: cookieHeader },
      });
      expect(res.status).toBe(200);

      // Verify the GitHub API was called with "main" branch
      expect(capturedTreeUrl).toContain("/git/trees/main");

      // Verify KV cache key uses "main" as branch
      const cacheKey = "files:1001:test-owner:test-repo:main";
      const cached = (await kv.get(cacheKey, "json")) as { files: string[] } | null;
      expect(cached).toBeTruthy();
    });
  });

  // ---- GET /api/sessions/:sessionId/clone-token ----

  describe("GET /api/sessions/:sessionId/clone-token", () => {
    it("returns 401 for nonexistent session without auth", async () => {
      const { env } = createWorkerEnv(workerModule);

      // No session created — the DO is new with no stored hash.
      // Missing bearer token → DO returns 401 "Missing sandbox auth token" (durable-object.ts:1197-1198)
      const res = await workerFetch(workerModule, env, "/api/sessions/nonexistent/clone-token");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.ok).toBe(false);
    });

    it("rejects request without sandbox auth token (401)", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-clonetoken-noauth");

      // Existing session, no Authorization header → 401 (durable-object.ts:1197-1198)
      const res = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-noauth/clone-token");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Missing sandbox auth token");
    });

    it("rate limits repeated sandbox auth failures per IP and recovers after lockout", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-04T00:00:00Z"));
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-clonetoken-rate-limit");

      for (let i = 0; i < 5; i++) {
        const res = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-rate-limit/clone-token", {
          headers: { "CF-Connecting-IP": "203.0.113.9" },
        });
        expect(res.status).toBe(401);
      }

      const lockedRes = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-rate-limit/clone-token", {
        headers: { "CF-Connecting-IP": "203.0.113.9" },
      });
      expect(lockedRes.status).toBe(429);
      await expect(lockedRes.json()).resolves.toMatchObject({ ok: false, error: "Too many sandbox auth failures" });

      vi.setSystemTime(new Date("2026-05-04T00:00:31Z"));

      const recoveredRes = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-rate-limit/clone-token", {
        headers: { "CF-Connecting-IP": "203.0.113.9" },
      });
      expect(recoveredRes.status).toBe(401);
    });

    it("keeps sandbox auth failure counters isolated by IP", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-clonetoken-ip-isolation");

      for (let i = 0; i < 5; i++) {
        const res = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-ip-isolation/clone-token", {
          headers: { "CF-Connecting-IP": "203.0.113.10" },
        });
        expect(res.status).toBe(401);
      }

      const blockedIpRes = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-ip-isolation/clone-token", {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      });
      expect(blockedIpRes.status).toBe(429);

      const otherIpRes = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-ip-isolation/clone-token", {
        headers: { "CF-Connecting-IP": "203.0.113.11" },
      });
      expect(otherIpRes.status).toBe(401);
    });

    it("applies sandbox auth failure limits across sessions with a sliding window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-04T00:00:00Z"));
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-clonetoken-sliding-a");
      await createSession(workerModule, env, "s-clonetoken-sliding-b");

      for (const [index, offsetMs] of [0, 15_000, 30_000, 45_000, 59_000].entries()) {
        vi.setSystemTime(new Date(Date.parse("2026-05-04T00:00:00Z") + offsetMs));
        const sessionId = index % 2 === 0 ? "s-clonetoken-sliding-a" : "s-clonetoken-sliding-b";
        const res = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/clone-token`, {
          headers: { "CF-Connecting-IP": "203.0.113.12" },
        });
        expect(res.status).toBe(401);
      }

      vi.setSystemTime(new Date("2026-05-04T00:01:01Z"));

      const lockedRes = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-sliding-b/clone-token", {
        headers: { "CF-Connecting-IP": "203.0.113.12" },
      });
      expect(lockedRes.status).toBe(429);
    });

    it("rejects request with wrong sandbox token (403)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-clonetoken-wrongtoken");

      // Seed a hash for "correct-sandbox-token" into DO SQL storage
      const correctToken = "correct-sandbox-token";
      const tokenHash = await sha256Hex(correctToken);
      const doState = sessionNs._states.get("s-clonetoken-wrongtoken");
      expect(doState).toBeDefined();
      doState!.storage.sql.exec(
        "UPDATE sandbox_state SET sandbox_auth_token_hash = ?, status = 'ready' WHERE session_id = ?",
        tokenHash,
        "s-clonetoken-wrongtoken",
      );

      // Send a different bearer token → hash mismatch → 403 (durable-object.ts:1206-1207)
      const res = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-wrongtoken/clone-token", {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Invalid sandbox auth token");
    });

    it("passes auth and reaches token generation with valid sandbox token", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-clonetoken-valid");

      const sandboxToken = "test-clone-token-xyz";
      const tokenHash = await sha256Hex(sandboxToken);

      // Inject hash + installation_id into DO SQL storage
      // (mirrors what sandbox spawn does)
      const doState = sessionNs._states.get("s-clonetoken-valid");
      expect(doState).toBeDefined();
      doState!.storage.sql.exec(
        "UPDATE sandbox_state SET sandbox_auth_token_hash = ?, status = 'ready' WHERE session_id = ?",
        tokenHash,
        "s-clonetoken-valid",
      );
      doState!.storage.sql.exec(
        "UPDATE session SET installation_id = ? WHERE session_id = ?",
        42,
        "s-clonetoken-valid",
      );

      // Auth passes; GITHUB_APP_ID / GITHUB_PRIVATE_KEY are not set in the test env
      // so the DO returns 500 "GitHub App not configured" (durable-object.ts:1215-1216).
      // A non-401/403 response confirms the route delegates to the DO and the DO
      // validates the sandbox token correctly.
      const res = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-valid/clone-token", {
        headers: { authorization: `Bearer ${sandboxToken}` },
      });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("GitHub App not configured");
    });

    it("mints the push token with the workflows:write scope when the installation grants it", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      env.GITHUB_APP_ID = "app-id";
      env.GITHUB_PRIVATE_KEY = "private-key";
      mockCloneTokenMint.mockReset();
      mockCloneTokenMint.mockResolvedValue("ghs_push_token");

      await createSession(workerModule, env, "s-clonetoken-workflows-granted");
      await seedSandboxToken(sessionNs, "s-clonetoken-workflows-granted", "sandbox-token");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-workflows-granted/clone-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, token: "ghs_push_token" });
      // Single mint: the push scope (with workflows:write) succeeded, no fallback.
      expect(mockCloneTokenMint).toHaveBeenCalledTimes(1);
      expect(mockCloneTokenMint.mock.calls[0][0].permissions).toMatchObject({ workflows: "write" });
    });

    it("falls back to the minimal push scope when the installation has not approved workflows:write", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      env.GITHUB_APP_ID = "app-id";
      env.GITHUB_PRIVATE_KEY = "private-key";
      mockCloneTokenMint.mockReset();
      // First call (push scope w/ workflows:write) is rejected as over-broad (422);
      // the route must retry with the minimal scope and return that token.
      mockCloneTokenMint.mockImplementation((scope: { permissions: Record<string, string> }) => {
        if (scope.permissions.workflows) {
          return Promise.reject(Object.assign(new Error("permissions not granted"), { status: 422 }));
        }
        return Promise.resolve("ghs_minimal_token");
      });

      await createSession(workerModule, env, "s-clonetoken-workflows-ungranted");
      await seedSandboxToken(sessionNs, "s-clonetoken-workflows-ungranted", "sandbox-token");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-workflows-ungranted/clone-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, token: "ghs_minimal_token" });
      // Two mints: over-broad push scope rejected, then minimal scope succeeded.
      expect(mockCloneTokenMint).toHaveBeenCalledTimes(2);
      expect(mockCloneTokenMint.mock.calls[0][0].permissions).toMatchObject({ workflows: "write" });
      expect(mockCloneTokenMint.mock.calls[1][0].permissions).not.toHaveProperty("workflows");
    });

    it("rejects token generation after the sandbox is stopped", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-clonetoken-stopped");
      await seedSandboxToken(sessionNs, "s-clonetoken-stopped", "sandbox-token", "stopped");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-stopped/clone-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Sandbox not active");
      // Structured code lets the bridge distinguish this lifecycle 403 from a
      // real sandbox-auth rejection (which has no code).
      expect(body.code).toBe("sandbox_not_active");
    });

    it("rejects token generation with the structured code when the session is no longer active", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-clonetoken-session-done");
      await seedSandboxToken(sessionNs, "s-clonetoken-session-done", "sandbox-token", "ready");
      const doState = sessionNs._states.get("s-clonetoken-session-done");
      expect(doState).toBeDefined();
      doState!.storage.sql.exec(
        "UPDATE session SET status = ? WHERE session_id = ?",
        "completed",
        "s-clonetoken-session-done",
      );

      const res = await workerFetch(workerModule, env, "/api/sessions/s-clonetoken-session-done/clone-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Sandbox not active");
      expect(body.code).toBe("sandbox_not_active");
    });
  });

  // ---- Grace-overlap previous sandbox auth token (Part A) ----

  describe("grace-overlap previous sandbox auth token", () => {
    async function seedRotatedTokens(
      sessionNs: DurableNamespace,
      sessionId: string,
      opts: {
        currentToken: string;
        prevToken: string | null;
        prevExpiresAt: number | null;
        sandboxId?: string;
        // Multi-generation overlap: when set, seeds the full prior-generation list
        // (newest-first) instead of deriving a single entry from prevToken.
        priorTokens?: Array<{ token: string; expiresAt: number }>;
      },
    ): Promise<void> {
      const doState = sessionNs._states.get(sessionId);
      expect(doState).toBeDefined();
      const priorGenerations =
        opts.priorTokens !== undefined
          ? await Promise.all(
              opts.priorTokens.map(async (g) => ({ hash: await sha256Hex(g.token), expiresAt: g.expiresAt })),
            )
          : opts.prevToken === null
            ? []
            : [{ hash: await sha256Hex(opts.prevToken), expiresAt: opts.prevExpiresAt ?? 0 }];
      doState!.storage.sql.exec(
        `UPDATE sandbox_state
         SET sandbox_auth_token_hash = ?, prev_sandbox_auth_token_hashes = ?,
             sandbox_id = ?, status = 'ready'
         WHERE session_id = ?`,
        await sha256Hex(opts.currentToken),
        JSON.stringify(priorGenerations),
        opts.sandboxId ?? null,
        sessionId,
      );
      doState!.storage.sql.exec("UPDATE session SET installation_id = ? WHERE session_id = ?", 42, sessionId);
    }

    async function markConsumed(
      sessionNs: DurableNamespace,
      sessionId: string,
      sandboxId: string,
      token: string,
    ): Promise<void> {
      const doState = sessionNs._states.get(sessionId);
      expect(doState).toBeDefined();
      await doState!.storage.put(`sandbox_one_time_auth:${sessionId}:${sandboxId}:${await sha256Hex(token)}`, 1);
    }

    it("accepts the previous token within the grace window", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-grace-within");
      await seedRotatedTokens(sessionNs, "s-grace-within", {
        currentToken: "new-token",
        prevToken: "old-token",
        prevExpiresAt: Date.now() + 60_000,
      });

      // Auth passes via the previous token, so the route reaches token generation
      // (no GitHub App configured in the test env -> 500), not a 403.
      const res = await workerFetch(workerModule, env, "/api/sessions/s-grace-within/clone-token", {
        headers: { authorization: "Bearer old-token" },
      });
      expect(res.status).not.toBe(403);
      const body = await res.json();
      expect(body.error).toContain("GitHub App not configured");
    });

    it("accepts a 2-generations-old token while it is still in the overlap window", async () => {
      // A reconnect storm rolls the token several times before the bridge adopts
      // the newest; an in-flight REST call against a 2-generations-old token must
      // still authenticate (the multi-generation 403 fix).
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-grace-multi-gen");
      await seedRotatedTokens(sessionNs, "s-grace-multi-gen", {
        currentToken: "gen3-token",
        prevToken: null,
        prevExpiresAt: null,
        priorTokens: [
          { token: "gen2-token", expiresAt: Date.now() + 60_000 },
          { token: "gen1-token", expiresAt: Date.now() + 60_000 },
        ],
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-grace-multi-gen/clone-token", {
        headers: { authorization: "Bearer gen1-token" },
      });
      expect(res.status).not.toBe(403);
      const body = await res.json();
      expect(body.error).toContain("GitHub App not configured");
    });

    it("rejects a prior-generation token that has aged out while a newer one is still valid", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-grace-partial-expiry");
      await seedRotatedTokens(sessionNs, "s-grace-partial-expiry", {
        currentToken: "gen3-token",
        prevToken: null,
        prevExpiresAt: null,
        priorTokens: [
          { token: "gen2-token", expiresAt: Date.now() + 60_000 },
          { token: "gen1-token", expiresAt: Date.now() - 1 }, // aged out
        ],
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-grace-partial-expiry/clone-token", {
        headers: { authorization: "Bearer gen1-token" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("Invalid sandbox auth token");
    });

    it("rejects the previous token after the window expires", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-grace-expired");
      await seedRotatedTokens(sessionNs, "s-grace-expired", {
        currentToken: "new-token",
        prevToken: "old-token",
        prevExpiresAt: Date.now() - 1,
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-grace-expired/clone-token", {
        headers: { authorization: "Bearer old-token" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("Invalid sandbox auth token");
    });

    it("rejects an unknown token even with a live previous token", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-grace-unknown");
      await seedRotatedTokens(sessionNs, "s-grace-unknown", {
        currentToken: "new-token",
        prevToken: "old-token",
        prevExpiresAt: Date.now() + 60_000,
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-grace-unknown/clone-token", {
        headers: { authorization: "Bearer not-a-real-token" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("Invalid sandbox auth token");
    });

    it("accepts the previous token even though it was consumed as a one-time token", async () => {
      // The token a reconnected bridge holds is, by construction, consumed by the
      // WS-upgrade exchange. The prev-grace path must accept it for REST anyway.
      // Routed through github-token because it forwards the sandboxId query param
      // to the DO, so the consumed marker is genuinely checked (and prev wins).
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-grace-consumed-prev");
      await seedRotatedTokens(sessionNs, "s-grace-consumed-prev", {
        currentToken: "new-token",
        prevToken: "old-token",
        prevExpiresAt: Date.now() + 60_000,
        sandboxId: "sbx-grace",
      });
      await markConsumed(sessionNs, "s-grace-consumed-prev", "sbx-grace", "old-token");

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-grace-consumed-prev/github-token?source=installation&sandboxId=sbx-grace",
        { headers: { authorization: "Bearer old-token" } },
      );
      // Auth passed via prev despite the consumed marker (would be 403 otherwise).
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("rejects a consumed token that is not the current previous token (replay)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-grace-replay");
      await seedRotatedTokens(sessionNs, "s-grace-replay", {
        currentToken: "new-token",
        prevToken: null,
        prevExpiresAt: null,
        sandboxId: "sbx-replay",
      });
      await markConsumed(sessionNs, "s-grace-replay", "sbx-replay", "stale-token");

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-grace-replay/github-token?source=installation&sandboxId=sbx-replay",
        { headers: { authorization: "Bearer stale-token" } },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("already exchanged");
    });
  });

  // ---- GET /api/sessions/:sessionId/github-token ----

  describe("GET /api/sessions/:sessionId/github-token", () => {
    it("rejects request without sandbox auth token (401)", async () => {
      const { env } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-githubtoken-noauth");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-githubtoken-noauth/github-token");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Missing sandbox auth token");
    });

    it("rejects request with wrong sandbox token (403)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-githubtoken-wrongtoken");
      await seedSandboxToken(sessionNs, "s-githubtoken-wrongtoken", "correct-sandbox-token");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-githubtoken-wrongtoken/github-token", {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Invalid sandbox auth token");
    });

    it("returns a fresh installation token with valid sandbox auth when no user token is available", async () => {
      const { env, db, sessionNs } = createWorkerEnv(workerModule);
      env.GITHUB_APP_ID = "app-id";
      env.GITHUB_PRIVATE_KEY = "private-key";

      await createSession(workerModule, env, "s-githubtoken-valid");
      db.noGithubTokenUserIds.add(1001);
      await seedSandboxToken(sessionNs, "s-githubtoken-valid", "sandbox-token");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-githubtoken-valid/github-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: true,
        token: "ghs_install_token",
        source: "installation",
      });
    });

    it("mints a READ-ONLY single-repo scope for the agent gh (no write scope)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      env.GITHUB_APP_ID = "app-id";
      env.GITHUB_PRIVATE_KEY = "private-key";

      await createSession(workerModule, env, "s-githubtoken-readonly");
      await seedSandboxToken(sessionNs, "s-githubtoken-readonly", "sandbox-token");

      mockScopedTokenMint.mockClear();
      const res = await workerFetch(workerModule, env, "/api/sessions/s-githubtoken-readonly/github-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });
      expect(res.status).toBe(200);

      // The agent's gh token lands in a file the untrusted agent can read, so the scope
      // must be read-only: contents:read (never write) and no write scope of any kind.
      // A write-scoped token here would let a prompt-injection foothold exfiltrate it and
      // push/mutate directly, bypassing the gh wrapper.
      expect(mockScopedTokenMint).toHaveBeenCalledTimes(1);
      const scope = mockScopedTokenMint.mock.calls[0][0] as {
        repositories: string[];
        permissions: Record<string, string>;
      };
      expect(scope.repositories).toHaveLength(1);
      expect(scope.permissions.contents).toBe("read");
      expect(Object.values(scope.permissions)).not.toContain("write");
    });

    it("falls back to an installation token when user token refresh fails", async () => {
      const { env, db, sessionNs } = createWorkerEnv(workerModule);
      env.GITHUB_APP_ID = "app-id";
      env.GITHUB_PRIVATE_KEY = "private-key";

      await createSession(workerModule, env, "s-githubtoken-user-refresh-fails");
      db.throwGithubTokenUserIds.add(1001);
      await seedSandboxToken(sessionNs, "s-githubtoken-user-refresh-fails", "sandbox-token");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-githubtoken-user-refresh-fails/github-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: true,
        token: "ghs_install_token",
        source: "installation",
      });
    });

    it("rejects token generation after the sandbox is stopped", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      env.GITHUB_APP_ID = "app-id";
      env.GITHUB_PRIVATE_KEY = "private-key";

      await createSession(workerModule, env, "s-githubtoken-stopped");
      await seedSandboxToken(sessionNs, "s-githubtoken-stopped", "sandbox-token", "stopped");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-githubtoken-stopped/github-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Sandbox not active");
    });

    it("never returns the user GitHub token to the sandbox (mints a repo-scoped installation token instead)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      env.GITHUB_APP_ID = "app-id";
      env.GITHUB_PRIVATE_KEY = "private-key";

      // The session owner has a valid user OAuth token (ghp_test), but the sandbox
      // must never receive it: PRs are opened server-side as the user, so the gh
      // shim only ever gets a repo-scoped installation token. This caps a
      // prompt-injection foothold to a single-repo credential.
      await createSession(workerModule, env, "s-githubtoken-user");
      await seedSandboxToken(sessionNs, "s-githubtoken-user", "sandbox-token");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-githubtoken-user/github-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: true,
        token: "ghs_install_token",
        source: "installation",
      });
      expect(body.token).not.toBe("ghp_test");
      expect(body.source).not.toBe("user");
    });

    it("fails closed with 400 when the session has no repo to scope the token to", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      env.GITHUB_APP_ID = "app-id";
      env.GITHUB_PRIVATE_KEY = "private-key";

      await createSession(workerModule, env, "s-githubtoken-norepo");
      await seedSandboxToken(sessionNs, "s-githubtoken-norepo", "sandbox-token");
      // Clear the repo so the scoped-token path cannot resolve a repository to scope
      // to. The token must NOT be minted installation-wide as a fallback.
      const doState = sessionNs._states.get("s-githubtoken-norepo");
      expect(doState).toBeDefined();
      doState!.storage.sql.exec(
        "UPDATE session SET installation_id = ?, repo_name = NULL WHERE session_id = ?",
        42,
        "s-githubtoken-norepo",
      );

      const res = await workerFetch(workerModule, env, "/api/sessions/s-githubtoken-norepo/github-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No repo for session");
    });

    it("returns an installation token even when the sandbox explicitly requests installation auth (source param is a no-op)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      env.GITHUB_APP_ID = "app-id";
      env.GITHUB_PRIVATE_KEY = "private-key";

      await createSession(workerModule, env, "s-githubtoken-installation");
      await seedSandboxToken(sessionNs, "s-githubtoken-installation", "sandbox-token");

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-githubtoken-installation/github-token?source=installation",
        {
          headers: { authorization: "Bearer sandbox-token" },
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: true,
        token: "ghs_install_token",
        source: "installation",
      });
    });
  });

  // ---- GET /api/sessions/:sessionId/cli-auth-token ----

  describe("GET /api/sessions/:sessionId/cli-auth-token", () => {
    it("rejects request with wrong sandbox token (403)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-cli-auth-wrongtoken");
      await seedSandboxToken(sessionNs, "s-cli-auth-wrongtoken", "correct-sandbox-token", "spawning");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-cli-auth-wrongtoken/cli-auth-token", {
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Invalid sandbox auth token");
    });

    it("rejects valid sandbox auth without minting an owner user auth token", async () => {
      const { env, db, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-cli-auth-valid");
      await seedSandboxToken(sessionNs, "s-cli-auth-valid", "sandbox-token", "spawning");
      const authTokenCountBefore = db.authTokens.size;

      const res = await workerFetch(workerModule, env, "/api/sessions/s-cli-auth-valid/cli-auth-token", {
        headers: { authorization: "Bearer sandbox-token" },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toMatchObject({
        ok: false,
        error: "CLI auth token minting is disabled",
      });
      expect(body.token).toBeUndefined();
      expect(body.expiresInMs).toBeUndefined();
      expect(db.authTokens.size).toBe(authTokenCountBefore);
    });

    it("does not allow sandbox credentials to create sibling sessions through ordinary auth routes", async () => {
      const { env, db, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-cli-auth-escalation-parent");
      await seedSandboxToken(sessionNs, "s-cli-auth-escalation-parent", "sandbox-token", "spawning");
      const authTokenCountBefore = db.authTokens.size;

      const mintRes = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-cli-auth-escalation-parent/cli-auth-token",
        {
          headers: { authorization: "Bearer sandbox-token" },
        },
      );
      expect(mintRes.status).toBe(403);
      const mintBody = await mintRes.json();
      expect(mintBody.token).toBeUndefined();
      expect(db.authTokens.size).toBe(authTokenCountBefore);

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          authorization: "Bearer sandbox-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ repoUrl: "https://github.com/test-owner/test-repo" }),
      });
      expect(createRes.status).toBe(401);
      await expect(createRes.json()).resolves.toMatchObject({
        ok: false,
        error: "Unauthorized",
      });
    });
  });

  describe("POST /api/sessions/:sessionId/sandbox/child-sessions", () => {
    it("requires the parent sandbox binding", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-child-auth");
      await seedSandboxToken(sessionNs, "s-child-auth", "sandbox-token");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-child-auth/sandbox/child-sessions", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
        body: JSON.stringify({ prompt: "go", repositoryId: "test-owner/test-repo" }),
      });
      expect(res.status).toBe(403);
    });

    it("rejects verifier sandboxes before parsing or creating a child", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-child-verifier");
      await seedSandboxToken(sessionNs, "s-child-verifier", "sandbox-token");
      sessionNs._states
        .get("s-child-verifier")!
        .storage.sql.exec("UPDATE session SET agent_role = ? WHERE session_id = ?", "verification", "s-child-verifier");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-child-verifier/sandbox/child-sessions", {
        method: "POST",
        headers: { authorization: "Bearer sandbox-token", "content-type": "application/json" },
        body: JSON.stringify({ qa: true }),
      });
      expect(res.status).toBe(403);
    });

    it("strictly rejects fields that are not part of the sandbox contract", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-child-schema");
      await seedSandboxToken(sessionNs, "s-child-schema", "sandbox-token");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-child-schema/sandbox/child-sessions", {
        method: "POST",
        headers: { authorization: "Bearer sandbox-token", "content-type": "application/json" },
        body: JSON.stringify({ prompt: "go", repositoryId: "test-owner/test-repo", qa: true }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/sessions/:sessionId/slack/search-messages", () => {
    it("rejects Slack tool calls after the sandbox is stopped", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-slack-tool-stopped");
      await seedSandboxToken(sessionNs, "s-slack-tool-stopped", "sandbox-token", "stopped");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-slack-tool-stopped/slack/search-messages", {
        method: "POST",
        headers: {
          authorization: "Bearer sandbox-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "deploy" }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Sandbox not active");
    });
  });

  describe("POST /api/sessions/:sessionId/slack/get-thread", () => {
    it("rejects Slack get-thread calls after the sandbox is stopped", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-slack-get-thread-stopped");
      await seedSandboxToken(sessionNs, "s-slack-get-thread-stopped", "sandbox-token", "stopped");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-slack-get-thread-stopped/slack/get-thread", {
        method: "POST",
        headers: {
          authorization: "Bearer sandbox-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ channel: "C123", ts: "1710000000.000100" }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Sandbox not active");
    });
  });

  describe("POST /api/sessions/:sessionId/slack/send-message", () => {
    it("rejects Slack send-message calls after the sandbox is stopped", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-slack-send-message-stopped");
      await seedSandboxToken(sessionNs, "s-slack-send-message-stopped", "sandbox-token", "stopped");

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-slack-send-message-stopped/slack/send-message",
        {
          method: "POST",
          headers: {
            authorization: "Bearer sandbox-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ channel: "C123", text: "hello from test" }),
        },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Sandbox not active");
    });
  });

  describe("POST /api/sessions/:sessionId/integration-lifecycle", () => {
    it("forwards sandbox lifecycle callbacks through the session durable object", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-integration-lifecycle");
      await seedSandboxToken(sessionNs, "s-integration-lifecycle", "sandbox-token");

      const requestCountBefore = sessionNs._requests.length;
      const res = await workerFetch(workerModule, env, "/api/sessions/s-integration-lifecycle/integration-lifecycle", {
        method: "POST",
        headers: {
          authorization: "Bearer sandbox-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          integrationId: "slack",
          stage: "runtime_attached",
          status: "passed",
          message: "Slack runtime attached in the sandbox bridge.",
          details: { provider: "slack", requestId: "req-1" },
        }),
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true, recorded: true });

      const newRequests = sessionNs._requests.slice(requestCountBefore);
      expect(newRequests.map((request) => request.url)).toEqual(["https://internal/session/integration-lifecycle"]);
      expect(newRequests[0].headers.authorization).toBe("Bearer sandbox-token");
    });

    it("rejects unknown lifecycle reason codes from the sandbox", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-integration-lifecycle-invalid-reason");
      await seedSandboxToken(sessionNs, "s-integration-lifecycle-invalid-reason", "sandbox-token");

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-integration-lifecycle-invalid-reason/integration-lifecycle",
        {
          method: "POST",
          headers: {
            authorization: "Bearer sandbox-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            integrationId: "slack",
            stage: "first_tool_call_passed",
            status: "failed",
            reasonCode: "not_a_real_reason",
            message: "Slack tool call failed.",
          }),
        },
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "Invalid integration lifecycle payload" });
    });
  });

  describe("POST /api/sessions/:sessionId/review-loop/reply", () => {
    it("forwards sandbox review-loop reply calls through the session durable object", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-review-loop-reply");
      await seedSandboxToken(sessionNs, "s-review-loop-reply", "sandbox-token");

      const requestCountBefore = sessionNs._requests.length;
      const res = await workerFetch(workerModule, env, "/api/sessions/s-review-loop-reply/review-loop/reply", {
        method: "POST",
        headers: {
          authorization: "Bearer sandbox-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "Invalid review-loop reply payload" });

      const newRequests = sessionNs._requests.slice(requestCountBefore);
      expect(newRequests.map((request) => request.url)).toEqual(["https://internal/session/review-loop/reply"]);
      expect(newRequests[0].headers.authorization).toBe("Bearer sandbox-token");
    });

    it("rejects review-loop reply calls after the sandbox is stopped", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      await createSession(workerModule, env, "s-review-loop-reply-stopped");
      await seedSandboxToken(sessionNs, "s-review-loop-reply-stopped", "sandbox-token", "stopped");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-review-loop-reply-stopped/review-loop/reply", {
        method: "POST",
        headers: {
          authorization: "Bearer sandbox-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          epochId: "epoch-1",
          targetSourceId: "review-comment:1",
          verdict: "fixed",
          body: "Ack",
        }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Sandbox not active");
    });
  });

  describe("POST /api/sessions/:sessionId/review-loop/summary-comment", () => {
    it("rejects review-loop summary-comment calls without a bridge token (401)", async () => {
      const { env } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-summary-comment-noauth");

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-summary-comment-noauth/review-loop/summary-comment",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ epochId: "ep-1", headSha: "sha", body: "summary" }),
        },
      );
      expect(res.status).toBe(401);
    });

    it("forwards sandbox review-loop summary-comment calls through the session durable object", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-summary-comment-fwd");
      await seedSandboxToken(sessionNs, "s-summary-comment-fwd", "sandbox-token-summary");

      const requestCountBefore = sessionNs._requests.length;
      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-summary-comment-fwd/review-loop/summary-comment",
        {
          method: "POST",
          headers: {
            authorization: "Bearer sandbox-token-summary",
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      // Empty body → 400 from DO handler
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        error: "Invalid review-loop summary-comment payload",
      });

      const newRequests = sessionNs._requests.slice(requestCountBefore);
      expect(newRequests.map((r) => r.url)).toEqual(["https://internal/session/review-loop/summary-comment"]);
      expect(newRequests[0].headers.authorization).toBe("Bearer sandbox-token-summary");
    });

    it("accepts the tool-shaped payload { epochId, body } (no headSha) and does NOT return 400", async () => {
      // Regression: the bridge tool only sends { epochId, body, promptId? } — no headSha.
      // The DO route must not require headSha; it should reach publishReviewLoopSummaryComment.
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-summary-comment-nohash");
      await seedSandboxToken(sessionNs, "s-summary-comment-nohash", "sandbox-token-nohash");

      mockPublishReviewLoopSummaryComment.mockResolvedValue({ ok: true, githubCommentId: 1 });

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-summary-comment-nohash/review-loop/summary-comment",
        {
          method: "POST",
          headers: {
            authorization: "Bearer sandbox-token-nohash",
            "content-type": "application/json",
          },
          body: JSON.stringify({ epochId: "ep-1", body: "Here is my summary comment." }),
        },
      );

      // Must NOT be 400 — the payload is valid (epochId + body present, headSha is optional)
      expect(res.status).not.toBe(400);
      // publishReviewLoopSummaryComment was reached and called
      expect(mockPublishReviewLoopSummaryComment).toHaveBeenCalledOnce();
      expect(mockPublishReviewLoopSummaryComment).toHaveBeenCalledWith(
        expect.objectContaining({ epochId: "ep-1", body: "Here is my summary comment." }),
      );
      // The mock returned ok:true → DO returns 200 with githubCommentId
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true, githubCommentId: 1 });
    });

    it("rejects summary-comment calls after the sandbox is stopped", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSession(workerModule, env, "s-summary-comment-stopped");
      await seedSandboxToken(sessionNs, "s-summary-comment-stopped", "sandbox-token", "stopped");

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-summary-comment-stopped/review-loop/summary-comment",
        {
          method: "POST",
          headers: {
            authorization: "Bearer sandbox-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ epochId: "ep-1", headSha: "sha", body: "summary" }),
        },
      );
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Sandbox not active");
    });
  });
});
