import { checkDurableObjectRateLimit } from "../services/do-rate-limiter";
import type { Env } from "../types";

const SANDBOX_LAYER_BUILD_REQUEST_RATE_LIMIT_MAX = 6;
const SANDBOX_LAYER_BUILD_REQUEST_RATE_LIMIT_WINDOW_SECONDS = 600;

export async function checkSandboxLayerBuildRequestRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  input: { businessId: string; userId: string | number; repoOwner: string; repoName: string },
): Promise<boolean> {
  const key = [
    "sandbox_layer_build_request",
    "rl",
    input.businessId,
    String(input.userId),
    input.repoOwner.trim().toLowerCase(),
    input.repoName.trim().toLowerCase(),
  ].join(":");
  const { limited } = await checkDurableObjectRateLimit(env, key, {
    max: SANDBOX_LAYER_BUILD_REQUEST_RATE_LIMIT_MAX,
    windowSeconds: SANDBOX_LAYER_BUILD_REQUEST_RATE_LIMIT_WINDOW_SECONDS,
  });
  return !limited;
}
