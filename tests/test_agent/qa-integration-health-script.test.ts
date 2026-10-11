import { describe, expect, it, vi } from "vitest";

import {
  evaluateHealth,
  formatRequiredFailureText,
  formatSummary,
  parseArgs,
  type QaIntegrationHealthResponse,
} from "../../scripts/qa-integration-health";

const baseHealth: QaIntegrationHealthResponse = {
  ok: true,
  workerEnv: "qa",
  businessId: "qa-business",
  fixtures: [
    {
      integrationId: "cloudflare",
      status: "configured" as const,
      reason: "configured",
      env: { required: ["QA_CLOUDFLARE_D1_API_TOKEN"], present: ["QA_CLOUDFLARE_D1_API_TOKEN"], missing: [] },
      credentialRow: "present" as const,
      scope: "business" as const,
    },
    {
      integrationId: "datadog",
      status: "missing" as const,
      reason: "missing",
      env: { required: ["QA_DATADOG_API_KEY"], present: [], missing: ["QA_DATADOG_API_KEY"] },
      credentialRow: "missing" as const,
      scope: "missing" as const,
    },
  ],
};

describe("qa integration health script helpers", () => {
  it("parses fixture requirements including all", () => {
    expect(parseArgs(["--require", "datadog,cloudflare"]).requireFixtures).toEqual(["cloudflare", "datadog"]);
    expect(parseArgs(["--require=all"]).requireFixtures).toEqual(["braintrust", "cloudflare", "datadog"]);
  });

  it("rejects unknown fixture requirements", () => {
    expect(() => parseArgs(["--require", "linear"])).toThrow("Unknown fixture in --require: linear");
  });

  it("rejects empty equals-form fixture requirements", () => {
    expect(() => parseArgs(["--require="])).toThrow("--require= requires a comma-separated fixture list");
  });

  it("uses ARCANIST_API_URL as the default base URL when set", () => {
    vi.stubEnv("ARCANIST_API_URL", "https://qa.example.com/");
    try {
      expect(parseArgs([]).baseUrl).toBe("https://qa.example.com");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails evaluation when a required fixture is missing or not configured", () => {
    expect(evaluateHealth(baseHealth, ["cloudflare"])).toEqual({ ok: true, failures: [] });

    const evaluation = evaluateHealth(baseHealth, ["datadog", "braintrust"]);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures).toEqual([
      "datadog: expected configured, got missing (missing)",
      "braintrust: fixture is absent from health response",
    ]);
  });

  it("formats safe status without secret values", () => {
    const summary = formatSummary(baseHealth, evaluateHealth(baseHealth, ["datadog"]));

    expect(summary).toContain("QA integration health: workerEnv=qa businessId=qa-business");
    expect(summary).toContain("- cloudflare: configured");
    expect(summary).toContain("QA_DATADOG_API_KEY");
    expect(summary).not.toContain("token");
    expect(summary).toContain("datadog: expected configured, got missing");
  });

  it("builds explicit failure text for json-mode callers", () => {
    const evaluation = evaluateHealth(baseHealth, ["datadog"]);

    expect(formatRequiredFailureText(evaluation)).toBe(
      "QA integration health required fixture failures:\n- datadog: expected configured, got missing (missing)",
    );
    expect(formatRequiredFailureText({ ok: true, failures: [] })).toBeNull();
  });
});
