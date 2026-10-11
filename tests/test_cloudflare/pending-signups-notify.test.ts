import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPostMessage = vi.fn();

vi.mock("../../apps/control-plane-worker/src/slack/notify", () => ({
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}));

describe("pending signup Slack notification", () => {
  beforeEach(() => {
    mockPostMessage.mockReset().mockResolvedValue({ ok: true });
  });

  it("posts a buttonless text-only notification to the hardcoded #cycloid-signups channel", async () => {
    const { notifyCycloidAdminOfPendingSignup } =
      await import("../../apps/control-plane-worker/src/auth/pending-signups-notify");

    await notifyCycloidAdminOfPendingSignup(
      {
        SLACK_BOT_TOKEN: "xoxb-test",
      } as never,
      {
        githubLogin: "new-user",
        githubId: 12345,
        name: "New User",
        email: "new@example.com",
        frontendUrl: "https://app.trycycloid.com",
      },
    );

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const [, channel, text, blocks] = mockPostMessage.mock.calls[0];
    expect(channel).toBe("C0BD5UM1N6A");
    expect(text).toContain("New Cycloid signup pending approval: *new-user* (GitHub ID 12345)");
    expect(text).toContain("Name: New User");
    expect(text).toContain("Email: new@example.com");
    expect(text).toContain("Approve: https://app.trycycloid.com/admin/pending-signups");
    // Text-only: no blocks argument at all.
    expect(blocks).toBeUndefined();
  });

  it("escapes GitHub-controlled fields so channel mentions cannot be injected", async () => {
    const { notifyCycloidAdminOfPendingSignup } =
      await import("../../apps/control-plane-worker/src/auth/pending-signups-notify");

    await notifyCycloidAdminOfPendingSignup(
      {
        SLACK_BOT_TOKEN: "xoxb-test",
      } as never,
      {
        githubLogin: "<!channel>",
        githubId: 12345,
        name: "<@U123>",
        email: "evil<x>@example.com",
        frontendUrl: "https://app.trycycloid.com",
      },
    );

    const [, , text] = mockPostMessage.mock.calls[0];
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("<@U123>");
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&lt;@U123&gt;");
    expect(text).toContain("evil&lt;x&gt;@example.com");
  });

  it("no-ops when SLACK_BOT_TOKEN is unconfigured (e.g. QA)", async () => {
    const { notifyCycloidAdminOfPendingSignup } =
      await import("../../apps/control-plane-worker/src/auth/pending-signups-notify");

    await notifyCycloidAdminOfPendingSignup({} as never, {
      githubLogin: "new-user",
      githubId: 12345,
      name: "New User",
      email: "new@example.com",
      frontendUrl: "https://app.trycycloid.com",
    });

    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
