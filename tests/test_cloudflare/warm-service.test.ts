import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/control-plane-worker/src/services/bootstrap", () => ({}));
vi.mock("../../apps/control-plane-worker/src/services/repos", () => ({}));
vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({}));
vi.mock("../../apps/control-plane-worker/src/settings/db", () => ({}));

import {
  getWarmProbeBearerToken,
  getWarmProbeUrl,
  runWarmProbe,
  warmPublicFetchPath,
} from "../../apps/control-plane-worker/src/services/warm";

describe("warm service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("touches the hot bindings used by browser startup", async () => {
    const first = vi.fn().mockResolvedValue({ ok: 1 });
    const prepare = vi.fn().mockReturnValue({ first });
    const reposGet = vi.fn().mockResolvedValue(null);
    const modelsGet = vi.fn().mockResolvedValue(null);

    await runWarmProbe({
      DB: { prepare },
      REPOS_CACHE: { get: reposGet },
      DERIVED_MODELS: { get: modelsGet },
    } as never);

    expect(prepare).toHaveBeenCalledWith("SELECT 1 AS ok");
    expect(first).toHaveBeenCalledTimes(1);
    expect(reposGet).toHaveBeenCalledWith("warm-probe");
    expect(modelsGet).toHaveBeenCalledWith("warm-probe");
  });

  it("builds the public warm URL from FRONTEND_URL", () => {
    expect(getWarmProbeUrl({ FRONTEND_URL: "https://app.trycycloid.com/settings/general" } as never)).toBe(
      "https://app.trycycloid.com/api/health/warm",
    );
  });

  it("prefers CONTROL_PLANE_URL when it is present", () => {
    expect(
      getWarmProbeUrl({
        CONTROL_PLANE_URL: "https://worker.example.workers.dev",
        FRONTEND_URL: "https://app.trycycloid.com",
      } as never),
    ).toBe("https://worker.example.workers.dev/api/health/warm");
  });

  it("prefers CI automation token over the admin token", () => {
    expect(
      getWarmProbeBearerToken({
        CI_AUTOMATION_TOKEN: "ci-secret",
        ARCANIST_ADMIN_TOKEN: "admin-secret",
      } as never),
    ).toBe("ci-secret");
  });

  it("falls back to the production app URL when FRONTEND_URL is missing", () => {
    expect(getWarmProbeUrl({} as never)).toBe("https://app.trycycloid.com/api/health/warm");
  });

  it("throws when no automation token is configured", () => {
    expect(() => getWarmProbeBearerToken({} as never)).toThrow(
      "Warm probe requires CI_AUTOMATION_TOKEN or ARCANIST_ADMIN_TOKEN",
    );
  });

  it("self-fetches the public warm route without caching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "x-cycloid-warm-probe": "1" },
      }),
    );

    await warmPublicFetchPath(
      {
        CONTROL_PLANE_URL: "https://worker.example.workers.dev/app",
        CI_AUTOMATION_TOKEN: "ci-secret",
      } as never,
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith("https://worker.example.workers.dev/api/health/warm", {
      headers: {
        authorization: "Bearer ci-secret",
        "cache-control": "no-store",
        "user-agent": "Cycloid-Control-Plane-Warmer",
      },
    });
  });

  it("throws when the public warm fetch fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      warmPublicFetchPath(
        {
          CONTROL_PLANE_URL: "https://worker.example.workers.dev",
          CI_AUTOMATION_TOKEN: "ci-secret",
        } as never,
        fetchMock,
      ),
    ).rejects.toThrow("Warm probe failed with status 503");
  });

  it("throws when the response is 200 but is not the warm probe payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html>ok</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(
      warmPublicFetchPath(
        {
          CONTROL_PLANE_URL: "https://worker.example.workers.dev",
          CI_AUTOMATION_TOKEN: "ci-secret",
        } as never,
        fetchMock,
      ),
    ).rejects.toThrow();
  });
});
