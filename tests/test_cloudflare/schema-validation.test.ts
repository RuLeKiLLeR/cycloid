/**
 * Schema validation test: applies all D1 migrations to an in-memory SQLite DB,
 * then EXPLAINs every .prepare() query found in the control-plane-worker source.
 * Catches column renames, typos, and missing tables at CI time.
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "fs";
import { relative, resolve } from "path";
import { describe, expect, it } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { analyticsCtes } from "../../apps/control-plane-worker/src/session/activity-db";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");
const SRC_DIR = resolve(__dirname, "../../apps/control-plane-worker/src");

const DDL_PREFIXES = ["CREATE ", "DROP ", "ALTER ", "PRAGMA "];

// ---------------------------------------------------------------------------
// 1. Build an in-memory SQLite DB with all migrations applied
// ---------------------------------------------------------------------------

function buildSchema(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  applyMigrations(db, getMigrationFiles());

  // Deploy-time bookkeeping table created by `wrangler d1 migrations apply` (not in
  // migrations). getAppliedMigrationNames() / the schema-health route query it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

function getMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigrations(db: Database.Database, files: string[]): void {
  for (const file of files) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8"));
  }
}

// ---------------------------------------------------------------------------
// 2. Extract SQL queries from source files
// ---------------------------------------------------------------------------

interface ExtractedQuery {
  file: string;
  line: number;
  sql: string;
}

/**
 * Scan forward from `start` (one past the opening quote), collecting characters
 * until the closing `terminator` is found. Handles backslash escapes.
 * Returns the raw string content and the index of the closing quote.
 *
 * For template literals (terminator = '`'), `onInterpolation` is called for
 * each ${...} expression to produce a substitution value.
 */
function scanString(
  text: string,
  start: number,
  terminator: string,
  onInterpolation?: (raw: string, expr: string) => string,
): { raw: string; end: number } {
  let i = start;
  let raw = "";
  while (i < text.length) {
    if (text[i] === "\\") {
      raw += text[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (text[i] === terminator) {
      return { raw, end: i };
    }
    if (onInterpolation && text[i] === "$" && text[i + 1] === "{") {
      let depth = 1;
      i += 2;
      let expr = "";
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth++;
        if (text[i] === "}") depth--;
        if (depth > 0) expr += text[i];
        i++;
      }
      raw += onInterpolation(raw, expr);
      continue;
    }
    raw += text[i];
    i++;
  }
  // Unterminated string -- return what we have
  return { raw, end: i };
}

// Marks a query built with a dynamically-quoted SQL identifier; such queries
// are skipped by extractQueries because their table/column is unknown statically.
const DYNAMIC_IDENTIFIER_SENTINEL = "__dynamic_sql_identifier__";

/**
 * Heuristic substitution for ${...} template expressions in SQL.
 * - After SET: produces a valid "col = val" clause
 * - Predicate fragments: produces "" (the conditional clause is empty or a boolean at runtime)
 * - Placeholder lists: produces "?"
 * - Default: produces "1" (safe in SELECT, WHERE, etc.)
 */
function substituteInterpolation(precedingRaw: string, expr: string): string {
  const preceding = precedingRaw.toUpperCase().replace(/\s+/g, " ").trim();
  if (expr.includes("D1_RETRY_SAFE_MARKER")) {
    return "/* d1-retry-safe */";
  }
  if (expr.includes("cursor.sql")) {
    return "SELECT 1 FROM integration_lifecycle_events WHERE 1 = 1";
  }
  // Activity-dashboard queries lead with the `analyticsCtes()` WITH prefix
  // (session/activity-db.ts). Substitute the real prefix (owner-scoped, the
  // superset predicate) so EXPLAIN validates the CTEs and the outer SELECT.
  if (expr.includes("analytics.sql")) {
    return analyticsCtes({ businessId: "b", ownerUserId: "1", sinceIso: "1970-01-01T00:00:00.000Z" }).sql;
  }
  if (/\bSET\s*$/.test(preceding) || expr.includes("Clause")) {
    return "updated_at = updated_at";
  }
  // Conditional WHERE/AND fragments (e.g. `${cursorPredicate}`, `${providerPredicate}`) expand to
  // either an empty string or a complete boolean clause at runtime. Substitute empty so the surrounding
  // query parses regardless of whether a space precedes the interpolation (`<= ? ${p}` would otherwise
  // become the invalid `<= ? 1`).
  if (expr.includes("Predicate")) {
    return "";
  }
  if (expr.includes("placeholder")) {
    return "?";
  }
  // Dynamically-quoted table/column identifiers (guarded at runtime by
  // quoteSqlIdentifier) cannot be schema-validated: no concrete table/column is
  // known statically, so any substitution is either a syntax error or a bogus
  // "no such table". Emit a sentinel so extractQueries drops the whole query.
  if (expr.includes("quoteSqlIdentifier")) {
    return DYNAMIC_IDENTIFIER_SENTINEL;
  }
  return "1";
}

/**
 * Extract SQL strings from .prepare() calls in TypeScript source.
 * Handles double-quoted, single-quoted, and template literal strings.
 * For template literals, replaces ${...} with safe placeholder values.
 * Skips .prepare(variable) calls where SQL is dynamically constructed.
 */
function extractQueries(filePath: string): ExtractedQuery[] {
  const content = readFileSync(filePath, "utf-8");
  const queries: ExtractedQuery[] = [];

  let pos = 0;
  let lineNum = 1;

  while (pos < content.length) {
    const prepareIdx = content.indexOf(".prepare(", pos);
    if (prepareIdx === -1) break;

    // Track line numbers incrementally
    for (let i = pos; i < prepareIdx; i++) {
      if (content[i] === "\n") lineNum++;
    }

    const afterParen = prepareIdx + ".prepare(".length;
    let start = afterParen;
    while (start < content.length && /\s/.test(content[start])) start++;

    const quote = content[start];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      pos = afterParen;
      continue;
    }

    const isTemplate = quote === "`";
    const { raw, end } = scanString(content, start + 1, quote, isTemplate ? substituteInterpolation : undefined);

    const trimmed = raw.trim();
    const upper = trimmed.toUpperCase();

    const isDDL = DDL_PREFIXES.some((prefix) => upper.startsWith(prefix));
    const hasDynamicIdentifier = trimmed.includes(DYNAMIC_IDENTIFIER_SENTINEL);
    if (!isDDL && !hasDynamicIdentifier && trimmed.length >= 5) {
      queries.push({ file: filePath, line: lineNum, sql: trimmed });
    }

    pos = end + 1;
  }

  return queries;
}

// ---------------------------------------------------------------------------
// 3. Run EXPLAIN on each query
// ---------------------------------------------------------------------------

describe("schema validation", () => {
  const db = buildSchema();

  const sourceFiles = readdirSync(SRC_DIR, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => resolve(e.parentPath, e.name));

  const allQueries: ExtractedQuery[] = sourceFiles.flatMap(extractQueries);

  it("should find queries to validate", () => {
    expect(allQueries.length).toBeGreaterThan(50);
  });

  it("requires business_id on tenant-scoped session projection tables", () => {
    const tables = ["session_index", "usage_records", "prompt_runs", "session_completions"];

    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
      const businessIdColumn = columns.find((column) => column.name === "business_id");
      expect(businessIdColumn?.notnull, `${table}.business_id should be NOT NULL`).toBe(1);
    }
  });

  it("keeps self-hosted sandboxes opt-in for the Cycloid business", () => {
    const row = db
      .prepare("SELECT self_hosted_sandboxes_enabled FROM businesses WHERE id = ?")
      .get(SEEDED_BUSINESS_IDS.cycloid) as { self_hosted_sandboxes_enabled: number } | undefined;

    expect(row?.self_hosted_sandboxes_enabled).toBe(0);
    expect(db.prepare("SELECT 1 FROM businesses WHERE id = 'biz-arcanist'").get()).toBeUndefined();
  });

  it("backfills owned rows and deletes unowned rows before enforcing business_id", () => {
    const migrationDb = new Database(":memory:");
    const files = getMigrationFiles();
    applyMigrations(
      migrationDb,
      files.filter((file) => file < "0078_business_id_not_null.sql"),
    );

    migrationDb.exec(`
      INSERT INTO businesses (id, name, created_at, updated_at)
      VALUES ('biz-test', 'Test Business', 1, 1),
             ('biz-fallback', 'Fallback Business', 1, 1);

      INSERT INTO users (id, github_id, login, business_id, created_at, updated_at)
      VALUES (9001, 9001, 'owned-user', 'biz-test', 1, 1),
             (9002, 9002, 'fallback-user', 'biz-fallback', 1, 1);

      INSERT INTO session_index (session_id, owner_user_id, status, created_at, updated_at)
      VALUES ('s-owned', 9001, 'active', 1, 1),
             ('s-orphan', 9999, 'active', 1, 1);

      INSERT INTO durable_event_replay_metadata (session_id, last_event_sequence, last_event_timestamp, updated_at)
      VALUES ('s-owned', 1, '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z'),
             ('s-orphan', 1, '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z'),
             ('s-missing-index', 1, '2026-04-18T00:00:00.000Z', '2026-04-18T00:00:00.000Z');

      INSERT INTO session_webhook_refs (source, external_ref, session_id, updated_at)
      VALUES ('github_issue', 'owned-ref', 's-owned', '2026-04-18T00:00:00.000Z'),
             ('github_issue', 'orphan-ref', 's-orphan', '2026-04-18T00:00:00.000Z'),
             ('github_issue', 'missing-index-ref', 's-missing-index', '2026-04-18T00:00:00.000Z');

      INSERT INTO slack_thread_session_refs (channel_id, thread_ts, session_id, updated_at)
      VALUES ('C1', '1.000', 's-owned', '2026-04-18T00:00:00.000Z'),
             ('C1', '2.000', 's-orphan', '2026-04-18T00:00:00.000Z'),
             ('C1', '3.000', 's-missing-index', '2026-04-18T00:00:00.000Z');

      INSERT INTO linear_issue_session_refs (linear_issue_id, session_id, updated_at)
      VALUES ('LIN-1', 's-owned', '2026-04-18T00:00:00.000Z'),
             ('LIN-2', 's-orphan', '2026-04-18T00:00:00.000Z'),
             ('LIN-3', 's-missing-index', '2026-04-18T00:00:00.000Z');

      INSERT INTO usage_records (id, session_id, owner_user_id)
      VALUES ('usage-owned', 's-owned', 9001),
             ('usage-orphan', 's-orphan', 9999),
             ('usage-fallback', 's-fallback-missing-index', 9002);

      INSERT INTO prompt_runs (id, session_id, prompt_id, owner_user_id)
      VALUES ('run-owned', 's-owned', 'p-owned', 9001),
             ('run-orphan', 's-orphan', 'p-orphan', 9999),
             ('run-fallback', 's-fallback-missing-index', 'p-fallback', 9002);

      INSERT INTO session_completions (id, session_id, prompt_id, owner_user_id, repo_owner, repo_name, prompt_text, completed_at)
      VALUES ('completion-owned', 's-owned', 'p-owned', 9001, 'acme', 'repo', 'fix it', 1),
             ('completion-orphan', 's-orphan', 'p-orphan', 9999, 'acme', 'repo', 'fix it', 1),
             ('completion-fallback', 's-fallback-missing-index', 'p-fallback', 9002, 'acme', 'repo', 'fix it', 1);

      INSERT INTO codegraph_observations (id, repo_owner, repo_name, session_id, observation, observation_type)
      VALUES ('observation-owned', 'acme', 'repo', 's-owned', 'owned observation', 'architecture'),
             ('observation-orphan', 'acme', 'repo', 's-orphan', 'orphan observation', 'architecture');
    `);

    applyMigrations(migrationDb, ["0078_business_id_not_null.sql"]);

    const ownedSession = migrationDb
      .prepare("SELECT business_id FROM session_index WHERE session_id = 's-owned'")
      .get() as { business_id: string };
    expect(ownedSession.business_id).toBe("biz-test");

    const ownedTables = [
      ["usage_records", "usage-owned"],
      ["prompt_runs", "run-owned"],
      ["session_completions", "completion-owned"],
      ["codegraph_observations", "observation-owned"],
    ];
    for (const [table, id] of ownedTables) {
      const row = migrationDb.prepare(`SELECT business_id FROM ${table} WHERE id = ?`).get(id) as {
        business_id: string;
      };
      expect(row.business_id, `${table}.${id} should be backfilled`).toBe("biz-test");
    }

    const fallbackTables = [
      ["usage_records", "usage-fallback"],
      ["prompt_runs", "run-fallback"],
      ["session_completions", "completion-fallback"],
    ];
    for (const [table, id] of fallbackTables) {
      const row = migrationDb.prepare(`SELECT business_id FROM ${table} WHERE id = ?`).get(id) as {
        business_id: string;
      };
      expect(row.business_id, `${table}.${id} should fall back through owner_user_id`).toBe("biz-fallback");
    }

    const orphanTables = [
      ["session_index", "session_id", "s-orphan"],
      ["durable_event_replay_metadata", "session_id", "s-orphan"],
      ["durable_event_replay_metadata", "session_id", "s-missing-index"],
      ["session_webhook_refs", "session_id", "s-orphan"],
      ["session_webhook_refs", "session_id", "s-missing-index"],
      ["slack_thread_session_refs", "session_id", "s-orphan"],
      ["slack_thread_session_refs", "session_id", "s-missing-index"],
      ["linear_issue_session_refs", "session_id", "s-orphan"],
      ["linear_issue_session_refs", "session_id", "s-missing-index"],
      ["usage_records", "id", "usage-orphan"],
      ["prompt_runs", "id", "run-orphan"],
      ["session_completions", "id", "completion-orphan"],
      ["codegraph_observations", "id", "observation-orphan"],
    ];
    for (const [table, column, value] of orphanTables) {
      const count = migrationDb.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(value) as {
        count: number;
      };
      expect(count.count, `${table}.${value} should be deleted`).toBe(0);
    }
  });

  const byFile = new Map<string, ExtractedQuery[]>();
  for (const q of allQueries) {
    const relativeFile = relative(SRC_DIR, q.file).replaceAll("\\", "/");
    if (!byFile.has(relativeFile)) byFile.set(relativeFile, []);
    byFile.get(relativeFile)!.push(q);
  }

  for (const [file, queries] of byFile) {
    describe(file, () => {
      for (const q of queries) {
        const shortSql = q.sql.replace(/\s+/g, " ").slice(0, 80);
        it(`line ${q.line}: ${shortSql}...`, () => {
          const explainSql = q.sql.replace(/\?/g, "NULL");
          try {
            db.prepare(`EXPLAIN ${explainSql}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `Query at ${file}:${q.line} fails schema validation:\n` +
                `  SQL: ${q.sql.replace(/\s+/g, " ")}\n` +
                `  Error: ${msg}`,
            );
          }
        });
      }
    });
  }

  // -------------------------------------------------------------------------
  // 3. Guardrail: bare INSERTs into tables with secondary UNIQUE indexes
  // -------------------------------------------------------------------------
  // A bare `INSERT INTO` against a table with a secondary UNIQUE index uses
  // constraint errors as control flow under races (one error span per lost
  // race, tripping the D1 monitor). Use INSERT OR IGNORE / ON CONFLICT and
  // resolve `meta.changes === 0` instead, or add the statement to the
  // allowlist with a justification.
  describe("bare INSERT into tables with secondary UNIQUE indexes", () => {
    // `file -> table` entries where a bare INSERT is deliberate (the unique
    // key is provably unreachable concurrently, or a violation must surface
    // as a hard error).
    const ALLOWED_BARE_INSERTS = new Set<string>([
      // Duplicate-rule detection on a single user action (409 surface), not a
      // webhook race; OR IGNORE would conflate duplicates with the cap-reached
      // `changes === 0` outcome in the capped variant.
      "automation/db.ts -> scheduled_rules",
      // Manual "Run now" insert (insertManualAutomationSlotJob): the service
      // catches the (rule_id, slot_ms) unique violation from a same-ms double
      // click and maps it to a 409 run_already_requested; OR IGNORE would
      // silently no-op and then fail as run_create_failed. Single user action,
      // not a webhook race. The cron-path insert already uses ON CONFLICT.
      "automation/db.ts -> automation_slot_jobs",
      // The insert is batched with a supersede update; uniqueness violations
      // must abort the batch so the previous current base template remains
      // current.
      "sandbox/base-template-service.ts -> sandbox_base_templates",
      // Build completion batches artifact insertion with build completion and
      // optional promotion; uniqueness violations must abort the batch so the
      // build remains retryable instead of becoming completed without an
      // artifact.
      "sandbox/layer-db.ts -> sandbox_layer_artifacts",
      // Offboarding manifest creation deliberately catches the active-job unique
      // race and re-reads the winning manifest, preserving the exact row that
      // concurrent cleanup work should resume.
      "business/db.ts -> offboarding_jobs",
      // Genesis/backfill owns one coordination row per session; a duplicate
      // session_id or synthetic PR coordinator must surface as a hard invariant
      // violation rather than silently no-op.
      "session/pr-coordination-db.ts -> pr_coordination",
    ]);

    function tablesWithSecondaryUniqueIndexes(): Set<string> {
      const rows = db
        .prepare(
          `SELECT DISTINCT m.tbl_name AS table_name
           FROM sqlite_master m
           WHERE m.type = 'index' AND m.sql LIKE 'CREATE UNIQUE INDEX%'`,
        )
        .all() as Array<{ table_name: string }>;
      return new Set(rows.map((r) => r.table_name));
    }

    it("flags new bare INSERTs (use OR IGNORE / ON CONFLICT, or allowlist)", () => {
      const guarded = tablesWithSecondaryUniqueIndexes();
      const violations: string[] = [];
      for (const q of allQueries) {
        // Strip a leading block comment first: a d1-retry-safe statement reads
        // `/* d1-retry-safe */ INSERT INTO ...`, and the marker without OR IGNORE
        // on a guarded table is exactly the regression this guardrail must catch.
        const sql = q.sql
          .replace(/\s+/g, " ")
          .trim()
          .replace(/^\/\*[^*]*\*\/\s*/, "");
        const insert = sql.match(/^INSERT INTO\s+["`]?(\w+)["`]?/i);
        if (!insert) continue;
        if (!guarded.has(insert[1])) continue;
        if (/ON CONFLICT/i.test(sql)) continue;
        const relativeFile = relative(SRC_DIR, q.file).replaceAll("\\", "/");
        if (ALLOWED_BARE_INSERTS.has(`${relativeFile} -> ${insert[1]}`)) continue;
        violations.push(`${relativeFile}:${q.line} -> ${sql.slice(0, 100)}`);
      }
      expect(violations, violations.join("\n")).toEqual([]);
    });
  });
});
