import { afterEach, describe, expect, it, vi } from "vitest";

describe("braintrust dynamic tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds specs only when Braintrust credentials are present", async () => {
    const { buildBraintrustQuerySqlDynamicToolSpec } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");

    expect(buildBraintrustQuerySqlDynamicToolSpec({})).toEqual([]);
    expect(buildBraintrustQuerySqlDynamicToolSpec({ BRAINTRUST_API_KEY: "observability-key" })).toEqual([]);
    expect(buildBraintrustQuerySqlDynamicToolSpec({ BRAINTRUST_INTEGRATION_API_KEY: "bt-key" })).toHaveLength(1);
    expect(
      buildBraintrustQuerySqlDynamicToolSpec({
        BRAINTRUST_INTEGRATION_API_KEY: "bt-key",
        BRAINTRUST_INTEGRATION_API_URL: "http://api.braintrust.dev",
      }),
    ).toEqual([]);
  });

  it("advertises all Braintrust tools when integration credentials are present", async () => {
    const { buildAllDynamicToolSpecs } =
      await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js");

    const toolNames = buildAllDynamicToolSpecs({ BRAINTRUST_INTEGRATION_API_KEY: "bt-key" })
      .filter((tool) => tool.namespace === "braintrust")
      .map((tool) => tool.name);

    expect(toolNames).toEqual([
      "list_projects",
      "query_sql",
      "summarize_experiment",
      "generate_permalink",
      "infer_schema",
    ]);
  });

  it("lists Braintrust projects via the REST API", async () => {
    const { executeBraintrustListProjectsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            objects: [
              {
                id: "project-1",
                name: "Cycloid",
                description: "prod traces",
                created: "2026-01-01T00:00:00Z",
                org_id: "org-1",
                settings: { hidden: true },
              },
            ],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeBraintrustListProjectsDynamicToolCall(
      { limit: 1 },
      {
        env: {
          BRAINTRUST_INTEGRATION_API_KEY: "bt-key",
          BRAINTRUST_INTEGRATION_API_URL: "https://api.braintrust.dev/",
        },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.braintrust.dev/v1/project?limit=1");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer bt-key",
    });
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      projects: [
        {
          id: "project-1",
          name: "Cycloid",
          description: "prod traces",
          created: "2026-01-01T00:00:00Z",
          org_id: "org-1",
        },
      ],
    });
  });

  it("queries Braintrust SQL via the /btql API", async () => {
    const { executeBraintrustQuerySqlDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "row-1", output: "ok" }], cursor: "next" }), {
          status: 200,
        }),
    ) as typeof fetch;

    const result = await executeBraintrustQuerySqlDynamicToolCall(
      { query: "SELECT id, output FROM project_logs('project-id') LIMIT 1" },
      {
        env: {
          BRAINTRUST_INTEGRATION_API_KEY: "bt-key",
          BRAINTRUST_INTEGRATION_API_URL: "https://api-eu.braintrust.dev/",
        },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api-eu.braintrust.dev/btql");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer bt-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}"))).toEqual({
      query: "SELECT id, output FROM project_logs('project-id') LIMIT 1",
      fmt: "json",
    });
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      data: [{ id: "row-1", output: "ok" }],
      cursor: "next",
    });
  });

  it("rejects non-read-only and malformed input", async () => {
    const { executeBraintrustQuerySqlDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");

    await expect(
      executeBraintrustQuerySqlDynamicToolCall(
        { query: "DELETE FROM project_logs('project-id')" },
        { env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" } },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_input" });

    await expect(
      executeBraintrustQuerySqlDynamicToolCall(
        { query: "SELECT 1", extra: true },
        { env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" } },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_input" });
  });

  it("maps upstream Braintrust failures", async () => {
    const { executeBraintrustQuerySqlDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");

    await expect(
      executeBraintrustQuerySqlDynamicToolCall(
        { query: "SELECT 1" },
        {
          env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" },
          fetchImpl: vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "scope_missing" });

    await expect(
      executeBraintrustQuerySqlDynamicToolCall(
        { query: "SELECT 1" },
        {
          env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" },
          fetchImpl: vi.fn(async () => new Response("slow down", { status: 429 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "upstream_rate_limited" });
  });

  it("maps request TimeoutError to cancelled", async () => {
    const { executeBraintrustQuerySqlDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");

    await expect(
      executeBraintrustQuerySqlDynamicToolCall(
        { query: "SELECT 1" },
        {
          env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" },
          fetchImpl: vi.fn(async () => {
            throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
          }) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "cancelled" });
  });

  it("includes Braintrust response details for invalid SQL", async () => {
    const { executeBraintrustQuerySqlDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");

    const result = await executeBraintrustQuerySqlDynamicToolCall(
      { query: "SELECT 1" },
      {
        env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" },
        fetchImpl: vi.fn(
          async () =>
            new Response(JSON.stringify({ error: "SQL query must include a Braintrust data source" }), {
              status: 400,
            }),
        ) as typeof fetch,
      },
    );

    expect(result).toMatchObject({ success: false, errorCode: "invalid_input" });
    expect(result.contentItems[0].text).toContain("SQL query must include a Braintrust data source");
  });

  it("summarizes Braintrust experiments via the REST API", async () => {
    const { executeBraintrustSummarizeExperimentDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            project_name: "Cycloid",
            experiment_name: "eval-1",
            experiment_url: "https://www.braintrust.dev/app/acme/p/Cycloid/experiments/eval-1",
            scores: { correctness: { score: 0.9, diff: 0.1 } },
            metrics: {},
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeBraintrustSummarizeExperimentDynamicToolCall(
      { experiment_id: "exp-1", summarize_scores: true, comparison_experiment_id: "base-1" },
      {
        env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.braintrust.dev/v1/experiment/exp-1/summarize?summarize_scores=true&comparison_experiment_id=base-1",
    );
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      experiment_name: "eval-1",
      scores: { correctness: { score: 0.9, diff: 0.1 } },
    });
  });

  it("does not forward comparison_experiment_id when summarize_scores is false", async () => {
    const { executeBraintrustSummarizeExperimentDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ experiment_name: "eval-1" }), { status: 200 }),
    ) as typeof fetch;

    const result = await executeBraintrustSummarizeExperimentDynamicToolCall(
      { experiment_id: "exp-1", summarize_scores: false, comparison_experiment_id: "base-1" },
      {
        env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.braintrust.dev/v1/experiment/exp-1/summarize?summarize_scores=false",
    );
  });

  it("generates experiment permalinks from Braintrust summary URLs", async () => {
    const { executeBraintrustGeneratePermalinkDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            experiment_url: "https://www.braintrust.dev/app/acme/p/Cycloid/experiments/eval-1",
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeBraintrustGeneratePermalinkDynamicToolCall(
      { object_type: "experiment", object_id: "exp-1" },
      {
        env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      objectType: "experiment",
      objectId: "exp-1",
      url: "https://www.braintrust.dev/app/acme/p/Cycloid/experiments/eval-1",
    });
  });

  it("describes project permalink inputs consistently with runtime validation", async () => {
    const { buildBraintrustGeneratePermalinkDynamicToolSpec, executeBraintrustGeneratePermalinkDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");

    const spec = buildBraintrustGeneratePermalinkDynamicToolSpec({ BRAINTRUST_INTEGRATION_API_KEY: "bt-key" })[0];
    expect(spec?.inputSchema.properties?.org_name).toMatchObject({
      description: "Required with project_name for project links.",
    });

    await expect(
      executeBraintrustGeneratePermalinkDynamicToolCall(
        { object_type: "project", object_id: "project-1", project_name: "Cycloid" },
        { env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" } },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_input" });
  });

  it("generates project permalinks from org and project names", async () => {
    const { executeBraintrustGeneratePermalinkDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");

    const result = await executeBraintrustGeneratePermalinkDynamicToolCall(
      {
        object_type: "project",
        object_id: "project-1",
        org_name: "acme labs",
        project_name: "Cycloid Eval",
        app_url: "https://braintrust.example.com/api/v1",
      },
      { env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" } },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      objectType: "project",
      objectId: "project-1",
      url: "https://braintrust.example.com/app/acme%20labs/p/Cycloid%20Eval",
    });
  });

  it("infers schema from sampled Braintrust SQL rows", async () => {
    const { executeBraintrustInferSchemaDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "row-1", metadata: { model: "gpt-5" }, scores: { quality: 0.9 } },
              { id: "row-2", metadata: { model: "gpt-5" }, scores: { quality: 0.8 } },
            ],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeBraintrustInferSchemaDynamicToolCall(
      { source_type: "project_logs", object_id: "project-1", shape: "traces", days: 3, sample_limit: 2 },
      {
        env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")).query).toBe(
      "SELECT * FROM project_logs('project-1', shape => 'traces') WHERE created > now() - interval 3 day LIMIT 2",
    );
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      sampleRows: 2,
      fields: expect.arrayContaining([
        expect.objectContaining({ path: "metadata.model", types: ["string"] }),
        expect.objectContaining({ path: "scores.quality", types: ["number"] }),
      ]),
    });
  });

  it("rejects infer_schema options that would be ignored or alter generated SQL bounds", async () => {
    const { executeBraintrustInferSchemaDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");

    await expect(
      executeBraintrustInferSchemaDynamicToolCall(
        { source_type: "experiment", object_id: "exp-1", shape: "traces" },
        { env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" } },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_input" });

    await expect(
      executeBraintrustInferSchemaDynamicToolCall(
        { source_type: "project_logs", object_id: "project-1", where: "1=1 -- " },
        { env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" } },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_input" });

    await expect(
      executeBraintrustInferSchemaDynamicToolCall(
        { source_type: "project_logs", object_id: "project-1", where: "1=1) /* */ UNION SELECT 1" },
        { env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" } },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "invalid_input" });
  });

  it("caps large inferred schema output", async () => {
    const { executeBraintrustInferSchemaDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/braintrust-dynamic-tool.js");
    const wideRow = Object.fromEntries(Array.from({ length: 1_500 }, (_, index) => [`field_${index}`, "x"]));
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [wideRow],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeBraintrustInferSchemaDynamicToolCall(
      { source_type: "dataset", object_id: "dataset-1", sample_limit: 1 },
      {
        env: { BRAINTRUST_INTEGRATION_API_KEY: "bt-key" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    expect(result.contentItems[0].text.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.contentItems[0].text).toContain("[truncated]");
  });

  it("redacts Braintrust inputs before persistence", async () => {
    const { redactFirstPartyDynamicToolInputForPersistence } =
      await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js");
    const query = "SELECT * FROM project_logs('project-id') WHERE input = 'secret patient id'";

    const redactedQuery = redactFirstPartyDynamicToolInputForPersistence("braintrust", "query_sql", {
      query,
    });
    const redactedList = redactFirstPartyDynamicToolInputForPersistence("braintrust", "list_projects", {
      limit: 10,
    });
    const redactedSummary = redactFirstPartyDynamicToolInputForPersistence("braintrust", "summarize_experiment", {
      experiment_id: "exp-1",
      summarize_scores: false,
      comparison_experiment_id: "base-1",
    });

    expect(redactedQuery).toEqual({ queryLength: query.length, queryRedacted: true });
    expect(JSON.stringify(redactedQuery)).not.toContain("secret patient id");
    expect(redactedList).toEqual({ limit: 10, queryRedacted: true });
    expect(redactedSummary).toEqual({
      experimentId: "exp-1",
      summarizeScores: false,
      comparisonExperimentId: "base-1",
      inputRedacted: true,
    });
  });
});
