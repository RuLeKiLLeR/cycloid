import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "./sqlite-d1-helper";

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

const mockGetSessionState = vi.fn();
const mockResumeSession = vi.fn();
const mockSetSessionRepo = vi.fn();
const mockUpdateSessionCallbackContext = vi.fn().mockResolvedValue({ ok: true, status: 200, payload: { ok: true } });
vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
  resumeSession: (...args: unknown[]) => mockResumeSession(...args),
  setSessionRepo: (...args: unknown[]) => mockSetSessionRepo(...args),
  updateSessionCallbackContext: (...args: unknown[]) => mockUpdateSessionCallbackContext(...args),
}));

const mockVerifyRepoAccessAndInstallation = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/repo-gate", () => ({
  verifyRepoAccessAndInstallation: (...args: unknown[]) => mockVerifyRepoAccessAndInstallation(...args),
}));

const mockCheckSessionResumeRateLimit = vi.fn().mockResolvedValue({ limited: false });
vi.mock("../../apps/control-plane-worker/src/services/session-resume-rate-limiter", () => ({
  checkSessionResumeRateLimit: (...args: unknown[]) => mockCheckSessionResumeRateLimit(...args),
}));

const mockGetChildSessionRow = vi.fn().mockResolvedValue(null);
vi.mock("../../apps/control-plane-worker/src/session/child-session-db", () => ({
  getChildSessionRow: (...args: unknown[]) => mockGetChildSessionRow(...args),
}));

const mockNotifyUserBlocked = vi.fn().mockResolvedValue("sent");
vi.mock("../../apps/control-plane-worker/src/session/notify-user-blocked", () => ({
  notifyUserBlocked: (...args: unknown[]) => mockNotifyUserBlocked(...args),
}));

const mockGetPrCoordination = vi.fn().mockResolvedValue(null);
vi.mock("../../apps/control-plane-worker/src/session/pr-coordination-db", () => ({
  getPrCoordination: (...args: unknown[]) => mockGetPrCoordination(...args),
}));

const mockGetUserBusinessIdOrNull = vi.fn();
vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  getUserBusinessIdOrNull: (...args: unknown[]) => mockGetUserBusinessIdOrNull(...args),
}));

const mockPostSessionThreadMessage = vi
  .fn()
  .mockResolvedValue({ ok: true, ts: "ask-ts", posted: true, updatedInPlace: false });
vi.mock("../../apps/control-plane-worker/src/slack/thread-budget", () => ({
  postSessionThreadMessage: (...args: unknown[]) => mockPostSessionThreadMessage(...args),
}));

const mockUpdateSlackStatusCardFromSessionState = vi.fn().mockResolvedValue(true);
vi.mock("../../apps/control-plane-worker/src/slack/phase-updates", () => ({
  updateSlackStatusCardFromSessionState: (...args: unknown[]) => mockUpdateSlackStatusCardFromSessionState(...args),
}));

const mockPostStructuredEventToDd = vi.fn().mockResolvedValue(undefined);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import {
  buildSlackWakeAckLine,
  postSlackWakeAcknowledgement,
  wakeSlackSessionForFollowUp,
} from "../../apps/control-plane-worker/src/webhooks/slack-wake";

const MIGRATION_SQL = readFileSync(
  new URL("../../apps/control-plane-worker/migrations/0244_slack_interaction_requests.sql", import.meta.url),
  "utf8",
);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-03T12:00:00.000Z");

let sqlite: Database.Database;
let db: D1Database;
const env = { DB: undefined as unknown } as unknown as Env;

function sessionState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowIso = new Date(NOW).toISOString();
  return {
    sessionId: "sess-1",
    ownerUserId: "1",
    businessId: "biz-1",
    status: "active",
    phase: "stopped",
    stopMode: "user",
    createdAt: nowIso,
    updatedAt: nowIso,
    closedAt: null,
    repoOwner: "test-owner",
    repoName: "test-repo",
    baseBranch: "main",
    initiationMode: "user",
    callbackContext: {
      source: "slack",
      channel: "C1",
      threadTs: "1000.0",
      slackTeamId: "T1",
      statusMessageTs: "1000.1",
    },
    ...overrides,
  };
}

function followUpParams(overrides: Record<string, unknown> = {}) {
  return {
    env,
    db,
    sessionId: "sess-1",
    actorUserId: "1",
    slackTeamId: "T1",
    slackBotToken: "xoxb-team-token",
    channelId: "C1",
    threadTs: "1000.0",
    promptText: "please continue the work",
    replyToText: "please continue the work",
    now: NOW,
    ...overrides,
  };
}

function pendingWakeConfirmRows(): Array<{ id: string; status: string; kind: string; payload_json: string }> {
  return sqlite
    .prepare("SELECT id, status, kind, payload_json FROM slack_interaction_requests ORDER BY created_at ASC")
    .all() as Array<{ id: string; status: string; kind: string; payload_json: string }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(":memory:");
  sqlite.exec(MIGRATION_SQL);
  db = new SqliteD1(sqlite) as unknown as D1Database;
  (env as { DB: unknown }).DB = db;

  mockGetSessionState.mockResolvedValue(sessionState());
  mockGetUserBusinessIdOrNull.mockResolvedValue("biz-1");
  mockVerifyRepoAccessAndInstallation.mockResolvedValue({ ok: true, installationId: 42 });
  mockSetSessionRepo.mockResolvedValue({ ok: true });
  mockResumeSession.mockResolvedValue({ ok: true, status: "spawning" });
  mockCheckSessionResumeRateLimit.mockResolvedValue({ limited: false });
  mockGetChildSessionRow.mockResolvedValue(null);
  mockPostSessionThreadMessage.mockResolvedValue({ ok: true, ts: "ask-ts", posted: true, updatedInPlace: false });
  mockGetPrCoordination.mockResolvedValue(null);
});

afterEach(() => {
  sqlite.close();
});

describe("wakeSlackSessionForFollowUp – wake routing per phase", () => {
  it("wakes a user-stopped session: rate limit + repo gate + resume", async () => {
    const outcome = await wakeSlackSessionForFollowUp(followUpParams());

    expect(outcome).toEqual({ kind: "woken", fromPhase: "stopped" });
    expect(mockCheckSessionResumeRateLimit).toHaveBeenCalledWith(env, "sess-1", "1");
    expect(mockVerifyRepoAccessAndInstallation).toHaveBeenCalledOnce();
    expect(mockSetSessionRepo).toHaveBeenCalledWith(env, "sess-1", "test-owner", "test-repo", "main", 42);
    expect(mockResumeSession).toHaveBeenCalledWith(env, "sess-1");
  });

  it("does not wake an archived session and posts terminal copy", async () => {
    mockGetSessionState.mockResolvedValue(sessionState({ status: "archived", phase: "archived", stopMode: undefined }));

    const outcome = await wakeSlackSessionForFollowUp(followUpParams());

    expect(outcome).toEqual({ kind: "not_applicable", reason: "session_archived" });
    expect(mockResumeSession).not.toHaveBeenCalled();
    expect(mockPostSessionThreadMessage).toHaveBeenCalledOnce();
    const ask = mockPostSessionThreadMessage.mock.calls[0][0] as { kind: string; text: string };
    expect(ask.kind).toBe("ask");
    expect(ask.text).toContain("This session is archived. Start a new session to continue.");
  });

  it("fails a user-stopped wake when resume fails (enqueue would re-reject)", async () => {
    mockResumeSession.mockResolvedValue({ ok: false, error: "spawn_unavailable" });

    const outcome = await wakeSlackSessionForFollowUp(followUpParams());
    expect(outcome).toEqual({ kind: "denied", reason: "resume_failed" });
  });

  it.each(["failed", "blocked"])("posts one budget ask nudge for a %s session and does not wake", async (phase) => {
    mockGetSessionState.mockResolvedValue(sessionState({ phase, stopMode: undefined }));

    const outcome = await wakeSlackSessionForFollowUp(followUpParams());

    expect(outcome).toEqual({ kind: "retry_nudge" });
    expect(mockResumeSession).not.toHaveBeenCalled();
    expect(mockPostSessionThreadMessage).toHaveBeenCalledOnce();
    const ask = mockPostSessionThreadMessage.mock.calls[0][0] as { kind: string; text: string };
    expect(ask.kind).toBe("ask");
    expect(ask.text).toContain("use Retry on the status card above, or start a fresh thread");
  });

  it("does nothing for phases the wake path does not own", async () => {
    mockGetSessionState.mockResolvedValue(sessionState({ phase: "finalizing", stopMode: undefined }));

    const outcome = await wakeSlackSessionForFollowUp(followUpParams());
    expect(outcome).toEqual({ kind: "not_applicable", reason: "finalizing" });
    expect(mockPostSessionThreadMessage).not.toHaveBeenCalled();
  });
});

describe("wakeSlackSessionForFollowUp – authz fail-closed", () => {
  it("denies an unlinked actor (slack pseudo-id)", async () => {
    const outcome = await wakeSlackSessionForFollowUp(followUpParams({ actorUserId: "slack:U999" }));
    expect(outcome).toEqual({ kind: "denied", reason: "unlinked_actor" });
    expect(mockResumeSession).not.toHaveBeenCalled();
    expect(mockVerifyRepoAccessAndInstallation).not.toHaveBeenCalled();
  });

  it("denies a cross-business actor", async () => {
    mockGetUserBusinessIdOrNull.mockResolvedValue("biz-other");
    const outcome = await wakeSlackSessionForFollowUp(followUpParams());
    expect(outcome).toEqual({ kind: "denied", reason: "business_mismatch" });
    expect(mockResumeSession).not.toHaveBeenCalled();
  });

  it("denies when the session has no business binding", async () => {
    mockGetSessionState.mockResolvedValue(sessionState({ businessId: null }));
    const outcome = await wakeSlackSessionForFollowUp(followUpParams());
    expect(outcome).toEqual({ kind: "denied", reason: "business_unresolved" });
  });

  it("excludes automation-origin sessions from conversational wake entirely", async () => {
    mockGetSessionState.mockResolvedValue(sessionState({ initiationMode: "automation" }));
    const outcome = await wakeSlackSessionForFollowUp(followUpParams());
    expect(outcome).toEqual({ kind: "not_applicable", reason: "automation_session" });
    expect(mockResumeSession).not.toHaveBeenCalled();
    expect(mockPostSessionThreadMessage).not.toHaveBeenCalled();
  });

  it("denies child sessions (concurrency reservations stay route-managed)", async () => {
    mockGetChildSessionRow.mockResolvedValue({ parent_session_id: "parent-1" });
    const outcome = await wakeSlackSessionForFollowUp(followUpParams());
    expect(outcome).toEqual({ kind: "denied", reason: "child_session" });
  });

  it("denies when the resume rate limit trips", async () => {
    mockCheckSessionResumeRateLimit.mockResolvedValue({ limited: true });
    const outcome = await wakeSlackSessionForFollowUp(followUpParams());
    expect(outcome).toEqual({ kind: "denied", reason: "rate_limited" });
    expect(mockVerifyRepoAccessAndInstallation).not.toHaveBeenCalled();
  });
});

describe("wakeSlackSessionForFollowUp – repo access revoked", () => {
  it("denies and DMs the owner when the denied waker IS the owner", async () => {
    mockVerifyRepoAccessAndInstallation.mockResolvedValue({
      ok: false,
      reason: "repo_access_denied",
      response: new Response(null, { status: 403 }),
    });

    const outcome = await wakeSlackSessionForFollowUp(followUpParams({ actorUserId: "1" }));

    expect(outcome).toEqual({ kind: "denied", reason: "repo_access" });
    expect(mockNotifyUserBlocked).toHaveBeenCalledOnce();
    expect(mockNotifyUserBlocked.mock.calls[0][1]).toMatchObject({
      sessionId: "sess-1",
      ownerUserId: 1,
      kind: "repo_access_denied",
      dedupKey: "sess-1",
    });
    expect(mockResumeSession).not.toHaveBeenCalled();
  });

  it("notifies the owner when a non-owner waker is denied repository access", async () => {
    mockGetSessionState.mockResolvedValue(sessionState({ ownerUserId: "7" }));
    mockVerifyRepoAccessAndInstallation.mockResolvedValue({
      ok: false,
      reason: "repo_access_denied",
      response: new Response(null, { status: 403 }),
    });

    const outcome = await wakeSlackSessionForFollowUp(followUpParams({ actorUserId: "1" }));

    expect(outcome).toEqual({ kind: "denied", reason: "repo_access" });
    expect(mockNotifyUserBlocked).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "repo_access_denied", ownerUserId: 7 }),
    );
  });

  it("denies without an owner DM on an unverifiable gate (fail closed, not a denial)", async () => {
    mockVerifyRepoAccessAndInstallation.mockResolvedValue({
      ok: false,
      reason: "access_unverifiable",
      response: new Response(null, { status: 503 }),
    });

    const outcome = await wakeSlackSessionForFollowUp(followUpParams());
    expect(outcome).toEqual({ kind: "denied", reason: "repo_access" });
    expect(mockNotifyUserBlocked).not.toHaveBeenCalled();
  });
});

describe("postSlackWakeAcknowledgement / buildSlackWakeAckLine", () => {
  it("renders PR number, merged age, and branch from session PR metadata", () => {
    expect(
      buildSlackWakeAckLine({
        prUrl: "https://github.com/o/r/pull/123",
        prNumber: 123,
        publishedBranch: "feat/x",
        mergedAtMs: NOW - 3 * DAY_MS,
        nowMs: NOW,
      }),
    ).toBe("Picking this back up — PR #123 (merged 3 days ago), branch `feat/x`");
    expect(
      buildSlackWakeAckLine({ prUrl: null, prNumber: null, publishedBranch: null, mergedAtMs: null, nowMs: NOW }),
    ).toBe("Picking this back up.");
    expect(
      buildSlackWakeAckLine({
        prUrl: "https://github.com/o/r/pull/9",
        prNumber: 9,
        publishedBranch: null,
        mergedAtMs: NOW,
        nowMs: NOW,
      }),
    ).toBe("Picking this back up — PR #9 (merged today)");
  });

  it("updates the card in place through the existing card updater with the pickup line", async () => {
    mockGetSessionState.mockResolvedValue(
      sessionState({ prUrl: "https://github.com/o/r/pull/123", publishedBranch: "feat/x" }),
    );
    mockGetPrCoordination.mockResolvedValue({ state: "MERGED", stateEnteredAt: NOW - 3 * DAY_MS });

    await postSlackWakeAcknowledgement({ env, sessionId: "sess-1", now: NOW });

    expect(mockUpdateSlackStatusCardFromSessionState).toHaveBeenCalledOnce();
    const call = mockUpdateSlackStatusCardFromSessionState.mock.calls[0][0] as {
      stage: string;
      narrationLine: string;
    };
    expect(call.stage).toBe("running");
    expect(call.narrationLine).toBe("Picking this back up — PR #123 (merged 3 days ago), branch `feat/x`");
  });

  it("skips silently when the session is gone", async () => {
    mockGetSessionState.mockResolvedValue(null);
    await postSlackWakeAcknowledgement({ env, sessionId: "sess-1", now: NOW });
    expect(mockUpdateSlackStatusCardFromSessionState).not.toHaveBeenCalled();
  });
});

describe("dead-end copy is retired", () => {
  const REPO_ROOT = join(__dirname, "..", "..");
  const SCAN_ROOTS = [join(REPO_ROOT, "apps"), join(REPO_ROOT, "shared")];

  function listSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        files.push(...listSourceFiles(full));
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
        files.push(full);
      }
    }
    return files;
  }

  it("no source file contains the terminated-thread dead-end copy", () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of listSourceFiles(root)) {
        if (readFileSync(file, "utf8").includes("already been terminated")) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
