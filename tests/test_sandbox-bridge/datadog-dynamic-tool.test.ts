import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("datadog dynamic tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds specs only when Datadog credentials are present", async () => {
    const {
      buildDatadogGetMonitorsDynamicToolSpec,
      buildDatadogGetTraceDynamicToolSpec,
      buildDatadogQueryMetricsDynamicToolSpec,
      buildDatadogSearchLogsDynamicToolSpec,
    } = await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");

    expect(buildDatadogSearchLogsDynamicToolSpec({})).toEqual([]);
    expect(
      buildDatadogSearchLogsDynamicToolSpec({ DD_API_KEY: "api", DD_APP_KEY: "app", DD_SITE: "evil.example.com" }),
    ).toEqual([]);
    expect(
      buildDatadogGetTraceDynamicToolSpec({ DD_API_KEY: "api", DD_APP_KEY: "app", DD_SITE: "us5.datadoghq.com" }),
    ).toHaveLength(1);
    expect(
      buildDatadogQueryMetricsDynamicToolSpec({ DD_API_KEY: "api", DD_APP_KEY: "app", DD_SITE: "us5.datadoghq.com" }),
    ).toMatchObject([{ namespace: "datadog", name: "query_metrics" }]);
    expect(
      buildDatadogGetMonitorsDynamicToolSpec({ DD_API_KEY: "api", DD_APP_KEY: "app", DD_SITE: "us5.datadoghq.com" }),
    ).toMatchObject([{ namespace: "datadog", name: "get_monitors" }]);
  });

  it("searches Datadog logs and normalizes hits", async () => {
    const { executeDatadogSearchLogsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "log-1",
                attributes: {
                  timestamp: "2026-05-12T12:00:00.000Z",
                  service: "api",
                  status: "error",
                  host: "web-1",
                  tags: ["env:prod", "team:core"],
                  attributes: {
                    message: "x".repeat(5000),
                    "dd.trace_id": "trace-123",
                    "dd.span_id": "span-456",
                  },
                },
              },
            ],
            meta: { page: { after: "next-page-cursor" } },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeDatadogSearchLogsDynamicToolCall(
      {
        query: "service:api status:error",
        from: "2026-05-12T11:30:00.000Z",
        to: "2026-05-12T12:00:00.000Z",
        cursor: "page-cursor",
        limit: 5,
      },
      {
        env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as {
      query: string;
      nextCursor?: string;
      hits: Array<{ traceId: string | null; message: string | null }>;
    };
    expect(payload.query).toBe("service:api status:error");
    expect(payload.nextCursor).toBe("next-page-cursor");
    expect(payload.hits[0]).toMatchObject({ traceId: "trace-123" });
    expect(payload.hits[0]?.message).toContain("[truncated]");

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      filter: Record<string, unknown>;
      page: Record<string, unknown>;
    };
    expect(request.filter).toEqual({
      query: "service:api status:error",
      from: "2026-05-12T11:30:00.000Z",
      to: "2026-05-12T12:00:00.000Z",
    });
    expect(request.page).toEqual({ limit: 5, cursor: "page-cursor" });
  });

  it("omits Datadog log nextCursor when the response has no following page", async () => {
    const { executeDatadogSearchLogsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;

    const result = await executeDatadogSearchLogsDynamicToolCall(
      { query: "service:api", limit: 5 },
      {
        env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as { nextCursor?: string; hits: unknown[] };
    expect(payload.hits).toEqual([]);
    expect(payload.nextCursor).toBeUndefined();
  });

  it("fetches a Datadog trace by trace ID and builds a span tree", async () => {
    const { executeDatadogGetTraceDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "span-a",
                attributes: {
                  trace_id: "trace-1",
                  span_id: "root",
                  parent_id: "0",
                  service: "frontend",
                  resource_name: "GET /",
                  start_timestamp: "2026-05-12T12:00:00.000Z",
                },
              },
              {
                id: "span-b",
                attributes: {
                  trace_id: "trace-1",
                  span_id: "child",
                  parent_id: "root",
                  service: "api",
                  resource_name: "GET /v1/widgets",
                  start_timestamp: "2026-05-12T12:00:00.100Z",
                },
              },
            ],
            meta: { page: {} },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeDatadogGetTraceDynamicToolCall(
      { traceId: "abc123", lookback: "72h" },
      {
        env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "datadoghq.com" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as {
      traceId: string;
      lookback: string;
      rootSpanCount: number;
      roots: Array<{ spanId: string; children: Array<{ spanId: string }> }>;
    };
    expect(payload.traceId).toBe("abc123");
    expect(payload.lookback).toBe("72h");
    expect(payload.rootSpanCount).toBe(1);
    expect(payload.roots[0]).toMatchObject({
      spanId: "root",
      children: [{ spanId: "child" }],
    });

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      data: { attributes: { filter: { query: string; from: string; to: string } } };
    };
    expect(request.data.attributes.filter.query).toBe("trace_id:abc123");
    expect(request.data.attributes.filter.from).toBe("now-72h");
    expect(request.data.attributes.filter.to).toBe("now");
  });

  it("defaults Datadog trace lookback to 24h", async () => {
    const { executeDatadogGetTraceDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "span-a",
                attributes: {
                  trace_id: "trace-1",
                  span_id: "root",
                  parent_id: "0",
                  service: "api",
                  resource_name: "GET /",
                },
              },
            ],
            meta: { page: {} },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeDatadogGetTraceDynamicToolCall(
      { traceId: "abc123" },
      {
        env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ traceId: "abc123", lookback: "24h" });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      data: { attributes: { filter: { from: string } } };
    };
    expect(request.data.attributes.filter.from).toBe("now-24h");
  });

  it("rejects invalid input and invalid Datadog sites", async () => {
    const { executeDatadogGetTraceDynamicToolCall, executeDatadogSearchLogsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");

    await expect(
      executeDatadogSearchLogsDynamicToolCall(
        { query: "", limit: 55 },
        { env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" } },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_input" });

    await expect(
      executeDatadogGetTraceDynamicToolCall(
        { traceId: "trace-1" },
        { env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "evil.example.com" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_credential",
      contentItems: [
        { type: "inputText", text: "Datadog site 'evil.example.com' is not supported for dynamic tools." },
      ],
    });

    await expect(
      executeDatadogGetTraceDynamicToolCall(
        { traceId: "abc OR service:*" },
        { env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" } },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
      contentItems: [
        {
          type: "inputText",
          text: "Datadog get_datadog_trace requires 'traceId' to be a hex string (up to 32 characters).",
        },
      ],
    });

    await expect(
      executeDatadogGetTraceDynamicToolCall(
        { traceId: "abc123", lookback: "16d" },
        { env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" } },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
      contentItems: [
        {
          type: "inputText",
          text: "Datadog get_datadog_trace requires 'lookback' to be a relative window ending in m, h, or d and no more than 15d.",
        },
      ],
    });

    await expect(
      executeDatadogSearchLogsDynamicToolCall(
        { query: "service:api", cursor: "page-cursor" },
        { env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" } },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
      contentItems: [
        {
          type: "inputText",
          text: "Datadog search_datadog_logs requires fixed, non-relative 'from' and 'to' values when using 'cursor'.",
        },
      ],
    });
  });

  it("queries Datadog metrics with encoded GET params and bounded series", async () => {
    const { executeDatadogQueryMetricsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");
    const pointlist = Array.from({ length: 120 }, (_, index) => [1_799_000_000 + index, index]);
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(href);
      expect(url.origin + url.pathname).toBe("https://api.us5.datadoghq.com/api/v1/query");
      expect(url.searchParams.get("query")).toBe("avg:system.cpu.user{service:api,env:prod}");
      expect(url.searchParams.get("from")).toBe("1799000000");
      expect(url.searchParams.get("to")).toBe("1799000600");
      expect(url.href).not.toContain("api-key");
      expect(url.href).not.toContain("app-key");
      expect((init?.headers as Record<string, string>)["DD-API-KEY"]).toBe("api-key");
      expect((init?.headers as Record<string, string>)["DD-APPLICATION-KEY"]).toBe("app-key");
      return new Response(
        JSON.stringify({
          status: "ok",
          series: [
            {
              metric: "system.cpu.user",
              display_name: "CPU user",
              scope: "env:prod,service:api",
              pointlist,
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await executeDatadogQueryMetricsDynamicToolCall(
      { query: "avg:system.cpu.user{service:api,env:prod}", from: 1_799_000_000, to: 1_799_000_600 },
      {
        env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as {
      queryLength: number;
      truncated: boolean;
      series: Array<{ metric: string; points: unknown[]; truncatedPoints: boolean }>;
    };
    expect(payload).not.toHaveProperty("query");
    expect(payload.queryLength).toBe("avg:system.cpu.user{service:api,env:prod}".length);
    expect(result.contentItems[0].text).not.toContain("service:api,env:prod");
    expect(payload.truncated).toBe(true);
    expect(payload.series[0]).toMatchObject({ metric: "system.cpu.user", truncatedPoints: true });
    expect(payload.series[0]?.points).toHaveLength(100);
  });

  it("lists Datadog monitors with filters and hasMore", async () => {
    const { executeDatadogGetMonitorsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(href);
      expect(url.origin + url.pathname).toBe("https://api.datadoghq.com/api/v1/monitor");
      expect(url.searchParams.get("name")).toBe("checkout");
      expect(url.searchParams.get("monitor_tags")).toBe("team:core,env:prod");
      expect(url.searchParams.has("tags")).toBe(false);
      expect(url.searchParams.get("group_states")).toBe("alert,warn");
      expect(url.searchParams.get("page")).toBe("0");
      expect(url.searchParams.get("page_size")).toBe("2");
      return new Response(
        JSON.stringify([
          { id: 1, name: "checkout latency", overall_state: "Alert", message: "x".repeat(600) },
          { id: 2, name: "checkout errors", overall_state: "Warn", message: "ok" },
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await executeDatadogGetMonitorsDynamicToolCall(
      { name: "checkout", tags: ["team:core", "env:prod"], groupStates: "alert,warn", limit: 1 },
      {
        env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "datadoghq.com" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as {
      hasMore: boolean;
      monitors: Array<{ id: number; messageExcerpt: string }>;
    };
    expect(payload.hasMore).toBe(true);
    expect(payload.monitors).toHaveLength(1);
    expect(payload.monitors[0]?.messageExcerpt).toContain("[truncated]");
  });

  it("rejects Datadog metric and monitor bounds", async () => {
    const { executeDatadogGetMonitorsDynamicToolCall, executeDatadogQueryMetricsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");
    const env = { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" };

    await expect(
      executeDatadogQueryMetricsDynamicToolCall({ query: "avg:system.cpu.user{*}", from: 10, to: 10 }, { env }),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_input" });
    await expect(
      executeDatadogQueryMetricsDynamicToolCall(
        { query: "avg:system.cpu.user{*}", from: 0, to: 16 * 24 * 60 * 60 },
        { env },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_input" });
    await expect(executeDatadogGetMonitorsDynamicToolCall({ limit: 26 }, { env })).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
  });

  it("redacts Datadog metric query text before persistence", async () => {
    const { redactFirstPartyDynamicToolInputForPersistence } =
      await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js");

    expect(
      redactFirstPartyDynamicToolInputForPersistence("datadog", "query_metrics", {
        query: "avg:system.cpu.user{customer:secret}",
        from: 1,
        to: 2,
      }),
    ).toEqual({ queryLength: 36, from: 1, to: 2 });
  });

  it("maps upstream Datadog failures for logs and traces", async () => {
    const { executeDatadogGetTraceDynamicToolCall, executeDatadogSearchLogsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");

    await expect(
      executeDatadogSearchLogsDynamicToolCall(
        { query: "service:api" },
        {
          env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" },
          fetchImpl: vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_credential" });

    await expect(
      executeDatadogSearchLogsDynamicToolCall(
        { query: "service:api" },
        {
          env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" },
          fetchImpl: vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "scope_missing" });

    await expect(
      executeDatadogGetTraceDynamicToolCall(
        { traceId: "abc123" },
        {
          env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" },
          fetchImpl: vi.fn(
            async () => new Response("slow down", { status: 429, headers: { "X-RateLimit-Period": "1" } }),
          ) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "upstream_rate_limited", retryAfterMs: 1_000 });

    await expect(
      executeDatadogGetTraceDynamicToolCall(
        { traceId: "abc123" },
        {
          env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" },
          fetchImpl: vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "upstream_error" });
  });

  it.each([
    ["caller abort", "AbortError"],
    ["request timeout", "TimeoutError"],
  ])("maps %s requests to cancelled", async (_label, errorName) => {
    const { executeDatadogSearchLogsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/datadog-dynamic-tool.js");
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeDatadogSearchLogsDynamicToolCall(
        { query: "service:api" },
        {
          env: { DD_API_KEY: "api-key", DD_APP_KEY: "app-key", DD_SITE: "us5.datadoghq.com" },
          signal: controller.signal,
          fetchImpl: vi.fn(async () => {
            throw new DOMException("Aborted", errorName);
          }) as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "cancelled",
      contentItems: [{ type: "inputText", text: "Datadog search_datadog_logs was cancelled." }],
    });
  });
});
