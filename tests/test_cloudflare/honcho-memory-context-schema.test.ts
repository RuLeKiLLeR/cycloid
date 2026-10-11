import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { applyMemoryContextMigrations } from "./helpers/memory-context-db";

function insertScopePeerCollection(db: Database.Database): void {
  db.prepare(
    `INSERT INTO memory_scopes
      (id, business_id, scope_type, scope_key, repo_owner, repo_name, created_at_ms, updated_at_ms)
     VALUES ('scope-repo', 'biz-1', 'repo', 'trycycloid/cycloid', 'trycycloid', 'cycloid', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO memory_peers
      (id, business_id, peer_type, peer_key, display_name, created_at_ms, updated_at_ms)
     VALUES ('peer-agent', 'biz-1', 'agent', 'cycloid', 'Cycloid', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO memory_peers
      (id, business_id, peer_type, peer_key, display_name, created_at_ms, updated_at_ms)
     VALUES ('peer-repo', 'biz-1', 'repo', 'trycycloid/cycloid', 'trycycloid/cycloid', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO memory_collections
      (id, business_id, scope_id, observer_peer_id, observed_peer_id, collection_kind, created_at_ms, updated_at_ms)
     VALUES ('collection-1', 'biz-1', 'scope-repo', 'peer-agent', 'peer-repo', 'repo', 1000, 1000)`,
  ).run();
}

describe("0220 Honcho-style memory context graph migration", () => {
  it("creates directional graph tables with scoped uniqueness constraints", () => {
    const db = new Database(":memory:");
    applyMemoryContextMigrations(db);
    insertScopePeerCollection(db);

    expect(() => {
      db.prepare(
        `INSERT INTO memory_collections
          (id, business_id, scope_id, observer_peer_id, observed_peer_id, collection_kind, created_at_ms, updated_at_ms)
         VALUES ('collection-dupe', 'biz-1', 'scope-repo', 'peer-agent', 'peer-repo', 'repo', 1000, 1000)`,
      ).run();
    }).toThrow(/UNIQUE constraint failed/);
  });

  it("keeps repo, conclusion, and message FTS tables in sync", () => {
    const db = new Database(":memory:");
    applyMemoryContextMigrations(db);
    insertScopePeerCollection(db);

    db.prepare(
      `INSERT INTO repo_memories
        (id, repo_owner, repo_name, memory_id, status, memory_type, level, primitive, confidence, authority,
         enforcement, context_hint, content, applies_to_json, source_session_ids_json, memory_json, created_at_ms, updated_at_ms)
       VALUES ('repo-row-1', 'trycycloid', 'cycloid', 'repo-rule-1', 'active', 'action', 'tactical',
         'procedure', 'high', 'reviewed', 'warn', 'DAO boundary for routes',
         'Routes must call services before prepared statements.', '["apps/control-plane-worker/src/routes/**"]',
         '[]', '{}', 1000, 1000)`,
    ).run();

    db.prepare(
      `INSERT INTO memory_sessions
        (id, business_id, scope_id, source_kind, source_id, created_at_ms, updated_at_ms)
       VALUES ('session-1', 'biz-1', 'scope-repo', 'arcanist_session', 's-1', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO memory_messages
        (id, business_id, session_id, seq_in_session, role, content_text, occurred_at_ms, created_at_ms)
       VALUES ('message-1', 'biz-1', 'session-1', 1, 'user', 'Customer mentioned SOC2 onboarding.', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO memory_conclusions
        (id, business_id, collection_id, scope_id, kind, content, level, status, confidence, authority,
         created_at_ms, updated_at_ms)
       VALUES ('conclusion-1', 'biz-1', 'collection-1', 'scope-repo', 'company_fact',
         'SOC2 onboarding matters for this customer.', 'explicit', 'active', 'high', 'reviewed', 1000, 1000)`,
    ).run();

    expect(db.prepare("SELECT rowid FROM repo_memories_fts WHERE repo_memories_fts MATCH 'prepared'").all()).toEqual([
      { rowid: db.prepare("SELECT rowid FROM repo_memories WHERE id = 'repo-row-1'").get().rowid },
    ]);
    expect(
      db.prepare("SELECT rowid FROM memory_messages_fts WHERE memory_messages_fts MATCH 'onboarding'").all(),
    ).toEqual([{ rowid: db.prepare("SELECT rowid FROM memory_messages WHERE id = 'message-1'").get().rowid }]);
    expect(
      db.prepare("SELECT rowid FROM memory_conclusions_fts WHERE memory_conclusions_fts MATCH 'SOC2'").all(),
    ).toEqual([{ rowid: db.prepare("SELECT rowid FROM memory_conclusions WHERE id = 'conclusion-1'").get().rowid }]);
  });

  it("records semantic documents as non-authoritative vector catalog rows", () => {
    const db = new Database(":memory:");
    applyMemoryContextMigrations(db);

    db.prepare(
      `INSERT INTO memory_semantic_documents
        (id, source_kind, source_id, business_id, repo_owner, repo_name, scope_type, scope_id, text,
         content_hash, embedding_model, embedding_dim, vector_namespace, vector_id, vector_state, updated_at_ms)
       VALUES ('doc-1', 'repo_memory', 'repo-row-1', 'biz-1', 'trycycloid', 'cycloid', 'repo',
         'scope-repo', 'Remember DAO boundaries.', 'hash-1', 'text-embedding-3-small', 1536,
         'biz-1', 'vec-1', 'pending', 1000)`,
    ).run();

    expect(() => {
      db.prepare(
        `INSERT INTO memory_semantic_documents
          (id, source_kind, source_id, business_id, scope_type, scope_id, text, content_hash,
           embedding_model, embedding_dim, vector_namespace, vector_id, vector_state, updated_at_ms)
         VALUES ('doc-duplicate', 'repo_memory', 'repo-row-1', 'biz-1', 'repo', 'scope-repo',
           'Duplicate.', 'hash-2', 'text-embedding-3-small', 1536, 'biz-1', 'vec-2', 'pending', 1000)`,
      ).run();
    }).toThrow(/UNIQUE constraint failed/);
  });
});
