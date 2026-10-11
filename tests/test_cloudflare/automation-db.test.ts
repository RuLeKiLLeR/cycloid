// DAO tests for scheduled_rules: insert, list (with cursor pagination),
// business scoping, get-by-id, count, and the partial unique-active-identity index.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimAutomationSlotJobLease,
  claimScheduledRuleFire,
  countAutomationRunOutcomesForRuleSince,
  countEnabledScheduledRulesForBusiness,
  deleteScheduledRuleById,
  getAutomationSlotJob,
  getScheduledRuleById,
  getScheduledRuleByIdForScheduler,
  insertScheduledRuleIfBusinessUnderEnabledCap,
  type InsertScheduledRuleInput,
  listAutomationRunsForRule,
  listDueAutomationSlotJobs,
  listDueScheduledRules,
  listScheduledRules,
  markAutomationSlotJobTerminal,
  markAutomationSlotJobTerminalAndRestoreSchedule,
  recordScheduledRuleDelivery,
  rescheduleAutomationSlotJob,
  updateAutomationSlotJobPhase,
} from "../../apps/control-plane-worker/src/automation/db";
import { AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS } from "../../apps/control-plane-worker/src/constants/automation";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

class SqliteD1Statement {
  private boundValues: unknown[] = [];
  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}
  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }
  runSync() {
    const result = this.db.prepare(this.query).run(...this.boundValues);
    return {
      success: true as const,
      meta: { last_row_id: Number(result.lastInsertRowid ?? 0), changes: result.changes },
    };
  }
  async run() {
    return this.runSync();
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");
  constructor() {
    this.sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, query);
  }
  async batch(statements: SqliteD1Statement[]) {
    const tx = this.sqlite.transaction(() => statements.map((statement) => statement.runSync()));
    return tx();
  }
}

function buildInsert(overrides: Partial<InsertScheduledRuleInput> = {}): InsertScheduledRuleInput {
  return {
    id: overrides.id ?? "rule-1",
    businessId: overrides.businessId ?? "biz-a",
    configuredByUserId: overrides.configuredByUserId ?? "42",
    repoOwner: overrides.repoOwner ?? "acme",
    repoName: overrides.repoName ?? "webapp",
    installationId: overrides.installationId ?? 12345,
    modelId: overrides.modelId ?? null,
    promptTemplate: overrides.promptTemplate ?? "Run tests and fix snapshots.",
    cronExpression: overrides.cronExpression ?? "0 14 * * 1-5",
    normalizedCron: overrides.normalizedCron ?? "0 14 * * 1,2,3,4,5",
    name: overrides.name ?? null,
    nextFireAt: overrides.nextFireAt ?? Date.UTC(2026, 0, 7, 14, 0, 0),
    createdAt: overrides.createdAt ?? Date.UTC(2026, 0, 1, 0, 0, 0),
    slackTeamId: overrides.slackTeamId ?? null,
    slackChannelId: overrides.slackChannelId ?? null,
  };
}

// Setup helper: insert a rule unconditionally for fixtures. Wraps the capped
// sibling with an effectively unlimited cap so the insert always proceeds
// (the partial unique-active-identity index still throws on conflict).
const UNLIMITED_RULE_CAP = Number.MAX_SAFE_INTEGER;
async function insertScheduledRule(db: D1Database, input: InsertScheduledRuleInput): Promise<void> {
  await insertScheduledRuleIfBusinessUnderEnabledCap(db, input, UNLIMITED_RULE_CAP, UNLIMITED_RULE_CAP);
}

describe("scheduled_rules DAO", () => {
  let d1: SqliteD1;
  let db: D1Database;
  beforeEach(() => {
    d1 = new SqliteD1();
    db = d1 as unknown as D1Database;
  });

  it("inserts and reads back a rule", async () => {
    await insertScheduledRule(db, buildInsert({ name: "Test rule" }));
    const got = await getScheduledRuleById(db, "rule-1", "biz-a");
    expect(got).not.toBeNull();
    expect(got!.id).toBe("rule-1");
    expect(got!.businessId).toBe("biz-a");
    expect(got!.name).toBe("Test rule");
    expect(got!.enabled).toBe(true);
    expect(got!.lastEnqueuedAt).toBeNull();
  });

  it("round-trips model_id (set, and default-null) across both read projections", async () => {
    await insertScheduledRule(db, buildInsert({ id: "with-model", modelId: "claude-opus-4-8" }));
    await insertScheduledRule(db, buildInsert({ id: "no-model", repoName: "other" }));

    const withModel = await getScheduledRuleById(db, "with-model", "biz-a");
    expect(withModel!.modelId).toBe("claude-opus-4-8");
    // The scheduler reads through a distinct projection; it must carry model_id
    // too, since that is the value it routes the session model+backend on.
    const forScheduler = await getScheduledRuleByIdForScheduler(db, "with-model");
    expect(forScheduler!.modelId).toBe("claude-opus-4-8");

    // Omitting modelId defaults the column to NULL (use the backend default).
    const noModel = await getScheduledRuleById(db, "no-model", "biz-a");
    expect(noModel!.modelId).toBeNull();
  });

  it("scopes get-by-id by business_id", async () => {
    await insertScheduledRule(db, buildInsert({ id: "rule-1", businessId: "biz-a" }));
    expect(await getScheduledRuleById(db, "rule-1", "biz-b")).toBeNull();
  });

  it("lists rules for a business with newest-first ordering", async () => {
    await insertScheduledRule(db, buildInsert({ id: "r1", createdAt: 100 }));
    await insertScheduledRule(db, buildInsert({ id: "r2", createdAt: 200, repoName: "other" }));
    await insertScheduledRule(db, buildInsert({ id: "r3", createdAt: 300, repoName: "third" }));
    const result = await listScheduledRules(db, { businessId: "biz-a", limit: 10 });
    expect(result.items.map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect(result.nextCursor).toBeNull();
  });

  it("excludes rules from other businesses", async () => {
    await insertScheduledRule(db, buildInsert({ id: "r1", businessId: "biz-a" }));
    await insertScheduledRule(db, buildInsert({ id: "r2", businessId: "biz-b", repoName: "other" }));
    const result = await listScheduledRules(db, { businessId: "biz-a", limit: 10 });
    expect(result.items.map((r) => r.id)).toEqual(["r1"]);
  });

  it("paginates via cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await insertScheduledRule(db, buildInsert({ id: `r${i}`, createdAt: 100 + i, repoName: `repo-${i}` }));
    }
    const page1 = await listScheduledRules(db, { businessId: "biz-a", limit: 2 });
    expect(page1.items.map((r) => r.id)).toEqual(["r4", "r3"]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listScheduledRules(db, { businessId: "biz-a", limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.id)).toEqual(["r2", "r1"]);
    const page3 = await listScheduledRules(db, { businessId: "biz-a", limit: 2, cursor: page2.nextCursor });
    expect(page3.items.map((r) => r.id)).toEqual(["r0"]);
    expect(page3.nextCursor).toBeNull();
  });

  it("counts enabled rules per business", async () => {
    await insertScheduledRule(db, buildInsert({ id: "r1" }));
    await insertScheduledRule(db, buildInsert({ id: "r2", repoName: "other" }));
    expect(await countEnabledScheduledRulesForBusiness(db, "biz-a")).toBe(2);
    expect(await countEnabledScheduledRulesForBusiness(db, "biz-b")).toBe(0);
  });

  it("rejects duplicate active-identity inserts via unique index", async () => {
    const input = buildInsert({ id: "r1" });
    await insertScheduledRule(db, input);
    await expect(insertScheduledRule(db, { ...input, id: "r2" })).rejects.toThrow(/UNIQUE/);
  });

  it("conditionally inserts only while the business is under the enabled-rule cap", async () => {
    for (let i = 0; i < AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS - 1; i++) {
      await insertScheduledRule(db, buildInsert({ id: `pre-${i}`, repoName: `repo-${i}` }));
    }

    await expect(
      insertScheduledRuleIfBusinessUnderEnabledCap(
        db,
        buildInsert({ id: "allowed", repoName: "allowed" }),
        AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS,
        UNLIMITED_RULE_CAP,
      ),
    ).resolves.toEqual({ inserted: true });

    await expect(
      insertScheduledRuleIfBusinessUnderEnabledCap(
        db,
        buildInsert({ id: "blocked", repoName: "blocked" }),
        AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS,
        UNLIMITED_RULE_CAP,
      ),
    ).resolves.toEqual({ inserted: false });
    expect(await getScheduledRuleById(db, "blocked", "biz-a")).toBeNull();
  });

  it("refuses any insert once the business hits the total-rule cap, even paused", async () => {
    await insertScheduledRule(db, buildInsert({ id: "r1", repoName: "r1" }));
    await insertScheduledRule(db, buildInsert({ id: "r2", repoName: "r2", enabled: false }));
    await expect(
      insertScheduledRuleIfBusinessUnderEnabledCap(
        db,
        buildInsert({ id: "r3", repoName: "r3", enabled: false }),
        UNLIMITED_RULE_CAP,
        2,
      ),
    ).resolves.toEqual({ inserted: false });
    expect(await getScheduledRuleById(db, "r3", "biz-a")).toBeNull();
    // Other businesses are unaffected by biz-a's total.
    await expect(
      insertScheduledRuleIfBusinessUnderEnabledCap(
        db,
        buildInsert({ id: "r4", repoName: "r4", businessId: "biz-b", enabled: false }),
        UNLIMITED_RULE_CAP,
        2,
      ),
    ).resolves.toEqual({ inserted: true });
  });

  it("permits an identical disabled rule to coexist with an enabled one", async () => {
    const input = buildInsert({ id: "r1" });
    await insertScheduledRule(db, input);
    // Disable the existing one and insert a second identical, enabled rule.
    d1.sqlite.prepare("UPDATE scheduled_rules SET enabled = 0 WHERE id = ?").run("r1");
    await expect(insertScheduledRule(db, { ...input, id: "r2" })).resolves.toBeUndefined();
  });

  describe("deleteScheduledRuleById", () => {
    it("removes the row and reports deleted=true", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      const result = await deleteScheduledRuleById(db, "r1", "biz-a");
      expect(result).toEqual({ deleted: true });
      expect(await getScheduledRuleById(db, "r1", "biz-a")).toBeNull();
    });

    it("returns deleted=false for unknown id", async () => {
      const result = await deleteScheduledRuleById(db, "missing", "biz-a");
      expect(result).toEqual({ deleted: false });
    });

    it("refuses to delete a rule owned by a different business", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1", businessId: "biz-a" }));
      const result = await deleteScheduledRuleById(db, "r1", "biz-b");
      expect(result).toEqual({ deleted: false });
      expect(await getScheduledRuleById(db, "r1", "biz-a")).not.toBeNull();
    });

    it("allows immediate recreate of the same active identity after delete", async () => {
      const input = buildInsert({ id: "r1" });
      await insertScheduledRule(db, input);
      await deleteScheduledRuleById(db, "r1", "biz-a");
      await expect(insertScheduledRule(db, { ...input, id: "r2" })).resolves.toBeUndefined();
    });

    it("deletes disabled rules as well", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      d1.sqlite.prepare("UPDATE scheduled_rules SET enabled = 0 WHERE id = ?").run("r1");
      const result = await deleteScheduledRuleById(db, "r1", "biz-a");
      expect(result).toEqual({ deleted: true });
      expect(await getScheduledRuleById(db, "r1", "biz-a")).toBeNull();
    });
  });

  describe("slack delivery columns", () => {
    it("defaults delivery columns to null when no channel is configured", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      const rule = await getScheduledRuleById(db, "r1", "biz-a");
      expect(rule).toMatchObject({
        slackTeamId: null,
        slackChannelId: null,
        lastDeliveredAt: null,
        lastDeliveryError: null,
      });
    });

    it("persists the delivery target and surfaces it on every read path", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1", slackTeamId: "T123", slackChannelId: "C456" }));

      const byId = await getScheduledRuleById(db, "r1", "biz-a");
      expect(byId).toMatchObject({ slackTeamId: "T123", slackChannelId: "C456" });

      const forScheduler = await getScheduledRuleByIdForScheduler(db, "r1");
      expect(forScheduler).toMatchObject({ slackTeamId: "T123", slackChannelId: "C456" });

      const listed = await listScheduledRules(db, { businessId: "biz-a", limit: 10 });
      expect(listed.items[0]).toMatchObject({ slackTeamId: "T123", slackChannelId: "C456" });

      const due = await listDueScheduledRules(db, Date.UTC(2030, 0, 1), 10);
      expect(due.find((r) => r.id === "r1")).toMatchObject({ slackTeamId: "T123", slackChannelId: "C456" });
    });

    it("records a successful delivery and clears any prior error", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1", slackTeamId: "T123", slackChannelId: "C456" }));
      await recordScheduledRuleDelivery(db, "r1", 5_000, { deliveredAt: null, error: "channel_not_found" });
      await recordScheduledRuleDelivery(db, "r1", 9_000, { deliveredAt: 9_000, error: null });

      const rule = await getScheduledRuleById(db, "r1", "biz-a");
      expect(rule).toMatchObject({ lastDeliveredAt: 9_000, lastDeliveryError: null });
      expect(rule!.updatedAt).toBe(9_000);
    });

    it("records a failed delivery and preserves the last successful timestamp", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1", slackTeamId: "T123", slackChannelId: "C456" }));
      await recordScheduledRuleDelivery(db, "r1", 9_000, { deliveredAt: 9_000, error: null });
      await recordScheduledRuleDelivery(db, "r1", 12_000, { deliveredAt: null, error: "not_in_channel" });

      // COALESCE preserves the prior success timestamp while recording the new error.
      const rule = await getScheduledRuleById(db, "r1", "biz-a");
      expect(rule).toMatchObject({ lastDeliveredAt: 9_000, lastDeliveryError: "not_in_channel" });
    });
  });

  describe("automation slot jobs", () => {
    it("creates a slot job idempotently with the scheduled-rule CAS claim", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      const slot = Date.UTC(2026, 0, 7, 14, 0, 0);
      const sessionId = `automation-r1-${slot}`;
      const jobKey = `automation:r1:${slot}`;

      await expect(
        claimScheduledRuleFire(
          db,
          "r1",
          slot,
          slot + 60_000,
          slot,
          jobKey,
          sessionId,
          "Run tests and fix snapshots.",
          12345,
        ),
      ).resolves.toBe(true);
      await expect(
        claimScheduledRuleFire(
          db,
          "r1",
          slot,
          slot + 60_000,
          slot,
          jobKey,
          sessionId,
          "Run tests and fix snapshots.",
          12345,
        ),
      ).resolves.toBe(false);

      const job = await getAutomationSlotJob(db, jobKey);
      expect(job).toMatchObject({
        jobKey,
        ruleId: "r1",
        slotMs: slot,
        sessionId,
        promptTemplate: "Run tests and fix snapshots.",
        installationId: 12345,
        phase: "slot_claimed",
        terminalOutcome: null,
        retryAfterMs: slot,
      });
      const count = d1.sqlite.prepare("SELECT COUNT(*) AS c FROM automation_slot_jobs").get() as { c: number };
      expect(count.c).toBe(1);
    });

    it("leases due jobs once and hides them until the lease expires", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      const slot = 1000;
      const jobKey = `automation:r1:${slot}`;
      await claimScheduledRuleFire(
        db,
        "r1",
        slot,
        slot + 60_000,
        slot,
        jobKey,
        `automation-r1-${slot}`,
        "Run tests and fix snapshots.",
        12345,
      );

      expect((await listDueAutomationSlotJobs(db, slot, 10)).map((job) => job.jobKey)).toEqual([jobKey]);
      await expect(claimAutomationSlotJobLease(db, jobKey, slot, slot + 10_000)).resolves.toBe(true);
      await expect(claimAutomationSlotJobLease(db, jobKey, slot, slot + 10_000)).resolves.toBe(false);
      expect(await listDueAutomationSlotJobs(db, slot + 1, 10)).toEqual([]);
      expect((await listDueAutomationSlotJobs(db, slot + 10_000, 10)).map((job) => job.jobKey)).toEqual([jobKey]);
    });

    it("checkpoints phase, retry cadence, and terminal outcome", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      const slot = 1000;
      const jobKey = `automation:r1:${slot}`;
      await claimScheduledRuleFire(
        db,
        "r1",
        slot,
        slot + 60_000,
        slot,
        jobKey,
        `automation-r1-${slot}`,
        "Run tests and fix snapshots.",
        12345,
      );

      await updateAutomationSlotJobPhase(db, jobKey, "session_projected", slot + 1);
      await rescheduleAutomationSlotJob(db, jobKey, slot + 60_000, slot + 2, "provider_api_unavailable");
      let job = await getAutomationSlotJob(db, jobKey);
      expect(job).toMatchObject({
        phase: "session_projected",
        retryAfterMs: slot + 60_000,
        failureReason: "provider_api_unavailable",
        leaseExpiresAt: null,
      });

      await markAutomationSlotJobTerminal(db, jobKey, "failed", slot + 3, "prompt_enqueue_500");
      job = await getAutomationSlotJob(db, jobKey);
      expect(job).toMatchObject({
        terminalOutcome: "failed",
        failureReason: "prompt_enqueue_500",
        leaseExpiresAt: null,
      });
      expect(await listDueAutomationSlotJobs(db, slot + 60_000, 10)).toEqual([]);
    });

    it("atomically restores rule schedule while marking a slot job terminal", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      const slot = 1000;
      const jobKey = `automation:r1:${slot}`;
      await claimScheduledRuleFire(
        db,
        "r1",
        slot,
        slot + 60_000,
        slot,
        jobKey,
        `automation-r1-${slot}`,
        "Run tests and fix snapshots.",
        12345,
      );

      await markAutomationSlotJobTerminalAndRestoreSchedule(db, "r1", jobKey, "fired", slot + 1, slot + 120_000);

      const rule = await getScheduledRuleById(db, "r1", "biz-a");
      expect(rule?.nextFireAt).toBe(slot + 120_000);
      const job = await getAutomationSlotJob(db, jobKey);
      expect(job?.terminalOutcome).toBe("fired");
      expect(job?.leaseExpiresAt).toBeNull();
    });
  });

  describe("run history", () => {
    function seedSlotJob(options: {
      ruleId: string;
      slotMs: number;
      terminalOutcome?: string | null;
      failureReason?: string | null;
      createdAt?: number;
    }): void {
      d1.sqlite
        .prepare(
          `INSERT INTO automation_slot_jobs (
             job_key, rule_id, slot_ms, session_id, prompt_template, installation_id,
             phase, terminal_outcome, failure_reason, retry_after_ms, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'Run tests.', 12345, 'slot_claimed', ?, ?, ?, ?, ?)`,
        )
        .run(
          `automation:${options.ruleId}:${options.slotMs}`,
          options.ruleId,
          options.slotMs,
          `automation-${options.ruleId}-${options.slotMs}`,
          options.terminalOutcome ?? null,
          options.failureReason ?? null,
          options.slotMs,
          options.createdAt ?? options.slotMs,
          options.createdAt ?? options.slotMs,
        );
    }

    function seedSessionIndexRow(sessionId: string, richStatus: string | null): void {
      d1.sqlite
        .prepare(
          `INSERT INTO session_index (
             session_id, owner_user_id, business_id, status, created_at, updated_at, rich_status
           ) VALUES (?, 42, 'biz-a', 'active', 1000, 1000, ?)`,
        )
        .run(sessionId, richStatus);
    }

    it("lists runs newest-first with joined session status and pending outcome as null", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      seedSlotJob({ ruleId: "r1", slotMs: 1000, terminalOutcome: "fired" });
      seedSessionIndexRow("automation-r1-1000", "completed");
      seedSlotJob({ ruleId: "r1", slotMs: 2000, terminalOutcome: "skipped_overlap" });
      seedSlotJob({
        ruleId: "r1",
        slotMs: 3000,
        terminalOutcome: "failed",
        failureReason: "session_create_projection",
      });
      seedSlotJob({ ruleId: "r1", slotMs: 4000 }); // still pending
      // Another rule's runs must not leak in.
      await insertScheduledRule(db, buildInsert({ id: "r2", repoName: "other" }));
      seedSlotJob({ ruleId: "r2", slotMs: 5000, terminalOutcome: "fired" });

      const result = await listAutomationRunsForRule(db, { ruleId: "r1", limit: 10 });
      expect(result.nextCursor).toBeNull();
      expect(result.items.map((run) => run.slotMs)).toEqual([4000, 3000, 2000, 1000]);
      expect(result.items[0]).toMatchObject({ outcome: null, sessionId: null, sessionRichStatus: null });
      expect(result.items[1]).toMatchObject({
        outcome: "failed",
        failureReason: "session_create_projection",
        sessionId: null,
      });
      expect(result.items[2]).toMatchObject({ outcome: "skipped_overlap", sessionId: null });
      expect(result.items[3]).toMatchObject({
        outcome: "fired",
        sessionId: "automation-r1-1000",
        sessionRichStatus: "completed",
      });
    });

    it("paginates by slot cursor", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      for (const slot of [1000, 2000, 3000]) {
        seedSlotJob({ ruleId: "r1", slotMs: slot, terminalOutcome: "fired" });
      }
      const first = await listAutomationRunsForRule(db, { ruleId: "r1", limit: 2 });
      expect(first.items.map((run) => run.slotMs)).toEqual([3000, 2000]);
      expect(first.nextCursor).toBe("2000");
      const second = await listAutomationRunsForRule(db, { ruleId: "r1", cursor: first.nextCursor, limit: 2 });
      expect(second.items.map((run) => run.slotMs)).toEqual([1000]);
      expect(second.nextCursor).toBeNull();
    });

    it("ignores a malformed cursor and returns the first page", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      seedSlotJob({ ruleId: "r1", slotMs: 1000, terminalOutcome: "fired" });
      const result = await listAutomationRunsForRule(db, { ruleId: "r1", cursor: "not-a-slot", limit: 10 });
      expect(result.items.map((run) => run.slotMs)).toEqual([1000]);
    });

    it("returns empty results for a rule with no runs", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      const result = await listAutomationRunsForRule(db, { ruleId: "r1", limit: 10 });
      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeNull();
      const counts = await countAutomationRunOutcomesForRuleSince(db, "r1", 0);
      expect(counts).toEqual({ fired: 0, failed: 0, skipped: 0 });
    });

    it("counts fired, failed, and skipped outcomes inside the window only", async () => {
      await insertScheduledRule(db, buildInsert({ id: "r1" }));
      seedSlotJob({ ruleId: "r1", slotMs: 1000, terminalOutcome: "fired", createdAt: 1000 }); // outside window
      seedSlotJob({ ruleId: "r1", slotMs: 2000, terminalOutcome: "fired", createdAt: 2000 });
      seedSlotJob({ ruleId: "r1", slotMs: 3000, terminalOutcome: "failed", createdAt: 3000 });
      seedSlotJob({ ruleId: "r1", slotMs: 4000, terminalOutcome: "skipped_overlap", createdAt: 4000 });
      seedSlotJob({ ruleId: "r1", slotMs: 5000, terminalOutcome: "skipped_concurrency", createdAt: 5000 });
      seedSlotJob({ ruleId: "r1", slotMs: 6000, terminalOutcome: null, createdAt: 6000 }); // pending: not counted

      const counts = await countAutomationRunOutcomesForRuleSince(db, "r1", 2000);
      expect(counts).toEqual({ fired: 1, failed: 1, skipped: 2 });
      const all = await countAutomationRunOutcomesForRuleSince(db, "r1", 0);
      expect(all).toEqual({ fired: 2, failed: 1, skipped: 2 });
    });
  });
});
