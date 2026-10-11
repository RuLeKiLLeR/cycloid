import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { DYNAMIC_TOOL_ERROR_CODES } from "../../apps/sandbox-bridge/src/services/dynamic-tool-results";

const REPO_ROOT = process.cwd();
const MONITORS_TF = join(REPO_ROOT, "infra/datadog-monitors.tf");

const EXPECTED_DYNAMIC_TOOL_ERROR_CODES = [
  "blocked",
  "cancelled",
  "execution_failed",
  "forbidden",
  "graphql_error",
  "invalid_credential",
  "invalid_input",
  "limit_exceeded",
  "manual_rename",
  "missing_binary",
  "not_connected",
  "not_found",
  "not_registered",
  "scope_missing",
  "timed_out",
  "token_expired",
  "upstream_error",
  "upstream_http_error",
  "upstream_rate_limited",
  "workspace_unknown",
  "workspace_uninstalled",
] as const;

const EXPECTED_PAGEABLE_DYNAMIC_TOOL_ERROR_CODES = [
  "upstream_error",
  "upstream_http_error",
  "upstream_rate_limited",
  "not_connected",
  "forbidden",
  "invalid_credential",
  "token_expired",
  "scope_missing",
  "missing_binary",
  "graphql_error",
  "workspace_uninstalled",
] as const;

const EXPECTED_NON_PAGEABLE_DYNAMIC_TOOL_ERROR_CODES = [
  "blocked",
  "invalid_input",
  "not_found",
  "not_registered",
  "cancelled",
  "manual_rename",
  "limit_exceeded",
  "timed_out",
  "workspace_unknown",
  // terraform-plan-only; a non-zero terraform exit is the user's broken config,
  // an agent-driven outcome, not a pageable platform fault. See datadog-monitors.tf.
  "execution_failed",
] as const;

function readTerraformPageableCodes(): string[] {
  const source = readFileSync(MONITORS_TF, "utf8");
  const match = source.match(/pageable_first_party_dynamic_tool_error_codes\s*=\s*\[([\s\S]*?)\]/);
  expect(match).not.toBeNull();
  return [...match![1]!.matchAll(/"([^"]+)"/g)].map((code) => code[1]!);
}

describe("dynamic tool alerting classification", () => {
  it("classifies every dynamic tool error code exactly once", () => {
    const actualCodes = Object.values(DYNAMIC_TOOL_ERROR_CODES).sort();
    const expectedCodes = [...EXPECTED_DYNAMIC_TOOL_ERROR_CODES].sort();
    expect(actualCodes).toEqual(expectedCodes);

    const classifiedCodes = [
      ...EXPECTED_PAGEABLE_DYNAMIC_TOOL_ERROR_CODES,
      ...EXPECTED_NON_PAGEABLE_DYNAMIC_TOOL_ERROR_CODES,
    ].sort();
    expect(classifiedCodes).toEqual(expectedCodes);
    expect(new Set(classifiedCodes).size).toBe(classifiedCodes.length);
  });

  it("keeps the Datadog monitor pageable set in sync with the code classification", () => {
    expect(readTerraformPageableCodes().sort()).toEqual([...EXPECTED_PAGEABLE_DYNAMIC_TOOL_ERROR_CODES].sort());
    expect(readFileSync(MONITORS_TF, "utf8")).toContain(
      'join(" OR ", formatlist("error_code:%s", local.pageable_first_party_dynamic_tool_error_codes))',
    );
  });
});
