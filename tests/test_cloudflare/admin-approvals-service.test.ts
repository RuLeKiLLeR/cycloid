import { webcrypto } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

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

interface BusinessRow {
  id: string;
  name: string;
  shared_sessions: number;
  self_hosted_sandboxes_enabled: number;
  created_at: number;
}

interface UserRow {
  id: number;
  github_id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  business_id: string;
}

interface MemberRow {
  business_id: string;
  user_id: number;
  role: string;
}

interface VirtualKeyRow {
  id: string;
  key_hash: string;
  owner_user_id: string;
  business_id: string | null;
  status: string;
}

class FakeStmt {
  private bound: unknown[] = [];
  constructor(
    private readonly db: FakeDb,
    private readonly q: string,
  ) {}
  bind(...v: unknown[]): this {
    this.bound = v;
    return this;
  }
  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const q = this.q;
    if (this.db.failRunForQueryPrefix && q.startsWith(this.db.failRunForQueryPrefix)) {
      throw new Error(`Injected failure for ${this.db.failRunForQueryPrefix}`);
    }
    if (q.startsWith("INSERT INTO businesses")) {
      const [id, name, createdAt] = this.bound as [string, string, number, number];
      this.db.businesses.set(id, {
        id,
        name,
        shared_sessions: 0,
        self_hosted_sandboxes_enabled: 0,
        created_at: createdAt,
      });
      return { success: true, meta: { changes: 1, last_row_id: 0 } };
    }
    if (q.startsWith("INSERT INTO users")) {
      const [github_id, login, name, email, avatar_url, business_id] = this.bound as [
        number,
        string,
        string | null,
        string | null,
        string | null,
        string,
      ];
      const existing = Array.from(this.db.users.values()).find((u) => u.github_id === github_id);
      if (existing) return { success: true, meta: { changes: 0, last_row_id: 0 } };
      const id = this.db.nextUserId++;
      this.db.users.set(id, { id, github_id, login, name, email, avatar_url, business_id });
      return { success: true, meta: { changes: 1, last_row_id: id } };
    }
    if (q.startsWith("INSERT INTO business_members")) {
      const [business_id, role, , , github_id] = this.bound as [string, string, number, number, number];
      const user = Array.from(this.db.users.values()).find((u) => u.github_id === github_id);
      if (!user) return { success: true, meta: { changes: 0, last_row_id: 0 } };
      this.db.members.set(user.id, { business_id, user_id: user.id, role });
      return { success: true, meta: { changes: 1, last_row_id: 0 } };
    }
    if (q.startsWith("INSERT INTO openai_virtual_keys")) {
      const [id, key_hash, owner_user_id, business_id] = this.bound as [string, string, string, string | null];
      if (this.db.virtualKeys.has(id)) return { success: true, meta: { changes: 0, last_row_id: 0 } };
      this.db.virtualKeys.set(id, { id, key_hash, owner_user_id, business_id, status: "active" });
      return { success: true, meta: { changes: 1, last_row_id: 0 } };
    }
    if (q.startsWith("UPDATE openai_virtual_keys")) {
      const [key_hash, business_id, , id] = this.bound as [string, string | null, number, string];
      const row = this.db.virtualKeys.get(id);
      if (!row) return { success: true, meta: { changes: 0, last_row_id: 0 } };
      row.key_hash = key_hash;
      row.business_id = business_id;
      row.status = "active";
      return { success: true, meta: { changes: 1, last_row_id: 0 } };
    }
    if (q.startsWith("DELETE FROM pending_signups")) {
      const [id] = this.bound as [number];
      const ok = this.db.pending.delete(id);
      return { success: true, meta: { changes: ok ? 1 : 0, last_row_id: 0 } };
    }
    if (q.startsWith("UPDATE pending_signups")) {
      const [denied_at, denied_by_user_id, id] = this.bound as [number, number, number];
      const row = this.db.pending.get(id);
      if (!row || row.denied_at !== null) return { success: true, meta: { changes: 0, last_row_id: 0 } };
      row.denied_at = denied_at;
      row.denied_by_user_id = denied_by_user_id;
      return { success: true, meta: { changes: 1, last_row_id: 0 } };
    }
    throw new Error(`Unhandled run: ${q}`);
  }
  async first<T>(): Promise<T | null> {
    const q = this.q;
    if (q.startsWith("DELETE FROM pending_signups") && q.includes("RETURNING")) {
      const [id] = this.bound as [number];
      const row = this.db.pending.get(id);
      if (!row || row.denied_at !== null) return null;
      const existingUser = Array.from(this.db.users.values()).find((u) => u.github_id === row.github_id);
      if (existingUser) return null;
      this.db.pending.delete(id);
      return {
        github_id: row.github_id,
        login: row.login,
        name: row.name,
        email: row.email,
        avatar_url: row.avatar_url,
      } as unknown as T;
    }
    if (q.includes("FROM pending_signups WHERE id = ?")) {
      const [id] = this.bound as [number];
      const row = this.db.pending.get(id);
      return (row as unknown as T) ?? null;
    }
    if (q.includes("FROM pending_signups WHERE github_id = ?")) {
      const [github_id] = this.bound as [number];
      const row = Array.from(this.db.pending.values()).find((candidate) => candidate.github_id === github_id);
      return (row as unknown as T) ?? null;
    }
    if (q.includes("FROM users WHERE github_id = ?")) {
      const [github_id] = this.bound as [number];
      for (const u of this.db.users.values()) {
        if (u.github_id === github_id) return { id: u.id, login: u.login } as unknown as T;
      }
      return null;
    }
    if (q.includes("SELECT business_id FROM users WHERE id = ?")) {
      const [id] = this.bound as [number];
      const row = this.db.users.get(id);
      return row ? ({ business_id: row.business_id } as unknown as T) : null;
    }
    if (q.includes("FROM businesses WHERE id = ?")) {
      const [id] = this.bound as [string];
      const row = this.db.businesses.get(id);
      return (row as unknown as T) ?? null;
    }
    if (q.includes("FROM openai_virtual_keys WHERE id = ?")) {
      const [id] = this.bound as [string];
      const row = this.db.virtualKeys.get(id);
      return row ? ({ id: row.id, key_hash: row.key_hash } as unknown as T) : null;
    }
    throw new Error(`Unhandled first: ${q}`);
  }
}

class FakeDb {
  readonly pending = new Map<number, PendingRow>();
  readonly businesses = new Map<string, BusinessRow>();
  readonly users = new Map<number, UserRow>();
  readonly members = new Map<number, MemberRow>();
  readonly virtualKeys = new Map<string, VirtualKeyRow>();
  nextUserId = 100;
  failRunForQueryPrefix: string | null = null;

  prepare(q: string): FakeStmt {
    return new FakeStmt(this, q);
  }
  async batch(stmts: FakeStmt[]): Promise<unknown[]> {
    const businessesSnapshot = new Map(this.businesses);
    const usersSnapshot = new Map(this.users);
    const membersSnapshot = new Map(this.members);
    const virtualKeysSnapshot = new Map(this.virtualKeys);
    const nextUserIdSnapshot = this.nextUserId;
    const out: unknown[] = [];
    try {
      for (const s of stmts) out.push(await s.run());
      return out;
    } catch (error) {
      this.businesses.clear();
      businessesSnapshot.forEach((value, key) => this.businesses.set(key, value));
      this.users.clear();
      usersSnapshot.forEach((value, key) => this.users.set(key, value));
      this.members.clear();
      membersSnapshot.forEach((value, key) => this.members.set(key, value));
      this.virtualKeys.clear();
      virtualKeysSnapshot.forEach((value, key) => this.virtualKeys.set(key, value));
      this.nextUserId = nextUserIdSnapshot;
      throw error;
    }
  }
}

type SvcModule = typeof import("../../apps/control-plane-worker/src/services/admin-approvals");

let svc: SvcModule;
let db: FakeDb;

describe("admin-approvals service", () => {
  beforeEach(async () => {
    vi.stubGlobal("crypto", {
      subtle: webcrypto.subtle,
      randomUUID: () => "biz-new",
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        if (array && "byteLength" in array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7);
        return array;
      },
    });
    svc = (await import("../../apps/control-plane-worker/src/services/admin-approvals")) as SvcModule;
    db = new FakeDb();
  });

  function seedPending(id: number, github_id: number, denied = false): void {
    db.pending.set(id, {
      id,
      github_id,
      login: `gh-${github_id}`,
      name: null,
      email: null,
      avatar_url: null,
      requested_at: 1000,
      denied_at: denied ? 1500 : null,
      denied_by_user_id: denied ? 7 : null,
    });
  }

  it("approve new business: creates business, user, member, removes pending", async () => {
    seedPending(1, 555);
    const result = await svc.approvePendingSignup(
      db as unknown as Parameters<SvcModule["approvePendingSignup"]>[0],
      1,
      { kind: "new", businessName: "Acme", role: "admin" },
      9,
    );
    expect(result.status).toBe("ok");
    expect(db.businesses.get("biz-new")?.name).toBe("Acme");
    const user = Array.from(db.users.values()).find((u) => u.github_id === 555);
    expect(user?.business_id).toBe("biz-new");
    expect(db.members.get(user!.id)?.role).toBe("admin");
    expect(db.virtualKeys.size).toBe(0);
    expect(db.pending.has(1)).toBe(false);
  });

  it("approve new business: rolls back business creation when user membership batch fails", async () => {
    seedPending(10, 1010);
    db.failRunForQueryPrefix = "INSERT INTO business_members";

    await expect(
      svc.approvePendingSignup(
        db as unknown as Parameters<SvcModule["approvePendingSignup"]>[0],
        10,
        { kind: "new", businessName: "Acme", role: "admin" },
        9,
      ),
    ).rejects.toThrow("Injected failure for INSERT INTO business_members");

    expect(db.pending.has(10)).toBe(false);
    expect(db.businesses.has("biz-new")).toBe(false);
    expect(db.users.size).toBe(0);
    expect(db.members.size).toBe(0);
    expect(db.virtualKeys.size).toBe(0);
  });

  it("approve existing business: rejects unknown businessId", async () => {
    seedPending(2, 666);
    const result = await svc.approvePendingSignup(
      db as unknown as Parameters<SvcModule["approvePendingSignup"]>[0],
      2,
      { kind: "existing", businessId: "biz-nope", role: "member" },
      9,
    );
    expect(result.status).toBe("business_not_found");
    expect(db.users.size).toBe(0);
    expect(db.pending.has(2)).toBe(true);
  });

  it("approve existing business: attaches user with given role", async () => {
    db.businesses.set("biz-acme", {
      id: "biz-acme",
      name: "Acme",
      shared_sessions: 0,
      self_hosted_sandboxes_enabled: 0,
      created_at: 0,
    });
    seedPending(3, 777);
    const result = await svc.approvePendingSignup(
      db as unknown as Parameters<SvcModule["approvePendingSignup"]>[0],
      3,
      { kind: "existing", businessId: "biz-acme", role: "member" },
      9,
    );
    expect(result.status).toBe("ok");
    const user = Array.from(db.users.values()).find((u) => u.github_id === 777);
    expect(user?.business_id).toBe("biz-acme");
    expect(db.members.get(user!.id)?.role).toBe("member");
  });

  it("approve fails on already-denied signup", async () => {
    seedPending(4, 888, true);
    const result = await svc.approvePendingSignup(
      db as unknown as Parameters<SvcModule["approvePendingSignup"]>[0],
      4,
      { kind: "new", businessName: "x", role: "admin" },
      9,
    );
    expect(result.status).toBe("already_denied");
  });

  it("approve fails when pending row is missing", async () => {
    const result = await svc.approvePendingSignup(
      db as unknown as Parameters<SvcModule["approvePendingSignup"]>[0],
      999,
      { kind: "new", businessName: "x", role: "admin" },
      9,
    );
    expect(result.status).toBe("not_found");
  });

  it("approve fails closed when the GitHub user already exists", async () => {
    seedPending(6, 1234);
    db.users.set(41, {
      id: 41,
      github_id: 1234,
      login: "existing-user",
      name: null,
      email: null,
      avatar_url: null,
      business_id: "biz-existing",
    });
    db.members.set(41, {
      business_id: "biz-existing",
      user_id: 41,
      role: "member",
    });

    const result = await svc.approvePendingSignup(
      db as unknown as Parameters<SvcModule["approvePendingSignup"]>[0],
      6,
      { kind: "new", businessName: "Acme", role: "admin" },
      9,
    );

    expect(result).toEqual({ status: "existing_user_conflict", userId: 41 });
    expect(db.pending.has(6)).toBe(true);
    expect(db.members.get(41)?.business_id).toBe("biz-existing");
  });

  it("denyPendingSignup marks denied and is idempotent", async () => {
    seedPending(5, 999);
    const first = await svc.denyPendingSignup(db as unknown as Parameters<SvcModule["denyPendingSignup"]>[0], 5, 9);
    const second = await svc.denyPendingSignup(db as unknown as Parameters<SvcModule["denyPendingSignup"]>[0], 5, 9);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("already_denied");
    expect(db.pending.get(5)?.denied_at).not.toBeNull();
  });
});
