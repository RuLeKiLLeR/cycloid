import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimIdempotencyKey,
  commitIdempotencyKey,
  getIdempotencyKey,
  releaseIdempotencyKey,
} from "../../apps/control-plane-worker/src/db/idempotency-db";
import {
  beginIdempotentRequest,
  commitIdempotentRequest,
  computeRequestHash,
  readIdempotencyKeyHeader,
  releaseIdempotentRequest,
} from "../../apps/control-plane-worker/src/services/idempotency";

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

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { meta: { changes: info.changes } };
  }
}

class SqliteD1 {
  constructor(readonly db: Database.Database) {}
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0162_idempotency_keys.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("idempotency_keys DAO", () => {
  const base = { ownerUserId: "1", key: "k1", route: "session", requestHash: "hash-a" };

  it("claims once and reports conflict on the second claim", async () => {
    const first = await claimIdempotencyKey(db, base);
    expect(first.created).toBe(true);
    expect(first.row.status).toBe("pending");
    expect(first.row.resolvedId).toBeNull();

    const second = await claimIdempotencyKey(db, base);
    expect(second.created).toBe(false);
    expect(second.row.status).toBe("pending");
  });

  it("commits a pending claim once and rejects a double-commit", async () => {
    await claimIdempotencyKey(db, base);
    expect(await commitIdempotencyKey(db, { ...base, resolvedId: "sess-1" })).toBe(true);
    // CAS only transitions a pending row; the row is now committed.
    expect(await commitIdempotencyKey(db, { ...base, resolvedId: "sess-2" })).toBe(false);

    const row = await getIdempotencyKey(db, base);
    expect(row?.status).toBe("committed");
    expect(row?.resolvedId).toBe("sess-1");
  });

  it("release deletes only a pending row, leaving committed rows intact", async () => {
    await claimIdempotencyKey(db, base);
    await releaseIdempotencyKey(db, base);
    expect(await getIdempotencyKey(db, base)).toBeNull();

    // After release the slot is free: a fresh claim succeeds.
    const reclaim = await claimIdempotencyKey(db, base);
    expect(reclaim.created).toBe(true);

    await commitIdempotencyKey(db, { ...base, resolvedId: "sess-1" });
    await releaseIdempotencyKey(db, base); // no-op on committed
    expect((await getIdempotencyKey(db, base))?.status).toBe("committed");
  });

  it("scopes by owner: the same key/route for another user is independent", async () => {
    await claimIdempotencyKey(db, base);
    await commitIdempotencyKey(db, { ...base, resolvedId: "sess-user1" });

    const otherUser = { ...base, ownerUserId: "2" };
    const claim = await claimIdempotencyKey(db, otherUser);
    expect(claim.created).toBe(true);
    expect(claim.row.resolvedId).toBeNull();
  });

  it("scopes by route: prompt routes carry the session id so keys do not collide", async () => {
    const a = { ownerUserId: "1", key: "shared", route: "prompt:sess-a", requestHash: "h" };
    const b = { ...a, route: "prompt:sess-b" };
    expect((await claimIdempotencyKey(db, a)).created).toBe(true);
    expect((await claimIdempotencyKey(db, b)).created).toBe(true);
  });
});

describe("idempotency service state machine", () => {
  const ownerUserId = "1";
  const route = "session";

  it("proceeds on first claim, then replays the committed resolved id", async () => {
    const body = { repoUrl: "https://github.com/acme/repo", prompt: "do it" };
    const first = await beginIdempotentRequest(db, { key: "key-1", ownerUserId, route, requestBody: body });
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    await commitIdempotentRequest(db, first.token, "sess-123");

    const replay = await beginIdempotentRequest(db, { key: "key-1", ownerUserId, route, requestBody: body });
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") expect(replay.resolvedId).toBe("sess-123");
  });

  it("rejects the same key with a different payload (409 payload_mismatch)", async () => {
    await beginIdempotentRequest(db, { key: "key-2", ownerUserId, route, requestBody: { a: 1 } });
    const reject = await beginIdempotentRequest(db, { key: "key-2", ownerUserId, route, requestBody: { a: 2 } });
    expect(reject.kind).toBe("reject");
    if (reject.kind === "reject") {
      expect(reject.status).toBe(409);
      expect(reject.reason).toBe("payload_mismatch");
    }
  });

  it("rejects a retry while the first claim is still pending (in_progress)", async () => {
    await beginIdempotentRequest(db, { key: "key-3", ownerUserId, route, requestBody: { a: 1 } });
    const reject = await beginIdempotentRequest(db, { key: "key-3", ownerUserId, route, requestBody: { a: 1 } });
    expect(reject.kind).toBe("reject");
    if (reject.kind === "reject") expect(reject.reason).toBe("in_progress");
  });

  it("treats canonically-equal payloads (key order, omitted undefined) as the same request", async () => {
    const h1 = await computeRequestHash({ b: 2, a: 1, c: undefined });
    const h2 = await computeRequestHash({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  it("re-claims after a release so a create-failure retry succeeds", async () => {
    const body = { a: 1 };
    const first = await beginIdempotentRequest(db, { key: "key-4", ownerUserId, route, requestBody: body });
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    await releaseIdempotentRequest(db, first.token); // simulate create failure

    const retry = await beginIdempotentRequest(db, { key: "key-4", ownerUserId, route, requestBody: body });
    expect(retry.kind).toBe("proceed");
  });

  it("is disabled (untracked) when no key is supplied", async () => {
    const decision = await beginIdempotentRequest(db, { key: null, ownerUserId, route, requestBody: { a: 1 } });
    expect(decision.kind).toBe("disabled");
  });

  it("a different user's same key never returns the first user's resolved id", async () => {
    const body = { a: 1 };
    const u1 = await beginIdempotentRequest(db, { key: "shared", ownerUserId: "1", route, requestBody: body });
    if (u1.kind === "proceed") await commitIdempotentRequest(db, u1.token, "sess-user1");

    const u2 = await beginIdempotentRequest(db, { key: "shared", ownerUserId: "2", route, requestBody: body });
    expect(u2.kind).toBe("proceed"); // independent claim, not a replay of user 1
  });
});

describe("readIdempotencyKeyHeader", () => {
  const make = (value: string | null) =>
    new Request("https://x/api/sessions", { headers: value === null ? {} : { "idempotency-key": value } });

  it("reads case-insensitively and trims", () => {
    expect(readIdempotencyKeyHeader(make("  abc  "))).toBe("abc");
  });
  it("returns null for absent or empty keys", () => {
    expect(readIdempotencyKeyHeader(make(null))).toBeNull();
    expect(readIdempotencyKeyHeader(make("   "))).toBeNull();
  });
  it("rejects over-long keys", () => {
    expect(readIdempotencyKeyHeader(make("a".repeat(256)))).toBeNull();
  });
});
