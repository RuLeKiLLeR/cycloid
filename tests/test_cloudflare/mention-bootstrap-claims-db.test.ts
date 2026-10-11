import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimMentionBootstrap,
  getMentionBootstrapClaim,
  releaseMentionBootstrap,
} from "../../apps/control-plane-worker/src/session/mention-bootstrap-claims-db";

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

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(private readonly db: Database.Database) {}

  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

const BUSINESS_ID = "business-1";
const PR_URL = "https://github.com/acme/repo/pull/123";
const NOW = 1_800_000_000_000;
const STALE_AFTER_MS = 10 * 60 * 1000;

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0258_mention_bootstrap_claims.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("mention bootstrap claims DAO", () => {
  it("lets the first claim win and rejects an immediate second claim", async () => {
    await expect(
      claimMentionBootstrap(db, {
        businessId: BUSINESS_ID,
        prUrl: PR_URL,
        now: NOW,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).resolves.toEqual({ won: true });

    await expect(
      claimMentionBootstrap(db, {
        businessId: BUSINESS_ID,
        prUrl: PR_URL,
        now: NOW + 1,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).resolves.toEqual({ won: false });
  });

  it("allows exactly one winner across concurrent claims", async () => {
    const claims = await Promise.all(
      Array.from({ length: 2 }, () =>
        claimMentionBootstrap(db, {
          businessId: BUSINESS_ID,
          prUrl: PR_URL,
          now: NOW,
          staleAfterMs: STALE_AFTER_MS,
        }),
      ),
    );

    expect(claims.filter(({ won }) => won)).toHaveLength(1);
  });

  it("overtakes a stale claim and refreshes its claimed timestamp", async () => {
    await claimMentionBootstrap(db, {
      businessId: BUSINESS_ID,
      prUrl: PR_URL,
      now: NOW - STALE_AFTER_MS - 1,
      staleAfterMs: STALE_AFTER_MS,
    });

    await expect(
      claimMentionBootstrap(db, {
        businessId: BUSINESS_ID,
        prUrl: PR_URL,
        now: NOW,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).resolves.toEqual({ won: true });
    await expect(getMentionBootstrapClaim(db, { businessId: BUSINESS_ID, prUrl: PR_URL })).resolves.toEqual({
      businessId: BUSINESS_ID,
      prUrl: PR_URL,
      claimedAt: NOW,
    });
  });

  it("does not overtake a claim exactly at the stale cutoff", async () => {
    await claimMentionBootstrap(db, {
      businessId: BUSINESS_ID,
      prUrl: PR_URL,
      now: NOW - STALE_AFTER_MS,
      staleAfterMs: STALE_AFTER_MS,
    });

    await expect(
      claimMentionBootstrap(db, {
        businessId: BUSINESS_ID,
        prUrl: PR_URL,
        now: NOW,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).resolves.toEqual({ won: false });
  });

  it("releases a claim so a subsequent claim wins", async () => {
    await claimMentionBootstrap(db, {
      businessId: BUSINESS_ID,
      prUrl: PR_URL,
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });
    await releaseMentionBootstrap(db, { businessId: BUSINESS_ID, prUrl: PR_URL });

    await expect(
      claimMentionBootstrap(db, {
        businessId: BUSINESS_ID,
        prUrl: PR_URL,
        now: NOW + 1,
        staleAfterMs: STALE_AFTER_MS,
      }),
    ).resolves.toEqual({ won: true });
  });

  it("scopes the same PR independently by business", async () => {
    const first = await claimMentionBootstrap(db, {
      businessId: BUSINESS_ID,
      prUrl: PR_URL,
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });
    const second = await claimMentionBootstrap(db, {
      businessId: "business-2",
      prUrl: PR_URL,
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(first).toEqual({ won: true });
    expect(second).toEqual({ won: true });
  });

  it("scopes different PRs independently within one business", async () => {
    const first = await claimMentionBootstrap(db, {
      businessId: BUSINESS_ID,
      prUrl: PR_URL,
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });
    const second = await claimMentionBootstrap(db, {
      businessId: BUSINESS_ID,
      prUrl: "https://github.com/acme/repo/pull/456",
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });

    expect(first).toEqual({ won: true });
    expect(second).toEqual({ won: true });
  });

  it("returns a stored claim and omits a released claim", async () => {
    await expect(getMentionBootstrapClaim(db, { businessId: BUSINESS_ID, prUrl: PR_URL })).resolves.toBeNull();

    await claimMentionBootstrap(db, {
      businessId: BUSINESS_ID,
      prUrl: PR_URL,
      now: NOW,
      staleAfterMs: STALE_AFTER_MS,
    });
    await expect(getMentionBootstrapClaim(db, { businessId: BUSINESS_ID, prUrl: PR_URL })).resolves.toEqual({
      businessId: BUSINESS_ID,
      prUrl: PR_URL,
      claimedAt: NOW,
    });

    await releaseMentionBootstrap(db, { businessId: BUSINESS_ID, prUrl: PR_URL });
    await expect(getMentionBootstrapClaim(db, { businessId: BUSINESS_ID, prUrl: PR_URL })).resolves.toBeNull();
  });
});
