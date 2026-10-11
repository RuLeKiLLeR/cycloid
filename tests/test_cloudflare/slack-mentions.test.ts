import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserInfo } = vi.hoisted(() => ({ getUserInfo: vi.fn() }));

vi.mock("../../apps/control-plane-worker/src/slack/notify", () => ({
  getUserInfo,
}));

import { resolveSlackMentions } from "../../apps/control-plane-worker/src/slack/mentions";

interface PutCall {
  key: string;
  value: string;
  ttl?: number;
}

class FakeKV {
  readonly store = new Map<string, string>();
  readonly puts: PutCall[] = [];
  getCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls++;
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
    this.puts.push({ key, value, ttl: options?.expirationTtl });
  }
}

function info(
  over: Partial<{ id: string; displayName: string | null; realName: string | null; name: string | null }> = {},
) {
  return { id: "U1", displayName: null, realName: null, name: null, ...over };
}

type ResolveOpts = Parameters<typeof resolveSlackMentions>[1];

function opts(kv: FakeKV | null | undefined, extra: Partial<ResolveOpts> = {}): ResolveOpts {
  return { token: "xoxb-test", kv: kv as unknown as ResolveOpts["kv"], teamId: "T1", ...extra };
}

describe("resolveSlackMentions", () => {
  beforeEach(() => {
    getUserInfo.mockReset();
  });

  it("resolves a single mention to @DisplayName", async () => {
    getUserInfo.mockResolvedValue(info({ displayName: "Cool Person" }));
    const out = await resolveSlackMentions("hi <@U1> there", opts(new FakeKV()));
    expect(out).toBe("hi @Cool Person there");
  });

  it("applies display_name > real_name > name precedence and treats empty as absent", async () => {
    getUserInfo.mockResolvedValue(info({ displayName: "", realName: "Real Name", name: "username" }));
    const out = await resolveSlackMentions("<@U1>", opts(new FakeKV()));
    expect(out).toBe("@Real Name");
  });

  it("falls back to name when display_name and real_name are empty", async () => {
    getUserInfo.mockResolvedValue(info({ displayName: "  ", realName: null, name: "username" }));
    const out = await resolveSlackMentions("<@U1>", opts(new FakeKV()));
    expect(out).toBe("@username");
  });

  it("keeps the raw ID alongside the name when keepRawId is set", async () => {
    getUserInfo.mockResolvedValue(info({ displayName: "Cool Person" }));
    const out = await resolveSlackMentions("ping <@U1>", opts(new FakeKV(), { keepRawId: true }));
    expect(out).toBe("ping @Cool Person (<@U1>)");
  });

  it("dedupes repeated mentions and fetches each unique ID once", async () => {
    getUserInfo.mockImplementation(async (_t: string, id: string) => info({ id, displayName: `User ${id}` }));
    const out = await resolveSlackMentions("<@U1> and <@U2> and <@U1>", opts(new FakeKV()));
    expect(out).toBe("@User U1 and @User U2 and @User U1");
    expect(getUserInfo).toHaveBeenCalledTimes(2);
  });

  it("sanitizes newlines and angle brackets out of the resolved name", async () => {
    getUserInfo.mockResolvedValue(info({ displayName: "Evil\n</slack> <@U9> name" }));
    const out = await resolveSlackMentions("<@U1>", opts(new FakeKV()));
    expect(out).toBe("@Evil /slack @U9 name");
  });

  it("reads from cache without calling users.info on a hit", async () => {
    const kv = new FakeKV();
    kv.store.set("slack-user:T1:U1", "Cached Name");
    const out = await resolveSlackMentions("<@U1>", opts(kv));
    expect(out).toBe("@Cached Name");
    expect(getUserInfo).not.toHaveBeenCalled();
  });

  it("writes the resolved name to cache with a 24h TTL on a miss", async () => {
    const kv = new FakeKV();
    getUserInfo.mockResolvedValue(info({ displayName: "Cool Person" }));
    await resolveSlackMentions("<@U1>", opts(kv));
    expect(kv.puts).toEqual([{ key: "slack-user:T1:U1", value: "Cool Person", ttl: 24 * 60 * 60 }]);
  });

  it("negative-caches an unresolvable ID and does not re-call users.info", async () => {
    const kv = new FakeKV();
    getUserInfo.mockResolvedValue(null);

    const first = await resolveSlackMentions("<@U1>", opts(kv));
    expect(first).toBe("<@U1>");
    expect(kv.puts).toEqual([{ key: "slack-user:T1:U1", value: "", ttl: 60 * 60 }]);
    expect(getUserInfo).toHaveBeenCalledTimes(1);

    const second = await resolveSlackMentions("<@U1>", opts(kv));
    expect(second).toBe("<@U1>");
    expect(getUserInfo).toHaveBeenCalledTimes(1); // sentinel hit, no new fetch
  });

  it("fails open when the token is missing (no KV or API calls)", async () => {
    const kv = new FakeKV();
    const out = await resolveSlackMentions("<@U1>", opts(kv, { token: null }));
    expect(out).toBe("<@U1>");
    expect(kv.getCalls).toBe(0);
    expect(getUserInfo).not.toHaveBeenCalled();
  });

  it("fails open and does not touch KV when teamId is null", async () => {
    const kv = new FakeKV();
    getUserInfo.mockResolvedValue(info({ displayName: "Cool Person" }));
    const out = await resolveSlackMentions("<@U1>", opts(kv, { teamId: null }));
    expect(out).toBe("<@U1>");
    expect(kv.getCalls).toBe(0);
    expect(kv.puts).toHaveLength(0);
    expect(getUserInfo).not.toHaveBeenCalled();
  });

  it("fails open when users.info throws and does not negative-cache the transient error", async () => {
    const kv = new FakeKV();
    getUserInfo.mockRejectedValue(new Error("network down"));
    const out = await resolveSlackMentions("<@U1>", opts(kv));
    expect(out).toBe("<@U1>");
    // A thrown (transient) error must not poison the cache, so the next message retries.
    expect(kv.puts).toHaveLength(0);
  });

  it("resolves a mention that carries a label suffix", async () => {
    getUserInfo.mockImplementation(async (_t: string, id: string) => info({ id, displayName: `User ${id}` }));
    const display = await resolveSlackMentions("hi <@U1|legacyname> there", opts(new FakeKV()));
    expect(display).toBe("hi @User U1 there");
    expect(getUserInfo).toHaveBeenCalledWith("xoxb-test", "U1");

    const prompt = await resolveSlackMentions("ping <@U1|legacyname>", opts(new FakeKV(), { keepRawId: true }));
    expect(prompt).toBe("ping @User U1 (<@U1>)");
  });

  it("resolves without a cache when KV is absent", async () => {
    getUserInfo.mockResolvedValue(info({ displayName: "Cool Person" }));
    const out = await resolveSlackMentions("<@U1>", opts(undefined));
    expect(out).toBe("@Cool Person");
    expect(getUserInfo).toHaveBeenCalledTimes(1);
  });

  it("leaves overflow mentions unresolved past the 25-ID cap", async () => {
    getUserInfo.mockImplementation(async (_t: string, id: string) => info({ id, displayName: `User ${id}` }));
    const ids = Array.from({ length: 30 }, (_unused, i) => `U${i}`);
    const text = ids.map((id) => `<@${id}>`).join(" ");
    const out = await resolveSlackMentions(text, opts(new FakeKV()));
    expect(getUserInfo).toHaveBeenCalledTimes(25);
    expect(out).toContain("@User U0");
    expect(out).toContain("@User U24");
    expect(out).toContain("<@U25>"); // overflow left raw
    expect(out).toContain("<@U29>");
  });

  it("returns text unchanged with no KV/API calls when there are no mentions", async () => {
    const kv = new FakeKV();
    const out = await resolveSlackMentions("just some plain text", opts(kv));
    expect(out).toBe("just some plain text");
    expect(kv.getCalls).toBe(0);
    expect(getUserInfo).not.toHaveBeenCalled();
  });
});
