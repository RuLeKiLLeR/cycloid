import type Database from "better-sqlite3";

/**
 * Minimal `D1Database`-shaped adapter over an in-memory better-sqlite3 database,
 * with real `batch()` support (run inside a single transaction so a constraint
 * violation rolls back the whole batch, matching D1 semantics). Use for DAO
 * tests that need real SQLite constraint enforcement (unique indexes, primary
 * keys) rather than the hand-rolled FakeD1 mock.
 */
export class SqliteD1Statement {
  boundValues: unknown[] = [];

  constructor(
    readonly db: Database.Database,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  runSync<T = unknown>(): { success: true; meta: { changes: number }; results?: T[] } {
    const statement = this.db.prepare(this.query);
    if (statement.reader) {
      return { success: true, meta: { changes: 0 }, results: statement.all(...this.boundValues) as T[] };
    }
    const result = statement.run(...this.boundValues);
    return { success: true, meta: { changes: result.changes } };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.runSync();
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

export class SqliteD1 {
  constructor(readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }

  async batch<T = unknown>(
    statements: SqliteD1Statement[],
  ): Promise<Array<{ success: true; meta: { changes: number }; results?: T[] }>> {
    const tx = this.db.transaction(() => statements.map((statement) => statement.runSync<T>()));
    return tx();
  }
}

/** Create the subset of schema the Slack-link DAO/service touch. */
export function createSlackLinkSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      login TEXT,
      business_id TEXT
    );

    CREATE TABLE user_integrations (
      user_id INTEGER NOT NULL REFERENCES users(id),
      integration_id TEXT NOT NULL,
      oauth_access_token TEXT,
      oauth_refresh_token TEXT,
      oauth_expires_at INTEGER,
      api_key TEXT,
      external_user_id TEXT,
      external_team_id TEXT,
      service_url TEXT,
      encrypted INTEGER NOT NULL DEFAULT 0,
      last_validated_at INTEGER,
      last_validation_status TEXT,
      last_validation_reason_code TEXT,
      connected_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, integration_id)
    );
    CREATE UNIQUE INDEX idx_user_integrations_external_user
      ON user_integrations(integration_id, external_user_id)
      WHERE external_user_id IS NOT NULL;

    CREATE TABLE slack_workspaces (
      team_id TEXT PRIMARY KEY,
      bot_token_encrypted TEXT NOT NULL,
      bot_user_id TEXT NOT NULL,
      team_name TEXT,
      business_id TEXT,
      team_domain TEXT,
      enterprise_id TEXT,
      installed_by_user_id INTEGER REFERENCES users(id),
      installed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      uninstalled_at INTEGER
    );

    CREATE TABLE slack_link_token_consumptions (
      jti TEXT PRIMARY KEY,
      slack_team_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      consumed_by_user_id INTEGER NOT NULL REFERENCES users(id),
      consumed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_slack_link_consumptions_expires ON slack_link_token_consumptions(expires_at);
  `);
}
