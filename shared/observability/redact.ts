/**
 * Secret redaction for telemetry payloads.
 * Strips auth headers, cookies, API keys, OAuth tokens, clone tokens.
 */
import {
  DISPATCH_SUBSPANS_COMPLETED_EVENT,
  isDispatchSubspanName,
  isDispatchSubspanSnapshot,
} from "./dispatch-latency.js";

const REDACT_MAX_DEPTH = 3;

/** Patterns to redact from telemetry payloads. */
const INJECTED_SECRET_ENV_NAMES =
  "GITHUB_USER_TOKEN|GITHUB_CLONE_TOKEN|OPENAI_API_KEY|ARCANIST_OPENAI_API_KEY|SANDBOX_AUTH_TOKEN|TOKEN_ENCRYPTION_KEY";
const SECRET_ENV_NAME = "(?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|SECRET|KEY|PASSWORD)(?:_[A-Z0-9]+)*";
const CONNECTION_SECRET_ENV_NAME =
  "(?:DATABASE_URL|DB_URL|DATABASE_URI|POSTGRES_URL|POSTGRESQL_URL|MYSQL_URL|REDIS_URL|MONGODB_URI|MONGO_URI)";

export const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /x-access-token:[A-Za-z0-9_\-]+/gi,
  /Authorization:\s*token\s+[A-Za-z0-9\-._~+/]+=*/gi,
  new RegExp(`Authorization:\\s*(?:Bearer|Basic|token)\\s+\\$\\{?${SECRET_ENV_NAME}\\}?`, "gi"),
  new RegExp(`\\$(?:\\{(?:${INJECTED_SECRET_ENV_NAMES})\\}|(?:${INJECTED_SECRET_ENV_NAMES})(?![A-Z0-9_]))`, "g"),
  new RegExp(`\\$\\(\\s*env\\s*\\|\\s*grep\\s+(?:-[A-Za-z]+\\s+)*['"]?${SECRET_ENV_NAME}['"]?\\s*\\)`, "gi"),
  new RegExp(
    `(?:^|(?<=[\\s;]))(?:export\\s+)?${SECRET_ENV_NAME}=(?:"[^"\\n;&]*"|'[^'\\n;&]*'|\\$\\{?[A-Z][A-Z0-9_]*\\}?|[^\\s;&]+)`,
    "gm",
  ),
  new RegExp(
    `(?:^|(?<=[\\s;]))(?:export\\s+)?${CONNECTION_SECRET_ENV_NAME}=(?:"[^"\\n;&]*"|'[^'\\n;&]*'|\\$\\{?[A-Z][A-Z0-9_]*\\}?|[^\\s;&]+)`,
    "gim",
  ),
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@'"<>`]+:[^@\s/'"<>`]+@[^\s'"<>`]+/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"<>`]+/gi,
  // Credential-bearing non-DB schemes whose passwords may contain a literal "/"
  // (e.g. amqp/ftp connection strings logged verbatim). The username excludes "/"
  // and the password excludes "?"/"#" so a credential-free `host:port/path?x@y`
  // (port + later @ in a query) is not mistaken for `user:pass@`.
  /\b(?:amqps?|ftp|sftp):\/\/[^/\s:@'"<>`]+:[^@\s?#'"<>`]+@[^\s'"<>`]+/gi,
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ASIA[0-9A-Z]{16}/g,
  /arc_[a-f0-9]{64}/g,
  /e2b_[A-Za-z0-9]{16,}/g,
  /sk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,}/g,
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /whsec_[A-Za-z0-9]{16,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /lin_api_[A-Za-z0-9]+/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(?:CYCLOID_)?OPENAI_API_KEY=[^\s&]+/gi,
  // Generic key/value backstops for opaque secrets with no recognizable prefix. They require an
  // explicit assignment delimiter (`:` or `=`, optionally quoted) rather than any whitespace, so
  // ordinary prose or code that merely *mentions* "api key" / "token" before a long identifier,
  // hash, or UUID (e.g. "request token 550e8400-e29b-41d4-a716-446655440000") is not falsely
  // redacted. Space-separated secrets that do have a known shape are still caught by the prefix
  // patterns above (ghp_/github_pat_/sk-/AKIA/xox…/whsec_/…).
  /api[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9\-._]{16,}/gi,
  /token["']?\s*[:=]\s*["']?[A-Za-z0-9\-._]{20,}/gi,
];

export function redact(input: string): string {
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function isSecretKey(key: string): boolean {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalizedKey.includes("token") ||
    normalizedKey.includes("secret") ||
    normalizedKey.includes("password") ||
    normalizedKey.includes("authorization") ||
    normalizedKey.includes("cookie") ||
    normalizedKey.includes("apikey") ||
    normalizedKey.includes("accesskey") ||
    normalizedKey.includes("privatekey") ||
    normalizedKey === "databaseurl" ||
    normalizedKey === "dburl" ||
    normalizedKey === "databaseuri" ||
    normalizedKey === "postgresurl" ||
    normalizedKey === "postgresqlurl" ||
    normalizedKey === "mysqlurl" ||
    normalizedKey === "redisurl" ||
    normalizedKey === "mongodburi" ||
    normalizedKey === "mongouri" ||
    normalizedKey === "connectionstring" ||
    normalizedKey.endsWith("dsn")
  );
}

type RedactionContext = {
  rootEvent?: string;
};

function isDispatchSummarySpanSnapshot(
  rootEvent: string | undefined,
  path: readonly string[],
  key: string,
  value: unknown,
): boolean {
  return (
    rootEvent === DISPATCH_SUBSPANS_COMPLETED_EVENT &&
    path.length > 0 &&
    path[path.length - 1] === "spans" &&
    isDispatchSubspanName(key) &&
    isDispatchSubspanSnapshot(value)
  );
}

function redactValue(value: unknown, maxDepth: number, path: string[] = [], context: RedactionContext = {}): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (maxDepth <= 0) return { _truncated: true };
  if (value instanceof Error) return redactError(value, maxDepth - 1, path, context);
  if (Array.isArray(value))
    return value.map((item, index) => redactValue(item, maxDepth - 1, [...path, String(index)], context));
  return redactObject(value as Record<string, unknown>, maxDepth - 1, path, context);
}

function redactError(error: Error, maxDepth: number, path: string[] = [], context: RedactionContext = {}): Error {
  const redactedMessage = redact(error.message);
  const redactedStack = error.stack ? redact(error.stack) : undefined;
  const hasCause = "cause" in error;
  const customEntries = Object.entries(error);
  if (redactedMessage === error.message && redactedStack === error.stack && !hasCause && customEntries.length === 0) {
    return error;
  }

  const clone = new Error(redactedMessage);
  clone.name = error.name;
  if (redactedStack) clone.stack = redactedStack;
  if (hasCause) {
    (clone as Error & { cause?: unknown }).cause = redactValue(
      (error as Error & { cause?: unknown }).cause,
      maxDepth - 1,
      [...path, "cause"],
      context,
    );
  }
  for (const [key, value] of customEntries) {
    if (key === "cause") continue;
    (clone as unknown as Record<string, unknown>)[key] = isSecretKey(key)
      ? "[REDACTED]"
      : redactValue(value, maxDepth - 1, [...path, key], context);
  }
  return clone;
}

export function redactObject(
  obj: Record<string, unknown>,
  maxDepth = REDACT_MAX_DEPTH,
  path: string[] = [],
  context: RedactionContext = {},
): Record<string, unknown> {
  if (maxDepth <= 0) return { _truncated: true };

  const nextContext =
    path.length === 0 ? { rootEvent: typeof obj.event === "string" ? obj.event : undefined } : context;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const nextPath = [...path, key];
    if (isSecretKey(key) && !isDispatchSummarySpanSnapshot(nextContext.rootEvent, path, key, value)) {
      result[key] = "[REDACTED]";
    } else if (value instanceof Error) {
      result[key] = redactError(value, maxDepth - 1, nextPath, nextContext);
    } else if (typeof value === "string") {
      result[key] = redact(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item, index) =>
        redactValue(item, maxDepth - 1, [...nextPath, String(index)], nextContext),
      );
    } else if (value !== null && typeof value === "object") {
      result[key] = redactObject(value as Record<string, unknown>, maxDepth - 1, nextPath, nextContext);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Field-precise secret redaction. Walks a value and rewrites only secret-looking
 * substrings inside string leaves via {@link redact}, preserving all structure and
 * every non-secret character. Unlike {@link redactObject} it never blunt-replaces a
 * whole value by key name, so legitimate fields (file paths, diffs, prompts, tool
 * args) survive intact -- this is the "field-precise, not blunt redactObject"
 * contract for user-visible event projection.
 *
 * Returns the original reference when nothing changed, so a secret-free event
 * (the overwhelmingly common case, including streamed token deltas) keeps an
 * unchanged persisted/broadcast object and does not allocate replacement containers.
 */
export function redactSecretsInValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      const redacted = redactSecretsInValue(item);
      if (redacted !== item && !out) out = value.slice(0, index);
      if (out) out.push(redacted);
    }
    return out ?? value;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  let out: Record<string, unknown> | undefined;
  for (let index = 0; index < entries.length; index++) {
    const [key, item] = entries[index];
    const redacted = redactSecretsInValue(item);
    if (redacted !== item && !out) {
      out = {};
      for (const [previousKey, previousItem] of entries.slice(0, index)) {
        out[previousKey] = previousItem;
      }
    }
    if (out) out[key] = redacted;
  }
  return out ?? value;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `... [truncated ${s.length - max} chars]` : s;
}

/**
 * Keep the last `maxChars` of a string (the tail), prefixing a note when content was dropped.
 * Failure output is most useful at the end, so we truncate from the front.
 */
export function tailTruncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `[truncated ${omitted} chars]\n${value.slice(-maxChars)}`;
}
