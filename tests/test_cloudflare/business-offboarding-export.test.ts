import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const awsFetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.mock("aws4fetch", () => ({
  AwsClient: class {
    fetch(url: string, init?: RequestInit): Promise<Response> {
      return awsFetchMock(url, init);
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: vi.fn(),
}));

import type { OffboardingJob } from "../../apps/control-plane-worker/src/business/db";
import { exportBusinessOffboardingRows } from "../../apps/control-plane-worker/src/business/offboarding-export";
import { SqliteD1 } from "./sqlite-d1-helper";

let sqlite: Database.Database;
let db: D1Database;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  awsFetchMock.mockResolvedValue(new Response("", { status: 200 }));
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE businesses (id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE business_members (business_id TEXT, user_id INTEGER, role TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE users (id INTEGER PRIMARY KEY, business_id TEXT, login TEXT);
    CREATE TABLE session_index (session_id TEXT PRIMARY KEY, owner_user_id TEXT, business_id TEXT);
    CREATE TABLE auth_sessions (token TEXT PRIMARY KEY, user_id INTEGER);
    CREATE TABLE session_webhook_refs (source TEXT, external_ref TEXT, session_id TEXT);
    CREATE TABLE automation_rules (id TEXT PRIMARY KEY, business_id TEXT);
  `);
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

describe("business offboarding export", () => {
  it("writes per-table NDJSON and a manifest for every row the cascade would delete", async () => {
    seedBusiness("biz-a", 1, "s-a");
    seedBusiness("biz-b", 2, "s-b");
    sqlite.prepare("INSERT INTO automation_rules (id, business_id) VALUES (?, ?)").run("rule-a", "biz-a");
    sqlite.prepare("INSERT INTO automation_rules (id, business_id) VALUES (?, ?)").run("rule-b", "biz-b");

    const manifest = await exportBusinessOffboardingRows(
      s3Env(),
      db,
      job("biz-a", [1], ["s-a"]),
      ["sessions/s-a/artifacts/a/shot.png"],
      log as never,
      123,
    );

    expect(manifest.tableCounts).toMatchObject({
      auth_sessions: 1,
      automation_rules: 1,
      business_members: 1,
      businesses: 1,
      session_index: 1,
      session_webhook_refs: 1,
      users: 1,
    });
    expect(manifest.sessionArtifactKeys).toEqual(["sessions/s-a/artifacts/a/shot.png"]);

    const uploads = awsFetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      body: new TextDecoder().decode(init?.body as Uint8Array),
    }));
    const usersUpload = uploads.find((upload) => upload.url.endsWith("/offboard-archive/biz-a/job-biz-a/users.ndjson"));
    expect(
      usersUpload?.body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([expect.objectContaining({ id: 1, business_id: "biz-a" })]);
    expect(uploads.some((upload) => upload.url.endsWith("/offboard-archive/biz-a/job-biz-a/manifest.json"))).toBe(true);
    expect(uploads.every((upload) => !upload.body.includes("biz-b"))).toBe(true);
  });
});

function seedBusiness(businessId: string, userId: number, sessionId: string): void {
  sqlite
    .prepare("INSERT INTO businesses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(businessId, businessId, 1, 1);
  sqlite
    .prepare("INSERT INTO business_members (business_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(businessId, userId, "admin", 1, 1);
  sqlite
    .prepare("INSERT INTO users (id, business_id, login) VALUES (?, ?, ?)")
    .run(userId, businessId, `user-${userId}`);
  sqlite
    .prepare("INSERT INTO session_index (session_id, owner_user_id, business_id) VALUES (?, ?, ?)")
    .run(sessionId, String(userId), businessId);
  sqlite.prepare("INSERT INTO auth_sessions (token, user_id) VALUES (?, ?)").run(`auth-${userId}`, userId);
  sqlite
    .prepare("INSERT INTO session_webhook_refs (source, external_ref, session_id) VALUES (?, ?, ?)")
    .run("linear", `issue-${userId}`, sessionId);
}

function s3Env() {
  return {
    S3_ACCESS_KEY_ID: "ak",
    S3_SECRET_ACCESS_KEY: "sk",
    S3_SESSION_BUCKET: "bucket",
    S3_REGION: "us-east-1",
  } as never;
}

function job(businessId: string, userIds: number[], sessionIds: string[]): OffboardingJob {
  return {
    jobId: `job-${businessId}`,
    businessId,
    archiveKey: `offboard-archive/${businessId}/job-${businessId}`,
    capturedUserIds: userIds,
    capturedSessionIds: sessionIds,
    phase: "captured",
    stepMarkers: {},
    tableCounts: {},
    externalResults: {},
    error: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  };
}
