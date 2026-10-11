import { describe, expect, it } from "vitest";

import { CLI_TOKEN_ROUTE_ALLOWLIST } from "../../apps/control-plane-worker/src/constants/cli-tokens";
import { buildRouteMatchers } from "../../apps/control-plane-worker/src/router";

const WRITE_MATCHERS = buildRouteMatchers(CLI_TOKEN_ROUTE_ALLOWLIST.write);
const READ_MATCHERS = buildRouteMatchers(CLI_TOKEN_ROUTE_ALLOWLIST.read);

function allows(matchers: Array<{ method: string; pattern: RegExp }>, method: string, path: string): boolean {
  return matchers.some((entry) => entry.method === method && entry.pattern.test(path));
}

const BASE = "/api/businesses/biz-1/repos/trycycloid/mia-copy-4/test-credentials";

describe("CLI token test-credentials allowlist", () => {
  it("write scope can set, delete, and list (names-only) test credentials", () => {
    expect(allows(WRITE_MATCHERS, "PUT", `${BASE}/mia-anthropic-api-key`)).toBe(true);
    expect(allows(WRITE_MATCHERS, "DELETE", `${BASE}/mia-anthropic-api-key`)).toBe(true);
    expect(allows(WRITE_MATCHERS, "GET", BASE)).toBe(true);
  });

  it("read scope has no test-credentials access", () => {
    expect(allows(READ_MATCHERS, "PUT", `${BASE}/mia-anthropic-api-key`)).toBe(false);
    expect(allows(READ_MATCHERS, "DELETE", `${BASE}/mia-anthropic-api-key`)).toBe(false);
    expect(allows(READ_MATCHERS, "GET", BASE)).toBe(false);
  });

  it("repository environment-variable routes remain user-session-only", () => {
    const envVarPath = "/api/businesses/biz-1/repos/trycycloid/mia-copy-4/environment-variables/SOME_KEY";
    expect(allows(WRITE_MATCHERS, "PUT", envVarPath)).toBe(false);
    expect(allows(WRITE_MATCHERS, "DELETE", envVarPath)).toBe(false);
  });
});
