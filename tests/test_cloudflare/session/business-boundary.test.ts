import { describe, expect, it, vi } from "vitest";

import {
  getChildSessionStatusSummary,
  listChildSessionSummaries,
} from "../../../apps/control-plane-worker/src/services/child-session";
import { queryPromptRuns, searchSessions } from "../../../apps/control-plane-worker/src/services/observability";
import type { ChildSessionRow } from "../../../apps/control-plane-worker/src/session/child-session-db";
import type { AuthInfo } from "../../../apps/control-plane-worker/src/types";

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function isListChildrenQuery(sql: string): boolean {
  const normalized = normalizeSql(sql);
  return (
    normalized.startsWith("SELECT session_id, business_id, parent_session_id") &&
    normalized.includes("FROM session_index") &&
    normalized.includes("WHERE parent_session_id = ? AND business_id IS ?") &&
    normalized.includes("ORDER BY created_at DESC")
  );
}

function isChildLookupQuery(sql: string): boolean {
  const normalized = normalizeSql(sql);
  return (
    normalized.startsWith("SELECT session_id, business_id, parent_session_id") &&
    normalized.includes("FROM session_index") &&
    normalized.includes("WHERE session_id = ? AND parent_session_id IS NOT NULL LIMIT 1")
  );
}

class ChildBoundaryStatement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly rows: ChildSessionRow[],
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): ChildBoundaryStatement {
    const next = new ChildBoundaryStatement(this.rows, this.query);
    next.boundValues = values;
    return next;
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (isListChildrenQuery(this.query)) {
      const [parentSessionId, businessId] = this.boundValues as [string, string | null];
      return {
        results: this.rows
          .filter((row) => row.parent_session_id === parentSessionId && row.business_id === businessId)
          .sort((a, b) => b.created_at.localeCompare(a.created_at)) as T[],
      };
    }
    throw new Error(`Unhandled child boundary all query: ${normalizeSql(this.query)}`);
  }

  async first<T>(): Promise<T | null> {
    if (isChildLookupQuery(this.query)) {
      const [sessionId] = this.boundValues as [string];
      return (this.rows.find((row) => row.session_id === sessionId && row.parent_session_id) as T | undefined) ?? null;
    }
    throw new Error(`Unhandled child boundary first query: ${normalizeSql(this.query)}`);
  }
}

function makeChildBoundaryDb(rows: ChildSessionRow[]): D1Database {
  return {
    prepare(query: string) {
      return new ChildBoundaryStatement(rows, query);
    },
  } as unknown as D1Database;
}

function childRow(overrides: Partial<ChildSessionRow>): ChildSessionRow {
  return {
    session_id: "child-a",
    business_id: "biz-a",
    parent_session_id: "parent-a",
    parent_prompt_id: "prompt-a",
    spawned_by_user_id: 101,
    spawn_depth: 1,
    title: "Child",
    status: "active",
    rich_status: "running",
    publish_status: null,
    publish_error: null,
    created_at: "2026-05-04T00:00:00.000Z",
    closed_at: null,
    ...overrides,
  };
}

function makeObservedSqlDb() {
  let sql = "";
  let params: unknown[] = [];
  const all = vi.fn().mockResolvedValue({ results: [] });
  const bind = vi.fn((...boundParams: unknown[]) => {
    params = boundParams;
    return { all };
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

const sharedBusinessAuth = {
  userId: "101",
  tokenSource: "test",
  authMode: "user_session",
  canAccessAllSessions: false,
  user: {
    id: 101,
    login: "alice",
    name: "Alice",
    email: "alice@example.com",
    businessId: "biz-a",
    sharedSessions: true,
    businessMemberIds: ["101", "102"],
  },
} satisfies AuthInfo;

describe("session business boundary matrix", () => {
  it("omits child sessions whose business differs from the authorized parent business", async () => {
    const db = makeChildBoundaryDb([
      childRow({ session_id: "child-a", business_id: "biz-a" }),
      childRow({ session_id: "child-b", business_id: "biz-b" }),
      childRow({ session_id: "child-null", business_id: null }),
    ]);

    const summaries = await listChildSessionSummaries(db, "parent-a", "biz-a", "https://app.test", {});

    expect(summaries.map((summary) => summary.childSessionId)).toEqual(["child-a"]);
  });

  it("returns not_found when a child status row belongs to a different business than the parent", async () => {
    const db = makeChildBoundaryDb([childRow({ session_id: "child-b", business_id: "biz-b" })]);

    const result = await getChildSessionStatusSummary({
      db,
      childSessionId: "child-b",
      parentSessionId: "parent-a",
      parentBusinessId: "biz-a",
      frontendUrl: "https://app.test",
    });

    expect(result).toEqual({ ok: false, error: { code: "not_found", message: "Child session not found" } });
  });

  it("owner-scopes observability prompt runs even when shared sessions are enabled", async () => {
    const { db, getParams, getSql } = makeObservedSqlDb();

    await queryPromptRuns(db, { sessionId: "session-b" }, sharedBusinessAuth);

    expect(getSql()).toContain("owner_user_id = ?");
    expect(getSql()).toContain("session_id = ?");
    expect(getSql()).not.toContain("business_id = ?");
    expect(getParams()).toEqual(["101", "session-b", 50, 0]);
  });

  it("owner-scopes observability session search instead of widening to business scope", async () => {
    const { db, getParams, getSql } = makeObservedSqlDb();

    await searchSessions(db, { status: "active" }, sharedBusinessAuth);

    expect(getSql()).toContain("s.owner_user_id = ?");
    expect(getSql()).not.toContain("s.business_id = ?");
    expect(getParams()).toEqual(["101", "active", 50]);
  });
});
