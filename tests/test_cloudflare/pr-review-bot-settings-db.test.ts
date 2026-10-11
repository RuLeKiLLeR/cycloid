import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

type ExpectedPrReviewBot =
  | { type: "known"; id: "greptile" | "coderabbit" | "cursor-bugbot" | "chatgpt-codex" | "strix" }
  | { type: "custom"; login: string };

type SettingsDbModule = typeof import("../../apps/control-plane-worker/src/settings/db") & {
  getUserPrReviewBotSettings: (
    db: unknown,
    userId: number,
    owner: string,
    repo: string,
  ) => Promise<{
    expectedBots: ExpectedPrReviewBot[];
    expectedBotsHash: string;
    mergeConflictResolutionEnabled: boolean;
  }>;
  setUserPrReviewBotSettings: (
    db: unknown,
    userId: number,
    owner: string,
    repo: string,
    input: {
      expectedBots: ExpectedPrReviewBot[];
      mergeConflictResolutionEnabled: boolean;
    },
  ) => Promise<{
    expectedBots: ExpectedPrReviewBot[];
    expectedBotsHash: string;
    mergeConflictResolutionEnabled: boolean;
  }>;
  listUserPrReviewBotSettings: (
    db: unknown,
    userId: number,
    options?: { cursor?: string | null; limit?: number },
  ) => Promise<{
    rows: Array<{
      repoOwner: string;
      repoName: string;
      expectedBots: ExpectedPrReviewBot[];
      mergeConflictResolutionEnabled: boolean;
    }>;
    nextCursor: string | null;
  }>;
  getUserPrReviewBotSettingsByUserIds: (
    db: unknown,
    userIds: number[],
    owner: string,
    repo: string,
  ) => Promise<
    Map<
      number,
      {
        expectedBots: ExpectedPrReviewBot[];
        expectedBotsHash: string;
        mergeConflictResolutionEnabled: boolean;
      }
    >
  >;
  computeExpectedPrReviewBotsHash: (expectedBots: ExpectedPrReviewBot[]) => Promise<string>;
};

interface PrReviewBotSettingsRow {
  user_id: number;
  repo_owner: string;
  repo_name: string;
  expected_bots_json: string;
  merge_conflict_resolution_enabled: number;
  created_at: number;
  updated_at: number;
}

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

  async run(): Promise<{ success: true }> {
    if (this.query.includes("INSERT INTO user_pr_review_bot_settings")) {
      const [userId, repoOwner, repoName, expectedBotsJson, mergeConflictResolutionEnabled, createdAt, updatedAt] = this
        .boundValues as [number, string, string, string, number, number, number];
      const key = `${userId}:${repoOwner}/${repoName}`;
      const existing = this.db.rows.get(key);
      this.db.rows.set(key, {
        user_id: userId,
        repo_owner: repoOwner,
        repo_name: repoName,
        expected_bots_json: expectedBotsJson,
        merge_conflict_resolution_enabled: mergeConflictResolutionEnabled,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { success: true };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM user_pr_review_bot_settings")) {
      const [userId, repoOwner, repoName] = this.boundValues as [number, string, string];
      return (this.db.rows.get(`${userId}:${repoOwner}/${repoName}`) as T | undefined) ?? null;
    }
    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (this.query.includes("FROM user_pr_review_bot_settings")) {
      if (this.query.includes("user_id IN")) {
        const [repoOwner, repoName, ...userIds] = this.boundValues as [string, string, ...number[]];
        const userIdSet = new Set(userIds);
        const results = [...this.db.rows.values()].filter(
          (row) => row.repo_owner === repoOwner && row.repo_name === repoName && userIdSet.has(row.user_id),
        );
        return { results: results as unknown as Array<Record<string, unknown>> };
      }

      const userId = this.boundValues[0] as number;
      const hasCursor = this.boundValues.length >= 5;
      const cursorOwner = hasCursor ? (this.boundValues[1] as string) : null;
      const cursorRepo = hasCursor ? (this.boundValues[3] as string) : null;
      const limit = this.boundValues[this.boundValues.length - 1] as number;
      const results = [...this.db.rows.values()]
        .filter((row) => row.user_id === userId)
        .filter((row) => row.expected_bots_json !== "[]" || row.merge_conflict_resolution_enabled !== 1)
        .filter((row) => {
          if (!cursorOwner || !cursorRepo) return true;
          return row.repo_owner > cursorOwner || (row.repo_owner === cursorOwner && row.repo_name > cursorRepo);
        })
        .sort((a, b) => a.repo_owner.localeCompare(b.repo_owner) || a.repo_name.localeCompare(b.repo_name))
        .slice(0, limit);
      return { results: results as unknown as Array<Record<string, unknown>> };
    }
    throw new Error(`Unhandled all query: ${this.query}`);
  }
}

class FakeD1 {
  readonly rows = new Map<string, PrReviewBotSettingsRow>();

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }
}

describe("settings PR review bot DAO", () => {
  let mod: SettingsDbModule;
  let db: FakeD1;

  beforeEach(async () => {
    mod = (await import("../../apps/control-plane-worker/src/settings/db")) as SettingsDbModule;
    db = new FakeD1();
  });

  it("creates, updates, lower-cases repo keys, and persists empty checklists", async () => {
    await mod.setUserPrReviewBotSettings(db, 7, "TryCycloid", "Cycloid", {
      expectedBots: [
        { type: "known", id: "greptile" },
        { type: "custom", login: "Review-Bot" },
      ],
      mergeConflictResolutionEnabled: true,
    });

    expect(db.rows.has("7:trycycloid/cycloid")).toBe(true);
    expect(await mod.getUserPrReviewBotSettings(db, 7, "TRYCYCLOID", "CYCLOID")).toMatchObject({
      expectedBots: [
        { type: "known", id: "greptile" },
        { type: "custom", login: "review-bot" },
      ],
    });

    const emptied = await mod.setUserPrReviewBotSettings(db, 7, "TryCycloid", "Cycloid", {
      expectedBots: [],
      mergeConflictResolutionEnabled: true,
    });
    expect(emptied.expectedBots).toEqual([]);
    expect(db.rows.get("7:trycycloid/cycloid")?.expected_bots_json).toBe("[]");
  });

  it("returns an empty checklist for missing and malformed rows", async () => {
    await expect(mod.getUserPrReviewBotSettings(db, 7, "owner", "repo")).resolves.toMatchObject({
      expectedBots: [],
    });

    db.rows.set("7:owner/repo", {
      user_id: 7,
      repo_owner: "owner",
      repo_name: "repo",
      expected_bots_json: "{not-json",
      merge_conflict_resolution_enabled: 0,
      created_at: 111,
      updated_at: 222,
    });

    await expect(mod.getUserPrReviewBotSettings(db, 7, "owner", "repo")).resolves.toMatchObject({
      expectedBots: [],
    });
  });

  it("batch-fetches PR review bot settings by user id and defaults missing rows", async () => {
    await mod.setUserPrReviewBotSettings(db, 7, "TryCycloid", "Cycloid", {
      expectedBots: [{ type: "known", id: "greptile" }],
      mergeConflictResolutionEnabled: true,
    });
    await mod.setUserPrReviewBotSettings(db, 9, "TryCycloid", "Other", {
      expectedBots: [{ type: "known", id: "coderabbit" }],
      mergeConflictResolutionEnabled: false,
    });
    const prepareSpy = vi.spyOn(db, "prepare");

    const settings = await mod.getUserPrReviewBotSettingsByUserIds(db, [7, 8, 7, 9], "TRYCYCLOID", "CYCLOID");

    expect(settings.get(7)).toMatchObject({
      expectedBots: [{ type: "known", id: "greptile" }],
      mergeConflictResolutionEnabled: true,
    });
    expect(settings.get(8)).toMatchObject({
      expectedBots: [],
      mergeConflictResolutionEnabled: true,
    });
    expect(settings.get(9)).toMatchObject({
      expectedBots: [],
      mergeConflictResolutionEnabled: true,
    });
    expect(prepareSpy).toHaveBeenLastCalledWith(expect.stringContaining("user_id IN (?, ?, ?)"));
    prepareSpy.mockRestore();
  });

  it("chunks batched PR review bot settings reads to stay under D1 bind limits", async () => {
    const prepareSpy = vi.spyOn(db, "prepare");

    const settings = await mod.getUserPrReviewBotSettingsByUserIds(
      db,
      Array.from({ length: 99 }, (_, i) => i + 1),
      "owner",
      "repo",
    );

    expect(settings.size).toBe(99);
    expect(prepareSpy).toHaveBeenCalledTimes(2);
    expect(prepareSpy.mock.calls[0][0]).toContain(`${"?, ".repeat(97)}?`);
    expect(prepareSpy.mock.calls[1][0]).toContain("user_id IN (?)");
    prepareSpy.mockRestore();
  });

  it("computes a stable expected bot hash independent of order and case", async () => {
    const first = await mod.computeExpectedPrReviewBotsHash([
      { type: "custom", login: "Team-Bot" },
      { type: "known", id: "greptile" },
    ]);
    const second = await mod.computeExpectedPrReviewBotsHash([
      { type: "known", id: "greptile" },
      { type: "custom", login: "team-bot" },
    ]);

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("lists non-empty configurations with cursor pagination", async () => {
    const default10 = {
      mergeConflictResolutionEnabled: true,
    };
    await mod.setUserPrReviewBotSettings(db, 7, "b", "repo", {
      expectedBots: [{ type: "known", id: "coderabbit" }],
      ...default10,
    });
    await mod.setUserPrReviewBotSettings(db, 7, "a", "repo", {
      expectedBots: [{ type: "known", id: "greptile" }],
      ...default10,
    });
    // Empty bots + default merge-conflict handling → excluded from the list by the non-default predicate.
    await mod.setUserPrReviewBotSettings(db, 7, "c", "repo", { expectedBots: [], ...default10 });
    await mod.setUserPrReviewBotSettings(db, 8, "d", "repo", {
      expectedBots: [{ type: "known", id: "strix" }],
      ...default10,
    });

    const firstPage = await mod.listUserPrReviewBotSettings(db, 7, { limit: 1 });
    expect(firstPage.rows).toMatchObject([
      { repoOwner: "a", repoName: "repo", expectedBots: [{ type: "known", id: "greptile" }] },
    ]);
    expect(firstPage.nextCursor).toBe("a/repo");

    const secondPage = await mod.listUserPrReviewBotSettings(db, 7, {
      cursor: firstPage.nextCursor,
      limit: 5,
    });
    expect(secondPage.rows).toMatchObject([
      { repoOwner: "b", repoName: "repo", expectedBots: [{ type: "known", id: "coderabbit" }] },
    ]);
    expect(secondPage.nextCursor).toBeNull();
  });
});
