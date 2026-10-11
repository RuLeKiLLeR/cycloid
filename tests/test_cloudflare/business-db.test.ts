import { beforeEach, describe, expect, it, vi } from "vitest";

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

interface BusinessRow {
  id: string;
  name: string;
  shared_sessions: number;
  created_at: number;
  updated_at: number;
}

type BusinessDbModule = {
  getBusiness: (
    db: unknown,
    id: string,
  ) => Promise<{ id: string; name: string; sharedSessions: boolean; createdAt: number } | null>;
  searchAdminBusinesses: (
    db: unknown,
    options: { query?: string; limit: number; orderBy?: "createdAt" | "name" },
  ) => Promise<
    Array<{
      id: string;
      name: string;
      createdAt: number;
      memberCount: number;
      sessionCount: number;
      lastSessionAt: number | null;
    }>
  >;
  updateBusinessSharedSessions: (db: unknown, id: string, sharedSessions: boolean) => Promise<boolean>;
};

class FakeD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeBusinessD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    if (this.query.includes("UPDATE businesses SET shared_sessions")) {
      const [sharedSessions, updatedAt, id] = this.boundValues as [number, number, string];
      const existing = this.db.businesses.get(id);
      if (!existing) {
        return { success: true, meta: { changes: 0 } };
      }
      existing.shared_sessions = sharedSessions;
      existing.updated_at = updatedAt;
      return { success: true, meta: { changes: 1 } };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM businesses")) {
      const [id] = this.boundValues as [string];
      const row = this.db.businesses.get(id);
      return (row as unknown as T) ?? null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (!this.query.includes("FROM businesses b")) {
      throw new Error(`Unhandled all query: ${this.query}`);
    }

    const isSearchQuery = this.query.includes("WHERE b.name LIKE ? ESCAPE");
    const orderByCreatedAt = this.query.includes("ORDER BY b.created_at DESC, b.id DESC");
    const rows = Array.from(this.db.businesses.values());
    const filtered = isSearchQuery
      ? rows.filter((row) => {
          const [rawLike] = this.boundValues as [string, string, number];
          const query = unescapeLike(rawLike.slice(1, -1)).toLowerCase();
          return row.name.toLowerCase().includes(query) || row.id.toLowerCase().includes(query);
        })
      : rows;
    const sorted = filtered.sort((a, b) =>
      orderByCreatedAt
        ? b.created_at - a.created_at || b.id.localeCompare(a.id)
        : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    const limit = isSearchQuery ? (this.boundValues as [string, string, number])[2] : (this.boundValues as [number])[0];
    return {
      results: sorted.slice(0, limit).map((row) => ({
        id: row.id,
        name: row.name,
        created_at: row.created_at,
        member_count: 0,
        session_count: 0,
        last_session_at: null,
      })) as T[],
    };
  }
}

class FakeBusinessD1 {
  readonly businesses = new Map<string, BusinessRow>();

  addBusiness(overrides: Partial<BusinessRow> & { id: string }): void {
    const now = Date.now();
    this.businesses.set(overrides.id, {
      name: "Acme",
      shared_sessions: 0,
      created_at: now,
      updated_at: now,
      ...overrides,
    });
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
}

let mod: BusinessDbModule;
let fakeDb: FakeBusinessD1;

describe("business/db", () => {
  beforeEach(async () => {
    const modulePath = "../../apps/control-plane-worker/src/business/db";
    mod = (await import(modulePath)) as unknown as BusinessDbModule;
    fakeDb = new FakeBusinessD1();
  });

  describe("updateBusinessSharedSessions", () => {
    it("enables shared sessions on a business that has it disabled", async () => {
      fakeDb.addBusiness({ id: "biz-1", shared_sessions: 0 });

      const updated = await mod.updateBusinessSharedSessions(fakeDb, "biz-1", true);

      expect(updated).toBe(true);
      expect(fakeDb.businesses.get("biz-1")?.shared_sessions).toBe(1);
    });

    it("disables shared sessions on a business that has it enabled", async () => {
      fakeDb.addBusiness({ id: "biz-1", shared_sessions: 1 });

      const updated = await mod.updateBusinessSharedSessions(fakeDb, "biz-1", false);

      expect(updated).toBe(true);
      expect(fakeDb.businesses.get("biz-1")?.shared_sessions).toBe(0);
    });

    it("is idempotent when the flag already matches the requested value", async () => {
      fakeDb.addBusiness({ id: "biz-1", shared_sessions: 1 });

      const updated = await mod.updateBusinessSharedSessions(fakeDb, "biz-1", true);

      expect(updated).toBe(true);
      expect(fakeDb.businesses.get("biz-1")?.shared_sessions).toBe(1);
    });

    it("bumps updated_at to the current time", async () => {
      const originalNow = 1000;
      fakeDb.addBusiness({ id: "biz-1", shared_sessions: 0, updated_at: originalNow });
      const fakeNow = 2_000_000_000_000;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(fakeNow);

      try {
        await mod.updateBusinessSharedSessions(fakeDb, "biz-1", true);
      } finally {
        dateSpy.mockRestore();
      }

      expect(fakeDb.businesses.get("biz-1")?.updated_at).toBe(fakeNow);
    });

    it("does not touch other businesses", async () => {
      fakeDb.addBusiness({ id: "biz-1", shared_sessions: 0 });
      fakeDb.addBusiness({ id: "biz-2", shared_sessions: 0 });

      await mod.updateBusinessSharedSessions(fakeDb, "biz-1", true);

      expect(fakeDb.businesses.get("biz-1")?.shared_sessions).toBe(1);
      expect(fakeDb.businesses.get("biz-2")?.shared_sessions).toBe(0);
    });

    it("returns false when the business does not exist", async () => {
      const updated = await mod.updateBusinessSharedSessions(fakeDb, "missing", true);

      expect(updated).toBe(false);
      expect(fakeDb.businesses.has("missing")).toBe(false);
    });

    it("issues exactly one prepare() call", async () => {
      fakeDb.addBusiness({ id: "biz-1", shared_sessions: 0 });
      const prepareSpy = vi.spyOn(fakeDb, "prepare");

      await mod.updateBusinessSharedSessions(fakeDb, "biz-1", true);

      expect(prepareSpy).toHaveBeenCalledTimes(1);
      prepareSpy.mockRestore();
    });
  });

  describe("searchAdminBusinesses", () => {
    it("returns the latest businesses when no query is provided", async () => {
      fakeDb.addBusiness({ id: "biz-1", name: "Bravo", created_at: 100 });
      fakeDb.addBusiness({ id: "biz-2", name: "Alpha", created_at: 200 });

      const rows = await mod.searchAdminBusinesses(fakeDb, { limit: 10, orderBy: "createdAt" });

      expect(rows.map((row) => row.id)).toEqual(["biz-2", "biz-1"]);
    });

    it("matches businesses by name or id", async () => {
      fakeDb.addBusiness({ id: "biz-acme", name: "Acme Labs" });
      fakeDb.addBusiness({ id: "biz-other", name: "Other Co" });

      const byName = await mod.searchAdminBusinesses(fakeDb, { query: "Acme", limit: 10, orderBy: "name" });
      const byId = await mod.searchAdminBusinesses(fakeDb, { query: "other", limit: 10, orderBy: "name" });

      expect(byName.map((row) => row.id)).toEqual(["biz-acme"]);
      expect(byId.map((row) => row.id)).toEqual(["biz-other"]);
    });

    it("escapes LIKE wildcards in the query", async () => {
      fakeDb.addBusiness({ id: "biz-100-real", name: "Acme" });
      fakeDb.addBusiness({ id: "biz-100x", name: "Wildcard" });

      const rows = await mod.searchAdminBusinesses(fakeDb, { query: "100_", limit: 10, orderBy: "name" });

      expect(rows.map((row) => row.id)).toEqual([]);
    });
  });
});

function unescapeLike(value: string): string {
  return value.replace(/\\([\\%_])/g, "$1");
}
