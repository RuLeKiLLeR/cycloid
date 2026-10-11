import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const DOGFOOD_E2E_SCRIPT = resolve(REPO_ROOT, "scripts/dogfood-e2e.sh");
const PACKAGE_JSON = resolve(REPO_ROOT, "package.json");

describe("dogfood:e2e wrapper", () => {
  const script = readFileSync(DOGFOOD_E2E_SCRIPT, "utf8");
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { scripts: Record<string, string> };

  it("is exposed as the dogfood:e2e npm script", () => {
    expect(packageJson.scripts["dogfood:e2e"]).toBe("bash scripts/dogfood-e2e.sh");
  });

  it("uses the dogfood app-runtime ports and starts tunnel before runtime services", () => {
    expect(script).toContain('API_PORT="3000"');
    expect(script).toContain('UI_PORT="5173"');
    expect(script.indexOf("bash scripts/dev-tunnel.sh &")).toBeLessThan(
      script.indexOf("bash scripts/dogfood-runtime.sh api &"),
    );
    expect(script.indexOf("wait_for_tunnel_url")).toBeLessThan(script.indexOf("bash scripts/dogfood-runtime.sh api &"));
  });

  it("shares one dogfood auth token across API and UI startup", () => {
    expect(script).toContain('export DOGFOOD_SESSION_TOKEN="${DOGFOOD_SESSION_TOKEN:-$(random_hex)}"');
    expect(script).toContain("bash scripts/dogfood-runtime.sh api &");
    expect(script).toContain("bash scripts/dogfood-runtime.sh ui &");
  });

  it("preflights local API, public tunnel, sandbox websocket, and UI", () => {
    expect(script).toContain("http://127.0.0.1:$API_PORT/api/health");
    expect(script).toContain("$TUNNEL_URL/api/health");
    expect(script).toContain("$TUNNEL_URL/api/sessions/dogfood-local-preflight/ws?type=sandbox");
    expect(script).toContain("http://127.0.0.1:$UI_PORT/auth/status");
    expect(script).toContain('"426"');
  });

  it("accepts NGROK_DOMAIN from shell env or .dev.vars", () => {
    expect(script).toContain("require_env_or_dev_var()");
    expect(script).toContain("require_env_or_dev_var NGROK_DOMAIN");
  });

  it("fails early when no local model provider key is configured", () => {
    expect(script).toContain("require_any_dev_var");
    expect(script).toContain(
      'require_any_dev_var "agent model access" OPENAI_API_KEY OPENAI_API_KEY_INTERNAL_REVIEW ARCANIST_OPENAI_API_KEY',
    );
  });
});
