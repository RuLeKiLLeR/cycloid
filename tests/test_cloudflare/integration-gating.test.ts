import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetIntegrationLifecycleSummary = vi.fn();
const mockMapReasonCodeToUserMessage = vi.fn();
const mockMapReasonCodeToBusinessMessage = vi.fn();
const mockWriteIntegrationLifecycleEvent = vi.fn();
const mockRunPreflightProbe = vi.fn();

vi.mock("../../apps/control-plane-worker/src/integrations/lifecycle/service", () => ({
  getIntegrationLifecycleSummary: (...args: unknown[]) => mockGetIntegrationLifecycleSummary(...args),
  mapReasonCodeToUserMessage: (...args: unknown[]) => mockMapReasonCodeToUserMessage(...args),
  mapReasonCodeToBusinessMessage: (...args: unknown[]) => mockMapReasonCodeToBusinessMessage(...args),
  writeIntegrationLifecycleEvent: (...args: unknown[]) => mockWriteIntegrationLifecycleEvent(...args),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/providers/github", () => ({
  GithubProvider: class {
    runPreflightProbe(...args: unknown[]) {
      return mockRunPreflightProbe(...args);
    }
  },
}));

import {
  gateGithubSessionStart,
  getGithubBusinessLifecycleSummary,
} from "../../apps/control-plane-worker/src/services/integration-gating";

describe("integration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns installationId on successful GitHub session start gate", async () => {
    mockRunPreflightProbe.mockResolvedValue({
      ok: true,
      sessionMetadata: { installationId: 12345 },
    });

    const result = await gateGithubSessionStart({ DB: {} as D1Database } as never, {
      userId: "42",
      businessId: "biz-a",
      sessionId: "s-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });

    expect(result).toEqual({ ok: true, installationId: 12345 });
    expect(mockRunPreflightProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "42",
        businessId: "biz-a",
        sessionId: "s-1",
        repoOwner: "trycycloid",
        repoName: "cycloid",
      }),
    );
  });

  it("replaces business lifecycle summaries with a generic business-safe message", async () => {
    mockGetIntegrationLifecycleSummary.mockResolvedValue({
      integrationId: "github",
      stage: "credential_resolved",
      status: "failed",
      reasonCode: "token_missing",
      message: "No GitHub OAuth token is stored for this user.",
      createdAt: 123,
    });
    mockMapReasonCodeToBusinessMessage.mockReturnValue("A member needs to reconnect GitHub before starting a session.");

    const summary = await getGithubBusinessLifecycleSummary({} as D1Database, "biz-1");

    expect(mockGetIntegrationLifecycleSummary).toHaveBeenCalledWith(expect.anything(), {
      integrationId: "github",
      businessId: "biz-1",
    });
    expect(summary).toMatchObject({
      reasonCode: "token_missing",
      message: "A member needs to reconnect GitHub before starting a session.",
    });
  });

  it("leaves passed lifecycle summaries unchanged", async () => {
    mockGetIntegrationLifecycleSummary.mockResolvedValue({
      integrationId: "github",
      stage: "sandbox_token_prepared",
      status: "passed",
      reasonCode: null,
      message: "GitHub session credentials are ready for sandbox startup.",
      createdAt: 456,
    });

    const summary = await getGithubBusinessLifecycleSummary({} as D1Database, "biz-1");

    expect(mockMapReasonCodeToBusinessMessage).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      status: "passed",
      message: "GitHub session credentials are ready for sandbox startup.",
    });
  });
});
