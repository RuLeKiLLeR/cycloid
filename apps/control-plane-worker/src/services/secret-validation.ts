import type { Logger } from "../logger";
import type { Env } from "../types";

/**
 * Ingress/security secrets whose absence silently rejects traffic (webhook
 * signature checks, callback auth, token crypto) instead of failing loudly.
 * Broader runtime credentials (GitHub App key, E2B_API_KEY, platform LLM
 * keys) already fail loudly on their own paths and are out of scope.
 */
const CRITICAL_SECRETS = [
  "TOKEN_ENCRYPTION_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "SLACK_SIGNING_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "SANDBOX_CALLBACK_SECRET",
] as const;

type CriticalSecretName = (typeof CRITICAL_SECRETS)[number];

// `todo`, `xxx+`, `test`, and `dummy` are anchored on purpose: as substrings
// they appear in legitimate generated values, so only an exact match is
// treated as a placeholder. The remaining terms are unambiguous anywhere.
const PLACEHOLDER_VALUE_PATTERN = /placeholder|replace[_-]?me|change[_-]?me|fixme|^todo$|^xxx+$|^test$|^dummy$/i;

export interface InvalidSecret {
  name: CriticalSecretName;
  reason: "missing" | "placeholder";
}

/** Returns secret NAMES with an invalid state. Never returns or logs values. */
export function findInvalidCriticalSecrets(env: Env): InvalidSecret[] {
  const invalid: InvalidSecret[] = [];
  for (const name of CRITICAL_SECRETS) {
    const value = env[name];
    if (typeof value !== "string" || value.trim() === "") {
      invalid.push({ name, reason: "missing" });
    } else if (PLACEHOLDER_VALUE_PATTERN.test(value)) {
      invalid.push({ name, reason: "placeholder" });
    }
  }
  return invalid;
}

// Workers have no startup phase, so this runs lazily on the first request
// per isolate. Visibility only: every consumer of these secrets already
// fails closed on its own (e.g. a missing webhook secret rejects all
// deliveries), this just makes that state observable instead of silent.
let checkedThisIsolate = false;

export function warnOnInvalidCriticalSecretsOnce(env: Env, logger: Pick<Logger, "warn">): void {
  if (checkedThisIsolate) return;
  checkedThisIsolate = true;
  const invalid = findInvalidCriticalSecrets(env);
  if (invalid.length === 0) return;
  logger.warn(
    // Field name deliberately avoids "secret"/"token"/"key": the logger's
    // redactor replaces any such field wholesale, which would hide the names.
    { event: "security.invalid_critical_secrets", invalid },
    "Critical ingress secrets are missing or placeholder values; affected surfaces fail closed",
  );
}

export function resetSecretValidationStateForTests(): void {
  checkedThisIsolate = false;
}
