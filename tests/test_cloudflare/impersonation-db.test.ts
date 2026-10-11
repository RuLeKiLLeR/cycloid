import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createImpersonationIfActorBelowLimit,
  resolveImpersonationByTokenHash,
  revokeImpersonation,
} from "../../apps/control-plane-worker/src/auth/impersonation-db";
import { ARCANIST_BUSINESS_ID } from "../../apps/control-plane-worker/src/constants/auth";
import {
  IMPERSONATION_MAX_ACTIVE_PER_ACTOR,
  IMPERSONATION_TTL_MS,
} from "../../apps/control-plane-worker/src/constants/auth";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

class SqliteD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run() {
    const result = this.db.prepare(this.query).run(...this.boundValues);
    return {
      success: true as const,
      meta: { last_row_id: Number(result.lastInsertRowid ?? 0), changes: result.changes },
    };
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");

  constructor() {
    this.sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, query);
  }
}

function seedUser(
  d1: SqliteD1,
  id: number,
  businessId = "biz-impersonation",
  role: "admin" | "member" = "member",
): void {
  const now = Date.now();
  d1.sqlite
    .prepare(
      `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      10_000 + id,
      `user-${id}`,
      `User ${id}`,
      `user-${id}@example.com`,
      `https://example.com/${id}.png`,
      businessId,
      now,
      now,
    );
  d1.sqlite
    .prepare(
      `INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(businessId, id, role, now, now);
}

function seedUsers(d1: SqliteD1): void {
  const now = Date.now();
  d1.sqlite
    .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("biz-impersonation", "Impersonation Test", now, now);
  seedUser(d1, 1, "biz-impersonation", "admin");
  seedUser(d1, 2);
}

function activeRowCount(d1: SqliteD1, actorUserId = 1, now = Date.now()): number {
  const row = d1.sqlite
    .prepare(
      `SELECT COUNT(*) AS count
       FROM impersonation_sessions
       WHERE actor_user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(actorUserId, now) as { count: number };
  return row.count;
}

describe("impersonation DAO", () => {
  let d1: SqliteD1;
  let db: D1Database;
  const now = 1_800_000_000_000;

  beforeEach(() => {
    d1 = new SqliteD1();
    db = d1 as unknown as D1Database;
    seedUsers(d1);
  });

  it("caps active impersonation inserts per actor with the guarded INSERT semantics", async () => {
    // The better-sqlite3-backed shim executes each statement synchronously, so
    // this verifies the SQL guard itself rather than true cross-request
    // concurrency. In production, D1's serialized writes provide the actual
    // concurrent-safety guarantee for this conditional INSERT.
    const attempts = Array.from({ length: IMPERSONATION_MAX_ACTIVE_PER_ACTOR * 2 }, (_, index) =>
      createImpersonationIfActorBelowLimit(db, {
        id: `imp-${index}`,
        tokenHash: `token-hash-${index}`,
        actorUserId: 1,
        targetUserId: 2,
        reason: "debugging customer issue",
        ttlMs: IMPERSONATION_TTL_MS,
        maxActivePerActor: IMPERSONATION_MAX_ACTIVE_PER_ACTOR,
        now,
      }),
    );

    const rows = await Promise.all(attempts);

    expect(rows.filter(Boolean)).toHaveLength(IMPERSONATION_MAX_ACTIVE_PER_ACTOR);
    expect(rows.filter((row) => row === null)).toHaveLength(IMPERSONATION_MAX_ACTIVE_PER_ACTOR);
    expect(activeRowCount(d1, 1, now)).toBe(IMPERSONATION_MAX_ACTIVE_PER_ACTOR);
  });

  it("allows a new impersonation after an existing active session is revoked", async () => {
    for (let index = 0; index < IMPERSONATION_MAX_ACTIVE_PER_ACTOR; index += 1) {
      const row = await createImpersonationIfActorBelowLimit(db, {
        id: `imp-${index}`,
        tokenHash: `token-hash-${index}`,
        actorUserId: 1,
        targetUserId: 2,
        reason: "debugging customer issue",
        ttlMs: IMPERSONATION_TTL_MS,
        maxActivePerActor: IMPERSONATION_MAX_ACTIVE_PER_ACTOR,
        now,
      });
      expect(row).not.toBeNull();
    }

    expect(
      await createImpersonationIfActorBelowLimit(db, {
        id: "imp-over-limit",
        tokenHash: "token-hash-over-limit",
        actorUserId: 1,
        targetUserId: 2,
        reason: "debugging customer issue",
        ttlMs: IMPERSONATION_TTL_MS,
        maxActivePerActor: IMPERSONATION_MAX_ACTIVE_PER_ACTOR,
        now,
      }),
    ).toBeNull();

    await revokeImpersonation(db, "imp-0", 1, now + 1);
    const replacement = await createImpersonationIfActorBelowLimit(db, {
      id: "imp-replacement",
      tokenHash: "token-hash-replacement",
      actorUserId: 1,
      targetUserId: 2,
      reason: "debugging customer issue",
      ttlMs: IMPERSONATION_TTL_MS,
      maxActivePerActor: IMPERSONATION_MAX_ACTIVE_PER_ACTOR,
      now: now + 2,
    });

    expect(replacement).toMatchObject({ id: "imp-replacement", actorUserId: 1, targetUserId: 2 });
    expect(activeRowCount(d1, 1, now + 2)).toBe(IMPERSONATION_MAX_ACTIVE_PER_ACTOR);
  });
});

describe("resolveImpersonationByTokenHash actor-authority recheck", () => {
  const now = 1_800_000_000_000;
  // Migrations seed exactly one Cycloid user (an internal admin); reuse it as
  // the operator/actor so the test mirrors a real internal-admin identity.
  const ACTOR_ID = 71931994;
  const TARGET_ID = 900002;

  function setup(): { d1: SqliteD1; db: D1Database } {
    const d1 = new SqliteD1();
    // The Cycloid business and the actor (id ACTOR_ID, internal admin) are
    // already seeded by migrations. Seed only the impersonation target.
    d1.sqlite
      .prepare(
        `INSERT INTO users (id, github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(TARGET_ID, 99001, "target", "Target", "target@example.com", null, ARCANIST_BUSINESS_ID, now, now);
    d1.sqlite
      .prepare(
        `INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ARCANIST_BUSINESS_ID, TARGET_ID, "member", now, now);
    return { d1, db: d1 as unknown as D1Database };
  }

  async function mint(db: D1Database): Promise<void> {
    const row = await createImpersonationIfActorBelowLimit(db, {
      id: "imp-recheck",
      tokenHash: "token-hash-recheck",
      actorUserId: ACTOR_ID,
      targetUserId: TARGET_ID,
      reason: "debugging customer issue",
      ttlMs: IMPERSONATION_TTL_MS,
      maxActivePerActor: IMPERSONATION_MAX_ACTIVE_PER_ACTOR,
      now,
    });
    // Surface a broken migration seed (missing actor/target user) immediately
    // rather than as a confusing assertion failure deeper in each test.
    expect(row).not.toBeNull();
  }

  function revokedAt(d1: SqliteD1): number | null {
    const row = d1.sqlite.prepare("SELECT revoked_at FROM impersonation_sessions WHERE id = 'imp-recheck'").get() as
      { revoked_at: number | null } | undefined;
    return row?.revoked_at ?? null;
  }

  it("resolves while the actor is still a Cycloid admin", async () => {
    const { db } = setup();
    await mint(db);
    const result = await resolveImpersonationByTokenHash(db, "token-hash-recheck", now);
    expect(result.status).toBe("ok");
  });

  it("fails closed when the actor has been demoted from admin to member", async () => {
    const { d1, db } = setup();
    await mint(db);
    // Demote the operator after the token was minted; the token is unexpired.
    d1.sqlite
      .prepare("UPDATE business_members SET role = 'member' WHERE business_id = ? AND user_id = ?")
      .run(ARCANIST_BUSINESS_ID, ACTOR_ID);
    const result = await resolveImpersonationByTokenHash(db, "token-hash-recheck", now);
    expect(result.status).toBe("invalid");
    // The denied session is also revoked so it cannot linger as "active".
    expect(revokedAt(d1)).toBe(now);
  });

  it("fails closed when the actor's business membership has been revoked", async () => {
    const { d1, db } = setup();
    await mint(db);
    // Revoke the operator's Cycloid membership after the token was minted;
    // the join then yields a null role, so the recheck must fail closed.
    d1.sqlite.prepare("DELETE FROM business_members WHERE user_id = ?").run(ACTOR_ID);
    const result = await resolveImpersonationByTokenHash(db, "token-hash-recheck", now);
    expect(result.status).toBe("invalid");
    expect(revokedAt(d1)).toBe(now);
  });
});
