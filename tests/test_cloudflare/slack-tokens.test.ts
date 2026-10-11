import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBotTokenForTeam = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  }),
}));

vi.mock("../../apps/control-plane-worker/src/slack/workspaces", () => ({
  getBotTokenForTeam: (...args: unknown[]) => mockGetBotTokenForTeam(...args),
}));

import {
  resolveInstalledSlackBotToken,
  resolveSlackBotTokenForCallback,
} from "../../apps/control-plane-worker/src/slack/tokens";
import type { CallbackContext, Env } from "../../apps/control-plane-worker/src/types";

describe("Slack bot token resolution", () => {
  const env = {
    DB: {} as D1Database,
    TOKEN_ENCRYPTION_KEY: "test-key",
    SLACK_BOT_TOKEN: "xoxb-internal",
  } as Env;

  beforeEach(() => {
    mockGetBotTokenForTeam.mockReset().mockResolvedValue("xoxb-workspace");
    mockLoggerWarn.mockReset();
  });

  it("resolves installed Slack workspace bot tokens by team id", async () => {
    await expect(resolveInstalledSlackBotToken(env, "T_CUSTOMER")).resolves.toBe("xoxb-workspace");
    expect(mockGetBotTokenForTeam).toHaveBeenCalledWith(env.DB, "T_CUSTOMER", "test-key");
  });

  it("fails closed when installed workspace token lookup throws", async () => {
    mockGetBotTokenForTeam.mockRejectedValueOnce(new Error("d1 unavailable"));

    await expect(resolveInstalledSlackBotToken(env, "T_CUSTOMER")).resolves.toBeNull();
    expect(mockGetBotTokenForTeam).toHaveBeenCalledWith(env.DB, "T_CUSTOMER", "test-key");
  });

  it("fails closed when a Slack callback context has an empty persisted team id", async () => {
    await expect(
      resolveSlackBotTokenForCallback(
        env,
        {
          source: "slack",
          channel: "C123",
          threadTs: "1712345678.000100",
          slackTeamId: "",
        },
        { sessionId: "session-empty-team", operation: "notifySlackThread" },
      ),
    ).resolves.toBeNull();
    expect(mockGetBotTokenForTeam).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      {
        action: "slack.callback_context.missing_team_id",
        operation: "notifySlackThread",
        sessionId: "session-empty-team",
        channel: "C123",
        threadTs: "1712345678.000100",
      },
      "Slack callback token resolution skipped: missing team id",
    );
  });

  it("fails closed and logs when a legacy Slack callback context has no persisted team id", async () => {
    await expect(
      resolveSlackBotTokenForCallback(
        env,
        {
          source: "slack",
          channel: "C123",
          threadTs: "1712345678.000100",
        } as CallbackContext,
        { sessionId: "session-legacy", operation: "notifySlackThread" },
      ),
    ).resolves.toBeNull();
    expect(mockGetBotTokenForTeam).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      {
        action: "slack.callback_context.missing_team_id",
        operation: "notifySlackThread",
        sessionId: "session-legacy",
        channel: "C123",
        threadTs: "1712345678.000100",
      },
      "Slack callback token resolution skipped: missing team id",
    );
  });
});
