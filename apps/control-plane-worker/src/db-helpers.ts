import { createLogger } from "./logger";
import { decrypt } from "./settings/encryption";

const log = createLogger({ bindings: { component: "db-helpers" } });

// ---------------------------------------------------------------------------
// Generic upsert helper
// ---------------------------------------------------------------------------

interface UpsertOptions {
  /** Table name */
  table: string;
  /** Column names in insertion order */
  columns: string[];
  /** Values matching `columns` (same order, same length) */
  values: unknown[];
  /** Columns that form the unique constraint (used in ON CONFLICT) */
  conflictKeys: string[];
  /**
   * Optional overrides for individual SET clauses.
   * Use COALESCE or other expressions when the default `excluded.<col>` isn't enough.
   * Keys not present here get the default `col = excluded.col`.
   */
  updateOverrides?: Record<string, string>;
  /** Columns to exclude from the SET clause entirely (e.g. created_at). */
  excludeFromUpdate?: string[];
}

/**
 * Build and execute an INSERT ... ON CONFLICT DO UPDATE statement.
 *
 * Reduces the per-function boilerplate for upsert queries that follow the same
 * pattern: insert a row, and on conflict update every column except the conflict
 * keys and any explicitly excluded columns.
 *
 * SECURITY: `table`, `columns`, `conflictKeys`, and `updateOverrides` values are
 * interpolated directly into SQL. All callers MUST pass compile-time constants for
 * these parameters -- never user-derived or dynamic data.
 */
export async function upsertRow(db: D1Database, opts: UpsertOptions): Promise<void> {
  const { table, columns, values, conflictKeys, updateOverrides, excludeFromUpdate } = opts;

  const placeholders = columns.map(() => "?").join(", ");
  const skipSet = new Set([...conflictKeys, ...(excludeFromUpdate ?? [])]);

  const setClauses = columns
    .filter((col) => !skipSet.has(col))
    .map((col) => {
      if (updateOverrides?.[col]) return `${col} = ${updateOverrides[col]}`;
      return `${col} = excluded.${col}`;
    });

  if (setClauses.length === 0) {
    throw new Error(`upsertRow: no SET clauses generated for table "${table}". All columns are excluded from updates.`);
  }

  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(${conflictKeys.join(", ")}) DO UPDATE SET
         ${setClauses.join(",\n         ")}`;

  await db
    .prepare(sql)
    .bind(...values)
    .run();
}

// ---------------------------------------------------------------------------
// Generic get-and-decrypt helper
// ---------------------------------------------------------------------------

interface GetEncryptedFieldOpts<T> {
  /** SQL query that selects the row (should include LIMIT 1) */
  sql: string;
  /** Bind parameters for the query */
  binds: unknown[];
  /** Which fields on the returned row should be decrypted */
  encryptedFields: (keyof T & string)[];
  /** The encryption key (may be undefined if encryption is disabled) */
  encryptionKey: string | undefined;
  /** Stable credential context for decrypt failure logs. */
  context?: string;
}

/**
 * Execute a single-row query, null-check the result, and decrypt specified
 * fields. Returns null if the row is missing or any encrypted field is null.
 */
export async function getEncryptedRow<T extends Record<string, unknown>>(
  db: D1Database,
  opts: GetEncryptedFieldOpts<T>,
): Promise<T | null> {
  const row = await db
    .prepare(opts.sql)
    .bind(...opts.binds)
    .first<T>();
  if (!row) return null;

  // Ensure all encrypted fields are present
  for (const field of opts.encryptedFields) {
    if (row[field] == null) return null;
  }

  if (opts.encryptionKey == null) {
    for (const field of opts.encryptedFields) {
      if (typeof row[field] === "string" && row[field].startsWith("enc:")) {
        log.warn(
          {
            action: "encrypted_row.decrypt_failed",
            reason: "encryption_key_missing",
            context: opts.context,
            field,
          },
          "Cannot decrypt encrypted row: TOKEN_ENCRYPTION_KEY missing",
        );
        return null;
      }
    }
  }

  // Decrypt in-place
  try {
    for (const field of opts.encryptedFields) {
      (row as Record<string, unknown>)[field] = await decrypt(row[field] as string, opts.encryptionKey);
    }
  } catch (err) {
    log.warn(
      {
        action: "encrypted_row.decrypt_failed",
        reason: "decrypt_threw",
        context: opts.context,
        fields: opts.encryptedFields,
        error: String(err),
      },
      "Failed to decrypt encrypted row",
    );
    return null;
  }

  return row;
}
