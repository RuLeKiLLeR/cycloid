import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createOffboardingJobManifest,
  getOffboardingJob,
  updateOffboardingJobProgress,
} from "../../apps/control-plane-worker/src/business/db";
import { SqliteD1 } from "./sqlite-d1-helper";

let sqlite: Database.Database;
let db: D1Database;

function createBaseSchema(): void {
  sqlite.exec(`
    CREATE TABLE businesses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      shared_sessions INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      business_id TEXT NOT NULL,
      login TEXT
    );
    CREATE TABLE session_index (
      session_id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      business_id TEXT NOT NULL
    );
  `);
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0228_offboarding_jobs.sql", "utf8"));
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  createBaseSchema();
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0236_offboarding_jobs_active_unique.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("business offboarding manifest DAO", () => {
  it("captures business users and sessions before destructive work", async () => {
    sqlite
      .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("biz-a", "A", 1, 1);
    sqlite
      .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("biz-b", "B", 1, 1);
    sqlite.prepare("INSERT INTO users (id, business_id, login) VALUES (?, ?, ?)").run(2, "biz-a", "two");
    sqlite.prepare("INSERT INTO users (id, business_id, login) VALUES (?, ?, ?)").run(1, "biz-a", "one");
    sqlite.prepare("INSERT INTO users (id, business_id, login) VALUES (?, ?, ?)").run(3, "biz-b", "three");
    sqlite
      .prepare("INSERT INTO session_index (session_id, owner_user_id, business_id) VALUES (?, ?, ?)")
      .run("s2", "2", "biz-a");
    sqlite
      .prepare("INSERT INTO session_index (session_id, owner_user_id, business_id) VALUES (?, ?, ?)")
      .run("s1", "1", "biz-a");
    sqlite
      .prepare("INSERT INTO session_index (session_id, owner_user_id, business_id) VALUES (?, ?, ?)")
      .run("s3", "3", "biz-b");

    const manifest = await createOffboardingJobManifest(db, { businessId: "biz-a", jobId: "job-a", now: 10 });
    const job = manifest.job;

    expect(manifest.created).toBe(true);
    expect(job).toMatchObject({
      jobId: "job-a",
      businessId: "biz-a",
      archiveKey: "offboard-archive/biz-a/job-a",
      capturedUserIds: [1, 2],
      capturedSessionIds: ["s1", "s2"],
      phase: "captured",
      createdAt: 10,
      updatedAt: 10,
    });
  });

  it("resumes the latest incomplete manifest instead of recapturing from roots", async () => {
    sqlite.prepare("INSERT INTO users (id, business_id, login) VALUES (?, ?, ?)").run(1, "biz-a", "one");
    sqlite
      .prepare("INSERT INTO session_index (session_id, owner_user_id, business_id) VALUES (?, ?, ?)")
      .run("s1", "1", "biz-a");
    const first = await createOffboardingJobManifest(db, { businessId: "biz-a", jobId: "job-a", now: 10 });
    sqlite.prepare("DELETE FROM users").run();
    sqlite.prepare("DELETE FROM session_index").run();

    const second = await createOffboardingJobManifest(db, { businessId: "biz-a", jobId: "job-b", now: 20 });

    expect(second.created).toBe(false);
    expect(second.job.jobId).toBe(first.job.jobId);
    expect(second.job.capturedUserIds).toEqual([1]);
    expect(second.job.capturedSessionIds).toEqual(["s1"]);
  });

  it("returns the competing active manifest when a concurrent insert wins the unique race", async () => {
    sqlite.prepare("INSERT INTO users (id, business_id, login) VALUES (?, ?, ?)").run(1, "biz-a", "one");
    const baseDb = db as unknown as SqliteD1;
    let insertedCompetingManifest = false;
    const racingDb = {
      prepare(query: string) {
        const statement = baseDb.prepare(query);
        if (query.includes("INSERT INTO offboarding_jobs")) {
          const originalRun = statement.run.bind(statement);
          statement.run = async () => {
            if (!insertedCompetingManifest) {
              insertedCompetingManifest = true;
              sqlite
                .prepare(
                  `INSERT INTO offboarding_jobs (
                    job_id, business_id, archive_key, captured_user_ids_json, captured_session_ids_json,
                    phase, step_markers_json, table_counts_json, external_results_json, error_json,
                    created_at, updated_at, completed_at
                  ) VALUES (?, ?, ?, ?, '[]', 'captured', '{}', '{}', '{}', NULL, ?, ?, NULL)`,
                )
                .run("job-winner", "biz-a", "archive-winner", "[1]", 9, 9);
            }
            return originalRun();
          };
        }
        return statement;
      },
      batch: baseDb.batch.bind(baseDb),
    } as unknown as D1Database;

    const result = await createOffboardingJobManifest(racingDb, { businessId: "biz-a", jobId: "job-loser", now: 10 });

    expect(result.created).toBe(false);
    expect(result.job.jobId).toBe("job-winner");
    expect(result.job.capturedUserIds).toEqual([1]);
    expect(await getOffboardingJob(db, "job-loser")).toBeNull();
  });

  it("supersedes a failed job with a fresh manifest so offboarding can be retried", async () => {
    sqlite.prepare("INSERT INTO users (id, business_id, login) VALUES (?, ?, ?)").run(1, "biz-a", "one");
    const first = await createOffboardingJobManifest(db, { businessId: "biz-a", jobId: "job-a", now: 10 });
    await updateOffboardingJobProgress(db, first.job, { phase: "failed", error: { message: "boom" }, now: 15 });

    const retry = await createOffboardingJobManifest(db, { businessId: "biz-a", jobId: "job-b", now: 20 });

    expect(retry.created).toBe(true);
    expect(retry.job.jobId).toBe("job-b");
    expect(retry.job.phase).toBe("captured");
    expect(retry.job.capturedUserIds).toEqual([1]);
  });

  it("enforces one active manifest per business while allowing completed and failed history", async () => {
    sqlite
      .prepare(
        `INSERT INTO offboarding_jobs (
          job_id, business_id, archive_key, captured_user_ids_json, captured_session_ids_json,
          phase, step_markers_json, table_counts_json, external_results_json, error_json,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, '[]', '[]', ?, '{}', '{}', '{}', NULL, ?, ?, ?)`,
      )
      .run("job-completed", "biz-a", "archive-completed", "completed", 1, 1, 2);
    sqlite
      .prepare(
        `INSERT INTO offboarding_jobs (
          job_id, business_id, archive_key, captured_user_ids_json, captured_session_ids_json,
          phase, step_markers_json, table_counts_json, external_results_json, error_json,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, '[]', '[]', ?, '{}', '{}', '{}', NULL, ?, ?, ?)`,
      )
      .run("job-failed", "biz-a", "archive-failed", "failed", 3, 3, null);
    sqlite
      .prepare(
        `INSERT INTO offboarding_jobs (
          job_id, business_id, archive_key, captured_user_ids_json, captured_session_ids_json,
          phase, step_markers_json, table_counts_json, external_results_json, error_json,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, '[]', '[]', ?, '{}', '{}', '{}', NULL, ?, ?, ?)`,
      )
      .run("job-active", "biz-a", "archive-active", "captured", 4, 4, null);

    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO offboarding_jobs (
            job_id, business_id, archive_key, captured_user_ids_json, captured_session_ids_json,
            phase, step_markers_json, table_counts_json, external_results_json, error_json,
            created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, '[]', '[]', ?, '{}', '{}', '{}', NULL, ?, ?, ?)`,
        )
        .run("job-duplicate", "biz-a", "archive-duplicate", "exported", 5, 5, null),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("normalizes duplicate active manifests before creating the active uniqueness index", () => {
    sqlite = new Database(":memory:");
    createBaseSchema();
    sqlite
      .prepare(
        `INSERT INTO offboarding_jobs (
          job_id, business_id, archive_key, captured_user_ids_json, captured_session_ids_json,
          phase, step_markers_json, table_counts_json, external_results_json, error_json,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, '[]', '[]', ?, '{}', '{}', '{}', NULL, ?, ?, NULL)`,
      )
      .run("job-old", "biz-a", "archive-old", "captured", 10, 10);
    sqlite
      .prepare(
        `INSERT INTO offboarding_jobs (
          job_id, business_id, archive_key, captured_user_ids_json, captured_session_ids_json,
          phase, step_markers_json, table_counts_json, external_results_json, error_json,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, '[]', '[]', ?, '{}', '{}', '{}', NULL, ?, ?, NULL)`,
      )
      .run("job-new", "biz-a", "archive-new", "exported", 20, 20);

    sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0236_offboarding_jobs_active_unique.sql", "utf8"));

    expect(
      sqlite
        .prepare("SELECT job_id FROM offboarding_jobs WHERE business_id = ? AND phase NOT IN ('completed', 'failed')")
        .all("biz-a"),
    ).toEqual([{ job_id: "job-new" }]);
    expect(sqlite.prepare("SELECT phase, error_json FROM offboarding_jobs WHERE job_id = ?").get("job-old")).toEqual({
      phase: "failed",
      error_json: '{"message":"Superseded by active offboarding job unique-index migration"}',
    });
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO offboarding_jobs (
            job_id, business_id, archive_key, captured_user_ids_json, captured_session_ids_json,
            phase, step_markers_json, table_counts_json, external_results_json, error_json,
            created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, '[]', '[]', 'captured', '{}', '{}', '{}', NULL, ?, ?, NULL)`,
        )
        .run("job-duplicate", "biz-a", "archive-duplicate", 30, 30),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("merges progress without dropping captured ids", async () => {
    sqlite.prepare("INSERT INTO users (id, business_id, login) VALUES (?, ?, ?)").run(1, "biz-a", "one");
    const manifest = await createOffboardingJobManifest(db, { businessId: "biz-a", jobId: "job-a", now: 10 });
    const job = manifest.job;

    const updated = await updateOffboardingJobProgress(db, job, {
      phase: "exported",
      stepMarkers: { export: true },
      tableCounts: { users: 1 },
      externalResults: { archiveManifestKey: "offboard-archive/biz-a/job-a/manifest.json" },
      now: 15,
    });

    expect(updated.capturedUserIds).toEqual([1]);
    expect(updated.phase).toBe("exported");
    expect(updated.stepMarkers).toEqual({ export: true });
    expect(updated.tableCounts).toEqual({ users: 1 });
    expect(updated.externalResults).toEqual({ archiveManifestKey: "offboard-archive/biz-a/job-a/manifest.json" });
    expect((await getOffboardingJob(db, "job-a"))?.updatedAt).toBe(15);
  });
});
