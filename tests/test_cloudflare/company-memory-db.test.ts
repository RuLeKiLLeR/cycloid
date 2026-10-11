import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimReenqueueableIngestionEvents,
  deleteChannelIntake,
  getChannelIntake,
  getIngestionEventBySourceUri,
  getIngestionEventsForThread,
  listChannelIntake,
  markIngestionEventSkipped,
  recordIngestionEvent,
  recoverStaleIngestionEvents,
  upsertChannelIntake,
} from "../../apps/control-plane-worker/src/company-memory/db";
import { recordSlackIngestion } from "../../apps/control-plane-worker/src/company-memory/service";
import { COMPANY_MEMORY_SOURCE_TYPE } from "../../apps/control-plane-worker/src/constants/company-memory";
import type { Env } from "../../apps/control-plane-worker/src/types";

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

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).all(...this.boundValues) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0132_ingestion_events.sql", "utf8"));
  sqlite.exec("CREATE TABLE users (id INTEGER PRIMARY KEY)");
  sqlite.exec("INSERT INTO users (id) VALUES (1), (42), (43)");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0133_slack_channel_intake.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0153_repo_memory_d1_sink.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0235_honcho_style_memory_context_graph.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("company memory ingestion DAO", () => {
  it("dedupes source events by tenant and source id without deduping content hash", async () => {
    const first = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev1",
      sourceUri: "slack://T/C/1",
      sourceTimeMs: 1_000,
      contentText: "same text",
      contentRef: null,
      teamId: "T1",
      channelId: "C1",
      threadTs: "1.000",
    });
    const duplicate = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev1",
      sourceUri: "slack://T/C/1",
      sourceTimeMs: 1_000,
      contentText: "same text",
      contentRef: null,
    });
    const sameContentDifferentEvent = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev2",
      sourceUri: "slack://T/C/2",
      sourceTimeMs: 2_000,
      contentText: "same text",
      contentRef: null,
    });

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ id: first.id, created: false });
    expect(sameContentDifferentEvent.created).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM ingestion_events").get()).toEqual({ count: 2 });
  });

  it("rejects source types outside the company-memory closed set", async () => {
    await expect(
      recordIngestionEvent(db, {
        businessId: "biz-1",
        sourceType: "slack.unknown" as never,
        sourceEventId: "Ev-invalid",
        sourceUri: "slack://T/C/invalid",
        sourceTimeMs: 1_000,
        contentText: "should not persist",
        contentRef: null,
      }),
    ).rejects.toThrow("Invalid company memory source_type");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM ingestion_events").get()).toEqual({ count: 0 });
  });

  it("rejects ingestion scope types outside the company-memory closed set", async () => {
    await expect(
      recordIngestionEvent(db, {
        businessId: "biz-1",
        sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
        sourceEventId: "Ev-invalid-scope",
        sourceUri: "slack://T/C/invalid-scope",
        sourceTimeMs: 1_000,
        contentText: "should not persist",
        contentRef: null,
        scopeType: "workspace" as never,
        scopeId: "global",
      }),
    ).rejects.toThrow("Invalid company memory scope_type");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM ingestion_events").get()).toEqual({ count: 0 });
  });

  it("rejects non-finite ingestion source timestamps", async () => {
    await expect(
      recordIngestionEvent(db, {
        businessId: "biz-1",
        sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
        sourceEventId: "Ev-invalid-time",
        sourceUri: "slack://T/C/invalid-time",
        sourceTimeMs: Number.NaN,
        contentText: "should not persist",
        contentRef: null,
      }),
    ).rejects.toThrow("source_time_ms must be finite");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM ingestion_events").get()).toEqual({ count: 0 });
  });

  it("rejects blank ingestion source URIs", async () => {
    await expect(
      recordIngestionEvent(db, {
        businessId: "biz-1",
        sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
        sourceEventId: "Ev-blank-source-uri",
        sourceUri: "   ",
        sourceTimeMs: 1_000,
        contentText: "should not persist",
        contentRef: null,
      }),
    ).rejects.toThrow("source_uri is required");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM ingestion_events").get()).toEqual({ count: 0 });
  });

  it("normalizes optional ingestion references before writing", async () => {
    await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "  Ev-normalized  ",
      sourceUri: "slack://T/C/normalized",
      sourceTimeMs: 1_000,
      contentText: "normalize refs",
      contentRef: null,
      scopeId: "  acme  ",
      actorRef: "  slack_user:U1  ",
      teamId: "  T1  ",
      channelId: "  C1  ",
      threadTs: "  1.000  ",
    });

    expect(
      sqlite
        .prepare("SELECT source_event_id, scope_id, actor_ref, team_id, channel_id, thread_ts FROM ingestion_events")
        .get(),
    ).toEqual({
      source_event_id: "Ev-normalized",
      scope_id: "acme",
      actor_ref: "slack_user:U1",
      team_id: "T1",
      channel_id: "C1",
      thread_ts: "1.000",
    });
  });

  it("stores whitespace-only optional ingestion references as null", async () => {
    await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "   ",
      sourceUri: "slack://T/C/null-refs",
      sourceTimeMs: 1_000,
      contentText: "null refs",
      contentRef: null,
      scopeId: "   ",
      actorRef: "   ",
      teamId: "   ",
      channelId: "   ",
      threadTs: "   ",
    });

    expect(
      sqlite
        .prepare("SELECT source_event_id, scope_id, actor_ref, team_id, channel_id, thread_ts FROM ingestion_events")
        .get(),
    ).toEqual({
      source_event_id: null,
      scope_id: null,
      actor_ref: null,
      team_id: null,
      channel_id: null,
      thread_ts: null,
    });
  });

  it("normalizes bounded ingestion reasons before writing state", async () => {
    const pending = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev-reasons-1",
      sourceUri: "slack://T/C/reasons-1",
      sourceTimeMs: 1_000,
      contentText: "blank redaction reason",
      contentRef: null,
      redactionReason: "   ",
      skipReason: "  later  ",
    });
    expect(
      sqlite
        .prepare("SELECT processing_state, redaction_reason, skip_reason FROM ingestion_events WHERE id = ?")
        .get(pending.id),
    ).toEqual({
      processing_state: "pending",
      redaction_reason: null,
      skip_reason: "later",
    });

    const longReason = `  ${"x".repeat(250)}  `;
    const quarantined = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev-reasons-2",
      sourceUri: "slack://T/C/reasons-2",
      sourceTimeMs: 1_000,
      contentText: "long redaction reason",
      contentRef: null,
      redactionReason: longReason,
    });
    expect(
      sqlite
        .prepare(
          "SELECT processing_state, length(redaction_reason) AS redaction_length FROM ingestion_events WHERE id = ?",
        )
        .get(quarantined.id),
    ).toEqual({ processing_state: "quarantined", redaction_length: 200 });

    await markIngestionEventSkipped(db, pending.id, "biz-1", "   ");
    expect(sqlite.prepare("SELECT skip_reason FROM ingestion_events WHERE id = ?").get(pending.id)).toEqual({
      skip_reason: "unspecified",
    });
  });

  it("keeps thread reads and pending claims tenant-scoped", async () => {
    await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev1",
      sourceUri: "slack://T/C/1",
      sourceTimeMs: 1_000,
      contentText: "biz one",
      contentRef: null,
      teamId: "T1",
      channelId: "C1",
      threadTs: "1.000",
    });
    await recordIngestionEvent(db, {
      businessId: "biz-2",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev2",
      sourceUri: "slack://T/C/1",
      sourceTimeMs: 1_000,
      contentText: "biz two",
      contentRef: null,
      teamId: "T1",
      channelId: "C1",
      threadTs: "1.000",
    });

    const bizOneThread = await getIngestionEventsForThread(db, "biz-1", "T1", "C1", "1.000");
    expect(bizOneThread.map((event) => event.contentText)).toEqual(["biz one"]);
    const normalizedLookup = await getIngestionEventsForThread(db, "biz-1", " T1 ", " C1 ", " 1.000 ");
    expect(normalizedLookup.map((event) => event.contentText)).toEqual(["biz one"]);
  });

  it("recovers only stale processing ingestion events", async () => {
    const stale = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev-stale",
      sourceUri: "slack://T/C/stale",
      sourceTimeMs: 1_000,
      contentText: "stale processing event",
      contentRef: null,
    });
    const recent = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev-recent",
      sourceUri: "slack://T/C/recent",
      sourceTimeMs: 2_000,
      contentText: "recent processing event",
      contentRef: null,
    });
    const complete = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev-complete",
      sourceUri: "slack://T/C/complete",
      sourceTimeMs: 3_000,
      contentText: "complete event",
      contentRef: null,
    });
    const now = Date.now();
    sqlite
      .prepare(
        `UPDATE ingestion_events
         SET processing_state = 'processing', processed_at_ms = ?, received_at_ms = ?
         WHERE id IN (?, ?)`,
      )
      .run(now - 60_000, now - 60_000, stale.id, complete.id);
    sqlite
      .prepare("UPDATE ingestion_events SET processing_state = 'processing', processed_at_ms = ? WHERE id = ?")
      .run(now, recent.id);
    sqlite
      .prepare(
        "UPDATE ingestion_events SET processing_state = 'complete', processed_at_ms = ? WHERE id = ? AND business_id = ?",
      )
      .run(Date.now(), complete.id, "biz-1");

    await expect(recoverStaleIngestionEvents(db, 10_000)).resolves.toBe(1);
    await expect(claimReenqueueableIngestionEvents(db, 10_000)).resolves.toEqual([
      { id: stale.id, businessId: "biz-1" },
    ]);
    await expect(claimReenqueueableIngestionEvents(db, 10_000)).resolves.toEqual([]);

    expect(
      sqlite
        .prepare("SELECT id, processing_state, processed_at_ms FROM ingestion_events ORDER BY source_time_ms")
        .all(),
    ).toEqual([
      { id: stale.id, processing_state: "pending", processed_at_ms: expect.any(Number) },
      { id: recent.id, processing_state: "processing", processed_at_ms: now },
      expect.objectContaining({ id: complete.id, processing_state: "complete" }),
    ]);
  });

  it("computes the stale cutoff from the D1 clock, not the worker Date.now() clock", async () => {
    // Regression: rows stamp processed_at_ms/received_at_ms with the D1 clock
    // (unixepoch()*1000), so the recovery cutoff must use the same clock. The
    // old code derived the cutoff from Date.now() (worker clock); under
    // worker/D1 drift that misclassifies stale rows. Here we skew Date.now()
    // far into the past so a worker-clock cutoff would be negative and recover
    // nothing, then assert recovery/reenqueue still fire off the DB clock.
    const staleProcessing = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev-skew-processing",
      sourceUri: "slack://T/C/skew-processing",
      sourceTimeMs: 1_000,
      contentText: "stale processing event",
      contentRef: null,
    });
    const stalePending = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev-skew-pending",
      sourceUri: "slack://T/C/skew-pending",
      sourceTimeMs: 2_000,
      contentText: "stale pending event",
      contentRef: null,
    });
    const recentProcessing = await recordIngestionEvent(db, {
      businessId: "biz-1",
      sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
      sourceEventId: "Ev-skew-recent",
      sourceUri: "slack://T/C/skew-recent",
      sourceTimeMs: 3_000,
      contentText: "recent processing event",
      contentRef: null,
    });

    // Stamp timestamps off the real D1 clock so the fixture never reads
    // Date.now() (which the old, buggy cutoff also read).
    sqlite
      .prepare(
        `UPDATE ingestion_events
         SET processing_state = 'processing',
             processed_at_ms = (unixepoch() * 1000) - 60000,
             received_at_ms = (unixepoch() * 1000) - 60000
         WHERE id = ?`,
      )
      .run(staleProcessing.id);
    sqlite
      .prepare(
        `UPDATE ingestion_events
         SET processing_state = 'pending', processed_at_ms = (unixepoch() * 1000) - 60000
         WHERE id = ?`,
      )
      .run(stalePending.id);
    sqlite
      .prepare(
        "UPDATE ingestion_events SET processing_state = 'processing', processed_at_ms = unixepoch() * 1000 WHERE id = ?",
      )
      .run(recentProcessing.id);

    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1);
    try {
      // claim runs first so the recovered processing row (which also becomes
      // pending) cannot interfere with the pending-row assertion.
      await expect(claimReenqueueableIngestionEvents(db, 10_000)).resolves.toEqual([
        { id: stalePending.id, businessId: "biz-1" },
      ]);
      // Recovers only the 60s-old processing row, not the freshly-stamped one.
      await expect(recoverStaleIngestionEvents(db, 10_000)).resolves.toBe(1);
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(
      (
        sqlite.prepare("SELECT id, processing_state FROM ingestion_events ORDER BY source_time_ms").all() as Array<{
          id: string;
          processing_state: string;
        }>
      ).filter((row) => row.id === recentProcessing.id),
    ).toEqual([{ id: recentProcessing.id, processing_state: "processing" }]);
  });
});

describe("company memory Slack channel intake DAO", () => {
  it("upserts, lists, and deletes tenant-scoped channel intake rows", async () => {
    const row = await upsertChannelIntake(db, {
      businessId: "biz-1",
      teamId: "T1",
      channelId: "C1",
      scopeType: "generic",
      scopeId: null,
      enabledByUserId: 42,
    });
    expect(row).toMatchObject({
      businessId: "biz-1",
      teamId: "T1",
      channelId: "C1",
      scopeType: "generic",
      enabledByUserId: 42,
    });

    await upsertChannelIntake(db, {
      businessId: "biz-1",
      teamId: "T1",
      channelId: "C1",
      scopeType: "support",
      scopeId: "repo:trycycloid/cycloid",
      enabledByUserId: 43,
    });

    await upsertChannelIntake(db, {
      businessId: "biz-2",
      teamId: "T1",
      channelId: "C1",
      scopeType: "generic",
      scopeId: null,
    });

    await expect(getChannelIntake(db, "biz-1", "T1", "C1")).resolves.toMatchObject({
      scopeType: "support",
      scopeId: "repo:trycycloid/cycloid",
      enabledByUserId: 43,
    });
    await expect(listChannelIntake(db, "biz-1")).resolves.toHaveLength(1);
    await expect(deleteChannelIntake(db, "biz-1", "T1", "C1")).resolves.toBe(true);
    await expect(getChannelIntake(db, "biz-1", "T1", "C1")).resolves.toBeNull();
    await expect(getChannelIntake(db, "biz-2", "T1", "C1")).resolves.not.toBeNull();
  });

  it("rejects channel intake scope types outside the closed set", async () => {
    await expect(
      upsertChannelIntake(db, {
        businessId: "biz-1",
        teamId: "T1",
        channelId: "C1",
        scopeType: "workspace" as never,
        scopeId: null,
      }),
    ).rejects.toThrow("Invalid company memory scope_type");

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM slack_channel_intake").get()).toEqual({ count: 0 });
  });

  it("normalizes channel intake scope ids before writing", async () => {
    const row = await upsertChannelIntake(db, {
      businessId: "biz-1",
      teamId: "T1",
      channelId: "C1",
      scopeType: "customer",
      scopeId: "  acme  ",
    });
    expect(row.scopeId).toBe("acme");
    expect(sqlite.prepare("SELECT scope_id FROM slack_channel_intake").get()).toEqual({ scope_id: "acme" });

    const blankRow = await upsertChannelIntake(db, {
      businessId: "biz-1",
      teamId: "T1",
      channelId: "C1",
      scopeType: "customer",
      scopeId: "   ",
    });
    expect(blankRow.scopeId).toBeNull();
    expect(sqlite.prepare("SELECT scope_id FROM slack_channel_intake").get()).toEqual({ scope_id: null });
  });
});

describe("company memory Slack ingestion service", () => {
  const workspace = {
    teamId: "T1",
    teamName: "Test",
    botUserId: "U_BOT",
    installedByUserId: 1,
    businessId: "biz-1",
    teamDomain: "test-workspace",
    enterpriseId: null,
    uninstalledAt: null,
  };

  it("skips Slack memory ingestion when the message timestamp is invalid", async () => {
    const env = { DB: db } as Env;
    const result = await recordSlackIngestion(
      env,
      { event_id: "Ev-invalid-ts", team_id: "T1" },
      {
        type: "message",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        ts: "not-a-slack-ts",
        text: "This should not persist.",
      },
      {
        businessId: "biz-1",
        workspace,
        intakeRow: null,
      },
    );

    expect(result).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM ingestion_events").get()).toEqual({ count: 0 });
  });

  it("quarantines secret-looking Slack text before persisting content", async () => {
    const env = { DB: db } as Env;
    const result = await recordSlackIngestion(
      env,
      { event_id: "Ev-secret", team_id: "T1" },
      {
        type: "message",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        ts: "1712345678.000100",
        text: "deploy key AKIAIOSFODNN7EXAMPLE should not persist",
      },
      {
        businessId: "biz-1",
        workspace,
        intakeRow: {
          businessId: "biz-1",
          teamId: "T1",
          channelId: "C1",
          scopeType: "generic",
          scopeId: null,
          enabledAtMs: 1,
          enabledByUserId: 1,
        },
      },
    );

    expect(result?.created).toBe(true);
    const row = sqlite
      .prepare(
        "SELECT source_uri, content_text, processing_state, redaction_reason, untrusted_payload FROM ingestion_events",
      )
      .get();
    expect(row).toEqual({
      source_uri: "https://test-workspace.slack.com/archives/C1/p1712345678000100",
      content_text: null,
      processing_state: "quarantined",
      redaction_reason: "aws_access_key",
      untrusted_payload: 1,
    });
  });

  it("caps inline Slack text before persisting content", async () => {
    const env = { DB: db } as Env;
    const result = await recordSlackIngestion(
      env,
      { event_id: "Ev-large", team_id: "T1" },
      {
        type: "message",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        ts: "1712345678.000200",
        text: "x".repeat(1_000_010),
      },
      {
        businessId: "biz-1",
        workspace,
        intakeRow: null,
      },
    );

    expect(result?.created).toBe(true);
    const row = sqlite.prepare("SELECT length(content_text) AS length FROM ingestion_events").get();
    expect(row).toEqual({ length: 1_000_000 });
  });

  it("quarantines secrets before applying the inline Slack text cap", async () => {
    const env = { DB: db } as Env;
    const result = await recordSlackIngestion(
      env,
      { event_id: "Ev-large-secret", team_id: "T1" },
      {
        type: "message",
        channel_type: "channel",
        channel: "C1",
        user: "U1",
        ts: "1712345678.000300",
        text: `${"x".repeat(1_000_010)} AKIAIOSFODNN7EXAMPLE`,
      },
      {
        businessId: "biz-1",
        workspace,
        intakeRow: null,
      },
    );

    expect(result?.created).toBe(true);
    const row = sqlite.prepare("SELECT content_text, processing_state, redaction_reason FROM ingestion_events").get();
    expect(row).toEqual({
      content_text: null,
      processing_state: "quarantined",
      redaction_reason: "aws_access_key",
    });
  });

  it("dedupes Slack ingestion by source URI when event ids differ", async () => {
    const env = { DB: db } as Env;
    const event = {
      type: "message",
      channel_type: "channel",
      channel: "C1",
      user: "U1",
      ts: "1712345678.000400",
      text: "Decision: shiv-testing is the Memory 2.0 verification channel.",
    };

    const first = await recordSlackIngestion(env, { event_id: "Ev-original", team_id: "T1" }, event, {
      businessId: "biz-1",
      workspace,
      intakeRow: null,
    });
    const second = await recordSlackIngestion(
      env,
      { event_id: "slack:T1:C1:1712345678.000400", team_id: "T1" },
      event,
      {
        businessId: "biz-1",
        workspace,
        intakeRow: null,
      },
    );

    expect(first?.created).toBe(true);
    expect(second).toEqual({ id: first?.id, created: false });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM ingestion_events").get()).toEqual({ count: 1 });
    await expect(
      getIngestionEventBySourceUri(db, "biz-1", "https://test-workspace.slack.com/archives/C1/p1712345678000400"),
    ).resolves.toMatchObject({
      id: first?.id,
      sourceEventId: "Ev-original",
    });
  });
});
