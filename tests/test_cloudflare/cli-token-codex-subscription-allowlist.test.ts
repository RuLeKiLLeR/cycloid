import { describe, expect, it } from "vitest";

import { CLI_TOKEN_ROUTE_ALLOWLIST } from "../../apps/control-plane-worker/src/constants/cli-tokens";
import { buildRouteMatchers } from "../../apps/control-plane-worker/src/router";

const WRITE_MATCHERS = buildRouteMatchers(CLI_TOKEN_ROUTE_ALLOWLIST.write);
const READ_MATCHERS = buildRouteMatchers(CLI_TOKEN_ROUTE_ALLOWLIST.read);

function allows(matchers: Array<{ method: string; pattern: RegExp }>, method: string, path: string): boolean {
  return matchers.some((entry) => entry.method === method && entry.pattern.test(path));
}

const STATE = "/api/settings/codex-subscription";
const AUTH_JSON = "/api/settings/codex-subscription/auth-json";
const ENABLED = "/api/settings/codex-subscription/enabled";

// ARC-1517: `cycloid codex login/status/logout/use` drive the per-user Codex
// subscription credential over CLI tokens. Write scope manages it; read scope may
// only inspect status.
describe("CLI token Codex subscription allowlist", () => {
  it("write scope can read status, save/clear the credential, and toggle the selector", () => {
    expect(allows(WRITE_MATCHERS, "GET", STATE)).toBe(true);
    expect(allows(WRITE_MATCHERS, "PUT", AUTH_JSON)).toBe(true);
    expect(allows(WRITE_MATCHERS, "DELETE", AUTH_JSON)).toBe(true);
    expect(allows(WRITE_MATCHERS, "PUT", ENABLED)).toBe(true);
  });

  it("read scope can inspect status but cannot mutate the credential or selector", () => {
    expect(allows(READ_MATCHERS, "GET", STATE)).toBe(true);
    expect(allows(READ_MATCHERS, "PUT", AUTH_JSON)).toBe(false);
    expect(allows(READ_MATCHERS, "DELETE", AUTH_JSON)).toBe(false);
    expect(allows(READ_MATCHERS, "PUT", ENABLED)).toBe(false);
  });

  it("does not open other settings routes to CLI tokens", () => {
    expect(allows(WRITE_MATCHERS, "PUT", "/api/settings/api-keys/openai")).toBe(false);
    expect(allows(WRITE_MATCHERS, "PUT", "/api/settings")).toBe(false);
  });
});
