import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../apps/control-plane-worker/src/services/bootstrap", () => ({}));
vi.mock("../../apps/control-plane-worker/src/services/repos", () => ({}));
vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({}));
vi.mock("../../apps/control-plane-worker/src/settings/db", () => ({}));

import { publicRoutes } from "../../apps/control-plane-worker/src/routes/public";
import type { Env } from "../../apps/control-plane-worker/src/types";

describe("public warm route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("touches warm bindings and disables caching", async () => {
    const route = publicRoutes.find(
      (candidate) => candidate.method === "GET" && candidate.pattern.test("/api/health/warm"),
    );

    expect(route).toBeDefined();

    const first = vi.fn().mockResolvedValue({ ok: 1 });
    const prepare = vi.fn().mockReturnValue({ first });
    const reposGet = vi.fn().mockResolvedValue(null);
    const modelsGet = vi.fn().mockResolvedValue(null);
    const env = {
      DB: { prepare },
      REPOS_CACHE: { get: reposGet },
      DERIVED_MODELS: { get: modelsGet },
    } as unknown as Env;

    const request = new Request("https://example.com/api/health/warm");
    const match = new URL(request.url).pathname.match(route!.pattern);
    const response = await route!.handler(request, env, match!, null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-cycloid-warm-probe")).toBe("1");
    expect(prepare).toHaveBeenCalledWith("SELECT 1 AS ok");
    expect(first).toHaveBeenCalledTimes(1);
    expect(reposGet).toHaveBeenCalledWith("warm-probe");
    expect(modelsGet).toHaveBeenCalledWith("warm-probe");
  });
});
