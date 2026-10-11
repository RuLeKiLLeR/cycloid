import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

function createMigratedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function insertRule(
  db: Database.Database,
  overrides: {
    id?: string;
    businessId?: string;
    provider?: string;
    enabled?: number;
    repoName?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO automation_rules (
      id, business_id, configured_by_user_id, name, trigger_kind, trigger_provider,
      slack_team_id, slack_channel_id, slack_bot_user_id,
      allowed_slack_app_ids_json, allowed_slack_bot_ids_json,
      repo_owner, repo_name, installation_id, prompt_template,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id ?? "rule-1",
    overrides.businessId ?? "biz-a",
    "42",
    "Datadog alerts",
    "slack_channel_message",
    overrides.provider ?? "datadog",
    "T_ALERTS",
    "C_ALERTS",
    "U_CYCLOID",
    JSON.stringify(["A_DATADOG"]),
    JSON.stringify(["B_DATADOG"]),
    "trycycloid",
    overrides.repoName ?? "cycloid",
    12345,
    "Investigate this alert.",
    overrides.enabled ?? 0,
    1000,
    1000,
  );
}

function insertJob(
  db: Database.Database,
  overrides: {
    id?: string;
    ruleId?: string;
    businessId?: string;
    provider?: string;
    idempotencyKey?: string;
    phase?: string;
    payloadJson?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO automation_event_jobs (
      id, rule_id, business_id, trigger_kind, trigger_provider, idempotency_key,
      slack_team_id, slack_channel_id, slack_message_ts, slack_thread_ts,
      phase, payload_json, attempt_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id ?? "job-1",
    overrides.ruleId ?? "rule-1",
    overrides.businessId ?? "biz-a",
    "slack_channel_message",
    overrides.provider ?? "datadog",
    overrides.idempotencyKey ?? "slack:T_ALERTS:C_ALERTS:1712345678.000100",
    "T_ALERTS",
    "C_ALERTS",
    "1712345678.000100",
    null,
    overrides.phase ?? "queued",
    overrides.payloadJson ?? JSON.stringify({ text: "Monitor triggered" }),
    0,
    1000,
    1000,
  );
}

describe("automation event job schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedDb();
  });

  it("stores disabled Slack channel automation rules by default", () => {
    insertRule(db);

    const row = db
      .prepare("SELECT enabled, trigger_kind, trigger_provider FROM automation_rules WHERE id = ?")
      .get("rule-1") as { enabled: number; trigger_kind: string; trigger_provider: string };

    expect(row).toEqual({
      enabled: 0,
      trigger_kind: "slack_channel_message",
      trigger_provider: "datadog",
    });
  });

  it("enforces one enabled active identity while permitting disabled drafts", () => {
    insertRule(db, { id: "enabled-1", enabled: 1 });

    expect(() => insertRule(db, { id: "enabled-2", enabled: 1 })).toThrow(/UNIQUE/);
    expect(() => insertRule(db, { id: "disabled-1", enabled: 0 })).not.toThrow();
    expect(() => insertRule(db, { id: "disabled-2", enabled: 0 })).not.toThrow();
  });

  it("rejects unsupported rule providers and enabled values", () => {
    expect(() => insertRule(db, { provider: "pagerduty" })).toThrow(/CHECK/);
    expect(() => insertRule(db, { enabled: 2 })).toThrow(/CHECK/);
  });

  it("stores jobs with rule references and terminal-state fields", () => {
    insertRule(db);
    insertJob(db);

    db.prepare(
      `UPDATE automation_event_jobs
       SET phase = 'succeeded', session_id = ?, terminal_reason = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run("session-1", "session_created", 2000, 2000, "job-1");

    const row = db
      .prepare("SELECT phase, session_id, terminal_reason, completed_at FROM automation_event_jobs WHERE id = ?")
      .get("job-1") as {
      phase: string;
      session_id: string;
      terminal_reason: string;
      completed_at: number;
    };

    expect(row).toEqual({
      phase: "succeeded",
      session_id: "session-1",
      terminal_reason: "session_created",
      completed_at: 2000,
    });
  });

  it("dedupes jobs by business-scoped idempotency key", () => {
    insertRule(db, { id: "rule-a", businessId: "biz-a" });
    insertRule(db, { id: "rule-b", businessId: "biz-b" });
    insertJob(db, { id: "job-a", ruleId: "rule-a", businessId: "biz-a", idempotencyKey: "event-1" });

    expect(() =>
      insertJob(db, { id: "job-a-dupe", ruleId: "rule-a", businessId: "biz-a", idempotencyKey: "event-1" }),
    ).toThrow(/UNIQUE/);

    expect(() =>
      insertJob(db, { id: "job-b", ruleId: "rule-b", businessId: "biz-b", idempotencyKey: "event-1" }),
    ).not.toThrow();
  });

  it("rejects unsupported job phases and oversized payloads", () => {
    insertRule(db);

    expect(() => insertJob(db, { phase: "running" })).toThrow(/CHECK/);
    expect(() => insertJob(db, { payloadJson: "x".repeat(32769) })).toThrow(/CHECK/);
    expect(() => insertJob(db, { payloadJson: "💥".repeat(9000) })).toThrow(/CHECK/);
  });

  it("cascades jobs when a rule is deleted", () => {
    insertRule(db);
    insertJob(db);

    db.prepare("DELETE FROM automation_rules WHERE id = ?").run("rule-1");

    const row = db.prepare("SELECT id FROM automation_event_jobs WHERE id = ?").get("job-1");
    expect(row).toBeUndefined();
  });

  it("creates lookup, claim, and idempotency indexes", () => {
    const ruleIndexes = db.prepare("PRAGMA index_list('automation_rules')").all() as Array<{ name: string }>;
    const jobIndexes = db.prepare("PRAGMA index_list('automation_event_jobs')").all() as Array<{ name: string }>;

    expect(ruleIndexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(["idx_automation_rules_slack_lookup", "idx_automation_rules_active_identity"]),
    );
    expect(jobIndexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(["idx_automation_event_jobs_claimable", "idx_automation_event_jobs_idempotency"]),
    );
  });

  it("seeds internal Datadog and Sentry rules disabled", () => {
    const rows = db
      .prepare(
        `SELECT id, trigger_provider, enabled
         FROM automation_rules
         WHERE id IN ('internal-datadog-slack-alerts', 'internal-sentry-slack-alerts')
         ORDER BY id`,
      )
      .all() as Array<{ id: string; trigger_provider: string; enabled: number }>;

    expect(rows).toEqual([
      { id: "internal-datadog-slack-alerts", trigger_provider: "datadog", enabled: 0 },
      { id: "internal-sentry-slack-alerts", trigger_provider: "sentry", enabled: 0 },
    ]);
  });
});
