import { type Mock, vi } from "vitest";

import { BaseFakeD1Statement } from "./fake-d1";

// ---------------------------------------------------------------------------
// Fake D1 used by Slack webhook tests
// ---------------------------------------------------------------------------

export interface FakeSlackRepoDisambiguationRow {
  id: string;
  channel_id: string;
  thread_ts: string;
  message_ts: string | null;
  actor_user_id: string;
  actor_slack_user_id: string | null;
  prompt_text: string;
  attachment_file_ids_json?: string | null;
  attachment_omitted_count?: number | null;
  candidates_json: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export class FakeWebhookD1 {
  // The installed workspace's bot user id. Defaults to the same id channel
  // fixtures mention (`<@UBOT123>`) and the default `getSlackBotUserId` mock
  // returns, mirroring the production invariant that the stored bot id and the
  // live `auth.test` id are the same identity. DM tests that drive a different
  // bot id override this so the workspace id stays aligned with their trigger.
  workspaceBotUserId = "UBOT123";
  readonly sessionIndex = new Set<string>();
  readonly sessionIndexRepoContext = new Map<string, { repo_owner: string | null; repo_name: string | null }>();
  readonly slackThreadSessionRefs = new Map<string, string>();
  readonly ingestionEvents = new Map<string, Record<string, unknown>>();
  readonly slackChannelIntake = new Map<string, Record<string, unknown>>();
  readonly webhookIdempotency = new Map<string, Record<string, unknown>>();
  readonly slackRepoDisambiguations = new Map<string, FakeSlackRepoDisambiguationRow>();
  readonly userGithubIds = new Map<number, number>();
  readonly userBusinessMemberships = new Map<number, { businessId: string; role: "admin" | "member" }>();

  prepare(query: string): SlackWebhookFakeStatement {
    return new SlackWebhookFakeStatement(this, query);
  }
}

class SlackWebhookFakeStatement extends BaseFakeD1Statement<FakeWebhookD1> {
  override async run(): Promise<{ success: true; meta?: { changes: number } }> {
    if (this.isSchemaQuery()) {
      return { success: true };
    }
    if (this.query.includes("INSERT INTO user_integrations")) {
      return { success: true };
    }
    if (this.query.includes("DELETE FROM user_integrations")) {
      return { success: true };
    }
    if (this.query.includes("INTO webhook_idempotency")) {
      const [idempotencyKey, source, payloadHash] = this.boundValues as [string, string, string | null];
      // Real schema is UNIQUE(idempotency_key, source); mirror that here so
      // tests sharing an idempotency key across sources (e.g. github + slack)
      // do not collide.
      const dedupeKey = `${source}:${idempotencyKey}`;
      if (this.db.webhookIdempotency.has(dedupeKey)) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.webhookIdempotency.set(dedupeKey, { source, payloadHash });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.query.includes("INSERT INTO slack_thread_session_refs")) {
      const [businessId, teamId, channelId, threadTs, sessionId] =
        this.boundValues.length === 3
          ? ([null, null, ...this.boundValues] as [null, null, string, string, string])
          : (this.boundValues as [string, string, string, string, string]);
      const key = businessId && teamId ? `${businessId}:${teamId}:${channelId}:${threadTs}` : null;
      const legacyKey = `${channelId}:${threadTs}`;
      if ((key && this.db.slackThreadSessionRefs.has(key)) || this.db.slackThreadSessionRefs.has(legacyKey)) {
        return { success: true, meta: { changes: 0 } };
      }
      if (key) this.db.slackThreadSessionRefs.set(key, sessionId);
      this.db.slackThreadSessionRefs.set(legacyKey, sessionId);
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
      const key = businessId && teamId ? `${businessId}:${teamId}:${channelId}:${threadTs}` : null;
      const legacyKey = `${channelId}:${threadTs}`;
      const storedSessionId =
        (key ? this.db.slackThreadSessionRefs.get(key) : undefined) ?? this.db.slackThreadSessionRefs.get(legacyKey);
      if (storedSessionId !== sessionId) {
        return { success: true, meta: { changes: 0 } };
      }
      if (key) this.db.slackThreadSessionRefs.delete(key);
      this.db.slackThreadSessionRefs.delete(legacyKey);
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
    if (this.query.includes("INSERT INTO session_webhook_refs")) {
      return { success: true };
    }
    if (this.query.includes("INSERT OR IGNORE INTO ingestion_events")) {
      const [
        id,
        businessId,
        sourceType,
        sourceEventId,
        sourceUri,
        sourceTimeMs,
        contentHash,
        contentText,
        contentRef,
        scopeType,
        scopeId,
        actorRef,
        teamId,
        channelId,
        threadTs,
        untrustedPayload,
        processingState,
        redactionReason,
        skipReason,
      ] = this.boundValues as [
        string,
        string,
        string,
        string | null,
        string,
        number,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
        string,
        string | null,
        string | null,
      ];
      const key = sourceEventId ? `${businessId}:${sourceType}:${sourceEventId}` : id;
      if (this.db.ingestionEvents.has(key)) return { success: true, meta: { changes: 0 } };
      this.db.ingestionEvents.set(key, {
        id,
        businessId,
        sourceType,
        sourceEventId,
        sourceUri,
        sourceTimeMs,
        contentHash,
        contentText,
        contentRef,
        scopeType,
        scopeId,
        actorRef,
        teamId,
        channelId,
        threadTs,
        untrustedPayload,
        processingState,
        redactionReason,
        skipReason,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.query.includes("INSERT INTO slack_repo_disambiguations")) {
      const [
        id,
        channelId,
        threadTs,
        messageTs,
        actorUserId,
        actorSlackUserId,
        promptText,
        attachmentFileIdsJson,
        attachmentOmittedCount,
        candidatesJson,
        createdAt,
        expiresAt,
      ] = this.boundValues as [
        string,
        string,
        string,
        string | null,
        string,
        string | null,
        string,
        string | null,
        number,
        string,
        number,
        number,
      ];
      this.db.slackRepoDisambiguations.set(id, {
        id,
        channel_id: channelId,
        thread_ts: threadTs,
        message_ts: messageTs,
        actor_user_id: actorUserId,
        actor_slack_user_id: actorSlackUserId,
        prompt_text: promptText,
        attachment_file_ids_json: attachmentFileIdsJson,
        attachment_omitted_count: attachmentOmittedCount,
        candidates_json: candidatesJson,
        created_at: createdAt,
        expires_at: expiresAt,
        consumed_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.query.includes("UPDATE slack_repo_disambiguations")) {
      const [consumedAt, id, now] = this.boundValues as [number, string, number];
      const row = this.db.slackRepoDisambiguations.get(id);
      if (!row || row.consumed_at !== null || row.expires_at <= now) {
        return { success: true, meta: { changes: 0 } };
      }
      row.consumed_at = consumedAt;
      return { success: true, meta: { changes: 1 } };
    }
    if (this.query.includes("DELETE FROM slack_repo_disambiguations")) {
      return { success: true, meta: { changes: 0 } };
    }
    return this.unhandled("run");
  }

  override async first<T = Record<string, unknown>>(): Promise<T | null> {
    if (this.query.includes("FROM slack_thread_session_refs")) {
      const [businessId, teamId, channelId, threadTs] =
        this.boundValues.length === 2
          ? ([null, null, ...this.boundValues] as [null, null, string, string])
          : (this.boundValues as [string, string, string, string]);
      const sessionId =
        (businessId && teamId
          ? this.db.slackThreadSessionRefs.get(`${businessId}:${teamId}:${channelId}:${threadTs}`)
          : undefined) ?? this.db.slackThreadSessionRefs.get(`${channelId}:${threadTs}`);
      return (sessionId ? { session_id: sessionId } : null) as T | null;
    }
    if (this.query.includes("FROM slack_workspaces")) {
      const [teamId] = this.boundValues as [string];
      return {
        team_id: teamId,
        bot_user_id: this.db.workspaceBotUserId,
        team_name: "Test Workspace",
        business_id: "biz-1",
        team_domain: "test-workspace",
        enterprise_id: null,
        installed_by_user_id: 1,
        installed_at: 1,
        updated_at: 1,
        uninstalled_at: null,
      } as T;
    }
    if (this.query.includes("FROM slack_channel_intake")) {
      const [businessId, teamId, channelId] = this.boundValues as [string, string, string];
      return (this.db.slackChannelIntake.get(`${businessId}:${teamId}:${channelId}`) ?? null) as T | null;
    }
    if (this.query.includes("FROM ingestion_events")) {
      return null;
    }
    if (this.query.includes("FROM session_index")) {
      const [sessionId] = this.boundValues as [string];
      if (this.query.includes("repo_owner") || this.query.includes("repo_name")) {
        return (this.db.sessionIndexRepoContext.get(sessionId) ?? null) as T | null;
      }
      return (this.db.sessionIndex.has(sessionId) ? { session_id: sessionId } : null) as T | null;
    }
    if (this.query.includes("FROM slack_repo_disambiguations")) {
      const [id] = this.boundValues as [string];
      const row = this.db.slackRepoDisambiguations.get(id);
      return (row ?? null) as T | null;
    }
    if (this.query.includes("FROM user_slack_links")) {
      return null;
    }
    if (this.query.includes("SELECT github_id FROM users WHERE id = ?")) {
      const [userId] = this.boundValues as [number];
      const githubId = this.db.userGithubIds.get(userId);
      return (githubId === undefined ? null : { github_id: githubId }) as T | null;
    }
    if (
      this.query.includes("u.business_id") &&
      this.query.includes("bm.role AS business_role") &&
      this.query.includes("WHERE u.id = ?")
    ) {
      const [userId] = this.boundValues as [number];
      const githubId = this.db.userGithubIds.get(userId);
      const membership = this.db.userBusinessMemberships.get(userId);
      return (
        membership
          ? {
              github_id: githubId ?? null,
              business_id: membership.businessId,
              business_role: membership.role,
            }
          : null
      ) as T | null;
    }
    if (this.query.includes("SELECT business_id FROM users WHERE id = ?")) {
      return { business_id: "biz-1" } as T;
    }
    if (this.query.includes("FROM user_settings")) {
      return null;
    }
    if (this.query.includes("FROM github_installations")) {
      return { installation_id: 12345, owner_login: "test-owner" } as unknown as T;
    }
    // user_integrations queries (integrations/db.ts + integrations/service.ts)
    if (this.query.includes("FROM user_integrations") && this.query.includes("oauth_access_token")) {
      return {
        oauth_access_token: "ghp_test",
        oauth_refresh_token: null,
        oauth_expires_at: null,
        encrypted: 0,
      } as unknown as T;
    }
    if (this.query.includes("FROM user_integrations")) {
      return null;
    }
    // business_members queries (integrations/service.ts)
    if (this.query.includes("FROM business_members")) {
      return null;
    }
    // business_integrations queries
    if (this.query.includes("FROM business_integrations")) {
      return null;
    }
    return this.unhandled("first");
  }

  override async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    if (this.query.includes("FROM user_integrations") || this.query.includes("FROM business_integrations")) {
      return { results: [] };
    }
    // Mirror run()/first(): fail fast on unknown queries so fake/real drift
    // surfaces in tests instead of silently returning empty results.
    return this.unhandled("all");
  }
}

// ---------------------------------------------------------------------------
// Slack webhook request builders
// ---------------------------------------------------------------------------

export type SlackEventOverrides = {
  eventId?: string;
  teamId?: string | null;
  event?: Record<string, unknown>;
};

const SLACK_EVENTS_URL = "https://test/api/webhooks/slack/events";
const SLACK_INTERACTIONS_URL = "https://test/api/webhooks/slack/interactions";

function defaultSlackHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
    "x-slack-signature": "v0=test",
  };
}

function applyHeaderOverrides(
  base: Record<string, string>,
  overrides: Record<string, string | null>,
): Record<string, string> {
  const merged = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) {
      delete merged[k];
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

/**
 * Builds an `event_callback`-shaped Slack webhook request used by the main
 * handler describe block. The default event is an `app_mention` carrying
 * `<@UBOT123> <text>` in `C_TEST` from `U_SENDER`.
 */
export function buildSlackEventRequest(text: string, overrides: SlackEventOverrides = {}): Request {
  const body = JSON.stringify({
    type: "event_callback",
    event_id: overrides.eventId ?? `evt_${Date.now()}_${Math.random()}`,
    ...(overrides.teamId === null ? {} : { team_id: overrides.teamId ?? "T_TEST" }),
    event: {
      type: "app_mention",
      text: `<@UBOT123> ${text}`,
      channel: "C_TEST",
      ts: `${Date.now() / 1000}`,
      user: "U_SENDER",
      ...overrides.event,
    },
  });
  return new Request(SLACK_EVENTS_URL, {
    method: "POST",
    headers: { ...defaultSlackHeaders("application/json"), "x-slack-signature": "v0=test" },
    body,
  });
}

/**
 * Builds a bare Slack events webhook request used by signature-verification
 * tests, where the test only cares about the signature headers, not the body.
 * Override individual headers with `null` to remove them.
 */
export function buildSlackEventsBareRequest(overrideHeaders: Record<string, string | null> = {}, body = "{}"): Request {
  const headers = applyHeaderOverrides(
    { ...defaultSlackHeaders("application/json"), "x-slack-signature": "v0=test-sig" },
    overrideHeaders,
  );
  return new Request(SLACK_EVENTS_URL, { method: "POST", headers, body });
}

/**
 * Builds a Slack interactions webhook request (form-encoded payload) used by
 * signature-verification tests. Override individual headers with `null` to
 * remove them.
 */
export function buildSlackInteractionsRequest(overrideHeaders: Record<string, string | null> = {}): Request {
  const headers = applyHeaderOverrides(
    { ...defaultSlackHeaders("application/x-www-form-urlencoded"), "x-slack-signature": "v0=test-sig" },
    overrideHeaders,
  );
  const body = new URLSearchParams({ payload: JSON.stringify({ trigger_id: "t1", actions: [] }) }).toString();
  return new Request(SLACK_INTERACTIONS_URL, { method: "POST", headers, body });
}

// ---------------------------------------------------------------------------
// Worker env + execution context
// ---------------------------------------------------------------------------

/**
 * Builds the minimal worker env used by Slack webhook tests: a fake D1, the
 * Slack signing secret + bot token, and a stubbed SESSION durable namespace.
 * `overrides` shallow-merges into the env; pass `undefined` for an existing
 * key (e.g. `SLACK_BOT_TOKEN: undefined`) to delete it.
 */
export function buildSlackFakeEnv(db: FakeWebhookD1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DB: db,
    SLACK_SIGNING_SECRET: "test-secret",
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SESSION: {
      get: () => ({ fetch: vi.fn().mockResolvedValue(new Response("ok")) }),
      idFromName: (name: string) => name,
    },
    ...overrides,
  };
}

export interface FakeExecutionContext {
  ctx: ExecutionContext;
  waitUntilPromises: Promise<unknown>[];
  flush(options?: { timeoutMs?: number }): Promise<void>;
}

/**
 * Builds a fake `ExecutionContext` whose `waitUntil` collects promises so the
 * test can flush the background work after the handler returns.
 *
 * `flush` bounds each drain batch by `timeoutMs` (default 2s): a `waitUntil`
 * promise that never settles would otherwise hang the test until the whole-suite
 * timeout with no diagnostic. The budget is per batch, not a global wall-clock
 * deadline — a handler that enqueues N sequential waves of `waitUntil` work
 * (each wave starting only after the previous resolves) can run up to
 * N × `timeoutMs` before throwing. On timeout it throws naming how many promises
 * were still pending so the regression is legible. It also surfaces the first
 * rejection rather than swallowing it.
 */
export function buildFakeExecutionContext(): FakeExecutionContext {
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  return {
    ctx,
    waitUntilPromises,
    async flush(options = {}) {
      const timeoutMs = options.timeoutMs ?? 2000;
      // Drain via a cursor instead of mutating `waitUntilPromises` (tests inspect
      // its length). Handlers may push more promises while we await, so loop
      // until the cursor catches up to the array.
      let awaited = 0;
      while (awaited < waitUntilPromises.length) {
        const batch = waitUntilPromises.slice(awaited);
        awaited = waitUntilPromises.length;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all(batch),
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                reject(new Error(`Timed out after ${timeoutMs}ms flushing ${batch.length} waitUntil promise(s)`));
              }, timeoutMs);
            }),
          ]);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Async polling
// ---------------------------------------------------------------------------

/**
 * Polls `assertion` until it stops throwing or `timeoutMs` elapses, rethrowing
 * the last error on timeout. Useful for fire-and-forget post-handler work.
 */
export async function waitForAssertion(assertion: () => void, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch stubbing
// ---------------------------------------------------------------------------

/**
 * Stubs `globalThis.fetch` so any `api.github.com/repos/...` call returns a
 * minimal `{ id: 1 }` response, while other URLs fall through to the real
 * fetch. Returns an idempotent cleanup function that restores the original
 * fetch on the first call and no-ops on subsequent calls (so a defensive
 * double-cleanup in `afterEach` cannot clobber a fetch installed by a later
 * test setup between calls).
 */
export function installGithubReposFetchStub(): () => void {
  const originalFetch = globalThis.fetch;
  const stubbedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (url.includes("api.github.com/repos/")) {
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = stubbedFetch;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    // Only roll back if our stub is still installed; if a later test setup
    // replaced fetch, leave their value alone.
    if (globalThis.fetch === stubbedFetch) {
      globalThis.fetch = originalFetch;
    }
  };
}

// ---------------------------------------------------------------------------
// Mock reset defaults
// ---------------------------------------------------------------------------

/**
 * The full set of mocks the Slack webhook handler tests stub through `vi.mock`.
 * Test files declare these at module scope (so `vi.mock` factories can reach
 * them lazily) and pass the bag to {@link resetSlackWebhookMocks} from each
 * `beforeEach` to keep defaults in sync.
 */
export interface SlackWebhookMocks {
  postThreadReply: Mock;
  addReaction: Mock;
  removeReaction: Mock;
  getConversationInfo: Mock;
  getSlackBotUserId: Mock;
  getThreadReplies: Mock;
  hasSlackFileAttachments: Mock;
  processSlackAttachments: Mock;
  processSlackAttachmentsFromMessages: Mock;
  fetchRepoSkills: Mock;
  listAccessibleReposForUser: Mock;
  postStructuredEventToDd: Mock;
  queryOpenAIStructuredOutput: Mock;
  verifySlackWebhookSignature: Mock;
  getUserBySlackId: Mock;
  getUserBySlackIdForTeam: Mock;
  getUserBusinessIdOrNull: Mock;
  isIntegrationAvailable: Mock;
  getUserSettings: Mock;
  getUserSettingsIfExists: Mock;
  syncSessionProjection: Mock;
  createSessionState: Mock;
  enqueueSessionPrompt: Mock;
  resolveInstalledSlackBotToken: Mock;
}

function defaultNewSession(sessionId: string): { sessionId: string } {
  return { sessionId };
}

function defaultEnqueuePayload(sessionId: string) {
  return {
    ok: true,
    status: 200,
    payload: {
      session: { sessionId },
      replay: {},
      prompt: { id: "p-1" },
      dispatch: null,
    },
  };
}

/**
 * Resets every mock in the bag and reinstalls the default behavior. Tests can
 * subsequently override individual mocks with `mockResolvedValueOnce` etc.
 */
export function resetSlackWebhookMocks(mocks: SlackWebhookMocks): void {
  mocks.postThreadReply.mockReset().mockResolvedValue({ ok: true });
  mocks.addReaction.mockReset().mockResolvedValue({ ok: true });
  mocks.removeReaction.mockReset().mockResolvedValue({ ok: true });
  mocks.getConversationInfo.mockReset().mockResolvedValue(null);
  mocks.getSlackBotUserId.mockReset().mockResolvedValue("UBOT123");
  mocks.getThreadReplies.mockReset().mockResolvedValue([]);
  mocks.hasSlackFileAttachments
    .mockReset()
    .mockImplementation((event: Record<string, unknown> | undefined) =>
      Boolean(
        event &&
        ((Array.isArray(event.files) && event.files.length > 0) ||
          (Array.isArray(event.attachments) && event.attachments.length > 0)),
      ),
    );
  mocks.processSlackAttachments.mockReset().mockResolvedValue({ uploadedFiles: [], uploadedImages: [], skipped: [] });
  mocks.processSlackAttachmentsFromMessages.mockReset().mockImplementation((...args: unknown[]) => {
    const [token, messages, options] = args;
    const eventOrMessages = Array.isArray(messages) && messages.length === 1 ? messages[0] : messages;
    if (options && Object.keys(options as Record<string, unknown>).length > 0) {
      return mocks.processSlackAttachments(token, eventOrMessages, options);
    }
    return mocks.processSlackAttachments(token, eventOrMessages);
  });
  mocks.fetchRepoSkills.mockReset().mockResolvedValue([]);
  mocks.listAccessibleReposForUser.mockReset().mockResolvedValue({ ok: true, repos: [], cacheStatus: "hit" });
  mocks.postStructuredEventToDd.mockReset().mockResolvedValue(undefined);
  mocks.queryOpenAIStructuredOutput.mockReset();
  mocks.verifySlackWebhookSignature.mockReset().mockResolvedValue(true);
  mocks.getUserBySlackId.mockReset().mockResolvedValue({ id: 1, login: "test-user" });
  mocks.getUserBySlackIdForTeam.mockReset().mockResolvedValue({ id: 1, login: "test-user" });
  mocks.getUserBusinessIdOrNull.mockReset().mockResolvedValue(null);
  mocks.isIntegrationAvailable.mockReset().mockResolvedValue(true);
  mocks.getUserSettings.mockReset().mockResolvedValue({ default_repo: null });
  mocks.getUserSettingsIfExists.mockReset().mockResolvedValue({});
  mocks.syncSessionProjection.mockReset().mockResolvedValue(undefined);
  mocks.resolveInstalledSlackBotToken.mockReset().mockResolvedValue("xoxb-team-token");
  mocks.createSessionState.mockReset().mockImplementation(async (_env: unknown, sessionId: string) => ({
    session: defaultNewSession(sessionId),
    replay: {},
  }));
  mocks.enqueueSessionPrompt
    .mockReset()
    .mockImplementation(async (_env: unknown, sessionId: string) => defaultEnqueuePayload(sessionId));
}
