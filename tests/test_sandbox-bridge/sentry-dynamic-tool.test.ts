import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createFetchRouter(
  routes: Record<string, Response | ((request: Request) => Response | Promise<Response>)>,
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes[href];
    if (!route) {
      throw new Error(`Unexpected fetch URL: ${href}`);
    }
    return typeof route === "function" ? await route(new Request(href, init)) : route;
  }) as typeof fetch;
}

describe("sentry dynamic tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds specs only when Sentry credentials are present", async () => {
    const { buildSentryDynamicToolSpec, buildSentrySearchIssuesDynamicToolSpec } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");

    expect(buildSentryDynamicToolSpec({})).toEqual([]);
    expect(buildSentryDynamicToolSpec({ SENTRY_ACCESS_TOKEN: "token" })).toEqual([]);
    expect(buildSentryDynamicToolSpec({ SENTRY_ORGANIZATION_SLUG: "acme" })).toEqual([]);
    expect(buildSentryDynamicToolSpec({ SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" })).toHaveLength(
      1,
    );
    expect(
      buildSentrySearchIssuesDynamicToolSpec({ SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" }),
    ).toMatchObject([{ namespace: "sentry", name: "search_issues" }]);
  });

  it("uses an explicit organization slug for short IDs", async () => {
    const { executeSentryDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");

    const fetchImpl = createFetchRouter({
      "https://sentry.io/api/0/organizations/cycloid/shortids/CYCLOID-7Q/": () =>
        new Response(
          JSON.stringify({
            group: {
              id: "7489715398",
              shortId: "CYCLOID-7Q",
              title: "Durable Object isolate exceeded memory limit",
              permalink: "https://sentry.io/organizations/cycloid/issues/7489715398/",
            },
          }),
          { status: 200 },
        ),
      "https://sentry.io/api/0/organizations/cycloid/issues/7489715398/events/latest/": () =>
        new Response(
          JSON.stringify({
            id: "evt-latest",
            eventID: "evt-latest",
            title: "Latest event",
            permalink: "https://sentry.io/organizations/cycloid/issues/7489715398/events/latest/",
          }),
          { status: 200 },
        ),
    });

    const result = await executeSentryDynamicToolCall(
      { reference: "CYCLOID-7Q", organizationSlug: "cycloid" },
      { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "fallback-org" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      organizationSlug: "cycloid",
      resolvedFrom: "short_id",
      issue: { id: "7489715398", shortId: "CYCLOID-7Q" },
      event: { eventId: "evt-latest", title: "Latest event" },
    });
  });

  it("looks up a numeric issue ID and tolerates a missing latest event", async () => {
    const { executeSentryDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");

    const fetchImpl = createFetchRouter({
      "https://sentry.io/api/0/organizations/acme/issues/123/": new Response(
        JSON.stringify({
          id: "123",
          shortId: "WEB-123",
          title: "Broken checkout",
          culprit: "checkout",
          permalink: "https://sentry.io/organizations/acme/issues/123/",
          status: "unresolved",
          project: { slug: "web", name: "Web" },
        }),
        { status: 200 },
      ),
      "https://sentry.io/api/0/organizations/acme/issues/123/events/latest/": new Response("missing", { status: 404 }),
    });

    const result = await executeSentryDynamicToolCall(
      { reference: "123" },
      { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as {
      organizationSlug: string;
      resolvedFrom: string;
      issue: { id: string; shortId: string; title: string };
      event: null;
    };
    expect(payload).toMatchObject({
      organizationSlug: "acme",
      resolvedFrom: "issue_id",
      issue: { id: "123", shortId: "WEB-123", title: "Broken checkout" },
      event: null,
    });
  });

  it("preserves null optional fields in issue and event summaries", async () => {
    const { executeSentryDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");

    const fetchImpl = createFetchRouter({
      "https://sentry.io/api/0/organizations/acme/issues/123/": new Response(
        JSON.stringify({
          id: "123",
          title: "Broken checkout",
          project: {},
        }),
        { status: 200 },
      ),
      "https://sentry.io/api/0/organizations/acme/issues/123/events/latest/": new Response(
        JSON.stringify({
          eventID: "evt-latest",
          title: "Latest event",
        }),
        { status: 200 },
      ),
    });

    const result = await executeSentryDynamicToolCall(
      { reference: "123" },
      { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toEqual({
      organizationSlug: "acme",
      resolvedFrom: "issue_id",
      issue: {
        id: "123",
        shortId: null,
        title: "Broken checkout",
        culprit: null,
        permalink: null,
        firstSeen: null,
        lastSeen: null,
        status: null,
        count: null,
        userCount: null,
        projectSlug: null,
        projectName: null,
      },
      event: {
        id: "",
        eventId: "evt-latest",
        title: "Latest event",
        message: null,
        platform: null,
        culprit: null,
        permalink: null,
        occurredAt: null,
        tags: [],
      },
    });
  });

  it("propagates latest-event rate limits instead of silently dropping them", async () => {
    const { executeSentryDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");

    const fetchImpl = createFetchRouter({
      "https://sentry.io/api/0/organizations/acme/issues/123/": new Response(
        JSON.stringify({
          id: "123",
          shortId: "WEB-123",
          title: "Broken checkout",
          permalink: "https://sentry.io/organizations/acme/issues/123/",
        }),
        { status: 200 },
      ),
      "https://sentry.io/api/0/organizations/acme/issues/123/events/latest/": new Response("slow down", {
        status: 429,
      }),
    });

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123" },
        { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" }, fetchImpl },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "upstream_rate_limited" });
  });

  it("searches organization issues with encoded filters and normalizes counts", async () => {
    const { executeSentrySearchIssuesDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(href);
      expect(url.origin + url.pathname).toBe("https://sentry.io/api/0/organizations/acme/issues/");
      expect(url.searchParams.get("query")).toBe('is:unresolved user.email:"ada@example.com"');
      expect(url.searchParams.get("project")).toBe("web");
      expect(url.searchParams.get("statsPeriod")).toBe("48h");
      expect(url.searchParams.get("limit")).toBe("2");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token");
      return new Response(
        JSON.stringify([
          {
            id: "123",
            shortId: "WEB-123",
            title: "Broken checkout",
            culprit: "checkout",
            count: "42",
            userCount: 7,
            firstSeen: "2026-07-04T00:00:00Z",
            lastSeen: "2026-07-05T00:00:00Z",
            permalink: "https://sentry.io/organizations/acme/issues/123/",
            project: { slug: "web", name: "Web" },
          },
        ]),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await executeSentrySearchIssuesDynamicToolCall(
      { query: 'is:unresolved user.email:"ada@example.com"', project: "web", statsPeriod: "48h", limit: 2 },
      { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      organizationSlug: "acme",
      query: 'is:unresolved user.email:"ada@example.com"',
      project: "web",
      statsPeriod: "48h",
      issues: [
        {
          id: "123",
          shortId: "WEB-123",
          count: 42,
          userCount: 7,
          projectSlug: "web",
        },
      ],
    });
  });

  it("returns an empty Sentry issue search result", async () => {
    const { executeSentrySearchIssuesDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch;

    const result = await executeSentrySearchIssuesDynamicToolCall(
      { query: "is:resolved" },
      { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      organizationSlug: "acme",
      query: "is:resolved",
      project: null,
      statsPeriod: "24h",
      issues: [],
    });
  });

  it("maps Sentry issue search auth failures to token_expired", async () => {
    const { executeSentrySearchIssuesDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");

    await expect(
      executeSentrySearchIssuesDynamicToolCall(
        { query: "is:unresolved" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
          fetchImpl: vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "token_expired" });
  });

  it("rejects invalid Sentry issue search stats periods before calling Sentry", async () => {
    const { executeSentrySearchIssuesDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");
    const fetchImpl = vi.fn() as typeof fetch;

    const result = await executeSentrySearchIssuesDynamicToolCall(
      { query: "is:unresolved", statsPeriod: "forever" },
      { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" }, fetchImpl },
    );

    expect(result).toMatchObject({ success: false, errorCode: "invalid_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts Sentry issue search text before persistence", async () => {
    const { redactFirstPartyDynamicToolInputForPersistence } =
      await import("../../apps/sandbox-bridge/src/services/first-party-dynamic-tools.js");

    expect(
      redactFirstPartyDynamicToolInputForPersistence("sentry", "search_issues", {
        query: 'is:unresolved user.email:"ada@example.com"',
        project: "web",
        statsPeriod: "48h",
        limit: 2,
      }),
    ).toEqual({ queryLength: 42, project: "web", statsPeriod: "48h", limit: 2 });
  });

  it("looks up issue URLs, event URLs, and short IDs", async () => {
    const { executeSentryDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");

    const fetchImpl = createFetchRouter({
      "https://sentry.io/api/0/organizations/acme/issues/123/": () =>
        new Response(
          JSON.stringify({
            id: "123",
            shortId: "WEB-123",
            title: "Issue from URL",
            permalink: "https://sentry.io/organizations/acme/issues/123/",
          }),
          { status: 200 },
        ),
      "https://sentry.io/api/0/organizations/acme/issues/123/events/latest/": () =>
        new Response(
          JSON.stringify({
            id: "evt-latest",
            eventID: "evt-latest",
            title: "Latest event",
            permalink: "https://sentry.io/organizations/acme/issues/123/events/latest/",
            tags: [{ key: "env", value: "prod" }],
          }),
          { status: 200 },
        ),
      "https://sentry.io/api/0/organizations/acme/issues/123/events/evt-1/": () =>
        new Response(
          JSON.stringify({
            id: "evt-1",
            eventID: "evt-1",
            title: "Specific event",
            permalink: "https://sentry.io/organizations/acme/issues/123/events/evt-1/",
            tags: [{ key: "browser", value: "chrome" }],
          }),
          { status: 200 },
        ),
      "https://sentry.io/api/0/organizations/acme/shortids/WEB-123/": () =>
        new Response(
          JSON.stringify({
            group: {
              id: "123",
              shortId: "WEB-123",
              title: "Short ID issue",
              permalink: "https://sentry.io/organizations/acme/issues/123/",
            },
          }),
          { status: 200 },
        ),
    });

    const issueUrlResult = await executeSentryDynamicToolCall(
      { reference: "https://acme.sentry.io/issues/123/" },
      { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "fallback" }, fetchImpl },
    );
    expect(issueUrlResult.success).toBe(true);
    expect(JSON.parse(issueUrlResult.contentItems[0].text)).toMatchObject({
      organizationSlug: "acme",
      resolvedFrom: "issue_url",
      event: { eventId: "evt-latest", title: "Latest event" },
    });

    const eventUrlResult = await executeSentryDynamicToolCall(
      { reference: "https://sentry.io/organizations/acme/issues/123/events/evt-1/" },
      { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "fallback" }, fetchImpl },
    );
    expect(eventUrlResult.success).toBe(true);
    expect(JSON.parse(eventUrlResult.contentItems[0].text)).toMatchObject({
      organizationSlug: "acme",
      resolvedFrom: "event_url",
      event: { eventId: "evt-1", title: "Specific event" },
    });

    const shortIdResult = await executeSentryDynamicToolCall(
      { reference: "web-123" },
      { env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" }, fetchImpl },
    );
    expect(shortIdResult.success).toBe(true);
    expect(JSON.parse(shortIdResult.contentItems[0].text)).toMatchObject({
      organizationSlug: "acme",
      resolvedFrom: "short_id",
      issue: { id: "123", shortId: "WEB-123", title: "Short ID issue" },
      event: { eventId: "evt-latest", title: "Latest event" },
    });
  });

  it("rejects invalid inputs and unsupported fields", async () => {
    const { executeSentryDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");

    await expect(
      executeSentryDynamicToolCall("123", {
        env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
      }),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [
        { type: "inputText", text: "Sentry lookup failed: Sentry lookup_issue requires an object input." },
      ],
    });

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123", extra: true },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [
        { type: "inputText", text: "Sentry lookup failed: Sentry lookup_issue received unsupported fields: extra." },
      ],
    });

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123", organizationSlug: "   " },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [
        {
          type: "inputText",
          text: "Sentry lookup failed: Sentry lookup_issue requires 'organizationSlug' to be a non-empty string when provided.",
        },
      ],
    });

    await expect(
      executeSentryDynamicToolCall(
        { reference: "   " },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [
        {
          type: "inputText",
          text: "Sentry lookup failed: Sentry lookup_issue requires a non-empty 'reference' string.",
        },
      ],
    });

    await expect(
      executeSentryDynamicToolCall(
        { reference: "not a sentry reference" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "invalid_input",
      contentItems: [{ type: "inputText", text: "Sentry lookup failed: Unsupported Sentry reference" }],
    });
  });

  it("maps upstream auth, not found, rate limit, and server failures", async () => {
    const { executeSentryDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
          fetchImpl: vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "token_expired" });

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
          fetchImpl: vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "scope_missing" });

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
          fetchImpl: vi.fn(async () => new Response("missing", { status: 404 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "not_found" });

    await expect(
      executeSentryDynamicToolCall(
        { reference: "CYCLOID-7Q" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "wrong-org" },
          fetchImpl: vi.fn(async (input: string | URL | Request) => {
            const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (href === "https://sentry.io/api/0/organizations/wrong-org/shortids/CYCLOID-7Q/") {
              return new Response("missing", { status: 404 });
            }
            throw new Error(`Unexpected fetch URL: ${href}`);
          }) as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "not_found",
      contentItems: [
        {
          type: "inputText",
          text: "Sentry lookup failed: Sentry short ID 'CYCLOID-7Q' was not found in organization 'wrong-org'. Try the full issue URL or pass the correct organizationSlug.",
        },
      ],
    });

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
          fetchImpl: vi.fn(async () => new Response("slow down", { status: 429 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "upstream_rate_limited" });

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
          fetchImpl: vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch,
        },
      ),
    ).resolves.toMatchObject({ success: false, errorCode: "upstream_error" });
  });

  it("returns not_connected when credentials are missing", async () => {
    const { executeSentryDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");

    await expect(executeSentryDynamicToolCall({ reference: "123" }, { env: {} })).resolves.toEqual({
      success: false,
      errorCode: "not_connected",
      contentItems: [{ type: "inputText", text: "Sentry credentials are not configured for this session." }],
    });
  });

  it.each([
    ["caller abort", "AbortError"],
    ["request timeout", "TimeoutError"],
  ])("maps %s requests to cancelled", async (_label, errorName) => {
    const { executeSentryDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/sentry-dynamic-tool.js");
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeSentryDynamicToolCall(
        { reference: "123" },
        {
          env: { SENTRY_ACCESS_TOKEN: "token", SENTRY_ORGANIZATION_SLUG: "acme" },
          signal: controller.signal,
          fetchImpl: vi.fn(async () => {
            throw new DOMException("Aborted", errorName);
          }) as typeof fetch,
        },
      ),
    ).resolves.toEqual({
      success: false,
      errorCode: "cancelled",
      contentItems: [{ type: "inputText", text: "Sentry lookup was cancelled." }],
    });
  });
});
