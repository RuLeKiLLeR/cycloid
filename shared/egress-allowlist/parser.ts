import { normalizeEgressDomains } from "../types/business-egress-policy.js";

export const EGRESS_ALLOWLIST_SOURCE_PATH = ".cycloid/egress-allowlist.txt";

export function parseEgressAllowlistSourceFile(content: string, key = EGRESS_ALLOWLIST_SOURCE_PATH): string[] {
  const domains = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return normalizeEgressDomains(domains, key);
}

export function serializeEgressAllowlistSourceFile(domains: string[]): string {
  const normalized = normalizeEgressDomains(domains, EGRESS_ALLOWLIST_SOURCE_PATH);
  return normalized.length > 0 ? `${normalized.join("\n")}\n` : "";
}
