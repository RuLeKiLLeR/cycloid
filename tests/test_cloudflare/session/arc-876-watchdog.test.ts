/**
 * ARC-876: invariant tests for the post-execution and publishing watchdogs
 * plus the bundled push-outcome protocol.
 *
 * Covers the spec's Phase 4 list at the unit level. End-to-end behavior
 * inside the SessionDO is exercised by the pr-workflow and prompt-queue
 * suites; this file focuses on the pieces that have to hold independently:
 *
 *   - per-prompt watchdog state on `platform_llm_prompt_status.started_at`
 *   - `getPlatformLlmPromptStatusesPending` returns the rows the alarm
 *     scheduler walks to compute the soonest deadline
 *   - `isPromptPublishable` gates both auto and manual publish paths on the
 *     most recent prompt's `push_status`
 *   - prompt push outcome is persisted by `updatePromptPushOutcome`
 *   - PublishStatus enum no longer carries `"ready"`
 */

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  POST_EXECUTION_DEADLINE_MS,
  PUBLISHING_DEADLINE_MS,
} from "../../../apps/control-plane-worker/src/constants/sessions.js";
import {
  getPlatformLlmPromptStatus,
  getPlatformLlmPromptStatusesPending,
  getPromptPushOutcome,
  updatePromptPushOutcome,
  upsertPlatformLlmPromptStatus,
} from "../../../apps/control-plane-worker/src/session/do-db.js";
import { isPromptPublishable } from "../../../apps/control-plane-worker/src/session/publish-service.js";
import { initSchema, MIGRATIONS } from "../../../apps/control-plane-worker/src/session/schema.js";
import { PUBLISH_STATUSES } from "../../../shared/types/publish.js";

// Lightweight better-sqlite3 -> SqlStorage shim. Multi-statement SQL goes
// through `db.exec` (no params, matches initSchema's batched DDL); everything
// else uses prepare + run/all.
function createMockSql(): SqlStorage {
  const db = new Database(":memory:");
  const cursorOf = (rows: unknown[], rowsWritten: number) =>
    ({
      toArray() {
        return rows as Record<string, SqlStorageValue>[];
      },
      rowsRead: rows.length,
      rowsWritten,
      [Symbol.iterator]() {
        return (rows as Iterable<unknown>)[Symbol.iterator]() as Iterator<Record<string, SqlStorageValue>>;
      },
    }) as unknown as SqlStorageCursor;
  return {
    exec(query: string, ...params: unknown[]) {
      const isSelect = /^\s*(SELECT|WITH|PRAGMA)/i.test(query);
      if (params.length === 0) {
        if (isSelect) {
          return cursorOf(db.prepare(query).all(), 0);
        }
        db.exec(query);
        return cursorOf([], 0);
      }
      const stmt = db.prepare(query);
      if (isSelect) {
        return cursorOf(stmt.all(...(params as unknown[])), 0);
      }
      const result = stmt.run(...(params as unknown[]));
      return cursorOf([], result.changes);
    },
    databaseSize: 0,
  } as unknown as SqlStorage;
}

describe("ARC-876 schema and migrations", () => {
  it("ships every watchdog and push-outcome column as additive migrations", () => {
    const ids = new Map(MIGRATIONS.map((m) => [m.id, m.sql]));
    expect(ids.get(53)).toContain("platform_llm_prompt_status ADD COLUMN started_at");
    expect(ids.get(54)).toContain("session ADD COLUMN publishing_started_at");
    expect(ids.get(55)).toContain("prompts ADD COLUMN push_status");
    expect(ids.get(56)).toContain("prompts ADD COLUMN push_error");
    expect(ids.get(57)).toContain("UPDATE session SET publish_status = 'publishing' WHERE publish_status = 'ready'");
  });

  it("removes 'ready' from the PublishStatus enum", () => {
    expect(PUBLISH_STATUSES).not.toContain("ready");
    expect(PUBLISH_STATUSES).toContain("publishing");
  });

  it("uses 20 minute post-execution and publishing watchdog deadlines", () => {
    expect(POST_EXECUTION_DEADLINE_MS).toBe(20 * 60 * 1000);
    expect(PUBLISHING_DEADLINE_MS).toBe(20 * 60 * 1000);
  });
});

describe("ARC-876 platform_llm_prompt_status watchdog state", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSql();
    initSchema(sql);
  });

  it("records started_at when entering post_execution_pending and clears it on terminal", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-1",
      sessionId: "s-1",
      status: "post_execution_pending",
      updatedAt: 10_000,
      startedAt: 10_000,
    });
    const armed = getPlatformLlmPromptStatus(sql, "p-1");
    expect(armed?.startedAt).toBe(10_000);

    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-1",
      sessionId: "s-1",
      status: "terminal",
      updatedAt: 11_000,
      startedAt: null,
    });
    const cleared = getPlatformLlmPromptStatus(sql, "p-1");
    expect(cleared?.startedAt).toBeNull();
  });

  it("returns every pending prompt for the alarm scheduler so overlapping prompts each get their own deadline", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-1",
      sessionId: "s-1",
      status: "post_execution_pending",
      updatedAt: 10_000,
      startedAt: 10_000,
    });
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-2",
      sessionId: "s-1",
      status: "post_execution_pending",
      updatedAt: 20_000,
      startedAt: 20_000,
    });
    // Non-pending rows must not be returned, otherwise the alarm scheduler
    // would arm a deadline for a slot that has already cleared.
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-3",
      sessionId: "s-1",
      status: "terminal",
      updatedAt: 30_000,
      startedAt: null,
    });

    const pending = getPlatformLlmPromptStatusesPending(sql, "s-1");
    const ids = pending.map((r) => r.promptId).sort();
    expect(ids).toEqual(["p-1", "p-2"]);
    const lookup = new Map(pending.map((r) => [r.promptId, r.startedAt]));
    expect(lookup.get("p-1")).toBe(10_000);
    expect(lookup.get("p-2")).toBe(20_000);
  });

  it("scopes pending rows to the requesting session", () => {
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-1",
      sessionId: "s-1",
      status: "post_execution_pending",
      updatedAt: 10_000,
      startedAt: 10_000,
    });
    upsertPlatformLlmPromptStatus(sql, {
      promptId: "p-2",
      sessionId: "s-2",
      status: "post_execution_pending",
      updatedAt: 10_000,
      startedAt: 10_000,
    });

    expect(getPlatformLlmPromptStatusesPending(sql, "s-1").map((r) => r.promptId)).toEqual(["p-1"]);
    expect(getPlatformLlmPromptStatusesPending(sql, "s-2").map((r) => r.promptId)).toEqual(["p-2"]);
  });
});

describe("ARC-876 prompt push outcome persistence", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSql();
    initSchema(sql);
    // Minimal prompt row; the push-outcome update touches columns added by
    // migrations 55 and 56 and does not depend on the other prompt columns.
    sql.exec(
      `INSERT INTO prompts (
        prompt_id, session_id, prompt_text, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      "p-1",
      "s-1",
      "do the thing",
      "completed",
      1_000,
      1_000,
    );
  });

  it("persists succeeded/failed/unknown outcomes that the publish gate can read back", () => {
    updatePromptPushOutcome(sql, "p-1", { pushStatus: "succeeded", pushError: null });
    expect(getPromptPushOutcome(sql, "p-1")).toEqual({ pushStatus: "succeeded", pushError: null });

    updatePromptPushOutcome(sql, "p-1", { pushStatus: "failed", pushError: "git push exit 1" });
    expect(getPromptPushOutcome(sql, "p-1")).toEqual({ pushStatus: "failed", pushError: "git push exit 1" });

    updatePromptPushOutcome(sql, "p-1", { pushStatus: "unknown", pushError: null });
    expect(getPromptPushOutcome(sql, "p-1")).toEqual({ pushStatus: "unknown", pushError: null });
  });

  it("returns null for prompts without a recorded outcome (old prompts, in-flight bridges)", () => {
    expect(getPromptPushOutcome(sql, "p-1")).toBeNull();
    expect(getPromptPushOutcome(sql, "missing")).toBeNull();
  });
});

describe("ARC-876 isPromptPublishable", () => {
  let sql: SqlStorage;

  beforeEach(() => {
    sql = createMockSql();
    initSchema(sql);
    const now = Date.now();
    // Seed two prompts in queue_position order. isPromptPublishable walks
    // the queue from the most recent backwards.
    sql.exec(
      `INSERT INTO prompts (prompt_id, session_id, prompt_text, status, created_at, updated_at, queue_position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "p-old",
      "s-1",
      "earlier prompt",
      "completed",
      now - 1_000,
      now - 1_000,
      0,
    );
    sql.exec(
      `INSERT INTO prompts (prompt_id, session_id, prompt_text, status, created_at, updated_at, queue_position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "p-new",
      "s-1",
      "later prompt",
      "completed",
      now,
      now,
      1,
    );
  });

  it("returns ok=true when the most recent prompt pushed successfully", () => {
    updatePromptPushOutcome(sql, "p-new", { pushStatus: "succeeded", pushError: null });
    expect(isPromptPublishable(sql, "s-1")).toEqual({ ok: true });
  });

  it("blocks publish when the most recent prompt failed to push, with the bridge's error message", () => {
    updatePromptPushOutcome(sql, "p-new", { pushStatus: "failed", pushError: "no upstream" });
    const result = isPromptPublishable(sql, "s-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("no upstream");
    }
  });

  it("blocks publish on unknown push status (old bridge or missing event field)", () => {
    updatePromptPushOutcome(sql, "p-new", { pushStatus: "unknown", pushError: null });
    const result = isPromptPublishable(sql, "s-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/unknown/i);
    }
  });

  it("ignores stale outcomes on earlier prompts when the most recent prompt has a fresh result", () => {
    updatePromptPushOutcome(sql, "p-old", { pushStatus: "failed", pushError: "old failure" });
    updatePromptPushOutcome(sql, "p-new", { pushStatus: "succeeded", pushError: null });
    expect(isPromptPublishable(sql, "s-1")).toEqual({ ok: true });
  });

  it("falls back to ok=true when no prompt has a recorded outcome so the publish flow can fail-closed via verifyRemoteBranch", () => {
    expect(isPromptPublishable(sql, "s-1")).toEqual({ ok: true });
  });

  it("uses one prompt read with push outcomes while preserving branch-specific publish decisions", () => {
    sql.exec(
      `INSERT INTO session (session_id, owner_user_id, status, created_at, updated_at, last_branch)
       VALUES (?, ?, ?, ?, ?, ?)`,
      "s-1",
      "u-1",
      "active",
      1_000,
      1_000,
      "feature",
    );
    sql.exec("UPDATE prompts SET result_json = ? WHERE prompt_id = ?", JSON.stringify({ branch: "feature" }), "p-old");
    sql.exec("UPDATE prompts SET result_json = ? WHERE prompt_id = ?", JSON.stringify({ branch: "other" }), "p-new");
    updatePromptPushOutcome(sql, "p-old", { pushStatus: "failed", pushError: "old branch rejected" });
    updatePromptPushOutcome(sql, "p-new", { pushStatus: "unknown", pushError: null });

    let perPromptOutcomeReads = 0;
    let promptReads = 0;
    const countingSql = {
      ...sql,
      exec(query: string, ...params: unknown[]) {
        const normalized = query.replace(/\s+/g, " ").trim();
        if (normalized === "SELECT push_status, push_error FROM prompts WHERE prompt_id = ?") {
          perPromptOutcomeReads += 1;
        }
        if (
          normalized ===
          "SELECT * FROM prompts WHERE session_id = ? ORDER BY queue_position ASC, created_at ASC, prompt_id ASC"
        ) {
          promptReads += 1;
        }
        return sql.exec(query, ...params);
      },
    } as SqlStorage;

    const result = isPromptPublishable(countingSql, "s-1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("old branch rejected");
    }
    expect(perPromptOutcomeReads).toBe(0);
    expect(promptReads).toBe(1);
  });
});
