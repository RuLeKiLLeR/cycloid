import { describe, expect, it, vi } from "vitest";

const mockPostStructuredEventToDd = vi.hoisted(() => vi.fn());

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import {
  assertBusinessCanUseOpencode,
  canBusinessUseOpencode,
  OpencodeAccessDeniedError,
} from "../../apps/control-plane-worker/src/services/opencode-access-gate";
import type { Env } from "../../apps/control-plane-worker/src/types";

describe("opencode access gate", () => {
  it("allows non-opencode backends for any business", () => {
    expect(canBusinessUseOpencode({ agentRuntimeBackend: "codex", businessId: "biz-1" })).toBe(true);
    expect(canBusinessUseOpencode({ agentRuntimeBackend: "claude_code", businessId: null })).toBe(true);
  });

  it("allows opencode for internal Cycloid businesses", () => {
    expect(canBusinessUseOpencode({ agentRuntimeBackend: "opencode", businessId: SEEDED_BUSINESS_IDS.cycloid })).toBe(
      true,
    );
    expect(canBusinessUseOpencode({ agentRuntimeBackend: "opencode", businessId: SEEDED_BUSINESS_IDS.cycloidQa })).toBe(
      true,
    );
  });

  it("denies opencode for non-internal businesses and emits a direct-post event", async () => {
    const env = { WORKER_ENV: "production" } as Env;

    await expect(
      assertBusinessCanUseOpencode(env, {
        agentRuntimeBackend: "opencode",
        businessId: "biz-1",
        sessionId: "session-opencode",
        ownerUserId: "42",
        entrypoint: "api",
      }),
    ).rejects.toBeInstanceOf(OpencodeAccessDeniedError);

    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        event: "session_create.opencode_access_denied",
        backend: "opencode",
        businessId: "biz-1",
        sessionId: "session-opencode",
        ownerUserId: "42",
        entrypoint: "api",
      }),
    );
  });
});
