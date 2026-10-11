import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/control-plane-worker/src/auth/auth-me", () => ({
  resetAuthMeUserCache: () => {},
}));
vi.mock("../../apps/control-plane-worker/src/observability/run-with-sentry-tag", () => ({
  runWithSentryTag: async (_tag: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../../apps/control-plane-worker/src/slack/notify", () => ({
  getUserInfo: vi.fn(async () => ({ id: "U_ALICE", displayName: "Alice", realName: null, name: null })),
}));

import { encrypt } from "../../apps/control-plane-worker/src/settings/encryption.js";
import { confirmSlackLink, resolveSlackLink } from "../../apps/control-plane-worker/src/slack/link-service.js";
import { createSlackLinkToken } from "../../apps/control-plane-worker/src/slack/link-token.js";
import type { Env } from "../../apps/control-plane-worker/src/types.js";
import { OAUTH_CALLBACK_CODES } from "../../shared/constants/onboarding.js";
import { createSlackLinkSchema, SqliteD1 } from "./sqlite-d1-helper";

const SIGNING_KEY = "test-slack-link-signing-key";
const ENCRYPTION_KEY = "test-token-encryption-key";

let sqlite: Database.Database;
let db: D1Database;
let env: Env;

async function seedWorkspace(opts: {
  teamId: string;
  businessId: string | null;
  uninstalledAt?: number;
}): Promise<void> {
  const encrypted = await encrypt("xoxb-bot-token", ENCRYPTION_KEY);
  sqlite
    .prepare(
      `INSERT INTO slack_workspaces (team_id, bot_token_encrypted, bot_user_id, team_name, business_id, team_domain, enterprise_id, installed_by_user_id, installed_at, updated_at, uninstalled_at)
       VALUES (?, ?, 'U_BOT', 'Biz Workspace', ?, NULL, NULL, 1, 1, 1, ?)`,
    )
    .run(opts.teamId, encrypted, opts.businessId, opts.uninstalledAt ?? null);
}

function getLinkExternalId(userId: number): string | null {
  return (
    (
      sqlite
        .prepare("SELECT external_user_id FROM user_integrations WHERE user_id = ? AND integration_id = 'slack'")
        .get(userId) as { external_user_id: string | null } | undefined
    )?.external_user_id ?? null
  );
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  createSlackLinkSchema(sqlite);
  db = new SqliteD1(sqlite) as unknown as D1Database;
  sqlite.prepare("INSERT INTO users (id, login, business_id) VALUES (1, 'alice', 'biz-1')").run();
  env = { DB: db, SLACK_LINK_SIGNING_KEY: SIGNING_KEY, TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY } as unknown as Env;
});

describe("slack/link-service confirmSlackLink", () => {
  it("binds when the workspace business matches the user", async () => {
    await seedWorkspace({ teamId: "T_BIZ", businessId: "biz-1" });
    const token = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_BIZ" }, SIGNING_KEY);

    const code = await confirmSlackLink(env, { token, userId: 1, userBusinessId: "biz-1" });
    expect(code).toBe(OAUTH_CALLBACK_CODES.SLACK_LINK_SUCCESS);
    expect(getLinkExternalId(1)).toBe("U_ALICE");
  });

  it("fails closed when the workspace belongs to another business", async () => {
    await seedWorkspace({ teamId: "T_BIZ", businessId: "biz-2" });
    const token = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_BIZ" }, SIGNING_KEY);

    const code = await confirmSlackLink(env, { token, userId: 1, userBusinessId: "biz-1" });
    expect(code).toBe(OAUTH_CALLBACK_CODES.SLACK_LINK_WORKSPACE_MISMATCH);
    expect(getLinkExternalId(1)).toBeNull();
  });

  it("fails closed when the user has no business", async () => {
    await seedWorkspace({ teamId: "T_BIZ", businessId: "biz-1" });
    const token = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_BIZ" }, SIGNING_KEY);

    const code = await confirmSlackLink(env, { token, userId: 1, userBusinessId: null });
    expect(code).toBe(OAUTH_CALLBACK_CODES.SLACK_LINK_WORKSPACE_MISMATCH);
  });

  it("fails closed when the workspace is uninstalled", async () => {
    await seedWorkspace({ teamId: "T_BIZ", businessId: "biz-1", uninstalledAt: 999 });
    const token = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_BIZ" }, SIGNING_KEY);

    const code = await confirmSlackLink(env, { token, userId: 1, userBusinessId: "biz-1" });
    expect(code).toBe(OAUTH_CALLBACK_CODES.SLACK_LINK_WORKSPACE_MISMATCH);
  });

  it("fails closed when the workspace is not installed at all", async () => {
    const token = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_UNKNOWN" }, SIGNING_KEY);
    const code = await confirmSlackLink(env, { token, userId: 1, userBusinessId: "biz-1" });
    expect(code).toBe(OAUTH_CALLBACK_CODES.SLACK_LINK_WORKSPACE_MISMATCH);
  });

  it("rejects an invalid token", async () => {
    const code = await confirmSlackLink(env, { token: "garbage.token", userId: 1, userBusinessId: "biz-1" });
    expect(code).toBe(OAUTH_CALLBACK_CODES.SLACK_LINK_INVALID);
  });

  it("is idempotent on a double-submit of the same token (the ticket repro)", async () => {
    await seedWorkspace({ teamId: "T_BIZ", businessId: "biz-1" });
    const token = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_BIZ" }, SIGNING_KEY);

    const first = await confirmSlackLink(env, { token, userId: 1, userBusinessId: "biz-1" });
    expect(first).toBe(OAUTH_CALLBACK_CODES.SLACK_LINK_SUCCESS);
    expect(getLinkExternalId(1)).toBe("U_ALICE");

    // Second POST of the double-submit: same token, same identity. Must land on
    // the success page, not slack_link_already_bound.
    const second = await confirmSlackLink(env, { token, userId: 1, userBusinessId: "biz-1" });
    expect(second).toBe(OAUTH_CALLBACK_CODES.SLACK_LINK_SUCCESS);
    expect(getLinkExternalId(1)).toBe("U_ALICE");
  });

  it("returns already-bound when the user is already linked", async () => {
    await seedWorkspace({ teamId: "T_BIZ", businessId: "biz-1" });
    const first = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_BIZ" }, SIGNING_KEY);
    await confirmSlackLink(env, { token: first, userId: 1, userBusinessId: "biz-1" });

    const second = await createSlackLinkToken({ slackUserId: "U_ALICE_2", slackTeamId: "T_BIZ" }, SIGNING_KEY);
    const code = await confirmSlackLink(env, { token: second, userId: 1, userBusinessId: "biz-1" });
    expect(code).toBe(OAUTH_CALLBACK_CODES.SLACK_LINK_ALREADY_BOUND);
  });

  it("rejects a confirm when the signing key is not configured", async () => {
    const token = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_BIZ" }, SIGNING_KEY);
    const unconfigured = { ...env, SLACK_LINK_SIGNING_KEY: undefined } as unknown as Env;
    const code = await confirmSlackLink(unconfigured, { token, userId: 1, userBusinessId: "biz-1" });
    expect(code).toBe(OAUTH_CALLBACK_CODES.SLACK_LINK_INVALID);
  });

  it("resolveSlackLink surfaces the Slack display name for the consent screen", async () => {
    await seedWorkspace({ teamId: "T_BIZ", businessId: "biz-1" });
    const token = await createSlackLinkToken({ slackUserId: "U_ALICE", slackTeamId: "T_BIZ" }, SIGNING_KEY);
    const resolution = await resolveSlackLink(env, token, "biz-1");
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.context.slackDisplayName).toBe("Alice");
      expect(resolution.context.workspaceName).toBe("Biz Workspace");
    }
  });
});
