import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { exportBusinessOffboardingRows } from "../../apps/control-plane-worker/src/business/offboarding-export";
import { offboardBusiness } from "../../apps/control-plane-worker/src/business/offboarding-service";
import {
  disconnectBusinessJiraWorkspace,
  disconnectBusinessLinearWorkspace,
} from "../../apps/control-plane-worker/src/integrations/service";
import { deleteS3Objects, listSessionArchiveKeys } from "../../apps/control-plane-worker/src/services/archive";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { SqliteD1 } from "./sqlite-d1-helper";

vi.mock("../../apps/control-plane-worker/src/business/offboarding-export", () => ({
  exportBusinessOffboardingRows: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/service", () => ({
  disconnectBusinessJiraWorkspace: vi.fn(),
  disconnectBusinessLinearWorkspace: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/services/archive", () => ({
  deleteS3Objects: vi.fn(),
  listSessionArchiveKeys: vi.fn(),
}));

let sqlite: Database.Database;
let db: D1Database;

const log = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      business_id TEXT NOT NULL,
      login TEXT
    );
    CREATE TABLE businesses (
      id TEXT PRIMARY KEY,
      name TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE business_members (
      business_id TEXT,
      user_id INTEGER,
      role TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE session_index (
      session_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      business_id TEXT NOT NULL
    );
    CREATE TABLE auth_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER
    );
    CREATE TABLE cli_tokens (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      revoked_at INTEGER
    );
  `);
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0228_offboarding_jobs.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0236_offboarding_jobs_active_unique.sql", "utf8"));
  // Needed because offboardBusiness now also deletes personal secrets rows
  // from env_blobs (is_global=1) during cascade cleanup.
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0069_env_blobs.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0252_env_blob_entry_meta.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
  vi.mocked(exportBusinessOffboardingRows).mockResolvedValue({ tableCounts: {} } as never);
  vi.mocked(deleteS3Objects).mockResolvedValue({ deletedKeys: [], failedKeys: [] } as never);
  vi.mocked(disconnectBusinessLinearWorkspace).mockResolvedValue(undefined as never);
  vi.mocked(disconnectBusinessJiraWorkspace).mockResolvedValue(undefined as never);
});

describe("business offboarding service", () => {
  it("returns an active manifest without running destructive work for a confirmed concurrent loser", async () => {
    sqlite
      .prepare(
        `INSERT INTO offboarding_jobs (
          job_id, business_id, archive_key, captured_user_ids_json, captured_session_ids_json,
          phase, step_markers_json, table_counts_json, external_results_json, error_json,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'captured', '{}', ?, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        "job-winner",
        "biz-a",
        "archive-winner",
        JSON.stringify([1]),
        JSON.stringify(["s1"]),
        JSON.stringify({ users: 1 }),
        JSON.stringify({ startedBy: "winner" }),
        10,
        10,
      );

    const result = await offboardBusiness({} as Env, db, { businessId: "biz-a", confirm: true, now: 20 }, log);

    expect(result).toMatchObject({
      ok: true,
      dryRun: false,
      alreadyActive: true,
      archiveKey: "archive-winner",
      capturedUserIds: [1],
      capturedSessionIds: ["s1"],
      sessionArtifactKeys: [],
      tableCounts: { users: 1 },
      externalResults: { startedBy: "winner" },
    });
    expect(result.job.jobId).toBe("job-winner");
    expect(listSessionArchiveKeys).not.toHaveBeenCalled();
    expect(deleteS3Objects).not.toHaveBeenCalled();
  });

  it("lists session artifact keys with bounded concurrency and keeps a sorted unique result", async () => {
    seedBusiness("biz-a", ["s1", "s2", "s3", "s4", "s5", "s6"]);
    const active = { current: 0, max: 0 };
    const deferreds = new Map<string, Deferred<string[]>>();
    const calls: string[] = [];
    vi.mocked(listSessionArchiveKeys).mockImplementation((_env, sessionId) => {
      calls.push(sessionId);
      active.current += 1;
      active.max = Math.max(active.max, active.current);
      const deferred = createDeferred<string[]>();
      deferreds.set(sessionId, deferred);
      return deferred.promise.finally(() => {
        active.current -= 1;
      });
    });

    const run = offboardBusiness({} as Env, db, { businessId: "biz-a", confirm: false, now: 20 }, log);

    await waitUntil(() => calls.length === 5);
    expect(active.max).toBe(5);
    expect(calls).toEqual(["s1", "s2", "s3", "s4", "s5"]);

    for (const sessionId of ["s1", "s2", "s3", "s4", "s5"]) {
      deferreds.get(sessionId)?.resolve([`archive/${sessionId}`, "archive/a"]);
    }
    await waitUntil(() => calls.length === 6);
    deferreds.get("s6")?.resolve(["archive/z", "archive/a"]);

    await expect(run).resolves.toMatchObject({
      sessionArtifactKeys: [
        "archive/a",
        "archive/s1",
        "archive/s2",
        "archive/s3",
        "archive/s4",
        "archive/s5",
        "archive/z",
      ],
    });
  });

  it("purges SessionDO state with bounded concurrency and attempts every captured session", async () => {
    seedBusiness("biz-a", ["s1", "s2", "s3", "s4", "s5", "s6"]);
    vi.mocked(listSessionArchiveKeys).mockImplementation(async (_env, sessionId) => [`archive/${sessionId}`]);
    const active = { current: 0, max: 0 };
    const deferreds = new Map<string, Deferred<Response>>();
    const calls: string[] = [];
    const env = createSessionPurgeEnv((sessionId) => {
      calls.push(sessionId);
      active.current += 1;
      active.max = Math.max(active.max, active.current);
      const deferred = createDeferred<Response>();
      deferreds.set(sessionId, deferred);
      return deferred.promise.finally(() => {
        active.current -= 1;
      });
    });

    const run = offboardBusiness(env, db, { businessId: "biz-a", confirm: true, now: 20 }, log);

    await waitUntil(() => calls.length === 5);
    expect(active.max).toBe(5);
    expect(calls).toEqual(["s1", "s2", "s3", "s4", "s5"]);

    for (const sessionId of ["s1", "s2", "s3", "s4", "s5"]) {
      deferreds.get(sessionId)?.resolve(jsonResponse({ purged: true }));
    }
    await waitUntil(() => calls.length === 6);
    deferreds.get("s6")?.resolve(jsonResponse({ purged: true }));

    await expect(run).resolves.toMatchObject({
      ok: true,
      capturedSessionIds: ["s1", "s2", "s3", "s4", "s5", "s6"],
    });
    expect(calls).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
  });

  it("keeps artifact listing failures fail-fast", async () => {
    seedBusiness("biz-a", ["s1", "s2"]);
    vi.mocked(listSessionArchiveKeys).mockImplementation(async (_env, sessionId) => {
      if (sessionId === "s2") throw new Error("s2 listing failed");
      return [`archive/${sessionId}`];
    });

    await expect(
      offboardBusiness({} as Env, db, { businessId: "biz-a", confirm: false, now: 20 }, log),
    ).rejects.toThrow("s2 listing failed");
  });

  it("keeps SessionDO purge failures fail-fast and marks the job failed", async () => {
    seedBusiness("biz-a", ["s1", "s2"]);
    vi.mocked(listSessionArchiveKeys).mockImplementation(async (_env, sessionId) => [`archive/${sessionId}`]);
    const env = createSessionPurgeEnv((sessionId) =>
      Promise.resolve(sessionId === "s2" ? textResponse("boom", { status: 500 }) : jsonResponse({ purged: true })),
    );

    await expect(offboardBusiness(env, db, { businessId: "biz-a", confirm: true, now: 20 }, log)).rejects.toThrow(
      "SessionDO offboarding purge failed for s2: 500 boom",
    );
    expect(sqlite.prepare("SELECT phase FROM offboarding_jobs WHERE business_id = ?").get("biz-a")).toEqual({
      phase: "failed",
    });
  });
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for condition");
}

function seedBusiness(businessId: string, sessionIds: string[]): void {
  sqlite
    .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(businessId, "Acme", 1, 1);
  sqlite.prepare("INSERT INTO users (id, business_id, login) VALUES (?, ?, ?)").run(1, businessId, "owner");
  sqlite
    .prepare("INSERT INTO business_members (business_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(businessId, 1, "admin", 1, 1);
  for (const sessionId of sessionIds) {
    sqlite
      .prepare("INSERT INTO session_index (session_id, owner_user_id, business_id) VALUES (?, ?, ?)")
      .run(sessionId, "1", businessId);
  }
}

function createSessionPurgeEnv(fetchSession: (sessionId: string) => Promise<Response>): Env {
  return {
    SANDBOX_RUNTIME_CLEANUP_SECRET: "secret",
    SESSION: {
      idFromName: (sessionId: string) => sessionId,
      get: (sessionId: string) => ({
        fetch: () => fetchSession(sessionId),
      }),
    },
  } as unknown as Env;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}
