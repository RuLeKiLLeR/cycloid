import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import { SESSION_BEARER_INTERNAL_ROUTES } from "../../../apps/control-plane-worker/src/session/internal-routes.ts";
import { createFakeState, createTestEnv, mockCloudflareWorkers, mockSentryCloudflare } from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type SessionIndexProjectionRow = {
  rich_status: string | null;
  ui_lifecycle_stage: string | null;
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
};

class ReprojectD1 {
  constructor(
    readonly row: SessionIndexProjectionRow,
    readonly prCoordinationRow: Record<string, unknown> | null = null,
  ) {}

  prepare(query: string) {
    const db = this;
    const statement = {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        if (query.includes("FROM session_index") && query.includes("parent_session_id IS NOT NULL")) return null;
        if (query.includes("FROM session_index") && query.includes("runtime_provider")) return { ...db.row } as T;
        if (query.includes("FROM pr_coordination")) return db.prCoordinationRow as T;
        return null;
      },
      async run() {
        if (query.includes("UPDATE session_index SET rich_status")) {
          const [richStatus, uiLifecycleStage] = this.values as [string | null, string | null, string];
          db.row.rich_status = richStatus;
          if (query.includes("ui_lifecycle_stage")) db.row.ui_lifecycle_stage = uiLifecycleStage;
          return { success: true, meta: { changes: 1 } };
        }
        if (query.includes("UPDATE session_index") && query.includes("runtime_provider")) {
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
          ] = this.values as [
            string | null,
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
          Object.assign(db.row, {
            runtime_provider: runtimeProvider,
            runtime_backend: runtimeBackend,
            runtime_state: runtimeState,
            runtime_sandbox_id: runtimeSandboxId,
            runtime_template_id: runtimeTemplateId,
            runtime_state_expires_at: runtimeStateExpiresAt,
            runtime_live_lease_expires_at: runtimeLiveLeaseExpiresAt,
            runtime_preview_url: runtimePreviewUrl,
            runtime_created_at: runtimeCreatedAt,
            runtime_last_resumed_at: runtimeLastResumedAt,
            runtime_last_paused_at: runtimeLastPausedAt,
            runtime_last_provider_refreshed_at: runtimeLastProviderRefreshedAt,
            runtime_provider_ttl_expires_at: runtimeProviderTtlExpiresAt,
          });
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

describe("POST /internal/session/reproject", () => {
  let SessionDO: typeof import("../../../apps/control-plane-worker/src/session/durable-object.ts").SessionDO;
  let state: ReturnType<typeof createFakeState>;
  let env: ReturnType<typeof createTestEnv> & { DB: D1Database; SANDBOX_RUNTIME_CLEANUP_SECRET: string };
  let agent: InstanceType<typeof SessionDO>;

  beforeAll(async () => {
    ({ SessionDO } = await import("../../../apps/control-plane-worker/src/session/durable-object.ts"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state = createFakeState();
    env = {
      ...createTestEnv(),
      DB: new ReprojectD1(
        {
          rich_status: null,
          ui_lifecycle_stage: null,
          runtime_provider: "e2b",
          runtime_backend: "e2b_cloud",
          runtime_state: "killed",
          runtime_sandbox_id: "stale-sandbox",
          runtime_template_id: null,
          runtime_state_expires_at: null,
          runtime_live_lease_expires_at: null,
          runtime_preview_url: null,
          runtime_created_at: null,
          runtime_last_resumed_at: null,
          runtime_last_paused_at: null,
          runtime_last_provider_refreshed_at: null,
          runtime_provider_ttl_expires_at: null,
        },
        {
          session_id: "s-1",
          version: 1,
          state: "MERGE_READY",
          pr_url: "https://github.com/acme/repo/pull/1",
          head_sha: "head",
          verdict: null,
          verdict_head_sha: null,
          verification_run_head: null,
          verification_run_id: 0,
          verification_child_id: null,
          verification_run_count: 0,
          ci_fix_rounds: 0,
          in_flight_epoch_id: null,
          code_changed_since_verification: 0,
          prompt_intends_change: null,
          merge_ready_reopen_count: 0,
          blocked_reason: null,
          failure_reason: null,
          stop_mode: null,
          pre_stop_state: null,
          update_branch_queued_at: null,
          deadline_at: null,
          state_entered_at: null,
        },
      ) as unknown as D1Database,
      SANDBOX_RUNTIME_CLEANUP_SECRET: "cleanup-secret",
    };
    agent = new SessionDO(state as never, env as never);
    doDb.createSession(state.storage.sql, { sessionId: "s-1", ownerUserId: "1" });
  });

  function post(): Request {
    return new Request(`https://internal${SESSION_BEARER_INTERNAL_ROUTES.sessionIndexReproject.path}`, {
      method: SESSION_BEARER_INTERNAL_ROUTES.sessionIndexReproject.method,
      headers: {
        authorization: "Bearer cleanup-secret",
        "content-type": "application/json",
        "x-session-id": "s-1",
      },
      body: JSON.stringify({ sessionId: "s-1" }),
    });
  }

  it("clears stale runtime projection drift and converges on the next call", async () => {
    const first = await agent.fetch(post());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      drift: true,
      fields_changed: [
        "rich_status",
        "ui_lifecycle_stage",
        "runtime_provider",
        "runtime_backend",
        "runtime_state",
        "runtime_sandbox_id",
      ],
    });

    expect((env.DB as unknown as ReprojectD1).row).toMatchObject({
      rich_status: "completed",
      ui_lifecycle_stage: "merge_ready",
      runtime_provider: null,
      runtime_backend: null,
      runtime_state: null,
      runtime_sandbox_id: null,
    });

    const second = await agent.fetch(post());
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, drift: false, fields_changed: [] });
  });
});
