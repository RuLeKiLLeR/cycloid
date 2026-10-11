import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetGithubTokens = vi.fn();
const mockGetValidGithubTokenResult = vi.fn();
const mockProbeGithubRepoAccess = vi.fn();
const mockGetInstallationByOwner = vi.fn();

vi.mock("../../apps/control-plane-worker/src/integrations/db", () => ({
  getGithubTokens: (...args: unknown[]) => mockGetGithubTokens(...args),
}));

vi.mock("../../apps/control-plane-worker/src/auth/db", () => ({
  getValidGithubTokenResult: (...args: unknown[]) => mockGetValidGithubTokenResult(...args),
}));

vi.mock("../../apps/control-plane-worker/src/auth/repo-authorization", () => ({
  probeGithubRepoAccess: (...args: unknown[]) => mockProbeGithubRepoAccess(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/installations-db", () => ({
  getInstallationByOwner: (...args: unknown[]) => mockGetInstallationByOwner(...args),
}));

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { GithubProvider } from "../../apps/control-plane-worker/src/integrations/providers/github";
import {
  INTEGRATION_LIFECYCLE_REASON_CODE,
  INTEGRATION_LIFECYCLE_STAGE,
} from "../../shared/enums/integration-lifecycle";

function makeProvider() {
  return new GithubProvider({
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEY: "test-key",
  });
}

describe("GithubProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGithubTokens.mockResolvedValue({ accessToken: "encrypted" });
    mockGetValidGithubTokenResult.mockResolvedValue({ ok: true, token: "gho_test" });
    mockGetInstallationByOwner.mockResolvedValue({ installation_id: 123, suspended_at: null });
  });

  it("uses control-plane-configured for missing repo context", async () => {
    const provider = makeProvider();

    const result = await provider.runPreflightProbe({
      db: {} as D1Database,
      userId: "42",
      businessId: "biz-1",
      sessionId: "sess-1",
      repoOwner: "",
      repoName: "repo",
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: INTEGRATION_LIFECYCLE_STAGE.CONTROL_PLANE_CONFIGURED,
        reasonCode: "sandbox_token_unprepared",
      },
    });
    expect(mockProbeGithubRepoAccess).not.toHaveBeenCalled();
  });

  it("does not mark provider-probe-passed when the repo probe fails", async () => {
    mockProbeGithubRepoAccess.mockResolvedValue({
      ok: false,
      reason: "provider_api_unavailable",
      message: "GitHub API unavailable",
    });
    const provider = makeProvider();

    const result = await provider.runPreflightProbe({
      db: {} as D1Database,
      userId: "42",
      businessId: "biz-1",
      sessionId: "sess-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: INTEGRATION_LIFECYCLE_STAGE.CREDENTIAL_RESOLVED,
        message: "GitHub API unavailable",
      },
    });
  });

  it("maps transient token refresh failure to provider API unavailable", async () => {
    mockGetValidGithubTokenResult.mockResolvedValue({
      ok: false,
      reason: "token_refresh_unavailable",
      status: 503,
      message: "GitHub token refresh failed with HTTP 503.",
    });
    const provider = makeProvider();

    const result = await provider.runPreflightProbe({
      db: {} as D1Database,
      userId: "42",
      businessId: "biz-1",
      sessionId: "sess-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });

    expect(result).toMatchObject({
      ok: false,
      failure: {
        stage: INTEGRATION_LIFECYCLE_STAGE.CREDENTIAL_RESOLVED,
        reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.PROVIDER_API_UNAVAILABLE,
        message: "GitHub token refresh failed with HTTP 503.",
        details: { httpStatus: 503 },
      },
    });
    expect(mockProbeGithubRepoAccess).not.toHaveBeenCalled();
  });
});
