import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notifySandboxEnospc } from "../../apps/control-plane-worker/src/sandbox/enospc-notify";

function urlOf(call: unknown[]): string {
  return String(call[0]);
}

describe("notifySandboxEnospc", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts the disk.enospc COUNT with low-cardinality tags", async () => {
    await notifySandboxEnospc(
      { DD_API_KEY: "dd", WORKER_ENV: "production" },
      { repoOwner: "openevidence", repoName: "xyla", businessId: "biz-1", source: "push" },
    );

    const ddCall = fetchMock.mock.calls.find((c) => urlOf(c).includes("datadoghq.com/api/v2/series"));
    expect(ddCall).toBeDefined();
    expect(urlOf(ddCall!)).toContain("us5.datadoghq.com");
    const body = JSON.parse(String((ddCall![1] as RequestInit).body));
    expect(body.series[0].metric).toBe("arcanist.sandbox.disk.enospc");
    expect(body.series[0].tags).toEqual(
      expect.arrayContaining(["repo_owner:openevidence", "repo_name:xyla", "business_id:biz-1", "source:push"]),
    );
    // No per-session / per-owner tags (unbounded custom-metric cardinality).
    expect(body.series[0].tags.some((t: string) => t.startsWith("session_id:") || t.startsWith("owner_user_id:"))).toBe(
      false,
    );
  });

  it("no-ops without DD_API_KEY", async () => {
    await notifySandboxEnospc(
      { DD_API_KEY: undefined, WORKER_ENV: "production" },
      {
        repoOwner: "o",
        repoName: "r",
        businessId: null,
        source: null,
      },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
