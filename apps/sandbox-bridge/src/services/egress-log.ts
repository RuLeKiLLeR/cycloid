import { existsSync, readFileSync } from "fs";

import type { BridgeLogger } from "../logger.js";

const EGRESS_LOG_PATH = process.env.ARCANIST_EGRESS_LOG_PATH || "/var/log/cycloid-egress.log";
const EGRESS_PREFIX = "[egress] ";

function parseKeyValueFields(input: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const token of input.split(/\s+/)) {
    const separator = token.indexOf("=");
    if (separator <= 0 || separator === token.length - 1) continue;
    fields[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return fields;
}

function emitStructuredEgressEvent(log: BridgeLogger, line: string): void {
  if (!line.startsWith(EGRESS_PREFIX)) return;
  const payload = line.slice(EGRESS_PREFIX.length).trim();
  if (!payload) return;

  if (payload.startsWith("github-meta-fetch-failed ")) {
    log.warn(
      {
        ...parseKeyValueFields(payload),
        event: "egress.github_meta_fetch_failed",
      },
      "Sandbox egress GitHub Meta fetch failed",
    );
    return;
  }

  if (payload.startsWith("github-meta-snapshot-used ")) {
    log.warn(
      {
        ...parseKeyValueFields(payload),
        event: "egress.github_meta_snapshot_used",
      },
      "Sandbox egress GitHub Meta snapshot fallback used",
    );
    return;
  }

  if (payload.startsWith("unresolved ")) {
    log.warn(
      {
        ...parseKeyValueFields(payload),
        event: "egress.unresolved_domain",
      },
      "Sandbox egress unresolved domain",
    );
    return;
  }

  if (payload.startsWith("github-meta-cidrs-unavailable ") || payload.startsWith("failed-closed ")) {
    log.error(
      {
        ...parseKeyValueFields(payload),
        event: "egress.github_meta_unavailable",
      },
      "Sandbox egress GitHub Meta CIDRs unavailable",
    );
    return;
  }

  if (payload.startsWith("enforced ")) {
    log.info(
      {
        ...parseKeyValueFields(payload),
        event: "egress.enforced",
      },
      "Sandbox egress enforcement completed",
    );
  }
}

export function emitStartupEgressLog(log: BridgeLogger): void {
  if (!existsSync(EGRESS_LOG_PATH)) return;

  try {
    const contents = readFileSync(EGRESS_LOG_PATH, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      emitStructuredEgressEvent(log, line.trim());
    }
  } catch (error) {
    log.warn(
      {
        event: "egress.log_read_failed",
        path: EGRESS_LOG_PATH,
        error: String(error),
      },
      "Failed to read sandbox egress log",
    );
  }
}
