/**
 * Shared test infrastructure for smoke tests.
 * Extends the shared worker harness with smoke-test-specific D1 and env setup.
 */

import { createHmac } from "node:crypto";

import { expect, vi } from "vitest";

import {
  BaseFakeD1Statement,
  batchFakeD1Statements,
  type FakeLinearBootstrapJobRow,
  readFakeLinearBootstrapJob,
  runFakeLinearBootstrapJobMutation,
  runFakeLinearIssueSessionRefMutation,
} from "../test_cloudflare/helpers/fake-d1";
import { createWorkerTestEnv, seedGithubInstallation } from "../test_cloudflare/helpers/worker-env";
import {
  FakeDurableState as SharedFakeDurableState,
  FakeSqlStorage as SharedFakeSqlStorage,
  type WorkerModule as HarnessWorkerModule,
} from "../test_cloudflare/helpers/worker-harness";

vi.mock("../../apps/control-plane-worker/src/sandbox/e2b-client", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/sandbox/e2b-client")>(
    "../../apps/control-plane-worker/src/sandbox/e2b-client",
  );
  return {
    ...actual,
    E2BSandboxClient: class {
      async createSandbox(request: { sandboxId?: string; template?: string }) {
        return {
          runtimeProvider: "e2b",
          runtimeSandboxId: request.sandboxId ?? "sbx-test",
          runtimeTemplateId: request.template ?? "cycloid-sandbox-test",
          status: "running",
          createdAt: Date.now(),
        };
      }

      async startCommand() {
        return { pid: 123, startedAt: Date.now() };
      }

      async connectSandbox(runtimeSandboxId: string) {
        return { runtimeSandboxId };
      }

      async refreshSandbox() {
        return { status: "refreshed", refreshedUntil: Date.now() + 3_600_000 };
      }

      async pauseSandbox() {
        return { status: "paused" };
      }

      async terminateSandbox() {
        return { status: "killed" };
      }
    },
  };
});

// -- Durable Object storage fakes --

export class FakeStorage extends SharedFakeSqlStorage {}

export class FakeDurableState extends SharedFakeDurableState<FakeStorage> {
  constructor(storage: FakeStorage = new FakeStorage()) {
    super(storage);
  }
}

type FlushableDurableNamespace = {
  _flushWaitUntil(options?: { timeoutMs?: number }): Promise<void>;
};

function isFlushableDurableNamespace(value: unknown): value is FlushableDurableNamespace {
  return (
    typeof value === "object" &&
    value !== null &&
    "_flushWaitUntil" in value &&
    typeof value._flushWaitUntil === "function"
  );
}

/** Flush all waitUntil promises for durable namespaces configured in the smoke test env. */
export async function flushAllWaitUntil(env: Record<string, unknown>): Promise<void> {
  const namespaces = Object.values(env).filter(isFlushableDurableNamespace);
  if (namespaces.length === 0) {
    throw new Error("flushAllWaitUntil requires at least one durable namespace in env");
  }

  for (const namespace of namespaces) {
    await namespace._flushWaitUntil();
  }
}

type ProjectionSessionIndexRow = {
  owner_user_id?: string;
  business_id?: string | null;
  status: string;
  rich_status: string | null;
  closed_at?: string | null;
};

type ProjectionReplayRow = {
  session_id: string;
  last_event_sequence: number;
  updated_at: string | null;
};

export function expectProjectionRows(
  db: {
    sessionIndex: Map<string, ProjectionSessionIndexRow>;
    replay: Map<string, ProjectionReplayRow>;
  },
  sessionId: string,
  expectations: {
    ownerUserId?: string;
    status?: string;
    richStatus?: string | null;
    minReplaySequence?: number;
    maxReplaySequence?: number;
  } = {},
): void {
  const sessionIndexRow = db.sessionIndex.get(sessionId);
  expect(sessionIndexRow).toBeDefined();
  if (expectations.ownerUserId !== undefined) {
    expect(sessionIndexRow!.owner_user_id).toBe(expectations.ownerUserId);
  }
  if (expectations.status !== undefined) {
    expect(sessionIndexRow!.status).toBe(expectations.status);
  }
  if (expectations.richStatus !== undefined) {
    expect(sessionIndexRow!.rich_status).toBe(expectations.richStatus);
  }

  const replayRow = db.replay.get(sessionId);
  expect(replayRow).toBeDefined();
  expect(replayRow!.session_id).toBe(sessionId);
  expect(replayRow!.updated_at).toEqual(expect.any(String));
  if (expectations.minReplaySequence !== undefined) {
    expect(replayRow!.last_event_sequence).toBeGreaterThanOrEqual(expectations.minReplaySequence);
  }
  if (expectations.maxReplaySequence !== undefined) {
    expect(replayRow!.last_event_sequence).toBeLessThanOrEqual(expectations.maxReplaySequence);
  }
}

// -- D1 fakes --

class FakeSessionIndexRow {
  constructor(
    public session_id: string,
    public owner_user_id: string,
    public business_id: string | null,
    public status: string,
    public created_at: string,
    public updated_at: string,
    public closed_at: string | null,
    public last_event_id: string | null,
    public title: string | null = null,
    public rich_status: string | null = null,
    public installation_id: number | null = null,
    public repo_owner: string | null = null,
    public repo_name: string | null = null,
    public runtime_backend: string | null = null,
    public runtime_state: string | null = null,
    public runtime_sandbox_id: string | null = null,
    public runtime_template_id: string | null = null,
    public runtime_live_lease_expires_at: number | null = null,
  ) {}
}

class FakeReplayRow {
  constructor(
    public session_id: string,
    public last_event_sequence: number,
    public last_event_timestamp: string | null,
    public updated_at: string | null,
  ) {}
}

type AuthTokenUser = {
  user_id: number;
  expires_at: number;
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  business_id?: string;
  shared_sessions?: number | null;
  created_at?: number;
};

type FakeUserRow = {
  id: number;
  github_id?: number;
  login: string;
  name?: string | null;
  email?: string | null;
  slack_user_id?: string;
  linear_user_id?: string;
  business_id?: string;
  avatar_url?: string | null;
  created_at?: number;
  updated_at?: number;
};

type FakeBusinessMemberRow = {
  business_id: string;
  user_id: number;
  role: "admin" | "member";
  created_at: number;
  updated_at: number;
};

type FakeUserIntegrationRow = {
  user_id: number;
  integration_id: string;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: number | null;
  api_key: string | null;
  external_user_id: string | null;
  service_url: string | null;
  encrypted: number;
  last_validated_at: number | null;
  last_validation_status: string | null;
  last_validation_reason_code: string | null;
  connected_at: number;
  updated_at: number;
};

type FakeBusinessIntegrationRow = {
  business_id: string;
  integration_id: string;
  scope: "disabled" | "user" | "business";
  created_at?: number;
  updated_at?: number;
};

type FakeBusinessCredentialRow = {
  business_id: string;
  integration_id: string;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: number | null;
  api_key: string | null;
  service_url: string | null;
  encrypted: number;
  connected_at: number;
  updated_at: number;
};

type FakeIntegrationLifecycleEventRow = {
  id: string;
  business_id: string | null;
  user_id: number | null;
  session_id: string | null;
  integration_id: string;
  stage: string;
  status: string;
  reason_code: string | null;
  message: string | null;
  details_json: string | null;
  latency_ms: number;
  created_at: number;
};

type FakeOpenAIGatewaySessionTokenRow = {
  token_hash: string;
  owner_user_id: number;
  business_id: string | null;
  credential_source: string;
  credential_provider: string;
  credential_owner_id: string;
  session_id: string;
  expires_at: number;
  created_at: number;
};

type FakeUserSettingsRow = {
  user_id: number;
  default_model: string | null;
  default_repo: string | null;
  plan_mode_setting: "off" | "on" | "auto";
  // ARC-1514: per-user manual review mode. Optional here (the fake only stores what a test seeds);
  // the review-arm gates read it via getUserSettingsIfExists, defaulting to manual when absent.
  automatic_reviews_enabled?: number;
  created_at: number;
  updated_at: number;
};

type LinearWebhookInstallationRow = {
  business_id: string;
  linear_organization_id: string;
  linear_organization_name: string | null;
  linear_organization_url_key: string | null;
  linear_webhook_id: string | null;
  connected_by_user_id: number;
  status: "active" | "revoked";
  connected_at: number;
  updated_at: number;
  revoked_at: number | null;
};

type FakeSlackWorkspaceRow = {
  team_id: string;
  bot_token_encrypted: string;
  bot_user_id: string;
  team_name: string | null;
  business_id: string | null;
  team_domain: string | null;
  enterprise_id: string | null;
  installed_by_user_id: number | null;
  installed_at: number;
  updated_at: number;
  uninstalled_at: number | null;
};

type FakeManagedPrCommentRow = {
  repo_owner: string;
  repo_name: string;
  installation_id: number;
  pr_number: number;
  kind: string;
  pr_url: string;
  owner_session_id: string | null;
  comment_id: number | null;
  body_hash: string;
  prompt_id: string | null;
  head_sha: string | null;
  state: string;
  state_rank: number;
  lease_owner: string | null;
  lease_expires_at: number;
  created_at: number;
  updated_at: number;
};

type FakePrCoordinationRow = {
  session_id: string;
  version: number;
  state: string;
  pr_url: string | null;
  head_sha: string | null;
  verdict: string | null;
  verdict_head_sha: string | null;
  verification_run_head: string | null;
  verification_run_id: number;
  verification_child_id: string | null;
  verification_run_count: number;
  ci_fix_rounds: number;
  in_flight_epoch_id: string | null;
  code_changed_since_verification: number;
  prompt_intends_change: number | null;
  merge_ready_reopen_count: number;
  blocked_reason: string | null;
  failure_reason: string | null;
  stop_mode: string | null;
  pre_stop_state: string | null;
  update_branch_queued_at: number | null;
  deadline_at: number | null;
  state_entered_at: number | null;
};

class FakeD1Statement extends BaseFakeD1Statement<FakeD1> {
  private isArchivedRow(row: FakeSessionIndexRow): boolean {
    return row.status === "archived";
  }

  async run(): Promise<{ success: true; meta?: { changes: number } }> {
    if (this.isSchemaQuery()) return { success: true };

    if (this.query.includes("INSERT INTO pr_coordination_events")) {
      return { success: true, meta: { changes: 1 } };
    }

    if (
      this.query.includes("INSERT INTO qa_loop_session_bindings") ||
      this.query.includes("UPDATE qa_loop_session_bindings")
    ) {
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("INSERT INTO pr_coordination")) {
      const [
        sessionId,
        version,
        state,
        prUrl,
        headSha,
        verdict,
        verdictHeadSha,
        verificationRunHead,
        verificationRunId,
        verificationChildId,
        verificationRunCount,
        ciFixRounds,
        inFlightEpochId,
        codeChangedSinceVerification,
        promptIntendsChange,
        mergeReadyReopenCount,
        blockedReason,
        failureReason,
        stopMode,
        preStopState,
        updateBranchQueuedAt,
        deadlineAt,
        stateEnteredAt,
      ] = this.boundValues as [
        string,
        number,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
        string | null,
        number,
        number,
        string | null,
        number,
        number | null,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        number | null,
        number | null,
      ];
      if (this.db.prCoordination.has(sessionId)) return { success: true, meta: { changes: 0 } };
      this.db.prCoordination.set(sessionId, {
        session_id: sessionId,
        version,
        state,
        pr_url: prUrl,
        head_sha: headSha,
        verdict,
        verdict_head_sha: verdictHeadSha,
        verification_run_head: verificationRunHead,
        verification_run_id: verificationRunId,
        verification_child_id: verificationChildId,
        verification_run_count: verificationRunCount,
        ci_fix_rounds: ciFixRounds,
        in_flight_epoch_id: inFlightEpochId,
        code_changed_since_verification: codeChangedSinceVerification,
        prompt_intends_change: promptIntendsChange,
        merge_ready_reopen_count: mergeReadyReopenCount,
        blocked_reason: blockedReason,
        failure_reason: failureReason,
        stop_mode: stopMode,
        pre_stop_state: preStopState,
        update_branch_queued_at: updateBranchQueuedAt,
        deadline_at: deadlineAt,
        state_entered_at: stateEnteredAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("UPDATE pr_coordination SET verification_child_id = ?")) {
      const [verificationChildId, sessionId, verificationRunId] = this.boundValues as [string, string, number];
      const row = this.db.prCoordination.get(sessionId);
      if (!row || row.verification_run_id !== verificationRunId || row.verification_child_id !== null) {
        return { success: true, meta: { changes: 0 } };
      }
      row.verification_child_id = verificationChildId;
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("UPDATE pr_coordination SET") && this.query.includes("version = version + 1")) {
      const sessionId = this.boundValues[this.boundValues.length - 2] as string;
      const expectedVersion = this.boundValues[this.boundValues.length - 1] as number;
      const row = this.db.prCoordination.get(sessionId);
      if (!row || row.version !== expectedVersion) return { success: true, meta: { changes: 0 } };

      const setClause = this.query.slice(this.query.indexOf("SET") + 3, this.query.indexOf("WHERE"));
      const assignments = setClause
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part && part !== "version = version + 1");
      assignments.forEach((assignment, index) => {
        const column = assignment.split("=")[0]?.trim() as keyof FakePrCoordinationRow | undefined;
        if (!column || column === "session_id" || column === "version") return;
        row[column] = this.boundValues[index] as never;
      });
      row.version += 1;
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("INSERT INTO session_index")) {
      const [
        sessionId,
        ownerUserId,
        businessId,
        status,
        createdAt,
        updatedAt,
        closedAt,
        lastEventId,
        title,
        _titleTags,
        richStatus,
        _model,
        _reasoningEffort,
        _sessionKind,
        installationId,
        repoOwner,
        repoName,
      ] = this.boundValues as [
        string,
        string,
        string | null,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        string | null,
        string | null,
      ];
      const existing = this.db.sessionIndex.get(sessionId);
      const resolvedBusinessId =
        existing?.business_id ?? businessId ?? this.db.getUserById(Number(ownerUserId))?.business_id ?? null;
      this.db.sessionIndex.set(
        sessionId,
        new FakeSessionIndexRow(
          sessionId,
          ownerUserId,
          resolvedBusinessId,
          status,
          createdAt,
          updatedAt,
          closedAt,
          lastEventId,
          title ?? null,
          richStatus ?? existing?.rich_status ?? null,
          installationId ?? existing?.installation_id ?? null,
          repoOwner ?? existing?.repo_owner ?? null,
          repoName ?? existing?.repo_name ?? null,
          existing?.runtime_backend ?? null,
          existing?.runtime_state ?? null,
          existing?.runtime_sandbox_id ?? null,
          existing?.runtime_template_id ?? null,
          existing?.runtime_live_lease_expires_at ?? null,
        ),
      );
      return { success: true };
    }

    if (this.query.includes("UPDATE session_index SET rich_status")) {
      const [richStatus, sessionId] = this.boundValues as [string, string];
      const existing = this.db.sessionIndex.get(sessionId);
      if (existing) {
        existing.rich_status = richStatus;
      }
      return { success: true };
    }

    // Runtime-state projection UPDATE: model row existence faithfully so the
    // zero-row repair path (syncRuntimeProjectionChecked) is testable. The real
    // UPDATE matches by session_id only; a missing row reports changes:0.
    if (this.query.includes("UPDATE session_index") && this.query.includes("runtime_sandbox_id = ?")) {
      const sessionId = this.boundValues[this.boundValues.length - 1] as string;
      const existing = this.db.sessionIndex.get(sessionId);
      if (!existing) {
        return { success: true, meta: { changes: 0 } } as unknown as { success: true };
      }
      const [, runtimeBackend, runtimeState, runtimeSandboxId, runtimeTemplateId] = this.boundValues as unknown as [
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      if (runtimeBackend != null) existing.runtime_backend = runtimeBackend;
      existing.runtime_state = runtimeState ?? null;
      existing.runtime_sandbox_id = runtimeSandboxId ?? null;
      existing.runtime_template_id = runtimeTemplateId ?? null;
      return { success: true, meta: { changes: 1 } } as unknown as { success: true };
    }

    if (this.query.includes("UPDATE session_index")) {
      return { success: true, meta: { changes: 1 } } as unknown as { success: true };
    }

    if (this.query.includes("INSERT INTO durable_event_replay_metadata")) {
      const [sessionId, sequence, eventTimestamp, updatedAt] = this.boundValues as [
        string,
        number,
        string | null,
        string | null,
      ];
      this.db.replay.set(sessionId, new FakeReplayRow(sessionId, sequence, eventTimestamp, updatedAt));
      return { success: true };
    }

    if (this.query.includes("INSERT OR IGNORE INTO session_webhook_refs")) {
      const [source, externalRef, sessionId] = this.boundValues as [string, string, string, string];
      const key = `${source}:${externalRef}`;
      const existing = this.db.sessionWebhookRefs.get(key);
      if (existing && existing.size > 0) {
        return { success: true, meta: { changes: 0 } } as unknown as { success: true };
      }
      this.db.sessionWebhookRefs.set(key, new Set([sessionId]));
      return { success: true, meta: { changes: 1 } } as unknown as { success: true };
    }

    if (this.query.includes("INSERT INTO session_webhook_refs")) {
      const [source, externalRef, sessionId] = this.boundValues as [string, string, string, string];
      const key = `${source}:${externalRef}`;
      const existing = this.db.sessionWebhookRefs.get(key) || new Set<string>();
      existing.add(sessionId);
      this.db.sessionWebhookRefs.set(key, existing);
      return { success: true };
    }

    if (this.query.includes("INSERT INTO slack_thread_session_refs")) {
      const [businessId, teamId, channelId, threadTs, sessionId] =
        this.boundValues.length >= 6
          ? (this.boundValues as [string, string, string, string, string, string])
          : ([null, null, ...this.boundValues] as [null, null, string, string, string]);
      const key = `${channelId}:${threadTs}`;
      const scopedKey = businessId && teamId ? `${businessId}:${teamId}:${channelId}:${threadTs}` : key;
      if (this.db.slackThreadSessionRefs.has(key) || this.db.slackThreadSessionRefs.has(scopedKey)) {
        return { success: true, meta: { changes: 0 } } as unknown as { success: true };
      }
      this.db.slackThreadSessionRefs.set(key, sessionId);
      this.db.slackThreadSessionRefs.set(scopedKey, sessionId);
      return { success: true, meta: { changes: 1 } } as unknown as { success: true };
    }

    if (
      this.query.includes("DELETE FROM slack_thread_session_refs") &&
      this.query.includes("channel_id = ?") &&
      this.query.includes("thread_ts = ?") &&
      this.query.includes("session_id = ?") &&
      this.boundValues.length === 3
    ) {
      const [channelId, threadTs, sessionId] = this.boundValues as [string, string, string];
      const key = `${channelId}:${threadTs}`;
      if (this.db.slackThreadSessionRefs.get(key) !== sessionId) {
        return { success: true, meta: { changes: 0 } } as unknown as { success: true };
      }
      this.db.slackThreadSessionRefs.delete(key);
      return { success: true, meta: { changes: 1 } } as unknown as { success: true };
    }

    if (this.query.includes("INSERT INTO slack_workspaces")) {
      const [
        teamId,
        botTokenEncrypted,
        botUserId,
        teamName,
        businessId,
        teamDomain,
        enterpriseId,
        installedByUserId,
        installedAt,
        updatedAt,
      ] = this.boundValues as [
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        number,
        number,
      ];
      // Mirror the statement-level guards: one active workspace per business,
      // and no rebinding an active workspace to a different business.
      if (businessId !== null) {
        for (const existing of this.db.slackWorkspaces.values()) {
          const existingActive = existing.uninstalled_at === null;
          const otherTeamSameBusiness =
            existingActive && existing.business_id === businessId && existing.team_id !== teamId;
          const sameTeamOtherBusiness =
            existingActive &&
            existing.team_id === teamId &&
            existing.business_id !== null &&
            existing.business_id !== businessId;
          if (otherTeamSameBusiness || sameTeamOtherBusiness) {
            return { success: true, meta: { changes: 0 } } as unknown as { success: true };
          }
        }
      }
      this.db.slackWorkspaces.set(teamId, {
        team_id: teamId,
        bot_token_encrypted: botTokenEncrypted,
        bot_user_id: botUserId,
        team_name: teamName,
        business_id: businessId,
        team_domain: teamDomain,
        enterprise_id: enterpriseId,
        installed_by_user_id: installedByUserId,
        installed_at: installedAt,
        updated_at: updatedAt,
        uninstalled_at: null,
      });
      return { success: true, meta: { changes: 1 } } as unknown as { success: true };
    }

    if (this.query.includes("UPDATE slack_workspaces SET uninstalled_at")) {
      const [uninstalledAt, updatedAt, teamId] = this.boundValues as [number, number, string];
      const existing = this.db.slackWorkspaces.get(teamId);
      if (!existing) {
        return { success: true, meta: { changes: 0 } } as unknown as { success: true };
      }
      existing.uninstalled_at = uninstalledAt;
      existing.updated_at = updatedAt;
      return { success: true, meta: { changes: 1 } } as unknown as { success: true };
    }
    if (
      this.query.includes("DELETE FROM slack_thread_session_refs") &&
      this.query.includes("WHERE session_id = ?") &&
      this.boundValues.length === 1
    ) {
      const [sessionId] = this.boundValues as [string];
      let changes = 0;
      for (const [key, mappedSessionId] of this.db.slackThreadSessionRefs) {
        if (mappedSessionId === sessionId) {
          this.db.slackThreadSessionRefs.delete(key);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } } as unknown as { success: true };
    }

    const linearIssueMutation = runFakeLinearIssueSessionRefMutation(this.db, this.query, this.boundValues);
    if (linearIssueMutation) return linearIssueMutation;

    const bootstrapJobMutation = runFakeLinearBootstrapJobMutation(this.db, this.query, this.boundValues);
    if (bootstrapJobMutation) return bootstrapJobMutation as unknown as { success: true };

    if (this.query.includes("INTO webhook_idempotency")) {
      const [idempotencyKey, source, payloadHash, receivedAt] = this.boundValues as [
        string,
        string,
        string | null,
        string,
      ];
      if (this.db.webhookIdempotencyRows.has(idempotencyKey)) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.webhookIdempotencyRows.set(idempotencyKey, {
        idempotency_key: idempotencyKey,
        source,
        payload_hash: payloadHash,
        received_at: receivedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    // Memory analysis jobs — accept and no-op (the smoke test doesn't verify memory job outcomes)
    if (this.query.includes("INSERT INTO memory_analysis_jobs")) {
      return { success: true, meta: { changes: 1 } } as unknown as { success: true };
    }

    if (this.query.includes("UPDATE memory_analysis_jobs")) {
      return { success: true, meta: { changes: 0 } } as unknown as { success: true };
    }

    if (this.query.includes("DELETE FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      this.db.authTokens.delete(token);
      return { success: true };
    }

    if (this.query.includes("DELETE FROM session_index")) {
      const archivedOnly = this.query.includes("status = 'archived'");
      if (this.query.includes("owner_user_id")) {
        const [ownerUserId] = this.boundValues as [string];
        for (const [key, row] of this.db.sessionIndex) {
          if (row.owner_user_id === ownerUserId && (!archivedOnly || row.status === "archived")) {
            this.db.sessionIndex.delete(key);
          }
        }
      } else {
        if (archivedOnly) {
          for (const [key, row] of this.db.sessionIndex) {
            if (row.status === "archived") this.db.sessionIndex.delete(key);
          }
        } else {
          this.db.sessionIndex.clear();
        }
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE users SET linear_access_token")) {
      return { success: true };
    }

    if (this.query.includes("UPDATE users SET login")) {
      const [login, name, email, avatarUrl, updatedAt, lookupValue] = this.boundValues as [
        string,
        string | null,
        string | null,
        string | null,
        number,
        number,
      ];
      const user = this.db.getUserByGithubId(lookupValue) ?? this.db.getUserById(lookupValue);
      if (user) {
        user.login = login;
        user.name = name;
        user.email = email;
        user.avatar_url = avatarUrl;
        user.updated_at = updatedAt;
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE users SET slack_user_id")) {
      return { success: true };
    }

    if (this.query.includes("INSERT INTO slack_link_token_consumptions")) {
      const [jti, _slackTeamId, _slackUserId, consumedByUserId, _consumedAt, expiresAt] = this.boundValues as [
        string,
        string,
        string,
        number,
        number,
        number,
      ];
      if (this.db.slackLinkTokenConsumptions.has(jti)) {
        // Mirror the jti primary-key single-use guard.
        throw new Error("UNIQUE constraint failed: slack_link_token_consumptions.jti");
      }
      this.db.slackLinkTokenConsumptions.set(jti, {
        consumed_by_user_id: consumedByUserId,
        expires_at: expiresAt,
      });
      return { success: true };
    }

    if (this.query.includes("DELETE FROM slack_link_token_consumptions")) {
      const [now] = this.boundValues as [number];
      for (const [jti, row] of this.db.slackLinkTokenConsumptions) {
        if (row.expires_at < now) this.db.slackLinkTokenConsumptions.delete(jti);
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE user_integrations") && this.query.includes("slack_link_token_consumptions")) {
      const [teamId, userId, _ledgerUserId, candidateTeamId, latestLedgerUserId] = this.boundValues as [
        string,
        number,
        number,
        string,
        number,
      ];
      const row = this.db.userIntegrations.get(`${userId}:slack`);
      const ledgerTeams = [...this.db.slackLinkTokenConsumptions.values()]
        .filter((ledgerRow) => ledgerRow.consumed_by_user_id === latestLedgerUserId)
        .sort((a, b) => b.consumed_at - a.consumed_at);
      if (
        row?.external_team_id === null &&
        (ledgerTeams.length === 0 || ledgerTeams[0]?.slack_team_id === candidateTeamId)
      ) {
        row.external_team_id = teamId;
      }
      return { success: true };
    }

    // bindSlackIdentity identity upsert: only writes external_user_id when NULL,
    // and the partial unique index on (integration_id, external_user_id) rejects
    // a Slack id already owned by another user.
    if (
      this.query.includes("INSERT INTO user_integrations") &&
      this.query.includes("ON CONFLICT(user_id, integration_id)") &&
      this.query.includes("external_user_id = excluded.external_user_id")
    ) {
      const [userId, externalUserId, connectedAt, updatedAt] = this.boundValues as [number, string, number, number];
      for (const row of this.db.userIntegrations.values()) {
        if (row.integration_id === "slack" && row.external_user_id === externalUserId && row.user_id !== userId) {
          throw new Error("UNIQUE constraint failed: user_integrations.external_user_id");
        }
      }
      const key = `${userId}:slack`;
      const existing = this.db.userIntegrations.get(key);
      if (existing) {
        if (existing.external_user_id === null) {
          existing.external_user_id = externalUserId;
          existing.updated_at = updatedAt;
        }
      } else {
        this.db.userIntegrations.set(key, {
          user_id: userId,
          integration_id: "slack",
          oauth_access_token: null,
          oauth_refresh_token: null,
          oauth_expires_at: null,
          api_key: null,
          external_user_id: externalUserId,
          service_url: null,
          encrypted: 0,
          last_validated_at: null,
          last_validation_status: null,
          last_validation_reason_code: null,
          connected_at: connectedAt,
          updated_at: updatedAt,
        });
      }
      return { success: true };
    }

    if (this.query.includes("INSERT INTO user_integrations")) {
      const [
        userId,
        integrationId,
        oauthAccessToken,
        oauthRefreshToken,
        oauthExpiresAt,
        apiKey,
        externalUserId,
        serviceUrl,
        encrypted,
        lastValidatedAt,
        lastValidationStatus,
        lastValidationReasonCode,
        connectedAt,
        updatedAt,
      ] = this.boundValues as [
        number,
        string,
        string | null,
        string | null,
        number | null,
        string | null,
        string | null,
        string | null,
        number,
        number | null,
        string | null,
        string | null,
        number,
        number,
      ];
      this.db.userIntegrations.set(`${userId}:${integrationId}`, {
        user_id: userId,
        integration_id: integrationId,
        oauth_access_token: oauthAccessToken,
        oauth_refresh_token: oauthRefreshToken,
        oauth_expires_at: oauthExpiresAt,
        api_key: apiKey,
        external_user_id: externalUserId,
        service_url: serviceUrl,
        encrypted,
        last_validated_at: lastValidatedAt,
        last_validation_status: lastValidationStatus,
        last_validation_reason_code: lastValidationReasonCode,
        connected_at: connectedAt,
        updated_at: updatedAt,
      });
      return { success: true };
    }

    if (this.query.includes("INSERT INTO business_integrations")) {
      const [businessId, integrationId, scope, createdAt, updatedAt] = this.boundValues as [
        string,
        string,
        "disabled" | "user" | "business",
        number,
        number,
      ];
      this.db.businessIntegrations.set(`${businessId}:${integrationId}`, {
        business_id: businessId,
        integration_id: integrationId,
        scope,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true };
    }

    if (this.query.includes("INSERT INTO business_integration_credentials")) {
      const [
        businessId,
        integrationId,
        oauthAccessToken,
        oauthRefreshToken,
        oauthExpiresAt,
        apiKey,
        serviceUrl,
        encrypted,
        _lastValidatedAt,
        _lastValidationStatus,
        _lastValidationReasonCode,
        connectedAt,
        updatedAt,
      ] = this.boundValues as [
        string,
        string,
        string | null,
        string | null,
        number | null,
        string | null,
        string | null,
        number,
        unknown,
        unknown,
        unknown,
        number,
        number,
      ];
      this.db.businessIntegrationCredentials.set(`${businessId}:${integrationId}`, {
        business_id: businessId,
        integration_id: integrationId,
        oauth_access_token: oauthAccessToken,
        oauth_refresh_token: oauthRefreshToken,
        oauth_expires_at: oauthExpiresAt,
        api_key: apiKey,
        service_url: serviceUrl,
        encrypted,
        connected_at: connectedAt,
        updated_at: updatedAt,
      });
      return { success: true };
    }

    if (
      this.query.includes("UPDATE user_integrations") &&
      this.query.includes("last_validated_at = ?") &&
      this.query.includes("integration_id = 'jira'")
    ) {
      const [lastValidatedAt, lastValidationStatus, lastValidationReasonCode, updatedAt, userId] = this.boundValues as [
        number,
        string,
        string | null,
        number,
        number,
      ];
      const row = this.db.userIntegrations.get(`${userId}:jira`);
      if (row) {
        row.last_validated_at = lastValidatedAt;
        row.last_validation_status = lastValidationStatus;
        row.last_validation_reason_code = lastValidationReasonCode;
        row.updated_at = updatedAt;
      }
      return { success: true };
    }

    if (this.query.includes("INSERT INTO openai_gateway_session_tokens")) {
      const [tokenHash, ownerUserId, businessId, credentialSource, credentialOwnerId, sessionId, expiresAt, createdAt] =
        this.boundValues as [string, number, string | null, string, string, string, number, number];
      this.db.openAIGatewaySessionTokens.set(tokenHash, {
        token_hash: tokenHash,
        owner_user_id: ownerUserId,
        business_id: businessId,
        credential_source: credentialSource,
        credential_provider: "openai",
        credential_owner_id: credentialOwnerId,
        session_id: sessionId,
        expires_at: expiresAt,
        created_at: createdAt,
      });
      return { success: true };
    }

    if (this.query.includes("INSERT INTO linear_webhook_installations")) {
      const [
        businessId,
        linearOrganizationId,
        linearOrganizationName,
        linearOrganizationUrlKey,
        linearWebhookId,
        connectedByUserId,
        connectedAt,
        updatedAt,
      ] = this.boundValues as [string, string, string | null, string | null, string | null, number, number, number];
      const existing = this.db.linearWebhookInstallations.get(`${businessId}:${linearOrganizationId}`);
      this.db.linearWebhookInstallations.set(`${businessId}:${linearOrganizationId}`, {
        business_id: businessId,
        linear_organization_id: linearOrganizationId,
        linear_organization_name: linearOrganizationName ?? existing?.linear_organization_name ?? null,
        linear_organization_url_key: linearOrganizationUrlKey ?? existing?.linear_organization_url_key ?? null,
        linear_webhook_id: linearWebhookId,
        connected_by_user_id: connectedByUserId,
        status: "active",
        connected_at: connectedAt,
        updated_at: updatedAt,
        revoked_at: null,
      });
      return { success: true };
    }

    if (this.query.includes("UPDATE linear_webhook_installations") && this.query.includes("SET linear_webhook_id")) {
      const [linearWebhookId, updatedAt, businessId, linearOrganizationId] = this.boundValues as [
        string,
        number,
        string,
        string,
      ];
      const row = this.db.linearWebhookInstallations.get(`${businessId}:${linearOrganizationId}`);
      if (row && row.status === "active" && row.linear_webhook_id === null) {
        row.linear_webhook_id = linearWebhookId;
        row.updated_at = updatedAt;
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE linear_webhook_installations") && this.query.includes("SET status = 'revoked'")) {
      const [revokedAt, updatedAt, linearOrganizationId, linearWebhookId, _linearWebhookIdMatch] = this.boundValues as [
        number,
        number,
        string,
        string | null,
        string | null,
      ];
      for (const row of this.db.linearWebhookInstallations.values()) {
        if (row.linear_organization_id !== linearOrganizationId || row.status !== "active") continue;
        if (linearWebhookId !== null && row.linear_webhook_id !== null && row.linear_webhook_id !== linearWebhookId)
          continue;
        row.status = "revoked";
        row.revoked_at = revokedAt;
        row.updated_at = updatedAt;
      }
      return { success: true };
    }

    if (this.query.includes("DELETE FROM user_integrations")) {
      const [userId, integrationId] = this.boundValues as [number, string];
      this.db.userIntegrations.delete(`${userId}:${integrationId}`);
      return { success: true };
    }

    if (this.query.includes("INSERT INTO jira_webhook_installations")) {
      const [businessId, jiraCloudId, siteUrl, siteName, installationToken, connectedByUserId, createdAt, updatedAt] =
        this.boundValues as [string, string, string | null, string | null, string, number, number, number];
      // Mirror idx_jira_webhook_installations_cloud_active: one non-revoked binding per site.
      for (const [key, row] of this.db.jiraWebhookInstallations) {
        if (row.jira_cloud_id === jiraCloudId && row.status !== "revoked" && key !== `${businessId}:${jiraCloudId}`) {
          throw new Error("UNIQUE constraint failed: idx_jira_webhook_installations_cloud_active");
        }
      }
      const existing = this.db.jiraWebhookInstallations.get(`${businessId}:${jiraCloudId}`);
      this.db.jiraWebhookInstallations.set(`${businessId}:${jiraCloudId}`, {
        business_id: businessId,
        jira_cloud_id: jiraCloudId,
        site_url: siteUrl ?? existing?.site_url ?? null,
        site_name: siteName ?? existing?.site_name ?? null,
        webhooks_json: existing?.webhooks_json ?? null,
        installation_token: installationToken,
        trigger_label: existing?.trigger_label ?? null,
        connected_by_user_id: connectedByUserId,
        status: "active",
        webhook_registered_at: existing?.webhook_registered_at ?? null,
        webhook_expires_at: existing?.webhook_expires_at ?? null,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
        revoked_at: null,
      });
      return { success: true };
    }

    if (this.query.includes("UPDATE jira_webhook_installations") && this.query.includes("SET webhooks_json")) {
      const [webhooksJson, triggerLabel, registeredAt, expiresAt, updatedAt, businessId, jiraCloudId] = this
        .boundValues as [string, string, number, number | null, number, string, string];
      const row = this.db.jiraWebhookInstallations.get(`${businessId}:${jiraCloudId}`);
      if (row && row.status !== "revoked") {
        row.webhooks_json = webhooksJson;
        row.trigger_label = triggerLabel;
        row.webhook_registered_at = registeredAt;
        row.webhook_expires_at = expiresAt;
        row.status = "active";
        row.updated_at = updatedAt;
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE jira_webhook_installations") && this.query.includes("SET status = 'degraded'")) {
      const [updatedAt, businessId, jiraCloudId] = this.boundValues as [number, string, string];
      const row = this.db.jiraWebhookInstallations.get(`${businessId}:${jiraCloudId}`);
      if (row && row.status === "active") {
        row.status = "degraded";
        row.updated_at = updatedAt;
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE jira_webhook_installations") && this.query.includes("SET webhook_expires_at")) {
      const [expiresAt, updatedAt, businessId, jiraCloudId] = this.boundValues as [number, number, string, string];
      const row = this.db.jiraWebhookInstallations.get(`${businessId}:${jiraCloudId}`);
      if (row && row.status !== "revoked") {
        row.webhook_expires_at = expiresAt;
        row.status = "active";
        row.updated_at = updatedAt;
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE jira_webhook_installations") && this.query.includes("SET status = 'revoked'")) {
      const [revokedAt, updatedAt, businessId] = this.boundValues as [number, number, string];
      let changes = 0;
      for (const row of this.db.jiraWebhookInstallations.values()) {
        if (row.business_id !== businessId || row.status === "revoked") continue;
        row.status = "revoked";
        row.revoked_at = revokedAt;
        row.updated_at = updatedAt;
        changes++;
      }
      return { success: true, meta: { changes } };
    }

    if (this.query.includes("INSERT INTO jira_user_sites")) {
      const [userId, jiraCloudId, siteUrl, siteName, jiraAccountId, createdAt, updatedAt] = this.boundValues as [
        number,
        string,
        string,
        string | null,
        string,
        number,
        number,
      ];
      const existing = this.db.jiraUserSites.get(userId);
      this.db.jiraUserSites.set(userId, {
        user_id: userId,
        jira_cloud_id: jiraCloudId,
        site_url: siteUrl,
        site_name: siteName,
        jira_account_id: jiraAccountId,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { success: true };
    }

    if (this.query.includes("INSERT INTO jira_personal_data_reports")) {
      const [jiraAccountId, personalDataUpdatedAt, createdAt, updatedAt] = this.boundValues as [
        string,
        number,
        number,
        number,
      ];
      const existing = this.db.jiraPersonalDataReports.get(jiraAccountId);
      this.db.jiraPersonalDataReports.set(jiraAccountId, {
        jira_account_id: jiraAccountId,
        personal_data_updated_at: personalDataUpdatedAt,
        last_reported_at: existing?.last_reported_at ?? null,
        next_report_after: existing?.last_reported_at == null ? 0 : existing.next_report_after,
        last_status: existing?.last_status ?? null,
        last_error: null,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { success: true };
    }

    if (this.query.includes("DELETE FROM jira_user_sites")) {
      const [userId] = this.boundValues as [number];
      this.db.jiraUserSites.delete(Number(userId));
      return { success: true };
    }

    if (
      this.query.includes("DELETE FROM jira_personal_data_reports") &&
      this.query.includes("WHERE jira_account_id = ?")
    ) {
      const [jiraAccountId] = this.boundValues as [string];
      const stillReferencedByIntegration = [...this.db.userIntegrations.values()].some(
        (row) => row.integration_id === "jira" && row.external_user_id === jiraAccountId,
      );
      const stillReferencedBySite = [...this.db.jiraUserSites.values()].some(
        (row) => row.jira_account_id === jiraAccountId,
      );
      if (!stillReferencedByIntegration && !stillReferencedBySite) {
        this.db.jiraPersonalDataReports.delete(jiraAccountId);
      }
      return { success: true };
    }

    if (this.query.includes("DELETE FROM jira_personal_data_reports") && this.query.includes("user_integrations")) {
      const [integrationUserIdRaw, siteUserIdRaw] = this.boundValues as [number, number];
      const accountIds = new Set<string>();
      const integration = this.db.userIntegrations.get(`${Number(integrationUserIdRaw)}:jira`);
      if (typeof integration?.external_user_id === "string") accountIds.add(integration.external_user_id);
      const site = this.db.jiraUserSites.get(Number(siteUserIdRaw));
      if (typeof site?.jira_account_id === "string") accountIds.add(site.jira_account_id);
      for (const accountId of accountIds) this.db.jiraPersonalDataReports.delete(accountId);
      return { success: true };
    }

    if (this.query.includes("INSERT INTO jira_oauth_pending")) {
      const [nonce, userId, flow, tokenPayload, sitesJson, jiraAccountId, createdAt, expiresAt] = this.boundValues as [
        string,
        number,
        string,
        string,
        string,
        string | null,
        number,
        number,
      ];
      this.db.jiraOAuthPending.set(nonce, {
        nonce,
        user_id: userId,
        flow,
        token_payload: tokenPayload,
        sites_json: sitesJson,
        jira_account_id: jiraAccountId,
        created_at: createdAt,
        expires_at: expiresAt,
      });
      return { success: true };
    }

    if (this.query.includes("DELETE FROM jira_oauth_pending WHERE expires_at")) {
      const [now] = this.boundValues as [number];
      for (const [nonce, row] of this.db.jiraOAuthPending) {
        if ((row.expires_at as number) <= now) this.db.jiraOAuthPending.delete(nonce);
      }
      return { success: true };
    }

    if (this.query.includes("DELETE FROM jira_oauth_pending WHERE nonce")) {
      const [nonce] = this.boundValues as [string];
      const existed = this.db.jiraOAuthPending.delete(nonce);
      return { success: true, meta: { changes: existed ? 1 : 0 } };
    }

    if (this.query.includes("DELETE FROM business_integration_credentials")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      this.db.businessIntegrationCredentials.delete(`${businessId}:${integrationId}`);
      return { success: true };
    }

    if (this.query.includes("INSERT INTO user_settings")) {
      // `INSERT ... SELECT id, ?, ... FROM users WHERE id = ?` binds the user
      // id LAST; the SELECT column values come first.
      const userId = this.boundValues[this.boundValues.length - 1] as number;
      const planModeSetting = this.boundValues[3] as "off" | "on" | "auto";
      const defaultModel = this.boundValues[5] as string | null;
      const defaultRepo = this.boundValues[6] as string | null;
      const createdAt = this.boundValues[7] as number;
      const updatedAt = this.boundValues[8] as number;
      if (!this.db.userSettings.has(userId)) {
        this.db.userSettings.set(userId, {
          user_id: userId,
          default_model: defaultModel,
          default_repo: defaultRepo,
          plan_mode_setting: planModeSetting,
          created_at: createdAt,
          updated_at: updatedAt,
        });
      }
      return { success: true };
    }

    if (this.query.includes("INSERT INTO business_members")) {
      let businessId: string;
      let userId: number;
      let role: "admin" | "member" = "member";
      let createdAt: number;
      let updatedAt: number;

      if (this.query.includes("SELECT ?, users.id")) {
        [businessId, createdAt, updatedAt] = this.boundValues as [string, number, number, number];
        const githubUserId = Number(this.boundValues[3]);
        const user = this.db.getUserByGithubId(githubUserId);
        if (!user) return { success: true };
        userId = user.id;
      } else {
        [businessId, userId, createdAt, updatedAt] = this.boundValues as [string, number, number, number];
      }

      const existing = this.db.businessMembers.get(userId);
      if (existing) {
        existing.updated_at = updatedAt;
      } else {
        this.db.businessMembers.set(userId, {
          business_id: businessId,
          user_id: userId,
          role,
          created_at: createdAt,
          updated_at: updatedAt,
        });
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE users SET")) {
      return { success: true };
    }

    if (this.query.includes("INSERT INTO users")) {
      const githubId = this.boundValues[0] as number;
      const existing = this.db.getUserByGithubId(githubId);
      if (existing && this.query.includes("ON CONFLICT (github_id) DO NOTHING")) {
        return { success: true, meta: { last_row_id: 0 } } as unknown as { success: true };
      }
      const login = this.boundValues[1] as string;
      const name = this.boundValues[2] as string | null;
      const email = this.boundValues[3] as string | null;
      const avatarUrl = this.boundValues[4] as string | null;
      const businessId = this.boundValues[5] as string | undefined;
      const createdAt = this.boundValues[6] as number | undefined;
      const updatedAt = this.boundValues[7] as number | undefined;
      const id = this.db.addUserRecord(githubId, {
        login,
        name,
        email,
        avatar_url: avatarUrl,
        business_id: businessId,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { last_row_id: id } } as unknown as { success: true };
    }

    if (this.query.includes("INSERT INTO auth_sessions")) {
      const [token, userId, expiresAt, createdAt] = this.boundValues as [string, number, number, number | undefined];
      const user = this.db.getUserById(userId);
      this.db.setAuthToken(token, {
        user_id: userId,
        id: userId,
        expires_at: expiresAt,
        created_at: createdAt,
        login: user?.login ?? "testuser",
        name: user?.name ?? null,
        email: user?.email ?? null,
        business_id: user?.business_id,
      });
      return { success: true };
    }

    if (this.query.includes("INSERT INTO session_completions")) {
      const id = this.boundValues[0] as string;
      if (!this.db.sessionCompletions.has(`${this.boundValues[1]}:${this.boundValues[2]}`)) {
        this.db.sessionCompletions.set(`${this.boundValues[1]}:${this.boundValues[2]}`, {
          id,
          session_id: this.boundValues[1] as string,
          prompt_id: this.boundValues[2] as string,
        });
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE session_completions")) {
      return { success: true };
    }

    if (this.query.includes("INSERT INTO cli_tokens")) {
      // insertCliTokenIfBelowLimit collapses the cap check and the insert into a
      // single `INSERT ... SELECT ... WHERE (SELECT COUNT(*) ...) < ?` statement
      // and keys success on meta.changes === 1. Emulate that guard here: count
      // the user's active (non-revoked, non-expired) tokens and only insert when
      // below maxActive, returning meta.changes so the route maps 0 -> 409.
      const [userId, tokenHash, tokenPrefix, scope, createdAt, expiresAt, countUserId, nowMs, maxActive] = this
        .boundValues as [number, string, string, "read" | "write", number, number | null, number, number, number];
      const activeCount = [...this.db.cliTokens.values()].filter(
        (token) =>
          token.user_id === (countUserId ?? userId) &&
          token.revoked_at === null &&
          (token.expires_at == null || token.expires_at > nowMs),
      ).length;
      if (maxActive != null && activeCount >= maxActive) {
        return { success: true, meta: { changes: 0 } } as unknown as { success: true };
      }
      const id = this.db.allocateCliTokenId();
      this.db.cliTokens.set(id, {
        id,
        user_id: userId,
        token_hash: tokenHash,
        token_prefix: tokenPrefix,
        scope,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null,
        last_used_at: null,
      });
      return { success: true, meta: { changes: 1, last_row_id: id } } as unknown as { success: true };
    }

    if (this.query.includes("UPDATE cli_tokens SET last_used_at")) {
      const [lastUsedAt, tokenId] = this.boundValues as [number, number];
      const token = this.db.cliTokens.get(tokenId);
      if (token) token.last_used_at = lastUsedAt;
      return { success: true };
    }

    if (this.query.includes("UPDATE cli_tokens SET revoked_at")) {
      const [revokedAt, tokenId, userId] = this.boundValues as [number, number, number];
      const token = this.db.cliTokens.get(tokenId);
      if (token && token.user_id === userId) token.revoked_at = revokedAt;
      return { success: true };
    }

    if (this.query.includes("DELETE FROM cli_tokens")) {
      if (this.query.includes("expires_at IS NOT NULL")) {
        const [userId, now] = this.boundValues as [number, number];
        for (const [tokenId, token] of this.db.cliTokens.entries()) {
          if (token.user_id !== userId) continue;
          if (token.revoked_at !== null) continue;
          if (token.expires_at === null || token.expires_at > now) continue;
          this.db.cliTokens.delete(tokenId);
        }
        return { success: true };
      }
      const [tokenId, userId] = this.boundValues as [number, number];
      const token = this.db.cliTokens.get(tokenId);
      if (token && token.user_id === userId) this.db.cliTokens.delete(tokenId);
      return { success: true };
    }

    if (this.query.includes("INSERT INTO prompt_runs")) {
      const id = this.boundValues[0] as string;
      if (!this.db.promptRuns.has(id)) {
        this.db.promptRuns.set(id, {
          id,
          session_id: this.boundValues[1] as string,
          prompt_id: this.boundValues[2] as string,
          owner_user_id: this.boundValues[3] as string,
          business_id:
            this.boundValues[4] ?? this.db.sessionIndex.get(this.boundValues[1] as string)?.business_id ?? null,
          sandbox_id: this.boundValues[5],
          modal_object_id: this.boundValues[6],
          repo: this.boundValues[7],
          model: this.boundValues[8],
          agent: this.boundValues[9],
          source: this.boundValues[10],
          outcome: this.boundValues[11],
          error_code: this.boundValues[12],
          input_tokens: this.boundValues[13],
          output_tokens: this.boundValues[14],
          cost_usd: this.boundValues[15],
          duration_ms: this.boundValues[16],
          tool_call_count: this.boundValues[17],
          dd_trace_id: this.boundValues[18],
          bt_span_id: this.boundValues[19],
          created_at: this.boundValues[20],
          completed_at: this.boundValues[21],
          error_details_json: this.boundValues[22],
        });
      }
      return { success: true };
    }

    if (this.query.includes("INSERT OR IGNORE INTO integration_lifecycle_events")) {
      const [
        id,
        businessId,
        userId,
        sessionId,
        integrationId,
        stage,
        status,
        reasonCode,
        message,
        detailsJson,
        latencyMs,
        createdAt,
      ] = this.boundValues as [
        string,
        string | null,
        number | null,
        string | null,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        number,
        number,
      ];
      this.db.integrationLifecycleEvents.set(id, {
        id,
        business_id: businessId,
        user_id: userId,
        session_id: sessionId,
        integration_id: integrationId,
        stage,
        status,
        reason_code: reasonCode,
        message,
        details_json: detailsJson,
        latency_ms: latencyMs,
        created_at: createdAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("INSERT OR IGNORE INTO managed_pr_comments")) {
      const [
        repoOwner,
        repoName,
        installationId,
        prNumber,
        kind,
        prUrl,
        ownerSessionId,
        bodyHash,
        promptId,
        headSha,
        state,
        stateRank,
        leaseOwner,
        leaseExpiresAt,
        createdAt,
        updatedAt,
      ] = this.boundValues as [
        string,
        string,
        number,
        number,
        string,
        string,
        string | null,
        string,
        string | null,
        string | null,
        string,
        number,
        string,
        number,
        number,
        number,
      ];
      const key = this.db.managedPrCommentKey(repoOwner, repoName, installationId, prNumber, kind);
      if (this.db.managedPrComments.has(key)) return { success: true, meta: { changes: 0 } };
      this.db.managedPrComments.set(key, {
        repo_owner: repoOwner,
        repo_name: repoName,
        installation_id: installationId,
        pr_number: prNumber,
        kind,
        pr_url: prUrl,
        owner_session_id: ownerSessionId,
        comment_id: null,
        body_hash: bodyHash,
        prompt_id: promptId,
        head_sha: headSha,
        state,
        state_rank: stateRank,
        lease_owner: leaseOwner,
        lease_expires_at: leaseExpiresAt,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("UPDATE managed_pr_comments") && this.query.includes("SET comment_id")) {
      const [commentId, bodyHash, updatedAt, repoOwner, repoName, installationId, prNumber, kind, leaseOwner] = this
        .boundValues as [number, string, number, string, string, number, number, string, string];
      const row = this.db.managedPrComments.get(
        this.db.managedPrCommentKey(repoOwner, repoName, installationId, prNumber, kind),
      );
      if (!row || row.lease_owner !== leaseOwner) return { success: true, meta: { changes: 0 } };
      row.comment_id = commentId;
      row.body_hash = bodyHash;
      row.lease_owner = null;
      row.lease_expires_at = 0;
      row.updated_at = updatedAt;
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("UPDATE managed_pr_comments") && this.query.includes("lease_owner = NULL")) {
      const [updatedAt, repoOwner, repoName, installationId, prNumber, kind, leaseOwner] = this.boundValues as [
        number,
        string,
        string,
        number,
        number,
        string,
        string,
      ];
      const row = this.db.managedPrComments.get(
        this.db.managedPrCommentKey(repoOwner, repoName, installationId, prNumber, kind),
      );
      if (!row || row.lease_owner !== leaseOwner) return { success: true, meta: { changes: 0 } };
      row.lease_owner = null;
      row.lease_expires_at = 0;
      row.updated_at = updatedAt;
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("UPDATE managed_pr_comments") && this.query.includes("state_rank <")) {
      const [
        prUrl,
        inputStateForOwner,
        metadataOwnerSessionId,
        ownerSessionId,
        bodyHash,
        promptId,
        headSha,
        inputStateForState,
        state,
        inputStateForRank,
        stateRank,
        leaseOwner,
        leaseExpiresAt,
        updatedAt,
        repoOwner,
        repoName,
        installationId,
        prNumber,
        kind,
        now,
        currentLeaseOwner,
        inputStateForGuard,
        stateRankGuardLess,
        stateRankGuardEqual,
        promptIdGuardNull,
        promptIdGuard,
        headShaGuardNull,
        headShaGuard,
      ] = this.boundValues as [
        string,
        string,
        string | null,
        string | null,
        string,
        string | null,
        string | null,
        string,
        string,
        string,
        number,
        string,
        number,
        number,
        string,
        string,
        number,
        number,
        string,
        number,
        string,
        string,
        number,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      const row = this.db.managedPrComments.get(
        this.db.managedPrCommentKey(repoOwner, repoName, installationId, prNumber, kind),
      );
      if (!row) return { success: true, meta: { changes: 0 } };
      const leaseAvailable =
        row.lease_owner === null || row.lease_expires_at <= now || row.lease_owner === currentLeaseOwner;
      const rankAllows =
        inputStateForGuard === "metadata" ||
        row.state_rank < stateRankGuardLess ||
        (row.state_rank === stateRankGuardEqual &&
          (promptIdGuardNull === null || row.prompt_id === null || row.prompt_id === promptIdGuard) &&
          (headShaGuardNull === null || row.head_sha === null || row.head_sha === headShaGuard));
      if (!leaseAvailable || !rankAllows) return { success: true, meta: { changes: 0 } };
      row.pr_url = prUrl;
      row.owner_session_id =
        inputStateForOwner === "metadata"
          ? (row.owner_session_id ?? metadataOwnerSessionId)
          : (ownerSessionId ?? row.owner_session_id);
      row.body_hash = bodyHash;
      row.prompt_id = promptId ?? row.prompt_id;
      row.head_sha = headSha ?? row.head_sha;
      if (inputStateForState !== "metadata") row.state = state;
      if (inputStateForRank !== "metadata") row.state_rank = stateRank;
      row.lease_owner = leaseOwner;
      row.lease_expires_at = leaseExpiresAt;
      row.updated_at = updatedAt;
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("DELETE FROM integration_lifecycle_events")) {
      const [cutoffCreatedAt, limit] = this.boundValues as [number, number];
      const doomed = [...this.db.integrationLifecycleEvents.values()]
        .filter((row) => row.created_at < cutoffCreatedAt)
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, limit);
      for (const row of doomed) {
        this.db.integrationLifecycleEvents.delete(row.id);
      }
      return { success: true, meta: { changes: doomed.length } };
    }

    if (this.query.includes("UPDATE pending_signups") && this.query.includes("SET denied_at")) {
      const [denied_at, denied_by_user_id, id] = this.boundValues as [number, number, number];
      const row = this.db.pendingSignups.get(id);
      if (!row || row.denied_at !== null) {
        return { success: true, meta: { changes: 0 } };
      }
      row.denied_at = denied_at;
      row.denied_by_user_id = denied_by_user_id;
      return { success: true, meta: { changes: 1 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    const bootstrapRead = readFakeLinearBootstrapJob(this.db, this.query, this.boundValues);
    if (bootstrapRead) return { results: bootstrapRead.rows };

    if (this.query.includes("FROM pr_coordination_events")) {
      return { results: [] };
    }

    if (
      this.query.includes("SELECT session_id, prompt_id, stage, attempt_count") &&
      this.query.includes("FROM slack_posts")
    ) {
      return { results: [] };
    }

    if (
      this.query.includes("SELECT runtime_sandbox_id") &&
      this.query.includes("FROM session_index") &&
      this.query.includes("runtime_sandbox_id IN")
    ) {
      // The orphan-reaper protect-set query truth-filters owners by runtime_state
      // (only non-terminal owners shield). Mirror that filter when present, and
      // ignore any non-id bindings (e.g. a trailing nowMs) for the wanted set.
      const restrictRunningPaused = this.query.includes("runtime_state IN ('running', 'paused')");
      const wanted = new Set((this.boundValues as Array<string | number>).filter((v) => typeof v === "string"));
      return {
        results: [...this.db.sessionIndex.values()]
          .filter((row) => {
            const runtimeProvider = (row as FakeSessionIndexRow & { runtime_provider?: string }).runtime_provider;
            if (!wanted.has(row.runtime_sandbox_id ?? "") || runtimeProvider !== "e2b") return false;
            if (restrictRunningPaused && row.runtime_state !== "running" && row.runtime_state !== "paused") {
              return false;
            }
            return true;
          })
          .map((row) => ({
            runtime_sandbox_id: row.runtime_sandbox_id,
            runtime_backend: row.runtime_backend,
            session_id: row.session_id,
            runtime_state: row.runtime_state,
          })),
      };
    }

    if (this.query.includes("FROM jira_user_sites")) {
      const [userId] = this.boundValues as [number];
      const row = this.db.jiraUserSites.get(Number(userId));
      return { results: row ? [{ ...row }] : [] };
    }

    if (this.query.includes("FROM slack_workspaces") && this.query.includes("business_id = ?")) {
      const [businessId] = this.boundValues as [string];
      const rows = [...this.db.slackWorkspaces.values()].filter(
        (row) =>
          row.business_id === businessId &&
          (!this.query.includes("uninstalled_at IS NULL") || row.uninstalled_at === null),
      );
      return { results: rows.map((row) => ({ ...row })) };
    }

    if (this.query.includes("FROM user_settings") && this.query.includes("user_id IN")) {
      const userIds = new Set((this.boundValues as Array<number | string>).map((value) => Number(value)));
      return {
        results: [...this.db.userSettings.values()]
          .filter((row) => userIds.has(row.user_id))
          .map((row) => ({ ...row })),
      };
    }

    if (this.query.includes("FROM session_webhook_refs")) {
      const [source, externalRef] = this.boundValues as [string, string];
      const key = `${source}:${externalRef}`;
      const sessionIds = [...(this.db.sessionWebhookRefs.get(key) || new Set<string>())].sort();
      return { results: sessionIds.map((sessionId) => ({ session_id: sessionId })) };
    }

    if (this.query.includes("COUNT(*)") && this.query.includes("GROUP BY status")) {
      const counts = new Map<string, number>();
      for (const row of this.db.sessionIndex.values()) {
        counts.set(row.status, (counts.get(row.status) || 0) + 1);
      }
      return {
        results: [...counts.entries()].map(([status, count]) => ({ status, count })),
      };
    }

    if (this.query.includes("COUNT(*) AS user_total")) {
      const [businessId] = this.boundValues as [string];
      let count = 0;
      for (const member of this.db.businessMembers.values()) {
        if (member.business_id !== businessId) continue;
        const user = this.db.getUserById(member.user_id);
        if (user?.business_id === businessId) count += 1;
      }
      return { results: [{ user_total: count }] };
    }

    if (this.query.includes("COUNT(*) AS active_sessions")) {
      const [businessId, runtimeBackend] = this.boundValues as [string, string];
      const count = [...this.db.sessionIndex.values()].filter(
        (row) =>
          row.business_id === businessId && row.runtime_backend === runtimeBackend && row.runtime_state === "running",
      ).length;
      return { results: [{ active_sessions: count }] };
    }

    if (
      this.query.includes("SELECT si.session_id") &&
      this.query.includes("FROM session_index si") &&
      this.query.includes("si.session_id IN")
    ) {
      const [businessId, runtimeBackend, ...sessionIds] = this.boundValues as [string, string, ...string[]];
      const wanted = new Set(sessionIds);
      const rows = [...this.db.sessionIndex.values()].filter(
        (row) => wanted.has(row.session_id) && row.business_id === businessId && row.runtime_backend === runtimeBackend,
      );
      return {
        results: rows.map((row) => ({
          session_id: row.session_id,
          repo_owner: row.repo_owner,
          repo_name: row.repo_name,
          status: row.status,
          runtime_state: row.runtime_state,
          runtime_sandbox_id: row.runtime_sandbox_id,
          runtime_template_id: row.runtime_template_id,
          runtime_live_lease_expires_at: row.runtime_live_lease_expires_at,
          owner_login: this.db.getUserById(Number(row.owner_user_id))?.login ?? null,
        })),
      };
    }

    if (
      this.query.includes("SELECT si.session_id") &&
      this.query.includes("FROM session_index si") &&
      this.query.includes("si.runtime_backend")
    ) {
      const [businessId, runtimeBackend, limit] = this.boundValues as [string, string, number];
      const rows = [...this.db.sessionIndex.values()]
        .filter(
          (row) =>
            row.business_id === businessId &&
            row.runtime_backend === runtimeBackend &&
            (!this.query.includes("si.runtime_state = 'running'") || row.runtime_state === "running"),
        )
        .sort((a, b) => {
          const cmp = b.updated_at.localeCompare(a.updated_at);
          return cmp !== 0 ? cmp : b.session_id.localeCompare(a.session_id);
        })
        .slice(0, limit);
      return {
        results: rows.map((row) => ({
          session_id: row.session_id,
          repo_owner: row.repo_owner,
          repo_name: row.repo_name,
          status: row.status,
          runtime_state: row.runtime_state,
          runtime_sandbox_id: row.runtime_sandbox_id,
          runtime_template_id: row.runtime_template_id,
          runtime_live_lease_expires_at: row.runtime_live_lease_expires_at,
          owner_login: this.db.getUserById(Number(row.owner_user_id))?.login ?? null,
        })),
      };
    }

    if (
      this.query.includes("SELECT session_id") &&
      this.query.includes("FROM session_index") &&
      this.query.includes("runtime_backend") &&
      this.query.includes("session_id IN")
    ) {
      const [businessId, runtimeBackend, ...sessionIds] = this.boundValues as [string, string, ...string[]];
      return {
        results: sessionIds
          .map((sessionId) => this.db.sessionIndex.get(sessionId))
          .filter((row): row is FakeSessionIndexRow =>
            Boolean(row && row.business_id === businessId && row.runtime_backend === runtimeBackend),
          )
          .map((row) => ({ session_id: row.session_id })),
      };
    }

    if (
      this.query.includes("SELECT session_id, status, rich_status") &&
      this.query.includes("FROM session_index") &&
      this.query.includes("session_id IN")
    ) {
      const sessionIds = this.boundValues as string[];
      return {
        results: sessionIds
          .map((sessionId) => this.db.sessionIndex.get(sessionId))
          .filter((row): row is FakeSessionIndexRow => Boolean(row))
          .map((row) => ({ session_id: row.session_id, status: row.status, rich_status: row.rich_status ?? null })),
      };
    }

    if (this.query.includes("FROM session_index")) {
      const rows = [...this.db.sessionIndex.values()];
      let filtered = rows;

      // Parse bound values positionally based on query placeholders
      let paramIdx = 0;

      // Owner filter: IN (...) or owner_user_id = ?
      if (this.query.includes("owner_user_id IN")) {
        const placeholderMatch = this.query.match(/IN\s*\(([^)]+)\)/);
        const placeholderCount = placeholderMatch ? placeholderMatch[1].split(",").length : 0;
        const ownerIds = this.boundValues.slice(paramIdx, paramIdx + placeholderCount) as string[];
        paramIdx += placeholderCount;
        filtered = filtered.filter((r) => ownerIds.includes(String(r.owner_user_id)));
      } else if (this.query.includes("owner_user_id = ?")) {
        const ownerUserId = this.boundValues[paramIdx++] as string;
        filtered = filtered.filter((row) => String(row.owner_user_id) === String(ownerUserId));
      }

      // Status filter pushed into SQL
      if (this.query.includes("status != 'closed'") && this.query.includes("status != 'archived'")) {
        filtered = filtered.filter((row) => !this.isArchivedRow(row));
      }
      if (this.query.includes("(s.status = 'closed' OR s.status = 'archived')")) {
        filtered = filtered.filter((row) => this.isArchivedRow(row));
      }

      // Rich status filters
      if (this.query.includes("s.rich_status = 'idle' OR (s.rich_status IS NULL AND s.status = 'active')")) {
        filtered = filtered.filter((row) => {
          const derived = row.rich_status ?? (row.status === "active" ? "idle" : row.status);
          return derived === "idle";
        });
      } else if (this.query.includes("s.rich_status = ?")) {
        const richStatus = this.boundValues[paramIdx++] as string;
        filtered = filtered.filter((row) => {
          const derived = row.rich_status ?? (row.status === "active" ? "idle" : row.status);
          return derived === richStatus;
        });
      }

      // Cursor condition
      if (this.query.includes("(s.updated_at < ? OR (s.updated_at = ? AND s.session_id < ?))")) {
        const cursorUpdatedAt = this.boundValues[paramIdx++] as string;
        paramIdx++; // skip duplicate updated_at bind
        const cursorSessionId = this.boundValues[paramIdx++] as string;
        filtered = filtered.filter(
          (row) =>
            row.updated_at < cursorUpdatedAt ||
            (row.updated_at === cursorUpdatedAt && row.session_id < cursorSessionId),
        );
      }

      filtered.sort((a, b) => {
        const cmp = b.updated_at.localeCompare(a.updated_at);
        return cmp !== 0 ? cmp : b.session_id.localeCompare(a.session_id);
      });

      // LIMIT
      if (this.query.includes("LIMIT ?")) {
        const limit = this.boundValues[this.boundValues.length - 1] as number;
        filtered = filtered.slice(0, limit);
      }

      return {
        results: filtered.map((row) => ({
          session_id: row.session_id,
          owner_user_id: row.owner_user_id,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          closed_at: row.closed_at,
          last_event_id: row.last_event_id,
          rich_status: row.rich_status,
        })),
      };
    }

    if (this.query.includes("FROM users u") && this.query.includes("LEFT JOIN business_members")) {
      const [businessId, _businessIdIgnored, userIdRaw] = this.boundValues as [string, string, number | string];
      const userId = Number(userIdRaw);
      const user = this.db.getUserById(userId);
      const membership = this.db.businessMembers.get(userId);
      if (!user) return { results: [] };
      return {
        results: [
          {
            avatar_url: user.avatar_url ?? null,
            github_id: user.github_id ?? null,
            business_id: user.business_id ?? null,
            business_role: membership?.business_id === businessId ? membership.role : null,
          },
        ],
      };
    }

    // getBusinessMembers: SELECT id FROM users WHERE business_id = ?
    if (this.query.includes("FROM users WHERE business_id")) {
      const [businessId] = this.boundValues as [string];
      const results: Array<{ id: number }> = [];
      for (const member of this.db.businessMembers.values()) {
        if (member.business_id === businessId) {
          results.push({ id: member.user_id });
        }
      }
      return { results };
    }

    if (this.query.includes("SELECT external_user_id AS jira_account_id")) {
      const [integrationUserIdRaw, siteUserIdRaw] = this.boundValues as [number | string, number | string];
      const accountIds = new Set<string>();
      const integration = this.db.userIntegrations.get(`${Number(integrationUserIdRaw)}:jira`);
      if (
        typeof integration?.external_user_id === "string" &&
        integration.external_user_id &&
        integration.external_user_id !== "unknown"
      ) {
        accountIds.add(integration.external_user_id);
      }
      const site = this.db.jiraUserSites.get(Number(siteUserIdRaw));
      if (typeof site?.jira_account_id === "string" && site.jira_account_id && site.jira_account_id !== "unknown") {
        accountIds.add(site.jira_account_id);
      }
      return { results: [...accountIds].map((jiraAccountId) => ({ jira_account_id: jiraAccountId })) };
    }

    // user_integrations queries
    if (this.query.includes("FROM user_integrations")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const userId = Number(userIdRaw);
      const results = [...this.db.userIntegrations.values()]
        .filter((row) => row.user_id === userId)
        .map((row) => ({
          integration_id: row.integration_id,
          oauth_access_token: row.oauth_access_token,
          oauth_refresh_token: row.oauth_refresh_token,
          oauth_expires_at: row.oauth_expires_at,
          has_oauth_token: row.oauth_access_token ? 1 : 0,
          has_external_id: row.external_user_id ? 1 : 0,
          api_key: row.api_key,
          external_user_id: row.external_user_id,
          service_url: row.service_url,
          encrypted: row.encrypted,
          last_validated_at: row.last_validated_at,
          last_validation_status: row.last_validation_status,
          last_validation_reason_code: row.last_validation_reason_code,
        }));
      if (!results.some((row) => row.integration_id === "openai")) {
        results.push({
          integration_id: "openai",
          oauth_access_token: null,
          oauth_refresh_token: null,
          oauth_expires_at: null,
          has_oauth_token: 0,
          has_external_id: 0,
          api_key: "sk-openai-test",
          external_user_id: null,
          service_url: null,
          encrypted: 0,
          last_validated_at: Date.now(),
          last_validation_status: "validated",
          last_validation_reason_code: null,
        });
      }
      return { results };
    }

    // business_members queries
    if (this.query.includes("FROM business_members")) {
      if (this.query.includes("SELECT business_id") && this.query.includes("WHERE user_id")) {
        const [userIdRaw] = this.boundValues as [number | string];
        const userId = Number(userIdRaw);
        const membership = this.db.businessMembers.get(userId);
        return { results: membership ? [{ business_id: membership.business_id }] : [] };
      }
      if (this.query.includes("WHERE business_id")) {
        const [businessId] = this.boundValues as [string];
        const results: Array<Record<string, unknown>> = [];
        for (const member of this.db.businessMembers.values()) {
          if (member.business_id === businessId) {
            results.push({ user_id: member.user_id, role: member.role });
          }
        }
        return { results };
      }
      return { results: [] };
    }

    // business_integrations queries
    if (this.query.includes("FROM business_integrations")) {
      const [businessId] = this.boundValues as [string];
      const rows = [...this.db.businessIntegrations.values()]
        .filter((row) => row.business_id === businessId)
        .map((row) => ({ integration_id: row.integration_id, scope: row.scope }));
      return { results: rows };
    }

    // business_integration_credentials queries (onboarding status)
    if (this.query.includes("FROM business_integration_credentials")) {
      const [businessId] = this.boundValues as [string];
      const results = [...this.db.businessIntegrationCredentials.values()].filter(
        (row) => row.business_id === businessId,
      );
      return { results };
    }

    // github_installations queries (onboarding status)
    if (this.query.includes("FROM github_installations")) {
      const [ownerLogin] = this.boundValues as [string];
      const row = this.db.githubInstallations.get(ownerLogin);
      return { results: row ? [row] : [] };
    }

    if (this.query.includes("FROM session_completions")) {
      return { results: [...this.db.sessionCompletions.values()] };
    }

    if (this.query.includes("FROM cli_tokens")) {
      // listCliTokensByUser: SELECT ... FROM cli_tokens WHERE user_id = ? ORDER BY id DESC LIMIT ?
      const tokens = [...this.db.cliTokens.values()];
      let filtered = tokens;
      let paramIdx = 0;
      const userId = this.boundValues[paramIdx++] as number;
      filtered = filtered.filter((t) => t.user_id === userId);
      if (this.query.includes("AND id < ?")) {
        const cursorId = this.boundValues[paramIdx++] as number;
        filtered = filtered.filter((t) => t.id < cursorId);
      }
      const limit = this.boundValues[paramIdx] as number;
      filtered.sort((a, b) => b.id - a.id);
      filtered = filtered.slice(0, limit);
      return {
        results: filtered.map((t) => ({
          id: t.id,
          token_prefix: t.token_prefix,
          scope: t.scope,
          created_at: t.created_at,
          expires_at: t.expires_at,
          revoked_at: t.revoked_at,
          last_used_at: t.last_used_at,
        })),
      };
    }

    // prompt_runs queries — apply all filters from bound params
    if (this.query.includes("FROM prompt_runs")) {
      let rows = [...this.db.promptRuns.values()];
      // Parse bound params by matching ? placeholders to filters in query
      let paramIdx = 0;
      if (this.query.includes("owner_user_id = ?")) {
        const ownerUserId = this.boundValues[paramIdx++] as string;
        rows = rows.filter((r) => r.owner_user_id === ownerUserId);
      }
      // Handle business subquery: skip the two params (userId and businessId)
      if (this.query.includes("owner_user_id IN (SELECT")) {
        paramIdx += 2;
      }
      if (this.query.includes("session_id = ?")) {
        const sessionId = this.boundValues[paramIdx++] as string;
        rows = rows.filter((r) => r.session_id === sessionId);
      }
      return { results: rows };
    }

    if (this.query.includes("FROM pending_signups") && this.query.includes("WHERE denied_at IS NULL")) {
      const open = [...this.db.pendingSignups.values()]
        .filter((row) => row.denied_at === null)
        .sort((a, b) => a.requested_at - b.requested_at);
      return { results: open as unknown as Array<Record<string, unknown>> };
    }

    if (this.query.includes("FROM memory_facts_fts") || this.query.includes("FROM memory_takes_fts")) {
      return { results: [] };
    }

    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async first(): Promise<Record<string, unknown> | null> {
    const bootstrapRead = readFakeLinearBootstrapJob(this.db, this.query, this.boundValues);
    if (bootstrapRead) return bootstrapRead.rows[0] ?? null;

    if (this.query.includes("SELECT MIN(COALESCE(next_attempt_at, created_at)) AS next_attempt_at")) {
      return null;
    }

    if (this.query.includes("FROM pr_coordination")) {
      const [sessionId] = this.boundValues as [string];
      const row = this.db.prCoordination.get(sessionId);
      return row ? { ...row } : null;
    }

    if (this.query.includes("FROM qa_loop_session_bindings")) {
      return null;
    }

    if (this.query.includes("FROM github_installations")) {
      const [ownerLogin] = this.boundValues as [string];
      return this.db.githubInstallations.get(ownerLogin) ?? null;
    }

    if (this.query.includes("FROM durable_event_replay_metadata")) {
      const [sessionId] = this.boundValues as [string];
      return (this.db.replay.get(sessionId) as unknown as Record<string, unknown>) ?? null;
    }

    if (this.query.includes("FROM slack_thread_session_refs")) {
      const [businessId, teamId, channelId, threadTs] =
        this.boundValues.length >= 4
          ? (this.boundValues as [string, string, string, string])
          : ([null, null, ...this.boundValues] as [null, null, string, string]);
      const key = `${channelId}:${threadTs}`;
      const scopedKey = businessId && teamId ? `${businessId}:${teamId}:${channelId}:${threadTs}` : key;
      const sessionId = this.db.slackThreadSessionRefs.get(scopedKey) ?? this.db.slackThreadSessionRefs.get(key);
      return sessionId ? { session_id: sessionId } : null;
    }

    if (this.query.includes("FROM slack_workspaces")) {
      if (this.query.includes("business_id = ?")) {
        const [businessId] = this.boundValues as [string];
        const row = [...this.db.slackWorkspaces.values()].find(
          (candidate) =>
            candidate.business_id === businessId &&
            (!this.query.includes("uninstalled_at IS NULL") || candidate.uninstalled_at === null),
        );
        return row ? { ...row } : null;
      }
      const [teamId] = this.boundValues as [string];
      const row = this.db.slackWorkspaces.get(teamId);
      return row ? { ...row } : null;
    }

    if (this.query.includes("FROM slack_channel_intake")) {
      return null;
    }

    if (this.query.includes("FROM session_index")) {
      const [sessionId] = this.boundValues as [string];
      const row = this.db.sessionIndex.get(sessionId);
      return row ? { session_id: row.session_id } : null;
    }

    if (this.query.includes("FROM linear_issue_session_refs")) {
      const [linearIssueId] = this.boundValues as [string];
      const sessionId = this.db.linearIssueSessionRefs.get(linearIssueId);
      return sessionId ? { session_id: sessionId } : null;
    }

    if (this.query.includes("FROM linear_webhook_installations")) {
      const [linearOrganizationId] = this.boundValues as [string];
      const row = [...this.db.linearWebhookInstallations.values()].find(
        (candidate) => candidate.linear_organization_id === linearOrganizationId && candidate.status === "active",
      );
      return row ? { ...row } : null;
    }

    if (this.query.includes("SELECT id, scope FROM cli_tokens WHERE id = ? AND user_id = ?")) {
      const [tokenId, userId] = this.boundValues as [number, number];
      const token = this.db.cliTokens.get(tokenId);
      if (!token || token.user_id !== userId || token.revoked_at !== null) return null;
      return { id: token.id, scope: token.scope };
    }

    if (this.query.includes("FROM cli_tokens") && this.query.includes("INNER JOIN users")) {
      const [tokenHash, now] = this.boundValues as [string, number];
      for (const ct of this.db.cliTokens.values()) {
        if (ct.token_hash !== tokenHash) continue;
        if (ct.revoked_at !== null) continue;
        if (ct.expires_at !== null && ct.expires_at <= now) continue;
        const user =
          this.db.getUserById(ct.user_id) ??
          [...this.db.users.values()].find((candidate) => candidate.id === ct.user_id);
        if (!user) continue;
        const businessId = user.business_id ?? this.db.businessMembers.get(ct.user_id)?.business_id;
        const business = businessId ? this.db.businesses.get(businessId) : null;
        if (!businessId || !business) continue;
        const membership = this.db.businessMembers.get(ct.user_id);
        return {
          token_id: ct.id,
          scope: ct.scope,
          id: user.id,
          login: user.login,
          name: user.name ?? null,
          email: user.email ?? null,
          business_id: businessId,
          business_role: membership?.business_id === businessId ? membership.role : null,
          shared_sessions: business.shared_sessions,
        };
      }
      return null;
    }

    if (this.query.includes("SELECT 1 AS active FROM auth_sessions")) {
      const [token, now] = this.boundValues as [string, number];
      const session = this.db.authTokens.get(token);
      return session && session.expires_at > now ? { active: 1 } : null;
    }

    if (this.query.includes("FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      const user = this.db.authTokens.get(token);
      const membership = user ? this.db.businessMembers.get(user.id) : null;
      return user
        ? {
            ...user,
            business_role: membership?.business_id === user.business_id ? membership.role : null,
          }
        : null;
    }

    if (this.query.includes("FROM users WHERE github_id")) {
      const [githubId] = this.boundValues as [number];
      const user = this.db.getUserByGithubId(githubId);
      return user
        ? {
            id: user.id,
            login: user.login,
          }
        : null;
    }

    if (this.query.includes("FROM users WHERE id")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const userId = Number(userIdRaw);
      const user =
        this.db.getUserById(userId) ?? [...this.db.authTokens.values()].find((candidate) => candidate.id === userId);
      if (!user && this.query.includes("business_id")) {
        return { business_id: "biz-1" };
      }
      if (!user) return null;
      if (this.query.includes("business_id")) {
        return {
          github_id: "github_id" in user ? user.github_id : null,
          business_id: user.business_id ?? null,
        };
      }
      return {
        login: user.login,
        name: "name" in user ? user.name : null,
        email: "email" in user ? user.email : null,
      };
    }

    if (this.query.includes("SELECT business_id FROM session_index WHERE session_id = ?")) {
      const [sessionId] = this.boundValues as [string];
      const session = this.db.sessionIndex.get(sessionId);
      return session ? { business_id: session.business_id } : null;
    }

    if (this.query.includes("FROM users WHERE slack_user_id")) {
      const [slackUserId] = this.boundValues as [string];
      for (const user of this.db.users.values()) {
        if ((user as Record<string, unknown>).slack_user_id === slackUserId) {
          return { id: user.id, login: user.login };
        }
      }
      return null;
    }

    if (this.query.includes("FROM user_settings WHERE user_id")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const userId = Number(userIdRaw);
      const seededSettings = this.db.userSettings.get(userId);
      return seededSettings ? { ...seededSettings } : null;
    }

    // user_integrations queries (integrations/db.ts + integrations/service.ts)
    if (this.query.includes("FROM user_integrations") && this.query.includes("INNER JOIN users")) {
      // getUserByExternalId: SELECT u.id, u.login FROM user_integrations ui INNER JOIN users u ...
      const [integrationId, externalUserId] = this.boundValues as [string, string];
      const fieldMap: Record<string, string> = { slack: "slack_user_id", linear: "linear_user_id" };
      const field = fieldMap[integrationId];
      if (field) {
        for (const user of this.db.users.values()) {
          if ((user as Record<string, unknown>)[field] === externalUserId) {
            return { id: user.id, login: user.login };
          }
        }
      }
      return null;
    }

    if (this.query.includes("FROM user_integrations") && this.query.includes("oauth_access_token")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const userId = Number(userIdRaw);
      const integrationId =
        (this.boundValues[1] as string | undefined) ?? /integration_id = '(\w+)'/.exec(this.query)?.[1];
      const row = integrationId ? this.db.userIntegrations.get(`${userId}:${integrationId}`) : null;
      if (row) {
        return {
          oauth_access_token: row.oauth_access_token,
          oauth_refresh_token: row.oauth_refresh_token,
          oauth_expires_at: row.oauth_expires_at,
          api_key: row.api_key,
          external_user_id: row.external_user_id,
          service_url: row.service_url,
          encrypted: row.encrypted,
          last_validated_at: row.last_validated_at,
          last_validation_status: row.last_validation_status,
          last_validation_reason_code: row.last_validation_reason_code,
        };
      }
      return integrationId === "github"
        ? {
            oauth_access_token: "ghp_test",
            oauth_refresh_token: null,
            oauth_expires_at: null,
            encrypted: 0,
          }
        : null;
    }

    if (this.query.includes("FROM jira_user_sites")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const row = this.db.jiraUserSites.get(Number(userIdRaw));
      return row ? { ...row } : null;
    }

    if (this.query.includes("FROM jira_oauth_pending")) {
      const [nonce] = this.boundValues as [string];
      const row = this.db.jiraOAuthPending.get(nonce);
      return row ? { ...row } : null;
    }

    if (this.query.includes("FROM jira_webhook_installations") && this.query.includes("installation_token")) {
      const [token] = this.boundValues as [string];
      const row = [...this.db.jiraWebhookInstallations.values()].find(
        (candidate) => candidate.installation_token === token && candidate.status !== "revoked",
      );
      return row ? { ...row } : null;
    }

    if (this.query.includes("FROM jira_webhook_installations") && this.query.includes("business_id")) {
      const [businessId] = this.boundValues as [string];
      const rows = [...this.db.jiraWebhookInstallations.values()]
        .filter((candidate) => candidate.business_id === businessId)
        .sort((a, b) => {
          const aRevoked = a.status === "revoked" ? 1 : 0;
          const bRevoked = b.status === "revoked" ? 1 : 0;
          if (aRevoked !== bRevoked) return aRevoked - bRevoked;
          return (b.updated_at as number) - (a.updated_at as number);
        });
      return rows[0] ? { ...rows[0] } : null;
    }

    // getSlackExternalIdForUser: SELECT external_user_id FROM user_integrations
    // WHERE user_id = ? AND integration_id = 'slack' LIMIT 1
    if (
      this.query.includes("SELECT external_user_id FROM user_integrations") &&
      this.query.includes("integration_id = 'slack'")
    ) {
      const [userIdRaw] = this.boundValues as [number | string];
      const row = this.db.userIntegrations.get(`${Number(userIdRaw)}:slack`);
      return row?.external_user_id ? { external_user_id: row.external_user_id } : null;
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
    }

    if (this.query.includes("FROM user_integrations")) {
      return null;
    }

    if (this.query.includes("SELECT sandbox_image_version FROM repo_images")) {
      return { sandbox_image_version: null };
    }

    if (this.query.includes("COUNT(*) AS active_count") && this.query.includes("FROM cli_tokens")) {
      const [userId, now] = this.boundValues as [number, number];
      let activeCount = 0;
      for (const ct of this.db.cliTokens.values()) {
        if (ct.user_id !== userId) continue;
        if (ct.revoked_at !== null) continue;
        if (ct.expires_at !== null && ct.expires_at <= now) continue;
        activeCount++;
      }
      return { active_count: activeCount };
    }

    // business_members queries (integrations/service.ts + business/service.ts)
    if (this.query.includes("FROM business_members")) {
      if (this.query.includes("SELECT business_id") && this.query.includes("WHERE user_id")) {
        const [userIdRaw] = this.boundValues as [number | string];
        const userId = Number(userIdRaw);
        const membership = this.db.businessMembers.get(userId);
        return membership ? { business_id: membership.business_id } : null;
      }
      if (
        this.query.includes("SELECT role") &&
        this.query.includes("WHERE business_id") &&
        this.query.includes("user_id")
      ) {
        const [businessId, userIdRaw] = this.boundValues as [string, number | string];
        const userId = Number(userIdRaw);
        const membership = this.db.businessMembers.get(userId);
        return membership?.business_id === businessId ? { role: membership.role } : null;
      }
      return null;
    }

    // businesses queries (preflight)
    if (this.query.includes("FROM businesses")) {
      const [businessId] = this.boundValues as [string];
      const biz = this.db.businesses.get(businessId);
      return biz ? { id: biz.id, name: biz.id, shared_sessions: biz.shared_sessions ?? 0 } : null;
    }

    // business_integrations queries
    if (this.query.includes("FROM business_integrations")) {
      const [businessId, integrationId] = this.boundValues as [string, string | undefined];
      const row = integrationId
        ? this.db.businessIntegrations.get(`${businessId}:${integrationId}`)
        : [...this.db.businessIntegrations.values()].find((candidate) => candidate.business_id === businessId);
      return row ? { scope: row.scope } : null;
    }

    if (this.query.includes("FROM business_integration_credentials")) {
      const [businessId, integrationId] = this.boundValues as [string, string | undefined];
      if (this.query.includes("integration_id = 'sentry'")) {
        const row = this.db.businessIntegrationCredentials.get(`${businessId}:sentry`);
        if (!row) return null;
        if (this.query.includes("oauth_access_token IS NOT NULL") && !row.oauth_access_token) return null;
        return row as unknown as Record<string, unknown>;
      }
      const row = integrationId
        ? this.db.businessIntegrationCredentials.get(`${businessId}:${integrationId}`)
        : [...this.db.businessIntegrationCredentials.values()].find(
            (candidate) => candidate.business_id === businessId,
          );
      return row ? (row as unknown as Record<string, unknown>) : null;
    }

    if (this.query.includes("FROM env_blobs b") && this.query.includes("INNER JOIN env_blob_repos")) {
      return null;
    }

    if (this.query.includes("FROM env_blobs") && this.query.includes("is_global = 1")) {
      return null;
    }

    if (this.query.includes("sandbox_layer_sources")) {
      return null;
    }

    if (this.query.includes("FROM pending_signups WHERE github_id")) {
      const [githubId] = this.boundValues as [number];
      for (const row of this.db.pendingSignups.values()) {
        if (row.github_id === githubId) return row as unknown as Record<string, unknown>;
      }
      return null;
    }

    if (this.query.includes("FROM pending_signups WHERE id")) {
      const [id] = this.boundValues as [number];
      const row = this.db.pendingSignups.get(id);
      return row ? (row as unknown as Record<string, unknown>) : null;
    }

    if (this.query.startsWith("INSERT INTO pending_signups") && this.query.includes("ON CONFLICT")) {
      const [github_id, login, name, email, avatar_url, requested_at] = this.boundValues as [
        number,
        string,
        string | null,
        string | null,
        string | null,
        number,
      ];
      for (const row of this.db.pendingSignups.values()) {
        if (row.github_id === github_id) {
          row.login = login;
          row.name = name;
          row.email = email;
          row.avatar_url = avatar_url;
          return { requested_at: row.requested_at } as Record<string, unknown>;
        }
      }
      const id = this.db.nextPendingSignupId++;
      this.db.pendingSignups.set(id, {
        id,
        github_id,
        login,
        name,
        email,
        avatar_url,
        requested_at,
        denied_at: null,
        denied_by_user_id: null,
      });
      return { requested_at } as Record<string, unknown>;
    }

    if (this.query.startsWith("DELETE FROM pending_signups") && this.query.includes("RETURNING")) {
      const [id] = this.boundValues as [number];
      const row = this.db.pendingSignups.get(id);
      if (!row || row.denied_at !== null) return null;
      this.db.pendingSignups.delete(id);
      return {
        github_id: row.github_id,
        login: row.login,
        name: row.name,
        email: row.email,
        avatar_url: row.avatar_url,
      } as Record<string, unknown>;
    }

    if (this.query.includes("FROM managed_pr_comments")) {
      const [repoOwner, repoName, installationId, prNumber, kind] = this.boundValues as [
        string,
        string,
        number,
        number,
        string,
      ];
      return (this.db.managedPrComments.get(
        this.db.managedPrCommentKey(repoOwner, repoName, installationId, prNumber, kind),
      ) ?? null) as Record<string, unknown> | null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

export class FakeD1 {
  readonly preparedQueries: string[] = [];
  readonly sessionIndex = new Map<string, FakeSessionIndexRow>();
  readonly replay = new Map<string, FakeReplayRow>();
  readonly sessionWebhookRefs = new Map<string, Set<string>>();
  readonly managedPrComments = new Map<string, FakeManagedPrCommentRow>();
  readonly prCoordination = new Map<string, FakePrCoordinationRow>();
  readonly slackThreadSessionRefs = new Map<string, string>();
  readonly slackWorkspaces = new Map<string, FakeSlackWorkspaceRow>();
  readonly slackLinkTokenConsumptions = new Map<string, { consumed_by_user_id: number; expires_at: number }>();
  readonly linearIssueSessionRefs = new Map<string, string>();
  readonly linearWebhookBootstrapJobs = new Map<string, FakeLinearBootstrapJobRow>();
  readonly webhookIdempotencyRows = new Map<string, Record<string, unknown>>();
  readonly authTokens = new Map<string, AuthTokenUser>();
  readonly users = new Map<number | string, FakeUserRow>();
  readonly usersById = new Map<number, FakeUserRow>();
  readonly businessMembers = new Map<number, FakeBusinessMemberRow>();
  readonly userSettings = new Map<number, FakeUserSettingsRow>();
  readonly userIntegrations = new Map<string, FakeUserIntegrationRow>();
  readonly businessIntegrations = new Map<string, FakeBusinessIntegrationRow>();
  readonly businessIntegrationCredentials = new Map<string, FakeBusinessCredentialRow>();
  readonly openAIGatewaySessionTokens = new Map<string, FakeOpenAIGatewaySessionTokenRow>();
  readonly linearWebhookInstallations = new Map<string, LinearWebhookInstallationRow>();
  readonly jiraWebhookInstallations = new Map<string, Record<string, unknown>>();
  readonly jiraUserSites = new Map<number, Record<string, unknown>>();
  readonly jiraPersonalDataReports = new Map<string, Record<string, unknown>>();
  readonly jiraOAuthPending = new Map<string, Record<string, unknown>>();
  readonly githubInstallations = new Map<string, Record<string, unknown>>();
  readonly integrationLifecycleEvents = new Map<string, FakeIntegrationLifecycleEventRow>();
  readonly promptRuns = new Map<string, Record<string, unknown>>();
  readonly sessionCompletions = new Map<string, Record<string, unknown>>();
  readonly cliTokens = new Map<
    number,
    {
      id: number;
      user_id: number;
      token_hash: string;
      token_prefix: string;
      scope: "read" | "write";
      created_at: number;
      expires_at: number | null;
      revoked_at: number | null;
      last_used_at: number | null;
    }
  >();
  readonly businesses = new Map<
    string,
    { id: string; shared_sessions: number | null; self_hosted_sandboxes_enabled?: number | null }
  >();
  readonly pendingSignups = new Map<
    number,
    {
      id: number;
      github_id: number;
      login: string;
      name: string | null;
      email: string | null;
      avatar_url: string | null;
      requested_at: number;
      denied_at: number | null;
      denied_by_user_id: number | null;
    }
  >();
  nextPendingSignupId = 1;
  private nextUserId = 1;
  private nextCliTokenId = 1;

  setAuthToken(token: string, user: AuthTokenUser): void {
    const businessId = user.business_id ?? this.getUserById(user.id)?.business_id ?? "biz-1";
    const existingBusiness = this.businesses.get(businessId);
    const sharedSessions = user.shared_sessions ?? existingBusiness?.shared_sessions ?? 0;
    const normalized = {
      ...user,
      business_id: businessId,
      shared_sessions: sharedSessions,
    };
    this.authTokens.set(token, normalized);
    if (!this.usersById.has(user.id)) {
      const seededUser: FakeUserRow = {
        id: user.id,
        login: user.login,
        name: user.name,
        email: user.email,
        business_id: businessId,
        avatar_url: null,
      };
      this.users.set(user.id, seededUser);
      this.usersById.set(user.id, seededUser);
    }
    if (!this.businesses.has(businessId)) {
      this.businesses.set(businessId, { id: businessId, shared_sessions: sharedSessions });
    }
    if (!this.businessMembers.has(user.id)) {
      this.setBusinessMembership(user.id, businessId);
    }
    this.seedProviderApiKeys(user.id);
  }

  getUserByGithubId(githubId: number): FakeUserRow | undefined {
    return this.users.get(githubId);
  }

  getUserById(userId: number): FakeUserRow | undefined {
    return this.usersById.get(userId);
  }

  setBusinessMembership(userId: number, businessId: string, role: "admin" | "member" = "member"): void {
    const now = Date.now();
    this.businessMembers.set(userId, {
      business_id: businessId,
      user_id: userId,
      role,
      created_at: now,
      updated_at: now,
    });
  }

  setUserSettings(userId: number, overrides: Partial<FakeUserSettingsRow>): void {
    const now = Date.now();
    const existing = this.userSettings.get(userId);
    this.userSettings.set(userId, {
      default_model: null,
      default_repo: null,
      plan_mode_setting: "off",
      created_at: existing?.created_at ?? now,
      ...existing,
      ...overrides,
      user_id: userId,
      updated_at: now,
    });
  }

  addUserRecord(githubId: number, overrides: Partial<FakeUserRow> & { login: string }): number {
    const id = this.nextUserId++;
    const businessId = overrides.business_id ?? "biz-1";
    const user: FakeUserRow = {
      id,
      github_id: githubId,
      login: overrides.login,
      name: overrides.name ?? null,
      email: overrides.email ?? null,
      slack_user_id: overrides.slack_user_id,
      linear_user_id: overrides.linear_user_id,
      business_id: businessId,
      avatar_url: overrides.avatar_url ?? null,
      created_at: overrides.created_at,
      updated_at: overrides.updated_at,
    };
    this.users.set(githubId, user);
    this.usersById.set(id, user);
    if (!this.businesses.has(businessId)) {
      this.businesses.set(businessId, { id: businessId, shared_sessions: null });
    }
    this.setBusinessMembership(id, businessId);
    this.seedProviderApiKeys(id);
    return id;
  }

  private seedProviderApiKeys(userId: number): void {
    const now = Date.now();
    const keys: Array<[string, string]> = [["openai", "sk-openai-test"]];
    for (const [integrationId, apiKey] of keys) {
      const key = `${userId}:${integrationId}`;
      if (this.userIntegrations.has(key)) continue;
      this.userIntegrations.set(key, {
        user_id: userId,
        integration_id: integrationId,
        oauth_access_token: null,
        oauth_refresh_token: null,
        oauth_expires_at: null,
        api_key: apiKey,
        external_user_id: null,
        service_url: null,
        encrypted: 0,
        last_validated_at: now,
        last_validation_status: "validated",
        last_validation_reason_code: null,
        connected_at: now,
        updated_at: now,
      });
    }
  }

  addUser(githubId: number, login: string): number {
    return this.addUserRecord(githubId, { login });
  }

  addSlackUser(githubId: number, login: string, slackUserId: string): number {
    return this.addUserRecord(githubId, { login, slack_user_id: slackUserId });
  }

  addLinearUser(githubId: number, login: string, linearUserId: string): number {
    return this.addUserRecord(githubId, { login, linear_user_id: linearUserId });
  }

  addLinearWebhookInstallation(
    linearOrganizationId = "lin-org-1",
    businessId = "biz-1",
    linearWebhookId: string | null = "lin-webhook-1",
    connectedByUserId = 1,
  ): void {
    const now = Date.now();
    this.linearWebhookInstallations.set(`${businessId}:${linearOrganizationId}`, {
      business_id: businessId,
      linear_organization_id: linearOrganizationId,
      linear_organization_name: null,
      linear_organization_url_key: null,
      linear_webhook_id: linearWebhookId,
      connected_by_user_id: connectedByUserId,
      status: "active",
      connected_at: now,
      updated_at: now,
      revoked_at: null,
    });
  }

  setBusinessIntegrationScope(
    businessId: string,
    integrationId: string,
    scope: "disabled" | "user" | "business",
  ): void {
    this.businessIntegrations.set(`${businessId}:${integrationId}`, {
      business_id: businessId,
      integration_id: integrationId,
      scope,
    });
  }

  addBusinessUser(githubId: number, login: string, businessId: string, sharedSessions: number | null = null): number {
    const id = this.addUserRecord(githubId, { login, business_id: businessId });
    const existing = this.businesses.get(businessId);
    this.businesses.set(businessId, {
      id: businessId,
      shared_sessions: sharedSessions ?? existing?.shared_sessions ?? null,
    });
    return id;
  }

  allocateCliTokenId(): number {
    return this.nextCliTokenId++;
  }

  managedPrCommentKey(
    repoOwner: string,
    repoName: string,
    installationId: number,
    prNumber: number,
    kind: string,
  ): string {
    return `${repoOwner}/${repoName}:${installationId}:${prNumber}:${kind}`;
  }

  prepare(query: string): FakeD1Statement {
    this.preparedQueries.push(query);
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]): Promise<Array<{ results: Array<Record<string, unknown>> }>> {
    return batchFakeD1Statements(statements);
  }
}

// -- Worker module type --

export type WorkerModule = HarnessWorkerModule;

const originalGlobalFetch = globalThis.fetch;

export function restoreSmokeTestFetchMock(): void {
  globalThis.fetch = originalGlobalFetch;
}

function getOpenAiResponseToolName(init?: RequestInit): string | null {
  if (typeof init?.body !== "string") return null;
  try {
    const body = JSON.parse(init.body) as {
      text?: { format?: { name?: unknown } };
    };
    const toolName = body.text?.format?.name;
    return typeof toolName === "string" ? toolName : null;
  } catch {
    return null;
  }
}

function isLocalOrInternalSmokeUrl(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]" ||
    url.hostname.endsWith(".test") ||
    url.hostname.endsWith(".internal")
  );
}

// -- Env factory --

export function createWorkerEnv(workerModule: WorkerModule): {
  env: Record<string, unknown>;
  db: FakeD1;
} {
  const db = new FakeD1();
  const { env } = createWorkerTestEnv(workerModule, {
    db,
    sqlStorage: true,
    envOverrides: {
      E2B_API_KEY: "test-e2b-key",
      E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-test",
    },
  });

  // Seed default GitHub App installations for common test repo owners
  seedInstallation(db, "test-owner", 1);
  seedInstallation(db, "acme", 2);
  db.addLinearWebhookInstallation();

  // Intercept provider calls so smoke tests don't require real OAuth/API tokens.
  // verifyUserRepoAccess calls api.github.com/repos/* -- without this, the fake token
  // stored in FakeD1 ("ghp_test") would produce a 401 and now correctly throws.
  // First-prompt enqueue also schedules background session-title generation via waitUntil;
  // keep that path hermetic so waitUntil flushing cannot depend on OpenAI latency.
  restoreSmokeTestFetchMock();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.startsWith("https://api.github.com/repos/")) {
      const path = new URL(url).pathname;
      if (
        /\/pulls\/\d+\/(files|commits|comments)$/.test(path) ||
        /\/issues\/\d+\/comments$/.test(path) ||
        /\/pulls\/\d+\/reviews$/.test(path) ||
        /\/commits\/[^/]+\/(check-runs|statuses)$/.test(path)
      ) {
        return Response.json([]);
      }
      if (/\/actions\/runs$/.test(path)) {
        return Response.json({ workflow_runs: [] });
      }
      const prMatch = path.match(/\/pulls\/(\d+)$/);
      if (prMatch) {
        return Response.json({
          html_url: `https://github.com/test-owner/test-repo/pull/${prMatch[1]}`,
          number: Number(prMatch[1]),
          title: "Test PR",
          body: null,
          state: "open",
          draft: false,
          mergeable: true,
          mergeable_state: "clean",
          labels: [],
          head: { ref: "feature/test", sha: "abc123", repo: { full_name: "test-owner/test-repo" } },
          base: { ref: "main" },
          user: { login: "author" },
        });
      }
      return Response.json({});
    }
    const openAiToolName = getOpenAiResponseToolName(init);
    if (url === "https://api.openai.com/v1/responses" && openAiToolName === "generate_session_title") {
      return new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ title: "Smoke test session", tags: ["smoke"] }),
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://api.openai.com/v1/responses") {
      return new Response(JSON.stringify({ error: "Unhandled OpenAI Responses smoke stub request" }), {
        status: 501,
        headers: { "content-type": "application/json" },
      });
    }
    const parsedUrl = new URL(url);
    if ((parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") && !isLocalOrInternalSmokeUrl(parsedUrl)) {
      throw new Error(`Unexpected external fetch in smoke test: ${url}`);
    }
    return originalGlobalFetch(input as RequestInfo, init);
  };

  return { env, db };
}

export { workerFetch } from "../test_cloudflare/helpers/worker-harness";

export function apiTokenHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: "Bearer admin-secret",
    "content-type": "application/json",
    ...extra,
  };
}

export function sessionTokenHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: `session_token=${token}`,
    "content-type": "application/json",
    ...extra,
  };
}

export function createGithubSignature(secret: string, body: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

export function createSlackSignature(secret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return `v0=${digest}`;
}

export function createLinearSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Seeds a GitHub App installation in the FakeD1 for the installation gate.
 */
export function seedInstallation(db: FakeD1, ownerLogin: string, installationId = 1): void {
  seedGithubInstallation(db, ownerLogin, installationId);
}

/**
 * Seeds a valid auth token in the FakeD1 for session-token auth.
 */
export function seedAuthUser(
  db: FakeD1,
  token: string,
  userId: number,
  login: string,
  email: string | null = null,
  businessId = "biz-1",
): void {
  const mutableDb = db as unknown as {
    users: Map<number, FakeUserRow>;
    usersById: Map<number, FakeUserRow>;
    businesses: Map<string, { id: string; shared_sessions: number | null }>;
    businessMembers: Map<number, FakeBusinessMemberRow>;
  };
  const now = Date.now();
  const existingUser = mutableDb.usersById.get(userId);
  if (!existingUser) {
    const user: FakeUserRow = {
      id: userId,
      github_id: userId,
      login,
      name: null,
      email,
      business_id: businessId,
      avatar_url: null,
      created_at: now,
      updated_at: now,
    };
    mutableDb.users.set(userId, user);
    mutableDb.usersById.set(userId, user);
  }
  if (!mutableDb.businesses.has(businessId)) {
    mutableDb.businesses.set(businessId, { id: businessId, shared_sessions: null });
  }
  if (!mutableDb.businessMembers.has(userId)) {
    db.setBusinessMembership(userId, businessId);
  }
  db.setAuthToken(token, {
    user_id: userId,
    id: userId,
    expires_at: Date.now() + 60_000,
    login,
    name: null,
    email,
    business_id: businessId,
  });
}
