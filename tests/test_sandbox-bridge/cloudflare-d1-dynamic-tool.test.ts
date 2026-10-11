import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALID_ENV = {
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CF_D1_DATABASE_ID: "11111111-2222-3333-4444-555555555555",
  CF_API_TOKEN: "cf-token",
};

function d1Response(rows: unknown[], init?: ResponseInit): Response {
  return new Response(
    JSON.stringify({ success: true, errors: [], result: [{ results: rows, success: true, meta: {} }] }),
    { status: 200, ...init },
  );
}

function lastCloudflareRequestSql(fetchImpl: typeof fetch): string {
  const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const requestInit = calls[calls.length - 1]?.[1] as RequestInit | undefined;
  const body = JSON.parse(String(requestInit?.body ?? "{}")) as { sql?: unknown };
  return String(body.sql ?? "");
}

describe("cloudflare D1 dynamic tool", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the spec only when all three credentials are present", async () => {
    const { buildCloudflareQueryD1DynamicToolSpec } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");

    expect(buildCloudflareQueryD1DynamicToolSpec({})).toEqual([]);
    expect(buildCloudflareQueryD1DynamicToolSpec({ CF_ACCOUNT_ID: "a", CF_D1_DATABASE_ID: "b" })).toEqual([]);
    expect(buildCloudflareQueryD1DynamicToolSpec(VALID_ENV)).toHaveLength(1);
    expect(buildCloudflareQueryD1DynamicToolSpec(VALID_ENV)[0]).toMatchObject({
      namespace: "cloudflare",
      name: "query_d1",
    });
  });

  it("runs a SELECT and returns normalized rows", async () => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => d1Response([{ id: 1, email: "a@b.com" }])) as unknown as typeof fetch;

    const result = await executeCloudflareQueryD1DynamicToolCall(
      { sql: "SELECT id, email FROM users WHERE id = ?", params: [1] },
      { env: VALID_ENV, fetchImpl },
    );

    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, requestInit] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain(`/accounts/${VALID_ENV.CF_ACCOUNT_ID}/d1/database/${VALID_ENV.CF_D1_DATABASE_ID}/query`);
    expect((requestInit as RequestInit).headers).toMatchObject({ authorization: "Bearer cf-token" });
    expect(lastCloudflareRequestSql(fetchImpl)).toBe("SELECT id, email FROM users WHERE id = ? LIMIT 101");
    const payload = JSON.parse(result.contentItems[0].text) as {
      rowCount: number;
      truncated: boolean;
      rows: unknown[];
    };
    expect(payload).toMatchObject({ rowCount: 1, truncated: false });
    expect(payload.rows[0]).toMatchObject({ id: 1, email: "a@b.com" });
  });

  it("caps returned rows and flags truncation", async () => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const rows = Array.from({ length: 150 }, (_, i) => ({ id: i }));
    const fetchImpl = vi.fn(async () => d1Response(rows)) as unknown as typeof fetch;

    const result = await executeCloudflareQueryD1DynamicToolCall(
      { sql: "SELECT id FROM users" },
      { env: VALID_ENV, fetchImpl },
    );

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.contentItems[0].text) as { rowCount: number; truncated: boolean };
    expect(payload).toMatchObject({ rowCount: 100, truncated: true });
  });

  it.each([
    ["SELECT id FROM users", "SELECT id FROM users LIMIT 101"],
    ["  select id from users  ", "select id from users LIMIT 101"],
    [
      "SELECT 'limit' AS label, [limit] FROM users /* limit in a comment */",
      "SELECT 'limit' AS label, [limit] FROM users /* limit in a comment */ LIMIT 101",
    ],
    [
      "WITH recent AS (SELECT * FROM events) SELECT * FROM recent",
      "SELECT * FROM (WITH recent AS (SELECT * FROM events) SELECT * FROM recent) AS cycloid_limited_cte LIMIT 101",
    ],
  ])("pushes the row cap into safe SELECT SQL: %s", async (sql, expectedSql) => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => d1Response([{ id: 1 }])) as unknown as typeof fetch;

    const result = await executeCloudflareQueryD1DynamicToolCall({ sql }, { env: VALID_ENV, fetchImpl });

    expect(result.success).toBe(true);
    expect(lastCloudflareRequestSql(fetchImpl)).toBe(expectedSql);
  });

  it.each([
    "SELECT id FROM users LIMIT 10",
    "SELECT n FROM (SELECT 1 AS n) UNION SELECT 2",
    "SELECT n FROM (SELECT 1 AS n) INTERSECT SELECT 1",
    "SELECT n FROM (SELECT 1 AS n) EXCEPT SELECT 2",
    "SELECT id FROM users -- trailing line comment",
    "SELECT id FROM users /*",
    "SELECT 1; -- trailing comment only",
  ])("leaves unsafe or already-capped SELECT SQL unchanged: %s", async (sql) => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => d1Response([{ id: 1 }])) as unknown as typeof fetch;

    const result = await executeCloudflareQueryD1DynamicToolCall({ sql }, { env: VALID_ENV, fetchImpl });

    expect(result.success).toBe(true);
    expect(lastCloudflareRequestSql(fetchImpl)).toBe(sql.trim());
  });

  it("fails closed when credentials are not connected", async () => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await executeCloudflareQueryD1DynamicToolCall({ sql: "SELECT 1" }, { env: {}, fetchImpl });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("not_connected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "INSERT INTO users (id) VALUES (1)",
    "UPDATE users SET email = 'x' WHERE id = 1",
    "DELETE FROM users",
    "DROP TABLE users",
    "ALTER TABLE users ADD COLUMN x TEXT",
    "CREATE TABLE t (id INTEGER)",
    "PRAGMA writable_schema = 1",
    "ATTACH DATABASE 'x.db' AS x",
    "REPLACE INTO users (id) VALUES (1)",
    "VACUUM",
    "EXPLAIN SELECT * FROM users",
    "SELECT 1; DELETE FROM users",
    "SELECT 1;\nDROP TABLE users",
    "SELECT 1 -- harmless\n; DELETE FROM users",
    "SELECT 1 /* sneaky */; UPDATE users SET id = 2",
    "WITH x AS (SELECT 1) DELETE FROM users",
    "WITH x AS (SELECT 1) INSERT INTO users SELECT * FROM x",
    "WITH RECURSIVE x AS (SELECT 1) DELETE FROM users",
    "WITH x AS (INSERT INTO users (id) VALUES (1)) SELECT * FROM x",
    "WITH x AS (WITH y AS (SELECT 1) SELECT * FROM y) SELECT * FROM x",
    'WITH "quoted" AS (SELECT 1) SELECT * FROM quoted',
    "WITH x AS (SELECT 1) -- prologue comment\nSELECT * FROM x",
    // Regression: a CTE *named* `select` must not be mistaken for a read. This
    // executed a write under the earlier depth-0 keyword-scan approach.
    "WITH select AS (SELECT 1) DELETE FROM users",
  ])("rejects non-read-only SQL: %s", async (sql) => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await executeCloudflareQueryD1DynamicToolCall({ sql }, { env: VALID_ENV, fetchImpl });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("invalid_input");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "SELECT * FROM users WHERE id = 1",
    "  select id from users  ",
    "SELECT name FROM users WHERE note = 'please DELETE this row'",
    "SELECT 1; -- trailing comment only",
    'SELECT "delete" FROM audit',
    // Read-only queries a keyword denylist would reject as false positives:
    // SQLite's replace() scalar function and columns named like control keywords.
    "SELECT replace(note, 'a', 'b') FROM logs",
    "SELECT release, trigger, analyze FROM deploys",
    // Compound SELECTs and subqueries (the CTE-free way to express the same reads).
    "SELECT n FROM (SELECT 1 AS n) UNION SELECT 2",
    "WITH recent AS (SELECT * FROM events) SELECT * FROM recent",
    "WITH one AS (SELECT 1), two AS (SELECT 2) SELECT * FROM one UNION SELECT * FROM two",
    "WITH RECURSIVE nums(n) AS (SELECT 1) SELECT n FROM nums",
    "WITH recent(id, name) AS (SELECT id, name FROM users) SELECT id FROM recent",
    "WITH x AS MATERIALIZED (SELECT 1) SELECT * FROM x",
    "WITH x AS NOT MATERIALIZED (SELECT 1) SELECT * FROM x",
  ])("allows read-only SQL: %s", async (sql) => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => d1Response([{ ok: 1 }])) as unknown as typeof fetch;

    const result = await executeCloudflareQueryD1DynamicToolCall({ sql }, { env: VALID_ENV, fetchImpl });

    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid input shapes", async () => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    for (const args of [{}, { sql: "" }, { sql: "SELECT 1", extra: true }, { sql: "SELECT 1", params: "nope" }]) {
      const result = await executeCloudflareQueryD1DynamicToolCall(args, { env: VALID_ENV, fetchImpl });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("invalid_input");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a 403 response to scope_missing", async () => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ success: false, errors: [{ message: "forbidden" }] }), { status: 403 }),
    ) as unknown as typeof fetch;

    const result = await executeCloudflareQueryD1DynamicToolCall({ sql: "SELECT 1" }, { env: VALID_ENV, fetchImpl });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("scope_missing");
  });

  it("maps a 401 response to invalid_credential", async () => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: "unauthorized" }] }), { status: 401 }),
    ) as unknown as typeof fetch;

    const result = await executeCloudflareQueryD1DynamicToolCall({ sql: "SELECT 1" }, { env: VALID_ENV, fetchImpl });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("invalid_credential");
  });

  it.each([
    ["caller abort", "AbortError"],
    ["request timeout", "TimeoutError"],
  ])("reports %s cancellation distinctly", async (_label, errorName) => {
    const { executeCloudflareQueryD1DynamicToolCall } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("Aborted", errorName);
    }) as unknown as typeof fetch;

    const result = await executeCloudflareQueryD1DynamicToolCall({ sql: "SELECT 1" }, { env: VALID_ENV, fetchImpl });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("cancelled");
  });

  it("masks string literals and param counts for persistence", async () => {
    const { redactCloudflareD1DynamicToolInput } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");

    expect(
      redactCloudflareD1DynamicToolInput({
        sql: "SELECT * FROM users WHERE email = 'secret@x.com'",
        params: ["a", "b"],
      }),
    ).toEqual({ sql: "SELECT * FROM users WHERE email = '?'", paramCount: 2 });
  });

  it("masks double-quoted string literals so persisted input does not leak data", async () => {
    const { redactCloudflareD1DynamicToolInput } =
      await import("../../apps/sandbox-bridge/src/services/cloudflare-d1-dynamic-tool.js");

    expect(
      redactCloudflareD1DynamicToolInput({
        sql: "SELECT * FROM users WHERE email = \"secret@x.com\" AND name = 'Ada'",
      }),
    ).toEqual({ sql: "SELECT * FROM users WHERE email = \"?\" AND name = '?'" });
  });
});
