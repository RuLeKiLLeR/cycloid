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

describe("launchdarkly dynamic tools", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds specs only when LaunchDarkly credentials are present", async () => {
    const {
      buildLaunchDarklyGetFeatureFlagDynamicToolSpec,
      buildLaunchDarklyListFeatureFlagsDynamicToolSpec,
      buildLaunchDarklyPatchFeatureFlagDynamicToolSpec,
    } = await import("../../apps/sandbox-bridge/src/services/launchdarkly-dynamic-tool.js");

    expect(buildLaunchDarklyListFeatureFlagsDynamicToolSpec({})).toEqual([]);
    expect(buildLaunchDarklyGetFeatureFlagDynamicToolSpec({ LAUNCHDARKLY_ACCESS_TOKEN: "token" })).toMatchObject([
      { namespace: "launchdarkly", name: "get_feature_flag" },
    ]);
    expect(buildLaunchDarklyPatchFeatureFlagDynamicToolSpec({ LAUNCHDARKLY_ACCESS_TOKEN: "token" })).toMatchObject([
      { namespace: "launchdarkly", name: "patch_feature_flag" },
    ]);
  });

  it("exposes patch operation fields to MCP zod conversion", async () => {
    const { z } = await import("zod");
    const { buildLaunchDarklyPatchFeatureFlagDynamicToolSpec } =
      await import("../../apps/sandbox-bridge/src/services/launchdarkly-dynamic-tool.js");
    const { jsonSchemaPropertiesToZodShape } =
      await import("../../apps/sandbox-bridge/src/services/dynamic-tool-zod.js");

    const spec = buildLaunchDarklyPatchFeatureFlagDynamicToolSpec({ LAUNCHDARKLY_ACCESS_TOKEN: "token" })[0]!;
    const parsed = z.object(jsonSchemaPropertiesToZodShape(spec.inputSchema)).safeParse({
      projectKey: "acme",
      featureFlagKey: "checkout-redesign",
      environmentKey: "production",
      operations: [{ kind: "turn_on" }, { kind: "set_fallthrough_variation", variationId: "variation-true" }],
    });

    expect(parsed.success).toBe(true);
    expect(spec.inputSchema.properties?.operations).toMatchObject({
      items: {
        type: "object",
        properties: {
          kind: { enum: ["turn_on", "turn_off", "set_fallthrough_variation", "set_off_variation"] },
          variationId: { type: "string" },
        },
      },
    });
  });

  it("lists LaunchDarkly feature flags with environment summaries", async () => {
    const { executeLaunchDarklyListFeatureFlagsDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/launchdarkly-dynamic-tool.js");

    const fetchImpl = createFetchRouter({
      "https://app.launchdarkly.com/api/v2/flags/acme-app?limit=5&env=production&filter=query%3Acheckout": () =>
        new Response(
          JSON.stringify({
            totalCount: 1,
            items: [
              {
                key: "checkout-redesign",
                name: "Checkout redesign",
                kind: "boolean",
                description: "Gate the new checkout flow.",
                temporary: true,
                tags: ["checkout", "beta"],
                variations: [
                  { _id: "variation-true", value: true },
                  { _id: "variation-false", value: false },
                ],
                environments: {
                  production: {
                    on: false,
                    fallthrough: { variation: 0 },
                    offVariation: 1,
                    rules: [{ _id: "rule-1" }],
                    targets: [{ values: ["org-1"], variation: 0 }],
                    contextTargets: [{ values: ["device-1"], variation: 0, contextKind: "device" }],
                    prerequisites: [],
                  },
                },
              },
            ],
          }),
          { status: 200 },
        ),
    });

    const result = await executeLaunchDarklyListFeatureFlagsDynamicToolCall(
      {
        projectKey: "acme-app",
        environmentKey: "production",
        search: "checkout",
        limit: 5,
      },
      { env: { LAUNCHDARKLY_ACCESS_TOKEN: "token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      projectKey: "acme-app",
      totalCount: 1,
      returnedCount: 1,
      items: [
        {
          key: "checkout-redesign",
          kind: "boolean",
          tags: ["checkout", "beta"],
          variations: [
            { id: "variation-true", index: 0, value: true },
            { id: "variation-false", index: 1, value: false },
          ],
          environment: {
            key: "production",
            on: false,
            offVariationIndex: 1,
            fallthrough: { kind: "variation", variationIndex: 0 },
            ruleCount: 1,
            targetCount: 1,
            contextTargetCount: 1,
            prerequisiteCount: 0,
          },
        },
      ],
    });
  });

  it("gets a single LaunchDarkly feature flag with environment state", async () => {
    const { executeLaunchDarklyGetFeatureFlagDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/launchdarkly-dynamic-tool.js");

    const fetchImpl = createFetchRouter({
      "https://app.launchdarkly.com/api/v2/flags/acme-app/checkout-redesign?env=production&expand=evaluation": () =>
        new Response(
          JSON.stringify({
            key: "checkout-redesign",
            name: "Checkout redesign",
            kind: "boolean",
            description: "Gate the new checkout flow.",
            variations: [
              { _id: "variation-true", value: true },
              { _id: "variation-false", value: false },
            ],
            environments: {
              production: {
                on: true,
                fallthrough: { variation: 0 },
                offVariation: 1,
              },
            },
          }),
          { status: 200 },
        ),
    });

    const result = await executeLaunchDarklyGetFeatureFlagDynamicToolCall(
      {
        projectKey: "acme-app",
        featureFlagKey: "checkout-redesign",
        environmentKey: "production",
        includeEvaluation: true,
      },
      { env: { LAUNCHDARKLY_ACCESS_TOKEN: "token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      key: "checkout-redesign",
      name: "Checkout redesign",
      environment: {
        key: "production",
        on: true,
        offVariationIndex: 1,
        fallthrough: { kind: "variation", variationIndex: 0 },
      },
    });
  });

  it("patches a LaunchDarkly feature flag via semantic patch instructions", async () => {
    const { executeLaunchDarklyPatchFeatureFlagDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/launchdarkly-dynamic-tool.js");

    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://app.launchdarkly.com/api/v2/flags/acme-app/checkout-redesign");
      expect(init?.method).toBe("PATCH");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("token");
      expect(headers.get("content-type")).toBe("application/json; domain-model=launchdarkly.semanticpatch");
      expect(JSON.parse(String(init?.body))).toEqual({
        environmentKey: "production",
        instructions: [
          { kind: "updateFallthroughVariationOrRollout", variationId: "variation-true" },
          { kind: "turnFlagOn" },
        ],
      });
      return new Response(
        JSON.stringify({
          key: "checkout-redesign",
          name: "Checkout redesign",
          kind: "boolean",
          variations: [
            { _id: "variation-true", value: true },
            { _id: "variation-false", value: false },
          ],
          environments: {
            production: {
              on: true,
              fallthrough: { variation: 0 },
              offVariation: 1,
            },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await executeLaunchDarklyPatchFeatureFlagDynamicToolCall(
      {
        projectKey: "acme-app",
        featureFlagKey: "checkout-redesign",
        environmentKey: "production",
        operations: [{ kind: "set_fallthrough_variation", variationId: "variation-true" }, { kind: "turn_on" }],
      },
      { env: { LAUNCHDARKLY_ACCESS_TOKEN: "token" }, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.contentItems[0].text)).toMatchObject({
      appliedOperations: ["set_fallthrough_variation", "turn_on"],
      flag: {
        key: "checkout-redesign",
        environment: {
          key: "production",
          on: true,
          fallthrough: { kind: "variation", variationIndex: 0 },
        },
      },
    });
  });

  it("maps LaunchDarkly permission errors to scope_missing", async () => {
    const { executeLaunchDarklyGetFeatureFlagDynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/launchdarkly-dynamic-tool.js");

    const fetchImpl = createFetchRouter({
      "https://app.launchdarkly.com/api/v2/flags/acme-app/checkout-redesign": () =>
        new Response(JSON.stringify({ message: "forbidden" }), { status: 403 }),
    });

    const result = await executeLaunchDarklyGetFeatureFlagDynamicToolCall(
      { projectKey: "acme-app", featureFlagKey: "checkout-redesign" },
      { env: { LAUNCHDARKLY_ACCESS_TOKEN: "token" }, fetchImpl },
    );

    expect(result).toEqual({
      success: false,
      errorCode: "scope_missing",
      contentItems: [{ type: "inputText", text: "forbidden" }],
    });
  });
});
