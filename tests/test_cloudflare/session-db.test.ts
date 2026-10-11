import { describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import {
  getSessionIndexIdentity,
  getSessionIndexRepoUrl,
  getSessionLivenessRows,
  listSessions,
  toSessionApiShape,
} from "../../apps/control-plane-worker/src/session/db";

type SessionListRow = {
  session_id: string;
  owner_user_id: number;
  business_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  last_event_id: string | null;
  title: string | null;
  rich_status: string | null;
  model: string | null;
  reasoning_effort: string | null;
  agent_runtime_backend: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  parent_session_id: string | null;
  spawn_depth: number | null;
  match_score?: number | null;
  // Raw persisted column: may hold legacy `done_green`/`done_exhausted` strings on existing rows.
  review_loop_done_state?: string | null;
  verification_state?:
    | "verification-pending"
    | "verification-in-progress"
    | "verification-done"
    | "verification-skipped"
    | "verification-stopped"
    | "verification-exhausted"
    | null;
  verification_attempt_count?: number | null;
  verification_max_attempts?: number | null;
  qa_testing_state?: "qa-pending" | "qa-in-progress" | "qa-done" | "qa-skipped" | "qa-stopped" | "qa-exhausted" | null;
  qa_testing_attempt_count?: number | null;
  qa_testing_max_attempts?: number | null;
  // Raw READ-side pr_coordination columns (LEFT JOIN), aliased fsm_* in the query.
  fsm_state?: string | null;
  fsm_blocked_reason?: string | null;
  fsm_failure_reason?: string | null;
};

function makeRow(
  sessionId: string,
  createdAt: string,
  options: { matchScore?: number; updatedAt?: string } = {},
): SessionListRow {
  return {
    session_id: sessionId,
    owner_user_id: 1,
    business_id: "biz-1",
    status: "active",
    created_at: createdAt,
    updated_at: options.updatedAt ?? "2026-04-30T00:00:00.000Z",
    closed_at: null,
    last_event_id: null,
    title: "Architect agent search",
    rich_status: "idle",
    model: null,
    reasoning_effort: null,
    agent_runtime_backend: null,
    repo_owner: "trycycloid",
    repo_name: "cycloid",
    parent_session_id: null,
    spawn_depth: null,
    match_score: options.matchScore,
    review_loop_done_state: null,
    verification_state: null,
    verification_attempt_count: 0,
    verification_max_attempts: 3,
    qa_testing_state: null,
    qa_testing_attempt_count: 0,
    qa_testing_max_attempts: 3,
  };
}

function makeDb(
  rows: SessionListRow[] = [],
  options: {
    identityRow?: { owner_user_id: number; business_id: string | null } | null;
    repoRow?: { repo_owner: string | null; repo_name: string | null } | null;
  } = {},
) {
  let sql = "";
  let params: unknown[] = [];
  const all = vi.fn().mockResolvedValue({ results: rows });
  const first = vi.fn(async () => {
    if (sql.includes("SELECT owner_user_id, business_id FROM session_index")) return options.identityRow ?? null;
    return options.repoRow ?? null;
  });
  const bind = vi.fn((...boundParams: unknown[]) => {
    params = boundParams;
    return { all, first };
  });
  const prepare = vi.fn((preparedSql: string) => {
    sql = preparedSql;
    return { bind };
  });

  return {
    db: { prepare } as unknown as D1Database,
    getSql: () => sql,
    getParams: () => params,
  };
}

describe("session db listSessions", () => {
  it("serializes canonical phase and legacy status aliases in API list rows", () => {
    const idle = toSessionApiShape(makeRow("session-1", "2026-05-10T00:00:00.000Z"));

    expect(idle).toMatchObject({
      sessionId: "session-1",
      phase: "idle",
      displayStatus: "stopped",
      status: "idle",
    });

    const runningRow = makeRow("session-2", "2026-05-10T00:00:01.000Z");
    runningRow.rich_status = "running";

    expect(toSessionApiShape(runningRow)).toMatchObject({
      sessionId: "session-2",
      phase: "running",
      displayStatus: "working",
      status: "running",
    });
  });

  it("maps pr_draft to a prDraft boolean and omits it when unknown", () => {
    const draftRow = { ...makeRow("session-draft", "2026-05-10T00:00:00.000Z"), pr_url: "url", pr_draft: 1 };
    expect(toSessionApiShape(draftRow as never)).toMatchObject({ prUrl: "url", prDraft: true });

    const readyRow = { ...makeRow("session-ready", "2026-05-10T00:00:00.000Z"), pr_url: "url", pr_draft: 0 };
    expect(toSessionApiShape(readyRow as never)).toMatchObject({ prUrl: "url", prDraft: false });

    // Older completions predate the column: no prDraft key at all (UI falls back to the green PR pill).
    expect(toSessionApiShape(makeRow("session-legacy", "2026-05-10T00:00:00.000Z"))).not.toHaveProperty("prDraft");
  });

  it("gates desktop action path availability by Cycloid business membership", () => {
    expect(
      toSessionApiShape({
        ...makeRow("session-codex-desktop", "2026-05-10T00:00:00.000Z"),
        business_id: SEEDED_BUSINESS_IDS.cycloid,
        model: "gpt-5.4",
        agent_runtime_backend: "codex",
      }),
    ).toMatchObject({ desktopActionPathAvailable: true });

    expect(
      toSessionApiShape({
        ...makeRow("session-claude-desktop", "2026-05-10T00:00:00.000Z"),
        business_id: SEEDED_BUSINESS_IDS.cycloidQa,
        model: "claude-opus-4-8",
        agent_runtime_backend: "claude_code",
      }),
    ).toMatchObject({ desktopActionPathAvailable: true });

    expect(
      toSessionApiShape({
        ...makeRow("session-desktop", "2026-05-10T00:00:00.000Z"),
        business_id: SEEDED_BUSINESS_IDS.cycloidQa,
        model: "kimi-k2.7-code",
        agent_runtime_backend: "opencode",
      }),
    ).toMatchObject({ desktopActionPathAvailable: true });

    expect(
      toSessionApiShape({
        ...makeRow("session-wrong-backend", "2026-05-10T00:00:00.000Z"),
        model: "kimi-k2.7-code",
        agent_runtime_backend: "codex",
      }),
    ).toMatchObject({ desktopActionPathAvailable: false });

    expect(toSessionApiShape(makeRow("session-no-model", "2026-05-10T00:00:00.000Z"))).toMatchObject({
      desktopActionPathAvailable: false,
    });
  });

  it("selects pr_draft alongside pr_url for the list rows", async () => {
    const { db, getSql } = makeDb();

    await listSessions(db, "user-1", null, { limit: 10 });

    expect(getSql()).toContain("AS pr_draft");
  });

  it("fetches pr_url/pr_draft from the PR metadata read model via per-row correlated subqueries", async () => {
    const { db, getSql } = makeDb();

    await listSessions(db, "user-1", null, { limit: 10 });

    const sql = getSql();
    // Correlated subqueries run only for the LIMITed rows and seek
    // idx_session_pr_metadata_latest; an uncorrelated latest-PR join would
    // window the whole session_pr_metadata table regardless of page size.
    expect(sql).toContain("(SELECT pr_url FROM session_pr_metadata");
    expect(sql).toContain("(SELECT pr_draft FROM session_pr_metadata");
    expect(sql).toContain("ORDER BY updated_at DESC, pr_url DESC LIMIT 1");
  });

  it("orders ordinary session lists by creation time instead of last projection update", async () => {
    const { db, getSql } = makeDb();

    await listSessions(db, "user-1", null, { limit: 10 });

    const sql = getSql();
    expect(sql).toContain("ORDER BY s.created_at DESC, s.session_id DESC");
    expect(sql).not.toContain("ORDER BY s.updated_at DESC");
  });

  it("excludes empty prewarm shells from ordinary session lists", async () => {
    const { db, getSql } = makeDb();

    await listSessions(db, "user-1", null, { limit: 10 });

    const sql = getSql();
    expect(sql).toContain("s.title IS NOT NULL");
    expect(sql).toContain("EXISTS (SELECT 1 FROM prompt_runs pr WHERE pr.session_id = s.session_id)");
    expect(sql).toContain("EXISTS (SELECT 1 FROM session_completions sc WHERE sc.session_id = s.session_id)");
  });

  it("uses creation time in ordinary session list cursors", async () => {
    const firstPage = makeDb([
      makeRow("session-1", "2026-05-10T00:00:00.000Z"),
      makeRow("session-2", "2026-05-09T00:00:00.000Z"),
    ]);

    const page = await listSessions(firstPage.db, "user-1", null, { limit: 1 });

    expect(page.nextCursor).toEqual(expect.any(String));
    expect(atob(page.nextCursor!)).toBe("v2|2026-05-10T00:00:00.000Z|session-1");

    const secondPage = makeDb();
    await listSessions(secondPage.db, "user-1", null, {
      cursor: page.nextCursor,
      limit: 1,
    });

    expect(secondPage.getSql()).toContain("s.created_at < ?");
    expect(secondPage.getSql()).toContain("s.session_id < ?");
    expect(secondPage.getParams()).toEqual(expect.arrayContaining(["2026-05-10T00:00:00.000Z", "session-1"]));
  });

  it("ignores legacy pre-v2 cursors and restarts pagination from the first page", async () => {
    const legacyCursor = btoa("2026-05-10T00:00:00.000Z|session-9");
    const pageDb = makeDb([
      makeRow("session-1", "2026-05-01T00:00:00.000Z", { updatedAt: "2026-05-09T00:00:00.000Z" }),
      makeRow("session-2", "2026-05-02T00:00:00.000Z", { updatedAt: "2026-05-08T00:00:00.000Z" }),
    ]);

    const page = await listSessions(pageDb.db, "user-1", null, {
      cursor: legacyCursor,
      limit: 1,
    });

    // A legacy cursor decodes to null, so no cursor WHERE clause is applied and
    // ordering stays on created_at.
    expect(pageDb.getSql()).not.toContain("updated_at < ?");
    expect(pageDb.getSql()).toContain("ORDER BY s.created_at DESC, s.session_id DESC");
    expect(pageDb.getParams()).not.toContain("session-9");
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(atob(page.nextCursor!)).toBe("v2|2026-05-01T00:00:00.000Z|session-1");
  });

  it("never interpolates a cursor-controlled ORDER BY column", async () => {
    // A v2-shaped cursor with SQL in the timestamp slot: the timestamp lands
    // in binds, and the ORDER BY column must still be the allowlisted literal.
    const craftedCursor = btoa("v2|created_at; DROP TABLE session_index;--|session-9");
    const pageDb = makeDb([makeRow("session-1", "2026-05-01T00:00:00.000Z")]);

    await listSessions(pageDb.db, "user-1", null, {
      cursor: craftedCursor,
      limit: 1,
    });

    const sql = pageDb.getSql();
    expect(sql).toContain("ORDER BY s.created_at DESC, s.session_id DESC");
    expect(sql).not.toContain("DROP TABLE");
    expect(pageDb.getParams()).toEqual(expect.arrayContaining(["created_at; DROP TABLE session_index;--"]));
  });

  it("searches title and repo metadata with deterministic match-score ordering", async () => {
    const { db, getParams, getSql } = makeDb();

    await listSessions(db, "user-1", "idle", {
      search: { query: "architect agent", repo: "https://github.com/trycycloid/cycloid.git" },
      limit: 10,
    });

    const sql = getSql();
    expect(sql).toContain("AS match_score");
    expect(sql).toContain("ORDER BY match_score DESC, created_at DESC, session_id DESC");
    expect(sql).not.toContain("title_tags");
    expect(sql).toContain("LOWER(COALESCE(s.repo_owner, '') || '/' || COALESCE(s.repo_name, ''))");
    expect(sql).toContain("LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\'");
    expect(getParams()).toContain("trycycloid/cycloid");
    expect(getParams()).toContain("%architect agent%");
    expect(getParams()).toContain("%architect%");
    expect(getParams()).toContain("user-1");
  });

  it("uses match score in search cursors", async () => {
    const firstPage = makeDb([
      makeRow("session-1", "2026-04-29T00:00:03.000Z", { matchScore: 90 }),
      makeRow("session-2", "2026-04-29T00:00:02.000Z", { matchScore: 70 }),
    ]);

    const page = await listSessions(firstPage.db, "user-1", null, {
      search: { query: "architect" },
      limit: 1,
    });

    expect(page.nextCursor).toEqual(expect.any(String));
    expect(atob(page.nextCursor!)).toBe("v2|90|2026-04-29T00:00:03.000Z|session-1");

    const secondPage = makeDb();
    await listSessions(secondPage.db, "user-1", null, {
      search: { query: "architect" },
      cursor: page.nextCursor,
      limit: 1,
    });

    expect(secondPage.getSql()).toContain("match_score < ?");
    expect(secondPage.getParams()).toEqual(expect.arrayContaining([90, "2026-04-29T00:00:03.000Z", "session-1"]));
  });

  it("keeps created_at and session_id tie-breakers when search cursor scores match", async () => {
    const firstPage = makeDb([
      makeRow("session-9", "2026-04-29T00:00:03.000Z", { matchScore: 90 }),
      makeRow("session-8", "2026-04-29T00:00:02.000Z", { matchScore: 90 }),
    ]);

    const page = await listSessions(firstPage.db, "user-1", null, {
      search: { query: "architect" },
      limit: 1,
    });

    expect(page.nextCursor).toEqual(expect.any(String));

    const secondPage = makeDb();
    await listSessions(secondPage.db, "user-1", null, {
      search: { query: "architect" },
      cursor: page.nextCursor,
      limit: 1,
    });

    expect(secondPage.getSql()).toContain("match_score = ?");
    expect(secondPage.getSql()).toContain("created_at < ?");
    expect(secondPage.getSql()).toContain("session_id < ?");
    expect(secondPage.getParams()).toEqual(expect.arrayContaining([90, 90, "2026-04-29T00:00:03.000Z", "session-9"]));
  });

  it("ignores legacy pre-v2 search cursors and restarts pagination from the first page", async () => {
    const legacyCursor = btoa("90|2026-05-10T00:00:00.000Z|session-9");
    const pageDb = makeDb([
      makeRow("session-1", "2026-05-01T00:00:00.000Z", {
        matchScore: 80,
        updatedAt: "2026-05-09T00:00:00.000Z",
      }),
      makeRow("session-2", "2026-05-02T00:00:00.000Z", {
        matchScore: 70,
        updatedAt: "2026-05-08T00:00:00.000Z",
      }),
    ]);

    const page = await listSessions(pageDb.db, "user-1", null, {
      search: { query: "architect" },
      cursor: legacyCursor,
      limit: 1,
    });

    // A legacy cursor decodes to null, so no outer cursor WHERE clause is applied
    // and ordering stays on created_at.
    expect(pageDb.getSql()).not.toContain("updated_at < ?");
    expect(pageDb.getSql()).toContain("ORDER BY match_score DESC, created_at DESC, session_id DESC");
    expect(pageDb.getParams()).not.toContain("session-9");
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(atob(page.nextCursor!)).toBe("v2|80|2026-05-01T00:00:00.000Z|session-1");
  });

  it("builds a GitHub repo URL from session_index repo metadata", async () => {
    const { db, getSql, getParams } = makeDb([], {
      repoRow: { repo_owner: "trycycloid", repo_name: "cycloid" },
    });

    await expect(getSessionIndexRepoUrl(db, "session-1")).resolves.toBe("https://github.com/trycycloid/cycloid");
    expect(getSql()).toContain("SELECT repo_owner, repo_name FROM session_index");
    expect(getParams()).toEqual(["session-1"]);
  });

  it("returns null when session_index has no repo metadata", async () => {
    const { db } = makeDb([], { repoRow: { repo_owner: null, repo_name: null } });

    await expect(getSessionIndexRepoUrl(db, "session-1")).resolves.toBeNull();
  });

  it("loads session identity from session_index", async () => {
    const { db, getSql, getParams } = makeDb([], {
      identityRow: { owner_user_id: 42, business_id: "biz-1" },
    });

    await expect(getSessionIndexIdentity(db, "session-1")).resolves.toEqual({
      ownerUserId: 42,
      businessId: "biz-1",
    });
    expect(getSql()).toContain("SELECT owner_user_id, business_id FROM session_index");
    expect(getParams()).toEqual(["session-1"]);
  });

  it("surfaces review_loop_done_state in the api shape when present", () => {
    const doneRow = { ...makeRow("session-done", "2026-06-08T00:00:00.000Z"), review_loop_done_state: "done" };
    expect(toSessionApiShape(doneRow as never)).toMatchObject({ reviewLoopDoneState: "done" });

    const workingRow = { ...makeRow("session-working", "2026-06-08T00:00:01.000Z"), review_loop_done_state: "working" };
    expect(toSessionApiShape(workingRow as never)).toMatchObject({ reviewLoopDoneState: "working" });
  });

  it("normalizes legacy persisted done-state strings to done in the api shape", () => {
    // Rows persisted before the state collapse still hold the legacy strings; the projection
    // boundary maps them to the single `done` value.
    const greenRow = { ...makeRow("session-green", "2026-06-08T00:00:02.000Z"), review_loop_done_state: "done_green" };
    expect(toSessionApiShape(greenRow as never)).toMatchObject({ reviewLoopDoneState: "done" });

    const exhaustedRow = {
      ...makeRow("session-amber", "2026-06-08T00:00:03.000Z"),
      review_loop_done_state: "done_exhausted",
    };
    expect(toSessionApiShape(exhaustedRow as never)).toMatchObject({ reviewLoopDoneState: "done" });

    // An unknown/garbage persisted value is dropped (omitted) rather than projected through.
    const bogusRow = { ...makeRow("session-bogus", "2026-06-08T00:00:04.000Z"), review_loop_done_state: "bogus" };
    expect(toSessionApiShape(bogusRow as never)).not.toHaveProperty("reviewLoopDoneState");
  });

  it("omits reviewLoopDoneState when the column is null", () => {
    expect(toSessionApiShape(makeRow("session-null", "2026-06-08T00:00:02.000Z"))).not.toHaveProperty(
      "reviewLoopDoneState",
    );
  });

  it("selects review_loop_done_state for the list rows", async () => {
    const { db, getSql } = makeDb();
    await listSessions(db, "user-1", null, { limit: 10 });
    expect(getSql()).toContain("review_loop_done_state");
    expect(getSql()).toContain("arcanist_done_state");
    expect(getSql()).toContain("arcanist_done_outcome");
    expect(getSql()).toContain("arcanist_done_reasons_json");
  });

  it("surfaces cycloid done status in the api shape", () => {
    const row = {
      ...makeRow("session-cycloid-done", "2026-06-08T00:00:05.000Z"),
      arcanist_done_state: "done",
      arcanist_done_outcome: "needs_attention",
      arcanist_done_reasons_json: JSON.stringify(["ci_red", "bogus", "verification_exhausted"]),
    };

    expect(toSessionApiShape(row as never)).toMatchObject({
      cycloidDoneState: "done",
      cycloidDoneOutcome: "needs_attention",
      cycloidDoneReasons: ["ci_red", "verification_exhausted"],
    });
  });

  it("defaults invalid cycloid done state to working", () => {
    const row = {
      ...makeRow("session-cycloid-working", "2026-06-08T00:00:06.000Z"),
      arcanist_done_state: "bogus",
      arcanist_done_outcome: "bogus",
      arcanist_done_reasons_json: "not-json",
    };

    expect(toSessionApiShape(row as never)).toMatchObject({ cycloidDoneState: "working" });
    expect(toSessionApiShape(row as never)).not.toHaveProperty("cycloidDoneOutcome");
    expect(toSessionApiShape(row as never)).toMatchObject({ cycloidDoneReasons: [] });
  });

  it("surfaces verification state and attempt counters in the api shape", () => {
    const row = {
      ...makeRow("session-verification", "2026-06-08T00:00:03.000Z"),
      qa_testing_state: "qa-in-progress",
      qa_testing_attempt_count: 2,
      qa_testing_max_attempts: 3,
      verification_state: "verification-in-progress",
      verification_attempt_count: 2,
      verification_max_attempts: 3,
    } satisfies SessionListRow;

    expect(toSessionApiShape(row)).toMatchObject({
      verificationState: "verification-in-progress",
      verificationAttemptCount: 2,
      verificationMaxAttempts: 3,
    });
  });

  it("does not read legacy verification state columns for old api rows", () => {
    const row = {
      ...makeRow("session-verification-legacy", "2026-06-08T00:00:03.000Z"),
      qa_testing_state: undefined,
      qa_testing_attempt_count: undefined,
      qa_testing_max_attempts: undefined,
      verification_state: "verification-in-progress",
      verification_attempt_count: 2,
      verification_max_attempts: 3,
    } satisfies SessionListRow;

    const shape = toSessionApiShape(row);
    expect(shape).not.toHaveProperty("verificationState");
    expect(shape).toMatchObject({
      verificationAttemptCount: 0,
      verificationMaxAttempts: 3,
    });
  });

  it("uses QA testing columns while both mixed api row shapes exist", () => {
    const row = {
      ...makeRow("session-verification-mixed", "2026-06-08T00:00:03.000Z"),
      qa_testing_state: "qa-done",
      qa_testing_attempt_count: 3,
      qa_testing_max_attempts: 4,
      verification_state: "verification-in-progress",
      verification_attempt_count: 1,
      verification_max_attempts: 2,
    } satisfies SessionListRow;

    expect(toSessionApiShape(row)).toMatchObject({
      verificationState: "verification-done",
      verificationAttemptCount: 3,
      verificationMaxAttempts: 4,
    });
  });

  it("selects only QA testing state columns for list rows", async () => {
    const { db, getSql } = makeDb();
    await listSessions(db, "user-1", null, { limit: 10 });
    expect(getSql()).toContain("agent_runtime_backend");
    expect(getSql()).toContain("qa_testing_state");
    expect(getSql()).toContain("qa_testing_attempt_count");
    expect(getSql()).toContain("qa_testing_max_attempts");
    expect(getSql()).not.toContain("verification_state");
    expect(getSql()).not.toContain("verification_attempt_count");
    expect(getSql()).not.toContain("verification_max_attempts");
  });

  it("projects FSM lifecycle fields from the pr_coordination row", () => {
    const row = {
      ...makeRow("session-fsm", "2026-07-10T00:00:00.000Z"),
      fsm_state: "NEEDS_YOU",
      fsm_blocked_reason: "review_stuck",
      fsm_failure_reason: null,
    } satisfies SessionListRow;

    expect(toSessionApiShape(row)).toMatchObject({
      fsmState: "NEEDS_YOU",
      blockedReason: "review_stuck",
      failureReason: null,
    });
  });

  it("nulls FSM lifecycle fields for sessions with no pr_coordination row", () => {
    // Pre-publish / legacy rows have no coordination row, so the LEFT JOIN
    // yields NULL for all three columns — always present, always null.
    const shape = toSessionApiShape(makeRow("session-no-fsm", "2026-07-10T00:00:01.000Z"));

    expect(shape).toMatchObject({
      fsmState: null,
      blockedReason: null,
      failureReason: null,
    });
  });

  it("nulls unrecognized FSM column values instead of a bad union cast", () => {
    // `state` and `failure_reason` are unconstrained TEXT in D1, so an unknown
    // stored value must resolve to null (safe legacy fallback) rather than pass
    // through and index a chip/copy map to `undefined`.
    const row = {
      ...makeRow("session-bad-fsm", "2026-07-10T00:00:02.000Z"),
      fsm_state: "SOME_FUTURE_STATE",
      fsm_blocked_reason: "not_a_reason",
      fsm_failure_reason: "gremlins",
    } satisfies SessionListRow;

    expect(toSessionApiShape(row)).toMatchObject({
      fsmState: null,
      blockedReason: null,
      failureReason: null,
    });
  });

  it("left joins pr_coordination and selects the FSM lifecycle columns", async () => {
    const { db, getSql } = makeDb();

    await listSessions(db, "user-1", null, { limit: 10 });

    const sql = getSql();
    expect(sql).toContain("LEFT JOIN pr_coordination pc ON pc.session_id = s.session_id");
    expect(sql).toContain("pc.state AS fsm_state");
    expect(sql).toContain("pc.blocked_reason AS fsm_blocked_reason");
    expect(sql).toContain("pc.failure_reason AS fsm_failure_reason");
  });
});

describe("getSessionLivenessRows", () => {
  it("returns an empty array without querying when no ids are given", async () => {
    const { db } = makeDb();
    await expect(getSessionLivenessRows(db, [])).resolves.toEqual([]);
    expect((db as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare).not.toHaveBeenCalled();
  });

  it("selects liveness columns with one placeholder per session id", async () => {
    const rows = [
      { session_id: "s-1", status: "active", rich_status: "running" },
      { session_id: "s-2", status: "archived", rich_status: null },
    ];
    const all = vi.fn().mockResolvedValue({ results: rows });
    const bind = vi.fn(() => ({ all }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    await expect(getSessionLivenessRows(db, ["s-1", "s-2"])).resolves.toEqual(rows);
    expect(prepare).toHaveBeenCalledWith(
      expect.stringContaining(
        "SELECT session_id, status, rich_status, agent_role FROM session_index WHERE session_id IN (?, ?)",
      ),
    );
    expect(bind).toHaveBeenCalledWith("s-1", "s-2");
  });
});
