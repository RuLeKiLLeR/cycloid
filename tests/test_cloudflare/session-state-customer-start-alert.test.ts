import { describe, expect, it, vi } from "vitest";

import { createSessionState } from "../../apps/control-plane-worker/src/session/state";
import { CUSTOMER_SESSION_TRACKING_CHANNEL_ID } from "../../apps/control-plane-worker/src/slack/internal-channels";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { CREDENTIAL_VALIDATION_STATUS } from "../../shared/constants/onboarding";

const mockPostInternalAlert = vi.fn();

vi.mock("../../apps/control-plane-worker/src/slack/internal-alerts", () => ({
  postInternalAlert: (...args: unknown[]) => mockPostInternalAlert(...args),
}));

function makeEnv(fetchMock: ReturnType<typeof vi.fn>): Env {
  return {
    WORKER_ENV: "production",
    FRONTEND_URL: "https://app.trycycloid.com",
    SLACK_BOT_TOKEN: "xoxb-test",
    DB: {
      prepare(query: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async all() {
                if (query.includes("FROM business_integrations")) return { results: [] };
                if (query.includes("FROM user_settings")) {
                  return args[0] === 123 ? { results: [{ use_codex_subscription: 0 }] } : { results: [] };
                }
                if (
                  query.includes("FROM user_integrations") &&
                  query.includes("integration_id = ?") &&
                  args[0] === 123 &&
                  args[1] === "openai"
                ) {
                  return {
                    results: [
                      {
                        api_key: "openai-key",
                        encrypted: 1,
                        last_validation_status: CREDENTIAL_VALIDATION_STATUS.VALIDATED,
                        last_validation_reason_code: null,
                      },
                    ],
                  };
                }
                return { results: [] };
              },
            };
          },
        };
      },
      async batch(statements: Array<{ all: () => Promise<{ results: unknown[] }> }>) {
        return Promise.all(statements.map((statement) => statement.all()));
      },
    },
    SESSION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: fetchMock }),
    },
  } as unknown as Env;
}

describe("createSessionState customer session start alert", () => {
  it("posts a best-effort customer session start alert after initialization succeeds", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            session: {
              sessionId: "session-123",
              ownerUserId: "123",
              businessId: "biz-customer",
              status: "active",
            },
            replay: { sessionId: "session-123", lastEventSequence: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    mockPostInternalAlert.mockResolvedValue({ ok: true, ts: "1.2", channel: CUSTOMER_SESSION_TRACKING_CHANNEL_ID });

    await createSessionState(makeEnv(fetchMock), "session-123", "123", {
      businessId: "biz-customer",
      repoContext: { repoOwner: "acme", repoName: "app" },
      initiationMode: "api",
    });

    expect(mockPostInternalAlert).toHaveBeenCalledWith(
      expect.objectContaining({ WORKER_ENV: "production", SLACK_BOT_TOKEN: "xoxb-test" }),
      CUSTOMER_SESSION_TRACKING_CHANNEL_ID,
      expect.stringContaining("User:       123"),
      undefined,
      expect.objectContaining({
        sessionId: "session-123",
        ownerUserId: "123",
        businessId: "biz-customer",
        repoOwner: "acme",
        repoName: "app",
      }),
    );
  });
});
