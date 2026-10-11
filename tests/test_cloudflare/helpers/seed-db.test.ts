import { describe, expect, it } from "vitest";

import { UPSERT_SESSION_INDEX_SQL } from "../../../apps/control-plane-worker/src/session/db";
import { createControlPlaneD1, MIGRATIONS_DIR, seedBusiness, seedSessionIndex, seedUser } from "./seed-db";

describe("createControlPlaneD1", () => {
  it("provides a clean, fully migrated D1 schema", () => {
    const { sqlite } = createControlPlaneD1();
    try {
      expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM businesses").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM business_members").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM session_index").get()).toEqual({ count: 0 });

      const migrationCount = Number(sqlite.prepare("SELECT COUNT(*) AS count FROM d1_migrations").pluck().get());
      expect(migrationCount).toBeGreaterThan(0);
      expect(MIGRATIONS_DIR).toContain("apps/control-plane-worker/migrations");
      expect(sqlite.prepare("SELECT id, name FROM businesses").all()).toEqual([]);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'").get()).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  it("enforces the real foreign keys", () => {
    const { sqlite } = createControlPlaneD1();
    try {
      expect(() =>
        sqlite
          .prepare("INSERT INTO users (github_id, login, business_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run("gh-1", "user-1", "missing-business", 1, 1),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("seeds explicit business and user ids with membership", () => {
    const { sqlite } = createControlPlaneD1();
    try {
      expect(seedBusiness(sqlite, { id: "biz-explicit", name: "Explicit" })).toEqual({ id: "biz-explicit" });
      expect(seedUser(sqlite, { id: 42, businessId: "biz-explicit", githubId: 4242, login: "josiah" })).toEqual({
        id: 42,
        businessId: "biz-explicit",
      });
      expect(sqlite.prepare("SELECT id, business_id, login FROM users").all()).toEqual([
        { id: 42, business_id: "biz-explicit", login: "josiah" },
      ]);
      expect(sqlite.prepare("SELECT role FROM business_members WHERE user_id = 42").pluck().get()).toBe("member");
    } finally {
      sqlite.close();
    }
  });

  it("composes parent business, returns an autoincrement id, and supports membership overrides", () => {
    const { sqlite } = createControlPlaneD1();
    try {
      const user = seedUser(sqlite, { member: false, businessId: "auto-business", githubId: 9001 });
      expect(user.id).toBeTypeOf("number");
      expect(sqlite.prepare("SELECT id FROM businesses WHERE id = ?").get("auto-business")).toBeTruthy();
      expect(sqlite.prepare("SELECT * FROM business_members WHERE user_id = ?").all(user.id)).toEqual([]);

      seedUser(sqlite, { id: 43, businessId: "auto-business", role: "admin", githubId: 9002 });
      expect(sqlite.prepare("SELECT role FROM business_members WHERE user_id = 43").pluck().get()).toBe("admin");
      expect(seedUser(sqlite, { businessId: "auto-business", member: false, githubId: 9002 })).toEqual({
        id: 43,
        businessId: "auto-business",
      });
      expect(sqlite.prepare("SELECT * FROM business_members WHERE user_id = 43").all()).toEqual([]);
      expect(seedUser(sqlite, { businessId: "auto-business" }).id).not.toBe(user.id);
      expect(() => seedUser(sqlite, { id: 99, businessId: "other-business", githubId: 9002 })).toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("seeds session_index parents and normalizes timestamps to Unix milliseconds", () => {
    const { sqlite } = createControlPlaneD1();
    try {
      expect(seedSessionIndex(sqlite, { sessionId: "session-1", createdAt: "2026-01-02T03:04:05.000Z" })).toEqual({
        sessionId: "session-1",
        businessId: "biz-1",
        ownerUserId: 1,
      });
      const row = sqlite.prepare("SELECT created_at, updated_at, owner_user_id FROM session_index").get() as {
        created_at: unknown;
        updated_at: unknown;
        owner_user_id: unknown;
      };
      expect(row.created_at).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
      expect(row.updated_at).toBeTypeOf("number");
      expect(row.owner_user_id).toBe(1);
      expect(sqlite.prepare("SELECT id FROM users WHERE id = 1").get()).toEqual({ id: 1 });

      const columns = UPSERT_SESSION_INDEX_SQL.match(/INSERT INTO session_index \(([^)]+)\)/)?.[1]
        .split(",")
        .map((column) => column.trim());
      expect(columns).toEqual([
        "session_id",
        "owner_user_id",
        "business_id",
        "status",
        "created_at",
        "updated_at",
        "closed_at",
        "last_event_id",
        "title",
        "title_tags",
        "rich_status",
        "model",
        "reasoning_effort",
        "agent_runtime_backend",
        "agent_role",
        "target_pr_url",
        "installation_id",
        "repo_owner",
        "repo_name",
        "callback_context_json",
        "parent_session_id",
        "parent_prompt_id",
        "spawned_by_user_id",
        "spawn_depth",
        "initiation_mode",
        "entrypoint",
        "scheduled_rule_id",
        "rule_name_snapshot",
        "cron_snapshot",
      ]);
    } finally {
      sqlite.close();
    }
  });
});
