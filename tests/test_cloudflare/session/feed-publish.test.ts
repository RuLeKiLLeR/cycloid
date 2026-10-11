import { describe, expect, it, vi } from "vitest";

import { publishListDelta } from "../../../apps/control-plane-worker/src/session/feed-publish";
import type { Env } from "../../../apps/control-plane-worker/src/types";
import type { FeedDelta } from "../../../shared/types/session-feed";

const delta: FeedDelta = {
  type: "session_status",
  sessionId: "s-1",
  ownerUserId: "owner-1",
  repoOwner: "acme",
  repoName: "widgets",
  source: "status",
  phase: "running",
};

function makeEnv() {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  const getMock = vi.fn().mockReturnValue({ fetch: fetchMock });
  const idFromNameMock = vi.fn().mockImplementation((name: string) => `id:${name}`);
  const env = {
    SESSION_FEED: { idFromName: idFromNameMock, get: getMock },
  } as unknown as Env;
  return { env, fetchMock, getMock, idFromNameMock };
}

describe("publishListDelta", () => {
  it("routes to idFromName(businessId) and POSTs the serialized delta", () => {
    const { env, fetchMock, getMock, idFromNameMock } = makeEnv();

    publishListDelta(env, "biz-1", delta);

    expect(idFromNameMock).toHaveBeenCalledWith("biz-1");
    expect(getMock).toHaveBeenCalledWith("id:biz-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://internal/feed/publish");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(delta);
  });

  it("is a no-op when SESSION_FEED is unbound", () => {
    const env = {} as unknown as Env;
    expect(() => publishListDelta(env, "biz-1", delta)).not.toThrow();
  });

  it("is a no-op when businessId is null or undefined", () => {
    const { env, fetchMock } = makeEnv();
    publishListDelta(env, null, delta);
    publishListDelta(env, undefined, delta);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the stub fetch rejects (fire-and-forget)", async () => {
    const { env, fetchMock } = makeEnv();
    fetchMock.mockRejectedValueOnce(new Error("DO unreachable"));
    expect(() => publishListDelta(env, "biz-1", delta)).not.toThrow();
    // Let the swallowing .catch settle so no unhandled rejection escapes.
    await Promise.resolve();
  });

  it("never throws when idFromName itself throws", () => {
    const { env, idFromNameMock } = makeEnv();
    idFromNameMock.mockImplementationOnce(() => {
      throw new Error("bad id");
    });
    expect(() => publishListDelta(env, "biz-1", delta)).not.toThrow();
  });
});
