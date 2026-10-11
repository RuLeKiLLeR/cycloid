import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlanModeSetting } from "../../shared/plan-mode";

// Keep new-user profile defaults covered independently from settings route behavior.

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

// Local type definitions to avoid importing Cloudflare-typed source modules at the type level
type KeyProvider = "openai" | "baseten";

interface UserSettingsRowResult {
  user_id: number;
  default_pr_draft?: number;
  auto_verify_enabled?: number;
  automatic_reviews_enabled?: number;
  plan_mode_setting: PlanModeSetting;
  plan_approval_required?: number | null;
  settings_profile?: "manual" | "autonomous" | "custom" | null;
  use_codex_subscription?: number;
  default_model: string | null;
  default_repo: string | null;
  created_at: number;
  updated_at: number;
}

type SettingsDbModule = {
  getUserSettings: (db: unknown, userId: number) => Promise<UserSettingsRowResult>;
  getUserSettingsIfExists: (db: unknown, userId: number) => Promise<UserSettingsRowResult | null>;
  updateUserSettings: (
    db: unknown,
    userId: number,
    fields: {
      defaultPrDraft?: boolean;
      autoVerifyEnabled?: boolean;
      automaticReviewsEnabled?: boolean;
      planMode?: "off" | "on" | "auto";
      planApprovalRequired?: boolean | null;
      useCodexSubscription?: boolean;
      defaultModel?: string | null;
      defaultRepo?: string | null;
    },
  ) => Promise<UserSettingsRowResult>;
  getSettingsWithKeyStatus: (
    db: unknown,
    userId: number,
  ) => Promise<{
    settings: UserSettingsRowResult;
    apiKeys: Record<
      string,
      {
        isSet: boolean;
        lastValidatedAt: number | null;
        lastValidationStatus: string | null;
        lastValidationReasonCode: string | null;
      }
    >;
  }>;
  getProviderKeyStatus: (db: unknown, userId: number) => Promise<Record<string, boolean>>;
  setProviderApiKey: (
    db: unknown,
    userId: number,
    provider: KeyProvider,
    apiKey: string,
    encryptionKey: string | undefined,
    validationState?: {
      lastValidatedAt: number;
      lastValidationStatus: string;
      lastValidationReasonCode: string | null;
    },
  ) => Promise<void>;
  clearProviderApiKey: (db: unknown, userId: number, provider: KeyProvider) => Promise<void>;
  getUserApiKey: (
    db: unknown,
    userId: string,
    provider: string,
    encryptionKey: string | undefined,
  ) => Promise<{ envVar: string; apiKey: string } | null>;
  UserRowMissingError: new (userId: number) => Error;
};

interface UserRow {
  id: number;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  github_token: string | null;
  updated_at: number;
}

interface IntegrationRow {
  user_id: number;
  integration_id: string;
  api_key: string | null;
  encrypted: number;
  last_validated_at?: number | null;
  last_validation_status?: string | null;
  last_validation_reason_code?: string | null;
}

class FakeD1Statement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeSettingsD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    if (this.query.includes("INSERT INTO user_settings") && this.query.includes("ON CONFLICT")) {
      this.db.lastUserSettingsUpsert = { query: this.query, values };
    }
    return this;
  }

  async run(): Promise<{ success: true }> {
    if (this.query.includes("INSERT INTO user_settings")) {
      // `INSERT ... SELECT id, ?, ... FROM users WHERE id = ?` binds the user
      // id LAST (the SELECT column values come first, the WHERE id binds last).
      const userId = this.boundValues[this.boundValues.length - 1] as number;
      const values = {
        default_pr_draft: this.boundValues[0] as number,
        auto_verify_enabled: this.boundValues[1] as number,
        automatic_reviews_enabled: this.boundValues[2] as number,
        plan_mode_setting: this.boundValues[3] as PlanModeSetting,
        plan_approval_required: this.boundValues[4] as number | null,
        settings_profile: this.boundValues[5] as "manual" | "autonomous" | "custom" | null,
        use_codex_subscription: this.boundValues[6] as number,
        default_model: this.boundValues[7] as string | null,
        default_repo: this.boundValues[8] as string | null,
        created_at: this.boundValues[9] as number,
        updated_at: this.boundValues[10] as number,
      };
      this.db.beforeUserSettingsInsert?.(userId);
      // No `users` row → the SELECT matches nothing → nothing is inserted.
      if (this.db.missingUserIds.has(userId)) {
        return { success: true };
      }
      if (this.query.includes("ON CONFLICT") && this.db.userSettings.has(userId)) {
        return { success: true };
      }
      this.db.userSettings.set(userId, {
        user_id: userId,
        ...values,
      });
      return { success: true };
    }

    if (this.query.includes("UPDATE user_settings SET")) {
      // The last bound value is the userId (WHERE user_id = ?)
      const userId = this.boundValues[this.boundValues.length - 1] as number;
      const existing = this.db.userSettings.get(userId);
      if (!existing) return { success: true };

      // Parse set clauses from the query
      const setClause = this.query.match(/SET (.+?) WHERE/)?.[1] || "";
      const fields = setClause.split(",").map((f) => f.trim().split("=")[0].trim());
      let valueIndex = 0;
      for (const field of fields) {
        if (field === "default_pr_draft") existing.default_pr_draft = this.boundValues[valueIndex] as number;
        else if (field === "auto_verify_enabled") existing.auto_verify_enabled = this.boundValues[valueIndex] as number;
        else if (field === "automatic_reviews_enabled")
          existing.automatic_reviews_enabled = this.boundValues[valueIndex] as number;
        else if (field === "plan_mode_setting")
          existing.plan_mode_setting = this.boundValues[valueIndex] as PlanModeSetting;
        else if (field === "plan_approval_required")
          existing.plan_approval_required = this.boundValues[valueIndex] as number | null;
        else if (field === "settings_profile")
          existing.settings_profile = this.boundValues[valueIndex] as "manual" | "autonomous" | "custom" | null;
        else if (field === "use_codex_subscription")
          existing.use_codex_subscription = this.boundValues[valueIndex] as number;
        else if (field === "default_model") existing.default_model = this.boundValues[valueIndex] as string | null;
        else if (field === "default_repo") existing.default_repo = this.boundValues[valueIndex] as string | null;
        else if (field === "updated_at") existing.updated_at = this.boundValues[valueIndex] as number;
        valueIndex++;
      }
      return { success: true };
    }

    // user_integrations: connectIntegration (INSERT ... ON CONFLICT)
    if (this.query.includes("INSERT INTO user_integrations")) {
      const [
        userId,
        integrationId,
        ,
        ,
        ,
        apiKey,
        ,
        ,
        encrypted,
        lastValidatedAt,
        lastValidationStatus,
        lastValidationReasonCode,
      ] = this.boundValues as [
        number,
        string,
        unknown,
        unknown,
        unknown,
        string | null,
        unknown,
        unknown,
        number,
        number | null,
        string | null,
        string | null,
        number,
        number,
      ];
      const key = `${userId}:${integrationId}`;
      this.db.integrationRows.set(key, {
        user_id: userId,
        integration_id: integrationId,
        api_key: apiKey,
        encrypted,
        last_validated_at: lastValidatedAt,
        last_validation_status: lastValidationStatus,
        last_validation_reason_code: lastValidationReasonCode,
      });
      return { success: true };
    }

    // user_integrations: disconnectIntegration (DELETE)
    if (this.query.includes("DELETE FROM user_integrations")) {
      const [userId, integrationId] = this.boundValues as [number, string];
      this.db.integrationRows.delete(`${userId}:${integrationId}`);
      return { success: true };
    }

    if (this.query.includes("UPDATE users SET")) {
      const userId = this.boundValues[this.boundValues.length - 1] as number;
      const existing = this.db.users.get(userId);
      if (!existing) return { success: true };

      if (this.query.includes("openai_api_key = ?")) {
        existing.openai_api_key = this.boundValues[0] as string | null;
      } else if (this.query.includes("openai_api_key = ?")) {
        existing.openai_api_key = this.boundValues[0] as string | null;
      }
      if (this.query.includes("openai_api_key = NULL")) {
        existing.openai_api_key = null;
      }
      if (this.query.includes("openai_api_key = NULL")) {
        existing.openai_api_key = null;
      }
      return { success: true };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async first<T>(): Promise<T | null> {
    // user_integrations: getUserApiKey
    if (
      this.query.includes("FROM user_integrations") &&
      this.query.includes("api_key") &&
      this.query.includes("integration_id = ?")
    ) {
      const [userId, integrationId] = this.boundValues as [number, string];
      const key = `${userId}:${integrationId}`;
      const row = this.db.integrationRows.get(key);
      if (!row?.api_key) return null;
      return {
        api_key: row.api_key,
        last_validation_status: row.last_validation_status ?? null,
      } as unknown as T;
    }

    // user_integrations: generic first (fallthrough)
    if (this.query.includes("FROM user_integrations")) {
      return null;
    }

    // business_members queries
    if (this.query.includes("FROM business_members")) {
      return null;
    }

    // Upsert: INSERT ... SELECT id, ? ... FROM users WHERE id = ? ON CONFLICT (user_id) DO UPDATE SET ... RETURNING explicit columns
    if (this.query.includes("INSERT INTO user_settings") && this.query.includes("ON CONFLICT")) {
      // The user id binds LAST (WHERE id = ?); the SELECT column values precede it.
      const userId = this.boundValues[this.boundValues.length - 1] as number;
      const [default_pr_draft, auto_verify_enabled, automatic_reviews_enabled] = this.boundValues as [
        number,
        number,
        number,
      ];
      const plan_mode_setting = this.boundValues[3] as PlanModeSetting;
      const plan_approval_required = this.boundValues[4] as number | null;
      const settings_profile = this.boundValues[5] as "manual" | "autonomous" | "custom" | null;
      const use_codex_subscription = this.boundValues[6] as number;
      const default_model = this.boundValues[7] as string | null;
      const default_repo = this.boundValues[8] as string | null;
      const createdAt = this.boundValues[9] as number;
      const updatedAt = this.boundValues[10] as number;

      // No `users` row → the SELECT matches nothing → no insert, no conflict,
      // RETURNING is empty. updateUserSettings maps that to UserRowMissingError.
      if (this.db.missingUserIds.has(userId)) {
        return null;
      }

      const existing = this.db.userSettings.get(userId);

      if (!existing) {
        const newRow: UserSettingsRowResult = {
          user_id: userId,
          default_pr_draft,
          auto_verify_enabled,
          automatic_reviews_enabled,
          plan_mode_setting,
          plan_approval_required,
          settings_profile,
          use_codex_subscription,
          default_model,
          default_repo,
          created_at: createdAt,
          updated_at: updatedAt,
        };
        this.db.userSettings.set(userId, newRow);
        return newRow as unknown as T;
      }

      // Existing row: apply only the columns referenced via excluded.* in the SET clause.
      const setMatch = this.query.match(/DO UPDATE SET (.+?)(?:\s+RETURNING|\s*$)/s);
      const setClause = setMatch?.[1] ?? "";
      const excluded = {
        default_pr_draft,
        auto_verify_enabled,
        automatic_reviews_enabled,
        plan_mode_setting,
        plan_approval_required,
        settings_profile,
        use_codex_subscription,
        default_model,
        default_repo,
        updated_at: updatedAt,
      };

      if (setClause.includes("excluded.default_pr_draft")) existing.default_pr_draft = excluded.default_pr_draft;
      if (setClause.includes("excluded.auto_verify_enabled"))
        existing.auto_verify_enabled = excluded.auto_verify_enabled;
      if (setClause.includes("excluded.automatic_reviews_enabled"))
        existing.automatic_reviews_enabled = excluded.automatic_reviews_enabled;
      if (setClause.includes("excluded.plan_mode_setting")) existing.plan_mode_setting = excluded.plan_mode_setting;
      if (setClause.includes("excluded.plan_approval_required"))
        existing.plan_approval_required = excluded.plan_approval_required;
      if (setClause.includes("excluded.settings_profile")) existing.settings_profile = excluded.settings_profile;
      if (setClause.includes("excluded.use_codex_subscription"))
        existing.use_codex_subscription = excluded.use_codex_subscription;
      if (setClause.includes("excluded.default_model")) existing.default_model = excluded.default_model;
      if (setClause.includes("excluded.default_repo")) existing.default_repo = excluded.default_repo;
      if (setClause.includes("excluded.updated_at")) existing.updated_at = excluded.updated_at;

      return existing as unknown as T;
    }

    if (this.query.includes("FROM user_settings")) {
      const [userId] = this.boundValues as [number];
      return (this.db.userSettings.get(userId) as unknown as T) ?? null;
    }

    if (this.query.includes("openai_api_key") && this.query.includes("FROM users")) {
      const [userId] = this.boundValues as [number];
      const user = this.db.users.get(userId);
      if (!user) return null;
      return { openai_api_key: user.openai_api_key } as unknown as T;
    }

    if (this.query.includes("FROM users")) {
      const [userId] = this.boundValues as [number | string];
      const numId = Number(userId);
      const user = this.db.users.get(numId);
      if (!user) return null;
      return user as unknown as T;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    // user_settings: batch query path
    if (this.query.includes("FROM user_settings")) {
      if (this.query.includes("user_id IN")) {
        const userIds = new Set(this.boundValues as number[]);
        const results = [...this.db.userSettings.values()].filter((row) => userIds.has(row.user_id));
        return { results: results as unknown as Record<string, unknown>[] };
      }
      const [userId] = this.boundValues as [number];
      const row = this.db.userSettings.get(userId);
      return { results: row ? [row as unknown as Record<string, unknown>] : [] };
    }

    // user_integrations: getProviderKeyStatus / getProviderKeyStates
    if (this.query.includes("FROM user_integrations")) {
      const userId = Number(this.boundValues[0]);
      const results: Array<Record<string, unknown>> = [];
      for (const row of this.db.integrationRows.values()) {
        if (row.user_id === userId) {
          results.push({
            integration_id: row.integration_id,
            last_validated_at: row.last_validated_at ?? null,
            last_validation_status: row.last_validation_status ?? null,
            last_validation_reason_code: row.last_validation_reason_code ?? null,
          });
        }
      }
      return { results };
    }

    // business_integrations
    if (this.query.includes("FROM business_integrations")) {
      return { results: [] };
    }

    return { results: [] };
  }
}

class FakeSettingsD1 {
  readonly userSettings = new Map<number, UserSettingsRowResult>();
  readonly users = new Map<number, UserRow>();
  readonly integrationRows = new Map<string, IntegrationRow>();
  // User ids whose `users` row was deleted/renumbered (e.g. by a repair
  // migration). Models the `user_settings -> users` FK: the lazy settings
  // INSERT ... SELECT FROM users WHERE id = ? matches nothing for these.
  readonly missingUserIds = new Set<number>();
  beforeUserSettingsInsert: ((userId: number) => void) | null = null;
  lastUserSettingsUpsert: { query: string; values: unknown[] } | null = null;

  addUser(id: number, overrides: Partial<UserRow> = {}): void {
    this.users.set(id, {
      id,
      openai_api_key: null,
      anthropic_api_key: null,
      github_token: null,
      updated_at: Date.now(),
      ...overrides,
    });
    // Seed corresponding user_integrations rows for any non-null API keys
    if (overrides.openai_api_key) {
      this.integrationRows.set(`${id}:openai`, {
        user_id: id,
        integration_id: "openai",
        api_key: overrides.openai_api_key,
        encrypted: 1,
      });
    }
    if (overrides.anthropic_api_key) {
      this.integrationRows.set(`${id}:anthropic`, {
        user_id: id,
        integration_id: "anthropic",
        api_key: overrides.anthropic_api_key,
        encrypted: 1,
      });
    }
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(
    stmts: FakeD1Statement[],
  ): Promise<Array<{ results: unknown[]; success: boolean; meta: Record<string, unknown> }>> {
    return Promise.all(
      stmts.map(async (s) => {
        const result = await s.all();
        return { results: result.results ?? [], success: true, meta: {} };
      }),
    );
  }
}

let mod: SettingsDbModule;
let fakeDb: FakeSettingsD1;

describe("settings/db", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/settings/db";
    mod = (await import(modulePath)) as unknown as SettingsDbModule;
    fakeDb = new FakeSettingsD1();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getUserSettings", () => {
    it("creates default settings when user has none", async () => {
      const settings = await mod.getUserSettings(fakeDb, 1);
      expect(settings.user_id).toBe(1);
      expect(settings.auto_verify_enabled).toBe(0);
      expect(settings.plan_mode_setting).toBe("off");
      expect(settings.settings_profile).toBe("manual");
      expect(settings.default_model).toBeNull();
      expect(settings.default_repo).toBeNull();
    });

    it("returns existing settings", async () => {
      fakeDb.userSettings.set(1, {
        user_id: 1,
        plan_mode_setting: "off",
        default_model: "gpt-5.4",
        default_repo: "org/repo",
        created_at: 1000,
        updated_at: 2000,
      });
      const settings = await mod.getUserSettings(fakeDb, 1);
      expect(settings.default_model).toBe("gpt-5.4");
      expect(settings.default_repo).toBe("org/repo");
    });

    it("rejects an invalid persisted plan mode on direct read", async () => {
      fakeDb.userSettings.set(1, {
        user_id: 1,
        plan_mode_setting: "sometimes" as PlanModeSetting,
        default_model: null,
        default_repo: null,
        created_at: 1000,
        updated_at: 2000,
      });

      await expect(mod.getUserSettings(fakeDb, 1)).rejects.toThrow(/Invalid plan_mode_setting/);
    });

    it("rejects an invalid persisted settings profile on direct read", async () => {
      fakeDb.userSettings.set(1, {
        user_id: 1,
        plan_mode_setting: "off",
        settings_profile: "unsafe" as "custom",
        default_model: null,
        default_repo: null,
        created_at: 1000,
        updated_at: 2000,
      });

      await expect(mod.getUserSettings(fakeDb, 1)).rejects.toThrow(/Invalid settings_profile/);
    });

    it("returns the row created by a concurrent lazy initializer", async () => {
      fakeDb.beforeUserSettingsInsert = (userId) => {
        fakeDb.beforeUserSettingsInsert = null;
        fakeDb.userSettings.set(userId, {
          user_id: userId,
          plan_mode_setting: "off",
          default_model: "gpt-5.4",
          default_repo: "trycycloid/cycloid",
          created_at: 111,
          updated_at: 222,
        });
      };

      const settings = await mod.getUserSettings(fakeDb, 1);

      expect(settings).toMatchObject({
        user_id: 1,
        default_model: "gpt-5.4",
        default_repo: "trycycloid/cycloid",
        created_at: 111,
        updated_at: 222,
      });
    });

    it("rejects an invalid persisted plan mode after lazy creation", async () => {
      fakeDb.beforeUserSettingsInsert = (userId) => {
        fakeDb.beforeUserSettingsInsert = null;
        fakeDb.userSettings.set(userId, {
          user_id: userId,
          plan_mode_setting: "sometimes" as PlanModeSetting,
          default_model: null,
          default_repo: null,
          created_at: 111,
          updated_at: 222,
        });
      };

      await expect(mod.getUserSettings(fakeDb, 1)).rejects.toThrow(/Invalid plan_mode_setting/);
    });
  });

  describe("getUserSettingsIfExists", () => {
    it("returns null without creating defaults when user has no settings", async () => {
      const settings = await mod.getUserSettingsIfExists(fakeDb, 1);
      expect(settings).toBeNull();
      expect(fakeDb.userSettings.has(1)).toBe(false);
    });

    it("returns existing settings", async () => {
      fakeDb.userSettings.set(1, {
        user_id: 1,
        plan_mode_setting: "off",
        default_model: "gpt-5.4",
        default_repo: "org/repo",
        created_at: 1000,
        updated_at: 2000,
      });

      const settings = await mod.getUserSettingsIfExists(fakeDb, 1);

      expect(settings?.default_model).toBe("gpt-5.4");
    });

    it("rejects an invalid persisted plan mode", async () => {
      fakeDb.userSettings.set(1, {
        user_id: 1,
        plan_mode_setting: "sometimes" as PlanModeSetting,
        default_model: null,
        default_repo: null,
        created_at: 1000,
        updated_at: 2000,
      });

      await expect(mod.getUserSettingsIfExists(fakeDb, 1)).rejects.toThrow(/Invalid plan_mode_setting/);
    });
  });

  describe("updateUserSettings", () => {
    it("updates default-PR-draft off and back on", async () => {
      const on = await mod.updateUserSettings(fakeDb, 1, { defaultPrDraft: true });
      expect(on.default_pr_draft).toBe(1);
      const off = await mod.updateUserSettings(fakeDb, 1, { defaultPrDraft: false });
      expect(off.default_pr_draft).toBe(0);
    });

    it("defaults default-PR-draft to off when a first update omits it", async () => {
      // Opt-in setting: first write that omits it must insert 0, not 1.
      const settings = await mod.updateUserSettings(fakeDb, 8, { defaultModel: "gpt-4" });
      expect(settings.default_pr_draft).toBe(0);
    });

    it("updates auto verification off and back on", async () => {
      const off = await mod.updateUserSettings(fakeDb, 1, { autoVerifyEnabled: false });
      expect(off.auto_verify_enabled).toBe(0);
      const on = await mod.updateUserSettings(fakeDb, 1, { autoVerifyEnabled: true });
      expect(on.auto_verify_enabled).toBe(1);
    });

    it("defaults auto verification to off when a first update omits it", async () => {
      const settings = await mod.updateUserSettings(fakeDb, 9, { defaultModel: "gpt-4" });
      expect(settings.auto_verify_enabled).toBe(0);
    });

    it("updateUserSettings persists automatic_reviews_enabled round-trip", async () => {
      const on = await mod.updateUserSettings(fakeDb, 1, { automaticReviewsEnabled: true });
      expect(on.automatic_reviews_enabled).toBe(1);
      const off = await mod.updateUserSettings(fakeDb, 1, { automaticReviewsEnabled: false });
      expect(off.automatic_reviews_enabled).toBe(0);
    });

    it("defaults automatic_reviews_enabled to off when a first update omits it", async () => {
      const settings = await mod.updateUserSettings(fakeDb, 11, { defaultModel: "gpt-4" });
      expect(settings.automatic_reviews_enabled).toBe(0);
    });

    it("updateUserSettings persists every plan_mode_setting value unchanged", async () => {
      const on = await mod.updateUserSettings(fakeDb, 1, { planMode: "on" });
      expect(on.plan_mode_setting).toBe("on");
      expect(fakeDb.lastUserSettingsUpsert?.query).toContain("plan_mode_setting");
      expect(fakeDb.lastUserSettingsUpsert?.values[3]).toBe("on");
      const auto = await mod.updateUserSettings(fakeDb, 1, { planMode: "auto" });
      expect(auto.plan_mode_setting).toBe("auto");
      const off = await mod.updateUserSettings(fakeDb, 1, { planMode: "off" });
      expect(off.plan_mode_setting).toBe("off");
    });

    it("defaults plan_mode_setting to off when a first update omits it", async () => {
      const settings = await mod.updateUserSettings(fakeDb, 12, { defaultModel: "gpt-4" });
      expect(settings.plan_mode_setting).toBe("off");
    });

    it("rejects an invalid persisted plan mode returned by an update", async () => {
      fakeDb.userSettings.set(1, {
        user_id: 1,
        plan_mode_setting: "sometimes" as PlanModeSetting,
        default_model: null,
        default_repo: null,
        created_at: 1000,
        updated_at: 2000,
      });

      await expect(mod.updateUserSettings(fakeDb, 1, { defaultRepo: "org/repo" })).rejects.toThrow(
        /Invalid plan_mode_setting/,
      );
    });

    // Removed: selfHostedSandboxesOptIn no longer exists in updateUserSettings.

    it("updates default model", async () => {
      const settings = await mod.updateUserSettings(fakeDb, 1, { defaultModel: "gpt-4" });
      expect(settings.default_model).toBe("gpt-4");
    });

    it("sets default model to null", async () => {
      await mod.updateUserSettings(fakeDb, 1, { defaultModel: "gpt-4" });
      const settings = await mod.updateUserSettings(fakeDb, 1, { defaultModel: null });
      expect(settings.default_model).toBeNull();
    });

    it("updates default repo", async () => {
      const settings = await mod.updateUserSettings(fakeDb, 1, { defaultRepo: "org/repo" });
      expect(settings.default_repo).toBe("org/repo");
    });

    it("sets default repo to null", async () => {
      await mod.updateUserSettings(fakeDb, 1, { defaultRepo: "org/repo" });
      const settings = await mod.updateUserSettings(fakeDb, 1, { defaultRepo: null });
      expect(settings.default_repo).toBeNull();
    });

    it("handles no-op update (no fields provided)", async () => {
      const settings = await mod.updateUserSettings(fakeDb, 1, {});
      expect(settings.user_id).toBe(1);
    });

    it("issues exactly one D1 prepare() call (single upsert query)", async () => {
      const prepareSpy = vi.spyOn(fakeDb, "prepare");
      await mod.updateUserSettings(fakeDb, 1, { defaultModel: "gpt-4" });
      expect(prepareSpy).toHaveBeenCalledTimes(1);
      prepareSpy.mockRestore();
    });

    it("issues exactly one prepare() call even for a new user", async () => {
      const prepareSpy = vi.spyOn(fakeDb, "prepare");
      await mod.updateUserSettings(fakeDb, 42, { defaultModel: "gpt-4" });
      expect(prepareSpy).toHaveBeenCalledTimes(1);
      prepareSpy.mockRestore();
    });

    it("creates default settings for new user on update", async () => {
      const settings = await mod.updateUserSettings(fakeDb, 99, { defaultPrDraft: true });
      expect(settings.user_id).toBe(99);
      expect(settings.settings_profile).toBe("manual");
      expect(settings.default_model).toBeNull();
    });

    it("does not overwrite unspecified fields on existing user", async () => {
      fakeDb.userSettings.set(1, {
        user_id: 1,
        plan_mode_setting: "off",
        default_model: "gpt-5.4",
        default_repo: "org/repo",
        created_at: 1000,
        updated_at: 2000,
      });
      const settings = await mod.updateUserSettings(fakeDb, 1, { defaultPrDraft: true });
      expect(settings.default_pr_draft).toBe(1);
      expect(settings.default_model).toBe("gpt-5.4");
      expect(settings.default_repo).toBe("org/repo");
    });
  });

  describe("getSettingsWithKeyStatus", () => {
    it("returns default settings and empty apiKeys for new user", async () => {
      const { settings, apiKeys } = await mod.getSettingsWithKeyStatus(fakeDb, 1);
      expect(settings.user_id).toBe(1);
      expect(settings.auto_verify_enabled).toBe(0);
      expect(apiKeys.openai).toEqual({
        isSet: false,
        lastValidatedAt: null,
        lastValidationStatus: null,
        lastValidationReasonCode: null,
      });
      expect(apiKeys.openai).toEqual({
        isSet: false,
        lastValidatedAt: null,
        lastValidationStatus: null,
        lastValidationReasonCode: null,
      });
    });

    it("returns existing settings and key status in one call", async () => {
      fakeDb.userSettings.set(1, {
        user_id: 1,
        plan_mode_setting: "off",
        default_model: "gpt-5.4",
        default_repo: null,
        created_at: 1000,
        updated_at: 2000,
      });
      fakeDb.integrationRows.set("1:openai", {
        user_id: 1,
        integration_id: "openai",
        api_key: "sk-openai-test",
        encrypted: 1,
      });

      const { settings, apiKeys } = await mod.getSettingsWithKeyStatus(fakeDb, 1);
      expect(settings.default_model).toBe("gpt-5.4");
      expect(apiKeys.openai).toEqual({
        isSet: true,
        lastValidatedAt: null,
        lastValidationStatus: null,
        lastValidationReasonCode: null,
      });
    });

    it("rejects an invalid persisted plan mode from the batch read", async () => {
      fakeDb.userSettings.set(1, {
        user_id: 1,
        plan_mode_setting: "sometimes" as PlanModeSetting,
        default_model: null,
        default_repo: null,
        created_at: 1000,
        updated_at: 2000,
      });

      await expect(mod.getSettingsWithKeyStatus(fakeDb, 1)).rejects.toThrow(/Invalid plan_mode_setting/);
    });

    it("uses a single db.batch() call when settings exist", async () => {
      fakeDb.userSettings.set(1, {
        user_id: 1,
        plan_mode_setting: "off",
        default_model: null,
        default_repo: null,
        created_at: 1000,
        updated_at: 2000,
      });
      const batchSpy = vi.spyOn(fakeDb, "batch");
      const prepareSpy = vi.spyOn(fakeDb, "prepare");

      await mod.getSettingsWithKeyStatus(fakeDb, 1);

      // One batch call (2 statements), no additional prepare calls
      expect(batchSpy).toHaveBeenCalledTimes(1);
      expect(prepareSpy).toHaveBeenCalledTimes(2);
      batchSpy.mockRestore();
      prepareSpy.mockRestore();
    });

    it("returns the row created by a concurrent lazy initializer", async () => {
      fakeDb.beforeUserSettingsInsert = (userId) => {
        fakeDb.beforeUserSettingsInsert = null;
        fakeDb.userSettings.set(userId, {
          user_id: userId,
          plan_mode_setting: "off",
          default_model: "gpt-5.4-mini",
          default_repo: "trycycloid/control-plane",
          created_at: 333,
          updated_at: 444,
        });
      };

      const { settings, apiKeys } = await mod.getSettingsWithKeyStatus(fakeDb, 1);

      expect(settings).toMatchObject({
        user_id: 1,
        default_model: "gpt-5.4-mini",
        default_repo: "trycycloid/control-plane",
        created_at: 333,
        updated_at: 444,
      });
      expect(apiKeys.openai?.isSet).toBe(false);
      expect(apiKeys.openai?.isSet).toBe(false);
    });

    it("rejects an invalid persisted plan mode from the batch lazy initializer", async () => {
      fakeDb.beforeUserSettingsInsert = (userId) => {
        fakeDb.beforeUserSettingsInsert = null;
        fakeDb.userSettings.set(userId, {
          user_id: userId,
          plan_mode_setting: "sometimes" as PlanModeSetting,
          default_model: null,
          default_repo: null,
          created_at: 333,
          updated_at: 444,
        });
      };

      await expect(mod.getSettingsWithKeyStatus(fakeDb, 1)).rejects.toThrow(/Invalid plan_mode_setting/);
    });
  });

  describe("getProviderKeyStatus", () => {
    it("returns false for both when user has no keys", async () => {
      fakeDb.addUser(1);
      const status = await mod.getProviderKeyStatus(fakeDb, 1);
      expect(status.openai).toBe(false);
    });

    it("returns true for set keys", async () => {
      fakeDb.addUser(1, { openai_api_key: "enc:something" });
      const status = await mod.getProviderKeyStatus(fakeDb, 1);
      expect(status.openai).toBe(true);
    });

    it("returns false for both when user not found", async () => {
      const status = await mod.getProviderKeyStatus(fakeDb, 999);
      expect(status.openai).toBe(false);
    });
  });

  describe("setProviderApiKey", () => {
    it("stores encrypted openai key", async () => {
      fakeDb.addUser(1);
      await mod.setProviderApiKey(fakeDb, 1, "openai", "sk-openai-test", "test-encryption-key", {
        lastValidatedAt: 111,
        lastValidationStatus: "validated",
        lastValidationReasonCode: null,
      });
      expect(fakeDb.integrationRows.get("1:openai")?.api_key).toMatch(/^enc:/);
      expect(fakeDb.integrationRows.get("1:openai")?.last_validation_status).toBe("validated");
    });

    it("stores validation reason code alongside encrypted key", async () => {
      fakeDb.addUser(1);
      await mod.setProviderApiKey(fakeDb, 1, "openai", "sk-test", "test-encryption-key", {
        lastValidatedAt: 222,
        lastValidationStatus: "saved_unverified",
        lastValidationReasonCode: "network_validation_skipped",
      });
      expect(fakeDb.integrationRows.get("1:openai")?.api_key).toMatch(/^enc:/);
      expect(fakeDb.integrationRows.get("1:openai")?.last_validation_reason_code).toBe("network_validation_skipped");
    });

    it("throws without an encryption key and does not persist plaintext", async () => {
      fakeDb.addUser(1);
      await expect(
        mod.setProviderApiKey(fakeDb, 1, "openai", "sk-openai-test", undefined, {
          lastValidatedAt: 111,
          lastValidationStatus: "validated",
          lastValidationReasonCode: null,
        }),
      ).rejects.toThrow("TOKEN_ENCRYPTION_KEY is required");
      expect(fakeDb.integrationRows.has("1:openai")).toBe(false);
    });
  });

  describe("clearProviderApiKey", () => {
    it("clears openai key", async () => {
      fakeDb.addUser(1, { openai_api_key: "enc:something" });
      await mod.clearProviderApiKey(fakeDb, 1, "openai");
      expect(fakeDb.integrationRows.has("1:openai")).toBe(false);
    });
  });

  describe("getUserApiKey", () => {
    it("returns null for unknown provider", async () => {
      const result = await mod.getUserApiKey(fakeDb, "1", "unknown", undefined);
      expect(result).toBeNull();
    });

    it("returns null when user has no key", async () => {
      fakeDb.addUser(1);
      const result = await mod.getUserApiKey(fakeDb, "1", "openai", undefined);
      expect(result).toBeNull();
    });

    it("returns decrypted key and env var name", async () => {
      // Without encryption key, the key is stored and returned as plaintext
      fakeDb.addUser(1, { openai_api_key: "sk-openai-test123" });
      const result = await mod.getUserApiKey(fakeDb, "1", "openai", undefined);
      expect(result).not.toBeNull();
      expect(result!.envVar).toBe("OPENAI_API_KEY");
      expect(result!.apiKey).toBe("sk-openai-test123");
    });

    it("returns openai key with correct env var", async () => {
      fakeDb.addUser(1, { openai_api_key: "sk-openai-test" });
      const result = await mod.getUserApiKey(fakeDb, "1", "openai", undefined);
      expect(result).not.toBeNull();
      expect(result!.envVar).toBe("OPENAI_API_KEY");
    });

    it("treats invalid keys as missing", async () => {
      fakeDb.addUser(1, { openai_api_key: "sk-openai-invalid" });
      fakeDb.integrationRows.get("1:openai")!.last_validation_status = "invalid";

      const result = await mod.getUserApiKey(fakeDb, "1", "openai", undefined);

      expect(result).toBeNull();
    });

    it("returns saved_unverified keys", async () => {
      fakeDb.addUser(1, { openai_api_key: "sk-openai-unverified" });
      fakeDb.integrationRows.get("1:openai")!.last_validation_status = "saved_unverified";

      const result = await mod.getUserApiKey(fakeDb, "1", "openai", undefined);

      expect(result).toEqual({ envVar: "OPENAI_API_KEY", apiKey: "sk-openai-unverified" });
    });

    it("returns baseten key with correct env var", async () => {
      fakeDb.addUser(1);
      await mod.setProviderApiKey(fakeDb, 1, "baseten", "segment.segment", "test-encryption-key", {
        lastValidatedAt: 111,
        lastValidationStatus: "validated",
        lastValidationReasonCode: null,
      });

      const result = await mod.getUserApiKey(fakeDb, "1", "baseten", "test-encryption-key");

      expect(result).toEqual({ envVar: "BASETEN_API_KEY", apiKey: "segment.segment" });
    });

    it("returns null and logs without leaking ciphertext when an encrypted key has no encryption key", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      fakeDb.addUser(1, { openai_api_key: "enc:abcdef:abcdef:abcdef" });

      const result = await mod.getUserApiKey(fakeDb, "1", "openai", undefined);

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledOnce();
      const logEntry = JSON.parse(String(warnSpy.mock.calls[0]?.[0]));
      expect(logEntry).toMatchObject({
        action: "encrypted_row.decrypt_failed",
        reason: "encryption_key_missing",
        context: "user:openai",
        field: "api_key",
      });
      expect(JSON.stringify(logEntry)).not.toContain("enc:abcdef:abcdef:abcdef");
    });

    it("returns null and logs without leaking plaintext when encrypted key decryption throws", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      fakeDb.addUser(1, { openai_api_key: "enc:not-valid" });

      const result = await mod.getUserApiKey(fakeDb, "1", "openai", "test-encryption-key");

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledOnce();
      const logEntry = JSON.parse(String(warnSpy.mock.calls[0]?.[0]));
      expect(logEntry).toMatchObject({
        action: "encrypted_row.decrypt_failed",
        reason: "decrypt_threw",
        context: "user:openai",
        fields: ["api_key"],
      });
      expect(String(logEntry.error)).toContain("Malformed encrypted value");
      expect(JSON.stringify(logEntry)).not.toContain("enc:not-valid");
    });

    // Regression guard: hiding the Anthropic field from the customer UI must NOT remove
    // anthropic from the backend USER_API_KEY_PROVIDER_IDS allowlist. If it did, this
    // resolves null and claude_code BYOK silently breaks at spawn.
    it("still resolves anthropic key with correct env var (claude_code BYOK)", async () => {
      fakeDb.addUser(1, { anthropic_api_key: "sk-ant-test" });
      const result = await mod.getUserApiKey(fakeDb, "1", "anthropic", undefined);
      expect(result).not.toBeNull();
      expect(result!.envVar).toBe("ANTHROPIC_API_KEY");
      expect(result!.apiKey).toBe("sk-ant-test");
    });
  });

  describe("fails closed when the users row is missing", () => {
    it("getUserSettings throws UserRowMissingError instead of creating defaults", async () => {
      fakeDb.missingUserIds.add(42);
      await expect(mod.getUserSettings(fakeDb, 42)).rejects.toBeInstanceOf(mod.UserRowMissingError);
      // No settings row was created for the missing user.
      expect(fakeDb.userSettings.has(42)).toBe(false);
    });

    it("getSettingsWithKeyStatus throws UserRowMissingError on lazy init for a missing user", async () => {
      fakeDb.missingUserIds.add(42);
      await expect(mod.getSettingsWithKeyStatus(fakeDb, 42)).rejects.toBeInstanceOf(mod.UserRowMissingError);
      expect(fakeDb.userSettings.has(42)).toBe(false);
    });

    it("updateUserSettings throws UserRowMissingError instead of asserting a row", async () => {
      fakeDb.missingUserIds.add(42);
      await expect(mod.updateUserSettings(fakeDb, 42, { defaultPrDraft: true })).rejects.toBeInstanceOf(
        mod.UserRowMissingError,
      );
      expect(fakeDb.userSettings.has(42)).toBe(false);
    });

    it("updateUserSettings fails closed even when an orphan settings row exists", async () => {
      fakeDb.missingUserIds.add(5);
      fakeDb.userSettings.set(5, {
        user_id: 5,
        plan_mode_setting: "off",
        default_model: "gpt-5.4",
        default_repo: null,
        created_at: 1,
        updated_at: 2,
      });

      await expect(mod.updateUserSettings(fakeDb, 5, { defaultPrDraft: true })).rejects.toBeInstanceOf(
        mod.UserRowMissingError,
      );
      // The orphan row is not modified.
      expect(fakeDb.userSettings.get(5)?.default_model).toBe("gpt-5.4");
    });
  });
});
