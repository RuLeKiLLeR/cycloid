import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  findInvalidCriticalSecrets,
  resetSecretValidationStateForTests,
  warnOnInvalidCriticalSecretsOnce,
} from "../../apps/control-plane-worker/src/services/secret-validation";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { redactObject } from "../../shared/observability/redact";

const VALID_SECRETS = {
  TOKEN_ENCRYPTION_KEY: "a".repeat(64),
  GITHUB_WEBHOOK_SECRET: "gh-webhook-secret-value",
  SLACK_SIGNING_SECRET: "slack-signing-secret-value",
  LINEAR_WEBHOOK_SECRET: "linear-webhook-secret-value",
  SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret-value",
};

function envWith(overrides: Record<string, string | undefined>): Env {
  return { ...VALID_SECRETS, ...overrides } as unknown as Env;
}

describe("findInvalidCriticalSecrets", () => {
  it("returns empty for fully configured secrets", () => {
    expect(findInvalidCriticalSecrets(envWith({}))).toEqual([]);
  });

  it("flags undefined and empty values as missing", () => {
    expect(findInvalidCriticalSecrets(envWith({ TOKEN_ENCRYPTION_KEY: undefined }))).toEqual([
      { name: "TOKEN_ENCRYPTION_KEY", reason: "missing" },
    ]);
    expect(findInvalidCriticalSecrets(envWith({ GITHUB_WEBHOOK_SECRET: "   " }))).toEqual([
      { name: "GITHUB_WEBHOOK_SECRET", reason: "missing" },
    ]);
  });

  it("flags placeholder values", () => {
    for (const value of [
      "PLACEHOLDER",
      "replace_me",
      "REPLACE-ME",
      "changeme",
      "fixme",
      "todo",
      "xxxx",
      "test",
      "dummy",
    ]) {
      expect(findInvalidCriticalSecrets(envWith({ SLACK_SIGNING_SECRET: value }))).toEqual([
        { name: "SLACK_SIGNING_SECRET", reason: "placeholder" },
      ]);
    }
  });

  it("reports every invalid secret, never values", () => {
    const result = findInvalidCriticalSecrets(
      envWith({ LINEAR_WEBHOOK_SECRET: undefined, SANDBOX_CALLBACK_SECRET: "placeholder-value" }),
    );
    expect(result).toEqual([
      { name: "LINEAR_WEBHOOK_SECRET", reason: "missing" },
      { name: "SANDBOX_CALLBACK_SECRET", reason: "placeholder" },
    ]);
    expect(JSON.stringify(result)).not.toContain("placeholder-value");
  });
});

describe("warnOnInvalidCriticalSecretsOnce", () => {
  beforeEach(() => {
    resetSecretValidationStateForTests();
  });

  it("logs one structured warning per isolate", () => {
    const logger = { warn: vi.fn() };
    const env = envWith({ TOKEN_ENCRYPTION_KEY: undefined });
    warnOnInvalidCriticalSecretsOnce(env, logger);
    warnOnInvalidCriticalSecretsOnce(env, logger);
    warnOnInvalidCriticalSecretsOnce(env, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: "security.invalid_critical_secrets",
        invalid: [{ name: "TOKEN_ENCRYPTION_KEY", reason: "missing" }],
      },
      expect.stringContaining("fail closed"),
    );
  });

  it("warn payload survives logger redaction (field name avoids secret/token/key)", () => {
    const logger = { warn: vi.fn() };
    warnOnInvalidCriticalSecretsOnce(envWith({ TOKEN_ENCRYPTION_KEY: undefined }), logger);
    const payload = logger.warn.mock.calls[0][0] as Record<string, unknown>;
    const redacted = redactObject(payload);
    expect(redacted.invalid).toEqual([{ name: "TOKEN_ENCRYPTION_KEY", reason: "missing" }]);
  });

  it("does not log when all secrets are valid", () => {
    const logger = { warn: vi.fn() };
    warnOnInvalidCriticalSecretsOnce(envWith({}), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
