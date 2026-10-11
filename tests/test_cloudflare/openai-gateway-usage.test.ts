import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  insertGatewayLedgerRow,
  releaseGatewayLedgerRow,
  settleGatewayLedgerRow,
} from "../../apps/control-plane-worker/src/openai-gateway/db";
import {
  currentUtcMonthPeriod,
  getOpenAIGatewayUsagePayload,
} from "../../apps/control-plane-worker/src/openai-gateway/usage";

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.db.prepare(this.query).run(...this.values);
    return { success: true, meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid ?? 0) } };
  }

  async first<T>() {
    return (this.db.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>() {
    return { results: this.db.prepare(this.query).all(...this.values) as T[] };
  }

  async executeBatch() {
    const normalized = this.query.trimStart().toUpperCase();
    if (normalized.startsWith("SELECT") || normalized.startsWith("WITH")) {
      return this.all<Record<string, unknown>>();
    }
    const result = await this.run();
    return { results: [], meta: result.meta };
  }
}

class SqliteD1 {
  readonly db = new Database(":memory:");

  constructor() {
    this.db.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0109_openai_gateway.sql"), "utf8"));
    this.db.exec(
      readFileSync(resolve("apps/control-plane-worker/migrations/0141_openai_gateway_byok_sources.sql"), "utf8"),
    );
  }

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }

  async batch(statements: SqliteD1Statement[]) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.executeBatch());
    }
    return results;
  }
}

function insertDefaultVirtualKey(
  db: SqliteD1,
  params: { userId: number; businessId: string | null; now: number; monthlyLimitUsdMicros?: number },
): void {
  db.db
    .prepare(
      `INSERT INTO openai_virtual_keys (
        id, key_hash, owner_user_id, business_id, monthly_limit_usd_micros, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(
      `vk_user_${params.userId}`,
      `hash-${params.userId}`,
      String(params.userId),
      params.businessId,
      params.monthlyLimitUsdMicros ?? 100_000_000,
      params.now,
      params.now,
    );
}

describe("OpenAI gateway usage", () => {
  it("returns zeroed usage and an empty key list when the user has no gateway records", async () => {
    const db = new SqliteD1();
    const now = Date.UTC(2026, 4, 15);

    const payload = await getOpenAIGatewayUsagePayload(db as unknown as D1Database, 123, now);

    expect(payload).toEqual({
      currentMonth: {
        periodStartMs: Date.UTC(2026, 4, 1),
        periodEndMs: Date.UTC(2026, 5, 1),
        spentUsdMicros: 0,
        reservedUsdMicros: 0,
        monthlyLimitUsdMicros: 0,
        settledRequestCount: 0,
        reservedRequestCount: 0,
        releasedRequestCount: 0,
        settlementUnresolvedRequestCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        sources: [],
      },
      virtualKeys: [],
    });
  });

  it("returns the key and monthly limit with zero spend when the user has no ledger rows", async () => {
    const db = new SqliteD1();
    const now = Date.UTC(2026, 4, 15);
    insertDefaultVirtualKey(db, {
      userId: 123,
      businessId: "biz-1",
      now,
      monthlyLimitUsdMicros: 12_000_000,
    });

    const payload = await getOpenAIGatewayUsagePayload(db as unknown as D1Database, 123, now);

    expect(payload.currentMonth).toMatchObject({
      spentUsdMicros: 0,
      reservedUsdMicros: 0,
      monthlyLimitUsdMicros: 12_000_000,
      settledRequestCount: 0,
      reservedRequestCount: 0,
    });
    expect(payload.virtualKeys).toEqual([
      {
        id: "vk_user_123",
        status: "active",
        monthlyLimitUsdMicros: 12_000_000,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });

  it("summarizes current-month settled, reserved, released, unresolved, tokens, and keys", async () => {
    const db = new SqliteD1();
    const periodStart = Date.UTC(2026, 4, 1);
    insertDefaultVirtualKey(db, {
      userId: 123,
      businessId: "biz-1",
      now: periodStart,
    });

    await insertGatewayLedgerRow(db as unknown as D1Database, {
      id: "ledger-settled",
      virtualKeyId: "vk_user_123",
      ownerUserId: "123",
      businessId: "biz-1",
      sessionId: null,
      promptId: null,
      requestId: "req-1",
      model: "gpt-5.4-mini",
      credentialSource: "managed_virtual_key",
      upstreamCredentialRef: "vk_user_123",
      estimatedCostUsdMicros: 100,
      reservedCostUsdMicros: 100,
      now: periodStart + 1000,
    });
    await settleGatewayLedgerRow(db as unknown as D1Database, {
      ledgerId: "ledger-settled",
      openaiResponseId: "resp-1",
      actualCostUsdMicros: 75,
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 3,
      reasoningOutputTokens: 2,
      settlementSource: "response_completed",
      rawUsageJson: "{}",
      now: periodStart + 2000,
    });
    await insertGatewayLedgerRow(db as unknown as D1Database, {
      id: "ledger-reserved",
      virtualKeyId: "vk_user_123",
      ownerUserId: "123",
      businessId: "biz-1",
      sessionId: null,
      promptId: null,
      requestId: "req-2",
      model: "gpt-5.4-mini",
      credentialSource: "managed_virtual_key",
      upstreamCredentialRef: "vk_user_123",
      estimatedCostUsdMicros: 50,
      reservedCostUsdMicros: 50,
      now: periodStart + 3000,
    });
    await insertGatewayLedgerRow(db as unknown as D1Database, {
      id: "ledger-released",
      virtualKeyId: "vk_user_123",
      ownerUserId: "123",
      businessId: "biz-1",
      sessionId: null,
      promptId: null,
      requestId: "req-3",
      model: "gpt-5.4-mini",
      credentialSource: "managed_virtual_key",
      upstreamCredentialRef: "vk_user_123",
      estimatedCostUsdMicros: 30,
      reservedCostUsdMicros: 30,
      now: periodStart + 3500,
    });
    await releaseGatewayLedgerRow(db as unknown as D1Database, {
      ledgerId: "ledger-released",
      status: "released",
      now: periodStart + 3600,
    });
    await insertGatewayLedgerRow(db as unknown as D1Database, {
      id: "ledger-unresolved",
      virtualKeyId: "vk_user_123",
      ownerUserId: "123",
      businessId: "biz-1",
      sessionId: null,
      promptId: null,
      requestId: "req-4",
      model: "gpt-5.4-mini",
      credentialSource: "managed_virtual_key",
      upstreamCredentialRef: "vk_user_123",
      estimatedCostUsdMicros: 40,
      reservedCostUsdMicros: 40,
      now: periodStart + 3700,
    });
    await releaseGatewayLedgerRow(db as unknown as D1Database, {
      ledgerId: "ledger-unresolved",
      status: "settlement_unresolved",
      unresolvedReason: "missing_usage",
      now: periodStart + 3800,
    });

    const payload = await getOpenAIGatewayUsagePayload(db as unknown as D1Database, 123, periodStart + 4000);

    expect(payload.currentMonth).toMatchObject({
      spentUsdMicros: 75,
      reservedUsdMicros: 50,
      monthlyLimitUsdMicros: 100_000_000,
      settledRequestCount: 1,
      reservedRequestCount: 1,
      releasedRequestCount: 1,
      settlementUnresolvedRequestCount: 1,
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 3,
      reasoningOutputTokens: 2,
    });
    expect(payload.currentMonth.sources).toEqual([
      {
        source: "managed_virtual_key",
        label: "Cycloid managed key",
        spentUsdMicros: 75,
        reservedUsdMicros: 50,
        settledRequestCount: 1,
        reservedRequestCount: 1,
        releasedRequestCount: 1,
        settlementUnresolvedRequestCount: 1,
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 3,
        reasoningOutputTokens: 2,
      },
    ]);
    expect(payload.virtualKeys).toHaveLength(1);
    expect(payload.virtualKeys[0]).toMatchObject({ id: "vk_user_123", status: "active" });
  });

  it("aggregates multiple active keys for one user and excludes inactive key limits", async () => {
    const db = new SqliteD1();
    const now = Date.UTC(2026, 4, 15);
    insertDefaultVirtualKey(db, {
      userId: 123,
      businessId: "biz-1",
      now,
      monthlyLimitUsdMicros: 10_000_000,
    });
    db.db
      .prepare(
        `INSERT INTO openai_virtual_keys (
          id, key_hash, owner_user_id, business_id, monthly_limit_usd_micros, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("vk_user_123_extra", "hash-extra", "123", "biz-1", 20_000_000, "active", now + 1, now + 1);
    db.db
      .prepare(
        `INSERT INTO openai_virtual_keys (
          id, key_hash, owner_user_id, business_id, monthly_limit_usd_micros, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("vk_user_123_inactive", "hash-inactive", "123", "biz-1", 90_000_000, "inactive", now + 2, now + 2);

    for (const [id, virtualKeyId, cost] of [
      ["ledger-1", "vk_user_123", 100],
      ["ledger-2", "vk_user_123_extra", 200],
    ] as const) {
      await insertGatewayLedgerRow(db as unknown as D1Database, {
        id,
        virtualKeyId,
        ownerUserId: "123",
        businessId: "biz-1",
        sessionId: null,
        promptId: null,
        requestId: `${id}-req`,
        model: "gpt-5.4-mini",
        credentialSource: "managed_virtual_key",
        upstreamCredentialRef: virtualKeyId,
        estimatedCostUsdMicros: cost,
        reservedCostUsdMicros: cost,
        now,
      });
      await settleGatewayLedgerRow(db as unknown as D1Database, {
        ledgerId: id,
        openaiResponseId: `${id}-resp`,
        actualCostUsdMicros: cost,
        inputTokens: cost,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        settlementSource: "response_completed",
        rawUsageJson: "{}",
        now: now + 1,
      });
    }

    const payload = await getOpenAIGatewayUsagePayload(db as unknown as D1Database, 123, now);

    expect(payload.currentMonth).toMatchObject({
      spentUsdMicros: 300,
      monthlyLimitUsdMicros: 30_000_000,
      settledRequestCount: 2,
      inputTokens: 300,
      outputTokens: 2,
    });
    expect(payload.virtualKeys.map((key) => key.id)).toEqual([
      "vk_user_123",
      "vk_user_123_extra",
      "vk_user_123_inactive",
    ]);
  });

  it("excludes other users and rows outside the current UTC month", async () => {
    const db = new SqliteD1();
    const periodStart = Date.UTC(2026, 4, 1);
    const now = Date.UTC(2026, 4, 31, 23);
    insertDefaultVirtualKey(db, {
      userId: 123,
      businessId: "biz-1",
      now: periodStart,
    });
    insertDefaultVirtualKey(db, {
      userId: 456,
      businessId: "biz-2",
      now: periodStart,
    });

    for (const [id, ownerUserId, virtualKeyId, createdAt, cost] of [
      ["previous-month", "123", "vk_user_123", periodStart - 1, 100],
      ["current-month", "123", "vk_user_123", periodStart, 200],
      ["other-user", "456", "vk_user_456", periodStart, 300],
      ["next-month", "123", "vk_user_123", Date.UTC(2026, 5, 1), 400],
    ] as const) {
      await insertGatewayLedgerRow(db as unknown as D1Database, {
        id,
        virtualKeyId,
        ownerUserId,
        businessId: ownerUserId === "123" ? "biz-1" : "biz-2",
        sessionId: null,
        promptId: null,
        requestId: `${id}-req`,
        model: "gpt-5.4-mini",
        credentialSource: "managed_virtual_key",
        upstreamCredentialRef: virtualKeyId,
        estimatedCostUsdMicros: cost,
        reservedCostUsdMicros: cost,
        now: createdAt,
      });
      await settleGatewayLedgerRow(db as unknown as D1Database, {
        ledgerId: id,
        openaiResponseId: `${id}-resp`,
        actualCostUsdMicros: cost,
        inputTokens: cost,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        settlementSource: "response_completed",
        rawUsageJson: "{}",
        now: createdAt,
      });
    }

    const payload = await getOpenAIGatewayUsagePayload(db as unknown as D1Database, 123, now);

    expect(payload.currentMonth.spentUsdMicros).toBe(200);
    expect(payload.currentMonth.settledRequestCount).toBe(1);
    expect(payload.currentMonth.inputTokens).toBe(200);
    expect(payload.virtualKeys.map((key) => key.id)).toEqual(["vk_user_123"]);
  });

  it("uses UTC month boundaries even when local US time is still the previous month", () => {
    expect(currentUtcMonthPeriod(Date.UTC(2026, 5, 1, 0, 30))).toEqual({
      periodStartMs: Date.UTC(2026, 5, 1),
      periodEndMs: Date.UTC(2026, 6, 1),
    });
  });
});
