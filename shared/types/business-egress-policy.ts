export type BusinessEgressPolicy = {
  domains: string[];
};

export const MAX_BUSINESS_EGRESS_DOMAINS = 100;
const MAX_DOMAIN_LENGTH = 253;

export function normalizeBusinessEgressPolicy(input: unknown, key = "egressAllowlist"): BusinessEgressPolicy {
  const domainsInput = Array.isArray(input)
    ? input
    : input && typeof input === "object" && "domains" in input
      ? (input as { domains?: unknown }).domains
      : input;
  if (!Array.isArray(domainsInput) || domainsInput.some((entry) => typeof entry !== "string")) {
    throw new Error(`${key} must be an array of domain names`);
  }
  return { domains: normalizeEgressDomains(domainsInput, key) };
}

export function normalizeEgressDomains(entries: string[], key = "egressAllowlist"): string[] {
  const unique = [...new Set(entries.map((entry) => entry.trim().toLowerCase()).filter(Boolean))].sort();
  if (unique.length > MAX_BUSINESS_EGRESS_DOMAINS) {
    throw new Error(`${key} must contain at most ${MAX_BUSINESS_EGRESS_DOMAINS} domain names`);
  }
  for (const entry of unique) {
    assertValidEgressDomain(entry, key);
  }
  return unique;
}

function assertValidEgressDomain(value: string, key = "egressAllowlist"): void {
  if (
    value.includes("*") ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.includes("/") ||
    value.includes(":")
  ) {
    throw new Error(`${key} entries must be exact domain names`);
  }
  if (value.length > MAX_DOMAIN_LENGTH) {
    throw new Error(`${key} entries must be exact domain names`);
  }
  const labels = value.split(".");
  if (
    labels.length === 4 &&
    labels.every((label) => /^\d+$/.test(label) && Number(label) >= 0 && Number(label) <= 255)
  ) {
    throw new Error(`${key} entries must be exact domain names`);
  }
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    throw new Error(`${key} entries must be exact domain names`);
  }
}
