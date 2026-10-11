import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  notifySandboxUndersized,
  type SandboxUndersizedInput,
} from "../../apps/control-plane-worker/src/sandbox/undersize-notify";

const input: SandboxUndersizedInput = {
  sessionId: "sess-1",
  ownerUserId: "42",
  sandboxId: "imbaotn90uq8cfxauo9zh",
  runtimeBackend: "e2b_cloud",
  repoOwner: "acme",
  repoName: "widget",
  businessId: "biz-1",
  oomKills: 2,
  runtimeTemplateId: "arc-default-template-mem4096-cpu2",
  cpuCount: 2,
  memoryMB: 4096,
};

function urlOf(call: unknown[]): string {
  return String(call[0]);
}

describe("notifySandboxUndersized", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts Slack + a Datadog metric when fully configured", async () => {
    await notifySandboxUndersized(
      {
        SLACK_BOT_TOKEN: "tok",
        SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL: "#sandbox-alerts",
        DD_API_KEY: "dd",
        FRONTEND_URL: "https://app.trycycloid.com",
        WORKER_ENV: "qa",
      },
      input,
    );

    const urls = fetchMock.mock.calls.map(urlOf);
    const slackCall = fetchMock.mock.calls.find((c) => urlOf(c).includes("slack.com"));
    expect(slackCall).toBeDefined();
    const slackText = JSON.parse(String((slackCall![1] as RequestInit).body)).text as string;
    expect(slackText).toContain("arc-default-template-mem4096-cpu2");
    expect(slackText).toContain("(2 vCPU / 4096 MB)");
    expect(slackText).toContain(
      "E2B sandbox: <https://e2b.dev/dashboard/cycloid/sandboxes/imbaotn90uq8cfxauo9zh/|imbaotn90uq8cfxauo9zh>",
    );
    expect(slackText).not.toContain("E2B sandbox: `imbaotn90uq8cfxauo9zh`");
    expect(slackText).toContain("User: 42");
    expect(slackText).toContain("<https://app.trycycloid.com/sessions/sess-1|View session>");

    const ddCall = fetchMock.mock.calls.find((c) => urlOf(c).includes("datadoghq.com/api/v2/series"));
    expect(ddCall).toBeDefined();
    const body = JSON.parse(String((ddCall![1] as RequestInit).body));
    expect(body.series[0].metric).toBe("arcanist.sandbox.memory.undersized");
    expect(body.series[0].tags).toContain("reason:oom");
    expect(body.series[0].tags).toContain("repo_owner:acme");
    expect(body.series[0].tags).toContain("business_id:biz-1");
    expect(body.series[0].tags).toContain("template:arc-default-template-mem4096-cpu2");
    expect(body.series[0].tags).toContain("cpu:2");
    expect(body.series[0].tags).toContain("memory_mb:4096");
  });

  it("names the OOM victim and says the tier was exceeded for an already-bumped repo", async () => {
    await notifySandboxUndersized(
      {
        SLACK_BOT_TOKEN: "tok",
        SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL: "#sandbox-alerts",
        DD_API_KEY: "dd",
        FRONTEND_URL: "https://app.trycycloid.com",
        WORKER_ENV: "production",
      },
      {
        ...input,
        runtimeTemplateId: "arc-default-template-mem16384-cpu4",
        cpuCount: 4,
        memoryMB: 16384,
        victimComm: "python3",
        victimPid: 30149,
        victimRssMb: 28,
        specSource: "repo",
      },
    );

    const slackCall = fetchMock.mock.calls.find((c) => urlOf(c).includes("slack.com"));
    const slackText = JSON.parse(String((slackCall![1] as RequestInit).body)).text as string;
    // Victim attribution + tier-exceeded phrasing (not the misleading "add an entry").
    expect(slackText).toContain("Killed `python3` (pid 30149, ~28 MB rss).");
    expect(slackText).toContain("the 16384 MB tier was exceeded");
    expect(slackText).toContain("Raise the repo's `repo-sandbox-specs` tier.");
    expect(slackText).not.toContain("needs a larger");

    const ddCall = fetchMock.mock.calls.find((c) => urlOf(c).includes("datadoghq.com/api/v2/series"));
    const tags = JSON.parse(String((ddCall![1] as RequestInit).body)).series[0].tags as string[];
    expect(tags).toContain("victim_comm:python3");
    expect(tags).toContain("spec_source:repo");
    // High-cardinality numeric RSS must NOT be a tag.
    expect(tags.some((t) => t.startsWith("victim_rss_mb"))).toBe(false);
  });

  it("omits the sandbox line when the runtime id is absent", async () => {
    await notifySandboxUndersized(
      {
        SLACK_BOT_TOKEN: "tok",
        SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL: "#sandbox-alerts",
        FRONTEND_URL: "https://app.trycycloid.com",
        WORKER_ENV: "qa",
      },
      { ...input, sandboxId: null },
    );

    const slackCall = fetchMock.mock.calls.find((c) => urlOf(c).includes("slack.com"));
    const slackText = JSON.parse(String((slackCall![1] as RequestInit).body)).text as string;
    expect(slackText).not.toContain("E2B sandbox:");
  });

  it("uses a plain sandbox id for non-E2B runtimes", async () => {
    await notifySandboxUndersized(
      {
        SLACK_BOT_TOKEN: "tok",
        SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL: "#sandbox-alerts",
        FRONTEND_URL: "https://app.trycycloid.com",
        WORKER_ENV: "qa",
      },
      { ...input, runtimeBackend: "freestyle" },
    );

    const slackCall = fetchMock.mock.calls.find((c) => urlOf(c).includes("slack.com"));
    const slackText = JSON.parse(String((slackCall![1] as RequestInit).body)).text as string;
    expect(slackText).toContain("Sandbox: `imbaotn90uq8cfxauo9zh`");
    expect(slackText).not.toContain("E2B sandbox:");
    expect(slackText).not.toContain("https://e2b.dev/dashboard/");
  });

  it("falls back to count-only copy when no victim was captured (default-tier repo)", async () => {
    await notifySandboxUndersized(
      {
        SLACK_BOT_TOKEN: "tok",
        SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL: "#sandbox-alerts",
        FRONTEND_URL: "https://app.trycycloid.com",
        WORKER_ENV: "qa",
      },
      { ...input, specSource: "default" },
    );
    const slackCall = fetchMock.mock.calls.find((c) => urlOf(c).includes("slack.com"));
    const slackText = JSON.parse(String((slackCall![1] as RequestInit).body)).text as string;
    expect(slackText).not.toContain("Killed `");
    expect(slackText).toContain("was too small");
    expect(slackText).toContain("needs a larger `repo-sandbox-specs` entry.");
  });

  it("skips Slack without token/channel but still emits the metric", async () => {
    const prepare = vi.fn();
    await notifySandboxUndersized(
      {
        DD_API_KEY: "dd",
        FRONTEND_URL: "https://app.trycycloid.com",
        WORKER_ENV: "qa",
        DB: { prepare } as never,
      },
      input,
    );
    const urls = fetchMock.mock.calls.map(urlOf);
    expect(urls.some((u) => u.includes("slack.com"))).toBe(false);
    expect(urls.some((u) => u.includes("datadoghq.com/api/v2/series"))).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("skips the metric without DD_API_KEY but still posts Slack", async () => {
    await notifySandboxUndersized(
      {
        SLACK_BOT_TOKEN: "tok",
        SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL: "#sandbox-alerts",
        FRONTEND_URL: "https://app.trycycloid.com",
        WORKER_ENV: "qa",
      },
      input,
    );
    const urls = fetchMock.mock.calls.map(urlOf);
    expect(urls.some((u) => u.includes("slack.com"))).toBe(true);
    expect(urls.some((u) => u.includes("datadoghq.com/api/v2/series"))).toBe(false);
  });

  it("never throws when Slack and Datadog both fail", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(
      notifySandboxUndersized(
        {
          SLACK_BOT_TOKEN: "tok",
          SANDBOX_UNDERSIZED_NOTIFY_SLACK_CHANNEL: "#sandbox-alerts",
          DD_API_KEY: "dd",
          FRONTEND_URL: "https://app.trycycloid.com",
          WORKER_ENV: "qa",
        },
        input,
      ),
    ).resolves.toBeUndefined();
  });
});
