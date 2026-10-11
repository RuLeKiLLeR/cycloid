// ARC-1330 (PR 37) — publish-path producer: publish outcome → spine-event mapping.
//
// The PR-37 contract test: the three pure builders carry the right `FsmEvent`/`EventMetadata`/actor, and
// a small integration leg drives `applyEvent` over a real migrated D1 (the Wave-1 createMigratedSqlite/
// asD1 idiom) to prove the emissions + resolver actually advance the shadow `pr_coordination` row from
// PUBLISHING → {REVIEW (pr_opened), ANSWERED_NO_PR (no_changes), FAILED (failed)}.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyEvent,
  noopSideEffectSink,
  noopWorklistSink,
  type SideEffectDispatch,
} from "../../../apps/control-plane-worker/src/session/fsm/apply-event";
import { buildGenesisRecord } from "../../../apps/control-plane-worker/src/session/fsm/genesis";
import {
  buildPublishFailedEmission,
  buildPublishNoChangesEmission,
  buildPublishPrOpenedEmission,
  buildPublishSupersededEmission,
  type PublishEmission,
  publishShadowResolver,
} from "../../../apps/control-plane-worker/src/session/fsm/publish-producer";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { SqliteD1 } from "../sqlite-d1-helper";

const NOW = 1_700_000_000_000;

describe("publish producer — outcome → spine-event mapping (PR 37)", () => {
  it("buildPublishPrOpenedEmission carries pr_head on the event + bare metadata + transport actor", () => {
    expect(buildPublishPrOpenedEmission("abc123")).toEqual({
      event: { type: "publish.pr_opened", prHead: "abc123" },
      metadata: { type: "publish.pr_opened" },
      actor: "transport",
    });
  });

  it("buildPublishPrOpenedEmission carries normalized structured diff stats when available", () => {
    expect(buildPublishPrOpenedEmission("abc123", { insertions: 12, deletions: -2 })).toEqual({
      event: { type: "publish.pr_opened", prHead: "abc123" },
      metadata: { type: "publish.pr_opened", diffStats: { insertions: 12, deletions: 0 } },
      actor: "transport",
    });
  });

  it("buildPublishNoChangesEmission → publish.no_changes", () => {
    expect(buildPublishNoChangesEmission()).toEqual({
      event: { type: "publish.no_changes" },
      metadata: { type: "publish.no_changes" },
      actor: "transport",
    });
  });

  it("buildPublishFailedEmission → publish.failed", () => {
    expect(buildPublishFailedEmission()).toEqual({
      event: { type: "publish.failed" },
      metadata: { type: "publish.failed" },
      actor: "transport",
    });
  });

  it("buildPublishSupersededEmission → publish.superseded (actor internal — the epoch publish guard)", () => {
    expect(buildPublishSupersededEmission()).toEqual({
      event: { type: "publish.superseded" },
      metadata: { type: "publish.superseded" },
      actor: "internal",
    });
  });

  it("publishShadowResolver threads prUrl + the committed record's verificationChildId onto the guards bag", () => {
    const withUrl = publishShadowResolver("sess-1", "https://gh/pr/1");
    const rec = { verificationChildId: "vchild-9" } as never;
    // `verificationChildId` is record-sourced (the VERIFYING supersede's kill_verification, ARC-1389).
    expect(withUrl.guards(rec, {} as never)).toEqual({
      sandboxAlive: true,
      verificationChildId: "vchild-9",
      prUrl: "https://gh/pr/1",
    });
    expect(withUrl.deadlineMs("REVIEW")).toBeNull();
    const caught = withUrl.caughtUpInputs({} as never, {} as never);
    // The conservative store can never settle a spurious MERGE_READY (an undispositioned actionable item).
    expect(caught.store.countUndispositionedActionable()).toBe(1);
    // No prUrl → omitted from the bag (no_changes / failed edges never read it).
    expect(publishShadowResolver("sess-1").guards(rec, {} as never)).toEqual({
      sandboxAlive: true,
      verificationChildId: "vchild-9",
    });
  });
});

const MIGRATIONS_DIR = resolve(__dirname, "../../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function asD1(sqlite: Database.Database): D1Database {
  return new SqliteD1(sqlite) as unknown as D1Database;
}

describe("publish producer — applyEvent integration over the shadow row (PR 37)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const depsFor = (sid: string, prUrl?: string) => ({
    db,
    env: { DD_API_KEY: undefined, WORKER_ENV: "test" },
    mode: "shadow" as const,
    now: () => NOW,
    resolver: publishShadowResolver(sid, prUrl),
    emit: vi.fn(async () => true),
    sideEffects: noopSideEffectSink,
    worklist: noopWorklistSink,
  });

  const apply = (sid: string, emission: PublishEmission, prUrl?: string) =>
    applyEvent(depsFor(sid, prUrl), {
      sessionId: sid,
      event: emission.event,
      metadata: emission.metadata,
      actor: emission.actor,
    });

  it("publish.pr_opened advances PUBLISHING → REVIEW and seeds head_sha + pr_url", async () => {
    const sid = "sess-pub-ok";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "PUBLISHING" });
    const r = await apply(sid, buildPublishPrOpenedEmission("head-sha-1"), "https://gh/pr/42");
    expect(r).toMatchObject({ outcome: "handled", to: "REVIEW" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.headSha).toBe("head-sha-1");
    expect(rec?.prUrl).toBe("https://gh/pr/42");
    expect(rec?.codeChangedSinceVerification).toBe(true);
  });

  it("publish.pr_opened adopts an existing PR directly from CREATED", async () => {
    const sid = "sess-adopt-pr";
    await insertPrCoordination(db, buildGenesisRecord(sid, NOW));
    const r = await apply(sid, buildPublishPrOpenedEmission("adopted-head-sha"), "https://gh/pr/43");
    expect(r).toMatchObject({ outcome: "handled", from: "CREATED", to: "REVIEW" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("REVIEW");
    expect(rec?.headSha).toBe("adopted-head-sha");
    expect(rec?.prUrl).toBe("https://gh/pr/43");
  });

  it("publish.no_changes settles PUBLISHING → ANSWERED_NO_PR", async () => {
    const sid = "sess-pub-nochange";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "PUBLISHING" });
    const r = await apply(sid, buildPublishNoChangesEmission());
    expect(r).toMatchObject({ outcome: "handled", to: "ANSWERED_NO_PR" });
    expect((await getPrCoordination(db, sid))?.state).toBe("ANSWERED_NO_PR");
  });

  it("publish.failed drives PUBLISHING → FAILED with the publish_failed reason", async () => {
    const sid = "sess-pub-fail";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "PUBLISHING" });
    const r = await apply(sid, buildPublishFailedEmission());
    expect(r).toMatchObject({ outcome: "handled", to: "FAILED" });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("FAILED");
    expect(rec?.failureReason).toBe("publish_failed");
  });

  it("publish.superseded settles a listening REVIEW session in the SUPERSEDED terminal (ARC-1389)", async () => {
    const sid = "sess-pub-superseded";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "REVIEW" });
    const r = await apply(sid, buildPublishSupersededEmission());
    expect(r).toMatchObject({ outcome: "handled", to: "SUPERSEDED" });
    expect((await getPrCoordination(db, sid))?.state).toBe("SUPERSEDED");
  });

  it("publish.superseded leaving VERIFYING dispatches kill_verification with the committed run's child (ARC-1389)", async () => {
    const sid = "sess-pub-superseded-verifying";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "VERIFYING",
      verificationChildId: "vchild-42",
    });
    const dispatches: SideEffectDispatch[] = [];
    const sink = { dispatch: (d: SideEffectDispatch) => void dispatches.push(d) };
    const emission = buildPublishSupersededEmission();
    const r = await applyEvent(
      { ...depsFor(sid), sideEffects: sink },
      { sessionId: sid, event: emission.event, metadata: emission.metadata, actor: emission.actor },
    );
    expect(r).toMatchObject({ outcome: "handled", to: "SUPERSEDED" });
    expect((await getPrCoordination(db, sid))?.state).toBe("SUPERSEDED");
    // The teardown of the in-flight verifier carries the COMMITTED record's child id — not a null handle.
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].sideEffects).toContainEqual({
      kind: "kill_verification",
      args: { verificationChildId: "vchild-42" },
    });
  });

  it("publish.superseded outside the listening states is an unhandled no-op (PUBLISHING keeps its state)", async () => {
    const sid = "sess-pub-superseded-noop";
    await insertPrCoordination(db, { ...buildGenesisRecord(sid, NOW), state: "PUBLISHING" });
    const r = await apply(sid, buildPublishSupersededEmission());
    expect(r).toMatchObject({ outcome: "unhandled" });
    expect((await getPrCoordination(db, sid))?.state).toBe("PUBLISHING");
  });
});
