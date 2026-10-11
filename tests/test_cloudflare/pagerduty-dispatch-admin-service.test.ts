import { beforeEach, describe, expect, it, vi } from "vitest";

const gateGithubSessionStartMock = vi.fn();
vi.mock("../../apps/control-plane-worker/src/services/integration-gating", () => ({
  gateGithubSessionStart: (...args: unknown[]) => gateGithubSessionStartMock(...args),
}));

import {
  getPagerDutyDispatchInstallationSummary,
  PagerDutyDispatchAdminError,
  savePagerDutyDispatchInstallation,
} from "../../apps/control-plane-worker/src/automation/pagerduty-dispatch-admin-service";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { createControlPlaneD1, seedBusiness, seedUser } from "./helpers/seed-db";

function makeEnv(): Env {
  const { sqlite, d1 } = createControlPlaneD1();
  seedBusiness(sqlite, { id: "biz-1" });
  seedUser(sqlite, { id: 42, businessId: "biz-1" });
  return {
    DB: d1,
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
  } as unknown as Env;
}

describe("pagerduty-dispatch-admin-service", () => {
  beforeEach(() => {
    gateGithubSessionStartMock.mockReset().mockResolvedValue({ ok: true, installationId: 99 });
  });

  it("creates a new dispatch binding and returns the webhook URL", async () => {
    const env = makeEnv();

    const saved = await savePagerDutyDispatchInstallation(env, {
      callerUserId: "42",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "api",
      modelId: "gpt-5.4",
      webhookSigningSecret: "pd-signing-secret",
      publicBaseUrl: "https://app.test",
    });

    expect(saved).toMatchObject({
      status: "active",
      repoOwner: "acme",
      repoName: "api",
      modelId: "gpt-5.4",
      webhookSigningSecretConfigured: true,
    });
    expect(saved.webhookUrl).toMatch(/^https:\/\/app\.test\/api\/webhooks\/pagerduty\//);
  });

  it("preserves the active token on ordinary updates and rotates only when requested", async () => {
    const env = makeEnv();

    const created = await savePagerDutyDispatchInstallation(env, {
      callerUserId: "42",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "api",
      webhookSigningSecret: "pd-signing-secret",
      publicBaseUrl: "https://app.test",
    });
    const updated = await savePagerDutyDispatchInstallation(env, {
      callerUserId: "42",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "worker",
      publicBaseUrl: "https://app.test",
    });
    const rotated = await savePagerDutyDispatchInstallation(env, {
      callerUserId: "42",
      businessId: "biz-1",
      repoOwner: "acme",
      repoName: "worker",
      rotateToken: true,
      publicBaseUrl: "https://app.test",
    });

    expect(updated.webhookUrl).toBe(created.webhookUrl);
    expect(updated.repoName).toBe("worker");
    expect(rotated.webhookUrl).not.toBe(created.webhookUrl);
    expect(rotated.webhookSigningSecretConfigured).toBe(true);
  });

  it("requires a signing secret on first configure", async () => {
    const env = makeEnv();

    await expect(
      savePagerDutyDispatchInstallation(env, {
        callerUserId: "42",
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "api",
        publicBaseUrl: "https://app.test",
      }),
    ).rejects.toMatchObject<PagerDutyDispatchAdminError>({
      code: "invalid_input",
      status: 400,
    });
  });

  it("surfaces repo gate failures as admin errors", async () => {
    const env = makeEnv();
    gateGithubSessionStartMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      body: { reasonCode: "repo_access_denied", stage: "provider_probe_passed" },
    });

    await expect(
      savePagerDutyDispatchInstallation(env, {
        callerUserId: "42",
        businessId: "biz-1",
        repoOwner: "acme",
        repoName: "api",
        webhookSigningSecret: "pd-signing-secret",
        publicBaseUrl: "https://app.test",
      }),
    ).rejects.toMatchObject<PagerDutyDispatchAdminError>({
      code: "repo_not_available",
      status: 404,
      details: { reasonCode: "repo_access_denied" },
    });
  });

  it("returns not_configured when no binding exists", async () => {
    const env = makeEnv();
    const summary = await getPagerDutyDispatchInstallationSummary(env.DB, "biz-1", "https://app.test");
    expect(summary).toEqual({
      status: "not_configured",
      repoOwner: null,
      repoName: null,
      modelId: null,
      webhookUrl: null,
      webhookSigningSecretConfigured: false,
      connectedAt: null,
      updatedAt: null,
      revokedAt: null,
    });
  });
});
