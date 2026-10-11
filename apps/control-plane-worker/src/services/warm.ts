import type { Env } from "../types";

export const DEFAULT_FRONTEND_URL = "https://app.trycycloid.com";
const WARM_PROBE_KEY = "warm-probe";
const WARM_PROBE_HEADER = "x-cycloid-warm-probe";

type WarmBindingsEnv = Pick<Env, "DB" | "DERIVED_MODELS" | "REPOS_CACHE">;
type WarmFetchEnv = Pick<Env, "ARCANIST_ADMIN_TOKEN" | "CI_AUTOMATION_TOKEN" | "CONTROL_PLANE_URL" | "FRONTEND_URL">;

export async function runWarmProbe(env: WarmBindingsEnv): Promise<void> {
  await Promise.all([
    env.DB.prepare("SELECT 1 AS ok").first(),
    env.REPOS_CACHE.get(WARM_PROBE_KEY),
    env.DERIVED_MODELS.get(WARM_PROBE_KEY),
    import("./bootstrap"),
    import("./repos"),
    import("../auth/db"),
    import("../settings/db"),
  ]);
}

export function getWarmProbeUrl(env: WarmFetchEnv): string {
  const baseUrl = env.CONTROL_PLANE_URL || env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  return new URL("/api/health/warm", baseUrl).toString();
}

export function getWarmProbeBearerToken(env: WarmFetchEnv): string {
  const token = env.CI_AUTOMATION_TOKEN || env.ARCANIST_ADMIN_TOKEN;
  if (!token) {
    throw new Error("Warm probe requires CI_AUTOMATION_TOKEN or ARCANIST_ADMIN_TOKEN");
  }
  return token;
}

export async function warmPublicFetchPath(env: WarmFetchEnv, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(getWarmProbeUrl(env), {
    headers: {
      authorization: `Bearer ${getWarmProbeBearerToken(env)}`,
      "cache-control": "no-store",
      "user-agent": "Cycloid-Control-Plane-Warmer",
    },
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Warm probe failed with status ${response.status}`);
  }

  const responseHeader = response.headers.get(WARM_PROBE_HEADER);
  const payload = (await response.json()) as { ok?: boolean } | null;
  if (responseHeader !== "1" || payload?.ok !== true) {
    throw new Error("Warm probe returned an unexpected success payload");
  }
}
