import { beforeEach, describe, expect, it } from "vitest";

interface PendingRow {
  id: number;
  github_id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  requested_at: number;
  denied_at: number | null;
  denied_by_user_id: number | null;
}

type DbModule = typeof import("../../apps/control-plane-worker/src/auth/pending-signups-db");

class FakeStatement {
  private boundValues: unknown[] = [];
  constructor(
    private readonly db: FakePendingD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const q = this.query;
    if (q.startsWith("DELETE FROM pending_signups WHERE github_id = ?")) {
      const [github_id] = this.boundValues as [number];
      let changes = 0;
      for (const [id, row] of this.db.rows.entries()) {
        if (row.github_id === github_id) {
          this.db.rows.delete(id);
          changes++;
        }
      }
      return { success: true, meta: { changes, last_row_id: 0 } };
    }
    if (q.startsWith("UPDATE pending_signups\n       SET denied_at")) {
      const [denied_at, denied_by_user_id, id] = this.boundValues as [number, number, number];
      const row = this.db.rows.get(id);
      if (!row || row.denied_at !== null) {
        return { success: true, meta: { changes: 0, last_row_id: 0 } };
      }
      row.denied_at = denied_at;
      row.denied_by_user_id = denied_by_user_id;
      return { success: true, meta: { changes: 1, last_row_id: 0 } };
    }
    if (q.startsWith("DELETE FROM pending_signups\n       WHERE denied_at IS NOT NULL AND denied_at < ?")) {
      const [cutoff] = this.boundValues as [number];
      let changes = 0;
      for (const [id, row] of this.db.rows.entries()) {
        if (row.denied_at !== null && row.denied_at < cutoff) {
          this.db.rows.delete(id);
          changes++;
        }
      }
      return { success: true, meta: { changes, last_row_id: 0 } };
    }
    throw new Error(`Unhandled run query: ${q}`);
  }

  async first<T>(): Promise<T | null> {
    const q = this.query;
    if (q.startsWith("INSERT INTO pending_signups") && q.includes("ON CONFLICT")) {
      if (this.db.returnNullOnUpsertReturning) {
        return null;
      }
      const [github_id, login, name, email, avatar_url, requested_at] = this.boundValues as [
        number,
        string,
        string | null,
        string | null,
        string | null,
        number,
      ];
      for (const row of this.db.rows.values()) {
        if (row.github_id === github_id) {
          row.login = login;
          row.name = name;
          row.email = email;
          row.avatar_url = avatar_url;
          return { requested_at: row.requested_at } as unknown as T;
        }
      }
      const id = this.db.nextId++;
      this.db.rows.set(id, {
        id,
        github_id,
        login,
        name,
        email,
        avatar_url,
        requested_at,
        denied_at: null,
        denied_by_user_id: null,
      });
      return { requested_at } as unknown as T;
    }
    if (q.includes("WHERE github_id = ? LIMIT 1")) {
      const [github_id] = this.boundValues as [number];
      for (const row of this.db.rows.values()) {
        if (row.github_id === github_id) return row as unknown as T;
      }
      return null;
    }
    if (q.includes("WHERE id = ? LIMIT 1")) {
      const [id] = this.boundValues as [number];
      const row = this.db.rows.get(id);
      return row ? (row as unknown as T) : null;
    }
    throw new Error(`Unhandled first query: ${q}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    const q = this.query;
    if (q.includes("WHERE denied_at IS NULL")) {
      const open = Array.from(this.db.rows.values()).filter((r) => r.denied_at === null);
      open.sort((a, b) => a.requested_at - b.requested_at);
      return { results: open as unknown as T[] };
    }
    throw new Error(`Unhandled all query: ${q}`);
  }
}

class FakePendingD1 {
  readonly rows = new Map<number, PendingRow>();
  nextId = 1;
  returnNullOnUpsertReturning = false;
  prepare(query: string): FakeStatement {
    return new FakeStatement(this, query);
  }
}

let mod: DbModule;
let db: FakePendingD1;

describe("pending-signups DAO", () => {
  beforeEach(async () => {
    mod = (await import("../../apps/control-plane-worker/src/auth/pending-signups-db")) as DbModule;
    db = new FakePendingD1();
  });

  it("upserts a new pending signup and reports inserted=true", async () => {
    const inserted = await mod.upsertPendingSignup(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      { githubId: 100, login: "alice", name: "Alice", email: "a@x.com", avatarUrl: null },
      1000,
    );
    expect(inserted).toBe(true);
    expect(db.rows.size).toBe(1);
    const row = await mod.getPendingSignupByGithubId(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      100,
    );
    expect(row?.login).toBe("alice");
    expect(row?.deniedAt).toBeNull();
  });

  it("upserts an existing pending signup with refreshed profile (inserted=false)", async () => {
    await mod.upsertPendingSignup(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      { githubId: 100, login: "alice", name: "Alice", email: "a@x.com", avatarUrl: null },
      1000,
    );
    const inserted = await mod.upsertPendingSignup(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      { githubId: 100, login: "alice2", name: "Alice 2", email: "b@x.com", avatarUrl: "u" },
      2000,
    );
    expect(inserted).toBe(false);
    const row = await mod.getPendingSignupByGithubId(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      100,
    );
    expect(row?.login).toBe("alice2");
    expect(row?.requestedAt).toBe(1000);
  });

  it("throws when the upsert RETURNING clause produces no row", async () => {
    db.returnNullOnUpsertReturning = true;

    await expect(
      mod.upsertPendingSignup(
        db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
        { githubId: 100, login: "alice", name: "Alice", email: "a@x.com", avatarUrl: null },
        1000,
      ),
    ).rejects.toThrow("upsertPendingSignup: RETURNING clause produced no row");
  });

  it("lists only non-denied signups, ordered by requested_at ascending", async () => {
    await mod.upsertPendingSignup(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      { githubId: 1, login: "first", name: null, email: null, avatarUrl: null },
      1000,
    );
    await mod.upsertPendingSignup(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      { githubId: 2, login: "second", name: null, email: null, avatarUrl: null },
      2000,
    );
    await mod.markPendingSignupDenied(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      1,
      99,
      1500,
    );
    const open = await mod.listOpenPendingSignups(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
    );
    expect(open.map((r) => r.login)).toEqual(["second"]);
  });

  it("markPendingSignupDenied is idempotent (only changes once)", async () => {
    await mod.upsertPendingSignup(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      { githubId: 1, login: "x", name: null, email: null, avatarUrl: null },
      1000,
    );
    const first = await mod.markPendingSignupDenied(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      1,
      99,
      2000,
    );
    const second = await mod.markPendingSignupDenied(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      1,
      99,
      3000,
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("purges only denied rows older than the cutoff", async () => {
    await mod.upsertPendingSignup(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      { githubId: 1, login: "old", name: null, email: null, avatarUrl: null },
      1000,
    );
    await mod.upsertPendingSignup(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      { githubId: 2, login: "recent", name: null, email: null, avatarUrl: null },
      2000,
    );
    await mod.markPendingSignupDenied(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      1,
      99,
      3000,
    );
    await mod.markPendingSignupDenied(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      2,
      99,
      5000,
    );

    const purged = await mod.purgeDeniedPendingSignupsOlderThan(
      db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0],
      4000,
    );

    expect(purged).toBe(1);
    expect(
      await mod.getPendingSignupByGithubId(db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0], 1),
    ).toBeNull();
    expect(
      await mod.getPendingSignupByGithubId(db as unknown as Parameters<DbModule["getPendingSignupByGithubId"]>[0], 2),
    ).not.toBeNull();
  });
});
