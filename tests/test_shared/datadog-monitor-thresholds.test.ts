import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const MONITORS_TF = join(REPO_ROOT, "infra/datadog-monitors.tf");

function readMonitorBlock(monitorKey: string): string {
  const source = readFileSync(MONITORS_TF, "utf8");
  const match = source.match(new RegExp(`\\b${monitorKey}\\s*=\\s*\\{([\\s\\S]*?)^\\s{4}\\}`, "m"));
  expect(match).not.toBeNull();
  return match![1]!;
}

describe("Datadog monitor thresholds", () => {
  it("keeps terminal_outcome_coercion as a critical-only zero-tolerance monitor", () => {
    const block = readMonitorBlock("terminal_outcome_coercion");

    expect(block).toMatch(/\bcritical\s*=\s*0\b/);
    expect(block).not.toMatch(/\bwarning\s*=/);
  });
});
