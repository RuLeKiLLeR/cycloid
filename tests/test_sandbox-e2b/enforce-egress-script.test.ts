import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const ENFORCE_EGRESS_SH = resolve(REPO_ROOT, "apps/sandbox-e2b/enforce-egress.sh");

describe("enforce-egress.sh", () => {
  const source = readFileSync(ENFORCE_EGRESS_SH, "utf8");

  it("pins public egress to resolved allowlist addresses instead of provider-wide Cloudflare CIDRs", () => {
    expect(source).toContain("resolve_domain");
    expect(source).toContain('echo "[egress] allowed domain=${domain} ip=${ip}" >>"${LOG_PATH}"');
    expect(source).toContain("Provider-wide CDN CIDR exceptions");
    expect(source).not.toContain("CLOUDFLARE_IPV4_RANGES");
    expect(source).not.toContain("CLOUDFLARE_IPV6_RANGES");
    expect(source).not.toContain("add_cloudflare_cidr_rules");
    expect(source).not.toContain("allowed cloudflare-cidr");
  });

  it("supplements Fastly-fronted destinations (PyPI) with Fastly's published CIDR ranges", () => {
    // pypi.org / files.pythonhosted.org are Fastly-fronted (Anycast + short
    // TTLs), so point-in-time A/AAAA resolution can miss the IP a later pip
    // connection lands on. Trust Fastly's published ranges, but only when a
    // Fastly-fronted domain is allowlisted.
    expect(source).toMatch(/FASTLY_IPV4_RANGES\b/);
    expect(source).toMatch(/FASTLY_IPV6_RANGES\b/);
    // Representative published Fastly range.
    expect(source).toContain("151.101.0.0/16");
    // Gated on a Fastly-fronted domain being present in the allowlist.
    expect(source).toContain("allowlist_needs_fastly_ranges");
    expect(source).toContain("pypi.org");
    expect(source).toContain("files.pythonhosted.org");
    expect(source).toContain('add_fastly_cidr_rules "${CHAIN}"');
    expect(source).toMatch(/iptables -A "\$\{chain\}" -p tcp -d "\$\{cidr\}" -m multiport --dports 80,443 -j ACCEPT/);
    expect(source).toMatch(/ip6tables -A "\$\{chain\}" -p tcp -d "\$\{cidr\}" -m multiport --dports 80,443 -j ACCEPT/);
  });

  it("logs each Fastly CIDR rule for auditability", () => {
    expect(source).toMatch(/\[egress\] allowed fastly-cidr=\$\{cidr\}/);
  });

  it("supplements GitHub-hosted destinations with GitHub Meta API CIDRs", () => {
    // github.com uses a broad, shifting edge range; point-in-time A/AAAA
    // resolution can miss the exact IP a later clone/fetch lands on. Querying
    // the official Meta API lets the firewall trust GitHub's published web/api
    // and git ranges when GitHub-hosted domains are present in the allowlist.
    expect(source).toContain('GITHUB_META_ENDPOINT="https://api.github.com/meta"');
    expect(source).toContain("allowlist_needs_github_meta_ranges");
    expect(source).toContain("fetch_github_meta_cidrs");
    expect(source).toContain("add_github_meta_cidr_rules");
    expect(source).toContain("github.com");
    expect(source).toContain("api.github.com");
    expect(source).toContain("codeload.github.com");
    expect(source).toContain("objects.githubusercontent.com");
    expect(source).toContain("raw.githubusercontent.com");
    expect(source).toContain("ghcr.io");
    expect(source).toMatch(/\(\.web \/\/ \[\]\)/);
    expect(source).toMatch(/\(\.api \/\/ \[\]\)/);
    expect(source).toMatch(/\(\.git \/\/ \[\]\)/);
    expect(source).toMatch(/iptables -A "\$\{chain\}" -p tcp -d "\$\{cidr\}" -m multiport --dports 80,443 -j ACCEPT/);
    expect(source).toMatch(/ip6tables -A "\$\{chain\}" -p tcp -d "\$\{cidr\}" -m multiport --dports 80,443 -j ACCEPT/);
    expect(source).toContain('add_github_meta_cidr_rules "${CHAIN}"');
  });

  it("logs GitHub Meta API failures and accepted CIDRs for auditability", () => {
    expect(source).toContain(
      'GITHUB_META_SNAPSHOT_PATH="${ARCANIST_GITHUB_META_SNAPSHOT_PATH:-/app/github-meta-cidrs.snapshot}"',
    );
    expect(source).toContain('GITHUB_META_FETCH_MAX_ATTEMPTS="${ARCANIST_GITHUB_META_FETCH_MAX_ATTEMPTS:-3}"');
    expect(source).toContain('GITHUB_META_TOKEN="${ARCANIST_GITHUB_META_TOKEN:-}"');
    expect(source).toContain("Do not");
    expect(source).toContain("implicitly consume ambient GITHUB_TOKEN");
    expect(source).toContain('-H "Authorization: Bearer ${GITHUB_META_TOKEN}"');
    expect(source).toContain('-H "X-GitHub-Api-Version: 2022-11-28"');
    expect(source).toMatch(
      /\[egress\] github-meta-fetch-failed endpoint=\$\{GITHUB_META_ENDPOINT\} attempt=\$\{attempt\} max_attempts=\$\{max_attempts\}/,
    );
    expect(source).toMatch(/\[egress\] github-meta-snapshot-used path=\$\{GITHUB_META_SNAPSHOT_PATH\}/);
    expect(source).toMatch(
      /\[egress\] github-meta-cidrs-unavailable endpoint=\$\{GITHUB_META_ENDPOINT\} snapshot_path=\$\{GITHUB_META_SNAPSHOT_PATH\}/,
    );
    expect(source).toMatch(/\[egress\] allowed github-meta-cidr=\$\{cidr\} source=\$\{cidr_source\}/);
    expect(source).toContain("read_github_meta_snapshot_cidrs");
    expect(source).toContain('if ! add_github_meta_cidr_rules "${CHAIN}"; then');
    expect(source).toContain('echo "[egress] failed-closed reason=github-meta-cidrs-unavailable" >&2');
  });

  it("allows RFC1918 destinations so Docker host-port forwarding reaches container bridges", () => {
    // Docker DNATs `127.0.0.1:<host_port>` to a container bridge IP
    // (typically 172.17.0.0/16 for the default `docker0` bridge, or
    // another RFC1918 range for compose-created networks). After DNAT
    // the OUTPUT chain sees a destination in RFC1918 and an outbound
    // interface like `docker0` — NOT `lo` — so without these rules
    // the chain falls through to REJECT and `curl http://127.0.0.1:<host_port>`
    // from the sandbox host fails even though the container is healthy.
    expect(source).toContain("add_private_network_rules");
    expect(source).toContain('"10.0.0.0/8"');
    expect(source).toContain('"172.16.0.0/12"');
    expect(source).toContain('"192.168.0.0/16"');
    expect(source).toMatch(/-A "\$\{chain\}" -d "\$\{cidr\}" -j ACCEPT/);
    expect(source).toContain('add_private_network_rules iptables "${CHAIN}"');
    // RFC1918 is IPv4-only; ip6tables intentionally does NOT get this call.
    // Without this negative assertion a contributor could accidentally add
    // an ip6tables call (with a meaningless v4 CIDR) and no test would fail.
    expect(source).not.toContain("add_private_network_rules ip6tables");
  });

  it("logs each private-network rule for auditability", () => {
    expect(source).toMatch(/\[egress\] allowed private-network=\$\{cidr\}/);
  });
});
