import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const EGRESS_SMOKE_TS = resolve(REPO_ROOT, "scripts/e2b-egress-smoke.ts");

describe("e2b egress smoke", () => {
  const source = readFileSync(EGRESS_SMOKE_TS, "utf8");

  it("uses a non-allowlisted Cloudflare-fronted deny target", () => {
    expect(source).toContain('const DENIED_HOST = "www.cloudflare.com";');
    expect(source).toContain("const DENIED_URL = `https://${DENIED_HOST}`;");
    expect(source).not.toContain("https://example.com");
    expect(source).not.toContain("blocked domain=example.com");
    expect(source).not.toContain('const DENIED_HOST = "www.google.com";');
  });

  it("keeps the allowed probe scoped to api.github.com", () => {
    expect(source).toContain('const ALLOWED_HOST = "api.github.com";');
    expect(source).toContain("const ALLOWED_URL = `https://${ALLOWED_HOST}`;");
  });

  it("also probes an allowlisted Cloudflare-backed host", () => {
    expect(source).toContain('const ALLOWED_CLOUDFLARE_HOST = "app.trycycloid.com";');
    expect(source).toContain("const ALLOWED_CLOUDFLARE_URL = `https://${ALLOWED_CLOUDFLARE_HOST}`;");
    expect(source).toContain('export ARCANIST_SANDBOX_EGRESS_ALLOWLIST="${ALLOWED_HOST},${ALLOWED_CLOUDFLARE_HOST}"');
  });

  it("pins the allowed curl probe to an address installed in the egress chain", () => {
    expect(source).toContain('CURL_PATH="$(command -v curl)"');
    expect(source).toContain('if [ "${CURL_PATH}" != "/usr/local/bin/curl" ]; then');
    expect(source).toContain('echo "unexpected curl path: ${CURL_PATH}" >&2');
    expect(source).toContain('grep -q "curl to non-allowlisted domain" /usr/local/bin/curl || {');
    expect(source).toContain('echo "curl wrapper missing hostname allowlist policy" >&2');
    expect(source).toContain('ALLOWED_IP="$(awk');
    expect(source).toContain('ALLOWED_CLOUDFLARE_IP="$(awk');
    expect(source).toContain("allowed domain=");
    expect(source).toContain('--resolve "${ALLOWED_HOST}:443:${ALLOWED_IP}"');
    expect(source).toContain('--resolve "${ALLOWED_CLOUDFLARE_HOST}:443:${ALLOWED_CLOUDFLARE_IP}"');
  });

  it("uses only GitHub auth for GitHub probes when available", () => {
    expect(source).toContain("process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()");
    expect(source).not.toContain("process.env.CI_AUTOMATION_TOKEN?.trim()");
    expect(source).toContain('export ARCANIST_GITHUB_META_TOKEN="${GITHUB_TOKEN}"');
    expect(source).toContain('sudo -E /usr/local/sbin/cycloid-enforce-egress "${ARCANIST_SANDBOX_EGRESS_ALLOWLIST}"');
    expect(source).toContain("unset ARCANIST_GITHUB_META_TOKEN");
    expect(source).toContain('-H "Authorization: Bearer ${GITHUB_TOKEN}"');
    expect(source).toContain("envs: { GITHUB_TOKEN: githubToken }");
    expect(source).not.toContain("sudo env ARCANIST_GITHUB_META_TOKEN");
  });
});
