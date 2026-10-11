import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  AUTOMATION_EVENT_JOB_PAYLOAD_MAX_BYTES,
  claimAutomationEventJob,
  countOpenAutomationEventJobsForBusiness,
  failStaleAutomationEventJobs,
  findEnabledSlackChannelAutomationRules,
  insertAutomationEventJobIfNotExists,
  type InsertAutomationEventJobInput,
  insertSkippedAutomationEventJobIfNotExists,
  markAutomationEventJobTerminal,
  updateAutomationEventJobPhase,
} from "../../apps/control-plane-worker/src/automation/db";
import { SqliteD1 } from "./sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

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

function insertRule(
  sqlite: Database.Database,
  overrides: {
    id?: string;
    businessId?: string;
    provider?: "datadog" | "sentry";
    enabled?: number;
    slackChannelId?: string;
    createdAt?: number;
  } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO automation_rules (
        id, business_id, configured_by_user_id, name, trigger_kind, trigger_provider,
        slack_team_id, slack_channel_id, slack_bot_user_id,
        allowed_slack_app_ids_json, allowed_slack_bot_ids_json,
        repo_owner, repo_name, installation_id, prompt_template,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.id ?? "rule-1",
      overrides.businessId ?? "biz-a",
      "42",
      "Alert triage",
      "slack_channel_message",
      overrides.provider ?? "datadog",
      "T_ALERTS",
      overrides.slackChannelId ?? "C_ALERTS",
      "U_CYCLOID",
      JSON.stringify(["A_DATADOG"]),
      JSON.stringify(["B_DATADOG"]),
      "trycycloid",
      "cycloid",
      12345,
      "Investigate this alert.",
      overrides.enabled ?? 1,
      overrides.createdAt ?? 1000,
      overrides.createdAt ?? 1000,
    );
}

function buildJob(overrides: Partial<InsertAutomationEventJobInput> = {}): InsertAutomationEventJobInput {
  return {
    id: overrides.id ?? "job-1",
    ruleId: overrides.ruleId ?? "rule-1",
    businessId: overrides.businessId ?? "biz-a",
    triggerKind: overrides.triggerKind ?? "slack_channel_message",
    triggerProvider: overrides.triggerProvider ?? "datadog",
    idempotencyKey: overrides.idempotencyKey ?? "slack:T_ALERTS:C_ALERTS:1712345678.000100",
    slackTeamId: overrides.slackTeamId ?? "T_ALERTS",
    slackChannelId: overrides.slackChannelId ?? "C_ALERTS",
    slackMessageTs: overrides.slackMessageTs ?? "1712345678.000100",
    slackThreadTs: overrides.slackThreadTs ?? null,
    payloadJson: overrides.payloadJson ?? JSON.stringify({ text: "Monitor triggered" }),
    createdAt: overrides.createdAt ?? 1000,
  };
}

describe("automation event job DAO", () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = createMigratedSqlite();
    db = asD1(sqlite);
  });

  it("finds enabled Slack channel rules scoped by business/team/channel", async () => {
    insertRule(sqlite, { id: "disabled", enabled: 0, createdAt: 1 });
    insertRule(sqlite, { id: "wrong-channel", slackChannelId: "C_OTHER", createdAt: 2 });
    insertRule(sqlite, { id: "sentry", provider: "sentry", createdAt: 3 });
    insertRule(sqlite, { id: "datadog", provider: "datadog", createdAt: 4 });

    const rules = await findEnabledSlackChannelAutomationRules(db, {
      businessId: "biz-a",
      slackTeamId: "T_ALERTS",
      slackChannelId: "C_ALERTS",
    });

    expect(rules.map((rule) => rule.id)).toEqual(["sentry", "datadog"]);
    expect(rules[0]).toMatchObject({
      triggerProvider: "sentry",
      allowedSlackAppIds: ["A_DATADOG"],
      allowedSlackBotIds: ["B_DATADOG"],
      enabled: true,
    });
  });

  it("inserts a queued job once per idempotency key", async () => {
    insertRule(sqlite);

    await expect(insertAutomationEventJobIfNotExists(db, buildJob())).resolves.toEqual({ inserted: true });
    await expect(insertAutomationEventJobIfNotExists(db, buildJob({ id: "job-duplicate" }))).resolves.toEqual({
      inserted: false,
    });

    const rows = sqlite.prepare("SELECT id, phase, attempt_count FROM automation_event_jobs").all() as Array<{
      id: string;
      phase: string;
      attempt_count: number;
    }>;
    expect(rows).toEqual([{ id: "job-1", phase: "queued", attempt_count: 0 }]);
  });

  it("rejects payloads above the DAO byte bound before writing", async () => {
    insertRule(sqlite);

    await expect(
      insertAutomationEventJobIfNotExists(
        db,
        buildJob({ payloadJson: "x".repeat(AUTOMATION_EVENT_JOB_PAYLOAD_MAX_BYTES + 1) }),
      ),
    ).rejects.toThrow(/payload_json exceeds/);

    const count = sqlite.prepare("SELECT COUNT(*) as count FROM automation_event_jobs").get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("inserts skipped terminal jobs once per idempotency key", async () => {
    insertRule(sqlite);

    await expect(
      insertSkippedAutomationEventJobIfNotExists(db, {
        ...buildJob(),
        terminalReason: "resolved_alert",
        completedAt: 2000,
      }),
    ).resolves.toEqual({ inserted: true });
    await expect(
      insertSkippedAutomationEventJobIfNotExists(db, {
        ...buildJob({ id: "job-duplicate" }),
        terminalReason: "resolved_alert",
        completedAt: 2500,
      }),
    ).resolves.toEqual({ inserted: false });

    const row = sqlite.prepare("SELECT phase, terminal_reason, completed_at FROM automation_event_jobs").get() as {
      phase: string;
      terminal_reason: string;
      completed_at: number;
    };
    expect(row).toEqual({ phase: "skipped", terminal_reason: "resolved_alert", completed_at: 2000 });
  });

  it("claims queued jobs once and permits reclaim after lease expiry", async () => {
    insertRule(sqlite);
    await insertAutomationEventJobIfNotExists(db, buildJob());

    await expect(
      claimAutomationEventJob(db, { jobId: "job-1", leaseOwner: "worker-a", leaseExpiresAt: 2000, nowMs: 1000 }),
    ).resolves.toEqual({ claimed: true });
    await expect(
      claimAutomationEventJob(db, { jobId: "job-1", leaseOwner: "worker-b", leaseExpiresAt: 2500, nowMs: 1500 }),
    ).resolves.toEqual({ claimed: false });
    await expect(
      claimAutomationEventJob(db, { jobId: "job-1", leaseOwner: "worker-b", leaseExpiresAt: 4000, nowMs: 2500 }),
    ).resolves.toEqual({ claimed: true });

    const row = sqlite
      .prepare("SELECT phase, lease_owner, lease_expires_at, attempt_count, claimed_at FROM automation_event_jobs")
      .get() as {
      phase: string;
      lease_owner: string;
      lease_expires_at: number;
      attempt_count: number;
      claimed_at: number;
    };
    expect(row).toEqual({
      phase: "claimed",
      lease_owner: "worker-b",
      lease_expires_at: 4000,
      attempt_count: 2,
      claimed_at: 2500,
    });
  });

  it("permits reclaim of expired session-enqueued jobs", async () => {
    insertRule(sqlite);
    await insertAutomationEventJobIfNotExists(db, buildJob());
    await claimAutomationEventJob(db, { jobId: "job-1", leaseOwner: "worker-a", leaseExpiresAt: 2000, nowMs: 1000 });
    await updateAutomationEventJobPhase(db, {
      jobId: "job-1",
      leaseOwner: "worker-a",
      phase: "session_enqueued",
      nowMs: 1500,
    });

    await expect(
      claimAutomationEventJob(db, { jobId: "job-1", leaseOwner: "worker-b", leaseExpiresAt: 3500, nowMs: 1999 }),
    ).resolves.toEqual({ claimed: false });
    await expect(
      claimAutomationEventJob(db, { jobId: "job-1", leaseOwner: "worker-b", leaseExpiresAt: 4000, nowMs: 2000 }),
    ).resolves.toEqual({ claimed: true });

    const row = sqlite
      .prepare("SELECT phase, lease_owner, lease_expires_at, attempt_count, claimed_at FROM automation_event_jobs")
      .get() as {
      phase: string;
      lease_owner: string;
      lease_expires_at: number;
      attempt_count: number;
      claimed_at: number;
    };
    expect(row).toEqual({
      phase: "claimed",
      lease_owner: "worker-b",
      lease_expires_at: 4000,
      attempt_count: 2,
      claimed_at: 2000,
    });
  });

  it("updates non-terminal phases", async () => {
    insertRule(sqlite);
    await insertAutomationEventJobIfNotExists(db, buildJob());
    await claimAutomationEventJob(db, { jobId: "job-1", leaseOwner: "worker-a", leaseExpiresAt: 2000, nowMs: 1000 });

    await expect(
      updateAutomationEventJobPhase(db, {
        jobId: "job-1",
        leaseOwner: "worker-a",
        phase: "session_enqueued",
        nowMs: 1500,
      }),
    ).resolves.toEqual({
      updated: true,
    });
    await expect(
      updateAutomationEventJobPhase(db, {
        jobId: "missing",
        leaseOwner: "worker-a",
        phase: "session_enqueued",
        nowMs: 1500,
      }),
    ).resolves.toEqual({
      updated: false,
    });
    await expect(
      updateAutomationEventJobPhase(db, {
        jobId: "job-1",
        leaseOwner: "worker-b",
        phase: "claimed",
        nowMs: 1750,
      }),
    ).resolves.toEqual({
      updated: false,
    });

    const row = sqlite.prepare("SELECT phase, updated_at FROM automation_event_jobs WHERE id = ?").get("job-1") as {
      phase: string;
      updated_at: number;
    };
    expect(row).toEqual({ phase: "session_enqueued", updated_at: 1500 });

    await markAutomationEventJobTerminal(db, {
      jobId: "job-1",
      leaseOwner: "worker-a",
      phase: "failed",
      terminalReason: "test_terminal",
      completedAt: 2000,
    });
    await expect(
      updateAutomationEventJobPhase(db, { jobId: "job-1", leaseOwner: "worker-a", phase: "claimed", nowMs: 2500 }),
    ).resolves.toEqual({ updated: false });
  });

  it("marks terminal outcome and clears the active lease", async () => {
    insertRule(sqlite);
    await insertAutomationEventJobIfNotExists(db, buildJob());
    await claimAutomationEventJob(db, { jobId: "job-1", leaseOwner: "worker-a", leaseExpiresAt: 2000, nowMs: 1000 });

    await expect(
      markAutomationEventJobTerminal(db, {
        jobId: "job-1",
        leaseOwner: "worker-b",
        phase: "failed",
        terminalReason: "stale_worker",
        completedAt: 2500,
      }),
    ).resolves.toEqual({ updated: false });

    await expect(
      markAutomationEventJobTerminal(db, {
        jobId: "job-1",
        leaseOwner: "worker-a",
        phase: "failed",
        terminalReason: "missing_slack_token",
        errorMessage: "Slack token unavailable",
        completedAt: 3000,
      }),
    ).resolves.toEqual({ updated: true });

    const row = sqlite.prepare("SELECT * FROM automation_event_jobs WHERE id = ?").get("job-1") as {
      phase: string;
      terminal_reason: string;
      error_message: string;
      lease_owner: string | null;
      lease_expires_at: number | null;
      completed_at: number;
      updated_at: number;
    };
    expect(row).toMatchObject({
      phase: "failed",
      terminal_reason: "missing_slack_token",
      error_message: "Slack token unavailable",
      lease_owner: null,
      lease_expires_at: null,
      completed_at: 3000,
      updated_at: 3000,
    });

    await expect(
      markAutomationEventJobTerminal(db, {
        jobId: "job-1",
        leaseOwner: "worker-a",
        phase: "succeeded",
        terminalReason: "late_success",
        completedAt: 4000,
      }),
    ).resolves.toEqual({ updated: false });

    const unchanged = sqlite
      .prepare("SELECT phase, terminal_reason, completed_at FROM automation_event_jobs WHERE id = ?")
      .get("job-1") as {
      phase: string;
      terminal_reason: string;
      completed_at: number;
    };
    expect(unchanged).toEqual({
      phase: "failed",
      terminal_reason: "missing_slack_token",
      completed_at: 3000,
    });
  });

  it("counts only non-terminal event jobs for business backpressure", async () => {
    insertRule(sqlite);
    await insertAutomationEventJobIfNotExists(db, buildJob({ id: "queued", idempotencyKey: "queued" }));
    await insertAutomationEventJobIfNotExists(db, buildJob({ id: "terminal", idempotencyKey: "terminal" }));
    await claimAutomationEventJob(db, { jobId: "terminal", leaseOwner: "worker-a", leaseExpiresAt: 2500, nowMs: 1500 });

    await markAutomationEventJobTerminal(db, {
      jobId: "terminal",
      leaseOwner: "worker-a",
      phase: "failed",
      terminalReason: "enqueue_failed",
      completedAt: 2000,
    });

    await expect(countOpenAutomationEventJobsForBusiness(db, "biz-a")).resolves.toBe(1);
    await expect(countOpenAutomationEventJobsForBusiness(db, "biz-b")).resolves.toBe(0);
  });

  it("terminalizes stale automation event jobs and releases the business backpressure count", async () => {
    insertRule(sqlite);
    const nowMs = 1_000_000;
    await insertAutomationEventJobIfNotExists(
      db,
      buildJob({ id: "expired-lease", idempotencyKey: "expired-lease", createdAt: 1000 }),
    );
    await claimAutomationEventJob(db, {
      jobId: "expired-lease",
      leaseOwner: "worker-a",
      leaseExpiresAt: 600_000,
      nowMs: 1000,
    });
    await updateAutomationEventJobPhase(db, {
      jobId: "expired-lease",
      leaseOwner: "worker-a",
      phase: "session_enqueued",
      nowMs: 2000,
    });

    await insertAutomationEventJobIfNotExists(
      db,
      buildJob({ id: "stale-unclaimed", idempotencyKey: "stale-unclaimed", createdAt: 50_000 }),
    );
    await insertAutomationEventJobIfNotExists(
      db,
      buildJob({ id: "fresh-lease", idempotencyKey: "fresh-lease", createdAt: 1000 }),
    );
    await claimAutomationEventJob(db, {
      jobId: "fresh-lease",
      leaseOwner: "worker-b",
      leaseExpiresAt: 750_000,
      nowMs: 1000,
    });
    await insertAutomationEventJobIfNotExists(
      db,
      buildJob({ id: "fresh-queued", idempotencyKey: "fresh-queued", createdAt: 150_000 }),
    );
    await insertAutomationEventJobIfNotExists(
      db,
      buildJob({ id: "terminal", idempotencyKey: "terminal", createdAt: 1000 }),
    );
    await claimAutomationEventJob(db, {
      jobId: "terminal",
      leaseOwner: "worker-c",
      leaseExpiresAt: 600_000,
      nowMs: 1000,
    });
    await markAutomationEventJobTerminal(db, {
      jobId: "terminal",
      leaseOwner: "worker-c",
      phase: "failed",
      terminalReason: "enqueue_failed",
      completedAt: 2000,
    });

    await expect(countOpenAutomationEventJobsForBusiness(db, "biz-a")).resolves.toBe(4);
    await expect(failStaleAutomationEventJobs(db, nowMs)).resolves.toEqual([
      { id: "expired-lease", ruleId: "rule-1", businessId: "biz-a", terminalReason: "lease_expired" },
      { id: "stale-unclaimed", ruleId: "rule-1", businessId: "biz-a", terminalReason: "stale_unclaimed" },
    ]);

    const rows = sqlite
      .prepare(
        "SELECT id, phase, terminal_reason, completed_at, lease_owner, lease_expires_at FROM automation_event_jobs",
      )
      .all() as Array<{
      id: string;
      phase: string;
      terminal_reason: string | null;
      completed_at: number | null;
      lease_owner: string | null;
      lease_expires_at: number | null;
    }>;
    expect(Object.fromEntries(rows.map((row) => [row.id, row]))).toMatchObject({
      "expired-lease": {
        phase: "failed",
        terminal_reason: "lease_expired",
        completed_at: nowMs,
        lease_owner: null,
        lease_expires_at: null,
      },
      "stale-unclaimed": {
        phase: "failed",
        terminal_reason: "stale_unclaimed",
        completed_at: nowMs,
        lease_owner: null,
        lease_expires_at: null,
      },
      "fresh-lease": { phase: "claimed", terminal_reason: null, lease_owner: "worker-b" },
      "fresh-queued": { phase: "queued", terminal_reason: null },
      terminal: { phase: "failed", terminal_reason: "enqueue_failed", completed_at: 2000 },
    });
    await expect(countOpenAutomationEventJobsForBusiness(db, "biz-a")).resolves.toBe(2);
  });

  it("bounds stale automation event job sweeps to one page per tick", async () => {
    insertRule(sqlite);
    const nowMs = 1_000_000;
    for (let i = 0; i < 105; i += 1) {
      const suffix = String(i).padStart(3, "0");
      await insertAutomationEventJobIfNotExists(
        db,
        buildJob({
          id: `stale-${suffix}`,
          idempotencyKey: `stale-${suffix}`,
          createdAt: i + 1,
        }),
      );
    }

    await expect(countOpenAutomationEventJobsForBusiness(db, "biz-a")).resolves.toBe(105);
    const swept = await failStaleAutomationEventJobs(db, nowMs);

    expect(swept).toHaveLength(100);
    expect(swept[0]?.id).toBe("stale-000");
    expect(swept[99]?.id).toBe("stale-099");
    await expect(countOpenAutomationEventJobsForBusiness(db, "biz-a")).resolves.toBe(5);
  });

  it("returns only stale automation event jobs actually updated by the sweep", async () => {
    insertRule(sqlite);
    await insertAutomationEventJobIfNotExists(
      db,
      buildJob({ id: "concurrent", idempotencyKey: "concurrent", createdAt: 50_000 }),
    );
    await insertAutomationEventJobIfNotExists(
      db,
      buildJob({ id: "stale", idempotencyKey: "stale", createdAt: 60_000 }),
    );

    class ConcurrentCompletionD1 extends SqliteD1 {
      override async batch<T = unknown>(
        statements: Parameters<SqliteD1["batch"]>[0],
      ): Promise<Array<{ success: true; meta: { changes: number }; results?: T[] }>> {
        this.db
          .prepare(
            `UPDATE automation_event_jobs
             SET phase = 'succeeded',
                 terminal_reason = 'session_completed',
                 completed_at = ?,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(999_000, 999_000, "concurrent");
        return super.batch<T>(statements);
      }
    }

    await expect(
      failStaleAutomationEventJobs(new ConcurrentCompletionD1(sqlite) as unknown as D1Database, 1_000_000),
    ).resolves.toEqual([{ id: "stale", ruleId: "rule-1", businessId: "biz-a", terminalReason: "stale_unclaimed" }]);
  });
});
