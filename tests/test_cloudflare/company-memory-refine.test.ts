import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockQueryOpenAIStructuredOutput } = vi.hoisted(() => ({
  mockQueryOpenAIStructuredOutput: vi.fn(),
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../shared/llm/structured-output", async () => {
  const actual = await vi.importActual<typeof import("../../shared/llm/structured-output")>(
    "../../shared/llm/structured-output",
  );
  return {
    ...actual,
    queryOpenAIStructuredOutput: mockQueryOpenAIStructuredOutput,
  };
});

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => mockLogger,
}));

import {
  listMemoryFactsForSourceEvents,
  MEMORY_PAGE_TYPES,
} from "../../apps/control-plane-worker/src/company-memory/core-db";
import { recordIngestionEvent } from "../../apps/control-plane-worker/src/company-memory/db";
import {
  handleMemoryRefineQueue,
  refineIngestionEvent,
} from "../../apps/control-plane-worker/src/company-memory/refine";
import { MEMORY_LINK_TYPES } from "../../apps/control-plane-worker/src/company-memory/verbs";
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
    return this.runSync();
  }

  runSync(): { success: true; meta: { changes: number } } {
    const info = this.db.prepare(this.query.replace(/\?(\d+)/g, "?")).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  readonly queries: string[] = [];

  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    this.queries.push(query);
    return new SqliteD1Statement(this.db, query);
  }

  async batch(statements: SqliteD1Statement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    const tx = this.db.transaction(() => statements.map((statement) => statement.runSync()));
    return tx();
  }
}

const budgetRequests: Array<{ path: string; body: unknown }> = [];

function createBudgetNamespace(options?: {
  releaseOk?: boolean;
  reserveOk?: boolean;
  settleOk?: boolean;
}): DurableObjectNamespace {
  const releaseOk = options?.releaseOk ?? true;
  const reserveOk = options?.reserveOk ?? true;
  const settleOk = options?.settleOk ?? true;
  const stub = {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      budgetRequests.push({
        path: pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (pathname === "/budget/reserve") {
        return new Response(
          JSON.stringify(
            reserveOk
              ? { ok: true, reservedUsdMicros: 250_000, month: "2026-05" }
              : { ok: false, code: "cycloid_openai_budget_exhausted" },
          ),
          { status: reserveOk ? 200 : 429, headers: { "content-type": "application/json" } },
        );
      }
      if (pathname === "/budget/settle" || pathname === "/budget/release") {
        const ok = pathname === "/budget/settle" ? settleOk : releaseOk;
        return new Response(JSON.stringify({ ok }), {
          status: ok ? 200 : 500,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected budget request: ${pathname} ${init?.body ?? ""}`);
    }),
  };
  return {
    idFromName: vi.fn((name: string) => ({ name }) as unknown as DurableObjectId),
    get: vi.fn(() => stub as unknown as DurableObjectStub),
  } as unknown as DurableObjectNamespace;
}

let sqlite: Database.Database;
let sqliteD1: SqliteD1;
let db: D1Database;
let env: Env;

beforeEach(() => {
  mockQueryOpenAIStructuredOutput.mockReset();
  for (const method of Object.values(mockLogger)) method.mockReset();
  budgetRequests.length = 0;
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0132_ingestion_events.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0134_company_memory_core.sql", "utf8"));
  sqliteD1 = new SqliteD1(sqlite);
  db = sqliteD1 as unknown as D1Database;
  env = {
    DB: db,
    ARCANIST_OPENAI_API_KEY: "test-key",
    OPENAI_GATEWAY_BUDGET: createBudgetNamespace(),
  } as Env;
});

async function insertDecisionEvent(): Promise<string> {
  const result = await recordIngestionEvent(db, {
    businessId: "biz-1",
    sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
    sourceEventId: "Ev-decision",
    sourceUri: "slack://T1/C1/1712345678.000100",
    sourceTimeMs: 1_712_345_678_000,
    contentText: "Decision: we are moving payments from Postgres to D1 to avoid regional latency.",
    contentRef: null,
    teamId: "T1",
    channelId: "C1",
    threadTs: "1712345678.000100",
  });
  return result.id;
}

async function insertThreadEvent(sourceEventId: string, messageTs: string, contentText: string): Promise<string> {
  const result = await recordIngestionEvent(db, {
    businessId: "biz-1",
    sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
    sourceEventId,
    sourceUri: `slack://T1/C1/${messageTs}`,
    sourceTimeMs: Math.floor(Number.parseFloat(messageTs) * 1000),
    contentText,
    contentRef: null,
    teamId: "T1",
    channelId: "C1",
    threadTs: "1712345678.000100",
  });
  return result.id;
}

describe("company memory refine", () => {
  it("lists source-event facts in batches under the D1 bind limit", async () => {
    const eventIds: string[] = [];
    for (let i = 0; i < 101; i++) {
      eventIds.push(
        await insertThreadEvent(
          `Ev-source-batch-${i}`,
          `1712345${String(100 + i)}.000100`,
          `Fact: source batch event ${i}.`,
        ),
      );
    }
    sqlite
      .prepare(
        `INSERT INTO memory_facts
         (id, business_id, kind, claim, holder, confidence, source_event_id, created_at_ms)
         VALUES
         ('fact-source-batch-first', 'biz-1', 'decision', 'First batch fact.', 'brain', 0.8, ?, 1000),
         ('fact-source-batch-last', 'biz-1', 'constraint', 'Last batch fact.', 'brain', 0.8, ?, 1000)`,
      )
      .run(eventIds[0], eventIds[100]);
    sqliteD1.queries.length = 0;

    const factsByEvent = await listMemoryFactsForSourceEvents(db, "biz-1", eventIds);

    expect(factsByEvent.get(eventIds[0])?.map((fact) => fact.claim)).toEqual(["First batch fact."]);
    expect(factsByEvent.get(eventIds[100])?.map((fact) => fact.claim)).toEqual(["Last batch fact."]);
    expect(sqliteD1.queries.filter((query) => query.includes("source_event_id IN"))).toHaveLength(2);
  });

  it("writes pages, facts, links, and provenance for a refined ingestion event", async () => {
    const eventId = await insertDecisionEvent();
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      facts: [
        {
          kind: "decision",
          claim: "Payments is moving from Postgres to D1 to avoid regional latency.",
          holder: "brain",
          confidence: 0.82,
          durable: true,
        },
      ],
      entities: [
        { page_type: "decision", slug: "payments-d1", title: "Payments D1 migration" },
        { page_type: "service", slug: "payments", title: "Payments" },
      ],
      edges: [
        {
          from: { page_type: "decision", slug: "payments-d1" },
          to: { page_type: "service", slug: "payments" },
          link_type: "decided_in",
        },
      ],
    });

    await expect(
      refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" }),
    ).resolves.toEqual({ status: "complete" });

    expect(sqlite.prepare("SELECT kind, claim, confidence, source_event_id FROM memory_facts").get()).toEqual({
      kind: "decision",
      claim: "Payments is moving from Postgres to D1 to avoid regional latency.",
      confidence: 0.82,
      source_event_id: eventId,
    });
    expect(sqlite.prepare("SELECT page_type, slug, title FROM memory_pages ORDER BY page_type").all()).toEqual([
      { page_type: "decision", slug: "payments-d1", title: "Payments D1 migration" },
      { page_type: "service", slug: "payments", title: "Payments" },
    ]);
    expect(sqlite.prepare("SELECT link_type FROM memory_links").get()).toEqual({ link_type: "decided_in" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_provenance").get()).toEqual({ count: 4 });
    expect(sqlite.prepare("SELECT processing_state FROM ingestion_events WHERE id = ?").get(eventId)).toEqual({
      processing_state: "complete",
    });
    expect(budgetRequests.find((request) => request.path === "/budget/settle")?.body).toMatchObject({
      reservedUsdMicros: 250_000,
      actualUsdMicros: 250_000,
    });
    expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        retry: { maxAttempts: 3 },
        tool: expect.objectContaining({
          input_schema: expect.objectContaining({
            properties: expect.objectContaining({
              entities: expect.objectContaining({
                items: expect.objectContaining({
                  properties: expect.objectContaining({
                    page_type: { type: "string", enum: [...MEMORY_PAGE_TYPES] },
                    title: { type: "string" },
                  }),
                }),
              }),
              edges: expect.objectContaining({
                items: expect.objectContaining({
                  properties: expect.objectContaining({
                    from: expect.objectContaining({
                      properties: expect.objectContaining({
                        page_type: { type: "string", enum: [...MEMORY_PAGE_TYPES] },
                      }),
                    }),
                    to: expect.objectContaining({
                      properties: expect.objectContaining({
                        page_type: { type: "string", enum: [...MEMORY_PAGE_TYPES] },
                      }),
                    }),
                    link_type: { type: "string", enum: [...MEMORY_LINK_TYPES] },
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("drops links to entities omitted for empty titles and logs the loss", async () => {
    const eventId = await insertDecisionEvent();
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      facts: [],
      entities: [
        { page_type: "decision", slug: "payments-d1", title: "" },
        { page_type: "service", slug: "payments", title: "Payments" },
      ],
      edges: [
        {
          from: { page_type: "decision", slug: "payments-d1" },
          to: { page_type: "service", slug: "payments" },
          link_type: "decided_in",
        },
      ],
    });

    await expect(
      refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" }),
    ).resolves.toEqual({ status: "complete" });

    expect(sqlite.prepare("SELECT page_type, slug, title FROM memory_pages").all()).toEqual([
      { page_type: "service", slug: "payments", title: "Payments" },
    ]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_links").get()).toEqual({ count: 0 });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        fromPageType: "decision",
        fromSlug: "payments-d1",
        toPageType: "service",
        toSlug: "payments",
        linkType: "decided_in",
      },
      "Dropped memory link with unresolved endpoint",
    );
  });

  it("bounds model-emitted memory strings before writing refine output", async () => {
    const eventId = await insertDecisionEvent();
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      facts: [
        {
          kind: "decision",
          claim: ` ${"c".repeat(4_010)} `,
          holder: ` ${"h".repeat(210)} `,
          confidence: 0.82,
          durable: true,
        },
      ],
      entities: [
        {
          page_type: "decision",
          slug: "s".repeat(250),
          title: ` ${"t".repeat(510)} `,
          summary: ` ${"m".repeat(2_010)} `,
        },
      ],
      edges: [],
    });

    await refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" });

    expect(
      sqlite.prepare("SELECT length(claim) AS claim_length, length(holder) AS holder_length FROM memory_facts").get(),
    ).toEqual({
      claim_length: 4_000,
      holder_length: 200,
    });
    expect(
      sqlite
        .prepare(
          "SELECT length(slug) AS slug_length, length(title) AS title_length, length(summary) AS summary_length FROM memory_pages",
        )
        .get(),
    ).toEqual({
      slug_length: 200,
      title_length: 500,
      summary_length: 2_000,
    });
  });

  it("is idempotent when the same event is refined twice", async () => {
    const eventId = await insertDecisionEvent();
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      facts: [{ kind: "decision", claim: "Use D1 for payments.", holder: "brain", confidence: 0.7, durable: true }],
      entities: [],
      edges: [],
    });

    await refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" });
    await refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" });

    expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledOnce();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_facts").get()).toEqual({ count: 1 });
  });

  it("drops self-referential company-memory tool instructions from refined facts", async () => {
    const eventId = await insertDecisionEvent();
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      facts: [
        {
          kind: "action_item",
          claim:
            'Call cycloid.company_memory_recall with intent "Memory 2.0 local live testing known constraints and dead ends".',
          holder: "brain",
          confidence: 0.98,
          durable: false,
        },
        {
          kind: "constraint",
          claim: "Memory 2.0 verification must use local dev plus ngrok before rollout.",
          holder: "brain",
          confidence: 0.92,
          durable: true,
        },
        {
          kind: "action_item",
          claim: "Use company memory recall to plan local Memory 2.0 live testing and avoid known dead ends.",
          holder: "brain",
          confidence: 0.96,
          durable: false,
        },
        {
          kind: "constraint",
          claim:
            "The Autonomous Memory 2.0 verification request says to summarize each returned result briefly and not edit files.",
          holder: "brain",
          confidence: 0.94,
          durable: false,
        },
        {
          kind: "constraint",
          claim: "In thread M35-E2E for repo trycycloid/cycloid, the instruction is to not edit files.",
          holder: "brain",
          confidence: 0.94,
          durable: false,
        },
      ],
      entities: [],
      edges: [],
    });

    await refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" });

    expect(sqlite.prepare("SELECT kind, claim FROM memory_facts").all()).toEqual([
      {
        kind: "constraint",
        claim: "Memory 2.0 verification must use local dev plus ngrok before rollout.",
      },
    ]);
  });

  it("skips an event already claimed by another refine worker", async () => {
    const eventId = await insertDecisionEvent();
    sqlite
      .prepare("UPDATE ingestion_events SET processing_state = 'processing' WHERE id = ? AND business_id = 'biz-1'")
      .run(eventId);

    await expect(
      refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" }),
    ).resolves.toEqual({ status: "skipped", reason: "already_processing" });

    expect(mockQueryOpenAIStructuredOutput).not.toHaveBeenCalled();
  });

  it("resets a claimed event to pending when refinement fails so queue retry can pick it up", async () => {
    const eventId = await insertDecisionEvent();
    mockQueryOpenAIStructuredOutput.mockRejectedValue(new Error("temporary model failure"));

    await expect(
      refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" }),
    ).rejects.toThrow("temporary model failure");

    expect(
      sqlite.prepare("SELECT processing_state, processed_at_ms FROM ingestion_events WHERE id = ?").get(eventId),
    ).toEqual({
      processing_state: "pending",
      processed_at_ms: null,
    });
  });

  it("acks successful queue messages after refining the ingestion event", async () => {
    const eventId = await insertDecisionEvent();
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      facts: [{ kind: "decision", claim: "Use D1 for payments.", holder: "brain", confidence: 0.7, durable: true }],
      entities: [],
      edges: [],
    });
    const ack = vi.fn();
    const retry = vi.fn();

    await handleMemoryRefineQueue(
      {
        queue: "cycloid-memory-refine",
        messages: [
          {
            body: { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" },
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch,
      env,
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT processing_state FROM ingestion_events WHERE id = ?").get(eventId)).toEqual({
      processing_state: "complete",
    });
  });

  it("retries failed queue messages and leaves the event pending for the next delivery", async () => {
    const eventId = await insertDecisionEvent();
    mockQueryOpenAIStructuredOutput.mockRejectedValue(new Error("temporary model failure"));
    const ack = vi.fn();
    const retry = vi.fn();

    await handleMemoryRefineQueue(
      {
        queue: "cycloid-memory-refine",
        messages: [
          {
            body: { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" },
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch,
      env,
    );

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(
      sqlite.prepare("SELECT processing_state, processed_at_ms FROM ingestion_events WHERE id = ?").get(eventId),
    ).toEqual({
      processing_state: "pending",
      processed_at_ms: null,
    });
  });

  it("drops disallowed model edge types while persisting valid facts", async () => {
    const eventId = (
      await recordIngestionEvent(db, {
        businessId: "biz-1",
        sourceType: COMPANY_MEMORY_SOURCE_TYPE.SLACK_INTAKE,
        sourceEventId: "Ev-guardrail",
        sourceUri: "slack://T1/C1/1712345679.000100",
        sourceTimeMs: 1_712_345_679_000,
        contentText: "Payments and checkout came up in planning.",
        contentRef: null,
        teamId: "T1",
        channelId: "C1",
        threadTs: "1712345678.000100",
      })
    ).id;
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      facts: [{ kind: "decision", claim: "Use D1 for payments.", holder: "brain", confidence: 0.7, durable: true }],
      entities: [
        { page_type: "decision", slug: "payments-d1", title: "Payments D1" },
        { page_type: "service", slug: "payments", title: "Payments" },
      ],
      edges: [
        {
          from: { page_type: "decision", slug: "payments-d1" },
          to: { page_type: "service", slug: "payments" },
          link_type: "rumored_relation_with",
        },
      ],
    });

    await refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" });

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_facts").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_links").get()).toEqual({ count: 0 });
  });

  it("marks events skipped without an LLM call when the business exceeds refine budget", async () => {
    const eventId = await insertDecisionEvent();
    env = { ...env, OPENAI_GATEWAY_BUDGET: createBudgetNamespace({ reserveOk: false }) };

    await expect(
      refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" }),
    ).resolves.toEqual({ status: "skipped", reason: "budget_exceeded" });

    expect(mockQueryOpenAIStructuredOutput).not.toHaveBeenCalled();
    expect(
      sqlite.prepare("SELECT processing_state, skip_reason FROM ingestion_events WHERE id = ?").get(eventId),
    ).toEqual({
      processing_state: "skipped",
      skip_reason: "budget_exceeded",
    });
  });

  it("logs and completes when the memory refine budget settle call returns non-ok", async () => {
    const eventId = await insertDecisionEvent();
    env = { ...env, OPENAI_GATEWAY_BUDGET: createBudgetNamespace({ settleOk: false }) };
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      facts: [
        {
          kind: "decision",
          claim: "Payments is moving from Postgres to D1 to avoid regional latency.",
          holder: "brain",
          confidence: 0.82,
          durable: true,
        },
      ],
      entities: [],
      edges: [],
    });

    await expect(
      refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" }),
    ).resolves.toEqual({ status: "complete" });

    expect(mockLogger.error).toHaveBeenCalledWith(
      { budgetKeyId: "memory-refine:biz-1", operation: "settle", status: 500 },
      "Company memory budget DO call failed",
    );
  });

  it("refines events when the refine budget binding is unavailable", async () => {
    const eventId = await insertDecisionEvent();
    env = { ...env, OPENAI_GATEWAY_BUDGET: undefined };
    mockQueryOpenAIStructuredOutput.mockResolvedValue({
      facts: [
        {
          kind: "decision",
          claim: "Payments is moving from Postgres to D1 to avoid regional latency.",
          holder: "brain",
          confidence: 0.82,
          durable: true,
        },
      ],
      entities: [],
      edges: [],
    });

    await expect(
      refineIngestionEvent(env, { businessId: "biz-1", ingestionEventId: eventId, trigger: "auto" }),
    ).resolves.toEqual({ status: "complete" });

    expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledOnce();
    expect(budgetRequests).toEqual([]);
    expect(
      sqlite.prepare("SELECT processing_state, skip_reason FROM ingestion_events WHERE id = ?").get(eventId),
    ).toEqual({
      processing_state: "complete",
      skip_reason: null,
    });
  });
});
