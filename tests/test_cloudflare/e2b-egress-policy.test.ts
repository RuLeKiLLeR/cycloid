import { describe, expect, it } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import {
  hasE2BSandboxOutboundPolicy,
  resolveE2BSandboxNetworkPolicy,
  resolveSandboxEgressAllowlist,
} from "../../apps/control-plane-worker/src/sandbox/egress-policy";

describe("resolveE2BSandboxNetworkPolicy", () => {
  it("keeps E2B sandbox URLs private while the server-side proxy authenticates with a traffic token", () => {
    expect(resolveE2BSandboxNetworkPolicy({})).toEqual({
      network: {
        allowPublicTraffic: false,
      },
    });
  });

  it("parses allow internet access and comma-separated network lists", () => {
    expect(
      resolveE2BSandboxNetworkPolicy({
        E2B_SANDBOX_ALLOW_INTERNET_ACCESS: "false",
        E2B_SANDBOX_NETWORK_ALLOW_OUT: "1.1.1.1,8.8.8.0/24",
        E2B_SANDBOX_NETWORK_DENY_OUT: "0.0.0.0/0",
      }),
    ).toEqual({
      allowInternetAccess: false,
      network: {
        allowPublicTraffic: false,
        allowOut: ["1.1.1.1", "8.8.8.0/24"],
        denyOut: ["0.0.0.0/0"],
      },
    });
  });

  it("parses JSON network lists and removes duplicates", () => {
    expect(
      resolveE2BSandboxNetworkPolicy({
        E2B_SANDBOX_ALLOW_INTERNET_ACCESS: "yes",
        E2B_SANDBOX_NETWORK_ALLOW_OUT: '["2001:4860:4860::8888","2001:4860:4860::8888"]',
      }),
    ).toEqual({
      allowInternetAccess: true,
      network: {
        allowPublicTraffic: false,
        allowOut: ["2001:4860:4860::8888"],
      },
    });
  });

  it("treats only restrictive or address-list settings as outbound policy", () => {
    expect(hasE2BSandboxOutboundPolicy(resolveE2BSandboxNetworkPolicy({}))).toBe(false);
    expect(
      hasE2BSandboxOutboundPolicy(
        resolveE2BSandboxNetworkPolicy({
          E2B_SANDBOX_ALLOW_INTERNET_ACCESS: "true",
        }),
      ),
    ).toBe(false);
    expect(
      hasE2BSandboxOutboundPolicy(
        resolveE2BSandboxNetworkPolicy({
          E2B_SANDBOX_ALLOW_INTERNET_ACCESS: "false",
        }),
      ),
    ).toBe(true);
    expect(
      hasE2BSandboxOutboundPolicy(
        resolveE2BSandboxNetworkPolicy({
          E2B_SANDBOX_NETWORK_ALLOW_OUT: "1.1.1.1",
        }),
      ),
    ).toBe(true);
  });

  it("rejects hostnames because E2B network policy accepts IPs and CIDR blocks", () => {
    expect(() =>
      resolveE2BSandboxNetworkPolicy({
        E2B_SANDBOX_NETWORK_ALLOW_OUT: "github.com",
      }),
    ).toThrow("E2B_SANDBOX_NETWORK_ALLOW_OUT entries must be IP addresses or CIDR blocks");
  });

  it("rejects invalid CIDR prefixes", () => {
    expect(() =>
      resolveE2BSandboxNetworkPolicy({
        E2B_SANDBOX_NETWORK_DENY_OUT: "10.0.0.0/33",
      }),
    ).toThrow("E2B_SANDBOX_NETWORK_DENY_OUT entries must be IP addresses or CIDR blocks");
  });

  it("rejects structurally invalid IPv6 addresses", () => {
    for (const value of [
      "2001:::1",
      "fe80:::/",
      "::::",
      "a:b",
      "dead:beef",
      "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "1.2.3.4:5.6.7.8",
    ]) {
      expect(() =>
        resolveE2BSandboxNetworkPolicy({
          E2B_SANDBOX_NETWORK_ALLOW_OUT: value,
        }),
      ).toThrow("E2B_SANDBOX_NETWORK_ALLOW_OUT entries must be IP addresses or CIDR blocks");
    }
  });

  it("accepts compressed, scoped, and CIDR IPv6 addresses", () => {
    expect(
      resolveE2BSandboxNetworkPolicy({
        E2B_SANDBOX_NETWORK_ALLOW_OUT: '["::1","2001:db8::1/64","fe80::1%eth0"]',
      }),
    ).toEqual({
      network: {
        allowPublicTraffic: false,
        allowOut: ["::1", "2001:db8::1/64", "fe80::1%eth0"],
      },
    });
  });
});

describe("resolveSandboxEgressAllowlist", () => {
  it("returns the default domain allowlist and the control-plane host", () => {
    const policy = resolveSandboxEgressAllowlist({}, { controlPlaneUrl: "https://control.example.com" });

    expect(policy.domains).toContain("api.github.com");
    expect(policy.domains).toContain("github.com");
    expect(policy.domains).toContain("registry.npmjs.org");
    expect(policy.domains).toContain("api.openai.com");
    expect(policy.domains).toContain("api.e2b.dev");
    expect(policy.domains).toContain("api.linear.app");
    expect(policy.domains).toContain("api.atlassian.com");
    expect(policy.domains).toContain("control.example.com");
    expect(policy.envs).toMatchObject({
      ARCANIST_SANDBOX_EGRESS_ENFORCEMENT: "1",
    });
    expect(policy.envs.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toContain("api.github.com");
    expect(policy.unrestrictedInternalBusiness).toBe(false);
  });

  it("includes container-registry hosts so customer compose stacks can pull base images", () => {
    // The E2E runtime feature relies on `cycloid-app start` running
    // `docker compose up`, which in turn pulls base images from public
    // registries. Without these hosts in the default allowlist, every
    // customer whose compose references a non-cached Docker Hub or GHCR
    // image fails with "registry connection refused" the first time their
    // session boots. Same risk class as the package-registry entries
    // (npmjs, pypi) already in the default.
    const policy = resolveSandboxEgressAllowlist({});

    // Docker Hub: registry API + token endpoint + layer CDN
    expect(policy.domains).toContain("registry-1.docker.io");
    expect(policy.domains).toContain("auth.docker.io");
    expect(policy.domains).toContain("production.cloudflare.docker.com");
    expect(policy.domains).toContain("production.cloudfront.docker.com");

    // GitHub Container Registry: API + layer CDN
    expect(policy.domains).toContain("ghcr.io");
    expect(policy.domains).toContain("pkg-containers.githubusercontent.com");
  });

  it("includes Playwright browser-binary CDN hosts so `npx playwright install` works", () => {
    // Customer repos with Playwright as a devDep run
    // `npx playwright install` (or it gets triggered transitively) before
    // `npx playwright test` can launch a browser. The download targets
    // playwright.azureedge.net / cdn.playwright.dev. Without these in the
    // default allowlist, the install fails with "CDN unreachable" and the
    // E2E test command can't proceed.
    const policy = resolveSandboxEgressAllowlist({});
    expect(policy.domains).toContain("playwright.azureedge.net");
    expect(policy.domains).toContain("cdn.playwright.dev");
  });

  it("includes Terraform Cloud and provider registry hosts so infra verification can plan", () => {
    const policy = resolveSandboxEgressAllowlist({});

    expect(policy.domains).toContain("app.terraform.io");
    expect(policy.domains).toContain("registry.terraform.io");
    expect(policy.domains).toContain("releases.hashicorp.com");
  });

  it("includes ngrok runtime hosts so user-requested tunnels work under egress enforcement", () => {
    const policy = resolveSandboxEgressAllowlist({});

    expect(policy.domains).toEqual(
      expect.arrayContaining([
        "connect.ngrok-agent.com",
        "crl.ngrok-agent.com",
        "api.ngrok.com",
        "tunnel.ngrok.com",
        "tunnel.us.ngrok.com",
        "tunnel.eu.ngrok.com",
        "tunnel.ap.ngrok.com",
        "tunnel.au.ngrok.com",
        "tunnel.sa.ngrok.com",
        "tunnel.jp.ngrok.com",
        "tunnel.in.ngrok.com",
      ]),
    );
  });

  it("includes dbt Hub so local dbt package resolution can run before parse verification", () => {
    const policy = resolveSandboxEgressAllowlist({});

    expect(policy.domains).toContain("hub.getdbt.com");
  });

  it("includes Sentry API hosts so first-party Sentry tools can reach sentry.io", () => {
    const policy = resolveSandboxEgressAllowlist({});

    expect(policy.domains).toContain("sentry.io");
  });

  it("includes Braintrust hosts for bridge logging and SDK compatibility", () => {
    const policy = resolveSandboxEgressAllowlist({});

    expect(policy.domains).toContain("www.braintrust.dev");
    expect(policy.domains).toContain("api.braintrust.dev");
  });

  it("includes the LaunchDarkly API host so first-party flag tools can reach app.launchdarkly.com", () => {
    const policy = resolveSandboxEgressAllowlist({});

    expect(policy.domains).toContain("app.launchdarkly.com");
  });

  it("includes Braintrust override hosts when the environment points the SDK at non-default app or API URLs", () => {
    const policy = resolveSandboxEgressAllowlist({
      BRAINTRUST_APP_URL: "https://braintrust-app.example.com",
      BRAINTRUST_API_URL: "https://braintrust-api.example.com",
    });

    expect(policy.domains).toContain("braintrust-app.example.com");
    expect(policy.domains).toContain("braintrust-api.example.com");
  });

  it("includes Notion API hosts so first-party Notion tools can reach api.notion.com", () => {
    const policy = resolveSandboxEgressAllowlist({});

    expect(policy.domains).toContain("api.notion.com");
  });

  it("includes the Cloudflare API host so the first-party query_d1 tool can reach api.cloudflare.com", () => {
    const policy = resolveSandboxEgressAllowlist({});

    expect(policy.domains).toContain("api.cloudflare.com");
  });

  it("drops the platform Datadog log intake host now that telemetry flows via the control-plane broker", () => {
    const policy = resolveSandboxEgressAllowlist({});

    expect(policy.domains).toContain("us5.datadoghq.com");
    // Platform DD logs now ship through the control-plane telemetry broker, so
    // the sandbox no longer talks to the log intake host directly.
    expect(policy.domains).not.toContain("http-intake.logs.us5.datadoghq.com");
    // OTLP trace export was removed; the sandbox no longer needs the OTLP intake host.
    expect(policy.domains).not.toContain("otlp.us5.datadoghq.com");
  });

  it("includes Datadog API hosts so first-party Datadog tools can reach supported customer sites", () => {
    const policy = resolveSandboxEgressAllowlist({});

    expect(policy.domains).toEqual(
      expect.arrayContaining([
        "api.datadoghq.com",
        "api.us3.datadoghq.com",
        "api.us5.datadoghq.com",
        "api.datadoghq.eu",
        "api.ap1.datadoghq.com",
        "api.ap2.datadoghq.com",
        "api.ddog-gov.com",
        "api.us2.ddog-gov.com",
      ]),
    );
  });

  it("merges global and business-specific domain overrides", () => {
    const policy = resolveSandboxEgressAllowlist(
      {
        E2B_SANDBOX_EGRESS_ALLOWLIST: "packages.acme.test,API.GITHUB.COM",
        E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON: JSON.stringify({
          "biz-1": ["registry.acme.test", "packages.acme.test"],
          "biz-2": ["other.acme.test"],
        }),
      },
      { businessId: "biz-1" },
    );

    expect(policy.domains).toContain("packages.acme.test");
    expect(policy.domains).toContain("registry.acme.test");
    expect(policy.domains).not.toContain("other.acme.test");
    expect(policy.domains.filter((domain) => domain === "api.github.com")).toHaveLength(1);
  });

  it("prefers the D1 business egress policy over legacy env business overrides", () => {
    const policy = resolveSandboxEgressAllowlist(
      {
        E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON: JSON.stringify({
          "biz-1": ["legacy.acme.test"],
        }),
      },
      {
        businessId: "biz-1",
        businessEgressPolicy: { domains: ["D1.ACME.test", "d1.acme.test"] },
      },
    );

    expect(policy.domains).toContain("d1.acme.test");
    expect(policy.domains).not.toContain("legacy.acme.test");
    expect(policy.domains).toContain("api.github.com");
  });

  it("disables domain egress enforcement for the prod internal Cycloid business", () => {
    const policy = resolveSandboxEgressAllowlist(
      {
        E2B_SANDBOX_EGRESS_ALLOWLIST: "packages.acme.test",
      },
      { businessId: SEEDED_BUSINESS_IDS.cycloid },
    );

    expect(policy).toEqual({
      domains: [],
      envs: {
        ARCANIST_SANDBOX_EGRESS_ENFORCEMENT: "0",
      },
      hasCustomDomainPolicy: false,
      unrestrictedInternalBusiness: true,
    });
    expect(policy.envs.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toBeUndefined();
  });

  it("disables domain egress enforcement for the QA internal Cycloid business", () => {
    const policy = resolveSandboxEgressAllowlist({}, { businessId: SEEDED_BUSINESS_IDS.cycloidQa });

    expect(policy).toEqual({
      domains: [],
      envs: {
        ARCANIST_SANDBOX_EGRESS_ENFORCEMENT: "0",
      },
      hasCustomDomainPolicy: false,
      unrestrictedInternalBusiness: true,
    });
  });

  it("keeps domain egress enforcement for customer businesses and missing business context", () => {
    const customerPolicy = resolveSandboxEgressAllowlist(
      {
        E2B_SANDBOX_EGRESS_ALLOWLIST: "packages.acme.test",
      },
      { businessId: "customer-business-id" },
    );
    const anonymousPolicy = resolveSandboxEgressAllowlist({});

    expect(customerPolicy.envs.ARCANIST_SANDBOX_EGRESS_ENFORCEMENT).toBe("1");
    expect(customerPolicy.envs.ARCANIST_SANDBOX_EGRESS_ALLOWLIST).toContain("packages.acme.test");
    expect(customerPolicy.unrestrictedInternalBusiness).toBe(false);
    expect(anonymousPolicy.envs.ARCANIST_SANDBOX_EGRESS_ENFORCEMENT).toBe("1");
    expect(anonymousPolicy.unrestrictedInternalBusiness).toBe(false);
  });

  it("lets the internal Cycloid business override D1 and legacy business domain policies", () => {
    const policy = resolveSandboxEgressAllowlist(
      {
        E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON: JSON.stringify({
          [SEEDED_BUSINESS_IDS.cycloid]: ["legacy.acme.test"],
        }),
      },
      {
        businessId: SEEDED_BUSINESS_IDS.cycloid,
        businessEgressPolicy: { domains: ["d1.acme.test"] },
      },
    );

    expect(policy).toEqual({
      domains: [],
      envs: {
        ARCANIST_SANDBOX_EGRESS_ENFORCEMENT: "0",
      },
      hasCustomDomainPolicy: false,
      unrestrictedInternalBusiness: true,
    });
  });

  it("rejects URL, port, IP, and CIDR business policy entries", () => {
    for (const domain of ["https://api.acme.test", "api.acme.test:443", "127.0.0.1", "10.0.0.0/8"]) {
      expect(() => resolveSandboxEgressAllowlist({}, { businessEgressPolicy: { domains: [domain] } })).toThrow(
        "businessEgressPolicy.domains entries must be exact domain names",
      );
    }
  });

  it("rejects oversized business egress policies before they reach sandbox env", () => {
    expect(() =>
      resolveSandboxEgressAllowlist(
        {},
        { businessEgressPolicy: { domains: Array.from({ length: 101 }, (_, index) => `api-${index}.acme.test`) } },
      ),
    ).toThrow("businessEgressPolicy.domains must contain at most 100 domain names");

    expect(() =>
      resolveSandboxEgressAllowlist({}, { businessEgressPolicy: { domains: [`${"a".repeat(250)}.test`] } }),
    ).toThrow("businessEgressPolicy.domains entries must be exact domain names");
  });

  it("treats business-specific overrides as a custom policy even without a business context", () => {
    const policy = resolveSandboxEgressAllowlist({
      E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON: JSON.stringify({
        "biz-1": ["registry.acme.test"],
      }),
    });

    expect(policy.domains).not.toContain("registry.acme.test");
  });

  it("rejects wildcard and malformed domain overrides", () => {
    expect(() =>
      resolveSandboxEgressAllowlist({
        E2B_SANDBOX_EGRESS_ALLOWLIST: "*.example.com",
      }),
    ).toThrow("E2B_SANDBOX_EGRESS_ALLOWLIST entries must be exact domain names");

    expect(() =>
      resolveSandboxEgressAllowlist(
        {
          E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON: JSON.stringify({ "biz-1": ["-bad.example.com"] }),
        },
        { businessId: "biz-1" },
      ),
    ).toThrow("E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON entries must be exact domain names");
  });
});
