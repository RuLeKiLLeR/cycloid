import { checkDurableObjectRateLimit } from "../services/do-rate-limiter";
import type { Env } from "../types";

const API_KEY_VALIDATION_RATE_LIMIT_MAX = 10;
const API_KEY_VALIDATION_RATE_LIMIT_WINDOW_SECONDS = 60;
const API_KEY_DELETE_RATE_LIMIT_MAX = 10;
const API_KEY_DELETE_RATE_LIMIT_WINDOW_SECONDS = 60;

export async function checkApiKeyValidationRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  userId: number,
  provider: string,
): Promise<boolean> {
  const { limited } = await checkDurableObjectRateLimit(env, `api_key_validation:rl:${userId}:${provider}`, {
    max: API_KEY_VALIDATION_RATE_LIMIT_MAX,
    windowSeconds: API_KEY_VALIDATION_RATE_LIMIT_WINDOW_SECONDS,
  });
  return !limited;
}

export async function checkApiKeyDeleteRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  userId: number,
  provider: string,
): Promise<boolean> {
  const { limited } = await checkDurableObjectRateLimit(env, `api_key_delete:rl:${userId}:${provider}`, {
    max: API_KEY_DELETE_RATE_LIMIT_MAX,
    windowSeconds: API_KEY_DELETE_RATE_LIMIT_WINDOW_SECONDS,
  });
  return !limited;
}

const PR_REVIEW_BOT_SETTINGS_RATE_LIMIT_MAX = 30;
const PR_REVIEW_BOT_SETTINGS_RATE_LIMIT_WINDOW_SECONDS = 600;

export async function checkPrReviewBotSettingsRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  userId: number,
  repoOwner: string,
  repoName: string,
): Promise<boolean> {
  const { limited } = await checkDurableObjectRateLimit(
    env,
    `pr_review_bots:rl:${userId}:${repoOwner.toLowerCase()}:${repoName.toLowerCase()}`,
    {
      max: PR_REVIEW_BOT_SETTINGS_RATE_LIMIT_MAX,
      windowSeconds: PR_REVIEW_BOT_SETTINGS_RATE_LIMIT_WINDOW_SECONDS,
    },
  );
  return !limited;
}
