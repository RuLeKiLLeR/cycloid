import { describe, expect, it } from "vitest";

import { deriveCurrentIntegrationHealth } from "../../apps/control-plane-worker/src/integrations/current-health";
import { INTEGRATION_LIFECYCLE_REASON_CODE } from "../../shared/enums/integration-lifecycle";
import type { IntegrationHealthCheck, IntegrationLifecycleSummary } from "../../shared/types/integrations";

describe("deriveCurrentIntegrationHealth", () => {
  it("prefers timestamped lifecycle evidence over an untimestamped health check", () => {
    const health = {
      status: "passed",
      checkKind: "basic",
      operation: "probe",
      checkedAt: null,
      latencyMs: 12,
      diagnostic: "ok",
      failureReason: null,
    } as unknown as IntegrationHealthCheck;
    const lifecycle: IntegrationLifecycleSummary = {
      integrationId: "linear",
      stage: "credential_resolved",
      status: "failed",
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REVOKED,
      message: "Linear credentials were revoked.",
      createdAt: 100,
    };

    expect(deriveCurrentIntegrationHealth({ health, lifecycle })).toMatchObject({
      state: "disconnected",
      source: "lifecycle",
      status: "failed",
      checkedAt: 100,
      reasonCode: INTEGRATION_LIFECYCLE_REASON_CODE.TOKEN_REVOKED,
      diagnostic: "credential_resolved",
      message: "Linear credentials were revoked.",
    });
  });

  it("preserves the latest health-check failure reason as the human message", () => {
    const health: IntegrationHealthCheck = {
      status: "failed",
      checkKind: "basic",
      operation: "jira.accessible_resources",
      checkedAt: 200,
      latencyMs: 12,
      diagnostic: "jira_installer_token_missing",
      failureReason: "The Jira installer's OAuth token is missing or can no longer be refreshed.",
    };
    const lifecycle: IntegrationLifecycleSummary = {
      integrationId: "jira",
      stage: "workspace_bound",
      status: "passed",
      reasonCode: null,
      message: "Jira business workspace is bound for webhook ingress.",
      createdAt: 100,
    };

    expect(deriveCurrentIntegrationHealth({ health, lifecycle })).toMatchObject({
      state: "disconnected",
      source: "health_check",
      status: "failed",
      checkedAt: 200,
      reasonCode: null,
      diagnostic: "jira_installer_token_missing",
      message: "The Jira installer's OAuth token is missing or can no longer be refreshed.",
    });
  });
});
