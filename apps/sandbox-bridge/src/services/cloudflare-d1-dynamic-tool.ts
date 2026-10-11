import {
  CLOUDFLARE_ACCOUNT_ID_ENV,
  CLOUDFLARE_API_TOKEN_ENV,
  CLOUDFLARE_D1_DATABASE_ID_ENV,
} from "../../../../shared/constants/sandbox-env.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { asNonEmptyString, asRecord } from "../utils/dynamic-tool-helpers.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  buildDynamicToolErrorResult as buildSharedDynamicToolErrorResult,
  createDynamicToolJsonSuccess as dynamicToolSuccessResult,
  DYNAMIC_TOOL_ERROR_CODES,
  DynamicToolError,
  mapDynamicToolErrorCode as mapSharedDynamicToolErrorCode,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";

export const CLOUDFLARE_DYNAMIC_TOOL_NAMESPACE = "cloudflare";
export const CLOUDFLARE_QUERY_D1_DYNAMIC_TOOL_NAME = "query_d1";

const CLOUDFLARE_TIMEOUT_MS = 15_000;
const CLOUDFLARE_D1_SQL_MAX_CHARS = 10_000;
const CLOUDFLARE_D1_PARAM_MAX = 50;
const CLOUDFLARE_D1_ROW_LIMIT = 100;

type CloudflareCredentialState =
  { status: "missing" } | { status: "ready"; accountId: string; databaseId: string; apiToken: string };

type CloudflareD1QueryInput = {
  sql: string;
  params: Array<string | number | boolean | null>;
};

type CloudflareD1ApiResponse = {
  success?: boolean;
  errors?: Array<{ code?: unknown; message?: unknown }> | null;
  result?: Array<{
    results?: unknown[] | null;
    success?: boolean;
    meta?: Record<string, unknown> | null;
  }> | null;
};

function cloudflareCredentialsFromEnv(env: NodeJS.ProcessEnv | Record<string, string>): CloudflareCredentialState {
  const accountId = env[CLOUDFLARE_ACCOUNT_ID_ENV]?.trim() ?? "";
  const databaseId = env[CLOUDFLARE_D1_DATABASE_ID_ENV]?.trim() ?? "";
  const apiToken = env[CLOUDFLARE_API_TOKEN_ENV]?.trim() ?? "";
  if (!accountId || !databaseId || !apiToken) return { status: "missing" };
  return { status: "ready", accountId, databaseId, apiToken };
}

function hasCloudflareCredentials(env: NodeJS.ProcessEnv | Record<string, string>): boolean {
  return cloudflareCredentialsFromEnv(env).status === "ready";
}

function requireCloudflareCredentials(
  env: NodeJS.ProcessEnv | Record<string, string>,
): Extract<CloudflareCredentialState, { status: "ready" }> {
  const credentials = cloudflareCredentialsFromEnv(env);
  if (credentials.status === "missing") {
    throw new DynamicToolError("Cloudflare D1 credentials are not connected for this session.", "not_connected");
  }
  return credentials;
}

type SqlScan = {
  tokens: string[];
  statementCount: number;
};

type SqlCteToken = {
  kind: "word" | "symbol";
  value: string;
};

type SqlLimitPushdownScan = {
  topLevelTokens: string[];
  hasTopLevelSemicolon: boolean;
  hasLineComment: boolean;
  hasUnterminatedBlockComment: boolean;
};

/**
 * Walk the SQL once, ignoring comments and the contents of string/identifier
 * literals, collecting bare word tokens (lowercased) and counting top-level
 * statements separated by `;`. This is deliberately not a naive prefix check — it
 * is the control we fully own, so it has to survive comments and stacked
 * statements (`SELECT 1; DROP TABLE x`, `;` hidden in a literal, etc.).
 */
function scanD1Sql(sql: string): SqlScan {
  const tokens: string[] = [];
  let current = "";
  let statementHasContent = false;
  let statementCount = 0;
  let i = 0;
  const n = sql.length;

  const flushToken = () => {
    if (current) {
      tokens.push(current.toLowerCase());
      current = "";
    }
  };

  const skipQuoted = (close: string, escapeByDoubling: boolean): void => {
    i += 1; // consume opening delimiter
    while (i < n) {
      if (sql[i] === close) {
        if (escapeByDoubling && sql[i + 1] === close) {
          i += 2;
          continue;
        }
        i += 1;
        return;
      }
      i += 1;
    }
  };

  while (i < n) {
    const ch = sql[i];

    if (ch === "-" && sql[i + 1] === "-") {
      flushToken();
      i += 2;
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      flushToken();
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'") {
      flushToken();
      statementHasContent = true;
      skipQuoted("'", true);
      continue;
    }
    if (ch === '"') {
      flushToken();
      statementHasContent = true;
      skipQuoted('"', true);
      continue;
    }
    if (ch === "`") {
      flushToken();
      statementHasContent = true;
      skipQuoted("`", true);
      continue;
    }
    if (ch === "[") {
      flushToken();
      statementHasContent = true;
      skipQuoted("]", false);
      continue;
    }
    if (ch === ";") {
      flushToken();
      if (statementHasContent) {
        statementCount += 1;
        statementHasContent = false;
      }
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      current += ch;
      statementHasContent = true;
      i += 1;
      continue;
    }

    flushToken();
    if (!/\s/.test(ch)) statementHasContent = true;
    i += 1;
  }

  flushToken();
  if (statementHasContent) statementCount += 1;

  return { tokens, statementCount };
}

function scanD1CteTokens(sql: string): { tokens: SqlCteToken[]; hasComment: boolean; valid: boolean } {
  const tokens: SqlCteToken[] = [];
  let current = "";
  let hasComment = false;
  let valid = true;
  let i = 0;
  const n = sql.length;

  const flushToken = () => {
    if (current) {
      tokens.push({ kind: "word", value: current.toLowerCase() });
      current = "";
    }
  };

  const skipQuoted = (close: string, escapeByDoubling: boolean): void => {
    i += 1;
    while (i < n) {
      if (sql[i] === close) {
        if (escapeByDoubling && sql[i + 1] === close) {
          i += 2;
          continue;
        }
        i += 1;
        return;
      }
      i += 1;
    }
    valid = false;
  };

  while (i < n) {
    const ch = sql[i];

    if (ch === "-" && sql[i + 1] === "-") {
      flushToken();
      hasComment = true;
      i += 2;
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      flushToken();
      hasComment = true;
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      if (i >= n) {
        valid = false;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      flushToken();
      skipQuoted(ch, true);
      continue;
    }
    if (ch === "[") {
      flushToken();
      skipQuoted("]", false);
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === ";") {
      flushToken();
      tokens.push({ kind: "symbol", value: ch });
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      current += ch;
      i += 1;
      continue;
    }

    flushToken();
    i += 1;
  }

  flushToken();
  return { tokens, hasComment, valid };
}

function validateD1CteReadOnlyShape(sql: string): boolean {
  const scan = scanD1CteTokens(sql);
  if (!scan.valid || scan.hasComment) return false;
  const tokens = scan.tokens;
  let index = 0;

  const word = (value: string): boolean => tokens[index]?.kind === "word" && tokens[index]?.value === value;
  const symbol = (value: string): boolean => tokens[index]?.kind === "symbol" && tokens[index]?.value === value;
  const consumeWord = (value: string): boolean => {
    if (!word(value)) return false;
    index += 1;
    return true;
  };
  const consumeSymbol = (value: string): boolean => {
    if (!symbol(value)) return false;
    index += 1;
    return true;
  };
  const consumeIdentifier = (): boolean => {
    const token = tokens[index];
    if (token?.kind !== "word") return false;
    if (["as", "materialized", "not", "recursive", "select", "with"].includes(token.value)) return false;
    index += 1;
    return true;
  };
  const consumeParenthesizedWords = (): boolean => {
    if (!consumeSymbol("(")) return false;
    let depth = 1;
    let sawWord = false;
    while (index < tokens.length && depth > 0) {
      const token = tokens[index];
      index += 1;
      if (!token) return false;
      if (token.kind === "word") sawWord = true;
      if (token.kind === "symbol" && token.value === "(") depth += 1;
      if (token.kind === "symbol" && token.value === ")") depth -= 1;
    }
    return depth === 0 && sawWord;
  };
  const consumeSelectBody = (): boolean => {
    if (!consumeSymbol("(")) return false;
    if (!consumeWord("select")) return false;
    let depth = 1;
    while (index < tokens.length && depth > 0) {
      const token = tokens[index];
      index += 1;
      if (!token) return false;
      if (token.kind === "symbol" && token.value === "(") depth += 1;
      if (token.kind === "symbol" && token.value === ")") depth -= 1;
    }
    return depth === 0;
  };

  if (!consumeWord("with")) return false;
  if (word("recursive")) index += 1;

  while (index < tokens.length) {
    if (!consumeIdentifier()) return false;
    if (symbol("(") && !consumeParenthesizedWords()) return false;
    if (!consumeWord("as")) return false;
    if (word("not")) {
      index += 1;
      if (!consumeWord("materialized")) return false;
    } else if (word("materialized")) {
      index += 1;
    }
    if (!consumeSelectBody()) return false;
    if (consumeSymbol(",")) continue;
    break;
  }

  if (!consumeWord("select")) return false;
  let depth = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (!token) return false;
    if (token.kind === "symbol" && token.value === "(") depth += 1;
    if (token.kind === "symbol" && token.value === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
    if (token.kind === "symbol" && token.value === ";" && index < tokens.length) return false;
  }
  return depth === 0;
}

function scanD1SqlForLimitPushdown(sql: string): SqlLimitPushdownScan {
  const topLevelTokens: string[] = [];
  let current = "";
  let depth = 0;
  let hasTopLevelSemicolon = false;
  let hasLineComment = false;
  let hasUnterminatedBlockComment = false;
  let i = 0;
  const n = sql.length;

  const flushToken = () => {
    if (current) {
      if (depth === 0) topLevelTokens.push(current.toLowerCase());
      current = "";
    }
  };

  const skipQuoted = (close: string, escapeByDoubling: boolean): void => {
    i += 1;
    while (i < n) {
      if (sql[i] === close) {
        if (escapeByDoubling && sql[i + 1] === close) {
          i += 2;
          continue;
        }
        i += 1;
        return;
      }
      i += 1;
    }
  };

  while (i < n) {
    const ch = sql[i];

    if (ch === "-" && sql[i + 1] === "-") {
      flushToken();
      hasLineComment = true;
      i += 2;
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      flushToken();
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      if (i >= n) {
        hasUnterminatedBlockComment = true;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      flushToken();
      skipQuoted("'", true);
      continue;
    }
    if (ch === '"') {
      flushToken();
      skipQuoted('"', true);
      continue;
    }
    if (ch === "`") {
      flushToken();
      skipQuoted("`", true);
      continue;
    }
    if (ch === "[") {
      flushToken();
      skipQuoted("]", false);
      continue;
    }
    if (ch === "(") {
      flushToken();
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      flushToken();
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (ch === ";") {
      flushToken();
      if (depth === 0) hasTopLevelSemicolon = true;
      i += 1;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      current += ch;
      i += 1;
      continue;
    }

    flushToken();
    i += 1;
  }

  flushToken();
  return { topLevelTokens, hasTopLevelSemicolon, hasLineComment, hasUnterminatedBlockComment };
}

function appendD1RowLimitWhenSafe(sql: string): string {
  const { topLevelTokens, hasTopLevelSemicolon, hasLineComment, hasUnterminatedBlockComment } =
    scanD1SqlForLimitPushdown(sql);
  if (hasTopLevelSemicolon || hasLineComment || hasUnterminatedBlockComment) return sql;
  if (topLevelTokens[0] === "with") {
    if (!validateD1CteReadOnlyShape(sql)) return sql;
    return `SELECT * FROM (${sql}) AS cycloid_limited_cte LIMIT ${CLOUDFLARE_D1_ROW_LIMIT + 1}`;
  }
  if (topLevelTokens[0] !== "select") return sql;
  if (topLevelTokens.includes("limit")) return sql;
  if (topLevelTokens.some((token) => token === "union" || token === "intersect" || token === "except")) return sql;
  return `${sql} LIMIT ${CLOUDFLARE_D1_ROW_LIMIT + 1}`;
}

export function assertReadOnlyD1Sql(sql: string): void {
  const { tokens, statementCount } = scanD1Sql(sql);
  if (tokens.length === 0) {
    throw new DynamicToolError("query_d1 requires a non-empty SQL statement.", "invalid_input");
  }
  if (statementCount > 1) {
    throw new DynamicToolError(
      "query_d1 allows only a single read statement; multiple statements are not permitted.",
      "invalid_input",
    );
  }
  // SELECT is read-only by grammar in SQLite: there is no SELECT INTO and built-in
  // scalar functions do not mutate the database. WITH needs its own fail-closed
  // shape check so a CTE body or trailing top-level statement cannot smuggle a write.
  if (tokens[0] === "select") return;
  if (tokens[0] === "with" && validateD1CteReadOnlyShape(sql)) return;
  throw new DynamicToolError(
    "query_d1 only allows a single read-only SELECT statement, including provably read-only WITH ... SELECT CTEs.",
    "invalid_input",
  );
}

/**
 * Replace single- and double-quoted string literal contents with `?` for safe
 * persistence. SQLite falls back to treating a double-quoted token as a string
 * literal when it does not resolve to an identifier, so a value smuggled as
 * `email = "a@b.com"` would otherwise be persisted verbatim. Mask both quoted
 * forms the read-only scanner recognizes so saved tool input never leaks data.
 */
export function maskD1SqlLiterals(sql: string): string {
  let masked = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      masked += `${ch}?${ch}`;
      i += 1;
      while (i < n) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    masked += ch;
    i += 1;
  }
  return masked;
}

function normalizeQueryD1Input(args: unknown): CloudflareD1QueryInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("query_d1 requires an object input.", "invalid_input");
  }
  const allowed = new Set(["sql", "params"]);
  const extras = Object.keys(input).filter((key) => !allowed.has(key));
  if (extras.length > 0) {
    throw new DynamicToolError(`query_d1 received unsupported fields: ${extras.join(", ")}.`, "invalid_input");
  }

  const sql = asNonEmptyString(input.sql);
  if (!sql) {
    throw new DynamicToolError("query_d1 requires a non-empty 'sql' string.", "invalid_input");
  }
  if (sql.length > CLOUDFLARE_D1_SQL_MAX_CHARS) {
    throw new DynamicToolError(
      `query_d1 'sql' must be at most ${CLOUDFLARE_D1_SQL_MAX_CHARS} characters.`,
      "invalid_input",
    );
  }

  let params: Array<string | number | boolean | null> = [];
  if (input.params !== undefined) {
    if (!Array.isArray(input.params)) {
      throw new DynamicToolError("query_d1 'params' must be an array.", "invalid_input");
    }
    if (input.params.length > CLOUDFLARE_D1_PARAM_MAX) {
      throw new DynamicToolError(
        `query_d1 'params' must contain at most ${CLOUDFLARE_D1_PARAM_MAX} entries.`,
        "invalid_input",
      );
    }
    params = input.params.map((value) => {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
      }
      throw new DynamicToolError(
        "query_d1 'params' entries must be string, number, boolean, or null.",
        "invalid_input",
      );
    });
  }

  assertReadOnlyD1Sql(sql);
  return { sql, params };
}

function mapCloudflareToolErrorCode(error: DynamicToolError): DynamicToolErrorCode {
  return mapSharedDynamicToolErrorCode(error, {
    passthrough: [
      DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT,
      DYNAMIC_TOOL_ERROR_CODES.FORBIDDEN,
      DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED,
      DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND,
    ],
    statusCodes: {
      401: DYNAMIC_TOOL_ERROR_CODES.INVALID_CREDENTIAL,
      403: DYNAMIC_TOOL_ERROR_CODES.SCOPE_MISSING,
      404: DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND,
      429: DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED,
    },
  });
}

function cloudflareToolErrorResult(error: unknown): FirstPartyDynamicToolCallResult {
  return buildSharedDynamicToolErrorResult({
    error,
    cancelledMessage: "Cloudflare query_d1 was cancelled.",
    mapErrorCode: mapCloudflareToolErrorCode,
    unexpectedMessage: (unexpected) => `Cloudflare query_d1 failed: ${String(unexpected)}`,
  });
}

async function cloudflareD1Query(params: {
  credentials: Extract<CloudflareCredentialState, { status: "ready" }>;
  sql: string;
  sqlParams: Array<string | number | boolean | null>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<CloudflareD1ApiResponse> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
    params.credentials.accountId,
  )}/d1/database/${encodeURIComponent(params.credentials.databaseId)}/query`;

  const response = await params.fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${params.credentials.apiToken}`,
    },
    body: JSON.stringify({ sql: params.sql, params: params.sqlParams }),
    signal: createTimeoutAwareSignal(params.signal, CLOUDFLARE_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = (await response.json()) as CloudflareD1ApiResponse;
      detail = (payload.errors ?? [])
        .map((entry) => asNonEmptyString(entry.message))
        .filter((entry): entry is string => !!entry)
        .join("; ");
    } catch {
      // Body was not JSON; fall back to the status code alone.
    }
    throw new DynamicToolError(
      `Cloudflare D1 API request failed (${response.status})${detail ? `: ${detail}` : ""}`,
      "upstream_http_error",
      response.status,
    );
  }

  const payload = (await response.json()) as CloudflareD1ApiResponse;
  if (payload.success === false) {
    const message =
      (payload.errors ?? [])
        .map((entry) => asNonEmptyString(entry.message))
        .filter((entry): entry is string => !!entry)
        .join("; ") || "Unknown Cloudflare D1 API error";
    throw new DynamicToolError(message, "upstream_error");
  }
  return payload;
}

export function buildCloudflareQueryD1DynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!hasCloudflareCredentials(env)) return [];
  return [
    {
      namespace: CLOUDFLARE_DYNAMIC_TOOL_NAMESPACE,
      name: CLOUDFLARE_QUERY_D1_DYNAMIC_TOOL_NAME,
      description:
        "Run a read-only SQL query against the connected Cloudflare D1 database and return result rows. " +
        "Only a single SELECT statement is permitted, including provably read-only WITH ... SELECT CTEs; any write/DDL " +
        "statement, multiple statements, or ambiguous CTE shape is rejected. " +
        `At most ${CLOUDFLARE_D1_ROW_LIMIT} rows are returned. Use the 'params' array for '?' placeholders.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sql: { type: "string", description: "A single read-only SELECT statement or WITH ... SELECT CTE query." },
          params: {
            type: "array",
            items: { type: ["string", "number", "boolean", "null"] },
            description: "Optional bound values for '?' placeholders in the SQL.",
          },
        },
        required: ["sql"],
      },
    },
  ];
}

export function redactCloudflareD1DynamicToolInput(args: unknown): Record<string, unknown> | null | undefined {
  const input = asRecord(args);
  if (!input) return undefined;
  const redacted: Record<string, unknown> = {};
  if (typeof input.sql === "string") {
    redacted.sql = maskD1SqlLiterals(input.sql);
  }
  if (Array.isArray(input.params)) {
    redacted.paramCount = input.params.length;
  }
  return redacted;
}

export async function executeCloudflareQueryD1DynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  try {
    const credentials = requireCloudflareCredentials(context.env);
    const input = normalizeQueryD1Input(args);
    const fetchImpl = context.fetchImpl ?? fetch;
    const sql = appendD1RowLimitWhenSafe(input.sql);

    const payload = await cloudflareD1Query({
      credentials,
      sql,
      sqlParams: input.params,
      fetchImpl,
      signal: context.signal,
    });

    const firstResult = Array.isArray(payload.result) ? payload.result[0] : null;
    const allRows = Array.isArray(firstResult?.results) ? firstResult.results : [];
    const truncated = allRows.length > CLOUDFLARE_D1_ROW_LIMIT;
    const rows = truncated ? allRows.slice(0, CLOUDFLARE_D1_ROW_LIMIT) : allRows;

    return dynamicToolSuccessResult({
      rowCount: rows.length,
      truncated,
      rows,
    });
  } catch (error) {
    return cloudflareToolErrorResult(error);
  }
}
