import { beforeEach, describe, expect, it, vi } from "vitest";

const getSlackExternalIdForUser = vi.hoisted(() => vi.fn());
const getLinkedSlackTeamIdForUser = vi.hoisted(() => vi.fn());
const getBusinessIdForUser = vi.hoisted(() => vi.fn());
const setLinkedSlackTeamIdForUser = vi.hoisted(() => vi.fn());
const getBotTokenForTeam = vi.hoisted(() => vi.fn());
const getUserInfo = vi.hoisted(() => vi.fn());
const getSoleActiveWorkspaceInstallForBusiness = vi.hoisted(() => vi.fn());
const postDirectMessage = vi.hoisted(() => vi.fn());
const publishPlanApprovalInteractionButton = vi.hoisted(() => vi.fn());
const postStructuredEventToDd = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({ info: logInfo, warn: vi.fn() }),
}));

vi.mock("../../apps/control-plane-worker/src/slack/link-db", () => ({
  getSlackExternalIdForUser,
  getLinkedSlackTeamIdForUser,
  getBusinessIdForUser,
  setLinkedSlackTeamIdForUser,
}));
vi.mock("../../apps/control-plane-worker/src/slack/workspaces", () => ({
  getBotTokenForTeam,
  getSoleActiveWorkspaceInstallForBusiness,
}));
vi.mock("../../apps/control-plane-worker/src/slack/notify", () => ({
  postDirectMessage,
  getUserInfo,
}));
vi.mock("../../apps/control-plane-worker/src/slack/plan-approval-interactions", () => ({
  publishPlanApprovalInteractionButton,
}));
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd,
}));

import { BlockerKind } from "../../apps/control-plane-worker/src/enums/blocker.js";
import {
  notifyUserBlocked,
  resolveBlockedDmTarget,
} from "../../apps/control-plane-worker/src/session/notify-user-blocked.js";
import type { CallbackContext, Env } from "../../apps/control-plane-worker/src/types.js";

/** Minimal in-memory KVNamespace stub. */
function fakeKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

/** Minimal in-memory DurableObjectStorage stub for the replay-flag path. */
function fakeStorage(): DurableObjectStorage & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (key: string) => store.get(key),
    put: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => store.delete(key),
  } as unknown as DurableObjectStorage & { store: Map<string, unknown> };
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    RATE_LIMITS: fakeKv(),
    TOKEN_ENCRYPTION_KEY: "test-key",
    FRONTEND_URL: "https://app.example.com",
    ...overrides,
  } as unknown as Env;
}

const slackCtx: CallbackContext = {
  source: "slack",
  channel: "C1",
  threadTs: "111.222",
  slackTeamId: "T_FROM_CONTEXT",
};

beforeEach(() => {
  vi.clearAllMocks();
  getSlackExternalIdForUser.mockResolvedValue("U_OWNER");
  getLinkedSlackTeamIdForUser.mockResolvedValue(null);
  getBusinessIdForUser.mockResolvedValue(null);
  getSoleActiveWorkspaceInstallForBusiness.mockResolvedValue(null);
  setLinkedSlackTeamIdForUser.mockResolvedValue(undefined);
  getBotTokenForTeam.mockResolvedValue("xoxb-token");
  getUserInfo.mockResolvedValue({ id: "U_OWNER" });
  postDirectMessage.mockResolvedValue({ ok: true, channel: "D_OWNER", ts: "1" });
  publishPlanApprovalInteractionButton.mockResolvedValue("request-1");
  postStructuredEventToDd.mockResolvedValue(true);
});

describe("resolveBlockedDmTarget", () => {
  it("returns null when the user has no linked Slack id", async () => {
    getSlackExternalIdForUser.mockResolvedValue(null);
    const target = await resolveBlockedDmTarget(makeEnv(), { ownerUserId: 7 });
    expect(target).toBeNull();
    expect(getBotTokenForTeam).not.toHaveBeenCalled();
  });

  it("uses the Slack-origin team from callback context when present", async () => {
    const target = await resolveBlockedDmTarget(makeEnv(), { ownerUserId: 7, callbackContext: slackCtx });
    expect(target).toEqual({
      botToken: "xoxb-token",
      slackUserId: "U_OWNER",
      teamId: "T_FROM_CONTEXT",
      teamSource: "slack_context",
    });
    expect(getBotTokenForTeam).toHaveBeenCalledWith(expect.anything(), "T_FROM_CONTEXT", "test-key");
    // Slack-origin context short-circuits the ledger/business lookups.
    expect(getLinkedSlackTeamIdForUser).not.toHaveBeenCalled();
  });

  it("falls back to the linked team when there is no Slack-origin context", async () => {
    getLinkedSlackTeamIdForUser.mockResolvedValue("T_LINKED");
    const target = await resolveBlockedDmTarget(makeEnv(), { ownerUserId: 7 });
    expect(target?.teamId).toBe("T_LINKED");
    expect(target?.teamSource).toBe("linked");
  });

  it("falls back to the sole active business install when the linked team is missing", async () => {
    getBusinessIdForUser.mockResolvedValue("biz-1");
    getSoleActiveWorkspaceInstallForBusiness.mockResolvedValue({ teamId: "T_BUSINESS" });
    const target = await resolveBlockedDmTarget(makeEnv(), { ownerUserId: 7 });
    expect(target).toMatchObject({ teamId: "T_BUSINESS", teamSource: "sole_business_install" });
    expect(getBotTokenForTeam).toHaveBeenCalledWith(expect.anything(), "T_BUSINESS", "test-key");
  });

  it("falls back when the linked team is no longer installed", async () => {
    getLinkedSlackTeamIdForUser.mockResolvedValue("T_STALE");
    getBusinessIdForUser.mockResolvedValue("biz-1");
    getSoleActiveWorkspaceInstallForBusiness.mockResolvedValue({ teamId: "T_BUSINESS" });
    getBotTokenForTeam.mockImplementation(async (_db: unknown, teamId: string) =>
      teamId === "T_STALE" ? null : "xoxb-token",
    );
    const target = await resolveBlockedDmTarget(makeEnv(), { ownerUserId: 7 });
    expect(target).toMatchObject({ teamId: "T_BUSINESS", teamSource: "sole_business_install" });
  });

  it("fails closed when the fallback workspace cannot resolve the stored Slack id", async () => {
    getBusinessIdForUser.mockResolvedValue("biz-1");
    getSoleActiveWorkspaceInstallForBusiness.mockResolvedValue({ teamId: "T_BUSINESS" });
    getUserInfo.mockResolvedValue(null);
    const target = await resolveBlockedDmTarget(makeEnv(), { ownerUserId: 7 });
    expect(target).toBeNull();
  });

  it("fails closed when the Slack id has no authoritative team or sole business install", async () => {
    getLinkedSlackTeamIdForUser.mockResolvedValue(null);
    const target = await resolveBlockedDmTarget(makeEnv(), { ownerUserId: 7 });
    expect(target).toBeNull();
    expect(getBotTokenForTeam).not.toHaveBeenCalled();
  });

  it("returns null when the resolved team has no decryptable bot token", async () => {
    getLinkedSlackTeamIdForUser.mockResolvedValue("T_LINKED");
    getBotTokenForTeam.mockResolvedValue(null);
    const target = await resolveBlockedDmTarget(makeEnv(), { ownerUserId: 7 });
    expect(target).toBeNull();
  });
});

describe("notifyUserBlocked", () => {
  const baseArgs = {
    sessionId: "sess-1",
    ownerUserId: 7,
    kind: BlockerKind.MergeConflict,
    dedupKey: "prompt-1:branch-x",
  } as const;

  it("sends a DM and records dedup only after success", async () => {
    const env = makeEnv();
    const kv = env.RATE_LIMITS as unknown as { store: Map<string, string> };
    const result = await notifyUserBlocked(env, { ...baseArgs, callbackContext: slackCtx });
    expect(result).toBe("sent");
    expect(postDirectMessage).toHaveBeenCalledTimes(1);
    expect([...kv.store.keys()]).toEqual(["blocked-dm:sess-1:merge_conflict:prompt-1:branch-x"]);
    expect(postStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "blocked_dm",
        outcome: "sent",
        session_id: "sess-1",
        kind: BlockerKind.MergeConflict,
        origin: "slack",
        team_source: "slack_context",
        team_id: "T_FROM_CONTEXT",
      }),
    );
  });

  it("does not record dedup when the Slack send fails (fail-open to retry)", async () => {
    postDirectMessage.mockResolvedValue({ ok: false, error: "dm_open_failed" });
    const env = makeEnv();
    const kv = env.RATE_LIMITS as unknown as { store: Map<string, string> };
    const result = await notifyUserBlocked(env, { ...baseArgs, callbackContext: slackCtx });
    expect(result).toBe("failed");
    expect(kv.store.size).toBe(0);
  });

  it("writes back the fallback team only after a successful send", async () => {
    getBusinessIdForUser.mockResolvedValue("biz-1");
    getSoleActiveWorkspaceInstallForBusiness.mockResolvedValue({ teamId: "T_BUSINESS" });
    const result = await notifyUserBlocked(makeEnv(), baseArgs);
    expect(result).toBe("sent");
    expect(setLinkedSlackTeamIdForUser).toHaveBeenCalledWith(expect.anything(), 7, "T_BUSINESS");

    setLinkedSlackTeamIdForUser.mockClear();
    postDirectMessage.mockResolvedValue({ ok: false, error: "dm_open_failed" });
    const failed = await notifyUserBlocked(makeEnv(), { ...baseArgs, dedupKey: "failed" });
    expect(failed).toBe("failed");
    expect(setLinkedSlackTeamIdForUser).not.toHaveBeenCalled();
  });

  it("keeps a sent result when fallback team write-back fails", async () => {
    getBusinessIdForUser.mockResolvedValue("biz-1");
    getSoleActiveWorkspaceInstallForBusiness.mockResolvedValue({ teamId: "T_BUSINESS" });
    setLinkedSlackTeamIdForUser.mockRejectedValue(new Error("d1 unavailable"));
    await expect(notifyUserBlocked(makeEnv(), baseArgs)).resolves.toBe("sent");
  });

  it("dedupes a re-entry on the same key via KV", async () => {
    const env = makeEnv();
    await notifyUserBlocked(env, { ...baseArgs, callbackContext: slackCtx });
    postDirectMessage.mockClear();
    const second = await notifyUserBlocked(env, { ...baseArgs, callbackContext: slackCtx });
    expect(second).toBe("skipped_deduped");
    expect(postDirectMessage).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "blocked_dm", outcome: "skipped_deduped", origin: "slack" }),
      "blocked_dm",
    );
  });

  it("re-notifies when the dedup key changes (new branch/fingerprint)", async () => {
    const env = makeEnv();
    await notifyUserBlocked(env, { ...baseArgs, callbackContext: slackCtx });
    postDirectMessage.mockClear();
    const second = await notifyUserBlocked(env, {
      ...baseArgs,
      dedupKey: "prompt-1:branch-y",
      callbackContext: slackCtx,
    });
    expect(second).toBe("sent");
    expect(postDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("does not double-send across a DO replay (storage flag set, KV lost)", async () => {
    const storage = fakeStorage();
    // First send records the DO-storage flag.
    await notifyUserBlocked(makeEnv(), { ...baseArgs, callbackContext: slackCtx, storage });
    postDirectMessage.mockClear();
    // Replay: fresh env (KV gone), same storage carries the flag.
    const replay = await notifyUserBlocked(makeEnv(), { ...baseArgs, callbackContext: slackCtx, storage });
    expect(replay).toBe("skipped_deduped");
    expect(postDirectMessage).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "blocked_dm", outcome: "skipped_deduped", origin: "slack" }),
      "blocked_dm",
    );
  });

  it("commits the DO replay flag even when the KV put fails (DO-first ordering)", async () => {
    // Crash guarantee: the DO flag must land before the external KV put, so a
    // failure/crash during the KV put is still caught on replay by the DO flag.
    const storage = fakeStorage();
    const kv = fakeKv();
    kv.put = (async () => {
      throw new Error("kv put failed mid-flight");
    }) as KVNamespace["put"];
    const first = await notifyUserBlocked(makeEnv({ RATE_LIMITS: kv }), {
      ...baseArgs,
      callbackContext: slackCtx,
      storage,
    });
    expect(first).toBe("sent");
    expect(storage.store.size).toBe(1);
    // Replay with a fresh env (KV unhelpful): the DO flag alone dedupes.
    postDirectMessage.mockClear();
    const replay = await notifyUserBlocked(makeEnv(), { ...baseArgs, callbackContext: slackCtx, storage });
    expect(replay).toBe("skipped_deduped");
    expect(postDirectMessage).not.toHaveBeenCalled();
  });

  it("re-notifies after the DO dedup TTL elapses (DO flag is not permanent)", async () => {
    // Fresh env each call => KV never carries; isolates the DO-storage TTL.
    const storage = fakeStorage();
    const t0 = 1_700_000_000_000;
    const first = await notifyUserBlocked(makeEnv(), { ...baseArgs, callbackContext: slackCtx, storage, now: t0 });
    expect(first).toBe("sent");
    postDirectMessage.mockClear();
    const within = await notifyUserBlocked(makeEnv(), {
      ...baseArgs,
      callbackContext: slackCtx,
      storage,
      now: t0 + 60_000,
    });
    expect(within).toBe("skipped_deduped");
    const after = await notifyUserBlocked(makeEnv(), {
      ...baseArgs,
      callbackContext: slackCtx,
      storage,
      now: t0 + 25 * 60 * 60 * 1000, // past the ~24h window
    });
    expect(after).toBe("sent");
    expect(postDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("skips when the user has no linked Slack id", async () => {
    getSlackExternalIdForUser.mockResolvedValue(null);
    const result = await notifyUserBlocked(makeEnv(), baseArgs);
    expect(result).toBe("skipped_no_slack");
    expect(postDirectMessage).not.toHaveBeenCalled();
    expect(postStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "blocked_dm", outcome: "skipped_no_slack", team_source: "none", team_id: null }),
    );
  });

  it("skips when the encryption key is unconfigured", async () => {
    const result = await notifyUserBlocked(makeEnv({ TOKEN_ENCRYPTION_KEY: undefined }), {
      ...baseArgs,
      callbackContext: slackCtx,
    });
    expect(result).toBe("skipped_unconfigured");
    expect(postDirectMessage).not.toHaveBeenCalled();
  });

  it("never throws and returns failed when a DAO read errors", async () => {
    getSlackExternalIdForUser.mockRejectedValue(new Error("d1 boom"));
    const result = await notifyUserBlocked(makeEnv(), { ...baseArgs, callbackContext: slackCtx });
    expect(result).toBe("failed");
  });

  it("sends fixed copy with no raw error text and links the session", async () => {
    await notifyUserBlocked(makeEnv(), { ...baseArgs, callbackContext: slackCtx });
    const sentText = postDirectMessage.mock.calls[0][2] as string;
    expect(sentText).toContain("https://app.example.com/sessions/sess-1");
    expect(sentText).not.toMatch(/error|exception|stack|prompt-1|branch-x/i);
    // baseArgs carries no prUrl, so the DM omits the optional "PR:" link line.
    expect(sentText).not.toMatch(/^PR: /m);
  });

  it("sends PlanReady blocks with a plain-text fallback and attached-plan session link", async () => {
    const result = await notifyUserBlocked(makeEnv(), {
      sessionId: "sess-1",
      ownerUserId: 7,
      kind: BlockerKind.PlanReady,
      dedupKey: "p-1:1",
      callbackContext: slackCtx,
      planReadyApproval: { businessId: "biz-1", revision: 1 },
    });

    expect(result).toBe("sent");
    const sentText = postDirectMessage.mock.calls[0][2] as string;
    expect(sentText).toContain("plan is ready");
    expect(sentText).toContain("https://app.example.com/sessions/sess-1");
    expect(postDirectMessage.mock.calls[0][3]).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: expect.stringContaining(
            "<https://app.example.com/sessions/sess-1|The plan is attached to this message. Edit or discuss it in Cycloid>",
          ),
        },
      },
    ]);
    expect(publishPlanApprovalInteractionButton).toHaveBeenCalledWith(
      expect.objectContaining({ DB: expect.anything() }),
      {
        businessId: "biz-1",
        sessionId: "sess-1",
        revision: 1,
        slackTeamId: "T_FROM_CONTEXT",
        slackChannelId: "D_OWNER",
        messageTs: "1",
        botToken: "xoxb-token",
        planMarkdown: null,
      },
    );
  });

  it("keeps a usable link-only PlanReady DM when button publication fails", async () => {
    publishPlanApprovalInteractionButton.mockRejectedValue(new Error("D1 unavailable"));

    const result = await notifyUserBlocked(makeEnv(), {
      sessionId: "sess-1",
      ownerUserId: 7,
      kind: BlockerKind.PlanReady,
      dedupKey: "p-1:1",
      callbackContext: slackCtx,
      planReadyApproval: { businessId: "biz-1", revision: 1 },
    });

    expect(result).toBe("sent");
    expect(postDirectMessage).toHaveBeenCalledTimes(1);
    expect(postDirectMessage.mock.calls[0][3]).toEqual([expect.objectContaining({ type: "section" })]);
  });

  it("keeps the PlanReady link-only fallback appendable for the later Slack action block", async () => {
    const trailingBlock = { type: "context", elements: [{ type: "plain_text", text: "Later action slot" }] };

    await notifyUserBlocked(makeEnv(), {
      sessionId: "sess-1",
      ownerUserId: 7,
      kind: BlockerKind.PlanReady,
      dedupKey: "p-1:1",
      callbackContext: slackCtx,
      planReadyAdditionalBlocks: [trailingBlock],
    });

    const blocks = postDirectMessage.mock.calls[0][3] as unknown[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "section" });
    expect(blocks[1]).toBe(trailingBlock);
  });
});
