import { redact, truncate } from "./observability/redact.js";

export const TOOL_FAILURE_CATEGORIES = ["auth", "provider", "policy", "wrapper", "command", "unknown"] as const;
export type ToolFailureCategory = (typeof TOOL_FAILURE_CATEGORIES)[number];

export const TOOL_FAILURE_PHASES = ["auth", "provider", "policy", "wrapper", "command"] as const;
export type ToolFailurePhase = (typeof TOOL_FAILURE_PHASES)[number];

export type ToolFailureUpstreamRef = {
  runId?: string;
  logUrl?: string;
};

export type ToolFailureReport = {
  category: ToolFailureCategory;
  phase: ToolFailurePhase;
  safeSummary: string;
  diagnosticsRedacted: true;
  upstream?: ToolFailureUpstreamRef;
};

const SAFE_SUMMARY_MAX_CHARS = 500;
const FAILURE_SUMMARY_LINES = 3;
const TOOL_TIMEOUT_PATTERNS = [/\btimeout\b/i, /\btimed?\s*out\b/i, /\bETIMEDOUT\b/i, /\bESOCKETTIMEDOUT\b/i];

const AUTH_PATTERNS = [
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bpermission denied\b/i,
  /\bauth(?:entication|orization)? failed\b/i,
  /\binvalid (?:token|api key|credentials?)\b/i,
  /\btoken (?:expired|revoked|missing)\b/i,
  /\b401\b/,
  /\b403\b/,
];

const POLICY_PATTERNS = [
  /\bpolicy block\b/i,
  /\bnot permitted\b/i,
  /\bblocked(?: by)? policy\b/i,
  /\bsandbox(?:ed)? restriction\b/i,
  /\brequires escalated privileges\b/i,
];

const PROVIDER_PATTERNS = [
  /\brate limit\b/i,
  /\b429\b/,
  /\b5\d\d\b/,
  /\bupstream\b/i,
  /\bprovider\b/i,
  /\bapi (?:error|unavailable)\b/i,
  /\btemporarily unavailable\b/i,
  /\bconnection (?:reset|refused|timed out)\b/i,
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bENOTFOUND\b/,
];

const WRAPPER_PATTERNS = [
  /\bspawn\b/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bcommand not found\b/i,
  /\bCreateProcess\b/i,
  /\btool .* failed\b/i,
  /\bwrapper\b/i,
];

const GITHUB_RUN_URL_RE = /https:\/\/github\.com\/[^\s'"<>`]+\/actions\/runs\/(\d+)/i;
const URL_RE = /https?:\/\/[^\s'"<>`]+/gi;

function normalizeFailureText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Error) return raw.message;
  if (raw === null || raw === undefined) return "";
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function classifyToolFailure(tool: string, redactedText: string): ToolFailureCategory {
  const text = `${tool}\n${redactedText}`;
  if (matchesAny(text, AUTH_PATTERNS)) return "auth";
  if (matchesAny(text, POLICY_PATTERNS)) return "policy";
  if (matchesAny(text, PROVIDER_PATTERNS)) return "provider";
  if (matchesAny(text, WRAPPER_PATTERNS)) return "wrapper";
  if (tool.toLowerCase() === "bash") return "command";
  return "unknown";
}

function phaseForCategory(category: ToolFailureCategory): ToolFailurePhase {
  return category === "unknown" ? "command" : category;
}

function summarizeFailure(redactedText: string, category: ToolFailureCategory): string {
  const meaningfulLines = redactedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, FAILURE_SUMMARY_LINES);
  const summary = meaningfulLines.join("\n") || `Tool failed during ${phaseForCategory(category)} phase.`;
  return truncate(summary, SAFE_SUMMARY_MAX_CHARS);
}

function extractUpstreamRef(redactedText: string): ToolFailureUpstreamRef | undefined {
  const githubRun = redactedText.match(GITHUB_RUN_URL_RE);
  if (githubRun?.[0]) {
    return { logUrl: githubRun[0], runId: githubRun[1] };
  }

  const urls = redactedText.match(URL_RE) ?? [];
  const logUrl = urls.find((url) => /(?:logs?|runs?|actions|builds?)/i.test(url));
  return logUrl ? { logUrl } : undefined;
}

export function isToolFailureTimeout(failure: Pick<ToolFailureReport, "safeSummary"> | null | undefined): boolean {
  const summary = failure?.safeSummary ?? "";
  return summary.length > 0 && TOOL_TIMEOUT_PATTERNS.some((pattern) => pattern.test(summary));
}

export function buildToolFailureReport(input: { tool: string; rawOutput: unknown }): ToolFailureReport {
  const redactedText = redact(normalizeFailureText(input.rawOutput));
  const category = classifyToolFailure(input.tool, redactedText);
  const upstream = extractUpstreamRef(redactedText);
  return {
    category,
    phase: phaseForCategory(category),
    safeSummary: summarizeFailure(redactedText, category),
    diagnosticsRedacted: true,
    ...(upstream ? { upstream } : {}),
  };
}
