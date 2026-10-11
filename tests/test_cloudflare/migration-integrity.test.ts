/**
 * Migration integrity test: ensures D1 migration files have unique, sequential
 * version prefixes. Migrations apply via wrangler native (`d1 migrations apply`),
 * which keys on the full filename; this test stops two files sharing a numeric
 * prefix before deployment.
 *
 * HOW TO FIX A FAILING TEST:
 *   Renumber the conflicting migration file to the next available version.
 *   e.g. if 0012_foo.sql and 0012_bar.sql both exist, rename one to 0013_bar.sql.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

function getMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

describe("D1 migration integrity", () => {
  it("does not use explicit transaction control statements", () => {
    const files = getMigrationFiles();
    const violations = files.flatMap((file) => {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
      return sql
        .split(";")
        .map((statement) => statement.trim().replace(/\s+/g, " "))
        .filter((statement) =>
          /^(BEGIN(?:\s+TRANSACTION)?|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i.test(statement),
        )
        .map((statement) => `${file}: ${statement}`);
    });

    expect(
      violations,
      `D1 remote migrations are applied through wrangler d1 migrations apply, which rejects explicit transactions:\n${violations.join("\n")}`,
    ).toHaveLength(0);
  });

  it("every migration file has a unique version prefix", () => {
    const files = getMigrationFiles();
    const versionToFiles = new Map<string, string[]>();

    for (const file of files) {
      const match = file.match(/^(\d+)/);
      if (!match) continue;
      const version = match[1];
      const existing = versionToFiles.get(version) ?? [];
      existing.push(file);
      versionToFiles.set(version, existing);
    }

    const duplicates = [...versionToFiles.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([version, files]) => `  Version ${version}: ${files.join(", ")}`);

    expect(duplicates, `Duplicate migration versions found:\n${duplicates.join("\n")}`).toHaveLength(0);
  });

  it("version prefixes are sequential with no gaps", () => {
    const files = getMigrationFiles();
    const versions = files
      .map((f) => {
        const match = f.match(/^(\d+)/);
        return match ? parseInt(match[1], 10) : null;
      })
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);

    for (let i = 1; i < versions.length; i++) {
      expect(
        versions[i],
        `Gap in migration versions: ${versions[i - 1]} -> ${versions[i]}. ` + `Expected ${versions[i - 1] + 1}.`,
      ).toBe(versions[i - 1] + 1);
    }
  });

  it("adds indexed E2B runtime state projection fields", () => {
    const migration = readFileSync(resolve(MIGRATIONS_DIR, "0087_e2b_runtime_state.sql"), "utf8");

    expect(migration).toContain("ALTER TABLE session_index ADD COLUMN runtime_provider TEXT;");
    expect(migration).toContain("ALTER TABLE session_index ADD COLUMN runtime_state TEXT;");
    expect(migration).toContain("ALTER TABLE session_index ADD COLUMN runtime_last_provider_refreshed_at INTEGER;");
    expect(migration).toContain("ALTER TABLE session_index ADD COLUMN runtime_provider_ttl_expires_at INTEGER;");
    expect(migration).toContain(
      "CREATE INDEX IF NOT EXISTS idx_session_index_runtime_expiry\n  ON session_index(runtime_provider, runtime_state, runtime_state_expires_at);",
    );
    expect(migration).toContain(
      "CREATE INDEX IF NOT EXISTS idx_session_index_runtime_live_lease\n  ON session_index(runtime_provider, runtime_state, runtime_live_lease_expires_at);",
    );
  });
});
