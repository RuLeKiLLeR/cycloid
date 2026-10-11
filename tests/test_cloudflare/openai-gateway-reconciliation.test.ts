import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockSentryCloudflare } from "./helpers/worker-harness";

mockSentryCloudflare();

class FakeD1 {
  queries: string[] = [];

  prepare(query: string) {
    this.queries.push(query);
    return {
      query,
      bind() {
        return this;
      },
      async first<T>() {
        return { total: 2_000_000 } as T;
      },
      async all<T>() {
        return {
          results: [
            { credentialSource: "managed_virtual_key", total: 2_000_000 },
            { credentialSource: "user_byok", total: 3_000_000 },
            { credentialSource: "business_byok", total: 4_000_000 },
          ],
        } as T;
      },
    };
  }
}

describe("OpenAI gateway reconciliation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("skips reconciliation when gateway API key id is missing", async () => {
    const { runOpenAIGatewayReconciliation } =
      await import("../../apps/control-plane-worker/src/openai-gateway/reconciliation");
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

    const report = await runOpenAIGatewayReconciliation(
      { DB: new FakeD1(), OPENAI_ADMIN_API_KEY: "admin-key" } as never,
      { now: Date.UTC(2026, 4, 15), logger: logger as never },
    );

    expect(report).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      { action: "openai_gateway_reconciliation_skipped" },
      "Skipping OpenAI gateway reconciliation because OPENAI_GATEWAY_API_KEY_ID is not configured",
    );
  });

  it("sums only costs grouped to the gateway API key id", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                results: [
                  { api_key_id: "key_gateway", amount: { value: 2 } },
                  { api_key_id: "key_other", amount: { value: 99 } },
                ],
              },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { runOpenAIGatewayReconciliation } =
      await import("../../apps/control-plane-worker/src/openai-gateway/reconciliation");
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const db = new FakeD1();

    const report = await runOpenAIGatewayReconciliation(
      {
        DB: db,
        OPENAI_ADMIN_API_KEY: "admin-key",
        OPENAI_GATEWAY_API_KEY_ID: "key_gateway",
      } as never,
      { now: Date.UTC(2026, 4, 15), logger: logger as never },
    );

    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.searchParams.get("group_by")).toBe("api_key_id");
    expect(db.queries.some((query) => query.includes("credential_source = 'managed_virtual_key'"))).toBe(true);
    expect(db.queries.some((query) => query.includes("GROUP BY credential_source"))).toBe(true);
    expect(report).toMatchObject({
      openaiCostUsdMicros: 2_000_000,
      cycloidSettledUsdMicros: 2_000_000,
      settledUsdMicrosByCredentialSource: {
        managed_virtual_key: 2_000_000,
        user_byok: 3_000_000,
        business_byok: 4_000_000,
      },
      notReconciledCredentialSources: ["user_byok", "business_byok"],
      driftUsdMicros: 0,
      alerted: false,
    });
  });

  it("retries transient OpenAI costs API failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ results: [{ api_key_id: "key_gateway", amount: { value: 2 } }] }],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { runOpenAIGatewayReconciliation } =
      await import("../../apps/control-plane-worker/src/openai-gateway/reconciliation");
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

    try {
      const reportPromise = runOpenAIGatewayReconciliation(
        {
          DB: new FakeD1(),
          OPENAI_ADMIN_API_KEY: "admin-key",
          OPENAI_GATEWAY_API_KEY_ID: "key_gateway",
        } as never,
        { now: Date.UTC(2026, 4, 15), logger: logger as never },
      );
      await vi.runAllTimersAsync();
      const report = await reportPromise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(report?.openaiCostUsdMicros).toBe(2_000_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
