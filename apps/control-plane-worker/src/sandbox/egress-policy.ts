import type { BusinessEgressPolicy } from "../../../../shared/types/business-egress-policy.js";
import { normalizeEgressDomains } from "../../../../shared/types/business-egress-policy.js";
import { isInternalCycloidBusinessId } from "../constants/businesses";
import type { Env } from "../types";

type E2BSandboxNetworkPolicy = {
  allowInternetAccess?: boolean;
  network?: {
    allowPublicTraffic: boolean;
    allowOut?: string[];
    denyOut?: string[];
  };
};

type SandboxEgressAllowlist = {
  domains: string[];
  envs: Record<string, string>;
  hasCustomDomainPolicy: boolean;
  unrestrictedInternalBusiness: boolean;
};

const DEFAULT_SANDBOX_EGRESS_ALLOWLIST = [
  "app.trycycloid.com",
  "qa.app.trycycloid.com",
  "e2b.dev",
  // The local Cycloid-on-Cycloid verifier runs the control plane inside an
  // E2B sandbox, so that parent sandbox must call E2B's control API to create
  // the child session sandbox.
  "api.e2b.dev",
  "api.github.com",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  // dbt package registry -- required by `dbt deps` before local parse/semantic
  // model verification can install Hub packages into `dbt_packages/`.
  "hub.getdbt.com",
  "api.openai.com",
  "api.anthropic.com",
  "inference.baseten.co",
  "api.notion.com",
  // First-party dynamic tools call these APIs from the sandbox bridge.
  // api.linear.app is Cloudflare-fronted; keep it explicitly allowlisted so the
  // sandbox pins egress to that named host instead of relying on provider-wide
  // CDN exceptions. api.atlassian.com is CloudFront-fronted and is blocked
  // without this entry (every jira.* tool call fails with ECONNREFUSED).
  "api.linear.app",
  "api.atlassian.com",
  "sentry.io",
  "slack.com",
  "api.slack.com",
  "www.braintrust.dev",
  "app.launchdarkly.com",
  "api.datadoghq.com",
  "api.us3.datadoghq.com",
  "api.us5.datadoghq.com",
  "api.datadoghq.eu",
  "api.ap1.datadoghq.com",
  "api.ap2.datadoghq.com",
  "api.braintrust.dev",
  "api-eu.braintrust.dev",
  "api.ddog-gov.com",
  "api.us2.ddog-gov.com",
  "us5.datadoghq.com",
  // Platform Datadog log intake (http-intake.logs.*) is no longer reachable from
  // the sandbox: the control plane now forwards platform telemetry via the
  // session telemetry broker, injecting the platform secret server-side. The
  // remaining api.*datadoghq.com / *.braintrust.dev / sentry.io /
  // app.launchdarkly.com hosts stay allowlisted because customer-facing
  // first-party dynamic tools call them directly.
  // Cloudflare D1 API -- required so the first-party `query_d1` dynamic tool can
  // reach the customer's connected D1 database. Without it, the read-only query
  // tool fails at the egress firewall before reaching Cloudflare.
  "api.cloudflare.com",
  // Container registries -- required by the E2E runtime so customer compose
  // stacks can pull base images at session start. Same risk class as the
  // package-registry entries above (npmjs, pypi). Without these, every
  // `cycloid-app start` against a repo whose compose references a Docker
  // Hub or GHCR image fails with "registry connection refused".
  "registry-1.docker.io", // Docker Hub registry API
  "auth.docker.io", // Docker Hub token endpoint (required even for anonymous public-image pulls)
  "production.cloudflare.docker.com", // Docker Hub layer CDN observed in some regions
  "production.cloudfront.docker.com", // Docker Hub layer CDN observed in E2B sessions
  "ghcr.io", // GitHub Container Registry API
  "pkg-containers.githubusercontent.com", // GHCR layer CDN
  // Browser-binary CDNs -- required when the agent runs `npx playwright install`
  // or any tool that auto-downloads Chromium / Firefox / WebKit. Without these,
  // customer repos with Playwright as a devDep can't run `npx playwright test`
  // through `cycloid-app run` because the browser download fails. Note:
  // `/usr/bin/chromium` is also baked into the sandbox image as a fallback for
  // simple screenshot use cases.
  "playwright.azureedge.net", // Playwright legacy CDN (still primary as of 2024)
  "cdn.playwright.dev", // Playwright newer CDN endpoint
  // ngrok tunnels -- required when repo runtime env provides NGROK_AUTHTOKEN /
  // NGROK_AUTH_TOKEN and the agent runs `ngrok http` or `ngrok tcp` inside the
  // sandbox. The policy accepts exact hosts only, so list the agent control/API,
  // revocation-list, and standard regional tunnel relay endpoints explicitly.
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
  // Terraform verification needs provider schemas and Terraform Cloud API access
  // for workspaces that use `terraform { cloud { ... } }`.
  "app.terraform.io",
  "registry.terraform.io",
  "releases.hashicorp.com",
];

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function resolveE2BSandboxNetworkPolicy(env: Pick<Env, E2BSandboxNetworkPolicyEnvKey>): E2BSandboxNetworkPolicy {
  const allowInternetAccess = parseOptionalBooleanEnv(
    env.E2B_SANDBOX_ALLOW_INTERNET_ACCESS,
    "E2B_SANDBOX_ALLOW_INTERNET_ACCESS",
  );
  const allowOut = parseAddressListEnv(env.E2B_SANDBOX_NETWORK_ALLOW_OUT, "E2B_SANDBOX_NETWORK_ALLOW_OUT");
  const denyOut = parseAddressListEnv(env.E2B_SANDBOX_NETWORK_DENY_OUT, "E2B_SANDBOX_NETWORK_DENY_OUT");

  return {
    ...(allowInternetAccess !== undefined ? { allowInternetAccess } : {}),
    network: {
      // Keep E2B sandbox URLs private. The control-plane live desktop proxy
      // authenticates its upstream noVNC request with the traffic token.
      allowPublicTraffic: false,
      ...(allowOut ? { allowOut } : {}),
      ...(denyOut ? { denyOut } : {}),
    },
  };
}

export function hasE2BSandboxOutboundPolicy(policy: E2BSandboxNetworkPolicy): boolean {
  return policy.allowInternetAccess === false || Boolean(policy.network?.allowOut || policy.network?.denyOut);
}

export function resolveSandboxEgressAllowlist(
  env: Pick<Env, SandboxEgressAllowlistEnvKey>,
  context: {
    businessId?: string | null;
    controlPlaneUrl?: string | null;
    businessEgressPolicy?: BusinessEgressPolicy | null;
  } = {},
): SandboxEgressAllowlist {
  if (context.businessId && isInternalCycloidBusinessId(context.businessId)) {
    return {
      domains: [],
      envs: {
        ARCANIST_SANDBOX_EGRESS_ENFORCEMENT: "0",
      },
      hasCustomDomainPolicy: false,
      unrestrictedInternalBusiness: true,
    };
  }

  const domains = new Set<string>();
  const customDomains = new Set<string>();
  const hasD1BusinessPolicy = Boolean(context.businessEgressPolicy);
  const hasBusinessOverrides =
    hasD1BusinessPolicy || hasAnyBusinessOverrideDomains(env.E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON);
  for (const domain of DEFAULT_SANDBOX_EGRESS_ALLOWLIST) {
    domains.add(domain);
  }
  const controlPlaneHost = hostFromUrl(context.controlPlaneUrl);
  if (controlPlaneHost) domains.add(controlPlaneHost);
  const braintrustAppHost = hostFromUrl(env.BRAINTRUST_APP_URL);
  if (braintrustAppHost) domains.add(braintrustAppHost);
  const braintrustApiHost = hostFromUrl(env.BRAINTRUST_API_URL);
  if (braintrustApiHost) domains.add(braintrustApiHost);

  for (const domain of parseDomainListEnv(env.E2B_SANDBOX_EGRESS_ALLOWLIST, "E2B_SANDBOX_EGRESS_ALLOWLIST")) {
    domains.add(domain);
    customDomains.add(domain);
  }
  const businessDomains = context.businessEgressPolicy
    ? normalizeEgressDomains(context.businessEgressPolicy.domains, "businessEgressPolicy.domains")
    : parseBusinessOverrideDomains(env.E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON, context.businessId);
  for (const domain of businessDomains) {
    domains.add(domain);
    customDomains.add(domain);
  }

  const sortedDomains = [...domains].sort();
  return {
    domains: sortedDomains,
    envs: {
      ARCANIST_SANDBOX_EGRESS_ENFORCEMENT: "1",
      ARCANIST_SANDBOX_EGRESS_ALLOWLIST: sortedDomains.join(","),
    },
    hasCustomDomainPolicy: customDomains.size > 0 || hasBusinessOverrides,
    unrestrictedInternalBusiness: false,
  };
}

type E2BSandboxNetworkPolicyEnvKey =
  "E2B_SANDBOX_ALLOW_INTERNET_ACCESS" | "E2B_SANDBOX_NETWORK_ALLOW_OUT" | "E2B_SANDBOX_NETWORK_DENY_OUT";

type SandboxEgressAllowlistEnvKey =
  | "E2B_SANDBOX_EGRESS_ALLOWLIST"
  | "E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON"
  | "BRAINTRUST_API_URL"
  | "BRAINTRUST_APP_URL";

function parseOptionalBooleanEnv(value: string | undefined, key: string): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(`${key} must be a boolean value`);
}

function parseBusinessOverrideDomains(value: string | undefined, businessId?: string | null): string[] {
  if (value === undefined || value.trim() === "" || !businessId) return [];
  const record = parseBusinessOverrideRecord(value);
  const override = record[businessId];
  if (override === undefined) return [];
  if (!Array.isArray(override) || override.some((entry) => typeof entry !== "string")) {
    throw new Error("E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON values must be arrays of strings");
  }
  return normalizeDomainEntries(override, "E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON");
}

function hasAnyBusinessOverrideDomains(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  const record = parseBusinessOverrideRecord(value);
  return Object.values(record).some((override) => {
    if (!Array.isArray(override) || override.some((entry) => typeof entry !== "string")) {
      throw new Error("E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON values must be arrays of strings");
    }
    return normalizeDomainEntries(override, "E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON").length > 0;
  });
}

function parseBusinessOverrideRecord(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("E2B_SANDBOX_EGRESS_ALLOWLIST_BY_BUSINESS_JSON must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseDomainListEnv(value: string | undefined, key: string): string[] {
  if (value === undefined || value.trim() === "") return [];
  return normalizeDomainEntries(parseListEnv(value, key), key);
}

function normalizeDomainEntries(entries: string[], key: string): string[] {
  return normalizeEgressDomains(entries, key);
}

function hostFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseAddressListEnv(value: string | undefined, key: string): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const entries = parseListEnv(value, key);
  const unique = [...new Set(entries.map((entry) => entry.trim()).filter(Boolean))];
  if (unique.length === 0) return undefined;
  for (const entry of unique) {
    assertValidNetworkAddress(entry, key);
  }
  return unique;
}

function parseListEnv(value: string, key: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`${key} must be a JSON array or comma-separated list`);
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      throw new Error(`${key} JSON value must be an array of strings`);
    }
    return parsed;
  }
  return trimmed.split(/[,\s]+/);
}

function assertValidNetworkAddress(value: string, key: string): void {
  const [address, prefix, extra] = value.split("/");
  if (extra !== undefined || !address || (prefix !== undefined && !isValidCidrPrefix(address, prefix))) {
    throw new Error(`${key} entries must be IP addresses or CIDR blocks`);
  }
  if (!isIPv4Address(address) && !isIPv6Address(address)) {
    throw new Error(`${key} entries must be IP addresses or CIDR blocks`);
  }
}

function isValidCidrPrefix(address: string, prefix: string): boolean {
  if (!/^\d+$/.test(prefix)) return false;
  const bits = Number(prefix);
  if (isIPv4Address(address)) return bits >= 0 && bits <= 32;
  if (isIPv6Address(address)) return bits >= 0 && bits <= 128;
  return false;
}

function isIPv4Address(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255 && String(Number(part)) === part,
    )
  );
}

function isIPv6Address(value: string): boolean {
  const zoneSeparatorIndex = value.indexOf("%");
  const address = zoneSeparatorIndex === -1 ? value : value.slice(0, zoneSeparatorIndex);
  const zone = zoneSeparatorIndex === -1 ? undefined : value.slice(zoneSeparatorIndex + 1);
  if (!address.includes(":") || (zone !== undefined && !/^[A-Za-z0-9_.-]+$/.test(zone))) {
    return false;
  }
  try {
    new URL(`http://[${address}]/`);
    return true;
  } catch {
    return false;
  }
}
