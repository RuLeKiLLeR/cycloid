import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBusinessIntegrations: vi.fn(),
  getUserSettingsIfExists: vi.fn(),
  getPagerDutyDispatchInstallationSummary: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/integrations/service", () => ({
  getBusinessIntegrations: mocks.getBusinessIntegrations,
}));
vi.mock("../../apps/control-plane-worker/src/settings/db", () => ({
  getUserSettingsIfExists: mocks.getUserSettingsIfExists,
}));
vi.mock("../../apps/control-plane-worker/src/automation/pagerduty-dispatch-admin-service", () => ({
  getPagerDutyDispatchInstallationSummary: mocks.getPagerDutyDispatchInstallationSummary,
}));

import { listConnectedTriggers } from "../../apps/control-plane-worker/src/automation/connected-triggers-service";

describe("listConnectedTriggers", () => {
  beforeEach(() => {
    mocks.getUserSettingsIfExists.mockResolvedValue(null);
    mocks.getPagerDutyDispatchInstallationSummary.mockResolvedValue({ status: "not_configured", updatedAt: null });
    mocks.getBusinessIntegrations.mockResolvedValue({
      github: { scope: "business", currentHealth: { status: "failed", checkedAt: 100 } },
      slack: { scope: "disabled", slackWorkspace: { status: "installed", installedAt: 200 } },
      linear: {
        scope: "disabled",
        linearWorkspace: { status: "active", webhookBound: true },
        currentHealth: { status: "passed", checkedAt: 300 },
      },
      jira: {
        scope: "business",
        jiraWorkspace: { status: "active", webhookBound: true, triggerLabel: "cycloid" },
        currentHealth: { status: "passed", checkedAt: 400 },
      },
    });
  });

  it("reports failed health as degraded and disabled installed integrations as setup needed", async () => {
    const triggers = await listConnectedTriggers({
      db: {} as D1Database,
      businessId: "biz-1",
      userId: 1,
      publicBaseUrl: "https://app.trycycloid.com",
    });

    expect(Object.fromEntries(triggers.map((trigger) => [trigger.id, trigger.status]))).toMatchObject({
      github: "degraded",
      slack: "setup_needed",
      linear: "setup_needed",
      jira: "active",
    });
  });
});
