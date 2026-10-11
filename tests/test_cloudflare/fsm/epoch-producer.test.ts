// ARC-1330 (PR 41) — epoch-terminal producer: review-loop epoch terminals → `epoch.*` (+ dispositions).
//
// The PR-41 contract test: the PURE classifier (terminal kind → spine event + §18.6 metadata slice +
// the disposition to stamp) + the builder (event/metadata/internal actor) + the record-derived resolver +
// the disposition-writing side-effect sink, then a small integration leg driving `shadowEmitEpochTerminal`
// over a real migrated D1 (the Wave-1 createMigratedSqlite/asD1 idiom) to prove a settled terminal lands
// the spine event AND writes the disposition rows, and that the owner-approval terminal routes the shadow
// row to `NEEDS_YOU{owner_approval}` (the design's sole owner-approval path, the reachability blocker fix).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildEpochTerminalEmission,
  classifyEpochTerminal,
  emitEpochDeferralToSpine,
  epochDispositionSink,
  shadowEmitEpochTerminal,
} from "../../../apps/control-plane-worker/src/session/fsm/epoch-producer";
import { buildGenesisRecord } from "../../../apps/control-plane-worker/src/session/fsm/genesis";
import { blockedReasonDisplay } from "../../../apps/control-plane-worker/src/session/fsm/project";
import type { SideEffect } from "../../../apps/control-plane-worker/src/session/fsm/types";
import {
  getPrCoordination,
  insertPrCoordination,
} from "../../../apps/control-plane-worker/src/session/pr-coordination-db";
import { listPrCoordinationEvents } from "../../../apps/control-plane-worker/src/session/pr-coordination-events-db";
import { listForPr } from "../../../apps/control-plane-worker/src/session/pr-review-item-disposition-db";
import { SqliteD1 } from "../sqlite-d1-helper";

const mocks = vi.hoisted(() => ({
  getSessionState: vi.fn(),
  syncSessionProjection: vi.fn(async () => {}),
  postDd: vi.fn(async () => true),
  postInternalAlert: vi.fn(async () => null),
  resolveInternalAlertOwnerLabel: vi.fn(async () => "owner"),
}));

vi.mock("../../../apps/control-plane-worker/src/session/state", () => ({
  getSessionState: mocks.getSessionState,
}));

vi.mock("../../../apps/control-plane-worker/src/services/session-projection", () => ({
  syncSessionProjection: mocks.syncSessionProjection,
}));

vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as Record<string, unknown>), postStructuredEventToDd: mocks.postDd };
});

vi.mock("../../../apps/control-plane-worker/src/slack/internal-alerts", () => ({
  postInternalAlert: mocks.postInternalAlert,
}));

vi.mock("../../../apps/control-plane-worker/src/slack/internal-alert-session-context", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    resolveInternalAlertOwnerLabel: mocks.resolveInternalAlertOwnerLabel,
  };
});

// ARC-1428 regression: wrap applyEvent (delegating to the REAL impl) to capture the `deps` each producer
// builds, so we can assert `shadowEmitEpochTerminal` threads its `waitUntil` seam ONTO deps. Behavior is
// unchanged for every other test — the wrapper just records deps then calls through.
type ApplyEventModule = typeof import("../../../apps/control-plane-worker/src/session/fsm/apply-event");
const capture = vi.hoisted(() => ({
  deps: [] as import("../../../apps/control-plane-worker/src/session/fsm/apply-event").ApplyEventDeps[],
  applyEventError: null as Error | null,
}));
vi.mock("../../../apps/control-plane-worker/src/session/fsm/apply-event", async (importOriginal) => {
  const actual = await importOriginal<ApplyEventModule>();
  return {
    ...actual,
    applyEvent: (
      deps: Parameters<ApplyEventModule["applyEvent"]>[0],
      input: Parameters<ApplyEventModule["applyEvent"]>[1],
    ) => {
      capture.deps.push(deps);
      if (capture.applyEventError) throw capture.applyEventError;
      return actual.applyEvent(deps, input);
    },
  };
});

const NOW = 1_700_000_000_000;

const SESSION = {
  sessionId: "sess-owner",
  ownerUserId: "7",
  businessId: "biz-1",
  status: "active",
  createdAt: "",
  updatedAt: "",
  closedAt: null,
  lastEventId: null,
  title: null,
  repoOwner: "o",
  repoName: "r",
  installationId: 42,
};

function resetMocks(): void {
  capture.applyEventError = null;
  mocks.getSessionState.mockReset().mockResolvedValue(SESSION);
  mocks.syncSessionProjection.mockReset().mockResolvedValue(undefined);
  mocks.postDd.mockReset().mockResolvedValue(true);
  mocks.postInternalAlert.mockReset().mockResolvedValue(null);
  mocks.resolveInternalAlertOwnerLabel.mockReset().mockResolvedValue("owner");
}

function ddEvents(name: string, sessionId?: string): Record<string, unknown>[] {
  return mocks.postDd.mock.calls
    .map((call) => call[1] as Record<string, unknown>)
    .filter((event) => event.event === name && (sessionId === undefined || event.session_id === sessionId));
}

describe("epoch producer — terminal classification (PR 41)", () => {
  it("classifyEpochTerminal maps each terminal kind to its spine event + §18.6 slice + disposition", () => {
    const base = {
      epochId: "ep-1",
      epochTrigger: "review" as const,
      sourceIds: ["review:1", "review:2"],
      headSha: "h1",
    };

    const committed = classifyEpochTerminal({ ...base, kind: "committed" });
    expect(committed.event).toEqual({ type: "epoch.committed", epochId: "ep-1" });
    expect(committed.metadata).toEqual({
      type: "epoch.committed",
      epochId: "ep-1",
      epochTrigger: "review",
      sourceIds: ["review:1", "review:2"],
      headBefore: "h1",
      headAfter: "h1",
      disposition: "fixed",
    });
    expect(committed.disposition).toBe("fixed");

    expect(classifyEpochTerminal({ ...base, kind: "replied" }).event).toEqual({
      type: "epoch.replied",
      epochId: "ep-1",
    });
    expect(classifyEpochTerminal({ ...base, kind: "replied" }).disposition).toBe("replied");

    const declined = classifyEpochTerminal({ ...base, kind: "declined", basis: "out of scope" });
    expect(declined.event).toEqual({ type: "epoch.declined", epochId: "ep-1" });
    expect(declined.disposition).toBe("declined");
    expect(declined.basis).toBe("out of scope");

    // owner-approval: the epoch.blocked event carries reason + trigger; NO disposition is stamped.
    const blocked = classifyEpochTerminal({ ...base, kind: "blocked_owner_approval", epochTrigger: "ci_fix" });
    expect(blocked.event).toEqual({
      type: "epoch.blocked",
      epochId: "ep-1",
      reason: "owner_approval",
      trigger: "ci_fix",
    });
    expect(blocked.metadata).toMatchObject({
      type: "epoch.blocked",
      reason: "owner_approval",
      disposition: null,
      epochTrigger: "ci_fix",
    });
    expect(blocked.disposition).toBeNull();

    // response_failed: an agent fix/reply POST that failed past its cap → epoch.blocked{response_failed},
    // NO disposition (items stay undispositioned, routing to NEEDS_YOU). ARC-1330.
    const responseFailed = classifyEpochTerminal({ ...base, kind: "blocked_response_failed" });
    expect(responseFailed.event).toEqual({
      type: "epoch.blocked",
      epochId: "ep-1",
      reason: "response_failed",
      trigger: "review",
    });
    expect(responseFailed.metadata).toMatchObject({
      type: "epoch.blocked",
      reason: "response_failed",
      disposition: null,
    });
    expect(responseFailed.disposition).toBeNull();

    // settled: a no-actionable-work terminal — the epoch.settled event, NO disposition stamp (items keep
    // whatever they already carry), and an empty itemDispositions so the sink writes nothing.
    const settled = classifyEpochTerminal({ ...base, kind: "settled" });
    expect(settled.event).toEqual({ type: "epoch.settled", epochId: "ep-1" });
    expect(settled.metadata).toEqual({
      type: "epoch.settled",
      epochId: "ep-1",
      epochTrigger: "review",
      sourceIds: ["review:1", "review:2"],
      headBefore: "h1",
      headAfter: "h1",
      disposition: null,
    });
    expect(settled.disposition).toBeNull();
    expect(settled.itemDispositions).toEqual([]);
  });

  it("buildEpochTerminalEmission carries the event + §18.6 metadata + the internal actor", () => {
    const c = classifyEpochTerminal({
      kind: "committed",
      epochId: "ep-9",
      epochTrigger: "ci_fix",
      sourceIds: ["ci:abc"],
      headSha: "h2",
    });
    expect(buildEpochTerminalEmission(c)).toEqual({ event: c.event, metadata: c.metadata, actor: "internal" });
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

describe("epoch producer — disposition sink writes the terminal stamp per owned source id (PR 41)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
  });

  const dispositionSideEffect = (value: string): SideEffect => ({
    kind: "disposition",
    args: { epochId: "ep-1", disposition: value },
  });

  it("upserts one row per source id with the terminal stamp + owning epoch; ignores non-disposition effects", async () => {
    let batchCalls = 0;
    const batchingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch") {
          return (statements: D1PreparedStatement[]) => {
            batchCalls += 1;
            return target.batch(statements);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as D1Database;
    const sink = epochDispositionSink({
      db: batchingDb,
      sessionId: "sess-d",
      prUrl: "https://github.com/o/r/pull/1",
      sourceIds: ["review:1", "review:2"],
      basis: null,
      now: NOW,
    });
    await sink.dispatch({
      mode: "shadow",
      sessionId: "sess-d",
      version: 2,
      from: "REVIEW",
      to: "REVIEW",
      event: { type: "epoch.committed", epochId: "ep-1" },
      sideEffects: [{ kind: "resolve_owned_threads" }, dispositionSideEffect("fixed")],
    });
    expect(batchCalls).toBe(1);
    const rows = await listForPr(db, "sess-d", "https://github.com/o/r/pull/1");
    expect(rows.map((row) => [row.sourceId, row.disposition, row.epochId])).toEqual([
      ["review:1", "fixed", "ep-1"],
      ["review:2", "fixed", "ep-1"],
    ]);
  });

  it("a declined disposition with no basis is refused by the store boundary (triage-with-basis)", async () => {
    const sink = epochDispositionSink({
      db,
      sessionId: "sess-x",
      prUrl: "https://github.com/o/r/pull/2",
      sourceIds: ["review:9"],
      basis: null,
      now: NOW,
    });
    await expect(
      sink.dispatch({
        mode: "shadow",
        sessionId: "sess-x",
        version: 2,
        from: "REVIEW",
        to: "REVIEW",
        event: { type: "epoch.declined", epochId: "ep-1" },
        sideEffects: [dispositionSideEffect("declined")],
      }),
    ).rejects.toThrow(/basis/);
  });
});

describe("epoch producer — shadowEmitEpochTerminal end-to-end over the shadow row (PR 41)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
    resetMocks();
  });

  const PR = "https://github.com/o/r/pull/1";
  // Built per-test (NOT at describe-body time) so it captures the beforeEach-assigned db, not undefined.
  const shadowEnv = () => ({ DB: db, FSM_MODE: "shadow", DD_API_KEY: undefined, WORKER_ENV: "test" }) as never;
  const liveEnv = () => ({ DB: db, FSM_MODE: "live", DD_API_KEY: undefined, WORKER_ENV: "test" }) as never;

  const seedReview = async (sid: string, inFlight: string) =>
    insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      prUrl: PR,
      headSha: "h1",
      verdict: "pass",
      verdictHeadSha: "h1",
      codeChangedSinceVerification: false,
      inFlightEpochId: inFlight,
    });

  const seedUndispositioned = async (sid: string, sourceIds: readonly string[]) => {
    for (const sourceId of sourceIds) {
      await db
        .prepare(
          `INSERT INTO pr_review_item_dispositions (session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at)
           VALUES (?, ?, ?, 'none', NULL, NULL, ?, ?)`,
        )
        .bind(sid, PR, sourceId, NOW, NOW)
        .run();
    }
  };

  it("replied terminal → epoch.replied: stamps disposition(replied) without a head/code change", async () => {
    const sid = "sess-replied";
    await seedReview(sid, "ep-2");
    await shadowEmitEpochTerminal(shadowEnv(), sid, PR, {
      kind: "replied",
      epochId: "ep-2",
      epochTrigger: "review",
      sourceIds: ["comment:7"],
      headSha: "h1",
    });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.inFlightEpochId).toBeNull();
    expect(rec?.codeChangedSinceVerification).toBe(false); // reply-only — no code change
    const rows = await listForPr(db, sid, PR);
    expect(rows.map((row) => [row.sourceId, row.disposition])).toEqual([["comment:7", "replied"]]);
  });

  it("replied terminal with undispositioned items no live epoch covers → ARMS THE DRAIN with a FRESH in-flight id (ARC-1556)", async () => {
    const sid = "sess-replied-drain";
    await seedReview(sid, "ep-reply");
    await seedUndispositioned(sid, ["issue-comment:42", "review-comment:43"]);
    await shadowEmitEpochTerminal(liveEnv(), sid, PR, {
      kind: "replied",
      epochId: "ep-reply",
      epochTrigger: "review",
      sourceIds: ["comment:7"],
      headSha: "h1",
    });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.inFlightEpochId).not.toBeNull();
    expect(rec?.inFlightEpochId).not.toBe("ep-reply");
    expect(rec?.inFlightEpochId).toMatch(new RegExp(`^epoch-${sid}-`));
    expect(rec?.state).toBe("REVIEW");
    const rows = await listForPr(db, sid, PR);
    expect(rows.find((row) => row.sourceId === "comment:7")?.disposition).toBe("replied");
  });

  it("replied terminal whose only undispositioned item is its own source id → clears in-flight after dispositioning, without arming a synthetic drain", async () => {
    const sid = "sess-replied-own-only";
    await seedReview(sid, "ep-reply-own");
    await seedUndispositioned(sid, ["comment:7"]);
    await shadowEmitEpochTerminal(liveEnv(), sid, PR, {
      kind: "replied",
      epochId: "ep-reply-own",
      epochTrigger: "review",
      sourceIds: ["comment:7"],
      headSha: "h1",
    });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.inFlightEpochId).toBeNull();
    expect(rec?.state).toBe("REVIEW");
    const rows = await listForPr(db, sid, PR);
    expect(rows.find((row) => row.sourceId === "comment:7")?.disposition).toBe("replied");
  });

  it("declined terminal with undispositioned items no live epoch covers → ARMS THE DRAIN with a FRESH in-flight id (ARC-1556)", async () => {
    const sid = "sess-declined-drain";
    await seedReview(sid, "ep-decline");
    await seedUndispositioned(sid, ["issue-comment:52", "review-comment:53"]);
    await shadowEmitEpochTerminal(liveEnv(), sid, PR, {
      kind: "declined",
      epochId: "ep-decline",
      epochTrigger: "review",
      sourceIds: ["comment:9"],
      headSha: "h1",
      basis: "out of scope",
    });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.inFlightEpochId).not.toBeNull();
    expect(rec?.inFlightEpochId).not.toBe("ep-decline");
    expect(rec?.inFlightEpochId).toMatch(new RegExp(`^epoch-${sid}-`));
    expect(rec?.state).toBe("REVIEW");
    const rows = await listForPr(db, sid, PR);
    expect(rows.find((row) => row.sourceId === "comment:9")?.disposition).toBe("declined");
  });

  it("declined terminal whose only undispositioned item is its own source id → clears in-flight after dispositioning, without arming a synthetic drain", async () => {
    const sid = "sess-declined-own-only";
    await seedReview(sid, "ep-decline-own");
    await seedUndispositioned(sid, ["comment:9"]);
    await shadowEmitEpochTerminal(liveEnv(), sid, PR, {
      kind: "declined",
      epochId: "ep-decline-own",
      epochTrigger: "review",
      sourceIds: ["comment:9"],
      headSha: "h1",
      basis: "out of scope",
    });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.inFlightEpochId).toBeNull();
    expect(rec?.state).toBe("REVIEW");
    const rows = await listForPr(db, sid, PR);
    expect(rows.find((row) => row.sourceId === "comment:9")?.disposition).toBe("declined");
  });

  it("threads waitUntil into applyEvent deps so the transition DD POST rides OFF the commit path (ARC-1428)", async () => {
    const sid = "sess-waituntil";
    await seedReview(sid, "ep-42");
    capture.deps.length = 0;
    const waitUntil = vi.fn();

    await shadowEmitEpochTerminal(
      shadowEnv(),
      sid,
      PR,
      { kind: "replied", epochId: "ep-42", epochTrigger: "review", sourceIds: ["comment:7"], headSha: "h1" },
      undefined,
      waitUntil,
    );

    // The producer must put its `waitUntil` seam ONTO deps; apply-event reads `deps.waitUntil` to defer
    // the transition telemetry POST off the commit path. Before the ARC-1428 fix deps.waitUntil was
    // undefined (threaded only into the side-effect sink), so the DD POST blocked the epoch-terminal
    // cascade — the primary `caught_up` recompute trigger. The disposition sink stays synchronous.
    const deps = capture.deps.at(-1);
    expect(deps?.waitUntil).toBe(waitUntil);
  });

  it("A4: a committed epoch owning a qa-verdict:* item re-verifies QA (app_breaks + head advanced, under cap)", async () => {
    const sid = "sess-qa-rerun";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      prUrl: PR,
      headSha: "newh", // the fix advanced the head past the verified head (oldh)
      verdict: "app_breaks",
      verdictHeadSha: "oldh",
      verificationRunId: 2,
      verificationRunCount: 1,
      verificationChildId: "child-old",
      inFlightEpochId: "ep-qa",
    });

    await shadowEmitEpochTerminal(liveEnv(), sid, PR, {
      kind: "committed",
      epochId: "ep-qa",
      epochTrigger: "review",
      sourceIds: ["qa-verdict:501"],
      headSha: "newh",
    });

    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("REVIEW");
    // requestVerification fired: run burned, run head repointed to the new head, fresh run id, child cleared.
    expect(rec?.verificationRunCount).toBe(2);
    expect(rec?.verificationRunHead).toBe("newh");
    expect(rec?.verificationRunId).toBe(3);
    expect(rec?.verificationChildId).toBeNull();
  });

  it("A4: a committed epoch owning only NON-QA items does NOT re-verify (run count unchanged)", async () => {
    const sid = "sess-no-qa-rerun";
    await insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      prUrl: PR,
      headSha: "newh",
      verdict: "app_breaks",
      verdictHeadSha: "oldh",
      verificationRunId: 2,
      verificationRunCount: 1,
      inFlightEpochId: "ep-plain",
    });

    await shadowEmitEpochTerminal(liveEnv(), sid, PR, {
      kind: "committed",
      epochId: "ep-plain",
      epochTrigger: "review",
      sourceIds: ["issue-comment:88", "review-comment:99"],
      headSha: "newh",
    });

    const rec = await getPrCoordination(db, sid);
    expect(rec?.verificationRunCount).toBe(1); // no re-run: no QA-sourced disposition
    expect(rec?.verificationRunId).toBe(2);
  });

  it("settled terminal → epoch.settled: CLEARS the in-flight marker, stamps NO disposition (ARC-1330 wedge fix)", async () => {
    const sid = "sess-settled";
    await seedReview(sid, "ep-9");
    await shadowEmitEpochTerminal(shadowEnv(), sid, PR, {
      kind: "settled",
      epochId: "ep-9",
      epochTrigger: "review",
      sourceIds: ["issue-comment:42"],
      headSha: "h1",
    });
    const rec = await getPrCoordination(db, sid);
    // THE fix: the no-actionable-work terminal re-opens `no_inflight_epoch` so `caught_up` can fire.
    expect(rec?.inFlightEpochId).toBeNull();
    expect(rec?.codeChangedSinceVerification).toBe(false); // no code change
    // No disposition is stamped — the item keeps whatever it already carried (e.g. an ingest-time
    // no_action_needed_informational), unlike replied/committed which overwrite.
    const rows = await listForPr(db, sid, PR);
    expect(rows).toEqual([]);
  });

  it("settled terminal with undispositioned items no live epoch covers → ARMS THE DRAIN: re-stamps a FRESH in_flight (ARC-1445)", async () => {
    const sid = "sess-settled-drain";
    await seedReview(sid, "ep-9");
    // Two actionable items the settling (terminal) epoch left undispositioned; no LIVE epoch covers them.
    for (const sourceId of ["issue-comment:42", "review-comment:43"]) {
      await db
        .prepare(
          `INSERT INTO pr_review_item_dispositions (session_id, pr_url, source_id, disposition, basis, epoch_id, created_at, updated_at)
           VALUES (?, ?, ?, 'none', NULL, NULL, ?, ?)`,
        )
        .bind(sid, PR, sourceId, NOW, NOW)
        .run();
    }
    await shadowEmitEpochTerminal(liveEnv(), sid, PR, {
      kind: "settled",
      epochId: "ep-9",
      epochTrigger: "review",
      sourceIds: ["issue-comment:42", "review-comment:43"],
      headSha: "h1",
    });
    const rec = await getPrCoordination(db, sid);
    // The drain armed: `in_flight_epoch_id` is re-stamped with a FRESH synthetic id — NOT null (today's
    // clear-only settle) and NOT the settling epoch's id (`ep-9` would make the dispatch executor re-observe
    // the just-settled terminal row and create nothing → re-strand). Epoch CREATION from this id is the
    // executor's job, covered by the dispatchEpochExecutor suite (live-side-effects.test.ts).
    expect(rec?.inFlightEpochId).not.toBeNull();
    expect(rec?.inFlightEpochId).not.toBe("ep-9");
    expect(rec?.inFlightEpochId).toMatch(new RegExp(`^epoch-${sid}-`));
    expect(rec?.state).toBe("REVIEW"); // stays in REVIEW — caught_up can't fire while items are undispositioned
  });

  it("owner-approval terminal → epoch.blocked{owner_approval}: routes to NEEDS_YOU, writes no disposition", async () => {
    const sid = "sess-owner";
    await seedReview(sid, "ep-3");
    await shadowEmitEpochTerminal(shadowEnv(), sid, PR, {
      kind: "blocked_owner_approval",
      epochId: "ep-3",
      epochTrigger: "review",
      sourceIds: ["review:5"],
      headSha: "h1",
    });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("NEEDS_YOU");
    expect(rec?.blockedReason).toBe("owner_approval"); // the design's sole owner-approval path is reachable
    expect(rec?.inFlightEpochId).toBeNull();
    expect(await listForPr(db, sid, PR)).toEqual([]); // blocked items stay undispositioned → NEEDS_YOU
  });

  it("response-failed terminal → epoch.blocked{response_failed}: routes to NEEDS_YOU(review_response_failed) (ARC-1330)", async () => {
    const sid = "sess-respfail";
    await seedReview(sid, "ep-rf");
    await shadowEmitEpochTerminal(shadowEnv(), sid, PR, {
      kind: "blocked_response_failed",
      epochId: "ep-rf",
      epochTrigger: "review",
      sourceIds: ["review:5"],
      headSha: "h1",
    });
    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("NEEDS_YOU");
    expect(rec?.blockedReason).toBe("review_response_failed");
    expect(rec?.inFlightEpochId).toBeNull();
    expect(await listForPr(db, sid, PR)).toEqual([]);
  });

  it("LIVE owner-approval terminal reaches NEEDS_YOU with reason metadata and never MERGE_READY", async () => {
    const sid = "sess-owner-live";
    await seedReview(sid, "ep-live");
    await shadowEmitEpochTerminal(liveEnv(), sid, PR, {
      kind: "blocked_owner_approval",
      epochId: "ep-live",
      epochTrigger: "review",
      sourceIds: ["review:owner"],
      headSha: "h1",
    });

    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("NEEDS_YOU");
    expect(rec?.state).not.toBe("MERGE_READY");
    expect(rec?.blockedReason).toBe("owner_approval");
    expect(rec?.inFlightEpochId).toBeNull();
    expect(rec?.deadlineAt).toBeNull();
    expect(blockedReasonDisplay("owner_approval")).toEqual({
      label: "owner-approval",
      copy: "Needs owner approval",
    });
    expect(await listForPr(db, sid, PR)).toEqual([]);

    const events = await listPrCoordinationEvents(db, sid);
    expect(events.map((event) => event.event)).toEqual(["epoch.blocked"]);
    expect(events[0]?.metadata).toMatchObject({
      type: "epoch.blocked",
      reason: "owner_approval",
      epochTrigger: "review",
    });
    const transitionEvents = ddEvents("fsm.transition", sid);
    expect(transitionEvents).toHaveLength(1);
    expect(transitionEvents[0]).toMatchObject({
      fsm_event: "epoch.blocked",
      to: "NEEDS_YOU",
      reason: "owner_approval",
      epoch_trigger: "review",
    });
    expect(ddEvents("fsm.settle", sid)).toEqual([]);
  });
});

// W11-V5: the sweep's deferral callers move onto the spine via `emitEpochDeferralToSpine`. This proves the
// deferral event LANDS ON THE SPINE (a `pr_coordination_events` journal row) as a REVIEW `log_noop`
// self-loop that does NOT touch the in-flight epoch — the give-up stays the §10 deadline (SF10).
describe("epoch producer — emitEpochDeferralToSpine lands the deferral on the spine (W11-V5)", () => {
  let db: D1Database;
  beforeEach(() => {
    db = asD1(createMigratedSqlite());
    resetMocks();
  });

  const liveEnv = () => ({ DB: db, FSM_MODE: "live", DD_API_KEY: undefined, WORKER_ENV: "test" }) as never;

  const seedReview = async (sid: string, inFlight: string) =>
    insertPrCoordination(db, {
      ...buildGenesisRecord(sid, NOW),
      state: "REVIEW",
      headSha: "h1",
      prUrl: "https://github.com/o/r/pull/1",
      inFlightEpochId: inFlight,
    });

  it("a contention deferral under live journals an epoch.deferred self-loop — REVIEW unchanged, epoch still in-flight", async () => {
    const sid = "sess-defer-contention";
    await seedReview(sid, "ep-1");
    await emitEpochDeferralToSpine(liveEnv(), sid, {
      epochId: "ep-1",
      deferralKind: "contention",
      reason: "ci_checks_pending",
    });

    const rec = await getPrCoordination(db, sid);
    expect(rec?.state).toBe("REVIEW"); // no state change
    expect(rec?.inFlightEpochId).toBe("ep-1"); // the epoch stays in-flight (the deadline is the give-up)
    expect(rec?.version).toBe(1); // one committed self-loop (genesis is v0)

    const events = await listPrCoordinationEvents(db, sid);
    const deferred = events.find((e) => e.event === "epoch.deferred");
    expect(deferred).toBeTruthy();
    expect(deferred?.fromState).toBe("REVIEW");
    expect(deferred?.toState).toBe("REVIEW");
    expect(deferred?.metadata).toMatchObject({ deferralKind: "contention", reason: "ci_checks_pending" });
  });

  it("a transient-poll deferral under live also journals — the same keep-alive self-loop", async () => {
    const sid = "sess-defer-transient";
    await seedReview(sid, "ep-2");
    await emitEpochDeferralToSpine(liveEnv(), sid, {
      epochId: "ep-2",
      deferralKind: "transient",
      reason: "github_502",
    });
    const events = await listPrCoordinationEvents(db, sid);
    expect(events.some((e) => e.event === "epoch.deferred")).toBe(true);
    expect((await getPrCoordination(db, sid))?.inFlightEpochId).toBe("ep-2");
  });

  it("logs transient D1 applyEvent failures without an error field", async () => {
    const sid = "sess-defer-d1-fault";
    await seedReview(sid, "ep-3");
    const log = { warn: vi.fn() };
    const error = new Error("D1_ERROR: internal error; reference = abc123");
    capture.applyEventError = error;

    await emitEpochDeferralToSpine(
      liveEnv(),
      sid,
      {
        epochId: "ep-3",
        deferralKind: "transient",
        reason: "transient_d1_error",
      },
      log,
    );

    expect(log.warn).toHaveBeenCalledWith(
      {
        sessionId: sid,
        epochId: "ep-3",
        transientError: String(error),
      },
      "fsm epoch-deferral producer failed (ignored)",
    );
    expect(log.warn.mock.calls[0]?.[0]).not.toHaveProperty("error");
  });

  it("logs non-transient applyEvent failures with an error field", async () => {
    const sid = "sess-defer-unknown-fault";
    await seedReview(sid, "ep-4");
    const log = { warn: vi.fn() };
    const error = new Error("unexpected database error");
    capture.applyEventError = error;

    await emitEpochDeferralToSpine(
      liveEnv(),
      sid,
      {
        epochId: "ep-4",
        deferralKind: "transient",
        reason: "github_poll_failed",
      },
      log,
    );

    expect(log.warn).toHaveBeenCalledWith(
      {
        sessionId: sid,
        epochId: "ep-4",
        error: String(error),
      },
      "fsm epoch-deferral producer failed (ignored)",
    );
    expect(log.warn.mock.calls[0]?.[0]).not.toHaveProperty("transientError");
  });
});
