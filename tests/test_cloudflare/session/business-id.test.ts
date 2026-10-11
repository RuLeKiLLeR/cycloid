import { describe, expect, it } from "vitest";

import {
  MissingBusinessIdError,
  resolveRequiredBusinessId,
} from "../../../apps/control-plane-worker/src/session/business-id";

class FakeStatement {
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
    if (this.query.includes("FROM session_index")) {
      const [sessionId] = this.boundValues as [string];
      const businessId = this.db.sessionIndex.get(sessionId);
      return businessId ? ({ business_id: businessId } as T) : null;
    }

    if (this.query.includes("FROM users")) {
      const [ownerUserId] = this.boundValues as [string];
      const businessId = this.db.users.get(ownerUserId);
      return businessId ? ({ business_id: businessId } as T) : null;
    }

    throw new Error(`Unhandled query: ${this.query}`);
  }
}

class FakeD1 {
  readonly sessionIndex = new Map<string, string>();
  readonly users = new Map<string, string>();
  readonly queries: string[] = [];

  prepare(query: string): FakeStatement {
    this.queries.push(query);
    return new FakeStatement(this, query);
  }
}

describe("resolveRequiredBusinessId", () => {
  it("returns the explicit business id without querying fallbacks", async () => {
    const db = new FakeD1();

    await expect(
      resolveRequiredBusinessId(db as unknown as D1Database, {
        operation: "test write",
        ownerUserId: "42",
        sessionId: "session-1",
        businessId: "biz-explicit",
      }),
    ).resolves.toBe("biz-explicit");

    expect(db.queries.some((query) => query.includes("FROM session_index"))).toBe(false);
    expect(db.queries.some((query) => query.includes("FROM users"))).toBe(false);
  });

  it("falls back to the indexed session business id before the owner user", async () => {
    const db = new FakeD1();
    db.sessionIndex.set("session-1", "biz-indexed");
    db.users.set("42", "biz-user");

    await expect(
      resolveRequiredBusinessId(db as unknown as D1Database, {
        operation: "test write",
        ownerUserId: "42",
        sessionId: "session-1",
        businessId: null,
      }),
    ).resolves.toBe("biz-indexed");
  });

  it("falls back to the owner user business id when the session index is missing", async () => {
    const db = new FakeD1();
    db.users.set("42", "biz-user");

    await expect(
      resolveRequiredBusinessId(db as unknown as D1Database, {
        operation: "test write",
        ownerUserId: "42",
        sessionId: "session-1",
        businessId: null,
      }),
    ).resolves.toBe("biz-user");
  });

  it("throws MissingBusinessIdError when no fallback can prove ownership", async () => {
    const db = new FakeD1();

    await expect(
      resolveRequiredBusinessId(db as unknown as D1Database, {
        operation: "test write",
        ownerUserId: "42",
        sessionId: "session-1",
        businessId: null,
      }),
    ).rejects.toBeInstanceOf(MissingBusinessIdError);
  });
});
