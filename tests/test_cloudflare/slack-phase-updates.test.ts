import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../apps/control-plane-worker/src/types";

const doDbMocks = vi.hoisted(() => ({
  getSessionExtended: vi.fn(),
  getSession: vi.fn(),
}));

const tokenMocks = vi.hoisted(() => ({
  resolveSlackBotTokenForCallback: vi.fn(),
}));

const controlMocks = vi.hoisted(() => ({
  syncCardControlRequests: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/session/do-db.js", () => ({
  getSessionExtended: doDbMocks.getSessionExtended,
  getSession: doDbMocks.getSession,
}));

vi.mock("../../apps/control-plane-worker/src/slack/tokens", () => ({
  resolveSlackBotTokenForCallback: tokenMocks.resolveSlackBotTokenForCallback,
}));

vi.mock("../../apps/control-plane-worker/src/slack/card-control-requests", () => ({
  syncCardControlRequests: controlMocks.syncCardControlRequests,
}));

import {
  updateSlackStatusCardFromSessionState,
  updateSlackStatusStageInPlace,
} from "../../apps/control-plane-worker/src/slack/phase-updates";

const fetchMock = vi.fn();
const log = { info: vi.fn(), warn: vi.fn() };
const env = { FRONTEND_URL: "https://app.trycycloid.com" } as unknown as Env;
const sql = {} as SqlStorage;

const SLACK_CONTEXT = {
  source: "slack" as const,
  channel: "C123",
  threadTs: "1700000000.000100",
  slackTeamId: "T123",
  statusMessageTs: "1700000000.000200",
};

function mockSlackResponse(ok: boolean, error?: string) {
  fetchMock.mockResolvedValueOnce({ json: () => Promise.resolve({ ok, error }) });
}

beforeEach(() => {
  fetchMock.mockReset();
  log.info.mockReset();
  log.warn.mockReset();
  doDbMocks.getSessionExtended.mockReset();
  doDbMocks.getSession.mockReset();
  tokenMocks.resolveSlackBotTokenForCallback.mockReset();
  controlMocks.syncCardControlRequests.mockReset();
  controlMocks.syncCardControlRequests.mockResolvedValue({});
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type UpdateStage = Parameters<typeof updateSlackStatusStageInPlace>[0]["stage"];

function callUpdate(stage: UpdateStage = "running", opts: { manageControls?: boolean } = {}) {
  return updateSlackStatusStageInPlace({ sql, env, log, sessionId: "sess-1", stage, ...opts });
}

describe("updateSlackStatusStageInPlace", () => {
  it("skips non-Slack sessions without calling Slack", async () => {
    doDbMocks.getSessionExtended.mockReturnValue({ callbackContext: undefined });

    await expect(callUpdate()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips when no status message ts is stored (never posts a new reply)", async () => {
    doDbMocks.getSessionExtended.mockReturnValue({
      callbackContext: { ...SLACK_CONTEXT, statusMessageTs: undefined },
    });

    await expect(callUpdate()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenMocks.resolveSlackBotTokenForCallback).not.toHaveBeenCalled();
  });

  it("skips when no bot token resolves", async () => {
    doDbMocks.getSessionExtended.mockReturnValue({ callbackContext: SLACK_CONTEXT });
    tokenMocks.resolveSlackBotTokenForCallback.mockResolvedValue(null);

    await expect(callUpdate()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("edits the status card in place with the running stage", async () => {
    doDbMocks.getSessionExtended.mockReturnValue({
      callbackContext: SLACK_CONTEXT,
      repoOwner: "acme",
      repoName: "widgets",
    });
    tokenMocks.resolveSlackBotTokenForCallback.mockResolvedValue("xoxb-token");
    mockSlackResponse(true);

    await expect(callUpdate()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://slack.com/api/chat.update");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.channel).toBe("C123");
    expect(body.ts).toBe("1700000000.000200");
    expect(JSON.stringify(body.blocks)).toContain("Running");
    expect(JSON.stringify(body.blocks)).toContain("acme/widgets");
  });

  it("edits the status card in place with terminal stages", async () => {
    doDbMocks.getSessionExtended.mockReturnValue({
      callbackContext: SLACK_CONTEXT,
      repoOwner: "acme",
      repoName: "widgets",
    });
    tokenMocks.resolveSlackBotTokenForCallback.mockResolvedValue("xoxb-token");
    mockSlackResponse(true);
    mockSlackResponse(true);
    mockSlackResponse(true);

    await expect(callUpdate("stopped")).resolves.toBe(true);
    await expect(callUpdate("archived")).resolves.toBe(true);
    await expect(callUpdate("failed")).resolves.toBe(true);

    const stoppedBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const archivedBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    const failedBody = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(JSON.stringify(stoppedBody.blocks)).toContain("Stopped");
    expect(stoppedBody.text).toContain("Stopped");
    expect(JSON.stringify(archivedBody.blocks)).toContain("Archived");
    expect(archivedBody.text).toContain("Archived");
    expect(JSON.stringify(failedBody.blocks)).toContain(":warning:");
    expect(JSON.stringify(failedBody.blocks)).toContain("Failed");
    expect(failedBody.text).toContain("Failed");
  });

  it("does not fall back to a thread reply when the update fails", async () => {
    doDbMocks.getSessionExtended.mockReturnValue({ callbackContext: SLACK_CONTEXT });
    tokenMocks.resolveSlackBotTokenForCallback.mockResolvedValue("xoxb-token");
    mockSlackResponse(false, "message_not_found");

    await expect(callUpdate()).resolves.toBe(false);

    // Exactly one Slack call: the chat.update attempt, no chat.postMessage.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalled();
  });

  it("accepts the full phase-derived stage set", async () => {
    doDbMocks.getSessionExtended.mockReturnValue({
      callbackContext: SLACK_CONTEXT,
      repoOwner: "acme",
      repoName: "widgets",
    });
    tokenMocks.resolveSlackBotTokenForCallback.mockResolvedValue("xoxb-token");

    const expectations: Array<[UpdateStage, string]> = [
      ["waiting_for_input", "Waiting for your answer"],
      ["finalizing", "Publishing…"],
      ["blocked", "Blocked"],
      ["review_listening", "Watching PR review"],
      ["superseded", "Superseded"],
    ];
    for (const [stage, label] of expectations) {
      mockSlackResponse(true);
      await expect(callUpdate(stage)).resolves.toBe(true);
      const call = fetchMock.mock.calls.at(-1)!;
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(JSON.stringify(body.blocks)).toContain(label);
      expect(body.text).toContain(label);
    }
  });

  it("still silent-skips new stages without a status anchor", async () => {
    doDbMocks.getSessionExtended.mockReturnValue({
      callbackContext: { ...SLACK_CONTEXT, statusMessageTs: undefined },
    });

    for (const stage of ["waiting_for_input", "blocked", "review_listening"] as const) {
      await expect(callUpdate(stage)).resolves.toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reconciles control rows and binds button ids when manageControls is set", async () => {
    const db = {} as D1Database;
    (env as { DB?: D1Database }).DB = db;
    doDbMocks.getSessionExtended.mockReturnValue({ callbackContext: SLACK_CONTEXT });
    doDbMocks.getSession.mockReturnValue({ businessId: "biz-1" });
    tokenMocks.resolveSlackBotTokenForCallback.mockResolvedValue("xoxb-token");
    controlMocks.syncCardControlRequests.mockResolvedValue({ resumeRequestId: "req-1" });
    mockSlackResponse(true);

    await expect(callUpdate("stopped", { manageControls: true })).resolves.toBe(true);

    expect(controlMocks.syncCardControlRequests).toHaveBeenCalledWith(db, {
      stage: "stopped",
      businessId: "biz-1",
      sessionId: "sess-1",
      slackTeamId: "T123",
      slackChannelId: "C123",
      messageTs: "1700000000.000200",
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(JSON.stringify(body.blocks)).toContain("cycloid:resume_session:req-1");
    delete (env as { DB?: D1Database }).DB;
  });

  it("never touches control rows without manageControls (narration hot path)", async () => {
    (env as { DB?: D1Database }).DB = {} as D1Database;
    doDbMocks.getSessionExtended.mockReturnValue({ callbackContext: SLACK_CONTEXT });
    tokenMocks.resolveSlackBotTokenForCallback.mockResolvedValue("xoxb-token");
    mockSlackResponse(true);

    await expect(callUpdate("running")).resolves.toBe(true);

    expect(controlMocks.syncCardControlRequests).not.toHaveBeenCalled();
    expect(doDbMocks.getSession).not.toHaveBeenCalled();
    delete (env as { DB?: D1Database }).DB;
  });
});

describe("updateSlackStatusCardFromSessionState", () => {
  const session = {
    sessionId: "sess-1",
    callbackContext: SLACK_CONTEXT,
    createdAt: "2026-01-01T00:00:00.000Z",
    repoOwner: "acme",
    repoName: "widgets",
    prUrl: null,
    verificationState: null,
    verificationResult: null,
  };

  it("edits the card in place from a worker-held session state", async () => {
    tokenMocks.resolveSlackBotTokenForCallback.mockResolvedValue("xoxb-token");
    mockSlackResponse(true);

    await expect(
      updateSlackStatusCardFromSessionState({
        env,
        log,
        session,
        stage: "running",
        narrationLine: "Resuming…",
      }),
    ).resolves.toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://slack.com/api/chat.update");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.ts).toBe("1700000000.000200");
    expect(JSON.stringify(body.blocks)).toContain("Resuming…");
    expect(JSON.stringify(body.blocks)).toContain("acme/widgets");
  });

  it("silent-skips without a status anchor", async () => {
    await expect(
      updateSlackStatusCardFromSessionState({
        env,
        log,
        session: { ...session, callbackContext: { ...SLACK_CONTEXT, statusMessageTs: undefined } },
        stage: "running",
      }),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
