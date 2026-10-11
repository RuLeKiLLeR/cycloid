import { describe, expect, it } from "vitest";

import { buildToolFailureReport } from "../../shared/tool-failure.js";

describe("buildToolFailureReport", () => {
  it("redacts raw diagnostics while surfacing a safe auth summary", () => {
    const token = "ghp_1234567890abcdefghijklmnop";
    const report = buildToolFailureReport({
      tool: "bash",
      rawOutput: `401 Unauthorized: token ${token} was rejected`,
    });

    expect(report).toEqual({
      category: "auth",
      phase: "auth",
      diagnosticsRedacted: true,
      safeSummary: "401 Unauthorized: token [REDACTED] was rejected",
    });
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("extracts upstream GitHub Actions run references from provider failures", () => {
    const report = buildToolFailureReport({
      tool: "bash",
      rawOutput: "Provider returned 503. See https://github.com/trycycloid/cycloid/actions/runs/987654321",
    });

    expect(report).toMatchObject({
      category: "provider",
      phase: "provider",
      diagnosticsRedacted: true,
      upstream: {
        runId: "987654321",
        logUrl: "https://github.com/trycycloid/cycloid/actions/runs/987654321",
      },
    });
  });
});
