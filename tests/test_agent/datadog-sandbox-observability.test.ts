import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SANDBOX_TF = resolve("infra/datadog-sandbox.tf");

function readSandboxTerraform(): string {
  return readFileSync(SANDBOX_TF, "utf8");
}

describe("sandbox Datadog observability terraform", () => {
  it("groups spawn and resume metrics by provider", () => {
    const source = readSandboxTerraform();

    expect(source).toMatch(
      /resource "datadog_logs_metric" "sandbox_spawn_duration"[\s\S]*?path\s*=\s*"@provider"[\s\S]*?tag_name\s*=\s*"provider"/,
    );
    expect(source).toMatch(
      /resource "datadog_logs_metric" "sandbox_resume_latency"[\s\S]*?path\s*=\s*"@provider"[\s\S]*?tag_name\s*=\s*"provider"/,
    );
  });

  it("derives the warm reuse ratio from post-stop resume counts", () => {
    const source = readSandboxTerraform();

    expect(source).toContain('title = "Warm reuse ratio (last 1d)"');
    expect(source).toContain('query       = "count:arcanist.sandbox.resume_latency{dispatch_path:warm}.as_count()"');
    expect(source).toContain('query       = "count:arcanist.sandbox.resume_latency{dispatch_path:cold}.as_count()"');
    expect(source).toContain('formula_expression = "default_zero(warm / (warm + cold)) * 100"');
  });
});
