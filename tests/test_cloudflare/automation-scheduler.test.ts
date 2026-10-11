// Scheduler tick tests: CAS, parse-failure parking, durable/transient gate
// failures, overlap skip via rich_status, concurrency cap, two-step
// create + prompt enqueue.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SESSION_START_MODEL_ID } from "../../shared/constants/models";

const mockGate = vi.fn();
const mockInitialize = vi.fn();
const mockEnqueue = vi.fn();
const mockListPrompts = vi.fn();

vi.mock("../../apps/control-plane-worker/src/services/integration-gating", () => ({
  gateGithubSessionStart: (...args: unknown[]) => mockGate(...args),
}));
vi.mock("../../apps/control-plane-worker/src/services/session-create", () => ({
  initializeAndProjectSession: (...args: unknown[]) => mockInitialize(...args),
  SessionCreateError: class extends Error {
    stage: string;
    constructor(stage: string, cause: unknown) {
      super(`stage=${stage}`);
      this.stage = stage;
      void cause;
    }
  },
}));
vi.mock("../../apps/control-plane-worker/src/session/state", () => ({
  enqueueSessionPrompt: (...args: unknown[]) => mockEnqueue(...args),
  listSessionPrompts: (...args: unknown[]) => mockListPrompts(...args),
}));

const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

const mockPostMessage = vi.fn();
vi.mock("../../apps/control-plane-worker/src/slack/notify", async (importActual) => {
  const actual = await importActual<typeof import("../../apps/control-plane-worker/src/slack/notify")>();
  return { ...actual, postMessage: (...args: unknown[]) => mockPostMessage(...args) };
});

const mockResolveBotToken = vi.fn();
vi.mock("../../apps/control-plane-worker/src/slack/tokens", async (importActual) => {
  const actual = await importActual<typeof import("../../apps/control-plane-worker/src/slack/tokens")>();
  return { ...actual, resolveInstalledSlackBotToken: (...args: unknown[]) => mockResolveBotToken(...args) };
});

const mockEmitDeliveryMetric = vi.fn();
vi.mock("../../apps/control-plane-worker/src/observability/automation-metrics", () => ({
  emitAutomationSlackDeliveryMetric: (...args: unknown[]) => mockEmitDeliveryMetric(...args),
}));

import {
  getAutomationSlotJob,
  getScheduledRuleById,
  type InsertScheduledRuleInput,
  type ScheduledRule,
} from "../../apps/control-plane-worker/src/automation/db";
import { automationSchedulerTick } from "../../apps/control-plane-worker/src/automation/scheduler";
import { AUTOMATION_MAX_CONCURRENT_SESSIONS_PER_BUSINESS } from "../../apps/control-plane-worker/src/constants/automation";
import { OpencodeAccessDeniedError } from "../../apps/control-plane-worker/src/services/opencode-access-gate";
import type { Env } from "../../apps/control-plane-worker/src/types";

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

function makeEnv(d1: SqliteD1): Env {
  return { DB: d1 as unknown } as unknown as Env;
}

const NOW = Date.UTC(2026, 0, 7, 14, 0, 0); // Wed 14:00 UTC — matches weekday 14:00 cron.

function seedRule(
  d1: SqliteD1,
  overrides: Partial<InsertScheduledRuleInput> & { id: string },
): InsertScheduledRuleInput {
  const input: InsertScheduledRuleInput = {
    id: overrides.id,
    businessId: overrides.businessId ?? "biz-a",
    configuredByUserId: overrides.configuredByUserId ?? "42",
    repoOwner: overrides.repoOwner ?? "acme",
    repoName: overrides.repoName ?? "webapp",
    installationId: overrides.installationId ?? 12345,
    modelId: overrides.modelId ?? null,
    promptTemplate: overrides.promptTemplate ?? "Run tests.",
    cronExpression: overrides.cronExpression ?? "0 14 * * 1-5",
    normalizedCron: overrides.normalizedCron ?? "0 14 * * 1,2,3,4,5",
    name: overrides.name ?? null,
    nextFireAt: overrides.nextFireAt ?? NOW,
    createdAt: overrides.createdAt ?? NOW - 1000,
  };
  // Direct INSERT so we can pre-seed without going through the service path.
  d1.sqlite
    .prepare(
      `INSERT INTO scheduled_rules (
        id, business_id, configured_by_user_id, repo_owner, repo_name, installation_id,
        model_id, prompt_template, cron_expression, normalized_cron, name,
        enabled, next_fire_at, last_enqueued_at, created_at, updated_at,
        slack_team_id, slack_channel_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.businessId,
      input.configuredByUserId,
      input.repoOwner,
      input.repoName,
      input.installationId,
      input.modelId ?? null,
      input.promptTemplate,
      input.cronExpression,
      input.normalizedCron,
      input.name,
      input.nextFireAt,
      input.createdAt,
      input.createdAt,
      overrides.slackTeamId ?? null,
      overrides.slackChannelId ?? null,
    );
  return input;
}

function seedSessionIndex(
  d1: SqliteD1,
  options: {
    sessionId: string;
    businessId: string;
    ownerUserId: string;
    scheduledRuleId?: string | null;
    richStatus?: string | null;
    initiationMode?: string;
  },
): void {
  const now = NOW;
  d1.sqlite
    .prepare(
      `INSERT INTO session_index (
				session_id, owner_user_id, business_id, repo_owner, repo_name,
				status, created_at, updated_at,
				scheduled_rule_id, initiation_mode, rich_status
			) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .run(
      options.sessionId,
      options.ownerUserId,
      options.businessId,
      "acme",
      "webapp",
      now,
      now,
      options.scheduledRuleId ?? null,
      options.initiationMode ?? "user",
      options.richStatus ?? null,
    );
}

function seedSlotJob(
  d1: SqliteD1,
  options: {
    ruleId: string;
    slotMs?: number;
    sessionId?: string;
    phase?: string;
    retryAfterMs?: number;
    createdAt?: number;
    promptTemplate?: string;
    installationId?: number;
  },
): void {
  const slotMs = options.slotMs ?? NOW;
  const sessionId = options.sessionId ?? `automation-${options.ruleId}-${slotMs}`;
  const createdAt = options.createdAt ?? NOW - 1000;
  d1.sqlite
    .prepare(
      `INSERT INTO automation_slot_jobs (
        job_key, rule_id, slot_ms, session_id, prompt_template, installation_id, phase,
        retry_after_ms, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `automation:${options.ruleId}:${slotMs}`,
      options.ruleId,
      slotMs,
      sessionId,
      options.promptTemplate ?? "Run tests.",
      options.installationId ?? 12345,
      options.phase ?? "slot_claimed",
      options.retryAfterMs ?? NOW,
      createdAt,
      createdAt,
    );
}

describe("automationSchedulerTick", () => {
  let d1: SqliteD1;
  let env: Env;

  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
    mockGate.mockReset();
    mockInitialize.mockReset();
    mockEnqueue.mockReset();
    mockListPrompts.mockReset();
    mockGate.mockResolvedValue({ ok: true, installationId: 12345 });
    mockInitialize.mockResolvedValue({ session: { sessionId: "x" }, replay: {} });
    mockEnqueue.mockResolvedValue({ ok: true, payload: {} });
    mockListPrompts.mockResolvedValue({ ok: true, payload: { prompts: [], queue: {} } });
    mockPostStructuredEventToDd.mockClear().mockResolvedValue(true);
    // Slack delivery defaults: healthy workspace + successful starting post.
    // Only rules seeded with a slack channel exercise these.
    mockResolveBotToken.mockReset();
    mockResolveBotToken.mockResolvedValue("xoxb-test-token");
    mockPostMessage.mockReset();
    mockPostMessage.mockResolvedValue({ ok: true, ts: "1700000000.000100", channel: "C456" });
    mockEmitDeliveryMetric.mockReset();
    mockEmitDeliveryMetric.mockResolvedValue(undefined);
  });

  it("emits automation.scheduler_error (stage rule) when a rule throws an unhandled error", async () => {
    // A permanent rule error (e.g. the fire-time gate rejecting) would otherwise repeat every tick with
    // only a console.error, which is never shipped to Datadog (logpush off). The outer per-rule safety
    // net must surface a queryable event.
    seedRule(d1, { id: "r-boom" });
    mockGate.mockRejectedValue(new Error("gate revalidation exploded"));

    const report = await automationSchedulerTick(env, { now: () => NOW });

    expect(report.fired).toBe(0);
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "automation.scheduler_error",
        stage: "rule",
        rule_id: "r-boom",
        business_id: "biz-a",
        error: expect.stringContaining("gate revalidation exploded"),
      }),
    );
  });

  it("emits automation.scheduler_error (stage slot_job) when a pending slot job throws", async () => {
    // A due slot job picked up from listDueAutomationSlotJobs that throws (gate reject) hits the separate
    // pending-jobs safety net; it too must be queryable, not console-only.
    seedRule(d1, { id: "r-slot" });
    seedSlotJob(d1, { ruleId: "r-slot", phase: "slot_claimed" });
    mockGate.mockRejectedValue(new Error("gate slot explosion"));

    await automationSchedulerTick(env, { now: () => NOW });

    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "automation.scheduler_error",
        stage: "slot_job",
        rule_id: "r-slot",
        error: expect.stringContaining("gate slot explosion"),
      }),
    );
  });

  it("does not emit automation.scheduler_error on a clean tick", async () => {
    seedRule(d1, { id: "r-ok" });
    await automationSchedulerTick(env, { now: () => NOW });
    expect(mockPostStructuredEventToDd).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "automation.scheduler_error" }),
    );
  });

  it("fires a due rule and advances next_fire_at", async () => {
    seedRule(d1, { id: "r1" });
    const report = await automationSchedulerTick(env, { now: () => NOW });
    expect(report.fired).toBe(1);
    expect(report.scanned).toBe(1);
    expect(mockInitialize).toHaveBeenCalledOnce();
    expect(mockEnqueue).toHaveBeenCalledOnce();
    const after = (await getScheduledRuleById(env.DB, "r1", "biz-a")) as ScheduledRule;
    expect(after.nextFireAt).toBeGreaterThan(NOW);
    expect(after.lastEnqueuedAt).toBe(Math.floor(NOW / 60_000) * 60_000);
    const job = await getAutomationSlotJob(env.DB, `automation:r1:${Math.floor(NOW / 60_000) * 60_000}`);
    expect(job?.terminalOutcome).toBe("fired");
  });

  it("enqueues leading slash skill prompts with the parsed skill list", async () => {
    seedRule(d1, { id: "r-skill", promptTemplate: "/audit-prod-docs https://docs.trycycloid.com/" });

    const report = await automationSchedulerTick(env, { now: () => NOW });

    expect(report.fired).toBe(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      env,
      `automation-r-skill-${NOW}`,
      "https://docs.trycycloid.com/",
      "42",
      expect.objectContaining({
        auth: expect.objectContaining({ userId: "42", businessId: "biz-a" }),
        skills: ["audit-prod-docs"],
      }),
    );
  });

  it("passes the rule's pinned model to session creation (Claude -> claude_code backend)", async () => {
    seedRule(d1, { id: "r-opus", modelId: "claude-opus-4-8" });
    const report = await automationSchedulerTick(env, { now: () => NOW });
    expect(report.fired).toBe(1);
    expect(mockInitialize).toHaveBeenCalledOnce();
    // createSessionState derives agent_runtime_backend from this model; a Claude
    // model id therefore runs the scheduled session on claude_code, not codex.
    const createArgs = mockInitialize.mock.calls[0][1] as { model: string };
    expect(createArgs.model).toBe("claude-opus-4-8");
  });

  it("falls back to the backend default model when the rule pins none", async () => {
    seedRule(d1, { id: "r-default" });
    await automationSchedulerTick(env, { now: () => NOW });
    const createArgs = mockInitialize.mock.calls[0][1] as { model: string };
    expect(createArgs.model).toBe("gpt-5.4");
  });

  it("does not fire disabled rules", async () => {
    seedRule(d1, { id: "r1" });
    d1.sqlite.prepare("UPDATE scheduled_rules SET enabled = 0 WHERE id = ?").run("r1");
    const report = await automationSchedulerTick(env, { now: () => NOW });
    expect(report.scanned).toBe(0);
    expect(report.fired).toBe(0);
  });

  it("CAS prevents double-fire across concurrent ticks for same slot", async () => {
    seedRule(d1, { id: "r1" });
    const [a, b] = await Promise.all([
      automationSchedulerTick(env, { now: () => NOW }),
      automationSchedulerTick(env, { now: () => NOW }),
    ]);
    const totalFired = a.fired + b.fired;
    expect(totalFired).toBe(1);
    expect(mockInitialize).toHaveBeenCalledOnce();
  });

  it("resumes a claimed-only slot job even after the rule next_fire_at advanced", async () => {
    seedRule(d1, { id: "r1", nextFireAt: NOW + 24 * 60 * 60 * 1000 });
    seedSlotJob(d1, { ruleId: "r1", slotMs: NOW, phase: "slot_claimed", retryAfterMs: NOW });

    const report = await automationSchedulerTick(env, { now: () => NOW });

    expect(report.fired).toBe(1);
    expect(mockGate).toHaveBeenCalledOnce();
    expect(mockInitialize).toHaveBeenCalledOnce();
    expect(mockEnqueue).toHaveBeenCalledOnce();
    const job = await getAutomationSlotJob(env.DB, `automation:r1:${NOW}`);
    expect(job?.terminalOutcome).toBe("fired");
  });

  it("parks a rule with an invalid stored cron without crashing siblings", async () => {
    // Direct insert to bypass service validation and corrupt the cron field.
    seedRule(d1, { id: "r-bad", cronExpression: "not-a-cron", normalizedCron: "not-a-cron" });
    seedRule(d1, { id: "r-good", repoName: "other" });
    const report = await automationSchedulerTick(env, { now: () => NOW });
    expect(report.parkedInvalidCron).toBe(1);
    expect(report.fired).toBe(1);
    const parked = (await getScheduledRuleById(env.DB, "r-bad", "biz-a")) as ScheduledRule;
    expect(parked.enabled).toBe(true); // not disabled, only parked
    expect(parked.nextFireAt).toBeGreaterThan(NOW + 100 * 24 * 60 * 60 * 1000); // far future
  });

  it.each([
    ["install_missing"],
    ["repo_access_denied"],
    ["token_revoked"],
    ["token_missing"],
    ["provider_authn_rejected"],
  ])("disables rule on durable gate failure (%s)", async (reasonCode) => {
    seedRule(d1, { id: "r1" });
    mockGate.mockResolvedValueOnce({
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: "integration_blocked",
        integrationId: "github",
        stage: "credential_resolved",
        reasonCode,
        userMessage: "x",
      },
    });
    const report = await automationSchedulerTick(env, { now: () => NOW });
    expect(report.disabledDurable).toBe(1);
    expect(report.fired).toBe(0);
    const after = (await getScheduledRuleById(env.DB, "r1", "biz-a")) as ScheduledRule;
    expect(after.enabled).toBe(false);
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "automation.rule_disabled",
        rule_id: "r1",
        business_id: "biz-a",
        reason_code: reasonCode,
        stage: "credential_resolved",
      }),
    );
  });

  it("keeps a durable rule disable when Datadog event export hangs", async () => {
    seedRule(d1, { id: "r1" });
    mockGate.mockResolvedValueOnce({
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: "integration_blocked",
        integrationId: "github",
        stage: "credential_resolved",
        reasonCode: "token_revoked",
        userMessage: "x",
      },
    });
    mockPostStructuredEventToDd.mockReturnValueOnce(new Promise(() => {}));

    const report = await automationSchedulerTick(env, { now: () => NOW });

    expect(report.disabledDurable).toBe(1);
    expect(report.fired).toBe(0);
    const after = (await getScheduledRuleById(env.DB, "r1", "biz-a")) as ScheduledRule;
    expect(after.enabled).toBe(false);
  });

  it.each([["provider_api_unavailable"], ["provider_rate_limited"], ["token_refresh_failed"]])(
    "leaves rule enabled and retries the claimed slot on transient gate failure (%s)",
    async (reasonCode) => {
      seedRule(d1, { id: "r1" });
      mockGate.mockResolvedValueOnce({
        ok: false,
        status: 409,
        body: {
          ok: false,
          error: "integration_blocked",
          integrationId: "github",
          stage: "credential_resolved",
          reasonCode,
          userMessage: "x",
        },
      });
      const report = await automationSchedulerTick(env, { now: () => NOW });
      expect(report.transientFailures).toBe(1);
      expect(report.fired).toBe(0);
      const after = (await getScheduledRuleById(env.DB, "r1", "biz-a")) as ScheduledRule;
      expect(after.enabled).toBe(true);
      const expectedSlot = Math.floor(NOW / 60_000) * 60_000;
      expect(after.nextFireAt).toBe(Date.UTC(2026, 0, 8, 14, 0, 0));
      const job = await getAutomationSlotJob(env.DB, `automation:r1:${expectedSlot}`);
      expect(job?.terminalOutcome).toBeNull();
      expect(job?.retryAfterMs).toBe(NOW + 60_000);
    },
  );

  it("keeps retrying the original slot when a transient gate failure persists into a later sweep", async () => {
    seedRule(d1, { id: "r1", cronExpression: "*/5 * * * *", normalizedCron: "*/5 * * * *" });
    mockGate.mockResolvedValue({
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: "integration_blocked",
        integrationId: "github",
        stage: "credential_resolved",
        reasonCode: "provider_api_unavailable",
        userMessage: "x",
      },
    });

    const firstReport = await automationSchedulerTick(env, { now: () => NOW });
    const secondReport = await automationSchedulerTick(env, { now: () => NOW + 5 * 60_000 });

    expect(firstReport.transientFailures).toBe(1);
    expect(secondReport.transientFailures).toBe(1);
    expect(mockGate).toHaveBeenCalledTimes(2);
    expect(mockInitialize).not.toHaveBeenCalled();
    const rows = d1.sqlite
      .prepare("SELECT job_key, slot_ms, retry_after_ms FROM automation_slot_jobs ORDER BY created_at")
      .all() as Array<{ job_key: string; slot_ms: number; retry_after_ms: number }>;
    expect(rows).toEqual([
      {
        job_key: `automation:r1:${NOW}`,
        slot_ms: NOW,
        retry_after_ms: NOW + 6 * 60_000,
      },
    ]);
    const after = (await getScheduledRuleById(env.DB, "r1", "biz-a")) as ScheduledRule;
    expect(after.nextFireAt).toBe(NOW + 5 * 60_000);
  });

  it("skips when a prior in-flight session exists for the rule", async () => {
    seedRule(d1, { id: "r1" });
    seedSessionIndex(d1, {
      sessionId: "prior-session",
      businessId: "biz-a",
      ownerUserId: "42",
      scheduledRuleId: "r1",
      richStatus: "running",
      initiationMode: "automation",
    });
    const report = await automationSchedulerTick(env, { now: () => NOW });
    expect(report.skippedOverlap).toBe(1);
    expect(report.fired).toBe(0);
    expect(mockInitialize).not.toHaveBeenCalled();
  });

  it("does not treat a terminal prior session as overlap", async () => {
    seedRule(d1, { id: "r1" });
    seedSessionIndex(d1, {
      sessionId: "prior-session",
      businessId: "biz-a",
      ownerUserId: "42",
      scheduledRuleId: "r1",
      richStatus: "completed",
      initiationMode: "automation",
    });
    const report = await automationSchedulerTick(env, { now: () => NOW });
    expect(report.fired).toBe(1);
  });

  it("skips when per-business concurrency cap is reached", async () => {
    seedRule(d1, { id: "r1" });
    for (let i = 0; i < AUTOMATION_MAX_CONCURRENT_SESSIONS_PER_BUSINESS; i++) {
      seedSessionIndex(d1, {
        sessionId: `active-${i}`,
        businessId: "biz-a",
        ownerUserId: "42",
        scheduledRuleId: null,
        richStatus: "running",
        initiationMode: "automation",
      });
    }
    const report = await automationSchedulerTick(env, { now: () => NOW });
    expect(report.skippedConcurrency).toBe(1);
    expect(report.fired).toBe(0);
    const job = await getAutomationSlotJob(env.DB, `automation:r1:${NOW}`);
    expect(job?.terminalOutcome).toBe("skipped_concurrency");
  });

  it("resumes a created-not-enqueued job and enqueues once", async () => {
    seedRule(d1, { id: "r1", nextFireAt: NOW + 24 * 60 * 60 * 1000 });
    seedSessionIndex(d1, {
      sessionId: `automation-r1-${NOW}`,
      businessId: "biz-a",
      ownerUserId: "42",
      scheduledRuleId: "r1",
      richStatus: "idle",
      initiationMode: "automation",
    });
    seedSlotJob(d1, { ruleId: "r1", slotMs: NOW, phase: "session_projected", retryAfterMs: NOW });

    const report = await automationSchedulerTick(env, { now: () => NOW });

    expect(report.fired).toBe(1);
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledOnce();
    const job = await getAutomationSlotJob(env.DB, `automation:r1:${NOW}`);
    expect(job?.terminalOutcome).toBe("fired");
  });

  it("does not enqueue again when retry finds the automation prompt already present", async () => {
    seedRule(d1, { id: "r1", nextFireAt: NOW + 24 * 60 * 60 * 1000 });
    seedSlotJob(d1, { ruleId: "r1", slotMs: NOW, phase: "session_projected", retryAfterMs: NOW });
    mockListPrompts.mockResolvedValueOnce({
      ok: true,
      payload: {
        prompts: [{ prompt: "Run tests.", actorUserId: "42" }],
        queue: {},
      },
    });

    const report = await automationSchedulerTick(env, { now: () => NOW });

    expect(report.fired).toBe(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
    const job = await getAutomationSlotJob(env.DB, `automation:r1:${NOW}`);
    expect(job?.terminalOutcome).toBe("fired");
  });

  it("matches an already-enqueued automation prompt by both prompt text and skills", async () => {
    seedRule(d1, { id: "r-skill", nextFireAt: NOW + 24 * 60 * 60 * 1000, promptTemplate: "/audit-prod-docs" });
    seedSlotJob(d1, {
      ruleId: "r-skill",
      slotMs: NOW,
      phase: "session_projected",
      retryAfterMs: NOW,
      promptTemplate: "/audit-prod-docs",
    });
    mockListPrompts.mockResolvedValueOnce({
      ok: true,
      payload: {
        prompts: [{ prompt: "", actorUserId: "42", skills: ["audit-prod-docs"] }],
        queue: {},
      },
    });

    const report = await automationSchedulerTick(env, { now: () => NOW });

    expect(report.fired).toBe(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("uses the slot-claim prompt snapshot when checking an already projected retry", async () => {
    seedRule(d1, {
      id: "r1",
      nextFireAt: NOW + 24 * 60 * 60 * 1000,
      promptTemplate: "Updated rule prompt.",
    });
    seedSlotJob(d1, {
      ruleId: "r1",
      slotMs: NOW,
      phase: "session_projected",
      retryAfterMs: NOW,
      promptTemplate: "Original slot prompt.",
    });
    mockListPrompts.mockResolvedValueOnce({
      ok: true,
      payload: {
        prompts: [{ prompt: "Original slot prompt.", actorUserId: "42" }],
        queue: {},
      },
    });

    const report = await automationSchedulerTick(env, { now: () => NOW });

    expect(report.fired).toBe(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
    const job = await getAutomationSlotJob(env.DB, `automation:r1:${NOW}`);
    expect(job?.terminalOutcome).toBe("fired");
  });

  it("uses the slot-job installation snapshot when resuming after gate revalidation", async () => {
    seedRule(d1, { id: "r1", nextFireAt: NOW + 24 * 60 * 60 * 1000, installationId: 111 });
    seedSlotJob(d1, {
      ruleId: "r1",
      slotMs: NOW,
      phase: "checks_passed",
      retryAfterMs: NOW,
      installationId: 222,
    });

    const report = await automationSchedulerTick(env, { now: () => NOW });

    expect(report.fired).toBe(1);
    expect(mockGate).not.toHaveBeenCalled();
    const args = mockInitialize.mock.calls[0][1] as Record<string, unknown>;
    expect(args.installationId).toBe(222);
  });

  it("persists the gate-resolved installation id on the slot job", async () => {
    seedRule(d1, { id: "r1", installationId: 111 });
    mockGate.mockResolvedValueOnce({ ok: true, installationId: 222 });

    await automationSchedulerTick(env, { now: () => NOW });

    const job = await getAutomationSlotJob(env.DB, `automation:r1:${NOW}`);
    expect(job?.installationId).toBe(222);
  });

  it("restores the natural next fire after a transient retry job completes", async () => {
    const nextNaturalFire = NOW + 24 * 60 * 60 * 1000;
    seedRule(d1, { id: "r1", nextFireAt: NOW + 60_000 });
    d1.sqlite
      .prepare("UPDATE scheduled_rules SET next_fire_at = ?, last_enqueued_at = ? WHERE id = ?")
      .run(NOW + 60_000, NOW, "r1");
    seedSlotJob(d1, { ruleId: "r1", slotMs: NOW, phase: "session_projected", retryAfterMs: NOW + 60_000 });

    const report = await automationSchedulerTick(env, { now: () => NOW + 5 * 60_000 });

    expect(report.scanned).toBe(1);
    expect(report.fired).toBe(1);
    expect(mockEnqueue).toHaveBeenCalledOnce();
    const after = (await getScheduledRuleById(env.DB, "r1", "biz-a")) as ScheduledRule;
    expect(after.nextFireAt).toBe(nextNaturalFire);
  });

  it("uses the per-tick limit to bound work", async () => {
    for (let i = 0; i < 10; i++) {
      seedRule(d1, { id: `r${i}`, repoName: `repo-${i}` });
    }
    const report = await automationSchedulerTick(env, { now: () => NOW, limit: 3 });
    expect(report.scanned).toBe(3);
    expect(report.fired).toBe(3);
  });

  it("threads provenance fields into initializeAndProjectSession", async () => {
    seedRule(d1, { id: "r1", name: "Weekday tests" });
    await automationSchedulerTick(env, { now: () => NOW });
    expect(mockInitialize).toHaveBeenCalledOnce();
    const args = mockInitialize.mock.calls[0][1] as Record<string, unknown>;
    expect(args.model).toBe(DEFAULT_SESSION_START_MODEL_ID);
    expect(args.initiationMode).toBe("automation");
    expect(args.scheduledRuleId).toBe("r1");
    expect(args.ruleNameSnapshot).toBe("Weekday tests");
    expect(args.cronSnapshot).toBe("0 14 * * 1,2,3,4,5");
  });

  describe("Slack delivery", () => {
    it("synthesizes a channel-only source:slack callbackContext and posts no starting message", async () => {
      seedRule(d1, { id: "r1", slackTeamId: "T123", slackChannelId: "C456" });
      const report = await automationSchedulerTick(env, { now: () => NOW });
      expect(report.fired).toBe(1);
      expect(mockResolveBotToken).toHaveBeenCalledWith(env, "T123");
      // No starting "Running…" card: a scheduled automation delivers only its
      // final digest as a single plain top-level message at completion, so the
      // context carries no threadTs/statusMessageTs anchor.
      expect(mockPostMessage).not.toHaveBeenCalled();
      const args = mockInitialize.mock.calls[0][1] as Record<string, unknown>;
      expect(args.callbackContext).toEqual({
        source: "slack",
        channel: "C456",
        slackTeamId: "T123",
      });
    });

    it("passes no callbackContext for a rule without a delivery channel", async () => {
      seedRule(d1, { id: "r1" });
      await automationSchedulerTick(env, { now: () => NOW });
      const args = mockInitialize.mock.calls[0][1] as Record<string, unknown>;
      expect(args.callbackContext).toBeUndefined();
      expect(mockResolveBotToken).not.toHaveBeenCalled();
      expect(mockPostMessage).not.toHaveBeenCalled();
    });

    it("fails open when the workspace is not connected: still fires, records the error + metric", async () => {
      seedRule(d1, { id: "r1", slackTeamId: "T123", slackChannelId: "C456" });
      mockResolveBotToken.mockResolvedValueOnce(null);
      const report = await automationSchedulerTick(env, { now: () => NOW });
      // Delivery failure never fails or disables the session.
      expect(report.fired).toBe(1);
      const args = mockInitialize.mock.calls[0][1] as Record<string, unknown>;
      expect(args.callbackContext).toBeUndefined();
      expect(mockPostMessage).not.toHaveBeenCalled();
      expect(mockEmitDeliveryMetric).toHaveBeenCalledWith(env, "workspace_not_connected");
      const rule = (await getScheduledRuleById(env.DB, "r1", "biz-a")) as ScheduledRule;
      expect(rule.lastDeliveryError).toBe("workspace_not_connected");
    });

    it("fails open when workspace-token resolution THROWS: records post_failed, never fails the session", async () => {
      seedRule(d1, { id: "r1", slackTeamId: "T123", slackChannelId: "C456" });
      // The only pre-session Slack work left is the workspace-connected check; a
      // thrown token resolution must never fail the session and must not be silent.
      mockResolveBotToken.mockRejectedValueOnce(new Error("socket hang up"));
      const report = await automationSchedulerTick(env, { now: () => NOW });
      expect(report.fired).toBe(1);
      const args = mockInitialize.mock.calls[0][1] as Record<string, unknown>;
      expect(args.callbackContext).toBeUndefined();
      expect(mockEmitDeliveryMetric).toHaveBeenCalledWith(env, "post_failed");
      const rule = (await getScheduledRuleById(env.DB, "r1", "biz-a")) as ScheduledRule;
      expect(rule.lastDeliveryError).toContain("post_threw:");
      expect(rule.lastDeliveryError).toContain("socket hang up");
    });
  });

  it("falls back to a computed name snapshot when rule.name is null", async () => {
    seedRule(d1, { id: "r1", name: null });
    await automationSchedulerTick(env, { now: () => NOW });
    const args = mockInitialize.mock.calls[0][1] as Record<string, unknown>;
    expect(args.ruleNameSnapshot).toBe("acme/webapp @ 0 14 * * 1,2,3,4,5");
  });

  it("reports createFailures when session create throws", async () => {
    seedRule(d1, { id: "r1" });
    mockInitialize.mockRejectedValueOnce(new Error("DO unavailable"));
    const report = await automationSchedulerTick(env, { now: () => NOW });
    expect(report.createFailures).toBe(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "automation.session_create_failed",
        rule_id: "r1",
        business_id: "biz-a",
        session_id: `automation-r1-${NOW}`,
        stage: "unknown",
        reason: "session_create_unknown",
      }),
    );
  });

  it("disables the rule when session create is permanently denied for opencode", async () => {
    seedRule(d1, { id: "r1", modelId: "kimi-k2.7-code" });
    mockInitialize.mockRejectedValueOnce(new OpencodeAccessDeniedError({ businessId: "biz-a" }));

    const report = await automationSchedulerTick(env, { now: () => NOW });

    expect(report.createFailures).toBe(1);
    expect(report.disabledDurable).toBe(1);
    expect(mockEnqueue).not.toHaveBeenCalled();
    const after = (await getScheduledRuleById(env.DB, "r1", "biz-a")) as ScheduledRule;
    expect(after.enabled).toBe(false);
    const expectedSlot = Math.floor(NOW / 60_000) * 60_000;
    const job = await getAutomationSlotJob(env.DB, `automation:r1:${expectedSlot}`);
    expect(job?.terminalOutcome).toBe("failed");
    expect(job?.failureReason).toBe("session_create_opencode_access_denied");
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "automation.session_create_failed",
        rule_id: "r1",
        business_id: "biz-a",
        session_id: `automation-r1-${NOW}`,
        stage: "opencode_access_denied",
        reason: "session_create_opencode_access_denied",
      }),
    );
  });

  it("reports createFailures when prompt enqueue returns ok=false", async () => {
    seedRule(d1, { id: "r1" });
    mockEnqueue.mockResolvedValueOnce({ ok: false, status: 500 });
    const report = await automationSchedulerTick(env, { now: () => NOW });
    expect(report.createFailures).toBe(1);
    expect(report.fired).toBe(0);
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "automation.prompt_enqueue_failed",
        rule_id: "r1",
        business_id: "biz-a",
        session_id: `automation-r1-${NOW}`,
        stage: "prompt_enqueue",
        reason: "prompt_enqueue_500",
      }),
    );
  });

  it("marks the orphaned session_index row failed when enqueue fails so the next tick is not blocked", async () => {
    seedRule(d1, { id: "r1" });
    // initializeAndProjectSession is mocked, so we simulate the session_index
    // row it would have written (rich_status='idle', scheduled_rule_id set).
    mockInitialize.mockImplementationOnce(async (_env: unknown, input: Record<string, unknown>) => {
      seedSessionIndex(d1, {
        sessionId: input.sessionId as string,
        businessId: "biz-a",
        ownerUserId: "42",
        scheduledRuleId: "r1",
        richStatus: "idle",
        initiationMode: "automation",
      });
      return { session: { sessionId: input.sessionId }, replay: {} };
    });
    mockEnqueue.mockResolvedValueOnce({ ok: false, status: 500 });

    const firstReport = await automationSchedulerTick(env, { now: () => NOW });
    expect(firstReport.createFailures).toBe(1);

    // The orphan should now be rich_status='failed' so the next tick doesn't
    // see it as in-flight via hasInFlightSessionForRule.
    const orphanRow = d1.sqlite
      .prepare("SELECT rich_status FROM session_index WHERE scheduled_rule_id = ?")
      .get("r1") as { rich_status: string } | undefined;
    expect(orphanRow?.rich_status).toBe("failed");

    // Run a second tick after rewinding next_fire_at so the rule is due again;
    // it should fire normally since the orphan is no longer non-terminal.
    d1.sqlite
      .prepare("UPDATE scheduled_rules SET next_fire_at = ?, last_enqueued_at = NULL WHERE id = ?")
      .run(NOW + 5 * 60_000, "r1");
    mockEnqueue.mockResolvedValueOnce({ ok: true, payload: {} });
    const secondReport = await automationSchedulerTick(env, { now: () => NOW + 5 * 60_000 });
    expect(secondReport.skippedOverlap).toBe(0);
    expect(secondReport.fired).toBe(1);
  });
});
