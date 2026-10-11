import { describe, expect, it, vi } from "vitest";

const { mockProbeGithubRepoAccess } = vi.hoisted(() => ({
  mockProbeGithubRepoAccess: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/auth/repo-authorization", () => ({
  probeGithubRepoAccess: (...args: unknown[]) => mockProbeGithubRepoAccess(...args),
}));

import type {
  IntegrationScope,
  ToggleableIntegrationId,
} from "../../apps/control-plane-worker/src/enums/integrations.js";
import {
  BUSINESS_ONLY_SET,
  TOGGLEABLE_INTEGRATION_IDS,
} from "../../apps/control-plane-worker/src/enums/integrations.js";
import {
  buildStepsFromSnapshot,
  getOnboardingStatus,
  type GithubRepoAccessResult,
  loadOnboardingSnapshot,
  type OnboardingBuildContext,
  type OnboardingSnapshot,
} from "../../apps/control-plane-worker/src/onboarding/service.js";
import { ONBOARDING_STEP_IDS } from "../../shared/constants/onboarding.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultScopes(): Record<ToggleableIntegrationId, IntegrationScope> {
  const scopes = {} as Record<ToggleableIntegrationId, IntegrationScope>;
  for (const id of TOGGLEABLE_INTEGRATION_IDS) {
    scopes[id] = BUSINESS_ONLY_SET.has(id) ? "disabled" : "user";
  }
  return scopes;
}

function makeSnapshot(overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return {
    businessId: null,
    userIntegrations: new Map(),
    scopes: defaultScopes(),
    businessCredentials: new Map(),
    installations: new Map(),
    ...overrides,
  };
}

function makeContext(overrides: Partial<OnboardingBuildContext> = {}): OnboardingBuildContext {
  return {
    repoOwner: null,
    repoName: null,
    githubAppSetupComplete: false,
    githubRepoAccess: { status: "not_requested" satisfies GithubRepoAccessResult["status"] },
    ...overrides,
  };
}

function findStep(steps: ReturnType<typeof buildStepsFromSnapshot>, id: string) {
  return steps.find((s) => s.id === id)!;
}

function makeDb(
  snapshotOverrides: {
    businessId?: string | null;
    businessScopeRows?: Array<{
      integration_id: string;
      scope: IntegrationScope;
    }>;
    businessCredentialRows?: Array<{
      integration_id: string;
      oauth_access_token: string | null;
      last_validated_at: number | null;
      last_validation_status: string | null;
      last_validation_reason_code: string | null;
    }>;
    userIntegrationRows?: Array<{
      integration_id: string;
      oauth_access_token: string | null;
      oauth_refresh_token: string | null;
      oauth_expires_at: number | null;
      api_key: string | null;
      last_validated_at?: number | null;
      last_validation_status?: string | null;
      last_validation_reason_code?: string | null;
    }>;
    installationRows?: Array<{
      installation_id: number;
      owner_login: string;
      suspended_at: number | null;
    }>;
  } = {},
): D1Database {
  class FakeStatement {
    bind(..._values: unknown[]): FakeStatement {
      return this;
    }
  }

  let batchCount = 0;

  return {
    prepare: () => new FakeStatement(),
    batch: async (statements: unknown[]) => {
      batchCount += 1;
      if (batchCount === 1) {
        return [
          { results: snapshotOverrides.businessId ? [{ business_id: snapshotOverrides.businessId }] : [] },
          { results: snapshotOverrides.userIntegrationRows ?? [] },
        ];
      }

      const businessId = snapshotOverrides.businessId ?? null;
      const results: Array<{ results: Array<Record<string, unknown>> }> = [];
      if (businessId) {
        results.push({ results: snapshotOverrides.businessScopeRows ?? [] });
        results.push({ results: snapshotOverrides.businessCredentialRows ?? [] });
      }
      if (statements.length > results.length) {
        results.push({ results: snapshotOverrides.installationRows ?? [] });
      }
      return results;
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildStepsFromSnapshot", () => {
  it("returns all onboarding step IDs", () => {
    const steps = buildStepsFromSnapshot(makeSnapshot(), makeContext());
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual([...ONBOARDING_STEP_IDS]);
  });

  // -------------------------------------------------------------------------
  // GitHub login
  // -------------------------------------------------------------------------

  describe("github_login", () => {
    it("shows connected when github integration row exists", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "github_login");
      expect(step.status).toBe("connected");
      expect(step.reasonCode).toBe("github_logged_in");
      expect(step.actionType).toBe("none");
      expect(step.required).toBe(true);
    });

    it("shows not_connected when no github integration row", () => {
      const step = findStep(buildStepsFromSnapshot(makeSnapshot(), makeContext()), "github_login");
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_not_logged_in");
      expect(step.actionType).toBe("connect");
    });
  });

  // -------------------------------------------------------------------------
  // GitHub business authorization
  // -------------------------------------------------------------------------

  describe("github_business_authorized", () => {
    it("shows connected when the github user is associated with a business", () => {
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "github_business_authorized");
      expect(step.status).toBe("connected");
      expect(step.reasonCode).toBe("github_business_authorized");
      expect(step.owner).toBe("admin");
    });

    it("shows connect when the user is not logged into github yet", () => {
      const step = findStep(buildStepsFromSnapshot(makeSnapshot(), makeContext()), "github_business_authorized");
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_not_logged_in");
      expect(step.actionType).toBe("connect");
      expect(step.owner).toBe("user");
    });

    it("shows ask_admin when github is connected but no business membership exists", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "github_business_authorized");
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_business_not_authorized");
      expect(step.actionType).toBe("ask_admin");
      expect(step.owner).toBe("admin");
    });
  });

  // -------------------------------------------------------------------------
  // GitHub App installed
  // -------------------------------------------------------------------------

  describe("github_app_installed", () => {
    it("shows connect when github is not logged in", () => {
      const step = findStep(buildStepsFromSnapshot(makeSnapshot(), makeContext()), "github_app_installed");
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_not_logged_in");
      expect(step.actionType).toBe("connect");
    });

    it("shows ask_admin when the github user is not associated with a business", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(
        buildStepsFromSnapshot(snapshot, makeContext({ repoOwner: "acme" })),
        "github_app_installed",
      );
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_business_not_authorized");
      expect(step.actionType).toBe("ask_admin");
      expect(step.owner).toBe("admin");
    });

    it("shows not_connected when no repo owner is provided", () => {
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "github_app_installed");
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_repo_not_selected");
      expect(step.actionType).toBe("none");
      expect(step.required).toBe(true);
    });

    it("shows not_connected when owner has no installation", () => {
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(
        buildStepsFromSnapshot(snapshot, makeContext({ repoOwner: "acme" })),
        "github_app_installed",
      );
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_app_not_installed");
    });

    it("shows pending webhook sync after setup callback when installation row is missing", () => {
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(
        buildStepsFromSnapshot(snapshot, makeContext({ repoOwner: "acme", githubAppSetupComplete: true })),
        "github_app_installed",
      );
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_app_install_pending_webhook_sync");
      expect(step.actionType).toBe("none");
    });

    it("shows connected when installation exists and is not suspended", () => {
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
        installations: new Map([["acme", { installation_id: 123, owner_login: "acme", suspended_at: null }]]),
      });
      const step = findStep(
        buildStepsFromSnapshot(snapshot, makeContext({ repoOwner: "acme" })),
        "github_app_installed",
      );
      expect(step.status).toBe("connected");
      expect(step.reasonCode).toBe("github_app_installed");
      expect(step.actionType).toBe("none");
    });

    it("shows needs_reconnect when installation is suspended", () => {
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
        installations: new Map([["acme", { installation_id: 123, owner_login: "acme", suspended_at: Date.now() }]]),
      });
      const step = findStep(
        buildStepsFromSnapshot(snapshot, makeContext({ repoOwner: "acme" })),
        "github_app_installed",
      );
      expect(step.status).toBe("needs_reconnect");
      expect(step.reasonCode).toBe("github_app_suspended");
      expect(step.actionType).toBe("manage_access");
    });

    it("performs case-insensitive owner lookup", () => {
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
        installations: new Map([["acme", { installation_id: 123, owner_login: "acme", suspended_at: null }]]),
      });
      const step = findStep(
        buildStepsFromSnapshot(snapshot, makeContext({ repoOwner: "ACME" })),
        "github_app_installed",
      );
      expect(step.status).toBe("connected");
    });
  });

  // -------------------------------------------------------------------------
  // GitHub repo access
  // -------------------------------------------------------------------------

  describe("github_repo_access", () => {
    function githubReadySnapshot(): OnboardingSnapshot {
      return makeSnapshot({
        businessId: "biz-1",
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
      });
    }

    it("shows connect when github is not logged in", () => {
      const step = findStep(buildStepsFromSnapshot(makeSnapshot(), makeContext()), "github_repo_access");
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_not_logged_in");
      expect(step.actionType).toBe("connect");
    });

    it("shows ask_admin when github is connected but no business membership exists", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(
        buildStepsFromSnapshot(
          snapshot,
          makeContext({ repoOwner: "acme", repoName: "repo", githubRepoAccess: { status: "denied" } }),
        ),
        "github_repo_access",
      );
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_business_not_authorized");
      expect(step.actionType).toBe("ask_admin");
      expect(step.owner).toBe("admin");
    });

    it("shows not_connected when no repo is selected", () => {
      const step = findStep(buildStepsFromSnapshot(githubReadySnapshot(), makeContext()), "github_repo_access");
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_repo_not_selected");
      expect(step.actionType).toBe("none");
    });

    it("shows connected when repo access is verified", () => {
      const step = findStep(
        buildStepsFromSnapshot(
          githubReadySnapshot(),
          makeContext({ repoOwner: "acme", repoName: "repo", githubRepoAccess: { status: "verified" } }),
        ),
        "github_repo_access",
      );
      expect(step.status).toBe("connected");
      expect(step.reasonCode).toBe("github_repo_access_verified");
    });

    it("shows not_connected when repo access is denied", () => {
      const step = findStep(
        buildStepsFromSnapshot(
          githubReadySnapshot(),
          makeContext({ repoOwner: "acme", repoName: "repo", githubRepoAccess: { status: "denied" } }),
        ),
        "github_repo_access",
      );
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_repo_access_denied");
      expect(step.actionType).toBe("manage_access");
    });

    it("shows lookup_failed when repo access verification fails", () => {
      const step = findStep(
        buildStepsFromSnapshot(
          githubReadySnapshot(),
          makeContext({ repoOwner: "acme", repoName: "repo", githubRepoAccess: { status: "lookup_failed" } }),
        ),
        "github_repo_access",
      );
      expect(step.status).toBe("lookup_failed");
      expect(step.reasonCode).toBe("github_repo_access_check_failed");
      expect(step.actionType).toBe("none");
    });

    it("treats a contradictory not_requested result as repo_not_selected instead of lookup_failed", () => {
      const step = findStep(
        buildStepsFromSnapshot(
          githubReadySnapshot(),
          makeContext({ repoOwner: "acme", repoName: "repo", githubRepoAccess: { status: "not_requested" } }),
        ),
        "github_repo_access",
      );
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("github_repo_not_selected");
      expect(step.actionType).toBe("none");
    });
  });

  describe("getOnboardingStatus", () => {
    it("preserves business credential validation metadata in the snapshot", async () => {
      const db = makeDb({
        businessId: "biz-1",
        businessCredentialRows: [
          {
            integration_id: "openai",
            oauth_access_token: null,
            last_validated_at: 321,
            last_validation_status: "invalid",
            last_validation_reason_code: "credentials_invalid",
          },
        ],
      });

      const snapshot = await loadOnboardingSnapshot(db, 42, null);

      expect(snapshot.businessCredentials.get("openai")).toEqual({
        integration_id: "openai",
        oauth_access_token: null,
        last_validated_at: 321,
        last_validation_status: "invalid",
        last_validation_reason_code: "credentials_invalid",
      });
    });

    it("throws instead of building onboarding status from duplicate owner installations", async () => {
      const db = makeDb({
        installationRows: [
          { installation_id: 1, owner_login: "acme", suspended_at: null },
          { installation_id: 2, owner_login: "acme", suspended_at: null },
        ],
      });

      await expect(loadOnboardingSnapshot(db, 42, "acme")).rejects.toThrow(
        /Multiple GitHub App installations found for owner_login=acme/,
      );
    });

    it("matches repo owner case-insensitively when loading installations", async () => {
      const db = makeDb({
        installationRows: [{ installation_id: 1, owner_login: "Acme", suspended_at: null }],
      });

      const snapshot = await loadOnboardingSnapshot(db, 42, "acme");
      expect(snapshot.installations.get("acme")?.installation_id).toBe(1);
    });

    it("passes reposCacheEnv through to verifyUserRepoAccess", async () => {
      mockProbeGithubRepoAccess.mockReset();
      mockProbeGithubRepoAccess.mockResolvedValue({ ok: true, access: true, source: "github_api" });

      const reposCacheEnv = { REPOS_CACHE: {} as KVNamespace };
      const githubTokenEnv = { GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret" };
      const db = makeDb({
        businessId: "biz-1",
        userIntegrationRows: [
          {
            integration_id: "github",
            oauth_access_token: "tok",
            oauth_refresh_token: null,
            oauth_expires_at: null,
            api_key: null,
          },
        ],
        installationRows: [{ installation_id: 1, owner_login: "acme", suspended_at: null }],
      });

      const steps = await getOnboardingStatus({
        db,
        userId: 42,
        repoOwner: "acme",
        repoName: "repo-one",
        githubTokenEnv,
        reposCacheEnv,
      });

      expect(findStep(steps, "github_repo_access").status).toBe("connected");
      expect(mockProbeGithubRepoAccess).toHaveBeenCalledWith(db, "42", "acme", "repo-one", {
        githubTokenEnv,
        reposCacheEnv,
      });
    });

    it("shows lookup_failed instead of denied when token resolution fails", async () => {
      mockProbeGithubRepoAccess.mockReset();
      mockProbeGithubRepoAccess.mockResolvedValue({
        ok: true,
        access: false,
        reason: "provider_authn_rejected",
        status: 401,
      });

      const githubTokenEnv = { GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret" };
      const db = makeDb({
        businessId: "biz-1",
        userIntegrationRows: [
          {
            integration_id: "github",
            oauth_access_token: "tok",
            oauth_refresh_token: null,
            oauth_expires_at: null,
            api_key: null,
          },
        ],
        installationRows: [{ installation_id: 1, owner_login: "acme", suspended_at: null }],
      });

      const steps = await getOnboardingStatus({
        db,
        userId: 42,
        repoOwner: "acme",
        repoName: "repo-one",
        githubTokenEnv,
      });

      const repoAccess = findStep(steps, "github_repo_access");
      expect(repoAccess.status).toBe("lookup_failed");
      expect(repoAccess.reasonCode).toBe("github_repo_access_check_failed");
    });

    it("shows lookup_failed instead of denied when repo access verification rejects GitHub credentials", async () => {
      mockProbeGithubRepoAccess.mockReset();
      mockProbeGithubRepoAccess.mockResolvedValue({
        ok: true,
        access: false,
        reason: "provider_authn_rejected",
        status: 401,
      });

      const githubTokenEnv = { GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret" };
      const db = makeDb({
        businessId: "biz-1",
        userIntegrationRows: [
          {
            integration_id: "github",
            oauth_access_token: "tok",
            oauth_refresh_token: null,
            oauth_expires_at: null,
            api_key: null,
          },
        ],
        installationRows: [{ installation_id: 1, owner_login: "acme", suspended_at: null }],
      });

      const steps = await getOnboardingStatus({
        db,
        userId: 42,
        repoOwner: "acme",
        repoName: "repo-one",
        githubTokenEnv,
      });

      const repoAccess = findStep(steps, "github_repo_access");
      expect(repoAccess.status).toBe("lookup_failed");
      expect(repoAccess.reasonCode).toBe("github_repo_access_check_failed");
      expect(repoAccess.actionType).toBe("none");
    });

    it("shows denied only for actual repo authorization failures", async () => {
      mockProbeGithubRepoAccess.mockReset();
      mockProbeGithubRepoAccess.mockResolvedValue({
        ok: true,
        access: false,
        reason: "repo_access_denied",
        status: 404,
      });

      const githubTokenEnv = { GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret" };
      const db = makeDb({
        businessId: "biz-1",
        userIntegrationRows: [
          {
            integration_id: "github",
            oauth_access_token: "tok",
            oauth_refresh_token: null,
            oauth_expires_at: null,
            api_key: null,
          },
        ],
        installationRows: [{ installation_id: 1, owner_login: "acme", suspended_at: null }],
      });

      const steps = await getOnboardingStatus({
        db,
        userId: 42,
        repoOwner: "acme",
        repoName: "repo-one",
        githubTokenEnv,
      });

      const repoAccess = findStep(steps, "github_repo_access");
      expect(repoAccess.status).toBe("not_connected");
      expect(repoAccess.reasonCode).toBe("github_repo_access_denied");
      expect(repoAccess.actionType).toBe("manage_access");
    });

    it("shows lookup_failed when the probe reports provider unavailability", async () => {
      mockProbeGithubRepoAccess.mockReset();
      mockProbeGithubRepoAccess.mockResolvedValue({
        ok: false,
        reason: "provider_api_unavailable",
        message: "GitHub API call failed verifying repo access",
      });

      const githubTokenEnv = { GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret" };
      const db = makeDb({
        businessId: "biz-1",
        userIntegrationRows: [
          {
            integration_id: "github",
            oauth_access_token: "tok",
            oauth_refresh_token: null,
            oauth_expires_at: null,
            api_key: null,
          },
        ],
        installationRows: [{ installation_id: 1, owner_login: "acme", suspended_at: null }],
      });

      const steps = await getOnboardingStatus({
        db,
        userId: 42,
        repoOwner: "acme",
        repoName: "repo-one",
        githubTokenEnv,
      });

      const repoAccess = findStep(steps, "github_repo_access");
      expect(repoAccess.status).toBe("lookup_failed");
      expect(repoAccess.reasonCode).toBe("github_repo_access_check_failed");
    });
  });

  // -------------------------------------------------------------------------
  // API key integrations (openai, anthropic)
  // -------------------------------------------------------------------------

  describe("api key integrations", () => {
    it("shows connected when user has an API key", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "openai",
            {
              integration_id: "openai",
              oauth_access_token: null,
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: "sk-xxx",
              last_validated_at: 123,
              last_validation_status: "validated",
              last_validation_reason_code: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "openai_key");
      expect(step.status).toBe("connected");
      expect(step.reasonCode).toBe("credentials_present");
      expect(step.owner).toBe("user");
      expect(step.lastValidationStatus).toBe("validated");
      expect(step.lastValidatedAt).toBe(123);
    });

    it("shows connected with a degraded reason when the key is saved unverified", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "openai",
            {
              integration_id: "openai",
              oauth_access_token: null,
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: "sk-xxx",
              last_validated_at: 456,
              last_validation_status: "saved_unverified",
              last_validation_reason_code: "network_validation_skipped",
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "openai_key");
      expect(step.status).toBe("connected");
      expect(step.reasonCode).toBe("network_validation_skipped");
      expect(step.lastValidationStatus).toBe("saved_unverified");
    });

    it("shows validation_failed when the saved key is marked invalid", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "openai",
            {
              integration_id: "openai",
              oauth_access_token: null,
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: "sk-invalid",
              last_validated_at: 789,
              last_validation_status: "invalid",
              last_validation_reason_code: "credentials_invalid",
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "openai_key");
      expect(step.status).toBe("validation_failed");
      expect(step.reasonCode).toBe("credentials_invalid");
      expect(step.actionType).toBe("connect");
      expect(step.lastValidationStatus).toBe("invalid");
    });

    it("shows not_connected when user has no API key", () => {
      const step = findStep(buildStepsFromSnapshot(makeSnapshot(), makeContext()), "openai_key");
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("credentials_missing");
      expect(step.actionType).toBe("connect");
    });

    it("shows disabled when scope is disabled", () => {
      const scopes = defaultScopes();
      scopes.openai = "disabled";
      const snapshot = makeSnapshot({ scopes });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "openai_key");
      expect(step.status).toBe("disabled");
      expect(step.reasonCode).toBe("integration_disabled");
      expect(step.actionType).toBe("none");
    });

    it("shows business_managed when scope is business and no credentials", () => {
      const scopes = defaultScopes();
      scopes.openai = "business";
      const snapshot = makeSnapshot({ businessId: "biz-1", scopes });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "openai_key");
      expect(step.status).toBe("business_managed");
      expect(step.reasonCode).toBe("business_managed");
      expect(step.actionType).toBe("ask_admin");
      expect(step.owner).toBe("admin");
    });

    it("shows connected when scope is business and credentials exist", () => {
      const scopes = defaultScopes();
      scopes.openai = "business";
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        scopes,
        businessCredentials: new Map([
          [
            "openai",
            {
              integration_id: "openai",
              last_validated_at: null,
              last_validation_status: null,
              last_validation_reason_code: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "openai_key");
      expect(step.status).toBe("connected");
      expect(step.reasonCode).toBe("credentials_present");
      expect(step.owner).toBe("admin");
    });

    it("passes business credential validation metadata through business-scoped key steps", () => {
      const scopes = defaultScopes();
      scopes.openai = "business";
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        scopes,
        businessCredentials: new Map([
          [
            "openai",
            {
              integration_id: "openai",
              last_validated_at: 654,
              last_validation_status: "invalid",
              last_validation_reason_code: "credentials_invalid",
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "openai_key");
      expect(step.status).toBe("connected");
      expect(step.lastValidatedAt).toBe(654);
      expect(step.lastValidationStatus).toBe("invalid");
      expect(step.lastValidationReasonCode).toBe("credentials_invalid");
    });
  });

  // -------------------------------------------------------------------------
  // OAuth integrations
  // -------------------------------------------------------------------------

  describe("oauth integrations", () => {
    it("shows connected when valid oauth token exists", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "linear",
            {
              integration_id: "linear",
              oauth_access_token: "tok",
              oauth_refresh_token: "ref",
              oauth_expires_at: Date.now() + 3600000,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "linear_oauth");
      expect(step.status).toBe("connected");
      expect(step.reasonCode).toBe("oauth_connected");
    });

    it("shows not_connected when no oauth row exists", () => {
      const step = findStep(buildStepsFromSnapshot(makeSnapshot(), makeContext()), "linear_oauth");
      expect(step.status).toBe("not_connected");
      expect(step.reasonCode).toBe("oauth_not_connected");
      expect(step.actionType).toBe("connect");
    });

    it("shows connected when token is expired but has refresh token (auto-refreshed at runtime)", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "linear",
            {
              integration_id: "linear",
              oauth_access_token: "tok",
              oauth_refresh_token: "ref",
              oauth_expires_at: Date.now() - 1000,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "linear_oauth");
      expect(step.status).toBe("connected");
      expect(step.reasonCode).toBe("oauth_connected");
      expect(step.actionType).toBe("none");
    });

    it("shows needs_reconnect with no_refresh_token when expired and no refresh token", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "linear",
            {
              integration_id: "linear",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: Date.now() - 1000,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "linear_oauth");
      expect(step.status).toBe("needs_reconnect");
      expect(step.reasonCode).toBe("oauth_no_refresh_token");
      expect(step.actionType).toBe("reconnect");
    });

    it("shows disabled when scope is disabled", () => {
      const scopes = defaultScopes();
      scopes.linear = "disabled";
      const snapshot = makeSnapshot({ scopes });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "linear_oauth");
      expect(step.status).toBe("disabled");
    });

    it("shows business_managed when scope is business and no credentials", () => {
      const scopes = defaultScopes();
      scopes.linear = "business";
      const snapshot = makeSnapshot({ businessId: "biz-1", scopes });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "linear_oauth");
      expect(step.status).toBe("business_managed");
      expect(step.reasonCode).toBe("business_managed");
      expect(step.actionType).toBe("ask_admin");
      expect(step.owner).toBe("admin");
    });

    it("shows connected when scope is business and credentials exist", () => {
      const scopes = defaultScopes();
      scopes.linear = "business";
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        scopes,
        businessCredentials: new Map([
          [
            "linear",
            {
              integration_id: "linear",
              last_validated_at: null,
              last_validation_status: null,
              last_validation_reason_code: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "linear_oauth");
      expect(step.status).toBe("connected");
      expect(step.reasonCode).toBe("credentials_present");
      expect(step.owner).toBe("admin");
    });

    it("shows connected when token has no expiry set", () => {
      const snapshot = makeSnapshot({
        userIntegrations: new Map([
          [
            "linear",
            {
              integration_id: "linear",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
        ]),
      });
      const step = findStep(buildStepsFromSnapshot(snapshot, makeContext()), "linear_oauth");
      expect(step.status).toBe("connected");
    });
  });

  // -------------------------------------------------------------------------
  // Business-managed integrations
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Step metadata
  // -------------------------------------------------------------------------

  describe("step metadata", () => {
    it("github steps are required", () => {
      const steps = buildStepsFromSnapshot(makeSnapshot(), makeContext());
      expect(findStep(steps, "github_login").required).toBe(true);
      expect(findStep(steps, "github_business_authorized").required).toBe(true);
      expect(findStep(steps, "github_app_installed").required).toBe(true);
      expect(findStep(steps, "github_repo_access").required).toBe(true);
    });

    it("integration steps are not required", () => {
      const steps = buildStepsFromSnapshot(makeSnapshot(), makeContext());
      expect(findStep(steps, "openai_key").required).toBe(false);
      expect(findStep(steps, "linear_oauth").required).toBe(false);
    });

    it("each step has a non-empty title", () => {
      const steps = buildStepsFromSnapshot(makeSnapshot(), makeContext());
      for (const s of steps) {
        expect(s.title.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Full happy path
  // -------------------------------------------------------------------------

  describe("full happy path", () => {
    it("shows all steps connected for a fully configured user", () => {
      const snapshot = makeSnapshot({
        businessId: "biz-1",
        userIntegrations: new Map([
          [
            "github",
            {
              integration_id: "github",
              oauth_access_token: "tok",
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: null,
            },
          ],
          [
            "openai",
            {
              integration_id: "openai",
              oauth_access_token: null,
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: "sk-xxx",
            },
          ],
          [
            "linear",
            {
              integration_id: "linear",
              oauth_access_token: "tok",
              oauth_refresh_token: "ref",
              oauth_expires_at: Date.now() + 3600000,
              api_key: null,
            },
          ],
          [
            "slack",
            {
              integration_id: "slack",
              oauth_access_token: "tok",
              oauth_refresh_token: "ref",
              oauth_expires_at: Date.now() + 3600000,
              api_key: null,
            },
          ],
        ]),
        scopes: defaultScopes(),
        installations: new Map([["acme", { installation_id: 1, owner_login: "acme", suspended_at: null }]]),
      });

      const steps = buildStepsFromSnapshot(
        snapshot,
        makeContext({ repoOwner: "acme", repoName: "repo", githubRepoAccess: { status: "verified" } }),
      );
      for (const s of steps) {
        expect(s.status).toBe("connected");
      }
    });
  });
});
