import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  consolidateMemoryScopeCardForScope,
  parseMemoryScopeCardJson,
} from "../../apps/control-plane-worker/src/company-memory/context-consolidation";
import { insertMemoryConclusion } from "../../apps/control-plane-worker/src/company-memory/context-db";
import { createMemoryContextD1, seedRepoMemoryGraph } from "./helpers/memory-context-db";

describe("memory context consolidation", () => {
  let sqlite: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    ({ sqlite, d1 } = createMemoryContextD1());
  });

  it("writes a typed scope card only after the scope is idle", async () => {
    await seedRepoMemoryGraph(d1);
    await insertMemoryConclusion(d1, {
      id: "conclusion-1",
      businessId: "biz-1",
      collectionId: "collection-1",
      scopeId: "scope-1",
      kind: "constraint",
      content: "Routes call services before DAO functions.",
      level: "explicit",
      status: "active",
      confidence: "high",
      authority: "reviewed",
      enforcement: "warn",
      sourceKind: "repo_memory",
      sourceId: "repo-rule-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      validUntilMs: null,
      metadataJson: "{}",
      nowMs: 1000,
    });

    await expect(
      consolidateMemoryScopeCardForScope(d1, {
        businessId: "biz-1",
        scopeId: "scope-1",
        observerPeerId: "peer-agent",
        observedPeerId: "peer-repo",
        idleMs: 500,
        limit: 10,
        nowMs: 1200,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "not_idle", entryCount: 0 });

    await expect(
      consolidateMemoryScopeCardForScope(d1, {
        businessId: "biz-1",
        scopeId: "scope-1",
        observerPeerId: "peer-agent",
        observedPeerId: "peer-repo",
        idleMs: 500,
        limit: 10,
        nowMs: 2000,
      }),
    ).resolves.toEqual({ status: "written", reason: "ok", entryCount: 1 });

    const row = sqlite
      .prepare(
        "SELECT card_json AS cardJson, source_conclusion_ids_json AS sourceConclusionIdsJson FROM memory_scope_cards",
      )
      .get() as {
      cardJson: string;
      sourceConclusionIdsJson: string;
    };
    expect(JSON.parse(row.cardJson)).toEqual({
      version: 1,
      entries: [
        {
          kind: "constraint",
          content: "Routes call services before DAO functions.",
          conclusionId: "conclusion-1",
          confidence: "high",
          level: "explicit",
        },
      ],
    });
    expect(JSON.parse(row.sourceConclusionIdsJson)).toEqual(["conclusion-1"]);
  });

  it("derives an idempotent contradiction conclusion with source-chain edges after idle", async () => {
    await seedRepoMemoryGraph(d1);
    await insertMemoryConclusion(d1, {
      id: "conclusion-negative",
      businessId: "biz-1",
      collectionId: "collection-1",
      scopeId: "scope-1",
      kind: "fact",
      content: "Globex renewal does not require SOC2 evidence.",
      level: "explicit",
      status: "active",
      confidence: "medium",
      authority: "reviewed",
      enforcement: "none",
      sourceKind: "memory_message",
      sourceId: "message-negative",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      validUntilMs: null,
      metadataJson: "{}",
      nowMs: 1000,
    });
    await insertMemoryConclusion(d1, {
      id: "conclusion-positive",
      businessId: "biz-1",
      collectionId: "collection-1",
      scopeId: "scope-1",
      kind: "fact",
      content: "Globex renewal requires SOC2 evidence.",
      level: "explicit",
      status: "active",
      confidence: "medium",
      authority: "reviewed",
      enforcement: "none",
      sourceKind: "memory_message",
      sourceId: "message-positive",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      validUntilMs: null,
      metadataJson: "{}",
      nowMs: 1000,
    });

    await expect(
      consolidateMemoryScopeCardForScope(d1, {
        businessId: "biz-1",
        scopeId: "scope-1",
        observerPeerId: "peer-agent",
        observedPeerId: "peer-repo",
        idleMs: 500,
        limit: 10,
        nowMs: 2000,
      }),
    ).resolves.toEqual({ status: "written", reason: "ok", entryCount: 2 });

    const contradiction = sqlite
      .prepare(
        `SELECT id, kind, content, level, status, confidence, authority, enforcement,
                source_kind AS sourceKind, source_id AS sourceId, metadata_json AS metadataJson
         FROM memory_conclusions
         WHERE business_id = ?
           AND scope_id = ?
           AND level = 'contradiction'`,
      )
      .get("biz-1", "scope-1") as
      | {
          id: string;
          kind: string;
          content: string;
          level: string;
          status: string;
          confidence: string;
          authority: string;
          enforcement: string;
          sourceKind: string;
          sourceId: string;
          metadataJson: string;
        }
      | undefined;
    expect(contradiction).toMatchObject({
      kind: "contradiction",
      level: "contradiction",
      status: "active",
      confidence: "low",
      authority: "inferred",
      enforcement: "none",
      sourceKind: "memory_conclusion",
      sourceId: "conclusion-negative",
    });
    expect(contradiction?.content).toContain("Globex renewal does not require SOC2 evidence.");
    expect(contradiction?.content).toContain("Globex renewal requires SOC2 evidence.");
    expect(JSON.parse(contradiction?.metadataJson ?? "{}")).toEqual({
      premiseConclusionIds: ["conclusion-negative", "conclusion-positive"],
    });

    const sources = sqlite
      .prepare(
        `SELECT source_kind AS sourceKind, source_id AS sourceId, excerpt, relationship
         FROM memory_conclusion_sources
         WHERE conclusion_id = ?
         ORDER BY source_id ASC`,
      )
      .all(contradiction?.id) as Array<{ sourceKind: string; sourceId: string; excerpt: string; relationship: string }>;
    expect(sources).toEqual([
      {
        sourceKind: "memory_conclusion",
        sourceId: "conclusion-negative",
        excerpt: "Globex renewal does not require SOC2 evidence.",
        relationship: "contradicts",
      },
      {
        sourceKind: "memory_conclusion",
        sourceId: "conclusion-positive",
        excerpt: "Globex renewal requires SOC2 evidence.",
        relationship: "contradicts",
      },
    ]);

    await consolidateMemoryScopeCardForScope(d1, {
      businessId: "biz-1",
      scopeId: "scope-1",
      observerPeerId: "peer-agent",
      observedPeerId: "peer-repo",
      idleMs: 500,
      limit: 10,
      nowMs: 3000,
    });

    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_conclusions
           WHERE business_id = ?
             AND scope_id = ?
             AND level = 'contradiction'`,
        )
        .get("biz-1", "scope-1"),
    ).toEqual({ count: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_conclusion_sources
           WHERE conclusion_id = ?`,
        )
        .get(contradiction?.id),
    ).toEqual({ count: 2 });
  });

  it("does not derive contradictions before the scope is idle", async () => {
    await seedRepoMemoryGraph(d1);
    await insertMemoryConclusion(d1, {
      id: "conclusion-negative",
      businessId: "biz-1",
      collectionId: "collection-1",
      scopeId: "scope-1",
      kind: "fact",
      content: "Globex renewal does not require SOC2 evidence.",
      level: "explicit",
      status: "active",
      confidence: "medium",
      authority: "reviewed",
      enforcement: "none",
      sourceKind: "memory_message",
      sourceId: "message-negative",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      validUntilMs: null,
      metadataJson: "{}",
      nowMs: 1000,
    });
    await insertMemoryConclusion(d1, {
      id: "conclusion-positive",
      businessId: "biz-1",
      collectionId: "collection-1",
      scopeId: "scope-1",
      kind: "fact",
      content: "Globex renewal requires SOC2 evidence.",
      level: "explicit",
      status: "active",
      confidence: "medium",
      authority: "reviewed",
      enforcement: "none",
      sourceKind: "memory_message",
      sourceId: "message-positive",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      validUntilMs: null,
      metadataJson: "{}",
      nowMs: 1000,
    });

    await expect(
      consolidateMemoryScopeCardForScope(d1, {
        businessId: "biz-1",
        scopeId: "scope-1",
        observerPeerId: "peer-agent",
        observedPeerId: "peer-repo",
        idleMs: 500,
        limit: 10,
        nowMs: 1200,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "not_idle", entryCount: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_conclusions
           WHERE business_id = ?
             AND scope_id = ?
             AND level = 'contradiction'`,
        )
        .get("biz-1", "scope-1"),
    ).toEqual({ count: 0 });
  });

  it("rejects invalid scope-card entries and behavioral fluff", () => {
    expect(
      parseMemoryScopeCardJson(
        JSON.stringify({
          version: 1,
          entries: [
            { kind: "vibe", content: "Acme requires SOC2.", conclusionId: "c1", confidence: "high", level: "explicit" },
          ],
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid_entry_kind" });
    expect(
      parseMemoryScopeCardJson(
        JSON.stringify({
          version: 1,
          entries: [
            {
              kind: "fact",
              content: "Always remember to be careful with Acme.",
              conclusionId: "c1",
              confidence: "high",
              level: "explicit",
            },
          ],
        }),
      ),
    ).toEqual({ ok: false, reason: "behavioral_fluff" });
  });
});
