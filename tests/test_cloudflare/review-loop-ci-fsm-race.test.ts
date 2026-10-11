import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createFsmDispatchedReviewLoopEpoch,
  REVIEW_LOOP_EPOCH_SENTINELS,
  upsertReviewLoopEpochActivity,
} from "../../apps/control-plane-worker/src/services/review-loop-epochs";
import { SqliteD1, type SqliteD1Statement } from "./sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

class InterleavingD1 extends SqliteD1 {
  constructor(
    db: Database.Database,
    private readonly beforeRun: (query: string) => Promise<void>,
  ) {
    super(db);
  }

  override prepare(query: string): SqliteD1Statement {
    const statement = super.prepare(query);
    const run = statement.run.bind(statement);
    statement.run = async () => {
      await this.beforeRun(query);
      return run();
    };
    return statement;
  }
}

describe("FSM CI retry creation races", () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
    db = new SqliteD1(sqlite) as unknown as D1Database;
  });

  it("does not open wave N+2 when legacy CI ingest wins wave N+1 between provenance read and insert", async () => {
    const common = {
      sessionId: "sess-ci-race",
      ownerUserId: 7,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 99,
      prUrl: "https://github.com/acme/repo/pull/99",
      headSha: "head-1",
      expectedBots: [],
      expectedBotsHash: REVIEW_LOOP_EPOCH_SENTINELS.ciExpectedBotsHash,
      sourceKind: REVIEW_LOOP_EPOCH_SENTINELS.ciSourceKind,
      botKey: "ci",
      botActorLogin: null,
      terminal: true,
    } as const;
    const predecessor = await upsertReviewLoopEpochActivity(db, {
      ...common,
      sourceId: "check-run-failure:123",
      evidence: { type: "ci_failure", sourceId: "check-run-failure:123" },
      nowMs: 1_000,
    });
    sqlite.prepare(`UPDATE pr_review_response_epochs SET status = 'completed' WHERE id = ?`).run(predecessor.id);

    let legacyWaveInserted = false;
    const raceDb = new InterleavingD1(sqlite, async (query) => {
      if (legacyWaveInserted || !query.includes("INSERT OR IGNORE INTO pr_review_response_epochs")) return;
      legacyWaveInserted = true;
      await upsertReviewLoopEpochActivity(db, {
        ...common,
        sourceId: "check-run-failure:456",
        evidence: { type: "ci_failure", sourceId: "check-run-failure:456" },
        nowMs: 2_000,
      });
    }) as unknown as D1Database;

    const created = await createFsmDispatchedReviewLoopEpoch(raceDb, {
      id: "epoch-sess-ci-race-2",
      sessionId: common.sessionId,
      ownerUserId: common.ownerUserId,
      repoOwner: common.repoOwner,
      repoName: common.repoName,
      prNumber: common.prNumber,
      prUrl: common.prUrl,
      headSha: common.headSha,
      kind: "ci",
      predecessorEpochId: predecessor.id,
      sourceIds: predecessor.triggeringSourceIds,
      nowMs: 3_000,
    });

    expect(legacyWaveInserted).toBe(true);
    expect(created).toBeNull();
    expect(
      sqlite
        .prepare(
          `SELECT id, wave, status FROM pr_review_response_epochs
           WHERE session_id = ? AND pr_url = ? AND head_sha = ? AND source_kind = 'ci'
           ORDER BY wave`,
        )
        .all(common.sessionId, common.prUrl, common.headSha),
    ).toEqual([
      { id: predecessor.id, wave: 1, status: "completed" },
      { id: expect.any(String), wave: 2, status: "ready" },
    ]);
  });
});
