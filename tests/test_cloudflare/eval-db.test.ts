import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

class QueryCapture {
  queries: { sql: string; binds: unknown[] }[] = [];
  nextAllResults: unknown[] = [];

  prepare(sql: string) {
    const self = this;
    const binds: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        binds.push(...args);
        return this;
      },
      async all<T>() {
        self.queries.push({ sql, binds });
        return { results: self.nextAllResults as T[] };
      },
    };
  }
}

type DbModule = {
  getEvaluationsBySessions: (db: unknown, sessionIds: string[]) => Promise<Map<string, unknown[]>>;
};

describe("eval/db", () => {
  it("reads historical session evaluation summaries for multiple sessions in one query", async () => {
    const mod = (await import("../../apps/control-plane-worker/src/eval/db")) as unknown as DbModule;
    const db = new QueryCapture();
    db.nextAllResults = [
      {
        id: "eval-2",
        session_id: "sess-2",
        status: "completed",
        evaluator_model: "gpt-5.4",
      },
      {
        id: "eval-1",
        session_id: "sess-1",
        status: "completed",
        evaluator_model: "gpt-5.4",
      },
    ];

    const rowsBySession = await mod.getEvaluationsBySessions(db as unknown as D1Database, [
      "sess-1",
      " sess-2 ",
      "sess-1",
      "",
    ]);

    expect(db.queries).toHaveLength(1);
    expect(db.queries[0].sql).toContain("FROM session_evaluations WHERE session_id IN (?, ?)");
    expect(db.queries[0].sql).toContain("ORDER BY session_id ASC, created_at DESC");
    expect(db.queries[0].binds).toEqual(["sess-1", "sess-2"]);
    expect(rowsBySession.get("sess-1")).toEqual([db.nextAllResults[1]]);
    expect(rowsBySession.get("sess-2")).toEqual([db.nextAllResults[0]]);
  });

  it("chunks batch evaluation lookups to stay within the D1 bind limit", async () => {
    const mod = (await import("../../apps/control-plane-worker/src/eval/db")) as unknown as DbModule;
    const db = new QueryCapture();
    const sessionIds = Array.from({ length: 101 }, (_, index) => `sess-${index + 1}`);

    const rowsBySession = await mod.getEvaluationsBySessions(db as unknown as D1Database, sessionIds);

    expect(rowsBySession.size).toBe(101);
    expect(db.queries).toHaveLength(2);
    expect(db.queries[0].binds).toHaveLength(100);
    expect(db.queries[0].binds[0]).toBe("sess-1");
    expect(db.queries[0].binds[99]).toBe("sess-100");
    expect(db.queries[1].binds).toEqual(["sess-101"]);
    expect(db.queries[0].sql).toContain("FROM session_evaluations WHERE session_id IN (");
    expect(db.queries[1].sql).toContain("FROM session_evaluations WHERE session_id IN (?)");
  });

  it("skips the database query when no valid session IDs are provided", async () => {
    const mod = (await import("../../apps/control-plane-worker/src/eval/db")) as unknown as DbModule;
    const db = new QueryCapture();

    const rowsBySession = await mod.getEvaluationsBySessions(db as unknown as D1Database, ["", "   "]);

    expect(rowsBySession.size).toBe(0);
    expect(db.queries).toHaveLength(0);
  });
});
