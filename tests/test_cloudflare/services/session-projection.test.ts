import * as Sentry from "@sentry/cloudflare";
import { describe, expect, it, vi } from "vitest";

const mockReportSwallowedFailure = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
}));

vi.mock("../../../apps/control-plane-worker/src/observability/swallowed-failure", () => ({
  reportSwallowedFailure: (...args: unknown[]) => mockReportSwallowedFailure(...args),
}));

import {
  computeRichStatusProjectionValue,
  scheduleSessionProjectionSync,
  syncRichStatusProjection,
  syncRuntimeBackendProjection,
  syncRuntimeProjection,
  syncRuntimeProjectionChecked,
  syncSessionProjection,
} from "../../../apps/control-plane-worker/src/services/session-projection";
import { buildUpsertSessionIndexStatement } from "../../../apps/control-plane-worker/src/session/db";
import type { Env } from "../../../apps/control-plane-worker/src/types";
import { computePhase, richStatusFromPhase } from "../../../shared/session/phase";

type SessionIndexRow = {
  session_id: string;
  owner_user_id: string;
  business_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  last_event_id: string | null;
  title: string | null;
  rich_status: string | null;
  plan_approval_pending?: number;
  model: string | null;
  reasoning_effort: string | null;
  agent_runtime_backend?: string | null;
  agent_role?: string | null;
  target_pr_url?: string | null;
  snapshot_image_id: string | null;
  installation_id: number | null;
  repo_owner: string | null;
  repo_name: string | null;
  callback_context_json: string | null;
  runtime_provider: string | null;
  runtime_backend: string | null;
  runtime_state: string | null;
  runtime_sandbox_id: string | null;
  runtime_template_id: string | null;
  runtime_state_expires_at: number | null;
  runtime_live_lease_expires_at: number | null;
  runtime_preview_url: string | null;
  runtime_created_at: number | null;
  runtime_last_resumed_at: number | null;
  runtime_last_paused_at: number | null;
  runtime_last_provider_refreshed_at: number | null;
  runtime_provider_ttl_expires_at: number | null;
  initiation_mode: string;
  entrypoint: string | null;
  scheduled_rule_id: string | null;
  rule_name_snapshot: string | null;
  cron_snapshot: string | null;
  review_loop_done_state?: string | null;
  arcanist_done_state?: string | null;
  arcanist_done_outcome?: string | null;
  arcanist_done_reasons_json?: string | null;
  verification_state?: string | null;
  verification_attempt_count?: number | null;
  verification_max_attempts?: number | null;
  publish_status?: string | null;
  publish_stage?: string | null;
  publish_error?: string | null;
  published_branch?: string | null;
  publish_attempt?: number | null;
  publish_sequence?: number | null;
  qa_testing_state?: string | null;
  qa_testing_attempt_count?: number | null;
  qa_testing_max_attempts?: number | null;
};

type ReplayRow = {
  session_id: string;
  last_event_sequence: number;
  last_event_timestamp: string | null;
  updated_at: string | null;
};

type ChildRow = {
  session_id: string;
  parent_session_id: string;
  parent_prompt_id: string;
  spawned_by_user_id: number;
  spawn_depth: number;
  title: string | null;
  status: string;
  rich_status: string | null;
  created_at: string;
  closed_at: string | null;
};

class FakeStatement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeProjectionD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("SELECT business_id FROM session_index WHERE session_id = ?")) {
      const [sessionId] = this.boundValues as [string];
      const existing = this.db.sessionIndex.get(sessionId);
      return existing ? ({ business_id: existing.business_id } as T) : null;
    }
    if (this.query.includes("SELECT business_id FROM users WHERE id = ?")) {
      const [ownerUserId] = this.boundValues as [string];
      const user = this.db.users.get(Number(ownerUserId));
      return user ? ({ business_id: user.business_id } as T) : null;
    }
    if (
      this.query.includes("FROM session_index WHERE session_id = ?") &&
      this.query.includes("AND parent_session_id IS NOT NULL")
    ) {
      const [sessionId] = this.boundValues as [string];
      const error = this.db.childLookupErrors.get(sessionId);
      if (error) throw error;
      return (this.db.childRows.get(sessionId) as T | undefined) ?? null;
    }
    return null;
  }

  async run(): Promise<{ success: true; meta?: { changes: number } }> {
    if (this.query.includes("INSERT INTO session_index")) {
      const values = this.boundValues;
      const sessionId = values[0] as string;
      const ownerUserId = values[1] as string;
      const businessId = values[2] as string | null;
      const status = values[3] as string;
      const createdAt = values[4] as string;
      const updatedAt = values[5] as string;
      const closedAt = values[6] as string | null;
      const lastEventId = values[7] as string | null;
      const title = values[8] as string | null;
      const titleTags = values[9] as string | null;
      const richStatus = values[10] as string | null;
      const model = values[11] as string | null;
      const reasoningEffort = values[12] as string | null;
      const agentRuntimeBackend = values[13] as string | null;
      const agentRole = values[14] as string | null;
      const targetPrUrl = values[15] as string | null;
      const installationId = values[16] as number | null;
      const repoOwner = values[17] as string | null;
      const repoName = values[18] as string | null;
      const callbackContextJson = values[19] as string | null;
      const parentSessionId = values[20] as string | null;
      const parentPromptId = values[21] as string | null;
      const spawnedByUserId = values[22] as number | null;
      const spawnDepth = values[23] as number;
      const initiationMode = values[24] as string;
      const entrypoint = values[25] as string | null;
      const scheduledRuleId = values[26] as string | null;
      const ruleNameSnapshot = values[27] as string | null;
      const cronSnapshot = values[28] as string | null;
      const existing = this.db.sessionIndex.get(sessionId);
      const resolvedBusinessId =
        existing?.business_id ?? businessId ?? this.db.users.get(Number(ownerUserId))?.business_id ?? null;
      this.db.sessionIndex.set(sessionId, {
        session_id: sessionId,
        owner_user_id: ownerUserId,
        business_id: resolvedBusinessId,
        status,
        created_at: createdAt,
        updated_at: updatedAt,
        closed_at: closedAt,
        last_event_id: lastEventId,
        title,
        rich_status: richStatus ?? existing?.rich_status ?? null,
        model: model ?? existing?.model ?? null,
        reasoning_effort: reasoningEffort ?? existing?.reasoning_effort ?? null,
        agent_runtime_backend: agentRuntimeBackend ?? existing?.agent_runtime_backend ?? null,
        agent_role: agentRole,
        target_pr_url: targetPrUrl,
        snapshot_image_id: existing?.snapshot_image_id ?? null,
        installation_id: installationId ?? existing?.installation_id ?? null,
        repo_owner: repoOwner ?? existing?.repo_owner ?? null,
        repo_name: repoName ?? existing?.repo_name ?? null,
        callback_context_json: callbackContextJson ?? existing?.callback_context_json ?? null,
        parent_session_id: parentSessionId ?? existing?.parent_session_id ?? null,
        parent_prompt_id: parentPromptId ?? existing?.parent_prompt_id ?? null,
        spawned_by_user_id: spawnedByUserId ?? existing?.spawned_by_user_id ?? null,
        spawn_depth: spawnDepth > 0 ? spawnDepth : (existing?.spawn_depth ?? 0),
        runtime_provider: existing?.runtime_provider ?? null,
        runtime_backend: existing?.runtime_backend ?? null,
        runtime_state: existing?.runtime_state ?? null,
        runtime_sandbox_id: existing?.runtime_sandbox_id ?? null,
        runtime_template_id: existing?.runtime_template_id ?? null,
        runtime_state_expires_at: existing?.runtime_state_expires_at ?? null,
        runtime_live_lease_expires_at: existing?.runtime_live_lease_expires_at ?? null,
        runtime_preview_url: existing?.runtime_preview_url ?? null,
        runtime_created_at: existing?.runtime_created_at ?? null,
        runtime_last_resumed_at: existing?.runtime_last_resumed_at ?? null,
        runtime_last_paused_at: existing?.runtime_last_paused_at ?? null,
        runtime_last_provider_refreshed_at: existing?.runtime_last_provider_refreshed_at ?? null,
        runtime_provider_ttl_expires_at: existing?.runtime_provider_ttl_expires_at ?? null,
        // initiation_mode / snapshots: INSERT-only at create, COALESCE-preserved on conflict.
        initiation_mode: existing?.initiation_mode ?? initiationMode,
        entrypoint: existing?.entrypoint ?? entrypoint,
        scheduled_rule_id: existing?.scheduled_rule_id ?? scheduledRuleId,
        rule_name_snapshot: existing?.rule_name_snapshot ?? ruleNameSnapshot,
        cron_snapshot: existing?.cron_snapshot ?? cronSnapshot,
      });
      return { success: true };
    }

    if (this.query.includes("INSERT INTO durable_event_replay_metadata")) {
      const [sessionId, lastEventSequence, lastEventTimestamp, updatedAt] = this.boundValues as [
        string,
        number,
        string | null,
        string | null,
      ];
      this.db.replayMetadata.set(sessionId, {
        session_id: sessionId,
        last_event_sequence: lastEventSequence,
        last_event_timestamp: lastEventTimestamp,
        updated_at: updatedAt,
      });
      return { success: true };
    }

    if (this.query.includes("UPDATE session_index SET rich_status")) {
      const hasPlanApprovalProjection = this.query.includes("plan_approval_pending");
      const richStatus = this.boundValues[0] as string;
      const planApprovalPending = hasPlanApprovalProjection ? (this.boundValues[1] as number) : undefined;
      const sessionId = this.boundValues[hasPlanApprovalProjection ? 2 : 1] as string;
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) {
        existing.rich_status = richStatus;
        if (planApprovalPending !== undefined) existing.plan_approval_pending = planApprovalPending;
        if (this.query.includes("status = 'archived'")) {
          existing.status = "archived";
        }
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE session_index SET review_loop_done_state")) {
      const [doneState, sessionId] = this.boundValues as [string | null, string];
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) existing.review_loop_done_state = doneState;
      return { success: true };
    }

    if (this.query.includes("UPDATE session_index") && this.query.includes("arcanist_done_state")) {
      const [state, outcome, reasonsJson, sessionId] = this.boundValues as [string, string | null, string, string];
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) {
        existing.arcanist_done_state = state;
        existing.arcanist_done_outcome = outcome;
        existing.arcanist_done_reasons_json = reasonsJson;
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE session_index") && this.query.includes("qa_testing_state")) {
      const [state, attemptCount, maxAttempts, sessionId] = this.boundValues as [string | null, number, number, string];
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) {
        existing.qa_testing_state = state;
        existing.qa_testing_attempt_count = attemptCount;
        existing.qa_testing_max_attempts = maxAttempts;
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE session_index") && this.query.includes("publish_status")) {
      const [
        publishStatus,
        hasPublishStage,
        publishStage,
        hasPublishError,
        publishError,
        hasPublishedBranch,
        publishedBranch,
        publishAttempt,
        publishSequence,
        sessionId,
      ] = this.boundValues as [
        string | null,
        number,
        string | null,
        number,
        string | null,
        number,
        string | null,
        number | null,
        number | null,
        string,
      ];
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) {
        existing.publish_status = publishStatus ?? existing.publish_status ?? null;
        if (hasPublishStage) existing.publish_stage = publishStage;
        if (hasPublishError) existing.publish_error = publishError;
        if (hasPublishedBranch) existing.published_branch = publishedBranch;
        existing.publish_attempt = publishAttempt ?? existing.publish_attempt ?? null;
        existing.publish_sequence = publishSequence ?? existing.publish_sequence ?? null;
      }
      return { success: true, meta: { changes: existing ? 1 : 0 } };
    }

    if (this.query.includes("UPDATE session_index SET snapshot_image_id")) {
      const [snapshotImageId, sessionId] = this.boundValues as [string | null, string];
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) existing.snapshot_image_id = snapshotImageId;
      return { success: true, meta: { changes: existing ? 1 : 0 } };
    }

    if (this.query.includes("UPDATE session_index SET runtime_backend")) {
      const [runtimeBackend, sessionId] = this.boundValues as [string | null, string];
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) existing.runtime_backend = runtimeBackend ?? existing.runtime_backend;
      return { success: true, meta: { changes: existing ? 1 : 0 } };
    }

    if (this.query.includes("UPDATE session_index") && this.query.includes("runtime_provider")) {
      const [
        runtimeProvider,
        runtimeBackend,
        runtimeState,
        runtimeSandboxId,
        runtimeTemplateId,
        runtimeStateExpiresAt,
        runtimeLiveLeaseExpiresAt,
        runtimePreviewUrl,
        runtimeCreatedAt,
        runtimeLastResumedAt,
        runtimeLastPausedAt,
        runtimeLastProviderRefreshedAt,
        runtimeProviderTtlExpiresAt,
        sessionId,
      ] = this.boundValues as [
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        string | null,
        number | null,
        number | null,
        number | null,
        number | null,
        number | null,
        string,
      ];
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) {
        existing.runtime_provider = runtimeProvider;
        existing.runtime_backend = runtimeBackend;
        existing.runtime_state = runtimeState;
        existing.runtime_sandbox_id = runtimeSandboxId;
        existing.runtime_template_id = runtimeTemplateId;
        existing.runtime_state_expires_at = runtimeStateExpiresAt;
        existing.runtime_live_lease_expires_at = runtimeLiveLeaseExpiresAt;
        existing.runtime_preview_url = runtimePreviewUrl;
        existing.runtime_created_at = runtimeCreatedAt;
        existing.runtime_last_resumed_at = runtimeLastResumedAt;
        existing.runtime_last_paused_at = runtimeLastPausedAt;
        existing.runtime_last_provider_refreshed_at = runtimeLastProviderRefreshedAt;
        existing.runtime_provider_ttl_expires_at = runtimeProviderTtlExpiresAt;
      }
      // Model real D1 row-match semantics so the zero-row repair path is testable.
      return { success: true, meta: { changes: existing ? 1 : 0 } };
    }

    if (this.query.includes("UPDATE child_session_limit_reservations")) {
      const [_nowMs, sessionId] = this.boundValues as [number, string];
      this.db.concurrentReleaseCalls.push(sessionId);
      return { success: true };
    }

    throw new Error(`Unhandled query: ${this.query}`);
  }
}

class FakeProjectionD1 {
  readonly preparedQueries: string[] = [];
  readonly sessionIndex = new Map<string, SessionIndexRow>();
  readonly replayMetadata = new Map<string, ReplayRow>();
  readonly childRows = new Map<string, ChildRow>();
  readonly childLookupErrors = new Map<string, Error>();
  readonly concurrentReleaseCalls: string[] = [];
  readonly users = new Map<number, { business_id: string | null }>();

  prepare(query: string): FakeStatement {
    this.preparedQueries.push(query);
    return new FakeStatement(this, query);
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function buildSessionState() {
  return {
    sessionId: "session-1",
    ownerUserId: "42",
    businessId: "biz-1",
    status: "active" as const,
    createdAt: "2026-04-08T00:00:00.000Z",
    updatedAt: "2026-04-08T00:00:01.000Z",
    closedAt: null,
    lastEventId: "event-1",
    title: "Projection test",
    model: "gpt-5.4",
    reasoningEffort: "medium",
    agentRuntimeBackend: "codex" as const,
    installationId: 123,
    repoOwner: "acme",
    repoName: "widget",
    agentRole: "verification" as const,
    targetPrUrl: "https://github.com/acme/widget/pull/42",
  };
}

function buildReplayState() {
  return {
    sessionId: "session-1",
    lastEventSequence: 7,
    lastEventTimestamp: "2026-04-08T00:00:01.000Z",
    updatedAt: "2026-04-08T00:00:01.000Z",
  };
}

function countTopLevelSqlValues(expression: string): number {
  let depth = 0;
  let count = 1;
  for (const ch of expression) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) count += 1;
  }
  return count;
}

describe("services/session-projection", () => {
  describe("computeRichStatusProjectionValue", () => {
    it("passes through legacy rich_status when no FSM display projection exists", () => {
      expect(computeRichStatusProjectionValue("running", null)).toBe("running");
      expect(computeRichStatusProjectionValue(null, null)).toBeNull();
      expect(computeRichStatusProjectionValue(undefined, null)).toBeNull();
    });

    it("prefers the FSM display projection when present", () => {
      expect(computeRichStatusProjectionValue("running", { richStatus: "completed" } as const)).toBe("completed");
    });
  });

  it("keeps the session_index upsert values aligned with its columns", async () => {
    const db = new FakeProjectionD1();

    await buildUpsertSessionIndexStatement(db as unknown as D1Database, buildSessionState(), "idle");

    const upsertQuery = db.preparedQueries.find((query) => query.includes("INSERT INTO session_index"));
    expect(upsertQuery).toBeTruthy();

    // buildInsertValuesSql emits a single VALUES tuple, so a lazy match is sufficient here.
    const match = upsertQuery!.match(/session_index \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)\s*ON CONFLICT/);
    expect(match).toBeTruthy();

    const columns = match![1]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const valuesCount = countTopLevelSqlValues(match![2]);
    expect(valuesCount).toBe(columns.length);
  });

  it("syncs session index and replay metadata together", async () => {
    const db = new FakeProjectionD1();

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: buildSessionState(),
      replay: buildReplayState(),
      richStatus: "idle",
    });

    expect(db.sessionIndex.get("session-1")).toMatchObject({
      status: "active",
      rich_status: "idle",
      model: "gpt-5.4",
      reasoning_effort: "medium",
      agent_runtime_backend: "codex",
      agent_role: "verification",
      target_pr_url: "https://github.com/acme/widget/pull/42",
      installation_id: 123,
      repo_owner: "acme",
      repo_name: "widget",
    });
    expect(db.replayMetadata.get("session-1")).toMatchObject({
      last_event_sequence: 7,
      last_event_timestamp: "2026-04-08T00:00:01.000Z",
    });
  });

  it("promotes rich-status-only archived syncs to archived list status", async () => {
    const db = new FakeProjectionD1();
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: buildSessionState(),
      richStatus: "idle",
    });

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      richStatus: "archived",
    });

    expect(db.sessionIndex.get("session-1")).toMatchObject({
      status: "archived",
      rich_status: "archived",
    });
  });

  it("resolves missing session business ids from the owner user snapshot", async () => {
    const db = new FakeProjectionD1();
    db.users.set(42, { business_id: "biz-from-user" });

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: {
        ...buildSessionState(),
        businessId: null,
      },
    });

    expect(db.sessionIndex.get("session-1")?.business_id).toBe("biz-from-user");
  });

  it("reuses the indexed business id when legacy session snapshots and owner rows are both missing", async () => {
    const db = new FakeProjectionD1();
    db.sessionIndex.set("session-1", {
      session_id: "session-1",
      owner_user_id: "42",
      business_id: "biz-existing",
      status: "active",
      created_at: "2026-04-08T00:00:00.000Z",
      updated_at: "2026-04-08T00:00:00.000Z",
      closed_at: null,
      last_event_id: "event-0",
      title: "Existing row",
      rich_status: null,
      model: null,
      reasoning_effort: null,
      snapshot_image_id: null,
      installation_id: null,
      repo_owner: null,
      repo_name: null,
      runtime_provider: null,
      runtime_backend: null,
      runtime_state: null,
      runtime_sandbox_id: null,
      runtime_template_id: null,
      runtime_state_expires_at: null,
      runtime_live_lease_expires_at: null,
      runtime_preview_url: null,
      runtime_created_at: null,
      runtime_last_resumed_at: null,
      runtime_last_paused_at: null,
      runtime_last_provider_refreshed_at: null,
      runtime_provider_ttl_expires_at: null,
      initiation_mode: "user",
      scheduled_rule_id: null,
      rule_name_snapshot: null,
      cron_snapshot: null,
    });

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: {
        ...buildSessionState(),
        businessId: null,
        updatedAt: "2026-04-08T00:00:02.000Z",
      },
    });

    expect(db.sessionIndex.get("session-1")?.business_id).toBe("biz-existing");
  });

  it("throws a named error when session business ownership cannot be resolved", async () => {
    const db = new FakeProjectionD1();

    await expect(
      syncSessionProjection({
        db: db as unknown as D1Database,
        sessionId: "session-1",
        session: {
          ...buildSessionState(),
          businessId: null,
        },
      }),
    ).rejects.toMatchObject({
      name: "MissingBusinessIdError",
      message: expect.stringContaining("session_index upsert"),
    });
  });

  it("updates snapshot image projection through the shared service", async () => {
    const db = new FakeProjectionD1();
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: buildSessionState(),
    });

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      snapshotImageId: "img_123",
    });

    expect(db.sessionIndex.get("session-1")?.snapshot_image_id).toBe("img_123");
  });

  it("updates runtime projection through the explicit runtime writer", async () => {
    mockReportSwallowedFailure.mockClear();
    const db = new FakeProjectionD1();
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: buildSessionState(),
    });

    await syncRuntimeProjection(
      { DB: db as unknown as D1Database } as Parameters<typeof syncRuntimeProjection>[0],
      "session-1",
      {
        runtimeProvider: "e2b",
        runtimeState: "running",
        runtimeSandboxId: "e2b-sb-1",
        runtimeTemplateId: "cycloid-sandbox-dev-test",
        runtimeStateExpiresAt: 1_762_000_000_000,
        runtimeLiveLeaseExpiresAt: 1_762_001_000_000,
        runtimePreviewUrl: "https://preview.example",
        runtimeCreatedAt: 1_761_999_000_000,
        runtimeLastResumedAt: 1_762_000_100_000,
        runtimeLastProviderRefreshedAt: 1_762_000_200_000,
        runtimeProviderTtlExpiresAt: 1_762_003_600_000,
      },
    );

    expect(db.sessionIndex.get("session-1")).toMatchObject({
      runtime_provider: "e2b",
      runtime_state: "running",
      runtime_sandbox_id: "e2b-sb-1",
      runtime_template_id: "cycloid-sandbox-dev-test",
      runtime_state_expires_at: null,
      runtime_live_lease_expires_at: 1_762_001_000_000,
      runtime_preview_url: "https://preview.example",
      runtime_created_at: 1_761_999_000_000,
      runtime_last_resumed_at: 1_762_000_100_000,
      runtime_last_provider_refreshed_at: 1_762_000_200_000,
      runtime_provider_ttl_expires_at: 1_762_003_600_000,
    });
    expect(mockReportSwallowedFailure).not.toHaveBeenCalled();
  });

  it("reports expected-existing projection updates that match zero session_index rows", async () => {
    mockReportSwallowedFailure.mockClear();
    const db = new FakeProjectionD1();

    await syncRuntimeProjection(
      {
        DB: db as unknown as D1Database,
        DD_API_KEY: "dd-key",
        WORKER_ENV: "production",
      } as Parameters<typeof syncRuntimeProjection>[0],
      "missing-session",
      {
        runtimeProvider: "e2b",
        runtimeState: "running",
        runtimeSandboxId: "e2b-sb-1",
      },
    );

    expect(mockReportSwallowedFailure).toHaveBeenCalledTimes(1);
    expect(mockReportSwallowedFailure).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "dd-key", WORKER_ENV: "production" }),
      expect.objectContaining({
        surface: "session_projection",
        operation: "updateSessionRuntimeState",
        sessionId: "missing-session",
        reason: "zero_rows",
      }),
    );
  });

  it("reports zero-row runtime backend projection updates", async () => {
    mockReportSwallowedFailure.mockClear();
    const db = new FakeProjectionD1();

    await syncRuntimeBackendProjection(
      {
        DB: db as unknown as D1Database,
        DD_API_KEY: "dd-key",
        WORKER_ENV: "production",
      } as Parameters<typeof syncRuntimeBackendProjection>[0],
      "missing-session",
      "e2b_cloud",
      { attempts: 1 },
    );

    expect(mockReportSwallowedFailure).toHaveBeenCalledTimes(1);
    expect(mockReportSwallowedFailure).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "dd-key", WORKER_ENV: "production" }),
      expect.objectContaining({
        surface: "session_projection",
        operation: "updateSessionRuntimeBackend",
        sessionId: "missing-session",
        reason: "zero_rows",
      }),
    );
  });

  it("reports zero-row snapshot image projection updates", async () => {
    mockReportSwallowedFailure.mockClear();
    const db = new FakeProjectionD1();

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "missing-session",
      snapshotImageId: "img_123",
      reportEnv: { DD_API_KEY: "dd-key", WORKER_ENV: "production" },
    });

    expect(mockReportSwallowedFailure).toHaveBeenCalledTimes(1);
    expect(mockReportSwallowedFailure).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "dd-key", WORKER_ENV: "production" }),
      expect.objectContaining({
        surface: "session_projection",
        operation: "updateSessionSnapshotImageId",
        sessionId: "missing-session",
        reason: "zero_rows",
      }),
    );
  });

  it("reports zero-row publish projection updates", async () => {
    mockReportSwallowedFailure.mockClear();
    const db = new FakeProjectionD1();

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "missing-session",
      publishState: { publishStatus: "publishing", publishStage: "creating_pr", publishAttempt: 1 },
      reportEnv: { DD_API_KEY: "dd-key", WORKER_ENV: "production" },
    });

    expect(mockReportSwallowedFailure).toHaveBeenCalledTimes(1);
    expect(mockReportSwallowedFailure).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "dd-key", WORKER_ENV: "production" }),
      expect.objectContaining({
        surface: "session_projection",
        operation: "updateSessionPublishState",
        sessionId: "missing-session",
        reason: "zero_rows",
      }),
    );
  });

  it("does not clear runtime projection during ordinary session projection", async () => {
    const db = new FakeProjectionD1();
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: buildSessionState(),
    });
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      runtimeState: {
        runtimeProvider: "e2b",
        runtimeState: "paused",
        runtimeSandboxId: "e2b-sb-1",
        runtimeStateExpiresAt: 1_762_003_600_000,
      },
    });

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: {
        ...buildSessionState(),
        updatedAt: "2026-04-08T00:00:02.000Z",
      },
    });

    expect(db.sessionIndex.get("session-1")).toMatchObject({
      runtime_provider: "e2b",
      runtime_state: "paused",
      runtime_sandbox_id: "e2b-sb-1",
      runtime_state_expires_at: 1_762_003_600_000,
    });
  });

  it("projects child parent metadata and initiation mode onto the session index row", async () => {
    const db = new FakeProjectionD1();

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "child-1",
      session: {
        ...buildSessionState(),
        sessionId: "child-1",
        initiationMode: "child",
      },
      parentContext: {
        parentSessionId: "parent-1",
        parentPromptId: "prompt-1",
        spawnedByUserId: 42,
        spawnDepth: 1,
      },
    });

    expect(db.sessionIndex.get("child-1")).toMatchObject({
      parent_session_id: "parent-1",
      parent_prompt_id: "prompt-1",
      spawned_by_user_id: 42,
      spawn_depth: 1,
      initiation_mode: "child",
    });
  });

  it("releases concurrent capacity only for archived child session projections", async () => {
    const db = new FakeProjectionD1();
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "parent-1",
      session: {
        ...buildSessionState(),
        sessionId: "parent-1",
        status: "archived",
        closedAt: "2026-04-08T00:00:02.000Z",
      },
    });
    expect(db.concurrentReleaseCalls).toEqual([]);

    db.childRows.set("child-1", {
      session_id: "child-1",
      parent_session_id: "parent-1",
      parent_prompt_id: "prompt-1",
      spawned_by_user_id: 42,
      spawn_depth: 1,
      title: null,
      status: "archived",
      rich_status: "closed",
      created_at: "2026-04-08T00:00:00.000Z",
      closed_at: "2026-04-08T00:00:02.000Z",
    });
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "child-1",
      session: {
        ...buildSessionState(),
        sessionId: "child-1",
        status: "archived",
        closedAt: "2026-04-08T00:00:02.000Z",
      },
    });

    expect(db.concurrentReleaseCalls).toEqual(["child-1"]);
  });

  function seedActiveChildRow(db: FakeProjectionD1, sessionId: string) {
    db.childRows.set(sessionId, {
      session_id: sessionId,
      parent_session_id: "parent-1",
      parent_prompt_id: "prompt-1",
      spawned_by_user_id: 42,
      spawn_depth: 1,
      title: null,
      status: "active",
      rich_status: "running",
      created_at: "2026-04-08T00:00:00.000Z",
      closed_at: null,
    });
  }

  // `stopped` is intentionally NOT in this set: a stopped child is resumable and
  // keeps its slot (see CHILD_SLOT_RELEASE_PHASES). Covered separately below.
  for (const richStatus of ["completed", "failed", "blocked", "archived"] as const) {
    it(`releases concurrent capacity when a child projects terminal rich_status '${richStatus}' with status active`, async () => {
      const db = new FakeProjectionD1();
      seedActiveChildRow(db, "child-term");

      await syncSessionProjection({
        db: db as unknown as D1Database,
        sessionId: "child-term",
        richStatus,
      });

      expect(db.concurrentReleaseCalls).toEqual(["child-term"]);
    });
  }

  it("releases concurrent capacity when FSM display projection supplies terminal rich_status", async () => {
    const db = new FakeProjectionD1();
    seedActiveChildRow(db, "child-fsm-term");

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "child-fsm-term",
      fsmDisplay: { richStatus: "completed", feChip: "completed", uiLifecycleStage: "merge_ready" },
    });

    expect(db.concurrentReleaseCalls).toEqual(["child-fsm-term"]);
  });

  it("does not release concurrent capacity for a resumable 'stopped' child", async () => {
    // A stopped child is resumable: releasing here would let the unarchive path
    // reacquire a slot and then immediately re-free it via the re-projected
    // `stopped` rich_status, undercounting the per-user cap.
    const db = new FakeProjectionD1();
    seedActiveChildRow(db, "child-stopped");

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "child-stopped",
      richStatus: "stopped",
    });

    expect(db.concurrentReleaseCalls).toEqual([]);
  });

  it("releases concurrent capacity when an answered-no-PR child is reaped after completion", async () => {
    const db = new FakeProjectionD1();
    seedActiveChildRow(db, "child-answered-no-pr");
    const phase = computePhase({
      sessionStatus: "active",
      sandboxStatus: "stopped",
      activePromptId: null,
      stopReason: "reaped",
      publishStatus: "not_started",
      mostRecentPromptResultNoChanges: true,
      reviewListeningActive: false,
    });

    expect(phase.phase).toBe("completed");
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "child-answered-no-pr",
      richStatus: richStatusFromPhase(phase),
    });

    expect(db.concurrentReleaseCalls).toEqual(["child-answered-no-pr"]);
  });

  for (const richStatus of ["running", "idle", "waiting_for_input", "finalizing", "review_listening"] as const) {
    it(`does not release concurrent capacity for non-terminal rich_status '${richStatus}'`, async () => {
      const db = new FakeProjectionD1();
      seedActiveChildRow(db, "child-active");

      await syncSessionProjection({
        db: db as unknown as D1Database,
        sessionId: "child-active",
        richStatus,
      });

      expect(db.concurrentReleaseCalls).toEqual([]);
    });
  }

  it("releases concurrent capacity from the lifecycle rich_status writer (syncRichStatusProjection)", async () => {
    // The DO lifecycle path (persistAndBroadcastSessionStatus -> persistRichStatusToD1)
    // settles a child's terminal rich_status through syncRichStatusProjection, not
    // syncSessionProjection. The release must fire on this writer too or the slot leaks.
    const db = new FakeProjectionD1();
    seedActiveChildRow(db, "child-lifecycle");

    await syncRichStatusProjection({
      db: db as unknown as D1Database,
      sessionId: "child-lifecycle",
      richStatus: "completed",
      planApprovalPending: false,
    });

    expect(db.concurrentReleaseCalls).toEqual(["child-lifecycle"]);
  });

  it("does not release from the lifecycle writer for a resumable 'stopped' child", async () => {
    const db = new FakeProjectionD1();
    seedActiveChildRow(db, "child-lifecycle-stopped");

    await syncRichStatusProjection({
      db: db as unknown as D1Database,
      sessionId: "child-lifecycle-stopped",
      richStatus: "stopped",
      planApprovalPending: false,
    });

    expect(db.concurrentReleaseCalls).toEqual([]);
  });

  it("does not release concurrent capacity for a parent row with terminal rich_status", async () => {
    const db = new FakeProjectionD1();
    // No child row seeded -> isChildSession resolves false (parent).
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "parent-term",
      richStatus: "completed",
    });

    expect(db.concurrentReleaseCalls).toEqual([]);
  });

  it("logs child lookup failures during terminal release instead of silently skipping them", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    const db = new FakeProjectionD1();
    db.childLookupErrors.set("child-lookup-fail", new Error("lookup failed"));

    await expect(
      syncSessionProjection({
        db: db as unknown as D1Database,
        sessionId: "child-lookup-fail",
        richStatus: "completed",
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(db.concurrentReleaseCalls).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "child-lookup-fail",
        error: "Error: lookup failed",
      }),
      "Child session terminal concurrency release attempt failed after projection sync",
    );
  });

  it("logs child lookup failures from syncRichStatusProjection instead of silently skipping them", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    const db = new FakeProjectionD1();
    db.childLookupErrors.set("child-lifecycle-lookup-fail", new Error("lookup failed"));

    await expect(
      syncRichStatusProjection({
        db: db as unknown as D1Database,
        sessionId: "child-lifecycle-lookup-fail",
        richStatus: "completed",
        planApprovalPending: false,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(db.concurrentReleaseCalls).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "child-lifecycle-lookup-fail",
        error: "Error: lookup failed",
      }),
      "Child session terminal concurrency release attempt failed after projection sync",
    );
  });

  it("projects the pending-plan mirror with each lifecycle rich_status write", async () => {
    const db = new FakeProjectionD1();
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-plan-projection",
      session: { ...buildSessionState(), sessionId: "session-plan-projection" },
      richStatus: "idle",
    });

    await syncRichStatusProjection({
      db: db as unknown as D1Database,
      sessionId: "session-plan-projection",
      richStatus: "waiting_for_input",
      planApprovalPending: true,
    });
    expect(db.sessionIndex.get("session-plan-projection")).toMatchObject({
      rich_status: "waiting_for_input",
      plan_approval_pending: 1,
    });

    await syncRichStatusProjection({
      db: db as unknown as D1Database,
      sessionId: "session-plan-projection",
      richStatus: "idle",
      planApprovalPending: false,
    });
    expect(db.sessionIndex.get("session-plan-projection")).toMatchObject({
      rich_status: "idle",
      plan_approval_pending: 0,
    });
  });

  it("projects malformed runtime state as null instead of canonical unknown", async () => {
    const db = new FakeProjectionD1();
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: buildSessionState(),
    });

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      runtimeState: {
        runtimeProvider: "e2b",
        runtimeState: "unknown",
        runtimeSandboxId: "e2b-sb-1",
      } as Parameters<typeof syncSessionProjection>[0]["runtimeState"],
    });

    expect(db.sessionIndex.get("session-1")).toMatchObject({
      runtime_provider: "e2b",
      runtime_state: null,
      runtime_sandbox_id: "e2b-sb-1",
    });
  });

  it("logs the attempted operations when projection sync fails", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    const db = {
      prepare: () => ({ bind: () => ({ run: vi.fn() }) }),
      batch: vi.fn().mockRejectedValue(new Error("boom")),
    };

    await expect(
      syncSessionProjection({
        db: db as unknown as D1Database,
        sessionId: "session-1",
        session: buildSessionState(),
        replay: buildReplayState(),
        logger,
        source: "test.failure",
        requestId: "req-1",
        userId: "42",
      }),
    ).rejects.toThrow("boom");

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        operations: ["upsertSessionIndex", "upsertReplayMetadata"],
        source: "test.failure",
        requestId: "req-1",
        userId: "42",
        error: "Error: boom",
      }),
      "Session projection sync failed",
    );
  });

  it("captures scheduled async projection failures with the service-level Sentry tag", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    const waitUntil = vi.fn();
    const db = {
      prepare: () => ({ bind: () => ({ run: vi.fn() }) }),
      batch: vi.fn().mockRejectedValue(new Error("boom")),
    };

    scheduleSessionProjectionSync({
      waitUntil,
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: buildSessionState(),
      replay: buildReplayState(),
      logger,
      source: "test.scheduled-failure",
      requestId: "req-2",
      userId: "42",
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        operations: ["upsertSessionIndex", "upsertReplayMetadata"],
        source: "test.scheduled-failure",
        requestId: "req-2",
        userId: "42",
        error: "Error: boom",
      }),
      "Session projection sync failed",
    );
    expect(logger.error).toHaveBeenCalledWith(
      {
        error: "Error: boom",
        operation: "session-projection-sync",
      },
      "Operation failed",
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { operation: "session-projection-sync" },
    });
  });

  it("round-trips initiation_mode and scheduled rule snapshots through the projection", async () => {
    const db = new FakeProjectionD1();

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: {
        ...buildSessionState(),
        initiationMode: "automation",
        scheduledRuleId: "rule-abc",
        ruleNameSnapshot: "Weekday test sweep",
        cronSnapshot: "0 14 * * 1-5",
      },
      richStatus: "idle",
    });

    expect(db.sessionIndex.get("session-1")).toMatchObject({
      initiation_mode: "automation",
      scheduled_rule_id: "rule-abc",
      rule_name_snapshot: "Weekday test sweep",
      cron_snapshot: "0 14 * * 1-5",
    });
  });

  it("preserves the original initiation_mode and snapshots on subsequent upserts", async () => {
    const db = new FakeProjectionD1();

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: {
        ...buildSessionState(),
        initiationMode: "automation",
        scheduledRuleId: "rule-abc",
        ruleNameSnapshot: "Weekday test sweep",
        cronSnapshot: "0 14 * * 1-5",
      },
    });

    // A later projection write that omits these fields must not erase them.
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: {
        ...buildSessionState(),
        updatedAt: "2026-04-08T00:00:02.000Z",
      },
    });

    expect(db.sessionIndex.get("session-1")).toMatchObject({
      initiation_mode: "automation",
      scheduled_rule_id: "rule-abc",
      rule_name_snapshot: "Weekday test sweep",
      cron_snapshot: "0 14 * * 1-5",
    });
  });

  it("defaults initiation_mode to 'user' and leaves snapshots null when omitted", async () => {
    const db = new FakeProjectionD1();

    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: buildSessionState(),
    });

    expect(db.sessionIndex.get("session-1")).toMatchObject({
      initiation_mode: "user",
      scheduled_rule_id: null,
      rule_name_snapshot: null,
      cron_snapshot: null,
    });
  });

  // ARC-1330 D-59c: the blind `mirror*ToIndex` fns were deleted (`project()` is the sole mirror writer).
  // The real-D1 projection-write behavior (`syncSessionProjection` `fsmMirror`/`fsmDisplay`) is covered by
  // tests/test_cloudflare/session/mirror-confirm-statements.test.ts.
});

describe("syncRuntimeProjectionChecked", () => {
  const RUNTIME = {
    runtimeProvider: "e2b" as const,
    runtimeBackend: "e2b_cloud" as const,
    runtimeState: "running" as const,
    runtimeSandboxId: "e2b-sbx-1",
    runtimeTemplateId: "tmpl",
  };

  function makeLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  }

  async function seedRow(db: FakeProjectionD1) {
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: buildSessionState(),
      richStatus: "idle",
    });
  }

  it("applies on the first attempt when the session_index row exists", async () => {
    const db = new FakeProjectionD1();
    await seedRow(db);

    const outcome = await syncRuntimeProjectionChecked({ DB: db } as unknown as Env, "session-1", RUNTIME, {
      sleep: async () => {},
    });

    expect(outcome).toBe("applied");
    expect(db.sessionIndex.get("session-1")?.runtime_sandbox_id).toBe("e2b-sbx-1");
  });

  it("repairs the projection when the row lands during a retry; never throws", async () => {
    const db = new FakeProjectionD1();
    let slept = 0;
    const sleep = async () => {
      slept += 1;
      // The create-time upsert lands during the first retry delay (the timing
      // race that caused the healthy-VM reaper kill).
      if (slept === 1) await seedRow(db);
    };

    const outcome = await syncRuntimeProjectionChecked({ DB: db } as unknown as Env, "session-1", RUNTIME, {
      sleep,
      logger: makeLogger(),
    });

    expect(outcome).toBe("repaired");
    expect(db.sessionIndex.get("session-1")?.runtime_sandbox_id).toBe("e2b-sbx-1");
  });

  it("returns missing_row and logs loud (never throws) when the row never lands", async () => {
    const db = new FakeProjectionD1();
    const logger = makeLogger();

    const outcome = await syncRuntimeProjectionChecked({ DB: db } as unknown as Env, "session-1", RUNTIME, {
      sleep: async () => {},
      attempts: 2,
      delayMs: 0,
      logger,
    });

    expect(outcome).toBe("missing_row");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "runtime_projection_missing_row", sessionId: "session-1" }),
      expect.any(String),
    );
  });

  it("rethrows a real D1 error (preserves existing failure behavior)", async () => {
    const throwingDb = {
      prepare: () => ({ bind: () => ({ run: async () => Promise.reject(new Error("d1 down")) }) }),
    } as unknown as D1Database;

    await expect(
      syncRuntimeProjectionChecked({ DB: throwingDb } as unknown as Env, "session-1", RUNTIME, {
        sleep: async () => {},
        logger: makeLogger(),
      }),
    ).rejects.toThrow("d1 down");
  });
});

describe("syncRuntimeBackendProjection", () => {
  function makeLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  }

  async function seedRow(db: FakeProjectionD1) {
    await syncSessionProjection({
      db: db as unknown as D1Database,
      sessionId: "session-1",
      session: buildSessionState(),
      richStatus: "idle",
    });
  }

  it("applies on the first attempt when the session_index row exists", async () => {
    const db = new FakeProjectionD1();
    await seedRow(db);

    const outcome = await syncRuntimeBackendProjection({ DB: db } as unknown as Env, "session-1", "e2b_cloud", {
      sleep: async () => {},
    });

    expect(outcome).toBe("applied");
    expect(db.sessionIndex.get("session-1")?.runtime_backend).toBe("e2b_cloud");
  });

  it("repairs the backend projection when the row lands during a retry", async () => {
    const db = new FakeProjectionD1();
    let slept = 0;
    const sleep = async () => {
      slept += 1;
      if (slept === 1) await seedRow(db);
    };

    const outcome = await syncRuntimeBackendProjection({ DB: db } as unknown as Env, "session-1", "e2b_cloud", {
      sleep,
      logger: makeLogger(),
    });

    expect(outcome).toBe("repaired");
    expect(db.sessionIndex.get("session-1")?.runtime_backend).toBe("e2b_cloud");
  });

  it("returns missing_row and reports once when the row never lands", async () => {
    mockReportSwallowedFailure.mockClear();
    const db = new FakeProjectionD1();
    const logger = makeLogger();

    const outcome = await syncRuntimeBackendProjection(
      {
        DB: db as unknown as D1Database,
        DD_API_KEY: "dd-key",
        WORKER_ENV: "production",
      } as unknown as Env,
      "session-1",
      "e2b_cloud",
      {
        sleep: async () => {},
        attempts: 2,
        delayMs: 0,
        logger,
      },
    );

    expect(outcome).toBe("missing_row");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "session_projection.zero_row",
        sessionId: "session-1",
        operation: "updateSessionRuntimeBackend",
      }),
      expect.any(String),
    );
    expect(mockReportSwallowedFailure).toHaveBeenCalledTimes(1);
  });

  it("rethrows a real D1 error", async () => {
    const throwingDb = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => Promise.reject(new Error("d1 down")),
    } as unknown as D1Database;

    await expect(
      syncRuntimeBackendProjection({ DB: throwingDb } as unknown as Env, "session-1", "e2b_cloud", {
        sleep: async () => {},
        logger: makeLogger(),
      }),
    ).rejects.toThrow("d1 down");
  });
});
