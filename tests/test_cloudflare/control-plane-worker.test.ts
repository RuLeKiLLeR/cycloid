import { createHmac } from "node:crypto";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { REPOS_CACHE_SCHEMA_VERSION } from "../../apps/control-plane-worker/src/services/repos";
import { storeWorkspaceInstall } from "../../apps/control-plane-worker/src/slack/workspaces";
import { generateSandboxPromptCallbackToken } from "../../apps/control-plane-worker/src/utils";
import {
  type FakeLinearBootstrapJobRow,
  readFakeLinearBootstrapJob,
  runFakeLinearBootstrapJobMutation,
  runFakeLinearIssueSessionRefMutation,
} from "./helpers/fake-d1";
import { FakeSqlStorage as SharedFakeSqlStorage } from "./helpers/worker-harness";

const DEFAULT_REPO_URL = "https://github.com/test-owner/test-repo";

const e2bMocks = vi.hoisted(() => {
  class E2BSandboxRuntimeError extends Error {
    code: string;

    constructor(code: string, message = code) {
      super(message);
      this.name = "E2BSandboxRuntimeError";
      this.code = code;
    }
  }

  return {
    E2BSandboxRuntimeError,
    connectSandbox: vi.fn(async () => ({
      runtimeProvider: "e2b",
      runtimeSandboxId: "e2b-test",
      status: "running",
    })),
    createSandbox: vi.fn(async (request: { sandboxId?: string; template?: string }) => ({
      runtimeProvider: "e2b",
      runtimeSandboxId: request.sandboxId ?? "e2b-test",
      runtimeTemplateId: request.template ?? "cycloid-sandbox-test",
      status: "running",
      createdAt: Date.now(),
    })),
  };
});

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

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

vi.mock("../../apps/control-plane-worker/src/sandbox/e2b-client", () => ({
  E2BSandboxRuntimeError: e2bMocks.E2BSandboxRuntimeError,
  E2BSandboxClient: class {
    async createSandbox(request: { sandboxId?: string; template?: string }) {
      return e2bMocks.createSandbox(request);
    }

    async connectSandbox(runtimeSandboxId: string) {
      return e2bMocks.connectSandbox(runtimeSandboxId);
    }

    async startCommand() {
      return { pid: 123, startedAt: Date.now() };
    }

    async terminateSandbox() {
      return { status: "killed" };
    }
  },
}));

type DurableEntry = { type: string; timestamp: string; data: Record<string, unknown> };

type DurableObjectClass = new (
  state: unknown,
  env: unknown,
) => {
  fetch(request: Request): Promise<Response>;
};

type TestDurableObjectInstance = {
  fetch(request: Request): Promise<Response>;
  state?: FakeDurableState;
};

type TestDurableNamespace = {
  idFromName(name: string): string;
  get(id: string): { fetch(request: Request | string, init?: RequestInit): Promise<Response> };
  __getInstance(id: string): TestDurableObjectInstance | undefined;
};

type WorkerModule = {
  default: {
    fetch(request: Request, env: Record<string, unknown>, ctx?: ExecutionContext): Promise<Response>;
  };
  selectReplayWindow: (
    events: Array<Record<string, unknown>>,
    afterSequenceRaw: unknown,
    maxEvents?: number,
  ) => {
    afterSequence: number;
    events: Array<Record<string, unknown>>;
    truncated: boolean;
    droppedCount: number;
  };
  resolveReplayCursor: (queryCursorRaw: unknown, headerCursorRaw: unknown) => number;
  SessionDO: DurableObjectClass;
  SessionResumeRateLimiterDO: DurableObjectClass;
};

class FakeStorage extends SharedFakeSqlStorage {}

class FakeDurableState {
  readonly storage = new FakeStorage();
  readonly id = { toString: () => "fake-do-id" };
  blockConcurrencyWhile = async (fn: () => Promise<unknown>) => {
    await fn();
  };
  waitUntil(promise: Promise<unknown>): void {
    void promise.catch(() => undefined);
  }
}

class FakeKV {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string, type?: string): Promise<unknown> {
    const entry = this.store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = typeof options?.expirationTtl === "number" ? Date.now() + options.expirationTtl * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

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
    public model: string | null = null,
    public reasoning_effort: string | null = null,
    public runtime_backend: string | null = null,
    public runtime_provider: string | null = null,
    public runtime_state: string | null = null,
    public runtime_sandbox_id: string | null = null,
    public runtime_template_id: string | null = null,
    public runtime_state_expires_at: number | null = null,
    public runtime_live_lease_expires_at: number | null = null,
    public runtime_preview_url: string | null = null,
    public runtime_created_at: number | null = null,
    public runtime_last_resumed_at: number | null = null,
    public runtime_last_paused_at: number | null = null,
    public runtime_last_provider_refreshed_at: number | null = null,
    public runtime_provider_ttl_expires_at: number | null = null,
    public snapshot_image_id: string | null = null,
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

class FakeD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  get queryText(): string {
    return this.query;
  }

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true; meta?: { changes: number } }> {
    if (this.query.includes("INSERT INTO linear_issue_skip_notices")) {
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("DELETE FROM linear_issue_skip_notices")) {
      return { success: true, meta: { changes: 1 } };
    }

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
      if (this.db.failSessionIndexInsert) throw this.db.failSessionIndexInsert;
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
        _richStatus,
        model,
        reasoningEffort,
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
      ];

      const existing = this.db.sessionIndex.get(sessionId);
      const resolvedBusinessId =
        existing?.business_id ?? businessId ?? this.db.users.get(Number(ownerUserId))?.business_id ?? null;
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
          title,
          _richStatus,
          model ?? existing?.model ?? null,
          reasoningEffort ?? existing?.reasoning_effort ?? null,
        ),
      );
      return { success: true };
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
        this.boundValues.length === 3
          ? ([null, null, ...this.boundValues] as [null, null, string, string, string])
          : (this.boundValues as [string, string, string, string, string]);
      const scopedKey = businessId && teamId ? `${businessId}:${teamId}:${channelId}:${threadTs}` : null;
      const key = `${channelId}:${threadTs}`;
      if ((scopedKey && this.db.slackThreadSessionRefs.has(scopedKey)) || this.db.slackThreadSessionRefs.has(key)) {
        return { success: true, meta: { changes: 0 } };
      }
      if (scopedKey) this.db.slackThreadSessionRefs.set(scopedKey, sessionId);
      this.db.slackThreadSessionRefs.set(key, sessionId);
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("INSERT INTO slack_workspaces")) {
      const [teamId, botTokenEncrypted, botUserId, teamName, installedByUserId, installedAt, updatedAt] = this
        .boundValues as [string, string, string, string | null, number | null, number, number];
      this.db.slackWorkspaces.set(teamId, {
        team_id: teamId,
        bot_token_encrypted: botTokenEncrypted,
        bot_user_id: botUserId,
        team_name: teamName,
        installed_by_user_id: installedByUserId,
        installed_at: installedAt,
        updated_at: updatedAt,
        uninstalled_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("UPDATE slack_workspaces SET uninstalled_at")) {
      const [uninstalledAt, updatedAt, teamId] = this.boundValues as [number, number, string];
      const existing = this.db.slackWorkspaces.get(teamId);
      if (!existing) {
        return { success: true, meta: { changes: 0 } };
      }
      existing.uninstalled_at = uninstalledAt;
      existing.updated_at = updatedAt;
      return { success: true, meta: { changes: 1 } };
    }

    if (
      this.query.includes("DELETE FROM slack_thread_session_refs") &&
      this.query.includes("channel_id = ?") &&
      this.query.includes("thread_ts = ?") &&
      this.query.includes("session_id = ?") &&
      (this.boundValues.length === 3 || this.boundValues.length === 5)
    ) {
      const [businessId, teamId, channelId, threadTs, sessionId] =
        this.boundValues.length === 3
          ? ([null, null, ...this.boundValues] as [null, null, string, string, string])
          : (this.boundValues as [string, string, string, string, string]);
      const scopedKey = businessId && teamId ? `${businessId}:${teamId}:${channelId}:${threadTs}` : null;
      const key = `${channelId}:${threadTs}`;
      const storedSessionId =
        (scopedKey ? this.db.slackThreadSessionRefs.get(scopedKey) : undefined) ??
        this.db.slackThreadSessionRefs.get(key);
      if (storedSessionId !== sessionId) {
        return { success: true, meta: { changes: 0 } };
      }
      if (scopedKey) this.db.slackThreadSessionRefs.delete(scopedKey);
      this.db.slackThreadSessionRefs.delete(key);
      return { success: true, meta: { changes: 1 } };
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
      return { success: true, meta: { changes } };
    }

    const linearIssueMutation = runFakeLinearIssueSessionRefMutation(this.db, this.query, this.boundValues);
    if (linearIssueMutation) return linearIssueMutation;

    const bootstrapJobMutation = runFakeLinearBootstrapJobMutation(this.db, this.query, this.boundValues);
    if (bootstrapJobMutation) return bootstrapJobMutation;

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

    if (this.query.includes("DELETE FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      this.db.authTokens.delete(token);
      return { success: true };
    }

    if (this.query.includes("UPDATE users SET slack_user_id")) {
      return { success: true };
    }

    if (this.query.includes("INSERT INTO user_integrations")) {
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
      return { success: true, meta: { changes: 1 } };
    }

    if (this.query.includes("DELETE FROM user_integrations")) {
      return { success: true };
    }

    if (this.query.includes("INSERT INTO session_completions")) {
      const [id, sessionId, promptId, ownerUserId, businessId, sessionBusinessLookupId, businessLookupOwnerUserId] =
        this.boundValues as [string, string, string, string, string | null, string, string];
      const key = `${sessionId}:${promptId}`;
      if (!this.db.sessionCompletions.has(key)) {
        this.db.sessionCompletions.set(key, {
          id,
          session_id: sessionId,
          prompt_id: promptId,
          owner_user_id: ownerUserId,
          business_id:
            businessId ??
            this.db.sessionIndex.get(sessionBusinessLookupId)?.business_id ??
            this.db.users.get(Number(businessLookupOwnerUserId))?.business_id ??
            null,
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
        business_id: businessId ?? null,
        user_id: userId ?? null,
        session_id: sessionId ?? null,
        integration_id: integrationId,
        stage,
        status,
        reason_code: reasonCode ?? null,
        message: message ?? null,
        details_json: detailsJson ?? null,
        latency_ms: latencyMs,
        created_at: createdAt,
      });
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

    if (this.query.includes("INSERT INTO prompt_runs")) {
      const id = this.boundValues[0] as string;
      if (!this.db.promptRuns.has(id)) {
        this.db.promptRuns.set(id, {
          id,
          session_id: this.boundValues[1],
          prompt_id: this.boundValues[2],
          owner_user_id: this.boundValues[3],
          business_id: this.boundValues[4] ?? null,
          outcome: this.boundValues[11],
          created_at: this.boundValues[20],
          error_details_json: this.boundValues[22],
        });
      }
      return { success: true };
    }

    if (this.query.includes("UPDATE session_index SET rich_status")) {
      const [richStatus, sessionId] = this.boundValues as [string | null, string];
      const row = this.db.sessionIndex.get(sessionId);
      if (row) row.rich_status = richStatus;
      return { success: true };
    }

    if (this.query.includes("UPDATE session_index SET runtime_backend = ?")) {
      const [runtimeBackend, sessionId] = this.boundValues as [string | null, string];
      const row = this.db.sessionIndex.get(sessionId);
      if (row) row.runtime_backend = runtimeBackend;
      return { success: true };
    }

    if (this.query.includes("UPDATE session_index SET snapshot_image_id")) {
      const [snapshotImageId, sessionId] = this.boundValues as [string | null, string];
      const row = this.db.sessionIndex.get(sessionId);
      if (row) row.snapshot_image_id = snapshotImageId;
      return { success: true };
    }

    if (this.query.includes("UPDATE session_index") && this.query.includes("SET runtime_provider")) {
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
        number | null,
        string,
      ];
      const row = this.db.sessionIndex.get(sessionId);
      if (row) {
        row.runtime_provider = runtimeProvider;
        row.runtime_backend = runtimeBackend ?? row.runtime_backend;
        row.runtime_state = runtimeState;
        row.runtime_sandbox_id = runtimeSandboxId;
        row.runtime_template_id = runtimeTemplateId;
        row.runtime_state_expires_at = runtimeStateExpiresAt;
        row.runtime_live_lease_expires_at = runtimeLiveLeaseExpiresAt;
        row.runtime_preview_url = runtimePreviewUrl;
        row.runtime_created_at = runtimeCreatedAt;
        row.runtime_last_resumed_at = runtimeLastResumedAt;
        row.runtime_last_paused_at = runtimeLastPausedAt;
        row.runtime_last_provider_refreshed_at = runtimeLastProviderRefreshedAt;
        row.runtime_provider_ttl_expires_at = runtimeProviderTtlExpiresAt;
      }
      return { success: true };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    const bootstrapRead = readFakeLinearBootstrapJob(this.db, this.query, this.boundValues);
    if (bootstrapRead) return { results: bootstrapRead.rows };

    if (
      this.query.includes("SELECT session_id, prompt_id, stage, attempt_count") &&
      this.query.includes("FROM slack_posts")
    ) {
      return { results: [] };
    }

    if (this.query.includes("FROM session_webhook_refs")) {
      const [source, externalRef] = this.boundValues as [string, string];
      const key = `${source}:${externalRef}`;
      const sessionIds = [...(this.db.sessionWebhookRefs.get(key) || new Set<string>())].sort();
      return {
        results: sessionIds.map((sessionId) => ({ session_id: sessionId })),
      };
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
          api_key: row.api_key,
          service_url: row.service_url,
          encrypted: row.encrypted,
          last_validated_at: row.last_validated_at ?? null,
          last_validation_status: row.last_validation_status ?? null,
          last_validation_reason_code: row.last_validation_reason_code ?? null,
        }));
      if (!results.some((row) => row.integration_id === "openai")) {
        results.push({
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
        });
      }
      return { results };
    }

    if (this.query.includes("FROM business_integrations")) {
      const [businessId] = this.boundValues as [string];
      const results = [...this.db.businessIntegrationScopes.entries()]
        .filter(([key]) => key.startsWith(`${businessId}:`))
        .map(([key, scope]) => ({
          integration_id: key.slice(businessId.length + 1),
          scope,
        }));
      return { results };
    }

    if (this.query.includes("FROM integration_lifecycle_events")) {
      let bindingIndex = 0;
      let filtered = [...this.db.integrationLifecycleEvents.values()];

      if (this.query.includes("integration_id = ?")) {
        const integrationId = this.boundValues[bindingIndex++] as string;
        filtered = filtered.filter((row) => row.integration_id === integrationId);
      }
      if (this.query.includes("session_id = ?")) {
        const sessionId = this.boundValues[bindingIndex++] as string;
        filtered = filtered.filter((row) => row.session_id === sessionId);
      }
      if (this.query.includes("business_id = ?")) {
        const businessId = this.boundValues[bindingIndex++] as string;
        filtered = filtered.filter((row) => row.business_id === businessId);
      }
      if (this.query.includes("user_id = ?")) {
        const userId = Number(this.boundValues[bindingIndex++]);
        filtered = filtered.filter((row) => row.user_id === userId);
      }
      if (this.query.includes("created_at < ? OR (created_at = ? AND id < ?)")) {
        const cursorCreatedAt = Number(this.boundValues[bindingIndex++]);
        bindingIndex += 1;
        const cursorId = this.boundValues[bindingIndex++] as string;
        filtered = filtered.filter(
          (row) => row.created_at < cursorCreatedAt || (row.created_at === cursorCreatedAt && row.id < cursorId),
        );
      } else if (this.query.includes("created_at < ?")) {
        const cursorCreatedAt = Number(this.boundValues[bindingIndex++]);
        filtered = filtered.filter((row) => row.created_at < cursorCreatedAt);
      }

      const limit = Number(this.boundValues[this.boundValues.length - 1] ?? filtered.length);
      filtered = filtered
        .sort((a, b) => (b.created_at === a.created_at ? b.id.localeCompare(a.id) : b.created_at - a.created_at))
        .slice(0, limit);
      return { results: filtered.map((row) => ({ ...row })) };
    }

    // prompt_runs queries
    if (this.query.includes("FROM prompt_runs") && !this.query.includes("FROM session_index")) {
      let rows = [...this.db.promptRuns.values()];
      if (this.query.includes("session_id = ?")) {
        const sessionId = this.boundValues[0] as string;
        rows = rows.filter((r) => r.session_id === sessionId);
      }
      return { results: rows };
    }

    if (this.query.includes("FROM pr_coordination_events")) {
      return { results: [] };
    }

    if (this.query.includes("FROM session_completions") && !this.query.includes("FROM session_index")) {
      return { results: [] };
    }

    if (!this.query.includes("FROM session_index")) {
      throw new Error(`Unhandled all query: ${this.query}`);
    }

    const rows = [...this.db.sessionIndex.values()];

    let filtered = rows;

    if (this.query.includes("WHERE owner_user_id = ? AND status = ?")) {
      const [ownerUserId, status] = this.boundValues as [string, string];
      filtered = filtered.filter((row) => row.owner_user_id === ownerUserId && row.status === status);
    } else if (this.query.includes("s.business_id = ?")) {
      const businessId = this.boundValues[0] as string;
      filtered = filtered.filter((row) => row.business_id === businessId);
    } else if (this.query.includes("WHERE owner_user_id = ?")) {
      const [ownerUserId] = this.boundValues as [string];
      filtered = filtered.filter((row) => row.owner_user_id === ownerUserId);
    } else if (this.query.includes("WHERE status = ?")) {
      const [status] = this.boundValues as [string];
      filtered = filtered.filter((row) => row.status === status);
    }

    if (this.query.includes("s.title IS NOT NULL") && this.query.includes("FROM prompt_runs pr")) {
      filtered = filtered.filter(
        (row) =>
          row.title !== null ||
          [...this.db.promptRuns.values()].some((promptRun) => promptRun.session_id === row.session_id) ||
          [...this.db.sessionCompletions.values()].some((completion) => completion.session_id === row.session_id),
      );
    }

    filtered.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    return {
      results: filtered.map((row) => ({
        session_id: row.session_id,
        owner_user_id: row.owner_user_id,
        business_id: row.business_id,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
        closed_at: row.closed_at,
        last_event_id: row.last_event_id,
        title: row.title,
        rich_status: row.rich_status,
        model: row.model,
        reasoning_effort: row.reasoning_effort,
        runtime_backend: row.runtime_backend,
        runtime_provider: row.runtime_provider,
        runtime_state: row.runtime_state,
        runtime_sandbox_id: row.runtime_sandbox_id,
        runtime_template_id: row.runtime_template_id,
        runtime_state_expires_at: row.runtime_state_expires_at,
        runtime_live_lease_expires_at: row.runtime_live_lease_expires_at,
        runtime_preview_url: row.runtime_preview_url,
        runtime_created_at: row.runtime_created_at,
        runtime_last_resumed_at: row.runtime_last_resumed_at,
        runtime_last_paused_at: row.runtime_last_paused_at,
        runtime_last_provider_refreshed_at: row.runtime_last_provider_refreshed_at,
        runtime_provider_ttl_expires_at: row.runtime_provider_ttl_expires_at,
      })),
    };
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.query.includes("SELECT MIN(COALESCE(next_attempt_at, created_at)) AS next_attempt_at")) {
      return null;
    }

    const bootstrapRead = readFakeLinearBootstrapJob(this.db, this.query, this.boundValues);
    if (bootstrapRead) return bootstrapRead.rows[0] ?? null;

    if (this.query.includes("FROM github_installations")) {
      const [ownerLogin] = this.boundValues as [string];
      return this.db.githubInstallations.get(ownerLogin) ?? null;
    }

    if (this.query.includes("FROM durable_event_replay_metadata")) {
      const [sessionId] = this.boundValues as [string];
      return (this.db.replay.get(sessionId) as unknown as Record<string, unknown>) ?? null;
    }

    if (this.query.includes("FROM pr_coordination")) {
      const [sessionId] = this.boundValues as [string];
      const row = this.db.prCoordination.get(sessionId);
      return row ? { ...row } : null;
    }

    if (this.query.includes("FROM qa_loop_session_bindings")) {
      return null;
    }

    if (this.query.includes("FROM slack_thread_session_refs")) {
      const [businessId, teamId, channelId, threadTs] =
        this.boundValues.length === 2
          ? ([null, null, ...this.boundValues] as [null, null, string, string])
          : (this.boundValues as [string, string, string, string]);
      const key = `${channelId}:${threadTs}`;
      const scopedKey = businessId && teamId ? `${businessId}:${teamId}:${channelId}:${threadTs}` : null;
      const sessionId =
        (scopedKey ? this.db.slackThreadSessionRefs.get(scopedKey) : undefined) ??
        this.db.slackThreadSessionRefs.get(key);
      return sessionId ? { session_id: sessionId } : null;
    }

    if (this.query.includes("FROM slack_workspaces")) {
      const [teamId] = this.boundValues as [string];
      const row = this.db.slackWorkspaces.get(teamId);
      return row ? { ...row } : null;
    }

    if (this.query.includes("FROM slack_channel_intake")) {
      const [businessId, teamId, channelId] = this.boundValues as [string, string, string];
      return (this.db.slackChannelIntake.get(`${businessId}:${teamId}:${channelId}`) ?? null) as T | null;
    }

    if (this.query.includes("FROM session_index")) {
      const [sessionId] = this.boundValues as [string];
      const row = this.db.sessionIndex.get(sessionId);
      if (!row) return null;
      if (this.query.includes("business_id")) {
        return { session_id: row.session_id, business_id: row.business_id };
      }
      return { session_id: row.session_id };
    }

    if (this.query.includes("sandbox_layer_sources")) {
      return null;
    }

    if (this.query.includes("FROM linear_issue_session_refs")) {
      const [linearIssueId] = this.boundValues as [string];
      if (this.db.linearIssueSessionRefReadMisses.has(linearIssueId)) {
        return null;
      }
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

    if (this.query.includes("FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      const user = this.db.authTokens.get(token);
      return user ?? null;
    }

    if (this.query.includes("FROM users WHERE id")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const userId = Number(userIdRaw);
      const user =
        this.db.users.get(userId) ?? [...this.db.authTokens.values()].find((candidate) => candidate.id === userId);
      if (!user && this.query.includes("business_id")) {
        return { business_id: "biz-1" };
      }
      if (!user) return null;
      if (this.query.includes("business_id")) {
        return {
          business_id: user.business_id ?? "biz-1",
        };
      }
      return {
        login: user.login,
        name: "name" in user ? user.name : null,
        email: "email" in user ? user.email : null,
      };
    }

    if (this.query.includes("FROM users WHERE slack_user_id")) {
      const [slackUserId] = this.boundValues as [string];
      return this.db.slackUsers.get(slackUserId) ?? null;
    }

    if (this.query.includes("FROM user_settings WHERE user_id")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const userId = Number(userIdRaw);
      const now = Date.now();
      return {
        user_id: userId,
        pr_review_auto_response_enabled: 0,
        default_model: null,
        default_repo: null,
        created_at: now,
        updated_at: now,
      };
    }

    // user_integrations queries (integrations/db.ts + integrations/service.ts)
    if (this.query.includes("FROM user_integrations") && this.query.includes("INNER JOIN users")) {
      // getUserByExternalId: reverse lookup by external_user_id
      const [integrationId, externalUserId] = this.boundValues as [string, string];
      if (integrationId === "slack") {
        return this.db.slackUsers.get(externalUserId) ?? null;
      }
      if (integrationId === "linear") {
        return this.db.linearUsers.get(externalUserId) ?? null;
      }
      return null;
    }

    if (this.query.includes("FROM user_integrations") && this.query.includes("integration_id = 'linear'")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const userId = Number(userIdRaw);
      const linearTokenRow = this.db.linearTokenRows.get(userId);
      if (linearTokenRow) return linearTokenRow;
      const row = this.db.userIntegrations.get(`${userId}:linear`);
      return row
        ? {
            oauth_access_token: row.oauth_access_token,
            oauth_refresh_token: row.oauth_refresh_token,
            oauth_expires_at: row.oauth_expires_at,
            api_key: row.api_key,
            external_user_id: row.external_user_id,
            service_url: row.service_url,
            encrypted: row.encrypted,
            last_validated_at: row.last_validated_at ?? null,
            last_validation_status: row.last_validation_status ?? null,
            last_validation_reason_code: row.last_validation_reason_code ?? null,
          }
        : null;
    }

    if (this.query.includes("FROM user_integrations") && this.query.includes("oauth_access_token")) {
      const [userIdRaw, integrationId = "github"] = this.boundValues as [number | string, string?];
      const userId = Number(userIdRaw);
      if (integrationId === "linear") {
        return this.db.linearTokenRows.get(userId) ?? null;
      }
      const row = this.db.userIntegrations.get(`${userId}:${integrationId}`);
      return row
        ? {
            oauth_access_token: row.oauth_access_token,
            oauth_refresh_token: row.oauth_refresh_token,
            oauth_expires_at: row.oauth_expires_at,
            api_key: row.api_key,
            external_user_id: row.external_user_id,
            service_url: row.service_url,
            encrypted: row.encrypted,
            last_validated_at: row.last_validated_at ?? null,
            last_validation_status: row.last_validation_status ?? null,
            last_validation_reason_code: row.last_validation_reason_code ?? null,
          }
        : {
            oauth_access_token: integrationId === "github" ? "ghp_test" : null,
            oauth_refresh_token: null,
            oauth_expires_at: null,
            encrypted: 0,
          };
    }

    if (this.query.includes("FROM user_integrations")) {
      const [userIdRaw, integrationId] = this.boundValues as [number | string, string];
      const userId = Number(userIdRaw);
      const row = this.db.userIntegrations.get(`${userId}:${integrationId}`);
      if (!row && integrationId === "openai") {
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
      return row
        ? {
            api_key: row.api_key,
            oauth_access_token: row.oauth_access_token,
            oauth_refresh_token: row.oauth_refresh_token,
            oauth_expires_at: row.oauth_expires_at,
            service_url: row.service_url,
            encrypted: row.encrypted,
            last_validated_at: row.last_validated_at ?? null,
            last_validation_status: row.last_validation_status ?? null,
            last_validation_reason_code: row.last_validation_reason_code ?? null,
          }
        : null;
    }

    if (this.query.includes("FROM businesses")) {
      return { id: this.boundValues[0] as string, name: this.boundValues[0] as string, shared_sessions: 0 };
    }

    if (this.query.includes("FROM env_blobs b") && this.query.includes("INNER JOIN env_blob_repos")) {
      return null;
    }

    if (this.query.includes("FROM env_blobs") && this.query.includes("is_global = 1")) {
      return null;
    }

    // business_members queries
    if (this.query.includes("FROM business_members")) {
      if (this.query.includes("SELECT business_id") && this.query.includes("WHERE user_id")) {
        return { business_id: "biz-1" };
      }
      return null;
    }

    if (this.query.includes("FROM business_integrations")) {
      const [businessId, integrationId] = this.boundValues as [string, string];
      const scope = this.db.businessIntegrationScopes.get(`${businessId}:${integrationId}`);
      return scope ? { scope } : null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

type AuthTokenUser = {
  user_id: number;
  expires_at: number;
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  business_id?: string;
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
  last_validated_at?: number | null;
  last_validation_status?: string | null;
  last_validation_reason_code?: string | null;
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
  installed_by_user_id: number | null;
  installed_at: number;
  updated_at: number;
  uninstalled_at: number | null;
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

class FakeD1 {
  readonly sessionIndex = new Map<string, FakeSessionIndexRow>();
  readonly replay = new Map<string, FakeReplayRow>();
  readonly sessionWebhookRefs = new Map<string, Set<string>>();
  readonly slackThreadSessionRefs = new Map<string, string>();
  readonly linearWebhookBootstrapJobs = new Map<string, FakeLinearBootstrapJobRow>();
  readonly slackWorkspaces = new Map<string, FakeSlackWorkspaceRow>();
  readonly slackChannelIntake = new Map<string, Record<string, unknown>>();
  readonly linearIssueSessionRefs = new Map<string, string>();
  readonly linearIssueSessionRefReadMisses = new Set<string>();
  readonly webhookIdempotencyRows = new Map<string, Record<string, unknown>>();
  readonly authTokens = new Map<string, AuthTokenUser>();
  readonly userIntegrations = new Map<string, FakeUserIntegrationRow>();
  readonly businessIntegrationScopes = new Map<string, string>();
  readonly githubInstallations = new Map<string, Record<string, unknown>>();
  readonly users = new Map<
    number,
    { id: number; login: string; name: string | null; email: string | null; business_id: string }
  >();
  readonly slackUsers = new Map<string, { id: number; login: string }>();
  readonly promptRuns = new Map<string, Record<string, unknown>>();
  readonly sessionCompletions = new Map<string, Record<string, unknown>>();
  readonly prCoordination = new Map<string, FakePrCoordinationRow>();
  readonly linearUsers = new Map<string, { id: number; login: string }>();
  readonly linearTokenRows = new Map<number, Record<string, unknown>>();
  readonly linearWebhookInstallations = new Map<string, LinearWebhookInstallationRow>();
  readonly integrationLifecycleEvents = new Map<string, FakeIntegrationLifecycleEventRow>();
  readonly openAIGatewaySessionTokens = new Map<string, FakeOpenAIGatewaySessionTokenRow>();
  failSessionIndexInsert: Error | null = null;

  setAuthToken(token: string, user: AuthTokenUser): void {
    this.authTokens.set(token, user);
    this.users.set(user.id, {
      id: user.id,
      login: user.login,
      name: user.name,
      email: user.email,
      business_id: user.business_id ?? "biz-1",
    });
    this.seedProviderApiKeys(user.id);
  }

  addSlackUser(slackUserId: string, id: number, login: string): void {
    this.slackUsers.set(slackUserId, { id, login });
    this.users.set(id, { id, login, name: null, email: null, business_id: "biz-1" });
    this.seedProviderApiKeys(id);
  }

  addLinearUser(linearUserId: string, id: number, login: string, businessId = "biz-1"): void {
    this.linearUsers.set(linearUserId, { id, login });
    this.users.set(id, { id, login, name: null, email: null, business_id: businessId });
    this.seedProviderApiKeys(id);
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

  setBusinessIntegrationScope(businessId: string, integrationId: string, scope: string): void {
    this.businessIntegrationScopes.set(`${businessId}:${integrationId}`, scope);
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
      });
    }
  }

  addLinearToken(userId: number, token: string, expiresAt = Date.now() + 60 * 60 * 1000): void {
    this.linearTokenRows.set(userId, {
      oauth_access_token: token,
      oauth_refresh_token: null,
      oauth_expires_at: expiresAt,
      api_key: null,
      external_user_id: null,
      service_url: null,
      encrypted: 0,
      last_validated_at: null,
      last_validation_status: null,
      last_validation_reason_code: null,
    });
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(
    statements: FakeD1Statement[],
  ): Promise<Array<{ results: Array<Record<string, unknown>>; meta?: { changes?: number } }>> {
    const out: Array<{ results: Array<Record<string, unknown>>; meta?: { changes?: number } }> = [];
    for (const stmt of statements) {
      const isRead = /^\s*(SELECT|WITH)/i.test(stmt.queryText);
      try {
        if (isRead) {
          out.push(await stmt.all());
        } else {
          const result = (await stmt.run()) as { meta?: { changes?: number } };
          out.push({ results: [], meta: result.meta });
        }
      } catch (err) {
        // This fake models only a subset of tables. Best-effort batched writes
        // to unmodeled tables (e.g. session_completions outcome updates) are
        // treated as no-ops, matching prior behavior where `db.batch` was absent
        // and such calls were swallowed upstream. Modeled statements (e.g. the
        // bootstrap-job claim) still execute and return real change counts.
        if (err instanceof Error && err.message.startsWith("Unhandled")) {
          out.push({ results: [], meta: { changes: 0 } });
          continue;
        }
        throw err;
      }
    }
    return out;
  }
}

function createDurableNamespace(durableClass: DurableObjectClass, env: Record<string, unknown>): TestDurableNamespace {
  const instances = new Map<string, TestDurableObjectInstance>();

  return {
    idFromName(name: string): string {
      return name;
    },
    get(id: string): { fetch(request: Request | string, init?: RequestInit): Promise<Response> } {
      return {
        fetch: async (request: Request | string, init?: RequestInit): Promise<Response> => {
          let instance = instances.get(id);
          if (!instance) {
            instance = new durableClass(new FakeDurableState(), env) as TestDurableObjectInstance;
            instances.set(id, instance);
          }

          const actualRequest = request instanceof Request ? request : new Request(request, init);
          return instance.fetch(actualRequest);
        },
      };
    },
    __getInstance(id: string): TestDurableObjectInstance | undefined {
      return instances.get(id);
    },
  };
}

function createWorkerEnv(workerModule: WorkerModule): {
  env: Record<string, unknown>;
  db: FakeD1;
} {
  const db = new FakeD1();
  const reposCache = new FakeKV();

  const env: Record<string, unknown> = {
    DB: db,
    REPOS_CACHE: reposCache,
    RATE_LIMITS: new FakeKV(),
    WORKER_ENV: "test",
    AUTH_SMOKE_TOKEN: "smoke-token",
    ARCANIST_ADMIN_TOKEN: "admin-secret",
    SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    GITHUB_WEBHOOK_SECRET: "gh-webhook-secret",
    SLACK_SIGNING_SECRET: "slack-webhook-secret",
    LINEAR_WEBHOOK_SECRET: "linear-webhook-secret",
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: "test-private-key",
    E2B_API_KEY: "test-e2b-key",
    E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-test",
    E2B_SANDBOX_TIMEOUT_MS: "3600000",
    E2B_RUNTIME_RETENTION_HOURS: "72",
    E2B_RUNTIME_LIVE_LEASE_MS: "900000",
    E2B_RUNTIME_PROVIDER_REFRESH_INTERVAL_MS: "1800000",
    E2B_RUNTIME_PROVIDER_TTL_MS: "3600000",
    TOKEN_ENCRYPTION_KEY: "test-encryption-key-32bytes!!",
  };

  env.SESSION = createDurableNamespace(workerModule.SessionDO, env);
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
  db.addLinearWebhookInstallation();

  return { env, db };
}

function getSessionDoInstance(env: Record<string, unknown>, sessionId: string): TestDurableObjectInstance {
  const namespace = env.SESSION as TestDurableNamespace;
  const instance = namespace.__getInstance(sessionId);
  if (!instance?.state) {
    throw new Error(`Expected SessionDO instance for ${sessionId}`);
  }
  return instance;
}

function forceStoppedResumableSession(
  env: Record<string, unknown>,
  sessionId: string,
  options?: { runtimeStateExpiresAt?: number; installationId?: number },
): void {
  const instance = getSessionDoInstance(env, sessionId);
  instance.state?.storage.sql.exec(
    `UPDATE sandbox_state SET
      status = ?,
      stop_reason = ?,
      runtime_provider = ?,
      runtime_state = ?,
      runtime_sandbox_id = ?,
      runtime_template_id = ?,
      runtime_state_expires_at = ?,
      pending_prompt_dispatch = ?
     WHERE session_id = ?`,
    "stopped",
    "reaped",
    "e2b",
    "paused",
    `e2b-${sessionId}`,
    "cycloid-sandbox-test",
    options?.runtimeStateExpiresAt ?? Date.now() + 60_000,
    0,
    sessionId,
  );
  instance.state?.storage.sql.exec(
    "UPDATE session SET installation_id = ? WHERE session_id = ?",
    options?.installationId ?? 1,
    sessionId,
  );
}

function forceCompletedNoPrReapedSession(
  env: Record<string, unknown>,
  sessionId: string,
  options?: { runtimeStateExpiresAt?: number; installationId?: number },
): void {
  forceStoppedResumableSession(env, sessionId, options);
  const instance = getSessionDoInstance(env, sessionId);
  const now = Date.now();
  instance.state?.storage.sql.exec(
    `INSERT INTO prompts (
      prompt_id, session_id, prompt_text, reply_to_text, status, created_at,
      started_at, completed_at, updated_at, result_json, queue_position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `completed-${sessionId}`,
    sessionId,
    "completed no-pr prompt",
    "completed no-pr prompt",
    "completed",
    now - 2_000,
    now - 1_500,
    now - 1_000,
    now - 1_000,
    JSON.stringify({ noChanges: true, noChangeReason: "no_diff" }),
    0,
  );
}

async function seedSlackWorkspace(env: Record<string, unknown>, teamId = "T_TEST"): Promise<void> {
  await storeWorkspaceInstall(
    env.DB as D1Database,
    {
      teamId,
      botToken: "xoxb-test-token",
      botUserId: "UARCA",
      teamName: "Test Workspace",
    },
    String(env.TOKEN_ENCRYPTION_KEY),
  );
}

async function workerFetch(
  workerModule: WorkerModule,
  env: Record<string, unknown>,
  path: string,
  init?: RequestInit,
  ctx?: ExecutionContext,
): Promise<Response> {
  return workerModule.default.fetch(new Request(`https://worker.test${path}`, init), env, ctx);
}

/**
 * Execution context that captures `ctx.waitUntil` work so a test can await the
 * worker's out-of-band tasks (e.g. the Linear bootstrap link-back or skip-notice
 * comment) deterministically instead of racing them with timer ticks. `flush`
 * drains promises that may themselves register further `waitUntil` work.
 */
function createCapturingExecutionContext(): { ctx: ExecutionContext; flush: () => Promise<void> } {
  const pending: Array<Promise<unknown>> = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>): void => {
      pending.push(Promise.resolve(promise).catch(() => undefined));
    },
    passThroughOnException: (): void => undefined,
  } as unknown as ExecutionContext;
  return {
    ctx,
    flush: async (): Promise<void> => {
      while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
      }
    },
  };
}

function createGithubSignature(secret: string, body: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

function createSlackSignature(secret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return `v0=${digest}`;
}

function createLinearSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function withLinearWebhookMetadata(
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    organizationId: "lin-org-1",
    webhookId: "lin-webhook-1",
    webhookTimestamp: Date.now(),
    ...payload,
    ...overrides,
  };
}

describe("control-plane worker migration endpoints", () => {
  let workerModule: WorkerModule;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(async () => {
    expect(workerModule).toBeDefined();
    const installationsDbMod = await import("../../apps/control-plane-worker/src/github/installations-db.js");
    installationsDbMod.resetInstallationByOwnerCacheForTests();
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url === "https://slack.com/api/auth.test") {
        return Response.json({ ok: true, user_id: "UARCA" });
      }
      // Live @mention follow-ups run the prior-thread backfill, which reads
      // conversations.replies and may add a reaction / post a reply. Stub these
      // so a mention-bearing follow-up does not hit the network guard.
      if (url.startsWith("https://slack.com/api/conversations.replies")) {
        return Response.json({ ok: true, messages: [] });
      }
      if (
        url === "https://slack.com/api/reactions.add" ||
        url === "https://slack.com/api/chat.postMessage" ||
        url === "https://slack.com/api/users.info"
      ) {
        return Response.json({ ok: true });
      }
      if (url.includes("api.github.com/repos/")) {
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
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      return originalFetch(input, init);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("verifies GitHub webhook signatures on worker ingress", async () => {
    const { env } = createWorkerEnv(workerModule);
    const body = JSON.stringify({
      action: "closed",
      pull_request: { html_url: "https://github.com/acme/repo/pull/1" },
    });
    const signature = createGithubSignature(String(env.GITHUB_WEBHOOK_SECRET), body);

    const validRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      body,
    });
    expect(validRes.status).toBe(200);
    const validBody = await validRes.json();
    expect(validBody.ok).toBe(true);
    expect(validBody.skipped).toBe(true);

    const missingSigRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(missingSigRes.status).toBe(401);
    const missingSigBody = await missingSigRes.json();
    expect(missingSigBody.error).toBe("Missing signature");

    const invalidSigRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=bad",
      },
      body,
    });
    expect(invalidSigRes.status).toBe(401);
    const invalidSigBody = await invalidSigRes.json();
    expect(invalidSigBody.error).toBe("Invalid signature");

    const badJson = "{";
    const badJsonSig = createGithubSignature(String(env.GITHUB_WEBHOOK_SECRET), badJson);
    const badJsonRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": badJsonSig,
      },
      body: badJson,
    });
    expect(badJsonRes.status).toBe(400);
    const badJsonBody = await badJsonRes.json();
    expect(badJsonBody.error).toBe("Invalid JSON");
  });

  it("verifies Slack webhook signatures for events and interactions on worker ingress", async () => {
    const { env } = createWorkerEnv(workerModule);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const slackSecret = String(env.SLACK_SIGNING_SECRET);

    const eventsBody = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-token",
    });
    const eventsSignature = createSlackSignature(slackSecret, timestamp, eventsBody);

    const validEventsRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": eventsSignature,
      },
      body: eventsBody,
    });
    expect(validEventsRes.status).toBe(200);
    const validEventsBody = await validEventsRes.json();
    expect(validEventsBody.challenge).toBe("challenge-token");

    const retryRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-retry-num": "1",
      },
      body: eventsBody,
    });
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json();
    expect(retryBody.ok).toBe(true);

    const missingHeadersRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: eventsBody,
    });
    expect(missingHeadersRes.status).toBe(401);
    const missingHeadersBody = await missingHeadersRes.json();
    expect(missingHeadersBody.error).toBe("Missing signature headers");

    const badSignatureRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": "v0=bad",
      },
      body: eventsBody,
    });
    expect(badSignatureRes.status).toBe(401);
    const badSignatureBody = await badSignatureRes.json();
    expect(badSignatureBody.error).toBe("Invalid signature");

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const staleSignature = createSlackSignature(slackSecret, staleTimestamp, eventsBody);
    const staleRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": staleTimestamp,
        "x-slack-signature": staleSignature,
      },
      body: eventsBody,
    });
    expect(staleRes.status).toBe(401);
    const staleBody = await staleRes.json();
    expect(staleBody.error).toBe("Invalid signature");

    const interactionsPayload = JSON.stringify({
      type: "block_actions",
      actions: [{ action_id: "stop_session", value: "session-123" }],
    });
    const interactionsBody = new URLSearchParams({ payload: interactionsPayload }).toString();
    const interactionsSignature = createSlackSignature(slackSecret, timestamp, interactionsBody);
    const interactionsRes = await workerFetch(workerModule, env, "/api/webhooks/slack/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": interactionsSignature,
      },
      body: interactionsBody,
    });
    expect(interactionsRes.status).toBe(200);
    const interactionsResponseBody = await interactionsRes.json();
    expect(interactionsResponseBody.ok).toBe(true);

    const malformedInteractionsBody = new URLSearchParams({ payload: "not-json" }).toString();
    const malformedInteractionsSignature = createSlackSignature(slackSecret, timestamp, malformedInteractionsBody);
    const malformedInteractionsRes = await workerFetch(workerModule, env, "/api/webhooks/slack/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": malformedInteractionsSignature,
      },
      body: malformedInteractionsBody,
    });
    expect(malformedInteractionsRes.status).toBe(400);
    const malformedInteractionsResponseBody = await malformedInteractionsRes.json();
    expect(malformedInteractionsResponseBody.error).toBe("Invalid payload");
  });

  it("verifies Linear webhook signatures on worker ingress", async () => {
    const { env } = createWorkerEnv(workerModule);
    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "update",
        data: { id: "issue-1" },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);

    const validRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-sig-valid",
      },
      body,
    });
    expect(validRes.status).toBe(200);
    const validBody = await validRes.json();
    expect(validBody.ok).toBe(true);
    expect(validBody.skipped).toBe(true);
    expect(validBody.reason).toBe("trigger_label_missing");

    const missingSigRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(missingSigRes.status).toBe(401);
    const missingSigBody = await missingSigRes.json();
    expect(missingSigBody.error).toBe("Missing signature");

    const invalidSigRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": "bad",
      },
      body,
    });
    expect(invalidSigRes.status).toBe(401);
    const invalidSigBody = await invalidSigRes.json();
    expect(invalidSigBody.error).toBe("Invalid signature");

    const malformedBody = "{";
    const malformedSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), malformedBody);
    const malformedRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": malformedSignature,
      },
      body: malformedBody,
    });
    expect(malformedRes.status).toBe(400);
    const malformedResponseBody = await malformedRes.json();
    expect(malformedResponseBody.error).toBe("Invalid JSON");
  });

  it("rejects Linear webhook timestamps older than the retry window", async () => {
    const { env } = createWorkerEnv(workerModule);
    // The acceptance window covers Linear's full cumulative redelivery
    // schedule (final retry ~7h01m after origin), so rejection starts past 8h.
    const body = JSON.stringify(
      withLinearWebhookMetadata(
        {
          type: "Issue",
          action: "update",
          data: { id: "issue-stale" },
        },
        { webhookTimestamp: Date.now() - 9 * 60 * 60 * 1000 },
      ),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);

    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-stale",
      },
      body,
    });
    expect(res.status).toBe(401);
    const responseBody = await res.json();
    expect(responseBody.error).toBe("Invalid timestamp");
  });

  it("skips Linear webhooks from unknown organizations and mismatched webhook IDs", async () => {
    const { env } = createWorkerEnv(workerModule);
    const unknownOrgBody = JSON.stringify(
      withLinearWebhookMetadata(
        {
          type: "Issue",
          action: "update",
          data: { id: "issue-unknown-org" },
        },
        { organizationId: "lin-org-unknown" },
      ),
    );
    const unknownOrgSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), unknownOrgBody);
    const unknownOrgRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": unknownOrgSignature,
        "linear-delivery": "lin-delivery-unknown-org",
      },
      body: unknownOrgBody,
    });
    expect(unknownOrgRes.status).toBe(200);
    expect((await unknownOrgRes.json()).reason).toBe("unknown_linear_organization");

    const mismatchBody = JSON.stringify(
      withLinearWebhookMetadata(
        {
          type: "Issue",
          action: "update",
          data: { id: "issue-mismatch" },
        },
        { webhookId: "lin-webhook-other" },
      ),
    );
    const mismatchSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), mismatchBody);
    const mismatchRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": mismatchSignature,
        "linear-delivery": "lin-delivery-mismatch",
      },
      body: mismatchBody,
    });
    expect(mismatchRes.status).toBe(200);
    expect((await mismatchRes.json()).reason).toBe("linear_webhook_mismatch");
  });

  it("binds the first verified Linear webhook ID and handles OAuth revocation", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addLinearWebhookInstallation("lin-org-first", "biz-1", null);

    const firstBody = JSON.stringify(
      withLinearWebhookMetadata(
        {
          type: "Issue",
          action: "update",
          data: { id: "issue-first" },
        },
        { organizationId: "lin-org-first", webhookId: "lin-webhook-first" },
      ),
    );
    const firstSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), firstBody);
    const firstRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": firstSignature,
        "linear-delivery": "lin-delivery-first-webhook",
      },
      body: firstBody,
    });
    expect(firstRes.status).toBe(200);
    expect(db.linearWebhookInstallations.get("biz-1:lin-org-first")?.linear_webhook_id).toBe("lin-webhook-first");

    const revokeBody = JSON.stringify(
      withLinearWebhookMetadata(
        {
          type: "OAuthApp",
          action: "revoked",
          oauthClientId: "linear-oauth-client",
        },
        { organizationId: "lin-org-first", webhookId: "lin-webhook-first" },
      ),
    );
    const revokeSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), revokeBody);
    const revokeRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": revokeSignature,
        "linear-delivery": "lin-delivery-revoke",
      },
      body: revokeBody,
    });
    expect(revokeRes.status).toBe(200);
    expect((await revokeRes.json()).revoked).toBe(true);
    expect(db.linearWebhookInstallations.get("biz-1:lin-org-first")?.status).toBe("revoked");
  });

  it("accepts stale Linear OAuth revoke webhooks after signature verification", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addLinearWebhookInstallation("lin-org-stale-revoke", "biz-1", "lin-webhook-stale");

    const revokeBody = JSON.stringify(
      withLinearWebhookMetadata(
        {
          type: "OAuthApp",
          action: "revoked",
          oauthClientId: "linear-oauth-client",
        },
        {
          organizationId: "lin-org-stale-revoke",
          webhookId: "lin-webhook-stale",
          webhookTimestamp: Date.now() - 10 * 60 * 1000,
        },
      ),
    );
    const revokeSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), revokeBody);
    const revokeRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": revokeSignature,
        "linear-delivery": "lin-delivery-stale-revoke",
      },
      body: revokeBody,
    });

    expect(revokeRes.status).toBe(200);
    expect((await revokeRes.json()).revoked).toBe(true);
    expect(db.linearWebhookInstallations.get("biz-1:lin-org-stale-revoke")?.status).toBe("revoked");
  });

  it("does not let stale Linear OAuth revoke webhooks claim a fresh install", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addLinearWebhookInstallation("lin-org-reconnect", "biz-1", null);

    const revokeBody = JSON.stringify(
      withLinearWebhookMetadata(
        {
          type: "OAuthApp",
          action: "revoked",
          oauthClientId: "linear-oauth-client",
        },
        {
          organizationId: "lin-org-reconnect",
          webhookId: "lin-webhook-old",
          webhookTimestamp: Date.now() - 10 * 60 * 1000,
        },
      ),
    );
    const revokeSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), revokeBody);
    const revokeRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": revokeSignature,
        "linear-delivery": "lin-delivery-stale-reconnect-revoke",
      },
      body: revokeBody,
    });

    expect(revokeRes.status).toBe(200);
    expect((await revokeRes.json()).reason).toBe("linear_webhook_unbound_for_revoke");
    expect(db.linearWebhookInstallations.get("biz-1:lin-org-reconnect")).toMatchObject({
      status: "active",
      linear_webhook_id: null,
    });
  });

  it("skips Linear webhooks when the actor belongs to another business", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/repo";
    db.addLinearUser("linear-cross-business", 177, "linear-other-business-user", "biz-2");

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-cross-business", type: "user", name: "Linear Other Business User" },
        data: {
          id: "lin-issue-cross-business",
          identifier: "ARC-177",
          title: "Cross business issue",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-cross-business",
      },
      body,
    });

    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody.skipped).toBe(true);
    expect(responseBody.reason).toBe("linear_actor_business_mismatch");
  });

  it("skips Linear webhooks when the actor business has Linear disabled", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/repo";
    db.addLinearUser("linear-disabled-user", 178, "linear-disabled-user");
    db.setBusinessIntegrationScope("biz-1", "linear", "disabled");

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-disabled-user", type: "user", name: "Linear Disabled User" },
        data: {
          id: "lin-issue-disabled-linear",
          identifier: "ARC-178",
          title: "Disabled Linear integration",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-disabled-linear",
      },
      body,
    });

    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody.skipped).toBe(true);
    expect(responseBody.reason).toBe("integration_disabled");
    expect(db.linearIssueSessionRefs.get("lin-issue-disabled-linear")).toBeUndefined();
  });

  it("processes GitHub PR-closed webhooks for mapped sessions with idempotency", async () => {
    const { env } = createWorkerEnv(workerModule);
    const prUrl = "https://github.com/acme/repo/pull/22";

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret",
      },
      body: JSON.stringify({
        sessionId: "s-gh-close",
        ownerUserId: "2201",
        repoUrl: DEFAULT_REPO_URL,
        githubPrUrl: prUrl,
      }),
    });
    expect(createRes.status).toBe(201);

    const body = JSON.stringify({
      action: "closed",
      pull_request: { html_url: prUrl },
    });
    const signature = createGithubSignature(String(env.GITHUB_WEBHOOK_SECRET), body);

    const firstRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
      },
      body,
    });
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    expect(firstBody.ok).toBe(true);
    expect(firstBody.archived).toBe(1);
    expect(firstBody.total).toBe(1);

    const sessionRes = await workerFetch(workerModule, env, "/api/sessions/s-gh-close", {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.status).toBe("archived");
    expect(sessionBody.session.closeReason).toBe("pr_closed");

    const duplicateRes = await workerFetch(workerModule, env, "/api/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-delivery": "delivery-1",
        "x-github-event": "pull_request",
      },
      body,
    });
    expect(duplicateRes.status).toBe(200);
    const duplicateBody = await duplicateRes.json();
    expect(duplicateBody.skipped).toBe(true);
    expect(duplicateBody.reason).toBe("duplicate");
  });

  it("processes Slack stop-session interactions with idempotency", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    // The stop_session interaction is authorized against the session: the acting
    // Slack user must be the owner or share the session's business. Map the
    // Slack actor to the session owner so a legitimate click is accepted.
    db.addSlackUser("U_STOP", 3301, "stopper");

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret",
      },
      body: JSON.stringify({
        sessionId: "s-slack-stop",
        ownerUserId: "3301",
        repoUrl: DEFAULT_REPO_URL,
      }),
    });
    expect(createRes.status).toBe(201);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = JSON.stringify({
      type: "block_actions",
      trigger_id: "trigger-stop-1",
      user: { id: "U_STOP" },
      actions: [{ action_id: "stop_session", value: "s-slack-stop" }],
    });
    const body = new URLSearchParams({ payload }).toString();
    const signature = createSlackSignature(String(env.SLACK_SIGNING_SECRET), timestamp, body);

    const firstRes = await workerFetch(workerModule, env, "/api/webhooks/slack/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    expect(firstBody.ok).toBe(true);
    expect(firstBody.stopped).toBe(true);
    expect(firstBody.sessionId).toBe("s-slack-stop");

    const sessionRes = await workerFetch(workerModule, env, "/api/sessions/s-slack-stop", {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.status).toBe("archived");
    expect(sessionBody.session.closeReason).toBe("slack_stop_interaction");

    const duplicateRes = await workerFetch(workerModule, env, "/api/webhooks/slack/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });
    expect(duplicateRes.status).toBe(200);
    const duplicateBody = await duplicateRes.json();
    expect(duplicateBody.skipped).toBe(true);
    expect(duplicateBody.reason).toBe("duplicate");
  });

  it("processes Slack message/app-mention events for create, follow-up, and stop within a thread", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    await seedSlackWorkspace(env);
    db.addSlackUser("U777", 7777, "slack-user");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const slackSecret = String(env.SLACK_SIGNING_SECRET);
    const threadTs = "1712345678.000100";

    const createBody = JSON.stringify({
      type: "event_callback",
      team_id: "T_TEST",
      event_id: "Ev-create-1",
      event: {
        type: "app_mention",
        text: "<@UARCA> repo=acme/repo, implement webhook parity",
        channel: "C999",
        ts: threadTs,
        user: "U777",
      },
    });
    const createSignature = createSlackSignature(slackSecret, timestamp, createBody);
    const createRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": createSignature,
      },
      body: createBody,
    });
    expect(createRes.status).toBe(200);
    const createPayload = await createRes.json();
    expect(createPayload.ok).toBe(true);
    expect(createPayload.created).toBe(true);
    expect(createPayload.enqueued).toBe(true);

    const sessionId = String(createPayload.sessionId);
    expect(db.slackThreadSessionRefs.get(`C999:${threadTs}`)).toBe(sessionId);

    const initialPromptsRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(initialPromptsRes.status).toBe(200);
    const initialPromptsBody = await initialPromptsRes.json();
    expect(initialPromptsBody.prompts).toHaveLength(1);
    expect(initialPromptsBody.prompts[0].prompt).toContain("Repository: https://github.com/acme/repo");
    expect(initialPromptsBody.prompts[0].prompt).toContain("implement webhook parity");

    const followUpBody = JSON.stringify({
      type: "event_callback",
      team_id: "T_TEST",
      event_id: "Ev-follow-1",
      event: {
        type: "app_mention",
        text: "<@UARCA> add tests for the webhook path",
        channel: "C999",
        ts: "1712345678.000200",
        thread_ts: threadTs,
        user: "U777",
      },
    });
    const followUpSignature = createSlackSignature(slackSecret, timestamp, followUpBody);
    const followUpRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": followUpSignature,
      },
      body: followUpBody,
    });
    expect(followUpRes.status).toBe(200);
    const followUpPayload = await followUpRes.json();
    expect(followUpPayload.ok).toBe(true);
    expect(followUpPayload.created).toBe(false);
    expect(followUpPayload.sessionId).toBe(sessionId);
    expect(followUpPayload.enqueued).toBe(true);

    const promptsAfterFollowUpRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(promptsAfterFollowUpRes.status).toBe(200);
    const promptsAfterFollowUpBody = await promptsAfterFollowUpRes.json();
    expect(promptsAfterFollowUpBody.prompts).toHaveLength(2);
    expect(promptsAfterFollowUpBody.prompts[1].prompt).toContain("Current Slack message author: slack-user.");
    expect(promptsAfterFollowUpBody.prompts[1].prompt).not.toContain('<user_content source="slack_message"');
    expect(promptsAfterFollowUpBody.prompts[1].prompt).toContain("add tests for the webhook path");

    const stopBody = JSON.stringify({
      type: "event_callback",
      team_id: "T_TEST",
      event_id: "Ev-stop-1",
      event: {
        type: "message",
        text: "stop",
        channel: "C999",
        ts: "1712345678.000300",
        thread_ts: threadTs,
        user: "U777",
      },
    });
    const stopSignature = createSlackSignature(slackSecret, timestamp, stopBody);
    const stopRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": stopSignature,
      },
      body: stopBody,
    });
    expect(stopRes.status).toBe(200);
    const stopPayload = await stopRes.json();
    expect(stopPayload.ok).toBe(true);
    expect(stopPayload.created).toBe(false);
    expect(stopPayload.sessionId).toBe(sessionId);
    expect(stopPayload.stopped).toBe(true);

    const sessionRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}`, {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.status).toBe("archived");
  });

  it("skips top-level Slack message events when no thread session exists", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    await seedSlackWorkspace(env);
    db.addSlackUser("U777", 7777, "slack-user");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T_TEST",
      event_id: "Ev-top-message-1",
      event: {
        type: "message",
        text: "repo=acme/repo, this should not create a session",
        channel: "C999",
        ts: "1712345678.000400",
        user: "U777",
      },
    });
    const signature = createSlackSignature(String(env.SLACK_SIGNING_SECRET), timestamp, body);

    const res = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toMatchObject({ ok: true, skipped: true, reason: "not_app_mention" });
    expect(db.slackThreadSessionRefs.size).toBe(0);
  });

  it("skips Slack webhooks when the actor business has Slack disabled", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    await seedSlackWorkspace(env);
    db.addSlackUser("U778", 7778, "slack-disabled-user");
    db.setBusinessIntegrationScope("biz-1", "slack", "disabled");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T_TEST",
      event_id: "Ev-slack-disabled-1",
      event: {
        type: "app_mention",
        text: "<@UARCA> repo=acme/repo, should be blocked",
        channel: "C998",
        ts: "1712345678.000500",
        user: "U778",
      },
    });
    const signature = createSlackSignature(String(env.SLACK_SIGNING_SECRET), timestamp, body);

    const res = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toMatchObject({ ok: true, skipped: true, reason: "integration_disabled" });
    expect(db.slackThreadSessionRefs.size).toBe(0);
  });

  it("processes Linear trigger-label webhooks into session creation and prompt enqueue", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/repo";
    db.addLinearUser("linear-uuid-77", 77, "linear-test-user");

    const firstBody = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-uuid-77", type: "user", name: "Linear Test User" },
        data: {
          id: "lin-issue-22",
          identifier: "ARC-22",
          title: "Implement webhook orchestration",
          description: "Ensure linear webhook paths create and dispatch sessions.",
          url: "https://linear.app/acme/issue/ARC-22/implement-webhook-orchestration",
          labels: [{ name: "cycloid" }, { name: "webhook" }],
          project: { name: "Control Plane" },
          team: { key: "ENG" },
          assignee: { name: "Linear Test User" },
          priorityLabel: "High",
        },
      }),
    );
    const firstSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), firstBody);
    const firstRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": firstSignature,
        "linear-delivery": "lin-delivery-create-22",
      },
      body: firstBody,
    });
    expect(firstRes.status).toBe(200);
    const firstPayload = await firstRes.json();
    expect(firstPayload.ok).toBe(true);
    expect(firstPayload.created).toBe(true);
    expect(firstPayload.enqueued).toBe(true);
    expect(firstPayload.linearIssueId).toBe("lin-issue-22");
    // ARC-1024 / ARC-1051: the Linear webhook response is narrowed; the durable
    // bootstrap drives prompt enqueue out of the response, so no raw wrapped
    // prompt, actor id, or dispatch credential is echoed. The stored prompt list
    // (GET /prompts, asserted below) still holds the wrapped text.
    expect(firstPayload.prompt).toBeUndefined();
    expect(firstPayload.dispatch).toBeUndefined();
    expect(JSON.stringify(firstPayload)).not.toContain("<user_content");

    const sessionId = String(firstPayload.sessionId);
    expect(db.linearIssueSessionRefs.get("lin-issue-22")).toBe(sessionId);
    expect(db.sessionWebhookRefs.get("linear_issue:lin-issue-22")?.has(sessionId)).toBe(true);

    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    expect(promptsRes.status).toBe(200);
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts).toHaveLength(1);
    expect(promptsBody.prompts[0].prompt).toContain("Repository: https://github.com/acme/repo");
    expect(promptsBody.prompts[0].prompt).toContain("Linear Issue: ARC-22");
    expect(promptsBody.prompts[0].prompt).toContain(
      "Issue URL: https://linear.app/acme/issue/ARC-22/implement-webhook-orchestration",
    );
    expect(promptsBody.prompts[0].prompt).toContain('<user_content source="linear_issue_title" author="linear_user">');
    expect(promptsBody.prompts[0].prompt).toContain("Implement webhook orchestration");
    expect(promptsBody.prompts[0].prompt).toContain(
      '<user_content source="linear_issue_description" author="linear_user">',
    );
    expect(promptsBody.prompts[0].prompt).toContain("Ensure linear webhook paths create and dispatch sessions.");
    expect(promptsBody.prompts[0].prompt).toContain(
      '<user_content source="linear_issue_metadata" author="linear_user">',
    );
    expect(promptsBody.prompts[0].prompt).toContain("Labels: cycloid, webhook");
    expect(promptsBody.prompts[0].prompt).toContain("Project: Control Plane");
    expect(promptsBody.prompts[0].prompt).toContain("Team: ENG");
    expect(promptsBody.prompts[0].prompt).toContain("Assignee: Linear Test User");
    expect(promptsBody.prompts[0].prompt).toContain("Priority: High");
    expect(promptsBody.prompts[0].prompt).not.toContain("Recent comments:");

    const secondBody = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "update",
        data: {
          id: "lin-issue-22",
          identifier: "ARC-22",
          title: "Implement webhook orchestration",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const secondSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), secondBody);
    const secondRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": secondSignature,
        "linear-delivery": "lin-delivery-update-22",
      },
      body: secondBody,
    });
    expect(secondRes.status).toBe(200);
    const secondPayload = await secondRes.json();
    expect(secondPayload.ok).toBe(true);
    expect(secondPayload.skipped).toBe(true);
    expect(secondPayload.reason).toBe("session_already_exists");
    expect(secondPayload.sessionId).toBe(sessionId);
  });

  it("returns 503 when a Linear issue claim is lost before any winner can be read", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/repo";
    db.addLinearUser("linear-uuid-claim-lost", 182, "linear-claim-lost-user");
    db.linearIssueSessionRefs.set("lin-issue-claim-lost", "s-stale-claim");
    db.linearIssueSessionRefReadMisses.add("lin-issue-claim-lost");

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-uuid-claim-lost", type: "user", name: "Linear Claim Lost User" },
        data: {
          id: "lin-issue-claim-lost",
          identifier: "ARC-661",
          title: "Retry transient claim loss",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-claim-lost",
      },
      body,
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "session_claim_lost" });
  });

  it("leaves the bootstrap job pending for sweep recovery when session creation throws (ARC-1051)", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/repo";
    db.addLinearUser("linear-uuid-session-throw", 183, "linear-session-throw-user");
    db.failSessionIndexInsert = new Error("D1_ERROR: failed session insert");

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-uuid-session-throw", type: "user", name: "Linear Session Throw User" },
        data: {
          id: "lin-issue-session-throw",
          identifier: "ARC-662",
          title: "Release claim on thrown session errors",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-session-throw",
      },
      body,
    });

    // A transient session-create failure no longer tears down the claim; the
    // durable bootstrap job is left pending (non-terminal) for the cron sweep.
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.pending).toBe(true);
    expect(db.linearIssueSessionRefs.get("lin-issue-session-throw")).toBeTruthy();
    const job = db.linearWebhookBootstrapJobs.get("lin-issue-session-throw");
    expect(job?.terminal_outcome).toBeNull();
    expect([...db.sessionIndex.keys()]).toEqual([]);
  });

  it("infers a Linear webhook repo from issue metadata when no explicit or default repo exists", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addLinearUser("linear-uuid-infer", 181, "linear-infer-user");
    await (env.REPOS_CACHE as FakeKV).put("repos:installations:version", "v-linear-infer");
    await (env.REPOS_CACHE as FakeKV).put(
      "repos:181",
      JSON.stringify({
        schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
        installationVersion: "v-linear-infer",
        repos: [
          {
            fullName: "acme/linear-inferred-repo",
            url: "https://github.com/acme/linear-inferred-repo",
            private: true,
            defaultBranch: "main",
            description: "Repository for Linear inferred sessions.",
          },
          {
            fullName: "acme/cycloid",
            url: "https://github.com/acme/cycloid",
            private: true,
            defaultBranch: "main",
            description: "Repo whose name matches the Linear trigger label and must not win inference.",
          },
          {
            fullName: "acme/other-service",
            url: "https://github.com/acme/other-service",
            private: true,
            defaultBranch: "main",
          },
        ],
        ssoOrgs: [],
      }),
    );

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-uuid-infer", type: "user", name: "Linear Infer User" },
        data: {
          id: "lin-issue-infer",
          identifier: "ARC-659",
          title: "Fix session startup from Linear",
          description: "The project name is the repo signal.",
          labels: [{ name: "cycloid" }],
          project: { name: "linear-inferred-repo" },
          team: { key: "ENG" },
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-infer",
      },
      body,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.created).toBe(true);
    expect(payload.repoSource).toBe("inferred");

    const sessionId = String(payload.sessionId);
    const sessionRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}`, {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    const sessionBody = await sessionRes.json();
    expect(sessionBody.session.repoOwner).toBe("acme");
    expect(sessionBody.session.repoName).toBe("linear-inferred-repo");

    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${sessionId}/prompts`, {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts[0].prompt).toContain("Repository: https://github.com/acme/linear-inferred-repo");
    expect(promptsBody.prompts[0].prompt).toContain("Project: linear-inferred-repo");
  });

  it("skips Linear webhook repo inference when candidate repos are unavailable", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.addLinearUser("linear-uuid-no-candidates", 182, "linear-no-candidates-user");
    db.addLinearToken(182, "lin-clarify-token");
    await (env.REPOS_CACHE as FakeKV).put("repos:installations:version", "v-linear-empty");
    await (env.REPOS_CACHE as FakeKV).put(
      "repos:182",
      JSON.stringify({
        schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
        installationVersion: "v-linear-empty",
        repos: [],
        ssoOrgs: [],
      }),
    );
    const commentCreateInputs: Array<{ issueId?: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      if (url === "https://api.linear.app/graphql") {
        const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
          query?: string;
          variables?: { input?: { issueId?: string; body?: string } };
        };
        expect(String(init?.body ?? "")).not.toContain("lin-clarify-token");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer lin-clarify-token");
        if (requestBody.query?.includes("viewer")) {
          return new Response(JSON.stringify({ data: { viewer: { id: "viewer-clarify" } } }), { status: 200 });
        }
        if (requestBody.query?.includes("LinearIssueRecentComments")) {
          return new Response(JSON.stringify({ data: { issue: { comments: { nodes: [] } } } }), { status: 200 });
        }
        if (requestBody.query?.includes("commentCreate")) {
          commentCreateInputs.push(requestBody.variables?.input ?? {});
          return new Response(JSON.stringify({ data: { commentCreate: { success: true } } }), { status: 200 });
        }
      }
      return originalFetch(input, init);
    });

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-uuid-no-candidates", type: "user", name: "Linear No Candidates User" },
        data: {
          id: "lin-issue-no-candidates",
          identifier: "ARC-660",
          title: "Ambiguous work",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const { ctx, flush } = createCapturingExecutionContext();
    const res = await workerFetch(
      workerModule,
      env,
      "/api/webhooks/linear",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": signature,
          "linear-delivery": "lin-delivery-no-candidates",
        },
        body,
      },
      ctx,
    );

    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody).toMatchObject({ ok: true, skipped: true, reason: "repo_inference_unknown" });
    expect(db.linearIssueSessionRefs.get("lin-issue-no-candidates")).toBeUndefined();
    // The skip-notice comment is posted out of band via ctx.waitUntil; drain it
    // so the assertion is deterministic instead of racing timer ticks.
    await flush();
    expect(commentCreateInputs).toEqual([
      {
        issueId: "lin-issue-no-candidates",
        body: "I couldn't determine which repo to use. Add `repo=owner/repo` to the issue description, or set a default repo in your Cycloid settings.",
      },
    ]);
  });

  it("includes recent Linear comments when an actor token is available", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/repo";
    db.addLinearUser("linear-uuid-78", 78, "linear-comment-user");
    db.addLinearToken(78, "lin-valid-token");
    const attachmentCreateInputs: Array<{ issueId?: string; title?: string; url?: string }> = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      if (url === "https://api.linear.app/graphql") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        expect(JSON.stringify(body)).not.toContain("lin-valid-token");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer lin-valid-token");
        if (body.query?.includes("viewer")) {
          return new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }), { status: 200 });
        }
        if (body.query?.includes("LinearIssueRecentComments")) {
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  comments: {
                    nodes: [{ body: "Comment context </user_content>", user: { name: "Commenter" } }],
                  },
                },
              },
            }),
            { status: 200 },
          );
        }
        if (body.query?.includes("attachmentCreate")) {
          attachmentCreateInputs.push(
            (body as { variables?: { input?: { issueId?: string; title?: string; url?: string } } }).variables?.input ??
              {},
          );
          return new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), { status: 200 });
      }
      return originalFetch(input, init);
    });
    globalThis.fetch = mockFetch;

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-uuid-78", type: "user", name: "Linear Comment User" },
        data: {
          id: "lin-issue-78",
          identifier: "ARC-78",
          title: "Implement comment context",
          url: "https://linear.app/acme/issue/ARC-78/implement-comment-context",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const { ctx, flush } = createCapturingExecutionContext();
    const res = await workerFetch(
      workerModule,
      env,
      "/api/webhooks/linear",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "linear-signature": signature,
          "linear-delivery": "lin-delivery-create-78",
        },
        body,
      },
      ctx,
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.enqueued).toBe(true);

    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${String(payload.sessionId)}/prompts`, {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts[0].prompt).toContain("Recent comments:");
    expect(promptsBody.prompts[0].prompt).toContain('<user_content source="linear_issue_comment" author="Commenter">');
    expect(promptsBody.prompts[0].prompt).toContain("Comment context &lt;/user_content&gt;");
    // The Linear attachment link-back runs out of band via ctx.waitUntil; drain
    // it so the assertion is deterministic instead of racing timer ticks.
    await flush();
    expect(attachmentCreateInputs).toHaveLength(1);
    expect(attachmentCreateInputs[0]).toMatchObject({
      issueId: "lin-issue-78",
      title: "Cycloid session for acme/repo",
      url: `https://app.trycycloid.com/sessions/${String(payload.sessionId)}`,
    });
  });

  it("continues without comments when the Linear comments fetch fails", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/repo";
    db.addLinearUser("linear-uuid-79", 79, "linear-fetch-fail-user");
    db.addLinearToken(79, "lin-valid-token");

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      if (url === "https://api.linear.app/graphql") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        if (body.query?.includes("viewer")) {
          return new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }), { status: 200 });
        }
        if (body.query?.includes("LinearIssueRecentComments")) {
          return new Response(JSON.stringify({ errors: [{ message: "unavailable" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), { status: 200 });
      }
      return originalFetch(input, init);
    });

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-uuid-79", type: "user", name: "Linear Fetch Fail User" },
        data: {
          id: "lin-issue-79",
          identifier: "ARC-79",
          title: "Implement without comments",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-create-79",
      },
      body,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.enqueued).toBe(true);

    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${String(payload.sessionId)}/prompts`, {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts[0].prompt).toContain("Implement without comments");
    expect(promptsBody.prompts[0].prompt).not.toContain("Recent comments:");
  });

  it("does not wait indefinitely for slow Linear prompt comments", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "https://github.com/acme/repo";
    db.addLinearUser("linear-uuid-80", 80, "linear-slow-comment-user");
    db.addLinearToken(80, "lin-valid-token");

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify({ id: 1 }), { status: 200 });
      }
      if (url === "https://api.linear.app/graphql") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        if (body.query?.includes("viewer")) {
          return new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }), { status: 200 });
        }
        if (body.query?.includes("LinearIssueRecentComments")) {
          return new Promise<Response>(() => {
            // Intentionally unresolved to exercise the webhook soft timeout path.
          });
        }
        return new Response(JSON.stringify({ data: { attachmentCreate: { success: true } } }), { status: 200 });
      }
      return originalFetch(input, init);
    });
    globalThis.fetch = mockFetch;

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-uuid-80", type: "user", name: "Linear Slow Comment User" },
        data: {
          id: "lin-issue-80",
          identifier: "ARC-80",
          title: "Implement with slow comments",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-create-80",
      },
      body,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.enqueued).toBe(true);

    const promptsRes = await workerFetch(workerModule, env, `/api/sessions/${String(payload.sessionId)}/prompts`, {
      headers: {
        authorization: "Bearer admin-secret",
      },
    });
    const promptsBody = await promptsRes.json();
    expect(promptsBody.prompts[0].prompt).toContain("Implement with slow comments");
    expect(promptsBody.prompts[0].prompt).not.toContain("Recent comments:");
    expect(
      mockFetch.mock.calls.some(([, init]) => String(init?.body ?? "").includes("LinearIssueRecentComments")),
    ).toBe(true);
  });

  it("skips Linear issue webhooks that do not contain the trigger label", async () => {
    const { env } = createWorkerEnv(workerModule);

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "update",
        data: {
          id: "lin-issue-23",
          identifier: "ARC-23",
          title: "No trigger label yet",
          labels: [{ name: "backend" }, { name: "triage" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-no-trigger",
      },
      body,
    });

    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody.ok).toBe(true);
    expect(responseBody.skipped).toBe(true);
    expect(responseBody.reason).toBe("trigger_label_missing");
  });

  it("skips Linear webhooks from non-user actors (e.g. integrations)", async () => {
    const { env } = createWorkerEnv(workerModule);

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "update",
        actor: { id: "integration-uuid-1", type: "Integration", name: "Some Integration" },
        data: {
          id: "lin-issue-30",
          identifier: "ARC-30",
          title: "Integration triggered issue",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-integration-actor",
      },
      body,
    });

    expect(res.status).toBe(200);
    const responseBody = await res.json();
    expect(responseBody.ok).toBe(true);
    expect(responseBody.skipped).toBe(true);
    expect(responseBody.reason).toBe("non_user_actor");
  });

  it("skips Linear webhook when LINEAR_DEFAULT_REPO_URL is an invalid repo URL", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.LINEAR_DEFAULT_REPO_URL = "cook";
    db.addLinearUser("linear-uuid-invalid-repo", 88, "linear-bad-repo-user");

    const body = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        actor: { id: "linear-uuid-invalid-repo", type: "user", name: "Linear Bad Repo" },
        data: {
          id: "lin-issue-invalid-repo",
          identifier: "ARC-99",
          title: "Issue with bad repo URL",
          labels: [{ name: "cycloid" }],
        },
      }),
    );
    const signature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), body);
    const res = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": signature,
        "linear-delivery": "lin-delivery-invalid-repo",
      },
      body,
    });

    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as { ok: boolean; skipped: boolean; reason: string };
    expect(responseBody.ok).toBe(true);
    expect(responseBody.skipped).toBe(true);
    expect(responseBody.reason).toBe("invalid_repo_url");
  });

  it("deduplicates Slack event and Linear webhook deliveries", async () => {
    const { env } = createWorkerEnv(workerModule);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const slackBody = JSON.stringify({
      type: "event_callback",
      event_id: "Ev123",
      event: { type: "app_mention", text: "<@U123> hi", channel: "C1", ts: "1", user: "U1" },
    });
    const slackSignature = createSlackSignature(String(env.SLACK_SIGNING_SECRET), timestamp, slackBody);

    const slackFirstRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSignature,
      },
      body: slackBody,
    });
    expect(slackFirstRes.status).toBe(200);
    const slackFirstBody = await slackFirstRes.json();
    expect(slackFirstBody.skipped).toBe(true);

    const slackDuplicateRes = await workerFetch(workerModule, env, "/api/webhooks/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSignature,
      },
      body: slackBody,
    });
    expect(slackDuplicateRes.status).toBe(200);
    const slackDuplicateBody = await slackDuplicateRes.json();
    expect(slackDuplicateBody.reason).toBe("duplicate");

    const linearBody = JSON.stringify(
      withLinearWebhookMetadata({
        type: "Issue",
        action: "create",
        data: { id: "issue-10" },
      }),
    );
    const linearSignature = createLinearSignature(String(env.LINEAR_WEBHOOK_SECRET), linearBody);

    const linearFirstRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": linearSignature,
        "linear-delivery": "lin-delivery-dedup-1",
      },
      body: linearBody,
    });
    expect(linearFirstRes.status).toBe(200);
    const linearFirstBody = await linearFirstRes.json();
    expect(linearFirstBody.skipped).toBe(true);

    const linearDuplicateRes = await workerFetch(workerModule, env, "/api/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": linearSignature,
        "linear-delivery": "lin-delivery-dedup-1",
      },
      body: linearBody,
    });
    expect(linearDuplicateRes.status).toBe(200);
    const linearDuplicateBody = await linearDuplicateRes.json();
    expect(linearDuplicateBody.reason).toBe("duplicate");
  });

  it("rejects session creation without repoUrl", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret",
      },
      body: JSON.stringify({ sessionId: "s-no-repo" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("repoUrl");
  });

  it("rejects session creation with an invalid repoUrl", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret",
      },
      body: JSON.stringify({ sessionId: "s-bad-url", repoUrl: "cook" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid repo URL");
  });

  it("rejects QA session creation when the prompt has multiple distinct pull request URLs", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret",
      },
      body: JSON.stringify({
        sessionId: "s-ambiguous-qa-target",
        ownerUserId: "2201",
        repoUrl: DEFAULT_REPO_URL,
        qa: true,
        prompt:
          "qa=true verify https://github.com/test-owner/test-repo/pull/1 and https://github.com/test-owner/test-repo/pull/2",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("multiple GitHub pull request URLs");
  });

  it("lets an explicit QA target override multiple prompt pull request URLs during session creation", async () => {
    const { env } = createWorkerEnv(workerModule);

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer admin-secret",
      },
      body: JSON.stringify({
        sessionId: "s-explicit-qa-target",
        ownerUserId: "2201",
        repoUrl: DEFAULT_REPO_URL,
        qa: true,
        targetPrUrl: "https://github.com/test-owner/test-repo/pull/3",
        prompt:
          "qa=true verify https://github.com/test-owner/test-repo/pull/1 and https://github.com/test-owner/test-repo/pull/2",
      }),
    });

    expect(res.status).toBe(201);
  });

  // Session CRUD lifecycle (create, list, get, close, archived) is
  // canonically tested in smoke/session-lifecycle.test.ts.

  it("uses the warmed repo cache during session creation instead of calling GitHub", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-user-cache", {
      user_id: 901,
      id: 901,
      expires_at: Date.now() + 60_000,
      login: "cacheuser",
      name: "Cache User",
      email: "cache@example.com",
    });

    await (env.REPOS_CACHE as FakeKV).put("repos:installations:version", "v1");
    await (env.REPOS_CACHE as FakeKV).put(
      "repos:901",
      JSON.stringify({
        schemaVersion: REPOS_CACHE_SCHEMA_VERSION,
        installationVersion: "v1",
        repos: [{ fullName: "test-owner/test-repo", url: DEFAULT_REPO_URL, private: true, defaultBranch: "main" }],
        ssoOrgs: [],
      }),
    );

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        throw new Error("session creation should not call the live GitHub repo check when cache is warm");
      }
      return originalFetch(input, init);
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-user-cache",
      },
      body: JSON.stringify({ sessionId: "s-cache", repoUrl: DEFAULT_REPO_URL }),
    });

    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.session.sessionId).toBe("s-cache");
  });

  // Auth invariants (expired token, admin bearer, cross-user 404) are
  // canonically tested in smoke/auth-flow.test.ts and smoke/cli-tokens.test.ts.

  it("enqueues prompts in DO-owned queue and completes via internal callback contract", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-user-4", {
      user_id: 404,
      id: 404,
      expires_at: Date.now() + 60_000,
      login: "user4",
      name: null,
      email: null,
    });

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-user-4",
      },
      // planMode:"off" — assert base DO-queue enqueue/callback mechanics without
      // plan mode's plan->implement handoff (default-on since ungating).
      body: JSON.stringify({ sessionId: "s-404", repoUrl: DEFAULT_REPO_URL, planMode: "off" }),
    });

    const enqueueRes = await workerFetch(workerModule, env, "/api/sessions/s-404/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-user-4",
      },
      body: JSON.stringify({ prompt: "ship the PR2b queue" }),
    });

    expect(enqueueRes.status).toBe(202);
    const enqueueBody = await enqueueRes.json();
    expect(enqueueBody.prompt.promptId).toBe("p-1");
    expect(enqueueBody.prompt.status).toBe("processing");
    expect(enqueueBody.queue.processingPromptId).toBe("p-1");
    // Narrowed enqueue response (ARC-1024): no raw prompt text, no callback credential.
    expect(enqueueBody.dispatch.promptId).toBe("p-1");
    expect(enqueueBody.dispatch.callback).toBeUndefined();
    expect(enqueueBody.dispatch.prompt).toBeUndefined();
    expect(enqueueBody.prompt.prompt).toBeUndefined();
    expect(enqueueBody.prompt.replyToText).toBeUndefined();
    expect(JSON.stringify(enqueueBody)).not.toContain("Bearer ");
    // Mint the callback auth the same way the DO does, rather than reading it from the response.
    const callbackAuth = `Bearer ${await generateSandboxPromptCallbackToken("s-404", "p-1", "sandbox-callback-secret")}`;

    const callbackRes = await workerFetch(workerModule, env, "/internal/sandbox/sessions/s-404/prompts/p-1/callback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: callbackAuth,
      },
      body: JSON.stringify({
        success: true,
        result: { summary: "completed" },
      }),
    });

    expect(callbackRes.status).toBe(200);
    const callbackBody = await callbackRes.json();
    expect(callbackBody.completedPrompt.status).toBe("completed");
    expect(callbackBody.nextDispatch).toBeNull();

    const listPromptsRes = await workerFetch(workerModule, env, "/api/sessions/s-404/prompts", {
      headers: { cookie: "session_token=sess-user-4" },
    });

    expect(listPromptsRes.status).toBe(200);
    const listPromptsBody = await listPromptsRes.json();
    expect(listPromptsBody.prompts).toHaveLength(1);
    expect(listPromptsBody.prompts[0].status).toBe("completed");
  });

  it("stores model and reasoningEffort on session creation", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-reasoning-1", {
      user_id: 801,
      id: 801,
      expires_at: Date.now() + 60_000,
      login: "reasoninguser",
      name: null,
      email: null,
    });

    // Create session with model and reasoningEffort
    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-reasoning-1",
      },
      body: JSON.stringify({
        sessionId: "s-reasoning",
        repoUrl: DEFAULT_REPO_URL,
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
      }),
    });

    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.session.model).toBe("gpt-5.4");
    expect(createBody.session.reasoningEffort).toBe("xhigh");

    const enqueueRes = await workerFetch(workerModule, env, "/api/sessions/s-reasoning/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-reasoning-1",
      },
      body: JSON.stringify({ prompt: "test model and reasoning list visibility" }),
    });
    expect(enqueueRes.status).toBe(202);

    // Verify model appears in session list
    const listRes = await workerFetch(workerModule, env, "/api/sessions", {
      headers: { cookie: "session_token=sess-reasoning-1" },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    const found = listBody.sessions.find((s: { sessionId: string }) => s.sessionId === "s-reasoning");
    expect(found).toBeDefined();
    expect(found.model).toBe("gpt-5.4");
    expect(found.reasoningEffort).toBe("xhigh");
  });

  it("stores a valid agentRuntimeBackend on session creation and defaults to codex", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.setAuthToken("sess-arb-1", {
      user_id: 811,
      id: 811,
      expires_at: Date.now() + 60_000,
      login: "arbuser",
      name: null,
      email: null,
    });

    // Default (omitted) → codex.
    const defaultRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session_token=sess-arb-1" },
      body: JSON.stringify({ sessionId: "s-arb-default", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(defaultRes.status).toBe(201);
    expect((await defaultRes.json()).session.agentRuntimeBackend).toBe("codex");

    // Explicit valid value persists.
    const explicitRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session_token=sess-arb-1" },
      body: JSON.stringify({
        sessionId: "s-arb-claude",
        repoUrl: DEFAULT_REPO_URL,
        agentRuntimeBackend: "claude_code",
      }),
    });
    expect(explicitRes.status).toBe(201);
    expect((await explicitRes.json()).session.agentRuntimeBackend).toBe("claude_code");
  });

  it("rejects an unknown agentRuntimeBackend with 400", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    db.setAuthToken("sess-arb-2", {
      user_id: 812,
      id: 812,
      expires_at: Date.now() + 60_000,
      login: "arbuser2",
      name: null,
      email: null,
    });

    const res = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session_token=sess-arb-2" },
      body: JSON.stringify({
        sessionId: "s-arb-bad",
        repoUrl: DEFAULT_REPO_URL,
        agentRuntimeBackend: "unknown_backend",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("stores the model default reasoningEffort when not provided", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-reasoning-2", {
      user_id: 802,
      id: 802,
      expires_at: Date.now() + 60_000,
      login: "noreasoninguser",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-reasoning-2",
      },
      body: JSON.stringify({ sessionId: "s-default-reasoning", repoUrl: DEFAULT_REPO_URL }),
    });

    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.session.reasoningEffort).toBe("medium");

    const enqueueRes = await workerFetch(workerModule, env, "/api/sessions/s-default-reasoning/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-reasoning-2",
      },
      body: JSON.stringify({ prompt: "test no reasoning" }),
    });

    expect(enqueueRes.status).toBe(202);
    const enqueueBody = await enqueueRes.json();
    expect(enqueueBody.prompt.reasoningEffort).toBe("medium");
  });

  it("rejects invalid reasoningEffort at session creation for known model", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-reasoning-3", {
      user_id: 803,
      id: 803,
      expires_at: Date.now() + 60_000,
      login: "invalidreasoninguser",
      name: null,
      email: null,
    });

    // "max" is not valid for GPT-5.4.
    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-reasoning-3",
      },
      body: JSON.stringify({
        sessionId: "s-bad-reasoning",
        repoUrl: DEFAULT_REPO_URL,
        model: "gpt-5.4",
        reasoningEffort: "max",
      }),
    });

    expect(createRes.status).toBe(400);
    const createBody = await createRes.json();
    expect(createBody.error).toBe("Invalid reasoningEffort for model gpt-5.4: max");
  });

  it("accepts supported Claude Code reasoningEffort at session creation", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-claude-reasoning", {
      user_id: 804,
      id: 804,
      expires_at: Date.now() + 60_000,
      login: "claudereasoninguser",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-claude-reasoning",
      },
      body: JSON.stringify({
        sessionId: "s-claude-reasoning",
        repoUrl: DEFAULT_REPO_URL,
        model: "claude-opus-4-8",
        reasoningEffort: "max",
      }),
    });

    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.session.agentRuntimeBackend).toBe("claude_code");
    expect(createBody.session.model).toBe("claude-opus-4-8");
    expect(createBody.session.reasoningEffort).toBe("max");
  });

  it("rejects unsupported Claude Code reasoningEffort at session creation", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-claude-reasoning-invalid", {
      user_id: 805,
      id: 805,
      expires_at: Date.now() + 60_000,
      login: "badclaudereasoninguser",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-claude-reasoning-invalid",
      },
      body: JSON.stringify({
        sessionId: "s-claude-bad-reasoning",
        repoUrl: DEFAULT_REPO_URL,
        model: "claude-sonnet-4-6",
        reasoningEffort: "xhigh",
      }),
    });

    expect(createRes.status).toBe(400);
    const createBody = await createRes.json();
    expect(createBody.error).toBe("Invalid reasoningEffort for model claude-sonnet-4-6: xhigh");
  });

  it("advances the next queued prompt after a callback completion", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-user-5", {
      user_id: 505,
      id: 505,
      expires_at: Date.now() + 60_000,
      login: "user5",
      name: null,
      email: null,
    });

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-user-5",
      },
      // planMode:"off" — assert base queue advance-on-callback without plan mode's
      // auto-enqueued implement turn (default-on since ungating).
      body: JSON.stringify({ sessionId: "s-505", repoUrl: DEFAULT_REPO_URL, planMode: "off" }),
    });

    const firstEnqueueRes = await workerFetch(workerModule, env, "/api/sessions/s-505/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-user-5",
      },
      body: JSON.stringify({ prompt: "first task" }),
    });
    expect(firstEnqueueRes.status).toBe(202);
    // ARC-1024: callback auth is no longer returned in the enqueue response; mint it as the DO does.
    const callbackAuth = `Bearer ${await generateSandboxPromptCallbackToken("s-505", "p-1", "sandbox-callback-secret")}`;

    const secondEnqueueRes = await workerFetch(workerModule, env, "/api/sessions/s-505/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-user-5",
      },
      body: JSON.stringify({ prompt: "second task" }),
    });

    expect(secondEnqueueRes.status).toBe(202);
    const secondEnqueueBody = await secondEnqueueRes.json();
    expect(secondEnqueueBody.prompt.promptId).toBe("p-2");
    expect(secondEnqueueBody.prompt.status).toBe("queued");
    expect(secondEnqueueBody.dispatch).toBeNull();

    const callbackRes = await workerFetch(workerModule, env, "/internal/sandbox/sessions/s-505/prompts/p-1/callback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: callbackAuth,
      },
      body: JSON.stringify({ success: true, result: { summary: "done first" } }),
    });

    expect(callbackRes.status).toBe(200);
    const callbackBody = await callbackRes.json();
    expect(callbackBody.completedPrompt.promptId).toBe("p-1");
    expect(callbackBody.completedPrompt.status).toBe("completed");
    expect(callbackBody.nextDispatch.promptId).toBe("p-2");
    expect(callbackBody.queue.processingPromptId).toBe("p-2");

    const listPromptsRes = await workerFetch(workerModule, env, "/api/sessions/s-505/prompts", {
      headers: { cookie: "session_token=sess-user-5" },
    });
    expect(listPromptsRes.status).toBe(200);
    const listPromptsBody = await listPromptsRes.json();
    expect(listPromptsBody.prompts[0].status).toBe("completed");
    expect(listPromptsBody.prompts[1].status).toBe("processing");
  });

  // Dual-write tests removed -- dual-write mirror feature was removed during router refactor

  // "skips dual-write mirroring" test removed -- dual-write mirror feature was removed during router refactor

  it("throws sandbox_error when E2B runtime config is not configured", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    delete env.E2B_API_KEY;

    db.setAuthToken("sess-no-e2b", {
      user_id: 999,
      id: 999,
      expires_at: Date.now() + 60_000,
      login: "user999",
      name: null,
      email: null,
    });

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-no-e2b",
      },
      body: JSON.stringify({ sessionId: "s-no-e2b", repoUrl: DEFAULT_REPO_URL }),
    });

    // Call /session/warm -- returns 202 but spawnSandbox throws internally
    const warmRes = await workerFetch(workerModule, env, "/api/sessions/s-no-e2b/warm", {
      method: "POST",
      headers: { cookie: "session_token=sess-no-e2b" },
    });
    expect(warmRes.status).toBe(202);
    const warmBody = (await warmRes.json()) as { ok: boolean; status: string };
    expect(warmBody.status).toBe("spawning");

    // Call /session/warm again -- spawn failure resets sandbox_status to "stopped",
    // so a second /warm triggers a new spawn attempt (no longer stuck in "spawning")
    const warmRes2 = await workerFetch(workerModule, env, "/api/sessions/s-no-e2b/warm", {
      method: "POST",
      headers: { cookie: "session_token=sess-no-e2b" },
    });
    expect(warmRes2.status).toBe(202);
    const warmBody2 = (await warmRes2.json()) as { ok: boolean; status: string };
    expect(warmBody2.status).toBe("spawning");
  });

  it("does not cold-create an expired paused runtime from a warm trigger", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    const now = Date.parse("2026-04-13T00:00:00.000Z");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      db.setAuthToken("sess-warm-expired", {
        user_id: 1301,
        id: 1301,
        expires_at: now + 60_000,
        login: "warm-expired-user",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-warm-expired",
        },
        body: JSON.stringify({ sessionId: "s-warm-expired", repoUrl: DEFAULT_REPO_URL }),
      });
      expect(createRes.status).toBe(201);
      forceStoppedResumableSession(env, "s-warm-expired", { runtimeStateExpiresAt: now - 1_000 });

      const warmRes = await workerFetch(workerModule, env, "/api/sessions/s-warm-expired/warm", {
        method: "POST",
        headers: { cookie: "session_token=sess-warm-expired" },
      });

      expect(warmRes.status).toBe(200);
      await expect(warmRes.json()).resolves.toMatchObject({ ok: true, status: "runtime_expired" });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not cold-create on page-open warm when no paused runtime exists", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    delete env.E2B_API_KEY;

    db.setAuthToken("sess-warm-open", {
      user_id: 1302,
      id: 1302,
      expires_at: Date.now() + 60_000,
      login: "warm-open-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-warm-open",
      },
      body: JSON.stringify({ sessionId: "s-warm-open", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    const warmRes = await workerFetch(workerModule, env, "/api/sessions/s-warm-open/warm?trigger=page_open", {
      method: "POST",
      headers: { cookie: "session_token=sess-warm-open" },
    });

    expect(warmRes.status).toBe(200);
    await expect(warmRes.json()).resolves.toMatchObject({ ok: true, status: "no_resumable_runtime" });
  });

  it("does not cold-create on page-open warm when the provider no longer has the paused runtime", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    e2bMocks.createSandbox.mockClear();
    e2bMocks.connectSandbox.mockRejectedValueOnce(new e2bMocks.E2BSandboxRuntimeError("missing_sandbox"));

    db.setAuthToken("sess-warm-open-stale", {
      user_id: 1303,
      id: 1303,
      expires_at: Date.now() + 60_000,
      login: "warm-open-stale-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-warm-open-stale",
      },
      body: JSON.stringify({ sessionId: "s-warm-open-stale", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);
    forceStoppedResumableSession(env, "s-warm-open-stale");
    e2bMocks.createSandbox.mockClear();

    const warmRes = await workerFetch(workerModule, env, "/api/sessions/s-warm-open-stale/warm?trigger=page_open", {
      method: "POST",
      headers: { cookie: "session_token=sess-warm-open-stale" },
    });
    expect(warmRes.status).toBe(202);
    await expect(warmRes.json()).resolves.toMatchObject({ ok: true, status: "spawning" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(e2bMocks.connectSandbox).toHaveBeenCalledWith("e2b-s-warm-open-stale");
    expect(e2bMocks.createSandbox).not.toHaveBeenCalled();
  });

  // Archive → unarchive → stopped → resume lifecycle is canonically
  // tested in smoke/session-lifecycle.test.ts.

  it("fails resume closed when repo access revalidation fails", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-resume-denied", {
      user_id: 1202,
      id: 1202,
      expires_at: Date.now() + 60_000,
      login: "denied-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-resume-denied",
      },
      body: JSON.stringify({ sessionId: "s-resume-denied", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return originalFetch(input, init);
    };

    const resumeRes = await workerFetch(workerModule, env, "/api/sessions/s-resume-denied/resume", {
      method: "POST",
      headers: { cookie: "session_token=sess-resume-denied" },
    });
    expect(resumeRes.status).toBe(403);
    const resumeBody = (await resumeRes.json()) as { error: string };
    expect(resumeBody.error).toBe("Access unavailable. Contact your administrator.");
  });

  it("fails resumable prompt sends closed when repo access revalidation fails", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-send-resume-denied", {
      user_id: 1205,
      id: 1205,
      expires_at: Date.now() + 60_000,
      login: "send-resume-denied-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-resume-denied",
      },
      body: JSON.stringify({ sessionId: "s-send-resume-denied", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    forceStoppedResumableSession(env, "s-send-resume-denied");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return originalFetch(input, init);
    };

    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-send-resume-denied/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-resume-denied",
      },
      body: JSON.stringify({ prompt: "resume from prompt send" }),
    });

    expect(promptRes.status).toBe(403);
    await expect(promptRes.json()).resolves.toMatchObject({
      error: "Access unavailable. Contact your administrator.",
    });
  });

  it("fails completed reaped prompt sends closed when repo access revalidation fails", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-send-completed-reap-denied", {
      user_id: 1208,
      id: 1208,
      expires_at: Date.now() + 60_000,
      login: "send-completed-reap-denied-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-completed-reap-denied",
      },
      body: JSON.stringify({ sessionId: "s-send-completed-reap-denied", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    forceCompletedNoPrReapedSession(env, "s-send-completed-reap-denied");

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return originalFetch(input, init);
    };

    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-send-completed-reap-denied/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-completed-reap-denied",
      },
      body: JSON.stringify({ prompt: "resume completed reaped session" }),
    });

    expect(promptRes.status).toBe(403);
    await expect(promptRes.json()).resolves.toMatchObject({
      error: "Access unavailable. Contact your administrator.",
    });
  });

  it("refreshes installationId on resumable prompt sends before enqueueing", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-send-resume-refresh", {
      user_id: 1206,
      id: 1206,
      expires_at: Date.now() + 60_000,
      login: "send-resume-refresh-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-resume-refresh",
      },
      body: JSON.stringify({ sessionId: "s-send-resume-refresh", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    forceStoppedResumableSession(env, "s-send-resume-refresh", { installationId: 1 });
    db.githubInstallations.set("test-owner", {
      installation_id: 77,
      owner_login: "test-owner",
      owner_id: 1,
      owner_type: "Organization",
      repository_selection: "all",
      created_at: Date.now(),
      suspended_at: null,
    });
    // Direct fake-DB seeding bypasses the DAO mutation functions, so the
    // read-through installation cache must be cleared by hand.
    const installationsDbModForSeed = await import("../../apps/control-plane-worker/src/github/installations-db.js");
    installationsDbModForSeed.resetInstallationByOwnerCacheForTests();

    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-send-resume-refresh/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-resume-refresh",
      },
      body: JSON.stringify({ prompt: "refresh install and resume" }),
    });

    expect(promptRes.status).toBe(202);

    const sessionRes = await workerFetch(workerModule, env, "/api/sessions/s-send-resume-refresh", {
      headers: { cookie: "session_token=sess-send-resume-refresh" },
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = (await sessionRes.json()) as { session: { installationId: number | null } };
    expect(sessionBody.session.installationId).toBe(77);
  });

  it("refreshes installationId on completed reaped prompt sends before enqueueing", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-send-completed-reap-refresh", {
      user_id: 1209,
      id: 1209,
      expires_at: Date.now() + 60_000,
      login: "send-completed-reap-refresh-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-completed-reap-refresh",
      },
      body: JSON.stringify({ sessionId: "s-send-completed-reap-refresh", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    forceCompletedNoPrReapedSession(env, "s-send-completed-reap-refresh", { installationId: 1 });
    db.githubInstallations.set("test-owner", {
      installation_id: 99,
      owner_login: "test-owner",
      owner_id: 1,
      owner_type: "Organization",
      repository_selection: "all",
      created_at: Date.now(),
      suspended_at: null,
    });
    const installationsDbModForSeed = await import("../../apps/control-plane-worker/src/github/installations-db.js");
    installationsDbModForSeed.resetInstallationByOwnerCacheForTests();

    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-send-completed-reap-refresh/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-completed-reap-refresh",
      },
      body: JSON.stringify({ prompt: "refresh install and resume completed reaped session" }),
    });

    expect(promptRes.status).toBe(202);

    const sessionRes = await workerFetch(workerModule, env, "/api/sessions/s-send-completed-reap-refresh", {
      headers: { cookie: "session_token=sess-send-completed-reap-refresh" },
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = (await sessionRes.json()) as { session: { installationId: number | null } };
    expect(sessionBody.session.installationId).toBe(99);
  });

  it("skips resumable-send revalidation for non-resumable sessions", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-send-idle", {
      user_id: 1207,
      id: 1207,
      expires_at: Date.now() + 60_000,
      login: "send-idle-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-idle",
      },
      body: JSON.stringify({ sessionId: "s-send-idle", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    db.githubInstallations.set("test-owner", {
      installation_id: 88,
      owner_login: "test-owner",
      owner_id: 1,
      owner_type: "Organization",
      repository_selection: "all",
      created_at: Date.now(),
      suspended_at: null,
    });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("api.github.com/repos/")) {
        throw new Error("idle prompt send should not revalidate repo access");
      }
      return originalFetch(input, init);
    });

    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-send-idle/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-idle",
      },
      body: JSON.stringify({ prompt: "normal queued prompt" }),
    });

    expect(promptRes.status).toBe(202);

    const sessionRes = await workerFetch(workerModule, env, "/api/sessions/s-send-idle", {
      headers: { cookie: "session_token=sess-send-idle" },
    });
    expect(sessionRes.status).toBe(200);
    const sessionBody = (await sessionRes.json()) as { session: { installationId: number | null } };
    expect(sessionBody.session.installationId).toBe(1);
  });

  it("forwards resumable prompt-send rate-limit responses from the DO", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-send-resume-rate", {
      user_id: 1208,
      id: 1208,
      expires_at: Date.now() + 60_000,
      login: "send-resume-rate-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-resume-rate",
      },
      body: JSON.stringify({ sessionId: "s-send-resume-rate", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    forceStoppedResumableSession(env, "s-send-resume-rate");

    for (let i = 0; i < 5; i += 1) {
      const resumeRes = await workerFetch(workerModule, env, "/api/sessions/s-send-resume-rate/resume", {
        method: "POST",
        headers: { cookie: "session_token=sess-send-resume-rate" },
      });
      expect([202, 409]).toContain(resumeRes.status);
      forceStoppedResumableSession(env, "s-send-resume-rate");
    }

    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-send-resume-rate/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-send-resume-rate",
      },
      body: JSON.stringify({ prompt: "too soon" }),
    });

    expect(promptRes.status).toBe(429);
    await expect(promptRes.json()).resolves.toMatchObject({
      error: "Resume is being retried too quickly. Please wait a moment and try again.",
    });
  });

  it("rate limits repeated resume requests per session and user", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    const now = Date.parse("2026-04-13T00:00:00.000Z");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      db.setAuthToken("sess-resume-rate", {
        user_id: 1204,
        id: 1204,
        expires_at: now + 60_000,
        login: "resume-rate-user",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-resume-rate",
        },
        body: JSON.stringify({ sessionId: "s-resume-rate", repoUrl: DEFAULT_REPO_URL }),
      });
      expect(createRes.status).toBe(201);

      for (let i = 0; i < 5; i += 1) {
        const resumeRes = await workerFetch(workerModule, env, "/api/sessions/s-resume-rate/resume", {
          method: "POST",
          headers: { cookie: "session_token=sess-resume-rate" },
        });
        expect([202, 409]).toContain(resumeRes.status);
      }

      const limitedRes = await workerFetch(workerModule, env, "/api/sessions/s-resume-rate/resume", {
        method: "POST",
        headers: { cookie: "session_token=sess-resume-rate" },
      });
      expect(limitedRes.status).toBe(429);
      const limitedBody = (await limitedRes.json()) as { error: string };
      expect(limitedBody.error).toContain("too quickly");

      dateNow.mockReturnValue(now + 29_000);
      const sameWindowRes = await workerFetch(workerModule, env, "/api/sessions/s-resume-rate/resume", {
        method: "POST",
        headers: { cookie: "session_token=sess-resume-rate" },
      });
      expect(sameWindowRes.status).toBe(429);

      dateNow.mockReturnValue(now + 30_001);
      const nextWindowRes = await workerFetch(workerModule, env, "/api/sessions/s-resume-rate/resume", {
        method: "POST",
        headers: { cookie: "session_token=sess-resume-rate" },
      });
      expect([202, 409]).toContain(nextWindowRes.status);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("rate limits repeated warm requests per session and user", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    const now = Date.parse("2026-04-13T00:00:00.000Z");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      db.setAuthToken("sess-warm-rate", {
        user_id: 1209,
        id: 1209,
        expires_at: now + 60_000,
        login: "warm-rate-user",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-warm-rate",
        },
        body: JSON.stringify({ sessionId: "s-warm-rate", repoUrl: DEFAULT_REPO_URL }),
      });
      expect(createRes.status).toBe(201);

      const installation = db.githubInstallations.get("test-owner");
      expect(installation).toBeDefined();
      if (installation) installation.suspended_at = now;

      for (let i = 0; i < 5; i += 1) {
        forceStoppedResumableSession(env, "s-warm-rate");
        const warmRes = await workerFetch(workerModule, env, "/api/sessions/s-warm-rate/warm", {
          method: "POST",
          headers: { cookie: "session_token=sess-warm-rate" },
        });
        expect(warmRes.status).toBe(403);
      }

      forceStoppedResumableSession(env, "s-warm-rate");
      const limitedRes = await workerFetch(workerModule, env, "/api/sessions/s-warm-rate/warm", {
        method: "POST",
        headers: { cookie: "session_token=sess-warm-rate" },
      });
      expect(limitedRes.status).toBe(429);
      await expect(limitedRes.json()).resolves.toMatchObject({
        error: "Warm is being retried too quickly. Please wait a moment and try again.",
      });

      dateNow.mockReturnValue(now + 30_001);
      forceStoppedResumableSession(env, "s-warm-rate");
      const nextWindowRes = await workerFetch(workerModule, env, "/api/sessions/s-warm-rate/warm", {
        method: "POST",
        headers: { cookie: "session_token=sess-warm-rate" },
      });
      expect(nextWindowRes.status).toBe(403);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("rate limits warm requests before non-warmable phase rejection", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    const now = Date.parse("2026-04-13T00:00:00.000Z");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      db.setAuthToken("sess-warm-running-rate", {
        user_id: 1210,
        id: 1210,
        expires_at: now + 60_000,
        login: "warm-running-rate-user",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-warm-running-rate",
        },
        body: JSON.stringify({ sessionId: "s-warm-running-rate", repoUrl: DEFAULT_REPO_URL }),
      });
      expect(createRes.status).toBe(201);

      getSessionDoInstance(env, "s-warm-running-rate").state?.storage.sql.exec(
        "UPDATE sandbox_state SET status = ? WHERE session_id = ?",
        "spawning",
        "s-warm-running-rate",
      );

      for (let i = 0; i < 5; i += 1) {
        const warmRes = await workerFetch(workerModule, env, "/api/sessions/s-warm-running-rate/warm", {
          method: "POST",
          headers: { cookie: "session_token=sess-warm-running-rate" },
        });
        expect(warmRes.status).toBe(409);
      }

      const limitedRes = await workerFetch(workerModule, env, "/api/sessions/s-warm-running-rate/warm", {
        method: "POST",
        headers: { cookie: "session_token=sess-warm-running-rate" },
      });
      expect(limitedRes.status).toBe(429);
      await expect(limitedRes.json()).resolves.toMatchObject({
        error: "Warm is being retried too quickly. Please wait a moment and try again.",
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("atomically rate limits concurrent resume requests per session and user", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    const now = Date.parse("2026-04-13T00:00:00.000Z");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      db.setAuthToken("sess-resume-rate-concurrent", {
        user_id: 1206,
        id: 1206,
        expires_at: now + 60_000,
        login: "resume-rate-concurrent-user",
        name: null,
        email: null,
      });

      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session_token=sess-resume-rate-concurrent",
        },
        body: JSON.stringify({ sessionId: "s-resume-rate-concurrent", repoUrl: DEFAULT_REPO_URL }),
      });
      expect(createRes.status).toBe(201);

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          workerFetch(workerModule, env, "/api/sessions/s-resume-rate-concurrent/resume", {
            method: "POST",
            headers: { cookie: "session_token=sess-resume-rate-concurrent" },
          }),
        ),
      );
      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 429)).toHaveLength(1);
      expect(statuses.filter((status) => status === 202 || status === 409)).toHaveLength(5);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("cleans expired resume rate-limit counters on alarm", async () => {
    const now = Date.parse("2026-04-13T00:00:00.000Z");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const state = new FakeDurableState();
    const limiter = new workerModule.SessionResumeRateLimiterDO(state, {}) as {
      fetch(request: Request): Promise<Response>;
      alarm(): Promise<void>;
    };

    try {
      const response = await limiter.fetch(
        new Request("https://rate-limiter.test/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ max: 5, windowSeconds: 30 }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await state.storage.getAlarm()).toBe(now + 30_000);
      expect(state.storage._get("counter")).toEqual({
        failureTimestampsMs: [now],
        expiresAt: now + 30_000,
      });

      dateNow.mockReturnValue(now + 29_999);
      await limiter.alarm();
      expect(state.storage._get("counter")).toBeDefined();
      expect(await state.storage.getAlarm()).toBe(now + 30_000);

      dateNow.mockReturnValue(now + 30_000);
      await limiter.alarm();
      expect(state.storage._get("counter")).toBeUndefined();
    } finally {
      dateNow.mockRestore();
    }
  });

  it("allows resume when the rate-limit backend is unavailable", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    env.SESSION_RESUME_RATE_LIMITER = {
      idFromName: () => "broken-session-resume-limiter",
      get: () => ({
        fetch: async () => {
          throw new Error("limiter unavailable");
        },
      }),
    };

    db.setAuthToken("sess-resume-rate-fail-open", {
      user_id: 1205,
      id: 1205,
      expires_at: Date.now() + 60_000,
      login: "resume-rate-fail-open-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-resume-rate-fail-open",
      },
      body: JSON.stringify({ sessionId: "s-resume-rate-fail-open", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    const resumeRes = await workerFetch(workerModule, env, "/api/sessions/s-resume-rate-fail-open/resume", {
      method: "POST",
      headers: { cookie: "session_token=sess-resume-rate-fail-open" },
    });
    expect([202, 409]).toContain(resumeRes.status);
  });

  it("does not expose the unarchive route", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-unarchive-suspended", {
      user_id: 1203,
      id: 1203,
      expires_at: Date.now() + 60_000,
      login: "suspended-user",
      name: null,
      email: null,
    });

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-unarchive-suspended",
      },
      body: JSON.stringify({ sessionId: "s-unarchive-suspended", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    const archiveRes = await workerFetch(workerModule, env, "/api/sessions/s-unarchive-suspended", {
      method: "DELETE",
      headers: { cookie: "session_token=sess-unarchive-suspended" },
    });
    expect(archiveRes.status).toBe(200);

    const unarchiveRes = await workerFetch(workerModule, env, "/api/sessions/s-unarchive-suspended/unarchive", {
      method: "POST",
      headers: { cookie: "session_token=sess-unarchive-suspended" },
    });
    expect(unarchiveRes.status).toBe(404);
  });

  it("serves SSE compatibility replay from durable events", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-user-8", {
      user_id: 808,
      id: 808,
      expires_at: Date.now() + 60_000,
      login: "user8",
      name: null,
      email: null,
    });

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-user-8",
      },
      body: JSON.stringify({ sessionId: "s-808", repoUrl: DEFAULT_REPO_URL }),
    });

    const promptRes808 = await workerFetch(workerModule, env, "/api/sessions/s-808/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-user-8",
      },
      body: JSON.stringify({ prompt: "stream me" }),
    });
    const callbackAuth808 = `Bearer ${await generateSandboxPromptCallbackToken("s-808", "p-1", "sandbox-callback-secret")}`;

    await workerFetch(workerModule, env, "/internal/sandbox/sessions/s-808/prompts/p-1/callback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: callbackAuth808,
      },
      body: JSON.stringify({ success: true }),
    });

    const eventsRes = await workerFetch(workerModule, env, "/api/sessions/s-808/events", {
      headers: {
        cookie: "session_token=sess-user-8",
        "last-event-id": "event-1",
      },
    });

    expect(eventsRes.status).toBe(200);
    expect(eventsRes.headers.get("content-type")).toContain("text/event-stream");
    const sseBody = await eventsRes.text();
    expect(sseBody).toContain("event: status");
    expect(sseBody).toContain("event: prompt_completed");
    expect(sseBody).toContain("id: 2");
    expect(sseBody).not.toContain("id: 1");
  });

  it("uses query cursor precedence for SSE and falls back to Last-Event-ID when query cursor is invalid", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-user-811", {
      user_id: 811,
      id: 811,
      expires_at: Date.now() + 60_000,
      login: "user811",
      name: null,
      email: null,
    });

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-user-811",
      },
      body: JSON.stringify({ sessionId: "s-811", repoUrl: DEFAULT_REPO_URL }),
    });

    const promptRes811 = await workerFetch(workerModule, env, "/api/sessions/s-811/prompts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-user-811",
      },
      body: JSON.stringify({ prompt: "cursor parity" }),
    });
    const callbackAuth811 = `Bearer ${await generateSandboxPromptCallbackToken("s-811", "p-1", "sandbox-callback-secret")}`;

    await workerFetch(workerModule, env, "/internal/sandbox/sessions/s-811/prompts/p-1/callback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: callbackAuth811,
      },
      body: JSON.stringify({ success: true }),
    });

    const queryPreferredRes = await workerFetch(workerModule, env, "/api/sessions/s-811/events?afterSequence=1", {
      headers: {
        cookie: "session_token=sess-user-811",
        "last-event-id": "event-99",
      },
    });
    expect(queryPreferredRes.status).toBe(200);
    const queryPreferredBody = await queryPreferredRes.text();
    expect(queryPreferredBody).toContain("id: 2");
    expect(queryPreferredBody).not.toContain("id: 1");

    const headerFallbackRes = await workerFetch(workerModule, env, "/api/sessions/s-811/events?afterSequence=oops", {
      headers: {
        cookie: "session_token=sess-user-811",
        "last-event-id": "event-1",
      },
    });
    expect(headerFallbackRes.status).toBe(200);
    const headerFallbackBody = await headerFallbackRes.text();
    expect(headerFallbackBody).toContain("id: 2");
    expect(headerFallbackBody).not.toContain("id: 1");
  });

  it("exposes replay window helpers for websocket resume truncation behavior", async () => {
    expect(workerModule.resolveReplayCursor("5", "event-10")).toBe(5);
    expect(workerModule.resolveReplayCursor("bad", "event-10")).toBe(10);
    expect(workerModule.resolveReplayCursor(null, null)).toBe(0);

    const events = Array.from({ length: 205 }, (_, index) => ({
      sequence: index + 1,
      type: "prompt_processing",
      data: { index },
    }));
    const replayWindow = workerModule.selectReplayWindow(events, "event-1", 200);
    expect(replayWindow.afterSequence).toBe(1);
    expect(replayWindow.truncated).toBe(true);
    expect(replayWindow.droppedCount).toBe(1);
    expect(replayWindow.events[0].sequence).toBe(6);
    expect(replayWindow.events[replayWindow.events.length - 1].sequence).toBe(205);
  });

  // "reconciles mirrored dual-write state" test removed -- dual-write mirror feature was removed during router refactor

  it("implements websocket path with upgrade guard and session access checks", async () => {
    const { env, db } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-owner-ws", {
      user_id: 909,
      id: 909,
      expires_at: Date.now() + 60_000,
      login: "ownerws",
      name: null,
      email: null,
    });

    db.setAuthToken("sess-other-ws", {
      user_id: 910,
      id: 910,
      expires_at: Date.now() + 60_000,
      login: "otherws",
      name: null,
      email: null,
    });

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session_token=sess-owner-ws",
      },
      body: JSON.stringify({ sessionId: "s-909", repoUrl: DEFAULT_REPO_URL }),
    });

    const noUpgradeRes = await workerFetch(workerModule, env, "/api/sessions/s-909/ws", {
      headers: { cookie: "session_token=sess-owner-ws" },
    });
    expect(noUpgradeRes.status).toBe(426);

    const crossUserRes = await workerFetch(workerModule, env, "/api/sessions/s-909/ws", {
      headers: {
        cookie: "session_token=sess-other-ws",
        upgrade: "websocket",
      },
    });
    expect(crossUserRes.status).toBe(404);

    const wsGlobal = globalThis as { WebSocketPair?: unknown };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = undefined;

    try {
      const runtimeWsRes = await workerFetch(workerModule, env, "/api/sessions/s-909/ws", {
        headers: {
          cookie: "session_token=sess-owner-ws",
          upgrade: "websocket",
        },
      });

      expect(runtimeWsRes.status).toBe(501);
      const runtimeWsBody = await runtimeWsRes.json();
      expect(runtimeWsBody.error).toContain("WebSocketPair");
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }
  });

  // Callback auth, cross-user prompt/replay/export denial, and ARC-453
  // regression are canonically tested in smoke/auth-flow.test.ts and
  // smoke/cli-tokens.test.ts.
});
