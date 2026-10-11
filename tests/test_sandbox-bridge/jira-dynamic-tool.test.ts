import { beforeEach, describe, expect, it, vi } from "vitest";

const JIRA_ENV = {
  JIRA_ACCESS_TOKEN: "jira-token",
  JIRA_CLOUD_ID: "cloud-1",
  JIRA_SITE_URL: "https://acme.atlassian.net",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("jira dynamic tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("builds specs only when both token and cloud ID are present", async () => {
    const { buildJiraCreateIssueDynamicToolSpec, buildJiraGetIssueDynamicToolSpec } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    expect(buildJiraCreateIssueDynamicToolSpec({})).toEqual([]);
    expect(buildJiraCreateIssueDynamicToolSpec({ JIRA_ACCESS_TOKEN: "jira-token" })).toEqual([]);
    expect(buildJiraCreateIssueDynamicToolSpec({ JIRA_CLOUD_ID: "cloud-1" })).toEqual([]);

    const specs = buildJiraCreateIssueDynamicToolSpec(JIRA_ENV);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      namespace: "jira",
      name: "create_issue",
      inputSchema: { required: ["projectKey", "summary"] },
    });
    expect(buildJiraGetIssueDynamicToolSpec(JIRA_ENV)[0]?.inputSchema).toMatchObject({ required: ["keyOrId"] });
  });

  it("names the session trigger label in the create_issue labels description", async () => {
    const { buildJiraCreateIssueDynamicToolSpec } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");

    const labelsDescription = (env: Record<string, string>) =>
      (
        buildJiraCreateIssueDynamicToolSpec(env)[0]?.inputSchema as {
          properties: { labels: { description: string } };
        }
      ).properties.labels.description;

    expect(labelsDescription({ ...JIRA_ENV, JIRA_TRIGGER_LABEL: "deploy-bot" })).toContain('"deploy-bot"');
    expect(labelsDescription(JIRA_ENV)).toContain('"cycloid"');
  });

  it("creates a Jira issue with an ADF-wrapped description and returns the browse URL", async () => {
    const { executeJiraCreateIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");

    const fetchImpl = vi.fn(async () => jsonResponse({ id: "10001", key: "ENG-7" }, 201)) as typeof fetch;

    const result = await executeJiraCreateIssueDynamicToolCall(
      {
        projectKey: "ENG",
        summary: " Track follow-up ",
        description: "First paragraph.\n\nSecond paragraph.\nWith a second line.",
        labels: ["follow-up"],
      },
      { env: JIRA_ENV, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      id: "10001",
      key: "ENG-7",
      url: "https://acme.atlassian.net/browse/ENG-7",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue");
    const body = JSON.parse(String(init.body)) as {
      fields: {
        project: { key: string };
        summary: string;
        issuetype: { name: string };
        labels: string[];
        description: { type: string; version: number; content: Array<{ type: string; content: unknown[] }> };
      };
    };
    expect(body.fields.project.key).toBe("ENG");
    expect(body.fields.summary).toBe("Track follow-up");
    expect(body.fields.issuetype.name).toBe("Task");
    expect(body.fields.labels).toEqual(["follow-up"]);
    expect(body.fields.description.type).toBe("doc");
    expect(body.fields.description.version).toBe(1);
    expect(body.fields.description.content).toHaveLength(2);
    expect(body.fields.description.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "First paragraph." }],
    });
    expect(body.fields.description.content[1]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "Second paragraph." },
        { type: "hardBreak" },
        { type: "text", text: "With a second line." },
      ],
    });
  });

  const CP_ENV = {
    ...JIRA_ENV,
    CONTROL_PLANE_URL: "https://cp.example.com",
    SESSION_ID: "sess-1",
    SANDBOX_AUTH_TOKEN: "tok-1",
  };

  it("captures the created key into the session so the PR title carries it", async () => {
    const { executeJiraCreateIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return url.endsWith("/ticket-key")
        ? jsonResponse({ ok: true, outcome: "set" }, 200)
        : jsonResponse({ id: "10001", key: "ENG-7" }, 201);
    }) as unknown as typeof fetch;

    const result = await executeJiraCreateIssueDynamicToolCall(
      { projectKey: "ENG", summary: "Track follow-up", issueType: "Task" },
      { env: CP_ENV, fetchImpl },
    );

    expect(result.success).toBe(true);
    const ticketCall = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.find(([u]) =>
      String(u).endsWith("/ticket-key"),
    ) as [string, RequestInit] | undefined;
    expect(ticketCall?.[0]).toBe("https://cp.example.com/api/sessions/sess-1/ticket-key");
    expect(JSON.parse(String(ticketCall?.[1].body))).toEqual({ ticketKey: "ENG-7" });
  });

  it("still returns the created issue when the ticket-key capture fails", async () => {
    const { executeJiraCreateIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");

    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/ticket-key") ? jsonResponse({ ok: false }, 400) : jsonResponse({ id: "10001", key: "ENG-7" }, 201),
    ) as unknown as typeof fetch;

    const result = await executeJiraCreateIssueDynamicToolCall(
      { projectKey: "ENG", summary: "Track follow-up", issueType: "Task" },
      { env: CP_ENV, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ key: "ENG-7" });
  });

  it("strips the trigger label from create_issue and reports it in the payload", async () => {
    const { executeJiraCreateIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "10002", key: "ENG-8" }, 201)) as typeof fetch;

    const result = await executeJiraCreateIssueDynamicToolCall(
      { projectKey: "ENG", summary: "Cascade attempt", labels: ["release-blocker", "release"] },
      { env: { ...JIRA_ENV, JIRA_TRIGGER_LABEL: "release" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ key: "ENG-8", strippedLabels: ["release"] });
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).fields.labels).toEqual(["release-blocker"]);
  });

  it("strips the trigger label case-insensitively and with a padded env value", async () => {
    const { executeJiraCreateIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "10003", key: "ENG-9" }, 201)) as typeof fetch;

    const result = await executeJiraCreateIssueDynamicToolCall(
      { projectKey: "ENG", summary: "Cascade attempt", labels: ["Release", "other"] },
      { env: { ...JIRA_ENV, JIRA_TRIGGER_LABEL: " release " }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ strippedLabels: ["Release"] });
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).fields.labels).toEqual(["other"]);
  });

  it("omits labels entirely when every label is stripped", async () => {
    const { executeJiraCreateIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "10004", key: "ENG-10" }, 201)) as typeof fetch;

    const result = await executeJiraCreateIssueDynamicToolCall(
      { projectKey: "ENG", summary: "Cascade attempt", labels: ["release"] },
      { env: { ...JIRA_ENV, JIRA_TRIGGER_LABEL: "release" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ strippedLabels: ["release"] });
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).fields).not.toHaveProperty("labels");
  });

  it("falls back to the default trigger label when the env var is missing", async () => {
    const { executeJiraCreateIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "10005", key: "ENG-11" }, 201)) as typeof fetch;

    const result = await executeJiraCreateIssueDynamicToolCall(
      { projectKey: "ENG", summary: "Cascade attempt", labels: ["Cycloid", "other"] },
      { env: JIRA_ENV, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({ strippedLabels: ["Cycloid"] });
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).fields.labels).toEqual(["other"]);
  });

  it("leaves non-trigger labels untouched and omits strippedLabels from the payload", async () => {
    const { executeJiraCreateIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "10006", key: "ENG-12" }, 201)) as typeof fetch;

    const result = await executeJiraCreateIssueDynamicToolCall(
      { projectKey: "ENG", summary: "Normal issue", labels: ["bug", "p1"] },
      { env: JIRA_ENV, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).not.toHaveProperty("strippedLabels");
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).fields.labels).toEqual(["bug", "p1"]);
  });

  it("rejects invalid create_issue input without calling Jira", async () => {
    const { executeJiraCreateIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn() as typeof fetch;

    for (const args of [
      null,
      {},
      { projectKey: "ENG" },
      { projectKey: "ENG", summary: "x", unexpected: true },
      { projectKey: "ENG", summary: "x", labels: ["ok", ""] },
      { projectKey: "ENG", summary: "x", issueType: "  " },
    ]) {
      const result = await executeJiraCreateIssueDynamicToolCall(args, { env: JIRA_ENV, fetchImpl });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("invalid_input");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns not_connected when credentials are absent", async () => {
    const { executeJiraGetIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const result = await executeJiraGetIssueDynamicToolCall({ keyOrId: "ENG-7" }, { env: {} });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("not_connected");
  });

  it("reads an issue and flattens the ADF description to text", async () => {
    const { executeJiraGetIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        id: "10001",
        key: "ENG-7",
        fields: {
          summary: "Fix the flaky test",
          status: { name: "In Progress" },
          issuetype: { name: "Bug" },
          priority: { name: "High" },
          assignee: { accountId: "acct-1", displayName: "Jane" },
          labels: ["cycloid", "ci"],
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "It fails " },
                  { type: "text", text: "often." },
                ],
              },
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "retry 1" }] }] },
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "retry 2" }] }] },
                ],
              },
            ],
          },
        },
      }),
    ) as typeof fetch;

    const result = await executeJiraGetIssueDynamicToolCall({ keyOrId: "ENG-7" }, { env: JIRA_ENV, fetchImpl });
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      key: "ENG-7",
      summary: "Fix the flaky test",
      status: "In Progress",
      issueType: "Bug",
      priority: "High",
      assignee: { accountId: "acct-1", displayName: "Jane" },
      labels: ["cycloid", "ci"],
      url: "https://acme.atlassian.net/browse/ENG-7",
    });
    expect(payload.description).toBe("It fails often.\n\nretry 1\n\nretry 2");

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("/rest/api/3/issue/ENG-7?fields=");
  });

  it("lists issue comments with pagination and flattened ADF bodies", async () => {
    const { executeJiraListCommentsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        startAt: 50,
        maxResults: 2,
        total: 53,
        comments: [
          {
            id: "10000",
            author: { accountId: "acct-1", displayName: "Jane" },
            created: "2026-01-01T12:00:00.000+0000",
            updated: "2026-01-01T12:05:00.000+0000",
            body: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "First comment." }] }],
            },
          },
          {
            id: "10001",
            author: null,
            body: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(9_000) }] }],
            },
          },
        ],
      }),
    ) as typeof fetch;

    const result = await executeJiraListCommentsDynamicToolCall(
      { keyOrId: "ENG-7", startAt: 50, maxResults: 2 },
      { env: JIRA_ENV, fetchImpl },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as {
      comments: Array<{ body: string; truncated: boolean }>;
      hasMore: boolean;
      nextStartAt: number;
      truncated: boolean;
    };
    expect(payload).toMatchObject({
      keyOrId: "ENG-7",
      startAt: 50,
      maxResults: 2,
      total: 53,
      hasMore: true,
      nextStartAt: 52,
      truncated: true,
    });
    expect(payload.comments[0]).toMatchObject({
      id: "10000",
      author: { accountId: "acct-1", displayName: "Jane" },
      createdAt: "2026-01-01T12:00:00.000+0000",
      updatedAt: "2026-01-01T12:05:00.000+0000",
      body: "First comment.",
      truncated: false,
    });
    expect(payload.comments[1].body).toContain("[truncated]");
    expect(payload.comments[1].body.match(/\[truncated\]/g)).toHaveLength(1);

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(
      "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/ENG-7/comment?startAt=50&maxResults=2",
    );
  });

  it("adds an issue comment as ADF and redacts the body for persistence", async () => {
    const { executeJiraAddCommentDynamicToolCall, redactJiraDynamicToolInputForPersistence } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "comment-1", created: "2026-01-01T12:00:00.000+0000" }, 201),
    ) as typeof fetch;

    const result = await executeJiraAddCommentDynamicToolCall(
      { keyOrId: "ENG-7", body: "Line one.\nLine two." },
      { env: JIRA_ENV, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      keyOrId: "ENG-7",
      id: "comment-1",
      createdAt: "2026-01-01T12:00:00.000+0000",
      commentAdded: true,
    });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/ENG-7/comment");
    expect(JSON.parse(String(init.body))).toEqual({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Line one." }, { type: "hardBreak" }, { type: "text", text: "Line two." }],
          },
        ],
      },
    });
    expect(redactJiraDynamicToolInputForPersistence({ keyOrId: "ENG-7", body: "secret comment" })).toEqual({
      keyOrId: "ENG-7",
      bodyLength: 14,
      bodyRedacted: true,
    });
  });

  it("returns an ambiguous write error when add_comment times out", async () => {
    const { executeJiraAddCommentDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const result = await executeJiraAddCommentDynamicToolCall(
      { keyOrId: "ENG-7", body: "Already sent?" },
      {
        env: JIRA_ENV,
        fetchImpl: vi.fn(async () => {
          throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
        }) as typeof fetch,
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("upstream_error");
    expect(result.contentItems[0].text).toContain("unknown whether the comment was posted");
  });

  it("searches issues through /search/jql with requested fields and token pagination", async () => {
    const { executeJiraSearchIssuesDynamicToolCall, redactJiraDynamicToolInputForPersistence } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        nextPageToken: "next-1",
        issues: [
          {
            id: "10001",
            key: "ENG-7",
            fields: {
              summary: "Fix flaky test",
              status: { name: "In Progress" },
              labels: ["ci"],
              issuetype: { name: "Bug" },
            },
          },
        ],
      }),
    ) as typeof fetch;

    const result = await executeJiraSearchIssuesDynamicToolCall(
      { jql: "project = ENG ORDER BY updated DESC", maxResults: 5, nextPageToken: "page-1" },
      { env: JIRA_ENV, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      hasMore: true,
      nextPageToken: "next-1",
      issues: [{ key: "ENG-7", summary: "Fix flaky test", status: "In Progress" }],
    });
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/search/jql");
    expect(url).not.toContain("/rest/api/3/search?");
    expect(JSON.parse(String(init.body))).toEqual({
      jql: "project = ENG ORDER BY updated DESC",
      maxResults: 5,
      fields: ["summary", "description", "status", "assignee", "labels", "issuetype", "priority"],
      nextPageToken: "page-1",
    });
    expect(redactJiraDynamicToolInputForPersistence({ jql: "assignee = alice@example.com" })).toEqual({
      jqlLength: 28,
      jqlRedacted: true,
    });
  });

  it("preserves null optional fields in get_issue summaries", async () => {
    const { executeJiraGetIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        key: "ENG-7",
        fields: {
          summary: "Fix the flaky test",
          labels: [],
        },
      }),
    ) as typeof fetch;

    const result = await executeJiraGetIssueDynamicToolCall({ keyOrId: "ENG-7" }, { env: JIRA_ENV, fetchImpl });

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      id: null,
      key: "ENG-7",
      summary: "Fix the flaky test",
      status: null,
      issueType: null,
      priority: null,
      assignee: null,
      labels: [],
      description: null,
      url: "https://acme.atlassian.net/browse/ENG-7",
    });
  });

  it("maps upstream auth failures to token_expired and scope_missing", async () => {
    const { executeJiraGetIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");

    const unauthorized = await executeJiraGetIssueDynamicToolCall(
      { keyOrId: "ENG-7" },
      {
        env: JIRA_ENV,
        fetchImpl: vi.fn(async () => jsonResponse({ errorMessages: ["expired"] }, 401)) as typeof fetch,
      },
    );
    expect(unauthorized.success).toBe(false);
    expect(unauthorized.errorCode).toBe("token_expired");
    expect(unauthorized.contentItems[0].text).toContain("Start a new session");

    const forbidden = await executeJiraGetIssueDynamicToolCall(
      { keyOrId: "ENG-7" },
      { env: JIRA_ENV, fetchImpl: vi.fn(async () => jsonResponse({}, 403)) as typeof fetch },
    );
    expect(forbidden.success).toBe(false);
    expect(forbidden.errorCode).toBe("scope_missing");
  });

  it("maps request TimeoutError to cancelled", async () => {
    const { executeJiraGetIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");

    await expect(
      executeJiraGetIssueDynamicToolCall(
        { keyOrId: "ENG-7" },
        {
          env: JIRA_ENV,
          fetchImpl: vi.fn(async () => {
            throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
          }) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "cancelled" });
  });

  it("maps 404s to not_found", async () => {
    const { executeJiraGetIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const result = await executeJiraGetIssueDynamicToolCall(
      { keyOrId: "ENG-404" },
      { env: JIRA_ENV, fetchImpl: vi.fn(async () => jsonResponse({}, 404)) as typeof fetch },
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("not_found");
    expect(result.contentItems[0].text).toContain("ENG-404");
  });

  it("lists transitions with target statuses", async () => {
    const { executeJiraListTransitionsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        transitions: [
          { id: "11", name: "To Do", to: { name: "To Do" } },
          { id: "21", name: "In Progress", to: { name: "In Progress" } },
          null,
          { id: "31", name: "Done", to: null },
        ],
      }),
    ) as typeof fetch;

    const result = await executeJiraListTransitionsDynamicToolCall({ keyOrId: "ENG-7" }, { env: JIRA_ENV, fetchImpl });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      keyOrId: "ENG-7",
      transitions: [
        { id: "11", name: "To Do", toStatus: "To Do" },
        { id: "21", name: "In Progress", toStatus: "In Progress" },
        { id: "31", name: "Done", toStatus: null },
      ],
    });
  });

  it("transitions an issue directly when given a numeric transition ID", async () => {
    const { executeJiraTransitionIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;

    const result = await executeJiraTransitionIssueDynamicToolCall(
      { keyOrId: "ENG-7", transition: "21" },
      { env: JIRA_ENV, fetchImpl },
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      keyOrId: "ENG-7",
      transitionId: "21",
      transitioned: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ transition: { id: "21" } });
  });

  it("resolves a transition name via the transitions list before posting", async () => {
    const { executeJiraTransitionIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") {
        return jsonResponse({ transitions: [{ id: "21", name: "In Progress", to: { name: "In Progress" } }] });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await executeJiraTransitionIssueDynamicToolCall(
      { keyOrId: "ENG-7", transition: "in progress" },
      { env: JIRA_ENV, fetchImpl },
    );
    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      transitionId: "21",
      transitionName: "In Progress",
      transitioned: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails with available transitions when the requested name does not exist", async () => {
    const { executeJiraTransitionIssueDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ transitions: [{ id: "11", name: "To Do", to: { name: "To Do" } }] }),
    ) as typeof fetch;

    const result = await executeJiraTransitionIssueDynamicToolCall(
      { keyOrId: "ENG-7", transition: "Shipped" },
      { env: JIRA_ENV, fetchImpl },
    );
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("invalid_input");
    expect(result.contentItems[0].text).toContain("To Do");
  });

  it("redacts summary and description for persistence", async () => {
    const { redactJiraDynamicToolInputForPersistence } =
      await import("../../apps/sandbox-bridge/src/services/jira-dynamic-tool.js");
    expect(
      redactJiraDynamicToolInputForPersistence({
        projectKey: "ENG",
        summary: "secret summary",
        description: "secret body",
        issueType: "Bug",
        labels: ["a", "b"],
      }),
    ).toEqual({
      projectKey: "ENG",
      issueType: "Bug",
      labelCount: 2,
      summaryLength: 14,
      descriptionLength: 11,
      summaryRedacted: true,
      descriptionRedacted: true,
    });
    expect(redactJiraDynamicToolInputForPersistence(null)).toEqual({});
  });

  it("flattens nested ADF and wraps multi-paragraph text symmetrically", async () => {
    const { flattenAdfToText, wrapTextAsAdf } = await import("../../shared/utils/adf.js");

    const wrapped = wrapTextAsAdf("Line one.\nLine two.\n\nSecond paragraph.");
    const flattened = flattenAdfToText(wrapped)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    expect(flattened).toBe("Line one.\nLine two.\n\nSecond paragraph.");

    expect(flattenAdfToText({ type: "doc", version: 1, content: [] })).toBe("");
    expect(flattenAdfToText(null)).toBe("");
    expect(flattenAdfToText("not adf")).toBe("");
  });

  it("preserves inline mention/emoji/inlineCard leaves instead of dropping them", async () => {
    const { flattenAdfToText } = await import("../../shared/utils/adf.js");

    // A mention between two text runs must not vanish (which would also fuse the
    // surrounding words into "see  for details").
    const paragraph = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "see " },
            { type: "mention", attrs: { id: "abc", text: "@alice" } },
            { type: "text", text: " for details" },
          ],
        },
      ],
    };
    expect(flattenAdfToText(paragraph).trim()).toBe("see @alice for details");

    expect(flattenAdfToText({ type: "emoji", attrs: { shortName: ":smile:" } })).toBe(":smile:");
    expect(flattenAdfToText({ type: "inlineCard", attrs: { url: "https://example.com/x" } })).toBe(
      "https://example.com/x",
    );
  });

  it("registers all jira tools in the first-party registry", async () => {
    const { buildAllDynamicToolSpecs } =
      await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js");
    const specs = buildAllDynamicToolSpecs(JIRA_ENV);
    const jiraSpecs = specs.filter((spec) => spec.namespace === "jira").map((spec) => spec.name);
    expect(jiraSpecs.sort()).toEqual([
      "add_comment",
      "create_issue",
      "get_issue",
      "list_comments",
      "list_transitions",
      "search_issues",
      "transition_issue",
    ]);

    const withoutCreds = buildAllDynamicToolSpecs({});
    expect(withoutCreds.filter((spec) => spec.namespace === "jira")).toEqual([]);
  });
});
