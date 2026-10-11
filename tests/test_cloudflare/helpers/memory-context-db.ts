import { readFileSync } from "node:fs";

import Database from "better-sqlite3";

import {
  upsertMemoryCollection,
  upsertMemoryPeer,
  upsertMemoryScope,
} from "../../../apps/control-plane-worker/src/company-memory/context-db";
import { SqliteD1 } from "../sqlite-d1-helper";

const MEMORY_CONTEXT_MIGRATIONS = [
  "apps/control-plane-worker/migrations/0153_repo_memory_d1_sink.sql",
  "apps/control-plane-worker/migrations/0235_honcho_style_memory_context_graph.sql",
] as const;

/** Apply the repo-memory sink + Honcho-style graph migrations with FK enforcement on. */
export function applyMemoryContextMigrations(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  for (const path of MEMORY_CONTEXT_MIGRATIONS) {
    db.exec(readFileSync(path, "utf8"));
  }
}

/** In-memory SQLite wrapped as a D1Database, with the memory-context migrations applied. */
export function createMemoryContextD1(): { sqlite: Database.Database; d1: D1Database } {
  const sqlite = new Database(":memory:");
  applyMemoryContextMigrations(sqlite);
  const d1 = new SqliteD1(sqlite) as unknown as D1Database;
  return { sqlite, d1 };
}

export interface RepoMemoryGraphIds {
  scopeId: string;
  agentPeerId: string;
  repoPeerId: string;
  collectionId: string;
}

/**
 * Seed the canonical repo-scoped graph: one `repo` scope for `trycycloid/cycloid`,
 * an agent peer, a repo peer, and the agent->repo collection linking them. Returns the
 * created ids so callers can attach conclusions/sessions without re-declaring them.
 */
export async function seedRepoMemoryGraph(
  d1: D1Database,
  { nowMs = 1000 }: { nowMs?: number } = {},
): Promise<RepoMemoryGraphIds> {
  const ids: RepoMemoryGraphIds = {
    scopeId: "scope-1",
    agentPeerId: "peer-agent",
    repoPeerId: "peer-repo",
    collectionId: "collection-1",
  };
  await upsertMemoryScope(d1, {
    id: ids.scopeId,
    businessId: "biz-1",
    scopeType: "repo",
    scopeKey: "trycycloid/cycloid",
    repoOwner: "trycycloid",
    repoName: "cycloid",
    customerSlug: null,
    slackTeamId: null,
    slackChannelId: null,
    slackThreadTs: null,
    sessionId: null,
    incidentId: null,
    personId: null,
    metadataJson: "{}",
    nowMs,
  });
  await upsertMemoryPeer(d1, {
    id: ids.agentPeerId,
    businessId: "biz-1",
    peerType: "agent",
    peerKey: "cycloid",
    displayName: "Cycloid",
    metadataJson: "{}",
    nowMs,
  });
  await upsertMemoryPeer(d1, {
    id: ids.repoPeerId,
    businessId: "biz-1",
    peerType: "repo",
    peerKey: "trycycloid/cycloid",
    displayName: "trycycloid/cycloid",
    metadataJson: "{}",
    nowMs,
  });
  await upsertMemoryCollection(d1, {
    id: ids.collectionId,
    businessId: "biz-1",
    scopeId: ids.scopeId,
    observerPeerId: ids.agentPeerId,
    observedPeerId: ids.repoPeerId,
    collectionKind: "repo",
    metadataJson: "{}",
    nowMs,
  });
  return ids;
}
