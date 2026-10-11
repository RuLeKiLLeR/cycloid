import { describe, expect, it } from "vitest";

import type { Env } from "../../apps/control-plane-worker/src/types";
import {
  generateSandboxPromptCallbackToken,
  resolveSandboxCallbackSecret,
  verifySandboxPromptCallbackAuth,
} from "../../apps/control-plane-worker/src/utils";

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    SANDBOX_CALLBACK_SECRET: "sandbox-secret",
    ...overrides,
  } as Env;
}

function callbackRequest(token: string): Request {
  return new Request("https://worker.test/internal/sandbox/sessions/s-1/prompts/p-1/callback", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("sandbox callback auth", () => {
  it("resolves only configured sandbox callback secrets", () => {
    expect(resolveSandboxCallbackSecret(env())).toBe("sandbox-secret");
    expect(resolveSandboxCallbackSecret(env({ SANDBOX_CALLBACK_SECRET: "CHANGE_ME" }))).toBeNull();
    expect(resolveSandboxCallbackSecret(env({ SANDBOX_CALLBACK_SECRET: "" }))).toBeNull();
  });

  it("accepts prompt callback tokens signed by SANDBOX_CALLBACK_SECRET", async () => {
    const token = await generateSandboxPromptCallbackToken("s-1", "p-1", "sandbox-secret");

    const result = await verifySandboxPromptCallbackAuth(callbackRequest(token), env(), "s-1", "p-1");

    expect(result.ok).toBe(true);
  });

  it("does not accept legacy Modal callback secrets for sandbox callbacks", async () => {
    const token = await generateSandboxPromptCallbackToken("s-1", "p-1", "modal-secret");

    const result = await verifySandboxPromptCallbackAuth(
      callbackRequest(token),
      env({
        SANDBOX_CALLBACK_SECRET: "sandbox-secret",
        MODAL_CALLBACK_SECRET: "modal-secret",
      }),
      "s-1",
      "p-1",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("fails closed when SANDBOX_CALLBACK_SECRET is not configured", async () => {
    const token = await generateSandboxPromptCallbackToken("s-1", "p-1", "modal-secret");

    const result = await verifySandboxPromptCallbackAuth(
      callbackRequest(token),
      env({
        SANDBOX_CALLBACK_SECRET: undefined,
        MODAL_CALLBACK_SECRET: "modal-secret",
      }),
      "s-1",
      "p-1",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
  });
});
