import { describe, expect, it } from "vitest";

import { CONFIGURED_TEST_FAILURE_EVENT } from "../../apps/sandbox-bridge/src/constants/observability.js";
import { buildDatadogLogsUrl } from "../../apps/sandbox-bridge/src/utils/datadog-logs-url.js";

describe("buildDatadogLogsUrl", () => {
  it("builds a us5 logs deep-link scoped to the session, service, env, and event", () => {
    const url = buildDatadogLogsUrl({
      sessionId: "sess-123",
      enabled: true,
      env: "production",
      event: CONFIGURED_TEST_FAILURE_EVENT,
      fromMs: 1_000_000,
      toMs: 2_000_000,
    });

    expect(url).toBeDefined();
    const parsed = new URL(url!);
    expect(parsed.host).toBe("us5.datadoghq.com");
    expect(parsed.pathname).toBe("/logs");
    // session id is logged as the `session_id` attribute, so the query must use `@session_id:`.
    // Facet values are double-quoted so hyphens/spaces do not split or mis-parse the query.
    expect(parsed.searchParams.get("query")).toBe(
      `@session_id:"sess-123" service:"cycloid-sandbox-bridge" env:"production" @event:"${CONFIGURED_TEST_FAILURE_EVENT}"`,
    );
    expect(parsed.searchParams.get("from_ts")).toBe("1000000");
    expect(parsed.searchParams.get("to_ts")).toBe("2000000");
  });

  it("quotes a UUID session id so hyphens are not parsed as Datadog operators", () => {
    const url = buildDatadogLogsUrl({ sessionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479", enabled: true });
    expect(new URL(url!).searchParams.get("query")).toContain('@session_id:"f47ac10b-58cc-4372-a567-0e02b2c3d479"');
  });

  it("derives a window from nowMs when explicit bounds are absent", () => {
    const now = 10_000_000;
    const url = buildDatadogLogsUrl({ sessionId: "s", enabled: true, nowMs: now });
    const parsed = new URL(url!);
    expect(Number(parsed.searchParams.get("from_ts"))).toBe(now - 15 * 60_000);
    expect(Number(parsed.searchParams.get("to_ts"))).toBe(now + 5 * 60_000);
  });

  it("honors a custom site and strips protocol/trailing slash", () => {
    const url = buildDatadogLogsUrl({
      sessionId: "s",
      enabled: true,
      ddSite: "https://us3.datadoghq.com/",
    });
    expect(new URL(url!).host).toBe("us3.datadoghq.com");
  });

  it("returns undefined when Datadog shipping is disabled (no link to logs never shipped)", () => {
    expect(buildDatadogLogsUrl({ sessionId: "s", enabled: false })).toBeUndefined();
  });

  it("returns undefined when there is no session id", () => {
    expect(buildDatadogLogsUrl({ sessionId: "", enabled: true })).toBeUndefined();
    expect(buildDatadogLogsUrl({ sessionId: "   ", enabled: true })).toBeUndefined();
  });
});
