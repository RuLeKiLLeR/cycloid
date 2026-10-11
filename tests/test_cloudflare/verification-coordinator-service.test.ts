import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSyntheticPrCoordinationByPrUrl,
  syntheticPrCoordinatorSessionId,
} from "../../apps/control-plane-worker/src/session/pr-coordination-db";
import { requestCoordinatedVerification } from "../../apps/control-plane-worker/src/session/verification-coordinator-service";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "./sqlite-d1-helper";

const mockFetchVerificationPrContext = vi.fn();
const mockFindActiveVerificationSession = vi.fn();
const mockCheckVerificationConflict = vi.fn();
const mockScheduleVerificationForPr = vi.fn();

vi.mock("../../apps/control-plane-worker/src/github/verification-pr-context", async () => {
  const actual = await vi.importActual<
    typeof import("../../apps/control-plane-worker/src/github/verification-pr-context")
  >("../../apps/control-plane-worker/src/github/verification-pr-context");
  return {
    ...actual,
    fetchVerificationPrContext: (...args: unknown[]) => mockFetchVerificationPrContext(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/session/verification-gate", () => ({
  checkVerificationConflict: (...args: unknown[]) => mockCheckVerificationConflict(...args),
  findActiveVerificationSession: (...args: unknown[]) => mockFindActiveVerificationSession(...args),
}));

vi.mock("../../apps/control-plane-worker/src/session/verification-spawn", () => ({
  scheduleVerificationForPr: (...args: unknown[]) => mockScheduleVerificationForPr(...args),
}));

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const PR_URL = "https://github.com/acme/widgets/pull/123";

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

function makeEnv(db: D1Database): Env {
  return { DB: db } as Env;
}

function makeInput(env: Env) {
  return {
    env,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    source: "api" as const,
    ownerUserId: "user-1",
    businessId: "biz-1",
    repoOwner: "acme",
    repoName: "widgets",
    installationId: 123,
    prUrl: PR_URL,
  };
}

describe("requestCoordinatedVerification", () => {
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    db = asD1(createMigratedSqlite());
    env = makeEnv(db);
    mockFetchVerificationPrContext.mockResolvedValue({ headSha: "head-1" });
    mockFindActiveVerificationSession.mockResolvedValue(null);
    mockCheckVerificationConflict.mockResolvedValue({ skip: false });
  });

  it("terminalizes a pre-enqueue schedule failure so the coordinator is not stuck in VERIFYING", async () => {
    mockScheduleVerificationForPr.mockResolvedValue({
      scheduled: false,
      reason: "schedule_failed",
      failureStage: "pre_enqueue",
    });

    await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
      ok: false,
      reason: "schedule_failed",
    });

    await expect(getSyntheticPrCoordinationByPrUrl(db, PR_URL)).resolves.toMatchObject({
      state: "NEEDS_YOU",
      blockedReason: "verification_stopped",
      verificationChildId: null,
    });
  });

  it("terminalizes an unexpected merge-conflict scheduler decline so the coordinator is not stuck in VERIFYING", async () => {
    mockScheduleVerificationForPr.mockResolvedValue({
      scheduled: false,
      reason: "merge_conflict",
    });

    await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
      ok: false,
      reason: "schedule_failed",
      error: "merge_conflict",
    });

    await expect(getSyntheticPrCoordinationByPrUrl(db, PR_URL)).resolves.toMatchObject({
      state: "NEEDS_YOU",
      blockedReason: "verification_stopped",
      verificationChildId: null,
    });
  });

  it("keeps a post-enqueue failure in VERIFYING and stamps the running child", async () => {
    mockScheduleVerificationForPr.mockResolvedValue({
      scheduled: false,
      reason: "schedule_failed",
      failureStage: "post_enqueue",
      verificationSessionId: "verifier-child-1",
    });

    await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
      ok: true,
      sessionId: "verifier-child-1",
      duplicate: false,
    });

    await expect(getSyntheticPrCoordinationByPrUrl(db, PR_URL)).resolves.toMatchObject({
      state: "VERIFYING",
      verificationChildId: "verifier-child-1",
    });
  });

  it("passes explicit runtime overrides to the verifier scheduler", async () => {
    mockScheduleVerificationForPr.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-1" });
    const callbackContext = {
      source: "github_qa_issue_comment" as const,
      installationId: 123,
      repoOwner: "acme",
      repoName: "widgets",
      issueNumber: 123,
      commentId: 456,
      targetPrUrl: PR_URL,
    };

    await expect(
      requestCoordinatedVerification({
        ...makeInput(env),
        modelId: "claude-opus-4-8",
        agentRuntimeBackend: "claude_code",
        reasoningEffort: "high",
        callbackContext,
      }),
    ).resolves.toMatchObject({ ok: true, sessionId: "verifier-child-1" });

    expect(mockScheduleVerificationForPr).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "claude-opus-4-8",
        agentRuntimeBackend: "claude_code",
        reasoningEffort: "high",
        callbackContext,
      }),
    );
  });

  it("allows the user default-model fallback for manual sources", async () => {
    mockScheduleVerificationForPr.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-1" });

    await expect(requestCoordinatedVerification({ ...makeInput(env), source: "child_session" })).resolves.toMatchObject(
      { ok: true, sessionId: "verifier-child-1" },
    );

    expect(mockScheduleVerificationForPr).toHaveBeenCalledWith(
      expect.objectContaining({ allowUserDefaultModel: true }),
    );
  });

  it("allows the user default-model fallback for the manual github issue-comment source", async () => {
    mockScheduleVerificationForPr.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-1" });

    await expect(requestCoordinatedVerification({ ...makeInput(env), source: "github" })).resolves.toMatchObject({
      ok: true,
      sessionId: "verifier-child-1",
    });

    expect(mockScheduleVerificationForPr).toHaveBeenCalledWith(
      expect.objectContaining({ allowUserDefaultModel: true }),
    );
  });

  it("passes child-session projection context to the verifier scheduler", async () => {
    mockScheduleVerificationForPr.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-1" });
    const childParentContext = {
      parentSessionId: "implementation-parent",
      parentPromptId: "prompt-1",
      spawnedByUserId: 42,
      spawnDepth: 1,
    };

    await expect(
      requestCoordinatedVerification({
        ...makeInput(env),
        source: "child_session",
        childParentContext,
      }),
    ).resolves.toMatchObject({ ok: true, sessionId: "verifier-child-1" });

    expect(mockScheduleVerificationForPr).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: expect.stringContaining("pr-coord:"),
        projectionParentContext: childParentContext,
      }),
    );
  });

  it("reports run-limit before reusing a stale child id on the blocked coordinator", async () => {
    mockScheduleVerificationForPr.mockResolvedValue({ scheduled: true, sessionId: "stale-child" });

    await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
      ok: true,
      sessionId: "stale-child",
    });

    await db
      .prepare(
        "UPDATE pr_coordination SET state = 'REVIEW', blocked_reason = NULL, verification_run_count = 3, verification_child_id = ? WHERE pr_url = ?",
      )
      .bind("stale-child", PR_URL)
      .run();

    await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
      ok: false,
      reason: "run_limit_reached",
    });
  });

  it("allows a merge-conflicted request at the run cap and tells the scheduler to allow the conflict", async () => {
    mockCheckVerificationConflict.mockResolvedValue({ skip: true, reason: "merge_conflict" });
    mockScheduleVerificationForPr.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-1" });

    await db
      .prepare(
        "INSERT INTO pr_coordination (session_id, version, state, pr_url, head_sha, verdict, verification_run_count, verification_run_id, code_changed_since_verification, prompt_intends_change, state_entered_at) VALUES (?, 0, 'REVIEW', ?, 'head-1', 'none', 3, 3, 1, 1, 0)",
      )
      .bind(syntheticPrCoordinatorSessionId(PR_URL), PR_URL)
      .run();

    await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
      ok: true,
      sessionId: "verifier-child-1",
    });

    expect(mockScheduleVerificationForPr).toHaveBeenCalledWith(
      expect.objectContaining({
        allowMergeConflict: true,
        verificationRunId: 4,
      }),
    );
    await expect(getSyntheticPrCoordinationByPrUrl(db, PR_URL)).resolves.toMatchObject({
      state: "VERIFYING",
      verificationRunCount: 4,
      verificationChildId: "verifier-child-1",
    });
  });

  it("keeps the run cap for a non-merge-conflicted request", async () => {
    await db
      .prepare(
        "INSERT INTO pr_coordination (session_id, version, state, pr_url, head_sha, verdict, verification_run_count, verification_run_id, code_changed_since_verification, prompt_intends_change, state_entered_at) VALUES (?, 0, 'REVIEW', ?, 'head-1', 'none', 3, 3, 1, 1, 0)",
      )
      .bind(syntheticPrCoordinatorSessionId(PR_URL), PR_URL)
      .run();

    await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
      ok: false,
      reason: "run_limit_reached",
    });
    expect(mockScheduleVerificationForPr).not.toHaveBeenCalled();
  });

  describe("forceNewSession (manual Verify button)", () => {
    it("bypasses the active-verifier dedup and schedules a fresh verifier", async () => {
      mockFindActiveVerificationSession.mockResolvedValue({ sessionId: "active-verifier" });
      mockScheduleVerificationForPr.mockResolvedValue({ scheduled: true, sessionId: "fresh-verifier" });

      // Without the flag the advisory dedup short-circuits and returns the in-flight verifier as a duplicate.
      await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
        ok: true,
        sessionId: "active-verifier",
        duplicate: true,
      });
      expect(mockScheduleVerificationForPr).not.toHaveBeenCalled();

      // With the flag the dedup is skipped and a brand-new verifier is scheduled.
      await expect(requestCoordinatedVerification({ ...makeInput(env), forceNewSession: true })).resolves.toMatchObject(
        {
          ok: true,
          sessionId: "fresh-verifier",
          duplicate: false,
        },
      );
      expect(mockScheduleVerificationForPr).toHaveBeenCalledTimes(1);
    });

    it("supersedes the in-flight verifier and spawns a new one when forced while already VERIFYING", async () => {
      mockScheduleVerificationForPr
        .mockResolvedValueOnce({ scheduled: true, sessionId: "verifier-child-1" })
        .mockResolvedValueOnce({ scheduled: true, sessionId: "verifier-child-2" });

      // First request admits run 1 and leaves the coordinator VERIFYING with the running child stamped.
      await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
        ok: true,
        sessionId: "verifier-child-1",
        duplicate: false,
      });
      await expect(getSyntheticPrCoordinationByPrUrl(db, PR_URL)).resolves.toMatchObject({
        state: "VERIFYING",
        verificationChildId: "verifier-child-1",
        verificationRunCount: 1,
      });

      // Forced while VERIFYING → supersede: burns another run, stamps the new child, returns it fresh.
      await expect(requestCoordinatedVerification({ ...makeInput(env), forceNewSession: true })).resolves.toMatchObject(
        {
          ok: true,
          sessionId: "verifier-child-2",
          duplicate: false,
        },
      );
      await expect(getSyntheticPrCoordinationByPrUrl(db, PR_URL)).resolves.toMatchObject({
        state: "VERIFYING",
        verificationChildId: "verifier-child-2",
        verificationRunCount: 2,
      });

      // The force flag is threaded to the scheduler so its advisory active-verifier check can't block the
      // fresh run on the not-yet-torn-down superseded child.
      expect(mockScheduleVerificationForPr).toHaveBeenLastCalledWith(
        expect.objectContaining({ forceNewSession: true }),
      );
    });

    it("without the flag a second request while VERIFYING reuses the in-flight child (duplicate)", async () => {
      mockScheduleVerificationForPr.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-1" });

      await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
        ok: true,
        sessionId: "verifier-child-1",
        duplicate: false,
      });

      // findActiveVerificationSession is null here (default), so reuse comes from the FSM VERIFYING row
      // returning the in-flight verification_child_id — the non-forced reuse semantics stay intact.
      await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({
        ok: true,
        sessionId: "verifier-child-1",
        duplicate: true,
      });
      expect(mockScheduleVerificationForPr).toHaveBeenCalledTimes(1);
    });

    it("still fails closed with run_limit_reached when forced past the per-PR run cap", async () => {
      mockScheduleVerificationForPr.mockResolvedValue({ scheduled: true, sessionId: "verifier-child-1" });

      await expect(requestCoordinatedVerification(makeInput(env))).resolves.toMatchObject({ ok: true });

      // Push the still-VERIFYING coordinator to the cap; a forced request must not bypass it.
      await db.prepare("UPDATE pr_coordination SET verification_run_count = 3 WHERE pr_url = ?").bind(PR_URL).run();

      await expect(requestCoordinatedVerification({ ...makeInput(env), forceNewSession: true })).resolves.toMatchObject(
        { ok: false, reason: "run_limit_reached" },
      );
    });
  });
});
