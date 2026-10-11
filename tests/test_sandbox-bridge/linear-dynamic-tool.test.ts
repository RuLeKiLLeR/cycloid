import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("linear dynamic tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.OWNER_USER_ID;
    delete process.env.SESSION_ID;
  });

  it("advertises Linear only through the loaded tool registry when credentials are present", async () => {
    const {
      buildAllDynamicToolSpecs,
      executeFirstPartyDynamicToolCall,
      getFirstPartyDynamicToolPlanMode,
      redactFirstPartyDynamicToolInputForPersistence,
    } = await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js");

    expect(buildAllDynamicToolSpecs({}).map((tool) => `${tool.namespace}.${tool.name}`)).not.toContain(
      "linear.create_issue",
    );

    const specs = buildAllDynamicToolSpecs({ LINEAR_ACCESS_TOKEN: "linear-token" });
    expect(specs.map((tool) => `${tool.namespace}.${tool.name}`)).toEqual(
      expect.arrayContaining([
        "linear.create_issue",
        "linear.get_issue",
        "linear.list_issue_statuses",
        "linear.update_issue",
        "linear.list_comments",
        "linear.create_comment",
        "linear.search_issues",
      ]),
    );
    expect(specs.filter((tool) => tool.namespace === "linear" && tool.name === "create_issue")).toHaveLength(1);
    expect(
      specs.find((tool) => tool.namespace === "linear" && tool.name === "create_issue")?.inputSchema,
    ).toMatchObject({
      required: ["teamId", "title"],
      properties: {
        teamId: { type: "string" },
        title: { type: "string" },
        priority: { type: "integer", minimum: 0, maximum: 4 },
      },
    });
    expect(specs.find((tool) => tool.namespace === "linear" && tool.name === "get_issue")?.inputSchema).toMatchObject({
      oneOf: [{ required: ["id"] }, { required: ["identifier"] }],
    });

    expect(getFirstPartyDynamicToolPlanMode("linear.create_issue")).toBe("sideEffecting");
    expect(
      redactFirstPartyDynamicToolInputForPersistence("linear", "search_issues", {
        query: "customer secret",
      }),
    ).toEqual({ queryLength: 15, queryRedacted: true });
    await expect(
      executeFirstPartyDynamicToolCall(
        "linear",
        "create_issue",
        { teamId: "team-1" },
        { env: { LINEAR_ACCESS_TOKEN: "linear-token" } },
      ),
    ).resolves.toMatchObject({
      success: false,
      errorCode: "invalid_input",
    });
  });

  it("creates a Linear issue and returns summarized metadata", async () => {
    const { buildLinearCreateIssueDynamicToolSpec, executeLinearCreateIssueDynamicToolCall } =
      await import("../../tools/linear/client.js");
    expect(buildLinearCreateIssueDynamicToolSpec({})).toEqual([]);
    expect(
      buildLinearCreateIssueDynamicToolSpec({ LINEAR_ACCESS_TOKEN: "linear-token" })[0]?.inputSchema,
    ).toMatchObject({
      required: ["teamId", "title"],
      properties: {
        teamId: { type: "string" },
        title: { type: "string" },
        priority: { type: "integer", minimum: 0, maximum: 4 },
      },
    });

    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: "issue-1",
                  identifier: "ENG-123",
                  title: "Track follow-up",
                  description: "Create the ticket and continue.",
                  priority: 2,
                  url: "https://linear.app/acme/issue/ENG-123/track-follow-up",
                  state: { id: "state-1", name: "Todo" },
                  assignee: { id: "user-1", name: "Jane" },
                  team: { id: "team-1", key: "ENG" },
                },
              },
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeLinearCreateIssueDynamicToolCall(
      {
        teamId: "team-1",
        title: " Track follow-up ",
        description: " Create the ticket and continue. ",
        priority: 2,
        stateId: "state-1",
        assigneeId: "user-1",
      },
      { env: { LINEAR_ACCESS_TOKEN: "linear-token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Track follow-up",
      state: { id: "state-1", name: "Todo" },
      assignee: { id: "user-1", name: "Jane" },
      priority: 2,
      team: { id: "team-1", key: "ENG" },
      url: "https://linear.app/acme/issue/ENG-123/track-follow-up",
      description: "Create the ticket and continue.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.linear.app/graphql");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain("mutation LinearCreateIssue($input: IssueCreateInput!)");
    expect(body.query).toContain("issueCreate(input: $input)");
    expect(body.variables).toEqual({
      input: {
        teamId: "team-1",
        title: "Track follow-up",
        description: "Create the ticket and continue.",
        priority: 2,
        stateId: "state-1",
        assigneeId: "user-1",
      },
    });
  });

  it("captures the created identifier into the session so the PR title carries it", async () => {
    const { executeLinearCreateIssueDynamicToolCall } = await import("../../tools/linear/client.js");

    const fetchImpl = vi.fn(async (url: string) =>
      String(url).endsWith("/ticket-key")
        ? new Response(JSON.stringify({ ok: true, outcome: "set" }), { status: 200 })
        : new Response(
            JSON.stringify({
              data: {
                issueCreate: {
                  success: true,
                  issue: { id: "issue-1", identifier: "ENG-123", team: { id: "team-1", key: "ENG" } },
                },
              },
            }),
            { status: 200 },
          ),
    ) as unknown as typeof fetch;

    const result = await executeLinearCreateIssueDynamicToolCall(
      { teamId: "team-1", title: "Track follow-up" },
      {
        env: {
          LINEAR_ACCESS_TOKEN: "linear-token",
          CONTROL_PLANE_URL: "https://cp.example.com",
          SESSION_ID: "sess-1",
          SANDBOX_AUTH_TOKEN: "tok-1",
        },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    const ticketCall = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.find(([u]) =>
      String(u).endsWith("/ticket-key"),
    ) as [string, RequestInit] | undefined;
    expect(ticketCall?.[0]).toBe("https://cp.example.com/api/sessions/sess-1/ticket-key");
    expect(JSON.parse(String(ticketCall?.[1].body))).toEqual({ ticketKey: "ENG-123" });
  });

  it("rejects invalid create_issue input", async () => {
    const { executeLinearCreateIssueDynamicToolCall } = await import("../../tools/linear/client.js");

    await expect(
      executeLinearCreateIssueDynamicToolCall({}, { env: { LINEAR_ACCESS_TOKEN: "linear-token" } }),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear create_issue requires a non-empty 'teamId' string." }],
    });

    await expect(
      executeLinearCreateIssueDynamicToolCall(
        { teamId: "team-1", title: "Title", extra: true },
        { env: { LINEAR_ACCESS_TOKEN: "linear-token" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear create_issue received unsupported fields: extra." }],
    });

    await expect(
      executeLinearCreateIssueDynamicToolCall(
        { teamId: "team-1", title: "Title", priority: Number.NaN },
        { env: { LINEAR_ACCESS_TOKEN: "linear-token" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear create_issue 'priority' must be a finite number." }],
    });

    await expect(
      executeLinearCreateIssueDynamicToolCall(
        { teamId: "team-1", title: "Title", priority: 2.5 },
        { env: { LINEAR_ACCESS_TOKEN: "linear-token" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear create_issue 'priority' must be an integer between 0 and 4." }],
    });

    await expect(
      executeLinearCreateIssueDynamicToolCall(
        { teamId: "team-1", title: "Title", priority: 5 },
        { env: { LINEAR_ACCESS_TOKEN: "linear-token" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear create_issue 'priority' must be an integer between 0 and 4." }],
    });

    await expect(
      executeLinearCreateIssueDynamicToolCall(
        { teamId: "team-1", title: "Title", stateId: 123 },
        { env: { LINEAR_ACCESS_TOKEN: "linear-token" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear create_issue 'stateId' must be a non-empty string." }],
    });

    await expect(
      executeLinearCreateIssueDynamicToolCall(
        { teamId: "team-1", title: "Title", assigneeId: "" },
        { env: { LINEAR_ACCESS_TOKEN: "linear-token" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear create_issue 'assigneeId' must be a non-empty string." }],
    });
  });

  it("updates a Linear issue and returns summarized metadata", async () => {
    const { buildLinearUpdateIssueDynamicToolSpec, executeLinearUpdateIssueDynamicToolCall } =
      await import("../../tools/linear/client.js");

    expect(buildLinearUpdateIssueDynamicToolSpec({})).toEqual([]);
    expect(
      buildLinearUpdateIssueDynamicToolSpec({ LINEAR_ACCESS_TOKEN: "linear-token" })[0]?.inputSchema,
    ).toMatchObject({
      required: ["issueId"],
      properties: {
        issueId: { type: "string" },
        priority: { type: "integer", minimum: 0, maximum: 4 },
      },
    });

    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              issueUpdate: {
                success: true,
                issue: {
                  id: "issue-1",
                  identifier: "ENG-123",
                  title: "Updated follow-up",
                  description: "Refined plan for the next step.",
                  priority: 1,
                  url: "https://linear.app/acme/issue/ENG-123/updated-follow-up",
                  state: { id: "state-2", name: "Done" },
                  assignee: { id: "user-2", name: "Avery" },
                  team: { id: "team-1", key: "ENG" },
                },
              },
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeLinearUpdateIssueDynamicToolCall(
      {
        issueId: "issue-1",
        title: " Updated follow-up ",
        description: " Refined plan for the next step. ",
        priority: 1,
        stateId: "state-2",
        assigneeId: "user-2",
      },
      { env: { LINEAR_ACCESS_TOKEN: "linear-token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Updated follow-up",
      state: { id: "state-2", name: "Done" },
      assignee: { id: "user-2", name: "Avery" },
      priority: 1,
      team: { id: "team-1", key: "ENG" },
      url: "https://linear.app/acme/issue/ENG-123/updated-follow-up",
      description: "Refined plan for the next step.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain("mutation LinearUpdateIssue($issueId: String!, $input: IssueUpdateInput!)");
    expect(body.query).toContain("issueUpdate(id: $issueId, input: $input)");
    expect(body.variables).toEqual({
      issueId: "issue-1",
      input: {
        title: "Updated follow-up",
        description: "Refined plan for the next step.",
        priority: 1,
        stateId: "state-2",
        assigneeId: "user-2",
      },
    });
  });

  it("updates only the workflow state for a Linear issue", async () => {
    const { executeLinearUpdateIssueDynamicToolCall } = await import("../../tools/linear/client.js");

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              issueUpdate: {
                success: true,
                issue: {
                  id: "issue-1",
                  identifier: "ENG-123",
                  title: "Updated follow-up",
                  state: { id: "state-2", name: "Done" },
                },
              },
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeLinearUpdateIssueDynamicToolCall(
      { issueId: "issue-1", stateId: "state-2" },
      { env: { LINEAR_ACCESS_TOKEN: "linear-token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables).toEqual({
      issueId: "issue-1",
      input: { stateId: "state-2" },
    });
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Updated follow-up",
      state: { id: "state-2", name: "Done" },
      assignee: null,
      priority: null,
      team: { id: null, key: null },
      url: null,
      description: null,
    });
  });

  it("rejects invalid update_issue input", async () => {
    const { executeLinearUpdateIssueDynamicToolCall } = await import("../../tools/linear/client.js");

    await expect(
      executeLinearUpdateIssueDynamicToolCall({}, { env: { LINEAR_ACCESS_TOKEN: "linear-token" } }),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear update_issue requires a non-empty 'issueId' string." }],
    });

    await expect(
      executeLinearUpdateIssueDynamicToolCall(
        { issueId: "issue-1", extra: true },
        { env: { LINEAR_ACCESS_TOKEN: "linear-token" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear update_issue received unsupported fields: extra." }],
    });

    await expect(
      executeLinearUpdateIssueDynamicToolCall(
        { issueId: "issue-1", title: "Still update title", description: "   " },
        { env: { LINEAR_ACCESS_TOKEN: "linear-token" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear update_issue 'description' must be a non-empty string." }],
    });
  });

  it("redacts create_issue input before persistence", async () => {
    const { redactFirstPartyDynamicToolInputForPersistence } =
      await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js");

    const redacted = redactFirstPartyDynamicToolInputForPersistence("linear", "create_issue", {
      teamId: "team-1",
      title: "Sensitive customer problem",
      description: "Contains customer secrets",
      priority: 2,
      stateId: "state-1",
      assigneeId: "user-1",
    });

    expect(redacted).toEqual({
      teamId: "team-1",
      stateId: "state-1",
      assigneeId: "user-1",
      priority: 2,
      titleLength: 26,
      descriptionLength: 25,
      titleRedacted: true,
      descriptionRedacted: true,
    });
    expect(JSON.stringify(redacted)).not.toContain("Sensitive customer problem");
    expect(JSON.stringify(redacted)).not.toContain("Contains customer secrets");
  });

  it("lists Linear comments with pagination metadata and truncates large bodies", async () => {
    const { executeLinearListCommentsDynamicToolCall } = await import("../../tools/linear/client.js");
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              issue: {
                comments: {
                  nodes: [
                    {
                      id: "comment-1",
                      body: "x".repeat(2500),
                      createdAt: "2026-07-05T12:00:00Z",
                      user: { id: "user-1", displayName: "Jane" },
                    },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
                },
              },
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeLinearListCommentsDynamicToolCall(
      { issueId: "issue-1", cursor: "cursor-1", limit: 10 },
      { env: { LINEAR_ACCESS_TOKEN: "linear-token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as {
      nextCursor: string;
      truncated: boolean;
      comments: Array<{ body: string; author: { name: string } }>;
    };
    expect(payload.nextCursor).toBe("cursor-2");
    expect(payload.truncated).toBe(true);
    expect(payload.comments[0]?.body).toContain("[truncated]");
    expect(payload.comments[0]?.author.name).toBe("Jane");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables).toEqual({ issueId: "issue-1", first: 10, cursor: "cursor-1" });
  });

  it("does not treat user-authored truncation marker text as Linear comment truncation", async () => {
    const { executeLinearListCommentsDynamicToolCall } = await import("../../tools/linear/client.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              issue: {
                comments: {
                  nodes: [
                    {
                      id: "comment-1",
                      body: "User wrote [truncated] literally.",
                      createdAt: "2026-07-05T12:00:00Z",
                      user: { id: "user-1", displayName: "Jane" },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeLinearListCommentsDynamicToolCall(
      { issueId: "issue-1" },
      { env: { LINEAR_ACCESS_TOKEN: "linear-token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as {
      truncated: boolean;
      comments: Array<{ body: string; truncated: boolean }>;
    };
    expect(payload.truncated).toBe(false);
    expect(payload.comments[0]).toMatchObject({ body: "User wrote [truncated] literally.", truncated: false });
  });

  it("creates a Linear comment and redacts body persistence", async () => {
    const { executeLinearCreateCommentDynamicToolCall } = await import("../../tools/linear/client.js");
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              commentCreate: {
                success: true,
                comment: {
                  id: "comment-1",
                  body: "Posted update",
                  createdAt: "2026-07-05T12:00:00Z",
                  user: { id: "user-1", name: "Jane" },
                },
              },
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeLinearCreateCommentDynamicToolCall(
      { issueId: "issue-1", body: "Posted update" },
      { env: { LINEAR_ACCESS_TOKEN: "linear-token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      issueId: "issue-1",
      comment: { id: "comment-1", body: "Posted update" },
    });
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      query: string;
      variables: { input: Record<string, unknown> };
    };
    expect(requestBody.query).toContain("commentCreate(input: $input)");
    expect(requestBody.variables.input).toEqual({ issueId: "issue-1", body: "Posted update" });

    const { redactFirstPartyDynamicToolInputForPersistence } =
      await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js");
    const redacted = redactFirstPartyDynamicToolInputForPersistence("linear", "create_comment", {
      issueId: "issue-1",
      body: "Contains customer secrets",
    });
    expect(redacted).toEqual({ bodyLength: 25, bodyRedacted: true });
    expect(JSON.stringify(redacted)).not.toContain("Contains customer secrets");
  });

  it("returns unknown-posted guidance when Linear comment creation times out", async () => {
    const { executeLinearCreateCommentDynamicToolCall } = await import("../../tools/linear/client.js");

    await expect(
      executeLinearCreateCommentDynamicToolCall(
        { issueId: "issue-1", body: "Posted update" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(async () => {
            throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
          }) as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "upstream_error",
      contentItems: [
        {
          type: "inputText",
          text: "Linear create_comment timed out after sending the request; it is unknown whether the comment was posted. Do not blindly retry. Read the issue comments first.",
        },
      ],
    });
  });

  it("searches Linear issues with term and structured filters", async () => {
    const { executeLinearSearchIssuesDynamicToolCall } = await import("../../tools/linear/client.js");
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              searchIssues: {
                nodes: [
                  {
                    id: "issue-1",
                    identifier: "ENG-123",
                    title: "Fix checkout",
                    priority: 2,
                    team: { id: "team-1", key: "ENG" },
                    state: { id: "state-1", name: "Todo" },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await executeLinearSearchIssuesDynamicToolCall(
      { query: "checkout", teamId: "team-1", stateType: "started", includeArchived: true, limit: 5 },
      { env: { LINEAR_ACCESS_TOKEN: "linear-token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      query: "checkout",
      includeArchived: true,
      issues: [{ id: "issue-1", identifier: "ENG-123", title: "Fix checkout" }],
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      variables: Record<string, unknown>;
    };
    expect(body.variables).toEqual({
      term: "checkout",
      first: 5,
      includeArchived: true,
      filter: {
        team: { id: { eq: "team-1" } },
        state: { type: { eq: "started" } },
      },
    });
  });

  it("maps create_issue upstream failures", async () => {
    const { executeLinearCreateIssueDynamicToolCall } = await import("../../tools/linear/client.js");
    const input = { teamId: "team-1", title: "Track follow-up" };

    await expect(executeLinearCreateIssueDynamicToolCall(input, { env: {} })).resolves.toMatchObject({
      success: false,
      errorCode: "not_connected",
    });

    await expect(
      executeLinearCreateIssueDynamicToolCall(input, {
        env: { LINEAR_ACCESS_TOKEN: "linear-token" },
        fetchImpl: vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
      }),
    ).resolves.toMatchObject({ success: false, errorCode: "token_expired" });

    await expect(
      executeLinearCreateIssueDynamicToolCall(input, {
        env: { LINEAR_ACCESS_TOKEN: "linear-token" },
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: {
                  issueCreate: {
                    success: false,
                    issue: null,
                  },
                },
              }),
              { status: 200 },
            ),
        ) as typeof fetch,
      }),
    ).resolves.toMatchObject({ success: false, errorCode: "upstream_error" });
  });

  it("gets a Linear issue by identifier and truncates long descriptions", async () => {
    const { executeLinearGetIssueDynamicToolCall } = await import("../../tools/linear/client.js");
    const result = await executeLinearGetIssueDynamicToolCall(
      { identifier: "ENG-123" },
      {
        env: { LINEAR_ACCESS_TOKEN: "linear-token" },
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: {
                  issue: {
                    id: "issue-1",
                    identifier: "ENG-123",
                    title: "Fix Linear bridge",
                    description: "x".repeat(5000),
                    priority: 2,
                    url: "https://linear.app/acme/issue/ENG-123/fix-linear-bridge",
                    state: { id: "state-1", name: "In Progress" },
                    assignee: { id: "user-1", name: "Jane" },
                    team: { id: "team-1", key: "ENG" },
                  },
                },
              }),
              { status: 200 },
            ),
        ) as typeof fetch,
      },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as { identifier: string; description: string };
    expect(payload.identifier).toBe("ENG-123");
    expect(payload.description).toContain("[truncated]");
  });

  it("preserves null optional fields in issue summaries", async () => {
    const { executeLinearGetIssueDynamicToolCall } = await import("../../tools/linear/client.js");
    const result = await executeLinearGetIssueDynamicToolCall(
      { id: "issue-1" },
      {
        env: { LINEAR_ACCESS_TOKEN: "linear-token" },
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                data: {
                  issue: {
                    id: "issue-1",
                    identifier: "ENG-123",
                    title: "Fix Linear bridge",
                  },
                },
              }),
              { status: 200 },
            ),
        ) as typeof fetch,
      },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      id: "issue-1",
      identifier: "ENG-123",
      title: "Fix Linear bridge",
      state: { id: null, name: null },
      assignee: null,
      priority: null,
      team: { id: null, key: null },
      url: null,
      description: null,
    });
  });

  it("rejects invalid get_issue input and unknown fields", async () => {
    const { buildLinearGetIssueDynamicToolSpec, executeLinearGetIssueDynamicToolCall } =
      await import("../../tools/linear/client.js");

    expect(buildLinearGetIssueDynamicToolSpec({ LINEAR_ACCESS_TOKEN: "linear-token" })[0]?.inputSchema).toMatchObject({
      oneOf: [{ required: ["id"] }, { required: ["identifier"] }],
    });

    await expect(
      executeLinearGetIssueDynamicToolCall(
        { id: "ENG-1", identifier: "ENG-1", extra: true },
        { env: { LINEAR_ACCESS_TOKEN: "linear-token" } },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Linear get_issue received unsupported fields: extra." }],
    });
  });

  it("maps upstream auth and server failures for get_issue", async () => {
    const { executeLinearGetIssueDynamicToolCall } = await import("../../tools/linear/client.js");

    await expect(
      executeLinearGetIssueDynamicToolCall(
        { id: "ENG-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "token_expired" });

    await expect(
      executeLinearGetIssueDynamicToolCall(
        { id: "ENG-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "scope_missing" });

    await expect(
      executeLinearGetIssueDynamicToolCall(
        { id: "ENG-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(async () => new Response("missing", { status: 404 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "not_found" });

    await expect(
      executeLinearGetIssueDynamicToolCall(
        { id: "ENG-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "upstream_error" });
  });

  it("maps request TimeoutError to cancelled", async () => {
    const { executeLinearGetIssueDynamicToolCall } = await import("../../tools/linear/client.js");

    await expect(
      executeLinearGetIssueDynamicToolCall(
        { id: "issue-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(async () => {
            throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
          }) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "cancelled" });
  });

  it("lists team statuses with a server-side team filter", async () => {
    const { executeLinearListIssueStatusesDynamicToolCall } = await import("../../tools/linear/client.js");
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              team: {
                states: {
                  nodes: [
                    { id: "state-2", name: "Done", type: "completed", position: 2 },
                    { id: "state-1", name: "Todo", type: "unstarted", position: 1 },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    const result = await executeLinearListIssueStatusesDynamicToolCall(
      { teamId: "team-1" },
      {
        env: { LINEAR_ACCESS_TOKEN: "linear-token" },
        fetchImpl,
      },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      teamId: "team-1",
      statuses: [
        { id: "state-1", name: "Todo", type: "unstarted", position: 1 },
        { id: "state-2", name: "Done", type: "completed", position: 2 },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}")) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain("team(id: $teamId)");
    expect(body.query).toContain("states(first: 250)");
    expect(body.query).toContain("query LinearWorkflowStates($teamId: String!)");
    expect(body.query).not.toContain("workflowStates(");
    expect(body.query).not.toContain("filter: { team:");
    expect(body.variables).toEqual({ teamId: "team-1" });
  });

  it("maps list_issue_statuses auth and upstream failures", async () => {
    const { executeLinearListIssueStatusesDynamicToolCall } = await import("../../tools/linear/client.js");

    await expect(
      executeLinearListIssueStatusesDynamicToolCall(
        { teamId: "team-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "token_expired" });

    await expect(
      executeLinearListIssueStatusesDynamicToolCall(
        { teamId: "team-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "scope_missing" });

    await expect(
      executeLinearListIssueStatusesDynamicToolCall(
        { teamId: "team-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(async () => new Response("missing", { status: 404 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "not_found" });

    await expect(
      executeLinearListIssueStatusesDynamicToolCall(
        { teamId: "team-1" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "upstream_error" });
  });

  it("returns not_found when Linear returns a null team", async () => {
    const { executeLinearListIssueStatusesDynamicToolCall } = await import("../../tools/linear/client.js");

    await expect(
      executeLinearListIssueStatusesDynamicToolCall(
        { teamId: "team-missing" },
        {
          env: { LINEAR_ACCESS_TOKEN: "linear-token" },
          fetchImpl: vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  data: {
                    team: null,
                  },
                }),
                { status: 200 },
              ),
          ) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "not_found" });
  });
});
