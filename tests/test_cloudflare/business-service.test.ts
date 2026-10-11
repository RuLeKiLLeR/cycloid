import { describe, expect, it } from "vitest";

import { loadBusinessForAuth } from "../../apps/control-plane-worker/src/business/service";
import type { AuthInfo } from "../../apps/control-plane-worker/src/types";

type BusinessRow = {
  id: string;
  name: string;
  shared_sessions: number;
  egress_allowlist_json: string | null;
  egress_allowlist_source_repo_owner: string | null;
  egress_allowlist_source_repo_name: string | null;
  created_at: number;
};

class FakeD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM businesses b") && this.query.includes("INNER JOIN business_members bm")) {
      const [businessId, userId] = this.boundValues as [string, number];
      const business = this.db.businesses.get(businessId);
      const member = this.db.members.get(`${businessId}:${userId}`);
      if (!business || !member) return null;
      if (this.query.includes("bm.role = 'admin'") && member.role !== "admin") return null;
      return business as T;
    }

    if (this.query.includes("FROM businesses WHERE id = ?")) {
      const [businessId] = this.boundValues as [string];
      return (this.db.businesses.get(businessId) as T | undefined) ?? null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

class FakeD1 {
  readonly businesses = new Map<string, BusinessRow>();
  readonly members = new Map<string, { role: "admin" | "member" }>();

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
}

function makeDb(): D1Database {
  const db = new FakeD1();
  db.businesses.set("biz-1", {
    id: "biz-1",
    name: "Acme",
    shared_sessions: 1,
    egress_allowlist_json: JSON.stringify({ domains: ["api.acme.test"] }),
    egress_allowlist_source_repo_owner: "acme",
    egress_allowlist_source_repo_name: "infra",
    created_at: 123,
  });
  db.members.set("biz-1:1", { role: "admin" });
  db.members.set("biz-1:2", { role: "member" });
  return db as unknown as D1Database;
}

function auth(overrides: Partial<AuthInfo>): AuthInfo {
  return {
    userId: "1",
    tokenSource: "test",
    authMode: "user_session",
    canAccessAllSessions: false,
    ...overrides,
  };
}

describe("loadBusinessForAuth", () => {
  it("loads through getBusiness for super-admin callers", async () => {
    const business = await loadBusinessForAuth(makeDb(), auth({ canAccessAllSessions: true }), "biz-1");

    expect(business).toMatchObject({
      id: "biz-1",
      egressAllowlist: ["api.acme.test"],
      egressAllowlistSource: { sourceRepoOwner: "acme", sourceRepoName: "infra" },
    });
  });

  it("loads through getBusinessForAdmin for business admins", async () => {
    const business = await loadBusinessForAuth(makeDb(), auth({ userId: "1" }), "biz-1");

    expect(business).toMatchObject({
      id: "biz-1",
      egressAllowlist: ["api.acme.test"],
      egressAllowlistSource: { sourceRepoOwner: "acme", sourceRepoName: "infra" },
    });
  });

  it("falls back to getBusinessForMember only when member reads are allowed", async () => {
    const db = makeDb();

    const readable = await loadBusinessForAuth(db, auth({ userId: "2" }), "biz-1", { allowMember: true });
    const adminOnly = await loadBusinessForAuth(db, auth({ userId: "2" }), "biz-1");

    expect(readable).toMatchObject({
      id: "biz-1",
      egressAllowlist: null,
      egressAllowlistSource: null,
    });
    expect(adminOnly).toBeNull();
  });

  it("returns null for non-finite user ids", async () => {
    await expect(loadBusinessForAuth(makeDb(), auth({ userId: "not-a-number" }), "biz-1")).resolves.toBeNull();
  });
});
